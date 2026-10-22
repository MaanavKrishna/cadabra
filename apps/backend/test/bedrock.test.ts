import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ApplyGuardrailCommand, BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

process.env.AWS_REGION = 'ap-south-1';
process.env.GUARDRAIL_ID = 'gr-1';
process.env.GUARDRAIL_VERSION = '1';
const { MODELS, converse, screen, designFromIngredients } = await import('../src/ai/bedrock');
const br = mockClient(BedrockRuntimeClient);

const okOut = (text = 'ok') => ({
  output: { message: { role: 'assistant', content: [{ text }] } }, stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 },
});
const err = (name: string) => Object.assign(new Error(name), { name });
const usedModels = () => br.commandCalls(ConverseCommand).map((c) => c.args[0].input.modelId);
const req = { model: 'designer' as const, system: 's', messages: [{ role: 'user' as const, content: [{ text: 'hi' }] }], timeoutMs: 5000 };

describe('bedrock', () => {
  beforeEach(() => br.reset());

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
});
