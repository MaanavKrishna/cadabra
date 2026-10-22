import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import {
  BackendToClientSchema, ClientToBackendSchema, DEFAULT_SETTINGS, FALLBACK_SPECS, parseSpec, pickFallback,
  type BackendToClient, type GameSpec, type Pitch,
} from '@cadabra/spec';

vi.mock('../src/ai/bedrock', () => ({
  IMAGE_REGION: 'us-west-2',
  MODELS: { image: 'img', removeBg: 'rm' },
  converse: vi.fn(async () => { throw new Error('no ai in tests'); }),
  screen: vi.fn(async (text: string) => ({ allowed: !/BADWORD/.test(text), reason: /BADWORD/.test(text) ? 'policy' : undefined })),
  screenOutput: vi.fn(async (text: string) => ({ allowed: !/BADWORD/.test(text), reason: /BADWORD/.test(text) ? 'policy' : undefined })),
}));

const { runForge, pctFor } = await import('../src/forge');
const { themedFallback } = await import('../src/fallback');
const { startForge, recordVote, claimForgeRun } = await import('../src/forge-room');
process.env.TABLE_NAME = 'T';
const forgeLambda = await import('../src/handlers/forge');
const { runPlaytest } = await import('../src/ai/tools');
const { fallbackPitches } = await import('../src/ai/designer');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PITCHES: Pitch[] = [
  { id: 'pa', title: 'Samosa Heist', hook: 'Sneak samosas past a grumpy cat.', keyArtPrompt: 'cat and samosas, no text', palette: FALLBACK_SPECS[0]!.theme.palette, blocksSketch: ['sneak', 'collect'] },
  { id: 'pb', title: 'Jelly Panic', hook: 'Grab jelly, dodge falling spoons.', keyArtPrompt: 'jelly rain, no text', palette: FALLBACK_SPECS[1]!.theme.palette, blocksSketch: ['arena-move', 'collect', 'dodge'] },
  { id: 'pc', title: 'Goat Tug', hook: 'Two teams, one rope, one goat.', keyArtPrompt: 'goat on a rope, no text', palette: FALLBACK_SPECS[2]!.theme.palette, blocksSketch: ['tug'] },
];
const aiSpec = (p: Pitch): GameSpec => ({ ...structuredClone(FALLBACK_SPECS[0]!), id: `ai-${p.id}`, title: p.title });

type Ev = { at: number; what: string; msg?: BackendToClient; conn?: string };

/** Harness: in-memory room + scripted AI. */
function harness(over: {
  design?: (p: Pitch, c: any) => Promise<{ spec: GameSpec }>;
  pitch?: (...a: any[]) => Promise<Pitch[]>;
  voteAfterMs?: number; winner?: string;
  budgets?: Record<string, number>;
  ingredients?: any[];
  art?: (...a: any[]) => Promise<void>;
} = {}) {
  const t0 = Date.now();
  const log: Ev[] = [];
  const room: { tvConn: string; winner?: string; voteAt?: number; pitchIds?: string[] } = { tvConn: 'tv1' };
  if (over.voteAfterMs !== undefined) {
    setTimeout(() => { room.winner = over.winner ?? 'pb'; room.voteAt = Date.now(); log.push({ at: Date.now() - t0, what: 'vote' }); }, over.voteAfterMs);
  }
  const losers: string[] = [];
  const deps = {
    post: async (conn: string, msg: BackendToClient) => { log.push({ at: Date.now() - t0, what: `post:${msg.t}`, msg, conn }); return true; },
    room: async () => ({ tvConn: room.tvConn, winner: room.winner, voteAt: room.voteAt }),
    setPitchIds: async (ids: string[]) => { room.pitchIds = ids; },
    done: async () => { log.push({ at: Date.now() - t0, what: 'done' }); },
    pitch: over.pitch ?? (async () => structuredClone(PITCHES)),
    design: async (p: Pitch, c: any) => {
      log.push({ at: Date.now() - t0, what: `design:start:${p.id}` });
      const r = await (over.design ?? (async (pp: Pitch, cc: any) => { cc.onProgress('Picking blocks'); await sleep(50); cc.onProgress('Game ready'); return { spec: aiSpec(pp) }; }))(p, c);
      log.push({ at: Date.now() - t0, what: `design:end:${p.id}` });
      return { ...r, report: { ok: true, reasons: [], stats: {} as any }, toolCalls: 1 };
    },
    onLoserReady: (p: Pitch) => { losers.push(p.id); },
    art: over.art ?? (async () => {}),
  };
  const job = {
    code: 'BCDF', forgeId: 'f1', startedAt: t0, hardStop: t0 + 20_000,
    ingredients: over.ingredients ?? ['samosa', { text: 'grumpy cat', playerId: 'p1' }, 'jelly'],
    players: [{ id: 'p1', name: 'Asha', conn: 'ph1' }, { id: 'p2', name: 'Ravi', conn: 'ph2' }],
    settings: DEFAULT_SETTINGS,
    budgets: { pitchMs: 1000, designMs: 3000, winnerMs: 400, pollMs: 20, voteWaitMs: 150, screenMs: 300, ...over.budgets },
  };
  return { log, room, losers, run: () => runForge(job, deps as any), t0 };
}
const posts = (log: Ev[], t: string, conn = 'tv1') => log.filter((e) => e.what === `post:${t}` && e.conn === conn);

describe('forge art', () => {
  test('winner art: key art at the vote, sprites once the spec is ready, only for the winner, posted as forge.art', async () => {
    const calls: { id: string; only: any; deadline: number }[] = [];
    const h = harness({
      voteAfterMs: 100, winner: 'pb',
      art: async (spec: any, onEach: any, deadline: number, _fs: boolean, only: any) => {
        calls.push({ id: spec.id, only, deadline });
        if (only.keyArt) onEach('keyArt', 'https://cdn.test/art/x/keyArt.png');
        else onEach('imp', 'https://cdn.test/art/x/imp.png');
      },
    });
    await h.run();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'f1-pb', only: { keyArt: true, sprites: false } });
    expect(calls[1]).toMatchObject({ id: 'ai-pb', only: { keyArt: false, sprites: true } });
    const art = posts(h.log, 'forge.art');
    expect(art.map((e) => (e.msg as any).key).sort()).toEqual(['imp', 'keyArt']);
    for (const e of art) {
      expect(BackendToClientSchema.safeParse(e.msg).success).toBe(true);
      expect((e.msg as any).pitchId).toBe('pb');
    }
  });

  test('no art message and no delay when the art step does nothing (image provider down)', async () => {
    const h = harness({ voteAfterMs: 50, winner: 'pa' });
    const t = Date.now();
    await h.run();
    expect(posts(h.log, 'forge.art')).toHaveLength(0);
    expect(Date.now() - t).toBeLessThan(2500);
  });

  test('a throwing art step never breaks the forge', async () => {
    const h = harness({ voteAfterMs: 50, winner: 'pa', art: async () => { throw new Error('boom'); } });
    await h.run();
    expect(posts(h.log, 'forge.ready').length).toBe(3);
  });
});

describe('forge orchestration', () => {
  test('pitches emitted before designs start', async () => {
    const h = harness({ voteAfterMs: 400 });
    await h.run();
    const iPitch = h.log.findIndex((e) => e.what === 'post:forge.pitches' && e.conn === 'tv1');
    const iDesign = h.log.findIndex((e) => e.what.startsWith('design:start'));
    expect(iPitch).toBeGreaterThanOrEqual(0);
    expect(iDesign).toBeGreaterThan(iPitch);
    const msg = h.log[iPitch]!.msg!;
    expect(BackendToClientSchema.safeParse(msg).success).toBe(true);
    expect(h.room.pitchIds).toEqual(['pa', 'pb', 'pc']);
    // phones see the pitches too
    expect(posts(h.log, 'forge.pitches', 'ph1')).toHaveLength(1);
  });

  test('three designs run concurrently', async () => {
    const h = harness({
      voteAfterMs: 50,
      design: async (p, c) => { c.onProgress('Picking blocks'); await sleep(150); return { spec: aiSpec(p) }; },
    });
    await h.run();
    const starts = h.log.filter((e) => e.what.startsWith('design:start')).map((e) => e.at);
    const ends = h.log.filter((e) => e.what.startsWith('design:end')).map((e) => e.at);
    expect(starts).toHaveLength(3);
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));
    const ready = posts(h.log, 'forge.ready');
    expect(ready.map((e) => (e.msg as any).pitchId).sort()).toEqual(['pa', 'pb', 'pc']);
    expect(ready.every((e) => !(e.msg as any).fallback)).toBe(true);
    const prog = posts(h.log, 'forge.progress');
    expect(prog.length).toBeGreaterThanOrEqual(3);
    for (const e of [...ready, ...prog]) {
      expect(BackendToClientSchema.safeParse(e.msg).success).toBe(true);
      expect((e.msg as any).forgeId).toBe('f1');
    }
    // losers' AI specs go to the arcade hook
    expect(h.losers.sort()).toEqual(['pa', 'pc']);
  });

  test('forge falls back when agent fails', async () => {
    const h = harness({
      voteAfterMs: 30, winner: 'pc',
      design: async (p) => { if (p.id === 'pc') throw new Error('ThrottlingException'); await sleep(20); return { spec: aiSpec(p) }; },
    });
    await h.run();
    const r = posts(h.log, 'forge.ready').find((e) => (e.msg as any).pitchId === 'pc')!.msg as any;
    expect(r.fallback).toBe(true);
    expect(r.spec.title).toBe('Goat Tug');
    expect(r.spec.blocks[0].block).toBe('tug');
    expect(r.spec.theme.palette).toEqual(PITCHES[2]!.palette);
    expect(runPlaytest(r.spec, 4).report.ok).toBe(true);
    expect(BackendToClientSchema.safeParse(r).success).toBe(true);
  });

  test('fallback spec passes playtest', async () => {
    // Every library game passes the strict playtest at every head count it can be picked for
    // (team games need 2 vs 2, so pickFallback only offers them with 4 seats).
    const seatsFor = (s: GameSpec) => (s.teams === 2 ? [4] : [2, 3, 4]);
    for (const base of FALLBACK_SPECS) {
      expect(parseSpec(base).ok).toBe(true);
      for (const n of seatsFor(base)) expect(runPlaytest(base, n).report.reasons).toEqual([]);
    }
    for (const p of [...PITCHES, ...fallbackPitches(['ladoo', 'sleeping bear', 'lava'])]) {
      for (const seats of [2, 3, 4]) {
        const spec = await themedFallback(p, { ingredients: ['ladoo', 'sleeping bear'], familySafe: true, seats });
        expect(runPlaytest(spec, seats).report.reasons).toEqual([]);
        expect(spec.title).toBe(p.title);
      }
    }
    expect(pickFallback(['tug'], { seats: 2 }).teams).toBe(0);
    expect(pickFallback(['tug']).id).toBe('fallback-bear-tug');
    expect(pickFallback(['arena-move', 'dodge']).id).toBe('fallback-lava-penguins');
    expect(pickFallback(['sneak', 'collect']).id).toBe('fallback-ladoo-heist');
    expect(pickFallback(['trivia']).id).toBe('fallback-ladoo-heist');
  });

  test('themed fallback uses generic text when screening blocks the pitch', async () => {
    const bad: Pitch = { ...PITCHES[0]!, title: 'BADWORD Heist' };
    const spec = await themedFallback(bad, { ingredients: ['samosa'], familySafe: true });
    expect(spec.title).toBe(FALLBACK_SPECS[0]!.title);
    expect(JSON.stringify(spec)).not.toContain('BADWORD');
    expect(spec.theme.palette).toEqual(bad.palette);
  });

  test('winner deadline: fallback at vote + winner budget, losers dropped', async () => {
    const h = harness({
      voteAfterMs: 100, winner: 'pb',
      budgets: { winnerMs: 300, designMs: 900 },
      design: () => new Promise(() => {}), // hangs forever
    });
    const res = await h.run();
    const vote = h.log.find((e) => e.what === 'vote')!.at;
    const ready = posts(h.log, 'forge.ready');
    expect(ready).toHaveLength(1);
    expect((ready[0]!.msg as any).pitchId).toBe('pb');
    expect((ready[0]!.msg as any).fallback).toBe(true);
    expect(ready[0]!.at - vote).toBeGreaterThanOrEqual(290);
    expect(ready[0]!.at - vote).toBeLessThan(800);
    expect(h.log.at(-1)!.what).toBe('done');
    expect(res.winnerReadyMs).toBeDefined();
  });

  test('winner always gets the full window after the vote, even past its own design deadline', async () => {
    const h = harness({
      voteAfterMs: 100, winner: 'pa',
      budgets: { designMs: 150, winnerMs: 400 },
      design: () => new Promise(() => {}),
    });
    await h.run();
    const vote = h.log.find((e) => e.what === 'vote')!.at;
    const ready = posts(h.log, 'forge.ready').find((e) => (e.msg as any).pitchId === 'pa')!;
    expect(ready.at - vote).toBeGreaterThanOrEqual(390);
  });

  test('a throwing reskin still yields a plain playable fallback', async () => {
    const t0 = Date.now();
    const sent: BackendToClient[] = [];
    await runForge({
      code: 'BCDF', forgeId: 'f1', startedAt: t0, hardStop: t0 + 5000, ingredients: ['x'], players: [], settings: DEFAULT_SETTINGS,
      budgets: { pitchMs: 200, designMs: 2000, winnerMs: 500, pollMs: 20, voteWaitMs: 100, screenMs: 100 },
    }, {
      post: async (_c: string, m: BackendToClient) => { sent.push(m); return true; },
      room: async () => ({ tvConn: 'tv1' }), setPitchIds: async () => {}, done: async () => {},
      pitch: async () => structuredClone(PITCHES),
      design: async () => { throw new Error('ai down'); },
      fallback: async () => { throw new Error('reskin broke'); },
    });
    const ready = sent.filter((m) => m.t === 'forge.ready') as any[];
    expect(ready).toHaveLength(3);
    for (const r of ready) expect(runPlaytest(r.spec, 4).report.ok).toBe(true);
  });

  test('a hung post times out instead of stalling the forge', async () => {
    const t0 = Date.now();
    await runForge({
      code: 'BCDF', forgeId: 'f1', startedAt: t0, hardStop: t0 + 20_000, ingredients: ['x'], players: [], settings: DEFAULT_SETTINGS,
      budgets: { pitchMs: 200, designMs: 2000, winnerMs: 500, pollMs: 20, voteWaitMs: 100, screenMs: 100 },
    }, {
      post: () => new Promise(() => {}),
      room: async () => ({ tvConn: 'tv1', winner: 'pa', voteAt: t0 }), setPitchIds: async () => {}, done: async () => {},
      pitch: async () => structuredClone(PITCHES),
      design: async (p: Pitch) => ({ spec: aiSpec(p), report: {} as any, toolCalls: 0 }),
    });
    // pitches + 3 readies, each post capped at 3 s; far below the 20 s hard stop
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 20_000);

  test('before the vote, a failed design is sent as a fallback right away', async () => {
    const h = harness({ voteAfterMs: 500, design: async () => { throw new Error('boom'); } });
    await h.run();
    const ready = posts(h.log, 'forge.ready');
    expect(ready).toHaveLength(3);
    expect(ready.every((e) => (e.msg as any).fallback && e.at < 500)).toBe(true);
  });

  test('pitch call that hangs still yields 3 pitches within the pitch budget', async () => {
    const h = harness({ voteAfterMs: 400, pitch: () => new Promise(() => {}), budgets: { pitchMs: 250 } });
    await h.run();
    const p = posts(h.log, 'forge.pitches')[0]!;
    expect(p.at).toBeLessThan(450);
    expect((p.msg as any).pitches).toHaveLength(3);
  });

  test('blocked ingredient is dropped and its player told', async () => {
    let seen: string[] = [];
    const h = harness({
      voteAfterMs: 100,
      ingredients: ['samosa', { text: 'BADWORD thing', playerId: 'p1' }],
      pitch: async (ing: string[]) => { seen = ing; return structuredClone(PITCHES); },
    });
    await h.run();
    expect(seen).toEqual(['samosa']);
    expect(posts(h.log, 'screen', 'ph1').map((e) => e.msg)).toEqual([{ t: 'screen', name: 'blocked' }]);
    expect(posts(h.log, 'screen', 'ph2')).toHaveLength(0);
  });

  test('never runs past the hard stop', async () => {
    // no vote ever, everything hangs: the hard stop still ends the run with a fallback per pitch
    const t0 = Date.now();
    const res = await runForge({ code: 'BCDF', forgeId: 'f1', startedAt: t0, hardStop: t0 + 600,
      ingredients: ['x'], players: [], settings: DEFAULT_SETTINGS,
      budgets: { pitchMs: 200, designMs: 60_000, winnerMs: 60_000, pollMs: 20, voteWaitMs: 60_000, screenMs: 100 } },
    {
      post: async () => true, room: async () => ({ tvConn: 'tv1' }), setPitchIds: async () => {}, done: async () => {},
      pitch: async () => structuredClone(PITCHES), design: () => new Promise(() => {}),
    } as any);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res.readies).toBe(3); // unresolved pitches get fallbacks at the hard stop (no vote known)
  });

  test('progress pct is monotonic and ends at 100', () => {
    let pct = 0;
    for (const s of ['Reading the ingredients', 'Picking blocks', 'Tuning the bear', 'Tuning the bear', 'Bots are playtesting', 'Checking the rules', 'Final bot playtest', 'Game ready']) {
      const next = pctFor(s, pct);
      expect(next).toBeGreaterThanOrEqual(pct);
      pct = next;
    }
    expect(pct).toBe(100);
  });
});

// ---------------------------------------------------------------- ws side: start + vote

const ddbMock = mockClient(DynamoDBDocumentClient);
const store = new Map<string, Record<string, any>>();
const key = (i: any) => `${i.pk}|${i.sk}`;
/** Tiny DynamoDB condition evaluator (enough for the expressions forge-room uses). */
function cond(item: any, expr: string | undefined, v: any): boolean {
  if (!expr) return true;
  const js = expr
    .replace(/attribute_not_exists\((\w+)\)/g, '(it.$1===undefined)')
    .replace(/attribute_exists\((\w+)\)/g, '(it.$1!==undefined)')
    .replace(/contains\((\w+), (:\w+)\)/g, '((it.$1||[]).includes(v["$2"]))')
    .replace(/(\w+) (<|>|=) (:\w+)/g, (_m, a, op, b) => `(it.${a}!==undefined&&it.${a}${op === '=' ? '===' : op}v["${b}"])`)
    .replace(/ AND /g, '&&').replace(/ OR /g, '||');
  return new Function('it', 'v', `return ${js};`)(item ?? {}, v);
}
function applyUpdate(item: any, expr: string, v: any) {
  const set = expr.match(/SET (.*?)(?: REMOVE|$)/)?.[1];
  const rem = expr.match(/REMOVE (.*?)(?: SET|$)/)?.[1];
  for (const a of set?.split(', ') ?? []) { const [l, r] = a.split(' = ') as [string, string]; item[l] = v[r]; }
  for (const f of rem?.split(', ') ?? []) delete item[f.trim()];
}

describe('forge room ops', () => {
  let sent: { conn: string; msg: any }[];
  let ctx: any;
  beforeEach(() => {
    store.clear();
    ddbMock.reset();
    ddbMock.on(GetCommand).callsFake((i) => ({ Item: store.get(key(i.Key)) }));
    ddbMock.on(PutCommand).callsFake((i) => { store.set(key(i.Item), i.Item); return {}; });
    ddbMock.on(QueryCommand).callsFake(() => ({ Items: [] }));
    ddbMock.on(UpdateCommand).callsFake((i) => {
      const cur = store.get(key(i.Key));
      if (!cond(cur, i.ConditionExpression, i.ExpressionAttributeValues ?? {})) {
        throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
      }
      const item = cur ?? { ...i.Key };
      applyUpdate(item, i.UpdateExpression, i.ExpressionAttributeValues ?? {});
      store.set(key(i.Key), item);
      return {};
    });
    sent = [];
    ctx = {
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' })),
      table: 'T', now: () => 1_000_000,
      send: async (conn: string, msg: any) => { sent.push({ conn, msg }); return true; },
    };
    store.set('ROOM#BCDF|META', { pk: 'ROOM#BCDF', sk: 'META', tvConn: 'tv1', ttl: 2_000_000 });
    store.set('CONN#tv1|META', { pk: 'CONN#tv1', sk: 'META', room: 'BCDF', role: 'tv' });
    store.set('CONN#ph1|META', { pk: 'CONN#ph1', sk: 'META', room: 'BCDF', role: 'player', playerId: 'p1' });
  });
  const pitchMsg = ClientToBackendSchema.parse({
    t: 'forge.pitch', code: 'BCDF', ingredients: ['samosa', { text: 'cat', playerId: 'p1' }], players: ['Asha'], settings: DEFAULT_SETTINGS,
  }) as Extract<ReturnType<typeof ClientToBackendSchema.parse>, { t: 'forge.pitch' }>;
  const vote = (pitchId: string) => ({ t: 'forge.vote' as const, code: 'BCDF', pitchId });

  test('forge.pitch from the TV invokes the forge once; a duplicate while busy is rejected', async () => {
    const invoked: any[] = [];
    const invoke = async (p: any) => { invoked.push(p); };
    await startForge(ctx, 'tv1', pitchMsg, { invoke, endpoint: 'https://x/prod', nowMs: 5_000 });
    await startForge(ctx, 'tv1', pitchMsg, { invoke, endpoint: 'https://x/prod', nowMs: 6_000 });
    expect(invoked).toHaveLength(1);
    expect(invoked[0]).toMatchObject({ code: 'BCDF', endpoint: 'https://x/prod', startedAt: 5_000, ingredients: pitchMsg.ingredients });
    expect(sent.at(-1)!.msg).toMatchObject({ t: 'error', code: 'forge.busy' });
  });

  test('forge.pitch from a phone is rejected', async () => {
    const invoke = vi.fn(async () => {});
    await startForge(ctx, 'ph1', pitchMsg, { invoke, endpoint: 'https://x/prod', nowMs: 5_000 });
    expect(invoke).not.toHaveBeenCalled();
    expect(sent[0]!.msg).toMatchObject({ t: 'error', code: 'room.badRequest' });
  });

  test('if the forge cannot be invoked, the TV still gets 3 pitches and 3 playable fallbacks', async () => {
    await startForge(ctx, 'tv1', pitchMsg, { invoke: async () => { throw new Error('nope'); }, endpoint: 'e', nowMs: 5_000 });
    const msgs = sent.filter((s) => s.conn === 'tv1').map((s) => s.msg);
    expect(msgs[0].t).toBe('forge.pitches');
    const ready = msgs.filter((m) => m.t === 'forge.ready');
    expect(ready).toHaveLength(3);
    for (const r of ready) expect(runPlaytest(r.spec, 4).report.ok).toBe(true);
    // the votes still validate against these pitches
    await recordVote(ctx, 'tv1', vote(msgs[0].pitches[1].id), 7_000);
    expect(store.get('ROOM#BCDF|META')!.forgeWinner).toBe(msgs[0].pitches[1].id);
  });

  test('duplicate forge event does not start a second forge', async () => {
    const api = mockClient(ApiGatewayManagementApiClient);
    api.on(PostToConnectionCommand).resolves({});
    const meta = store.get('ROOM#BCDF|META')!;
    meta.forgeId = 'f1'; meta.forgeBusyUntil = 1_000_100;
    const ev = { code: 'BCDF', forgeId: 'f1', startedAt: Date.now(), endpoint: 'https://x/prod', ingredients: [], players: [], settings: DEFAULT_SETTINGS };
    expect(await claimForgeRun(ctx, ev, 'req-1', ev.startedAt + 100, 8000)).toBe('ok');
    expect(meta.forgeRunner).toBe('req-1');
    expect(await claimForgeRun(ctx, ev, 'req-2', ev.startedAt + 200, 8000)).toBe('duplicate');
    // the Lambda handler bails before posting anything
    const r = await forgeLambda.handler(ev as any, { getRemainingTimeInMillis: () => 120_000, awsRequestId: 'req-3' });
    expect(r).toEqual({ skipped: 'duplicate' });
    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(0);
    expect(meta.forgeRunner).toBe('req-1');
    api.restore();
  });

  test('stale forge event (older than the pitch budget) bails and releases the lock', async () => {
    const api = mockClient(ApiGatewayManagementApiClient);
    api.on(PostToConnectionCommand).resolves({});
    const meta = store.get('ROOM#BCDF|META')!;
    meta.forgeId = 'f1'; meta.forgeBusyUntil = 1_000_100;
    const ev = { code: 'BCDF', forgeId: 'f1', startedAt: Date.now() - 9000, endpoint: 'https://x/prod', ingredients: [], players: [], settings: DEFAULT_SETTINGS };
    const r = await forgeLambda.handler(ev as any, { getRemainingTimeInMillis: () => 120_000, awsRequestId: 'req-1' });
    expect(r).toEqual({ skipped: 'stale' });
    expect(meta.forgeRunner).toBeUndefined();
    expect(meta.forgeBusyUntil).toBeUndefined();
    expect(api.commandCalls(PostToConnectionCommand)).toHaveLength(0);
    api.restore();
  });

  test('forge.vote is idempotent', async () => {
    const meta = store.get('ROOM#BCDF|META')!;
    meta.forgeId = 'f1'; meta.forgePitchIds = ['pa', 'pb', 'pc'];
    await recordVote(ctx, 'tv1', vote('pb'), 10_000);
    await recordVote(ctx, 'tv1', vote('pb'), 12_000);
    expect(meta.forgeWinner).toBe('pb');
    expect(meta.forgeVoteAt).toBe(10_000);
    expect(sent).toHaveLength(0);
    await recordVote(ctx, 'tv1', vote('pc'), 13_000);
    expect(meta.forgeWinner).toBe('pb');
    expect(sent.at(-1)!.msg).toMatchObject({ t: 'error', code: 'forge.badVote' });
  });

  test('vote for an unknown pitch or from a phone is rejected', async () => {
    const meta = store.get('ROOM#BCDF|META')!;
    meta.forgeId = 'f1'; meta.forgePitchIds = ['pa', 'pb', 'pc'];
    await recordVote(ctx, 'tv1', vote('zz'), 10_000);
    await recordVote(ctx, 'ph1', vote('pa'), 10_000);
    expect(meta.forgeWinner).toBeUndefined();
    expect(sent.map((s) => s.msg.code)).toEqual(['forge.badVote', 'room.badRequest']);
  });
});

test('a TV that reconnects mid-forge gets the pitches and ready specs replayed', async () => {
  const sentTo: string[] = [];
  let tv = 'tv1';
  setTimeout(() => { tv = 'tv2'; }, 120);
  const t0 = Date.now();
  await runForge({
    code: 'BCDF', forgeId: 'f1', startedAt: t0, hardStop: t0 + 5000, ingredients: ['x'], players: [], settings: DEFAULT_SETTINGS,
    budgets: { pitchMs: 200, designMs: 2000, winnerMs: 500, pollMs: 20, voteWaitMs: 200, screenMs: 100 },
  }, {
    post: async (conn: string, msg: BackendToClient) => { sentTo.push(`${conn}:${msg.t}`); return true; },
    room: async () => ({ tvConn: tv }), setPitchIds: async () => {}, done: async () => {},
    pitch: async () => structuredClone(PITCHES),
    design: async (p: Pitch) => { await sleep(20); return { spec: aiSpec(p), report: {} as any, toolCalls: 0 }; },
  });
  expect(sentTo.filter((s) => s === 'tv2:forge.pitches')).toHaveLength(1);
  expect(sentTo.filter((s) => s === 'tv2:forge.ready')).toHaveLength(3);
});
