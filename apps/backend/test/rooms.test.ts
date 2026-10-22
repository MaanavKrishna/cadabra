import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BackendToClientSchema, ClientToBackendSchema, MAX_PLAYERS, ROOM_CODE_RE } from '@cadabra/spec';
import { createRoom, disconnect, joinRoom, forward, resumeRoom, type Ctx } from '../src/rooms';

const ddbMock = mockClient(DynamoDBDocumentClient);
const store = new Map<string, Record<string, any>>();
const key = (i: any) => `${i.pk}|${i.sk}`;

function evalCond(item: any, cond: string | undefined, v: any, n: any = {}): boolean {
  if (!cond) return true;
  const nm = (f: string) => n[f] ?? f;
  return cond.split(' OR ').some((c) => {
    let m;
    if ((m = c.match(/^attribute_not_exists\((\w+)\)$/))) return !item || item[m[1]!] === undefined;
    if ((m = c.match(/^attribute_exists\((\w+)\)$/))) return !!item && item[m[1]!] !== undefined;
    if ((m = c.match(/^([#\w]+) (<|>|=) (:\w+)$/))) {
      const a = item?.[nm(m[1]!)], b = v[m[3]!];
      if (a === undefined) return false;
      return m[2] === '<' ? a < b : m[2] === '>' ? a > b : a === b;
    }
    throw new Error('fake: unsupported cond ' + c);
  });
}
function applyUpdate(item: any, expr: string, v: any, n: any = {}) {
  const nm = (f: string) => n[f] ?? f;
  const set = expr.match(/SET (.*?)(?: REMOVE|$)/)?.[1];
  const rem = expr.match(/REMOVE (.*?)(?: SET|$)/)?.[1];
  for (const a of set?.split(/, (?![^(]*\))/) ?? []) {
    const [lhs, rhs] = a.split(' = ') as [string, string];
    let m, val;
    if ((m = rhs.match(/^if_not_exists\((\w+), (:\w+)\) \+ (:\w+)$/))) val = (item[m[1]!] ?? v[m[2]!]) + v[m[3]!];
    else if ((m = rhs.match(/^(\w+) - (:\w+)$/))) val = item[m[1]!] - v[m[2]!];
    else val = v[rhs];
    item[nm(lhs)] = val;
  }
  for (const f of rem?.split(', ') ?? []) delete item[nm(f)];
}

let sent: Array<{ conn: string; msg: any }>;
let ctx: Ctx;
let gone: Set<string>;

beforeEach(() => {
  store.clear();
  ddbMock.reset();
  ddbMock.on(PutCommand).callsFake((i) => {
    if (i.ConditionExpression && !evalCond(store.get(key(i.Item)), i.ConditionExpression, {})) {
      throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
    }
    store.set(key(i.Item), i.Item);
    return {};
  });
  ddbMock.on(UpdateCommand).callsFake((i) => {
    const cur = store.get(key(i.Key));
    if (!evalCond(cur, i.ConditionExpression, i.ExpressionAttributeValues ?? {}, i.ExpressionAttributeNames)) {
      throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
    }
    const item = cur ?? { ...i.Key };
    applyUpdate(item, i.UpdateExpression, i.ExpressionAttributeValues ?? {}, i.ExpressionAttributeNames);
    store.set(key(i.Key), item);
    return {};
  });
  ddbMock.on(GetCommand).callsFake((i) => ({ Item: store.get(key(i.Key)) }));
  ddbMock.on(DeleteCommand).callsFake((i) => { store.delete(key(i.Key)); return {}; });
  ddbMock.on(QueryCommand).callsFake((i) => {
    const pk = i.ExpressionAttributeValues[':pk'];
    const p = i.ExpressionAttributeValues[':p'];
    return { Items: [...store.values()].filter((x) => x.pk === pk && x.sk.startsWith(p)) };
  });
  sent = [];
  ctx = {
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'ap-south-1' })),
    table: 'T',
    send: async (conn, msg) => { if (gone.has(conn)) return false; sent.push({ conn, msg }); return true; },
    now: () => 1_000_000,
  };
  gone = new Set();
});

const mkRoom = async () => {
  await createRoom(ctx, 'tv1', 'home');
  return sent.find((s) => s.msg.t === 'room.created')!.msg.code as string;
};
const lastTo = (conn: string, t: string) => [...sent].reverse().find((s) => s.conn === conn && s.msg.t === t)?.msg;

describe('rooms', () => {
  test('create returns 4-letter code', async () => {
    const code = await mkRoom();
    expect(code).toMatch(ROOM_CODE_RE);
    const created = sent[0]!.msg;
    expect(BackendToClientSchema.safeParse(created).success).toBe(true);
    expect(created.tvToken.length).toBeGreaterThanOrEqual(22);
    const meta = store.get(`ROOM#${code}|META`)!;
    expect(meta.tvConn).toBe('tv1');
    expect(meta.ttl).toBe(1_000_000 + 12 * 3600);
  });

  test('join unknown code -> error room.notFound', async () => {
    await joinRoom(ctx, 'p1', { t: 'room.join', code: 'ZZZZ', name: 'Riya' });
    expect(sent[0]!.msg).toMatchObject({ t: 'error', code: 'room.notFound' });
  });

  test('rejoinToken restores same playerId', async () => {
    const code = await mkRoom();
    await joinRoom(ctx, 'p1', { t: 'room.join', code, name: 'Riya' });
    const j = lastTo('p1', 'room.joined');
    await disconnect(ctx, 'p1');
    expect(lastTo('tv1', 'player.left')).toMatchObject({ playerId: j.playerId });
    await joinRoom(ctx, 'p9', { t: 'room.join', code, name: 'Riya', rejoinToken: j.token });
    const j2 = lastTo('p9', 'room.joined');
    expect(j2.playerId).toBe(j.playerId);
    expect(j2.name).toBe('Riya');
    expect(lastTo('tv1', 'player.joined').player.id).toBe(j.playerId);
  });

  test('name dedupe: second "Riya" becomes "Riya 2"', async () => {
    const code = await mkRoom();
    await joinRoom(ctx, 'p1', { t: 'room.join', code, name: ' Riya ' });
    await joinRoom(ctx, 'p2', { t: 'room.join', code, name: 'Riya' });
    expect(lastTo('p1', 'room.joined').name).toBe('Riya');
    expect(lastTo('p2', 'room.joined').name).toBe('Riya 2');
  });

  test('more than 4 players -> room.full', async () => {
    const code = await mkRoom();
    for (let i = 0; i < MAX_PLAYERS; i++) {
      await joinRoom(ctx, `p${i}`, { t: 'room.join', code, name: `P${i}` });
      expect(lastTo(`p${i}`, 'room.joined')).toBeTruthy();
    }
    await joinRoom(ctx, 'pX', { t: 'room.join', code, name: 'Extra' });
    expect(lastTo('pX', 'error')).toMatchObject({ code: 'room.full' });
  });

  test('signal and relay are forwarded', async () => {
    const code = await mkRoom();
    await joinRoom(ctx, 'p1', { t: 'room.join', code, name: 'A' });
    const pid = lastTo('p1', 'room.joined').playerId;
    await forward(ctx, 'p1', { t: 'signal', to: 'tv', data: { sdp: 1 } });
    expect(lastTo('tv1', 'signal')).toMatchObject({ from: pid, data: { sdp: 1 } });
    await forward(ctx, 'tv1', { t: 'relay', to: pid, data: 'hi' });
    expect(lastTo('p1', 'relay')).toMatchObject({ from: 'tv', data: 'hi' });
    await forward(ctx, 'p1', { t: 'relay', data: 'x' });
    expect(lastTo('tv1', 'relay')).toMatchObject({ from: pid, data: 'x' });
  });
});


describe('hardening', () => {
  const join = (conn: string, code: string, name: string, rejoinToken?: string) =>
    joinRoom(ctx, conn, { t: 'room.join', code, name, rejoinToken });

  test('non-room sender gets room.notInRoom', async () => {
    await forward(ctx, 'nobody', { t: 'signal', to: 'tv', data: 1 });
    expect(lastTo('nobody', 'error')).toMatchObject({ code: 'room.notInRoom' });
  });

  test('cross-room isolation', async () => {
    const a = await mkRoom();
    await createRoom(ctx, 'tv2', 'h');
    await join('pa', a, 'A');
    const pid = lastTo('pa', 'room.joined').playerId;
    await forward(ctx, 'tv2', { t: 'relay', to: pid, data: 'leak' });
    expect(lastTo('tv2', 'error')).toMatchObject({ code: 'room.targetGone' });
    expect(lastTo('pa', 'relay')).toBeUndefined();
  });

  test('phone->phone relay/signal rejected; tv must name a player', async () => {
    const code = await mkRoom();
    await join('p1', code, 'A'); await join('p2', code, 'B');
    const p2 = lastTo('p2', 'room.joined').playerId;
    await forward(ctx, 'p1', { t: 'relay', to: p2, data: 'x' });
    await forward(ctx, 'p1', { t: 'signal', to: p2, data: 'x' });
    expect(sent.filter((s) => s.conn === 'p1' && s.msg.code === 'room.badRequest')).toHaveLength(2);
    expect(lastTo('p2', 'relay')).toBeUndefined();
    await forward(ctx, 'tv1', { t: 'relay', data: 'x' });
    expect(lastTo('tv1', 'error')).toMatchObject({ code: 'room.badRequest' });
  });

  test('stale $disconnect after a rejoin does not clear the new conn', async () => {
    const code = await mkRoom();
    await join('p1', code, 'Riya');
    const j = lastTo('p1', 'room.joined');
    await join('p2', code, 'Riya', j.token); // rejoin before old disconnect fires
    sent.length = 0;
    await disconnect(ctx, 'p1');
    expect(store.get(`ROOM#${code}|PLAYER#${j.playerId}`)!.conn).toBe('p2');
    expect(store.get(`ROOM#${code}|META`)!.liveCount).toBe(1);
    expect(lastTo('tv1', 'player.left')).toBeUndefined();
  });

  test('tv drop sends tv.left, resume sends tv.back, bad token rejected', async () => {
    const code = await mkRoom();
    const tvToken = sent[0]!.msg.tvToken;
    await join('p1', code, 'A');
    await disconnect(ctx, 'tv1');
    expect(lastTo('p1', 'tv.left')).toBeTruthy();
    await resumeRoom(ctx, 'tvX', { t: 'room.resume', code, tvToken: 'nope' });
    expect(lastTo('tvX', 'error')).toMatchObject({ code: 'room.badToken' });
    await resumeRoom(ctx, 'tv2', { t: 'room.resume', code, tvToken });
    expect(lastTo('tv2', 'room.resumed').players).toHaveLength(1);
    expect(lastTo('p1', 'tv.back')).toBeTruthy();
    // stale disconnect of the old TV conn must not clear the new one
    await disconnect(ctx, 'tv1');
    expect(store.get(`ROOM#${code}|META`)!.tvConn).toBe('tv2');
  });

  test('ghost does not count toward the cap', async () => {
    const code = await mkRoom();
    for (let i = 0; i < 4; i++) await join(`p${i}`, code, `P${i}`);
    await disconnect(ctx, 'p0');
    await join('pNew', code, 'Newbie');
    expect(lastTo('pNew', 'room.joined')).toBeTruthy();
    await join('pNew2', code, 'Another');
    expect(lastTo('pNew2', 'error')).toMatchObject({ code: 'room.full' });
  });

  test('returning name matches a ghost -> reuses its slot', async () => {
    const code = await mkRoom();
    await join('p1', code, 'Riya');
    const id = lastTo('p1', 'room.joined').playerId;
    await disconnect(ctx, 'p1');
    await join('p2', code, 'riya');
    expect(lastTo('p2', 'room.joined')).toMatchObject({ playerId: id, name: 'Riya' });
  });

  test('send===false gives room.targetGone and clears conn', async () => {
    const code = await mkRoom();
    await join('p1', code, 'A');
    const pid = lastTo('p1', 'room.joined').playerId;
    gone.add('p1');
    await forward(ctx, 'tv1', { t: 'relay', to: pid, data: 1 });
    expect(lastTo('tv1', 'error')).toMatchObject({ code: 'room.targetGone' });
    expect(store.get(`ROOM#${code}|PLAYER#${pid}`)!.conn).toBeUndefined();
    gone.add('tv1');
    await join('p2', code, 'B'); // notify to gone TV is best-effort
    expect(lastTo('p2', 'room.joined')).toBeTruthy();
    expect(store.get(`ROOM#${code}|META`)!.tvConn).toBeUndefined();
  });

  test('expired room -> room.notFound', async () => {
    const code = await mkRoom();
    ctx.now = () => 1_000_000 + 13 * 3600;
    await join('p1', code, 'A');
    expect(lastTo('p1', 'error')).toMatchObject({ code: 'room.notFound' });
  });

  test('bad rejoinToken creates a new player', async () => {
    const code = await mkRoom();
    await join('p1', code, 'A');
    const id = lastTo('p1', 'room.joined').playerId;
    await join('p2', code, 'B', 'garbage');
    expect(lastTo('p2', 'room.joined').playerId).not.toBe(id);
  });

  test('create/join from a conn already in a room is rejected', async () => {
    const code = await mkRoom();
    await createRoom(ctx, 'tv1', 'h');
    expect(lastTo('tv1', 'error')).toMatchObject({ code: 'room.badRequest' });
    await join('p1', code, 'A'); await join('p1', code, 'B');
    expect(lastTo('p1', 'error')).toMatchObject({ code: 'room.badRequest' });
  });
});

describe('protocol bounds', () => {
  test('rejects oversized / control chars / bad code', () => {
    const ok = { t: 'room.join', code: 'BCDF', name: 'A' };
    expect(ClientToBackendSchema.safeParse({ ...ok, name: 'x'.repeat(41) }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ ...ok, name: 'a\u0007b' }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ ...ok, code: 'AEIO' }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ ...ok, rejoinToken: 'x'.repeat(65) }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ t: 'signal', to: 'x'.repeat(33), data: 1 }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ t: 'room.resume', code: 'BCDF', tvToken: 'x'.repeat(65) }).success).toBe(false);
  });
});

describe('protocol schemas', () => {
  test('client messages parse', () => {
    expect(ClientToBackendSchema.safeParse({ t: 'room.create', household: 'h' }).success).toBe(true);
    expect(ClientToBackendSchema.safeParse({ t: 'room.join', code: 'BCDF', name: 'A' }).success).toBe(true);
    expect(ClientToBackendSchema.safeParse({ t: 'room.join', code: 'BC', name: 'A' }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ t: 'nope' }).success).toBe(false);
  });
});
