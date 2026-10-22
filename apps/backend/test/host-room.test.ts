import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BlockRegistry, GameRuntime, registerBuiltins } from '@cadabra/engine';
import { FALLBACK_SPECS } from '@cadabra/spec';

const converse = vi.fn();
vi.mock('../src/ai/bedrock', () => ({
  converse: (...a: unknown[]) => converse(...a),
  screenOutput: vi.fn(async () => ({ allowed: true })),
}));
const host = await import('../src/ai/host');
const { requestHost, HOST_LIMITS, MAX_JUDGE_PAYLOAD_BYTES } = await import('../src/host-room');

const ddbMock = mockClient(DynamoDBDocumentClient);
const sent: any[] = [];
const ctx: any = { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), table: 'T', now: () => 1, send: async (_c: string, m: any) => { sent.push(m); return true; } };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const out = (text: string) => ({ text, toolUses: [], modelId: 'm', provider: 'bedrock' as const });
const tv = (room = 'BCDF') => ddbMock.on(GetCommand).resolves({ Item: { role: 'tv', room } });

beforeEach(() => { ddbMock.reset(); sent.length = 0; converse.mockReset(); });

describe('requestHost', () => {
  const say = { t: 'host.say' as const, code: 'BCDF', text: 'hi' };

  test('auth gate: a non-TV connection is rejected and nothing is invoked', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { role: 'player', room: 'BCDF' } });
    const invoke = vi.fn();
    await requestHost(ctx, 'c1', say, { invoke, endpoint: 'e' });
    expect(invoke).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ t: 'error', code: 'room.badRequest' });
  });

  test('TV request is invoked and counted', async () => {
    tv(); ddbMock.on(UpdateCommand).resolves({});
    const invoke = vi.fn(async () => {});
    await requestHost(ctx, 'c1', say, { invoke, endpoint: 'e' });
    expect(invoke).toHaveBeenCalledOnce();
    expect(ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input.ExpressionAttributeValues).toMatchObject({ ':max': HOST_LIMITS['host.say'] });
  });

  test('over the per-room limit -> room.rateLimited', async () => {
    tv(); ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const invoke = vi.fn();
    await requestHost(ctx, 'c1', say, { invoke, endpoint: 'e' });
    expect(invoke).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ t: 'error', code: 'room.rateLimited' });
  });

  test('oversize judge.request is rejected', async () => {
    tv(); ddbMock.on(UpdateCommand).resolves({});
    const invoke = vi.fn();
    const big = 'x'.repeat(MAX_JUDGE_PAYLOAD_BYTES + 1);
    await requestHost(ctx, 'c1', { t: 'judge.request', code: 'BCDF', id: 'j', kind: 'draw', payload: { entries: [{ playerId: 'p', image: big }] } }, { invoke, endpoint: 'e' });
    expect(invoke).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ t: 'error', code: 'room.badRequest' });
  });

  test('invoke failure: judgement is answered locally, host.say returns its caption', async () => {
    tv(); ddbMock.on(UpdateCommand).resolves({});
    const invoke = vi.fn(async () => { throw new Error('no fn'); });
    await requestHost(ctx, 'c1', { t: 'judge.request', code: 'BCDF', id: 'j1', kind: 'draw',
      payload: { round: 1, entries: [{ playerId: 'p0', name: 'A', image: png, bot: false }] } }, { invoke, endpoint: 'e' });
    expect(sent[0]).toMatchObject({ t: 'judge.result', id: 'j1' });
    expect(sent[0].result[0]).toMatchObject({ playerId: 'p0' });
    await requestHost(ctx, 'c1', { ...say, id: 'k' }, { invoke, endpoint: 'e' });
    expect(sent[1]).toEqual({ t: 'host.audio', id: 'k', text: 'hi' });
  });
});

describe('engine validator round-trip', () => {
  const SPS = 60;
  const spec = (block: string, params: object) => ({
    ...structuredClone(FALLBACK_SPECS[0]!), arena: { kind: block === 'trivia' ? 'quiz' : 'canvas', width: 1280, height: 720 },
    blocks: [{ block, params }], timeline: [], durationSec: 60,
  }) as any;
  const players = ['p0', 'p1'].map((id, i) => ({ id, name: `P${i}`, avatar: 'a', isBot: false, connected: true, score: 0 }));
  const mk = (s: any) => { const r = new BlockRegistry(); registerBuiltins(r); return new GameRuntime(s, players, r, 1); };

  test('draw-judge accepts judgeDrawings output', async () => {
    const rt = mk(spec('draw-judge', { drawSec: 20, rounds: 1, judgeStyle: 'kind', prompt: 'a hat' }));
    rt.input('p0', { t: 0, draw: png }); rt.input('p1', { t: 0, draw: png });
    for (let i = 0; i < 3; i++) rt.step();
    const j = rt.pendingJudgements()[0]!;
    converse.mockResolvedValue(out('[{"playerId":"p0","score":9,"roast":"Fab."},{"playerId":"p1","score":2,"roast":"Eh."}]'));
    const result = await host.resolveJudgement(j.kind, j.payload);
    rt.resolveJudgement(j.id, result);
    rt.step();
    const judged = rt.result().ranking;
    expect(judged.find((p) => p.id === 'p0')!.score).toBe(9);
    expect(judged.find((p) => p.id === 'p1')!.score).toBe(2);
  });

  test('trivia accepts triviaQuestions output', async () => {
    const rt = mk(spec('trivia', { questions: [], secondsPerQuestion: 10, pointsFast: 3, pointsSlow: 1, aboutPlayers: false }));
    rt.step();
    const j = rt.pendingJudgements()[0]!;
    converse.mockResolvedValue(out(JSON.stringify([{ q: 'Which is round?', options: ['Ladoo', 'Barfi', 'Jalebi', 'Peda'], answer: 0 }])));
    const result = await host.resolveJudgement(j.kind, j.payload);
    rt.resolveJudgement(j.id, result);
    rt.step();
    expect(rt.events.filter((e) => e.type === 'trivia.generated').map((e) => e.data!.source)).toEqual(['ai']);
  });
});
