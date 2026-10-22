import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** Anthropic API fallback provider. Speaks Bedrock-Converse-shaped requests/responses so callers never change. */

export const ANTHROPIC_MODELS = {
  designer: 'claude-sonnet-5-5',
  fast: 'claude-haiku-5-5',
  fallbackDesigner: 'claude-sonnet-5-5',
} as const;

const SECRET_REGION = 'ap-south-1';
const log = (...a: unknown[]) => console.warn('[anthropic]', ...a);

// ---- API key (Secrets Manager at cold start, or env for local scripts) ----
let keyCache: { key: string | null; until: number } | undefined;
let smClient: SecretsManagerClient | undefined;

/** Test hook. */
export function _resetAnthropic(): void { keyCache = undefined; smClient = undefined; clientCache = undefined; }

export async function getApiKey(): Promise<string | null> {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;
  if (keyCache && (keyCache.key || Date.now() < keyCache.until)) return keyCache.key;
  // Only reach for Secrets Manager inside Lambda, or when a secret id is configured explicitly.
  const secretId = process.env.ANTHROPIC_SECRET_ID
    || (process.env.AWS_LAMBDA_FUNCTION_NAME ? 'cadabra/anthropic-api-key' : '');
  if (!secretId) return null;
  try {
    smClient ??= new SecretsManagerClient({ region: SECRET_REGION });
    const r = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }), { abortSignal: AbortSignal.timeout(3000) });
    let key = (r.SecretString ?? '').trim();
    if (key.startsWith('{')) { // tolerate {"ANTHROPIC_API_KEY":"..."} style secrets
      try { const o = JSON.parse(key) as Record<string, unknown>; key = String(o.ANTHROPIC_API_KEY ?? o.apiKey ?? o.key ?? Object.values(o)[0] ?? '').trim(); } catch { /* raw */ }
    }
    keyCache = { key: key || null, until: Date.now() + 60_000 };
  } catch (e) {
    log('api key not available:', (e as Error)?.name); // never log message/values
    keyCache = { key: null, until: Date.now() + 60_000 };
  }
  return keyCache.key;
}

let clientCache: { key: string; client: Anthropic } | undefined;
function clientFor(key: string): Anthropic {
  if (clientCache?.key !== key) clientCache = { key, client: new Anthropic({ apiKey: key, maxRetries: 1 }) };
  return clientCache.client;
}

// ---- Converse -> Messages translation ----
type Obj = Record<string, any>; // Converse blocks are a loose union; shape-checked below
type CacheControl = { type: 'ephemeral' };
const EPHEMERAL: CacheControl = { type: 'ephemeral' };

function toolResultContent(content: Obj[] | undefined): Obj[] | string {
  const out: Obj[] = [];
  for (const c of content ?? []) {
    if (typeof c.text === 'string') { if (c.text) out.push({ type: 'text', text: c.text }); }
    else if (c.json !== undefined) out.push({ type: 'text', text: JSON.stringify(c.json) });
  }
  return out.length ? out : '(empty)';
}

export function toAnthropicMessages(messages: Obj[]): Obj[] {
  return messages.map((m) => {
    const blocks: Obj[] = [];
    for (const c of (m.content ?? []) as Obj[]) {
      if (c.cachePoint) { // marks the end of the cacheable prefix: attach to the block before it
        const prev = blocks[blocks.length - 1];
        if (prev) prev.cache_control = EPHEMERAL;
      } else if (c.toolUse) {
        blocks.push({ type: 'tool_use', id: c.toolUse.toolUseId, name: c.toolUse.name, input: c.toolUse.input ?? {} });
      } else if (c.toolResult) {
        blocks.push({
          type: 'tool_result', tool_use_id: c.toolResult.toolUseId, content: toolResultContent(c.toolResult.content),
          ...(c.toolResult.status === 'error' ? { is_error: true } : {}),
        });
      } else if (typeof c.text === 'string') {
        if (c.text.trim()) blocks.push({ type: 'text', text: c.text }); // the API rejects empty text blocks
      }
    }
    if (!blocks.length) blocks.push({ type: 'text', text: '(empty)' });
    return { role: m.role, content: blocks };
  });
}

export function toAnthropicTools(tools: Obj[] | undefined): Obj[] | undefined {
  if (!tools?.length) return undefined;
  const out: Obj[] = [];
  for (const t of tools) {
    if (t.cachePoint) { const prev = out[out.length - 1]; if (prev) prev.cache_control = EPHEMERAL; continue; }
    const s = t.toolSpec;
    if (!s) continue;
    out.push({ name: s.name, description: s.description ?? '', input_schema: s.inputSchema?.json ?? { type: 'object', properties: {} } });
  }
  return out.length ? out : undefined;
}

const STOP: Record<string, string> = {
  end_turn: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', stop_sequence: 'stop_sequence',
  refusal: 'content_filtered', pause_turn: 'end_turn',
};

/** Messages API response -> the Converse response shape converse()/designer.ts consume. */
export function toConverseResponse(res: Obj): {
  output: { message: { role: 'assistant'; content: Obj[] } };
  stopReason: string; usage: Obj;
} {
  const content: Obj[] = [];
  for (const b of (res.content ?? []) as Obj[]) {
    if (b.type === 'text') content.push({ text: b.text });
    else if (b.type === 'tool_use') content.push({ toolUse: { toolUseId: b.id, name: b.name, input: b.input } });
  }
  const u = res.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return {
    output: { message: { role: 'assistant', content } },
    stopReason: STOP[res.stop_reason as string] ?? String(res.stop_reason ?? 'end_turn'),
    usage: {
      inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
      totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + cacheRead + cacheWrite,
      cacheReadInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite,
    },
  };
}

export interface AnthropicRequest {
  model: keyof typeof ANTHROPIC_MODELS;
  system: string;
  messages: Obj[];
  tools?: Obj[];
  maxTokens?: number;
  timeoutMs: number;
}

export async function anthropicConverse(
  req: AnthropicRequest, key: string,
): Promise<ReturnType<typeof toConverseResponse> & { modelId: string }> {
  const modelId = ANTHROPIC_MODELS[req.model];
  const tools = toAnthropicTools(req.tools);
  try {
    const res = await clientFor(key).messages.create({
      model: modelId,
      max_tokens: req.maxTokens ?? 2048,
      system: [{ type: 'text', text: req.system }],
      messages: toAnthropicMessages(req.messages),
      ...(tools ? { tools } : {}),
      // Callers resend history as plain text/toolUse blocks (no thinking blocks), so keep thinking off.
      thinking: req.model === 'fast' ? { type: 'disabled' } : { type: 'between_tools' },
    } as never, { signal: AbortSignal.timeout(Math.max(1, req.timeoutMs)) }) as unknown as Obj;
    return { ...toConverseResponse(res), modelId };
  } catch (e) {
    throw sanitize(e, key);
  }
}

function sanitize(e: unknown, key: string): Error {
  const err = e as { name?: string; status?: number; message?: string };
  const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.name === 'APIUserAbortError' || err?.name === 'APIConnectionTimeoutError';
  const msg = String(err?.message ?? 'error').split(key).join('[redacted]');
  const out = new Error(`anthropic${err?.status ? ` ${err.status}` : ''}: ${msg}`);
  out.name = isTimeout ? 'TimeoutError' : 'AnthropicApiError';
  return out;
}
