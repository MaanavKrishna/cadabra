import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const create = vi.fn();
const { MockAbort, MockTimeout } = vi.hoisted(() => ({
  MockAbort: class extends Error {}, MockTimeout: class extends Error {},
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { static APIUserAbortError = MockAbort; static APIConnectionTimeoutError = MockTimeout; messages = { create }; constructor(public opts: unknown) {} },
}));

process.env.AWS_REGION = 'ap-south-1';
const KEY = 'sk-ant-SECRET-1234567890';
const { converse, _resetModelCache } = await import('../src/ai/bedrock');
const { toAnthropicMessages, toAnthropicTools, toConverseResponse } = await import('../src/ai/anthropic');
const br = mockClient(BedrockRuntimeClient);
const sm = mockClient(SecretsManagerClient);
const err = (name: string) => Object.assign(new Error(name), { name });
const req = { model: 'designer' as const, system: 's', messages: [{ role: 'user' as const, content: [{ text: 'hi' }] }], timeoutMs: 5000 };
const msg = (over = {}) => ({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 }, ...over });

beforeEach(() => {
  br.reset(); sm.reset(); create.mockReset(); _resetModelCache();
  process.env.ANTHROPIC_API_KEY = KEY;
  delete process.env.ANTHROPIC_SECRET_ID;
});

describe('translation', () => {
  test('request: text, toolUse, toolResult, cachePoints, tools', () => {
    const m = toAnthropicMessages([
      { role: 'user', content: [{ text: 'build' }, { cachePoint: { type: 'default' } }] },
      { role: 'assistant', content: [{ text: 'ok' }, { toolUse: { toolUseId: 't1', name: 'patch', input: { a: 1 } } }] },
      { role: 'user', content: [
        { toolResult: { toolUseId: 't1', content: [{ text: '{"ok":false}' }], status: 'error' } },
        { text: 'hurry' },
      ] },
    ]);
    expect(m[0]!.content).toEqual([{ type: 'text', text: 'build', cache_control: { type: 'ephemeral' } }]);
    expect(m[1]!.content[1]).toEqual({ type: 'tool_use', id: 't1', name: 'patch', input: { a: 1 } });
    expect(m[2]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"ok":false}' }], is_error: true });
    expect(m[2]!.content[1]).toEqual({ type: 'text', text: 'hurry' });
    const t = toAnthropicTools([
      { toolSpec: { name: 'patch', description: 'd', inputSchema: { json: { type: 'object' } } } },
      { cachePoint: { type: 'default' } },
    ]);
    expect(t).toEqual([{ name: 'patch', description: 'd', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]);
  });

  test('response: tool_use maps to toolUse + stopReason', () => {
    const r = toConverseResponse(msg({
      content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'u1', name: 'n', input: { k: 1 } }],
      stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 2 },
    }));
    expect(r.output.message.content).toEqual([{ text: 'x' }, { toolUse: { toolUseId: 'u1', name: 'n', input: { k: 1 } } }]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage).toMatchObject({ inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 2 });
  });
});

describe('provider selection', () => {
  test.each(['AccessDeniedException', 'ResourceNotFoundException', 'ThrottlingException'])('%s -> anthropic', async (name) => {
    br.on(ConverseCommand).rejects(err(name));
    create.mockResolvedValue(msg());
    const out = await converse(req);
    expect(out).toMatchObject({ text: 'hello', provider: 'anthropic', modelId: 'claude-sonnet-5-5', stopReason: 'end_turn' });
    expect(create.mock.calls[0]![0].model).toBe('claude-sonnet-5-5');
    expect(create.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  test('fast role uses haiku 5.5', async () => {
    br.on(ConverseCommand).rejects(err('AccessDeniedException'));
    create.mockResolvedValue(msg());
    expect((await converse({ ...req, model: 'fast' })).modelId).toBe('claude-haiku-5-5');
  });

  test('throttling does not hop Bedrock models', async () => {
    br.on(ConverseCommand).rejects(err('ThrottlingException'));
    create.mockResolvedValue(msg());
    await converse(req);
    expect(br.commandCalls(ConverseCommand)).toHaveLength(1);
  });

  test('no key: Bedrock error surfaces as before', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    br.on(ConverseCommand).rejects(err('AccessDeniedException'));
    await expect(converse(req)).rejects.toThrow('AccessDeniedException');
    expect(create).not.toHaveBeenCalled();
  });

  test('healthy bedrock stays on bedrock', async () => {
    br.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ text: 'b' }] } }, stopReason: 'end_turn' } as any);
    expect(await converse(req)).toMatchObject({ provider: 'bedrock', text: 'b' });
    expect(create).not.toHaveBeenCalled();
  });

  test('throttle-triggered fallback only sticks for 2 min', async () => {
    vi.useFakeTimers();
    try {
      br.on(ConverseCommand).rejects(err('ThrottlingException'));
      create.mockResolvedValue(msg());
      await converse(req);
      await converse(req);
      expect(br.commandCalls(ConverseCommand)).toHaveLength(1);
      vi.advanceTimersByTime(2 * 60_000 + 1);
      await converse(req);
      expect(br.commandCalls(ConverseCommand)).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  test('access-denied window is still 10 min (not retried at 3 min)', async () => {
    vi.useFakeTimers();
    try {
      br.on(ConverseCommand).rejects(err('AccessDeniedException'));
      create.mockResolvedValue(msg());
      await converse(req);
      const n = br.commandCalls(ConverseCommand).length;
      vi.advanceTimersByTime(3 * 60_000);
      await converse(req);
      expect(br.commandCalls(ConverseCommand)).toHaveLength(n);
    } finally { vi.useRealTimers(); }
  });

  test('account-unavailable anywhere in the chain falls through, even if first error is Validation', async () => {
    br.on(ConverseCommand, { modelId: 'anthropic.claude-sonnet-5-5' }).rejects(err('ValidationException'));
    br.on(ConverseCommand).rejects(err('AccessDeniedException'));
    create.mockResolvedValue(msg());
    expect((await converse(req)).provider).toBe('anthropic');
  });

  test('non-timeout anthropic failure clears the sticky window; timeout keeps it', async () => {
    br.on(ConverseCommand).rejects(err('AccessDeniedException'));
    create.mockResolvedValueOnce(msg());
    await converse(req);
    const n = br.commandCalls(ConverseCommand).length;
    create.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(converse(req)).rejects.toThrow('anthropic 500');
    create.mockResolvedValueOnce(msg());
    await converse(req); // window cleared: Bedrock probed again
    expect(br.commandCalls(ConverseCommand).length).toBeGreaterThan(n);
  });

  test('timeouts map to TimeoutError (SDK classes, no .name)', async () => {
    for (const E of [MockAbort, MockTimeout]) {
      _resetModelCache();
      br.on(ConverseCommand).rejects(err('AccessDeniedException'));
      create.mockRejectedValueOnce(new E('Request timed out.'));
      await expect(converse(req)).rejects.toMatchObject({ name: 'TimeoutError' });
    }
    _resetModelCache();
    create.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 400 }));
    await expect(converse(req)).rejects.toMatchObject({ name: 'AnthropicApiError' });
  });

  test('thinking is off for both roles (Sonnet 5.5 uses between_tools)', async () => {
    br.on(ConverseCommand).rejects(err('AccessDeniedException'));
    create.mockResolvedValue(msg());
    await converse(req);
    await converse({ ...req, model: 'fast' });
    const [designer, fast] = create.mock.calls.map((c) => c[0]);
    expect(designer.model).toBe('claude-sonnet-5-5');
    expect(designer.thinking).toEqual({ type: 'between_tools' });
    expect(fast.thinking).toEqual({ type: 'disabled' });
  });

  test('multi-turn tool_use/tool_result adjacency over 3 turns', () => {
    const turn = (i: number) => [
      { role: 'assistant', content: [{ text: 'step' }, { toolUse: { toolUseId: `t${i}`, name: 'patch', input: { i } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: `t${i}`, content: [{ json: { ok: true } }] } }] },
    ];
    const m = toAnthropicMessages([{ role: 'user', content: [{ text: 'go' }] }, ...turn(1), ...turn(2), ...turn(3)]);
    expect(m.map((x: any) => x.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
    for (const i of [1, 2, 3]) {
      const use = m[i * 2 - 1]!.content.find((b: any) => b.type === 'tool_use');
      const res = m[i * 2]!.content[0];
      expect(res).toMatchObject({ type: 'tool_result', tool_use_id: use.id, content: [{ type: 'text', text: '{"ok":true}' }] });
    }
  });

  test('failed secret lookup is retried after 60 s', async () => {
    vi.useFakeTimers();
    try {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_SECRET_ID = 'cadabra/anthropic-api-key';
      sm.on(GetSecretValueCommand).rejects(err('ResourceNotFoundException'));
      br.on(ConverseCommand).rejects(err('AccessDeniedException'));
      create.mockResolvedValue(msg());
      await expect(converse(req)).rejects.toThrow('AccessDenied');
      await expect(converse(req)).rejects.toThrow('AccessDenied');
      expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1); // negative cache
      vi.advanceTimersByTime(60_001);
      sm.on(GetSecretValueCommand).resolves({ SecretString: KEY });
      expect((await converse(req)).provider).toBe('anthropic');
      expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  test('unavailability cached 10 min, then Bedrock retried', async () => {
    vi.useFakeTimers();
    try {
      br.on(ConverseCommand).rejects(err('AccessDeniedException'));
      create.mockResolvedValue(msg());
      await converse(req);
      const n = br.commandCalls(ConverseCommand).length;
      await converse(req);
      expect(br.commandCalls(ConverseCommand)).toHaveLength(n); // skipped
      vi.advanceTimersByTime(10 * 60_000 + 1);
      br.on(ConverseCommand).resolves({ output: { message: { role: 'assistant', content: [{ text: 'back' }] } }, stopReason: 'end_turn' } as any);
      expect(await converse(req)).toMatchObject({ provider: 'bedrock', text: 'back' });
    } finally { vi.useRealTimers(); }
  });

  test('key from Secrets Manager inside Lambda', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_SECRET_ID = 'cadabra/anthropic-api-key';
    sm.on(GetSecretValueCommand).resolves({ SecretString: KEY });
    br.on(ConverseCommand).rejects(err('AccessDeniedException'));
    create.mockResolvedValue(msg());
    expect((await converse(req)).provider).toBe('anthropic');
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  test('key never appears in logs or errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    br.on(ConverseCommand).rejects(err('AccessDeniedException'));
    create.mockRejectedValue(Object.assign(new Error(`401 bad key ${KEY}`), { status: 401 }));
    const e = await converse(req).catch((x) => x as Error);
    expect(String((e as Error).message)).not.toContain(KEY);
    expect((e as Error).message).toContain('[redacted]');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    warn.mockRestore();
  });
});
