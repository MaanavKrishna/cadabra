import { describe, expect, test } from 'vitest';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ClientToBackendSchema, FALLBACK_SPECS, type GameSpec } from '@cadabra/spec';
import { ARCADE_CAP, MAX_GAME_BYTES, handleArcade, saveUnplayed } from '../src/arcade';

/** Minimal in-memory DynamoDB document client covering the commands arcade.ts uses. */
let queryLimit: number | undefined;
function fakeDb() {
  const items = new Map<string, Record<string, any>>();
  const k = (key: any) => `${key.pk}|${key.sk}`;
  const fail = () => new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
  return {
    items,
    async send(c: any) {
      const i = c.input;
      if (c instanceof GetCommand) return { Item: items.get(k(i.Key)) };
      if (c instanceof PutCommand) {
        if (i.ConditionExpression?.includes('attribute_not_exists') && items.has(k(i.Item))) throw fail();
        items.set(k(i.Item), structuredClone(i.Item));
        return {};
      }
      if (c instanceof DeleteCommand) { items.delete(k(i.Key)); return {}; }
      if (c instanceof BatchWriteCommand) {
        for (const r of i.RequestItems[Object.keys(i.RequestItems)[0]!]) items.delete(k(r.DeleteRequest.Key));
        return {};
      }
      if (c instanceof UpdateCommand) {
        const it = items.get(k(i.Key));
        if (i.ConditionExpression?.includes('attribute_exists') && !it) throw fail();
        if (!it) return {};
        const v = i.ExpressionAttributeValues;
        if (v[':one']) { it.playedCount = (it.playedCount ?? 0) + 1; it.lastPlayed = v[':t']; it.unplayed = v[':f']; }
        if (v[':a']) { it.art = v[':a']; it.keyArt = v[':k']; }
        return {};
      }
      if (c instanceof QueryCommand) {
        const pk = i.ExpressionAttributeValues[':pk'], g = i.ExpressionAttributeValues[':g'];
        const all = [...items.values()].filter((x) => x.pk === pk && x.sk.startsWith(g)).sort((a, b) => (a.sk < b.sk ? -1 : 1));
        const from = i.ExclusiveStartKey ? all.findIndex((x) => x.sk === i.ExclusiveStartKey.sk) + 1 : 0;
        const page = all.slice(from, from + (queryLimit ?? all.length));
        const more = from + page.length < all.length;
        return {
          Items: page.map((x) => { const { spec, art, ...rest } = x; return rest; }),
          LastEvaluatedKey: more ? { pk, sk: page[page.length - 1]!.sk } : undefined,
        };
      }
      throw new Error('unexpected ' + c.constructor.name);
    },
  };
}

function setup(household: string | null = 'hh1') {
  const db = fakeDb();
  let t = 1000;
  const sent: any[] = [];
  const ctx: any = { ddb: db, table: 'T', now: () => t, send: async (_c: string, m: any) => { sent.push(m); return true; } };
  db.items.set('CONN#tv|META', { pk: 'CONN#tv', sk: 'META', role: 'tv', room: 'BCDF' });
  db.items.set('CONN#ph|META', { pk: 'CONN#ph', sk: 'META', role: 'player', room: 'BCDF' });
  db.items.set('ROOM#BCDF|META', { pk: 'ROOM#BCDF', sk: 'META', household: household ?? undefined });
  return { db, ctx, sent, tick: (n = 10) => { t += n; } };
}
const spec = (id: string, title = id): GameSpec => ({ ...structuredClone(FALLBACK_SPECS[0]!), id, title });
const msg = (m: unknown) => ClientToBackendSchema.parse(m) as any;
const last = (s: any[]) => s[s.length - 1];

describe('arcade', () => {
  test('played game auto-saves with playedCount 1', async () => {
    const { ctx, sent } = setup();
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'g1', spec: spec('g1') }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    expect(last(sent).games).toMatchObject([{ id: 'g1', playedCount: 1, unplayed: false }]);
  });

  test('played again bumps the count and lastPlayed', async () => {
    const { ctx, sent, tick } = setup();
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'g1', spec: spec('g1') }));
    tick();
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'g1' }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    expect(last(sent).games[0]).toMatchObject({ playedCount: 2, lastPlayed: 1010 });
  });

  test('losing pitches saved unplayed (forge hook), sorted after played games, never overwritten', async () => {
    const { db, ctx, sent } = setup();
    expect(await saveUnplayed(ctx, 'hh1', spec('lose'))).toBe(true);
    expect(await saveUnplayed(ctx, 'hh1', spec('lose'))).toBe(false);
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'g1', spec: spec('g1') }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    expect(last(sent).games.map((g: any) => [g.id, g.unplayed])).toEqual([['g1', false], ['lose', true]]);
    expect(db.items.get('HH#hh1|GAME#lose')!.playedCount).toBe(0);
  });

  test('list returns games sorted by lastPlayed', async () => {
    const { ctx, sent, tick } = setup();
    for (const id of ['a', 'b', 'c']) {
      await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: id, spec: spec(id) }));
      tick();
    }
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'a' }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    expect(last(sent).games.map((g: any) => g.id)).toEqual(['a', 'c', 'b']);
  });

  test('household isolation: other household sees nothing', async () => {
    const { db, ctx, sent } = setup();
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'g1', spec: spec('g1') }));
    db.items.set('ROOM#OTHR|META', { pk: 'ROOM#OTHR', sk: 'META', household: 'hh2' });
    db.items.set('CONN#tv2|META', { pk: 'CONN#tv2', sk: 'META', role: 'tv', room: 'OTHR' });
    await handleArcade(ctx, 'tv2', msg({ t: 'arcade.list', household: 'hh2' }));
    expect(last(sent)).toMatchObject({ t: 'arcade.items', games: [] });
  });

  test('auth: non-TV, household mismatch and household-less rooms are rejected, nothing stored', async () => {
    const { db, ctx, sent } = setup();
    const save = (h: string) => msg({ t: 'arcade.save', household: h, spec: spec('x') });
    await handleArcade(ctx, 'ph', save('hh1'));
    await handleArcade(ctx, 'tv', save('hh2'));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh2' }));
    expect(sent.map((s) => s.t)).toEqual(['error', 'error', 'error']);
    expect([...db.items.keys()].some((x) => x.startsWith('HH#'))).toBe(false);
    const none = setup(null);
    await handleArcade(none.ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    expect(none.sent[0].t).toBe('error');
  });

  test('invalid and oversize specs are rejected', async () => {
    const { db, ctx, sent } = setup();
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.save', household: 'hh1', spec: { nope: 1 } }));
    const art = { sprites: Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`s${i}`, 'https://x.test/' + 'a'.repeat(MAX_GAME_BYTES / 2)])) };
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.save', household: 'hh1', spec: spec('big'), art }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.save', household: 'hh1', spec: spec('d'), art: { keyArt: 'data:image/png;base64,AAAA' } }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'd', spec: spec('d'), art: { keyArt: 'data:image/png;base64,AAAA' } }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: 'other', spec: spec('mismatch') }));
    expect(sent.map((s) => s.t)).toEqual(['error', 'error', 'error', 'error', 'error']);
    expect([...db.items.keys()].some((x) => x.startsWith('HH#'))).toBe(false);
  });

  test('play returns the full spec and art; delete removes it', async () => {
    const { ctx, sent } = setup();
    const art = { keyArt: 'https://x.test/a.png' };
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.save', household: 'hh1', spec: spec('g1'), art }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.play', household: 'hh1', specId: 'g1' }));
    expect(last(sent)).toMatchObject({ t: 'arcade.game', spec: { id: 'g1' }, art });
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    expect(last(sent).games[0]).toMatchObject({ keyArt: art.keyArt, unplayed: true });
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.delete', household: 'hh1', specId: 'g1' }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.play', household: 'hh1', specId: 'g1' }));
    expect(last(sent).t).toBe('error');
  });

  test('50 played games + a new loser: total stays 50, loser listed, oldest played evicted', async () => {
    const { ctx, sent, tick } = setup();
    for (let i = 0; i < ARCADE_CAP; i++) {
      await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: `p${i}`, spec: spec(`p${i}`) }));
      tick();
    }
    expect(await saveUnplayed(ctx, 'hh1', spec('loser'))).toBe(true);
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    const ids = last(sent).games.map((g: any) => g.id);
    expect(ids).toHaveLength(ARCADE_CAP);
    expect(ids).toContain('loser');
    expect(ids).not.toContain('p0');
    expect(ids).toContain('p1');
  });

  test('over the cap evicts unplayed before played', async () => {
    const { ctx, sent, tick } = setup();
    await saveUnplayed(ctx, 'hh1', spec('oldU')); tick();
    for (let i = 0; i < ARCADE_CAP; i++) {
      await handleArcade(ctx, 'tv', msg({ t: 'arcade.played', household: 'hh1', specId: `p${i}`, spec: spec(`p${i}`) }));
      tick();
    }
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    const ids = last(sent).games.map((g: any) => g.id);
    expect(ids).not.toContain('oldU');
    expect(ids).toContain('p0');
  });

  test('list paginates through DynamoDB pages', async () => {
    const { ctx, sent } = setup();
    for (let i = 0; i < 7; i++) await saveUnplayed(ctx, 'hh1', spec(`u${i}`));
    queryLimit = 2;
    try { await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' })); } finally { queryLimit = undefined; }
    expect(last(sent).games).toHaveLength(7);
  });

  test('delete cannot reach another household', async () => {
    const { db, ctx } = setup();
    await saveUnplayed(ctx, 'hh2', spec('theirs'));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.delete', household: 'hh2', specId: 'theirs' }));
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.delete', household: 'hh1', specId: 'theirs' }));
    expect(db.items.has('HH#hh2|GAME#theirs')).toBe(true);
  });

  test('capped at 50, dropping the oldest unplayed', async () => {
    const { ctx, sent, tick } = setup();
    for (let i = 0; i < ARCADE_CAP + 3; i++) { await saveUnplayed(ctx, 'hh1', spec(`u${i}`)); tick(); }
    await handleArcade(ctx, 'tv', msg({ t: 'arcade.list', household: 'hh1' }));
    const ids = last(sent).games.map((g: any) => g.id);
    expect(ids).toHaveLength(ARCADE_CAP);
    expect(ids).toContain(`u${ARCADE_CAP + 2}`);
    expect(ids).not.toContain('u0');
  });
});
