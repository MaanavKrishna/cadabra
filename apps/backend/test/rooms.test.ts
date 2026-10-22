import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BackendToClientSchema, ClientToBackendSchema, MAX_PLAYERS, ROOM_CODE_RE } from '@cadabra/spec';
import { createRoom, disconnect, joinRoom, forward, type Ctx } from '../src/rooms';

const ddbMock = mockClient(DynamoDBDocumentClient);
const store = new Map<string, Record<string, any>>();
const key = (i: any) => `${i.pk}|${i.sk}`;

let sent: Array<{ conn: string; msg: any }>;
let ctx: Ctx;

beforeEach(() => {
  store.clear();
  ddbMock.reset();
  ddbMock.on(PutCommand).callsFake((i) => {
    if (i.ConditionExpression?.includes('attribute_not_exists') && store.has(key(i.Item))) {
      throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
    }
    store.set(key(i.Item), i.Item);
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
    send: async (conn, msg) => { sent.push({ conn, msg }); return true; },
    now: () => 1_000_000,
  };
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

describe('protocol schemas', () => {
  test('client messages parse', () => {
    expect(ClientToBackendSchema.safeParse({ t: 'room.create', household: 'h' }).success).toBe(true);
    expect(ClientToBackendSchema.safeParse({ t: 'room.join', code: 'BCDF', name: 'A' }).success).toBe(true);
    expect(ClientToBackendSchema.safeParse({ t: 'room.join', code: 'BC', name: 'A' }).success).toBe(false);
    expect(ClientToBackendSchema.safeParse({ t: 'nope' }).success).toBe(false);
  });
});
