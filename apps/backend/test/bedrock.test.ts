import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ApplyGuardrailCommand, BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

process.env.AWS_REGION = 'ap-south-1';
process.env.GUARDRAIL_ID = 'gr-1';
process.env.GUARDRAIL_VERSION = '1';
const { MODELS, CHAINS, converse, screen, screenOutput, designFromIngredients, _resetModelCache } = await import('../src/ai/bedrock');
const br = mockClient(BedrockRuntimeClient);

const okOut = (text = 'ok') => ({
  output: { message: { role: 'assistant', content: [{ text }] } }, stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 },
});
const err = (name: string) => Object.assign(new Error(name), { name });
const usedModels = () => br.commandCalls(ConverseCommand).map((c) => c.args[0].input.modelId);
const req = { model: 'designer' as const, system: 's', messages: [{ role: 'user' as const, content: [{ text: 'hi' }] }], timeoutMs: 5000 };

describe('bedrock', () => {
  beforeEach(() => { br.reset(); _resetModelCache(); process.env.GUARDRAIL_ID = 'gr-1'; });

  test('converse retries with fallbackDesigner on ValidationException', async () => {
    br.on(ConverseCommand, { modelId: MODELS.designer }).rejects(err('ValidationException'));
    br.on(ConverseCommand, { modelId: MODELS.fallbackDesigner }).resolves(okOut('hello') as any);
    const out = await converse(req);
    expect(out.text).toBe('hello');
    expect(out.modelId).toBe(MODELS.fallbackDesigner);
    expect(usedModels()).toEqual([MODELS.designer, MODELS.fallbackDesigner]);
  });

  test('fallback chain is tried in order and stops at first success', async () => {
    br.on(ConverseCommand).rejects(err('ValidationException'));
    br.on(ConverseCommand, { modelId: 'global.anthropic.claude-sonnet-5-5' }).resolves(okOut() as any);
    const out = await converse(req);
    expect(out.modelId).toBe('global.anthropic.claude-sonnet-5-5');
    expect(usedModels()).toEqual([MODELS.designer, MODELS.fallbackDesigner, 'global.anthropic.claude-sonnet-5-5']);
  });

  test('throttling is not retried on another model', async () => {
    br.on(ConverseCommand).rejects(err('ThrottlingException'));
    await expect(converse(req)).rejects.toThrow();
    expect(usedModels()).toHaveLength(1);
  });

  test('screen: familySafe blocks any intervention; off only blocks HIGH hate/sexual', async () => {
    const mild = { action: 'GUARDRAIL_INTERVENED', assessments: [{ contentPolicy: { filters: [
      { type: 'INSULTS', confidence: 'MEDIUM', action: 'BLOCKED' }] } }] };
    const high = { action: 'GUARDRAIL_INTERVENED', assessments: [{ contentPolicy: { filters: [
      { type: 'SEXUAL', confidence: 'HIGH', action: 'BLOCKED' }] } }] };
    br.on(ApplyGuardrailCommand).resolves(mild as any);
    expect((await screen('x', 'INPUT')).allowed).toBe(false);
    expect((await screen('x', 'INPUT', false)).allowed).toBe(true);
    br.on(ApplyGuardrailCommand).resolves(high as any);
    expect((await screen('x', 'INPUT', false)).allowed).toBe(false);
    br.on(ApplyGuardrailCommand).resolves({ action: 'NONE', assessments: [] } as any);
    expect((await screen('x', 'INPUT')).allowed).toBe(true);
  });

  test('blocked input never reaches designer', async () => {
    br.on(ApplyGuardrailCommand).callsFake((i) =>
      ({ action: i.content[0].text.text === 'badword' ? 'GUARDRAIL_INTERVENED' : 'NONE', assessments: [] }));
    br.on(ConverseCommand).resolves(okOut('{}') as any);
    const r = await designFromIngredients(['rocket', 'badword', 'cheese'], { system: 's', timeoutMs: 5000 });
    expect(r.clientMsgs).toEqual([{ t: 'screen', name: 'blocked' }]);
    expect(r.blocked).toEqual(['badword']);
    const sent = JSON.stringify(br.commandCalls(ConverseCommand)[0]!.args[0].input.messages);
    expect(sent).toContain('rocket');
    expect(sent).toContain('cheese');
    expect(sent).not.toContain('badword');
  });

  test('all ingredients blocked -> designer not called', async () => {
    br.on(ApplyGuardrailCommand).resolves({ action: 'GUARDRAIL_INTERVENED', assessments: [] } as any);
    const r = await designFromIngredients(['a'], { system: 's', timeoutMs: 5000 });
    expect(r.output).toBeUndefined();
    expect(br.commandCalls(ConverseCommand)).toHaveLength(0);
  });

  test.each(['AccessDeniedException', 'ResourceNotFoundException'])('%s falls back to next model', async (name) => {
    br.on(ConverseCommand, { modelId: MODELS.designer }).rejects(err(name));
    br.on(ConverseCommand, { modelId: MODELS.fallbackDesigner }).resolves(okOut('fb') as any);
    expect((await converse(req)).text).toBe('fb');
  });

  test('non-fallback error on first model is rethrown immediately', async () => {
    br.on(ConverseCommand).rejects(err('InternalServerException'));
    await expect(converse(req)).rejects.toThrow('InternalServerException');
    expect(usedModels()).toEqual([MODELS.designer]);
  });

  test('whole chain failing rethrows the FIRST error with attempts summarized', async () => {
    br.on(ConverseCommand).callsFake((i: any) => {
      throw Object.assign(new Error(`first-${i.modelId}`), { name: 'ValidationException' });
    });
    const e = await converse(req).catch((x) => x);
    expect(e.message).toContain(`first-${MODELS.designer}`);
    for (const m of CHAINS.designer) expect(e.message).toContain(`${m}: ValidationException`);
    expect(usedModels()).toEqual([...CHAINS.designer]);
  });

  test('shared deadline: exhausted budget stops the chain', async () => {
    br.on(ConverseCommand).callsFake(async () => {
      await new Promise((r) => setTimeout(r, 80));
      throw err('ValidationException');
    });
    await expect(converse({ ...req, timeoutMs: 40 })).rejects.toThrow(/ValidationException/);
    expect(usedModels()).toHaveLength(1);
  });

  test('abort/timeout error is rethrown and does not hop models; signal is passed', async () => {
    br.on(ConverseCommand).rejects(err('TimeoutError'));
    await expect(converse(req)).rejects.toThrow('TimeoutError');
    expect(usedModels()).toHaveLength(1);
    const opts = (br.commandCalls(ConverseCommand)[0]!.args as unknown as any[])[1];
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
  });

  test('converse request shape: system array, no toolConfig without tools, maxTokens', async () => {
    br.on(ConverseCommand).resolves(okOut() as any);
    await converse({ ...req, maxTokens: 321 });
    const input = br.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(input.system).toEqual([{ text: 's' }]);
    expect(input.toolConfig).toBeUndefined();
    expect(input.inferenceConfig).toEqual({ maxTokens: 321 });
    expect(input.messages).toEqual(req.messages);
    await converse({ ...req, tools: [{ toolSpec: { name: 't', inputSchema: { json: {} } } }] });
    expect(br.commandCalls(ConverseCommand)[1]!.args[0].input.toolConfig?.tools).toHaveLength(1);
    expect(br.commandCalls(ConverseCommand)[1]!.args[0].input.inferenceConfig).toEqual({ maxTokens: 2048 });
  });

  test('cached working model is used first on later calls', async () => {
    br.on(ConverseCommand, { modelId: MODELS.designer }).rejects(err('AccessDeniedException'));
    br.on(ConverseCommand, { modelId: MODELS.fallbackDesigner }).resolves(okOut() as any);
    await converse(req);
    br.resetHistory();
    await converse(req);
    expect(usedModels()).toEqual([MODELS.fallbackDesigner]);
  });

  test('cached model that later fails is dropped and chain resumes', async () => {
    br.on(ConverseCommand, { modelId: MODELS.designer }).rejects(err('AccessDeniedException'));
    let n = 0;
    br.on(ConverseCommand, { modelId: MODELS.fallbackDesigner }).callsFake(() => {
      if (n++ === 0) return okOut();
      throw err('AccessDeniedException');
    });
    br.on(ConverseCommand, { modelId: 'global.anthropic.claude-sonnet-5-5' }).resolves(okOut() as any);
    await converse(req);
    br.resetHistory();
    expect((await converse(req)).modelId).toBe('global.anthropic.claude-sonnet-5-5');
    expect(usedModels()[0]).toBe(MODELS.fallbackDesigner);
  });

  test('screen fails closed with reason outage on guardrail error (after one retry)', async () => {
    br.on(ApplyGuardrailCommand).rejects(err('ThrottlingException'));
    expect(await screen('x', 'INPUT')).toEqual({ allowed: false, reason: 'outage' });
    expect(br.commandCalls(ApplyGuardrailCommand)).toHaveLength(2);
    expect((await screen('x', 'INPUT', false)).allowed).toBe(false);
  });

  test('screen recovers if the retry succeeds', async () => {
    br.on(ApplyGuardrailCommand).rejectsOnce(err('ServiceUnavailableException'))
      .resolves({ action: 'NONE', assessments: [] } as any);
    expect(await screen('x', 'INPUT')).toEqual({ allowed: true });
  });

  test('screen fails closed when GUARDRAIL_ID is missing', async () => {
    delete process.env.GUARDRAIL_ID;
    expect(await screen('x', 'INPUT')).toEqual({ allowed: false, reason: 'outage' });
    expect(await screen('x', 'INPUT', false)).toEqual({ allowed: false, reason: 'outage' });
    expect(br.commandCalls(ApplyGuardrailCommand)).toHaveLength(0);
  });

  test('policy block reports reason policy', async () => {
    br.on(ApplyGuardrailCommand).resolves({ action: 'GUARDRAIL_INTERVENED', assessments: [] } as any);
    expect(await screen('x', 'INPUT')).toEqual({ allowed: false, reason: 'policy' });
  });

  test('screenOutput uses OUTPUT source and fails closed', async () => {
    br.on(ApplyGuardrailCommand).resolves({ action: 'NONE', assessments: [] } as any);
    expect((await screenOutput('hi', true)).allowed).toBe(true);
    expect(br.commandCalls(ApplyGuardrailCommand)[0]!.args[0].input.source).toBe('OUTPUT');
    br.on(ApplyGuardrailCommand).rejects(err('InternalServerException'));
    expect(await screenOutput('hi', true)).toEqual({ allowed: false, reason: 'outage' });
  });

  test('designer output is screened; blocked output is withheld', async () => {
    br.on(ConverseCommand).resolves(okOut('naughty reply') as any);
    br.on(ApplyGuardrailCommand).callsFake((i) =>
      ({ action: i.source === 'OUTPUT' ? 'GUARDRAIL_INTERVENED' : 'NONE', assessments: [] }));
    const r = await designFromIngredients(['rocket'], { system: 's', timeoutMs: 5000 });
    expect(r.output).toBeUndefined();
    expect(r.outputBlocked).toBe('policy');
  });

  test('guardrail outage on ingredients: dropped, unscreened, no client blocked msg', async () => {
    br.on(ApplyGuardrailCommand).rejects(err('ThrottlingException'));
    const r = await designFromIngredients(['a'], { system: 's', timeoutMs: 5000 });
    expect(r.unscreened).toEqual(['a']);
    expect(r.blocked).toEqual([]);
    expect(r.clientMsgs).toEqual([]);
    expect(br.commandCalls(ConverseCommand)).toHaveLength(0);
  });
});
