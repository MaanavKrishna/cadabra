import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

process.env.ASSETS_BUCKET = 'assets-bkt';
process.env.ASSETS_URL = 'https://cdn.example.net';

const converse = vi.fn();
const screenOutput = vi.fn(async (text: string) => ({ allowed: !/BADWORD/.test(text) }));
vi.mock('../src/ai/bedrock', () => ({ converse: (...a: unknown[]) => converse(...a), screenOutput: (...a: [string]) => screenOutput(...a) }));

const host = await import('../src/ai/host');
const { speak, voiceKey } = await import('../src/ai/voice');
const s3 = mockClient(S3Client);
const polly = mockClient(PollyClient);

const out = (text: string) => ({ text, toolUses: [], modelId: 'm', provider: 'bedrock' as const });
const promptOf = (call = 0) => JSON.stringify(converse.mock.calls[call]![0]);
const players = [
  { id: 'p1', name: 'Dad', avatar: '', isBot: false, connected: true, score: 0 },
  { id: 'p2', name: 'Riya', avatar: '', isBot: false, connected: true, score: 0 },
];
const spec = { title: 'Ladoo Heist', hook: 'Sneak ladoos past a sleepy guard.' } as any;
const ev = (type: string, player: string, data?: Record<string, unknown>) => ({ t: 1, type, player, data });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeEach(() => { converse.mockReset(); screenOutput.mockClear(); s3.reset(); polly.reset(); });

describe('roast', () => {
  test('roast cites the player with most sneak.woke events', async () => {
    converse.mockResolvedValue(out('["Dad woke the guard four times.","Riya stole 3 ladoos.","Quiet night, nobody."]'));
    const events = [
      ...Array.from({ length: 4 }, () => ev('sneak.woke', 'p1')),
      ev('sneak.woke', 'p2'), ev('collect.stolen', 'p2'), ev('collect.stolen', 'p2'),
    ];
    const lines = await host.roast(events, players, spec);
    expect(promptOf()).toContain('Dad: woke the guard 4 times');
    expect(lines).toHaveLength(3);
  });
  test('falls back to lines built from the real counts when the AI is down', async () => {
    converse.mockRejectedValue(new Error('down'));
    const lines = await host.roast([ev('sneak.woke', 'p1'), ev('sneak.woke', 'p1')], players, spec);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.join(' ')).toContain('Dad');
  });
  test('screens every line; blocked ones become safe generic lines', async () => {
    converse.mockResolvedValue(out('["BADWORD roast","fine one"]'));
    const lines = await host.roast([ev('sneak.woke', 'p1')], players, spec);
    expect(lines.some((l) => /BADWORD/.test(l))).toBe(false);
    expect(lines).toContain('fine one');
    expect(screenOutput).toHaveBeenCalledWith('BADWORD roast', true);
  });
});

describe('hostLine', () => {
  test('uses the fast model, trims to 22 words and screens', async () => {
    converse.mockResolvedValue(out('"' + Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') + '"'));
    const line = await host.hostLine('join', { name: 'Riya' }, 'cheeky');
    expect(converse.mock.calls[0]![0].model).toBe('fast');
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(22);
    expect(screenOutput).toHaveBeenCalled();
  });
  test('blocked or failed output yields a generic safe line', async () => {
    converse.mockResolvedValue(out('BADWORD'));
    expect(await host.hostLine('event', {}, 'hype')).not.toMatch(/BADWORD/);
    converse.mockRejectedValue(new Error('x'));
    expect((await host.hostLine('finale', {}, 'calm')).length).toBeGreaterThan(3);
  });
});

describe('judgeDrawings', () => {
  test('returns score per drawing clamped 0..10, sends images, 7 s timeout', async () => {
    converse.mockResolvedValue(out('```json\n[{"playerId":"p1","score":14,"roast":"Bold."},{"playerId":"p2","score":-3,"roast":"Moody."}]\n```'));
    const r = await host.judgeDrawings('a cat king', [{ playerId: 'p1', png }, { playerId: 'p2', png }], 'savage');
    expect(r).toEqual([{ playerId: 'p1', score: 10, roast: 'Bold.' }, { playerId: 'p2', score: 0, roast: 'Moody.' }]);
    const req = converse.mock.calls[0]![0];
    expect(req.model).toBe('designer');
    expect(req.timeoutMs).toBe(7000);
    expect(req.messages[0].content.filter((c: any) => c.image)).toHaveLength(2);
  });
  test('bot drawings skip the AI and get a middling score', async () => {
    const r = await host.judgeDrawings('x', [{ playerId: 'b1', png, bot: true } as any], 'kind');
    expect(converse).not.toHaveBeenCalled();
    expect(r[0]!.playerId).toBe('b1');
    expect(r[0]!.score).toBeGreaterThanOrEqual(3);
    expect(r[0]!.score).toBeLessThanOrEqual(7);
    expect(r[0]!.roast.length).toBeGreaterThan(0);
  });
  test('only humans go to the AI; AI failure gives middling scores', async () => {
    converse.mockRejectedValue(new Error('down'));
    const r = await host.judgeDrawings('x', [{ playerId: 'p1', png }, { playerId: 'b1', png, bot: true } as any], 'kind');
    expect(r.map((v) => v.playerId)).toEqual(['p1', 'b1']);
    expect(r.every((v) => v.score >= 3 && v.score <= 7)).toBe(true);
  });
  test('screens roasts', async () => {
    converse.mockResolvedValue(out('[{"playerId":"p1","score":6,"roast":"BADWORD"}]'));
    const r = await host.judgeDrawings('x', [{ playerId: 'p1', png }], 'savage');
    expect(r[0]!.roast).not.toMatch(/BADWORD/);
    expect(r[0]!.roast.length).toBeGreaterThan(0);
  });
  test('caps at 4 drawings sent to the model', async () => {
    converse.mockResolvedValue(out('[]'));
    await host.judgeDrawings('x', ['a', 'b', 'c', 'd', 'e'].map((playerId) => ({ playerId, png })), 'kind');
    expect(converse.mock.calls[0]![0].messages[0].content.filter((c: any) => c.image)).toHaveLength(4);
  });
});

describe('triviaQuestions', () => {
  const good = { q: 'Which sweet is round?', options: ['Ladoo', 'Barfi', 'Jalebi', 'Peda'], answer: 0 };
  test('returns {q, options[4], answer} and drops invalid or blocked items', async () => {
    converse.mockResolvedValue(out(JSON.stringify([
      good, { q: 'bad', options: ['a', 'b'], answer: 1 }, { ...good, q: 'BADWORD?' }, { ...good, q: 'Second?', answer: 3 },
    ])));
    const r = await host.triviaQuestions('Ladoo Heist', ['Dad', 'Riya'], 4);
    expect(r.map((x) => x.q)).toEqual([good.q, 'Second?']);
    for (const x of r) { expect(x.options).toHaveLength(4); expect(x.answer).toBeGreaterThanOrEqual(0); expect(x.answer).toBeLessThanOrEqual(3); }
    expect(screenOutput).toHaveBeenCalledWith('Which sweet is round? Ladoo | Barfi | Jalebi | Peda', true);
  });
  test('AI down returns [] so the block uses its bank', async () => {
    converse.mockRejectedValue(new Error('down'));
    expect(await host.triviaQuestions('t', [], 3)).toEqual([]);
  });
});

describe('resolveJudgement', () => {
  test('maps engine payload shapes', async () => {
    converse.mockResolvedValue(out(JSON.stringify([{ q: 'Q?', options: ['a', 'b', 'c', 'd'], answer: 2 }])));
    const t = await host.resolveJudgement('trivia-gen', { topic: 'T', hook: 'H', ingredients: ['x'], players: ['Dad'], n: 3, aboutPlayers: true, familySafe: true });
    expect(t).toHaveLength(1);
    const d = await host.resolveJudgement('draw', { round: 1, prompt: 'p', judgeStyle: 'kind', entries: [{ playerId: 'b', name: 'Bot', image: png, bot: true }] }) as any[];
    expect(d[0].playerId).toBe('b');
  });
});

describe('speak', () => {
  test('speak caches by hash', async () => {
    s3.on(HeadObjectCommand).rejectsOnce(Object.assign(new Error('nf'), { name: 'NotFound' })).resolves({});
    s3.on(PutObjectCommand).resolves({});
    polly.on(SynthesizeSpeechCommand).resolves({ AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } } as any);
    const a = await speak('Hello Dad');
    const b = await speak('Hello Dad');
    expect(a).toBe(b);
    expect(a).toBe(`https://cdn.example.net/${voiceKey('Kajal', 'Hello Dad')}`);
    expect(voiceKey('Kajal', 'Hello Dad')).toMatch(/^voice\/[0-9a-f]{64}\.mp3$/);
    expect(polly.commandCalls(SynthesizeSpeechCommand)).toHaveLength(1);
    const input = polly.commandCalls(SynthesizeSpeechCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Engine: 'neural', VoiceId: 'Kajal', OutputFormat: 'mp3', LanguageCode: 'en-IN' });
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: 'assets-bkt', ContentType: 'audio/mpeg' });
  });
  test('falls back to Joanna when the voice is unavailable', async () => {
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
    s3.on(PutObjectCommand).resolves({});
    polly.on(SynthesizeSpeechCommand, { VoiceId: 'Kajal' }).rejects(Object.assign(new Error('v'), { name: 'ValidationException' }));
    polly.on(SynthesizeSpeechCommand, { VoiceId: 'Joanna' }).resolves({ AudioStream: { transformToByteArray: async () => new Uint8Array([9]) } } as any);
    const url = await speak('Different line');
    expect(url).toBe(`https://cdn.example.net/${voiceKey('Joanna', 'Different line')}`);
  });
});

describe('anthropic image translation', () => {
  test('Converse image blocks become base64 image blocks', async () => {
    const { toAnthropicMessages } = await import('../src/ai/anthropic');
    const m = toAnthropicMessages([{ role: 'user', content: [{ text: 'look' }, { image: { format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } } }] }]);
    expect(m[0]!.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } });
  });
});

describe('host-room', () => {
  test('host.say speaks a screened caption; voice failure still returns the caption', async () => {
    const { runHostMsg } = await import('../src/host-room');
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound' }));
    polly.on(SynthesizeSpeechCommand).rejects(new Error('polly down'));
    const r = await runHostMsg({ t: 'host.say', code: 'BCDF', id: 'a', text: 'Hello team' }) as any;
    expect(r).toEqual({ t: 'host.audio', id: 'a', text: 'Hello team' });
  });
  test('judge.request answers with judge.result matching the id', async () => {
    const { runHostMsg } = await import('../src/host-room');
    const r = await runHostMsg({ t: 'judge.request', code: 'BCDF', id: 'j1', kind: 'draw',
      payload: { round: 1, prompt: 'p', judgeStyle: 'kind', entries: [{ playerId: 'b', name: 'Bot', image: png, bot: true }] } }) as any;
    expect(r.t).toBe('judge.result');
    expect(r.id).toBe('j1');
    expect(r.result[0].playerId).toBe('b');
  });
});
