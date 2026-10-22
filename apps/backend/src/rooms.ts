import { randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { BackendErrorCode, BackendToClient, ClientToBackend } from '@cadabra/spec';
import { MAX_PLAYERS } from '@cadabra/spec';

export const ROOM_TTL_SEC = 12 * 3600;
// No vowels except A, so codes cannot spell words.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZA';
const NAME_MAX = 16;

export interface Ctx {
  ddb: DynamoDBDocumentClient;
  table: string;
  /** Returns false when the connection is gone. */
  send: (conn: string, msg: BackendToClient) => Promise<boolean>;
  now: () => number; // epoch seconds
}

const token = () => randomBytes(16).toString('base64url');
const newCode = () => {
  const b = randomBytes(4);
  return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
};
const err = (ctx: Ctx, conn: string, code: BackendErrorCode, message?: string) =>
  ctx.send(conn, { t: 'error', code, message });

const getItem = async (ctx: Ctx, pk: string, sk: string) =>
  (await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk, sk } }))).Item;
const putItem = (ctx: Ctx, item: Record<string, unknown>, condition?: string) =>
  ctx.ddb.send(new PutCommand({ TableName: ctx.table, Item: item, ConditionExpression: condition }));
const listPlayers = async (ctx: Ctx, code: string) =>
  (await ctx.ddb.send(new QueryCommand({
    TableName: ctx.table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
    ExpressionAttributeValues: { ':pk': `ROOM#${code}`, ':p': 'PLAYER#' },
  }))).Items ?? [];

export async function createRoom(ctx: Ctx, conn: string, household?: string) {
  const ttl = ctx.now() + ROOM_TTL_SEC;
  const tvToken = token();
  for (let i = 0; i < 10; i++) {
    const code = newCode();
    try {
      await putItem(ctx, {
        pk: `ROOM#${code}`, sk: 'META', tvConn: conn, tvToken, household, createdAt: ctx.now(), ttl,
      }, 'attribute_not_exists(pk)');
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException || (e as any)?.name === 'ConditionalCheckFailedException') continue;
      throw e;
    }
    await putItem(ctx, { pk: `CONN#${conn}`, sk: 'META', room: code, role: 'tv', ttl });
    await ctx.send(conn, { t: 'room.created', code, tvToken });
    return;
  }
  await err(ctx, conn, 'room.badRequest', 'could not allocate room code');
}

function uniqueName(raw: string, taken: string[], exclude?: string) {
  const base = raw.trim().slice(0, NAME_MAX) || 'Player';
  const used = new Set(taken.filter((n) => n !== exclude).map((n) => n.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const cand = base.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!used.has(cand.toLowerCase())) return cand;
  }
}

export async function joinRoom(
  ctx: Ctx, conn: string, msg: Extract<ClientToBackend, { t: 'room.join' }>,
) {
  const code = msg.code.toUpperCase();
  const meta = await getItem(ctx, `ROOM#${code}`, 'META');
  if (!meta || (meta.ttl as number) < ctx.now()) return void (await err(ctx, conn, 'room.notFound'));
  const ttl = meta.ttl as number;
  const players = await listPlayers(ctx, code);

  const existing = msg.rejoinToken ? players.find((p) => p.token === msg.rejoinToken) : undefined;
  let player: Record<string, any>;
  if (existing) {
    if (existing.conn && existing.conn !== conn) {
      await ctx.ddb.send(new DeleteCommand({ TableName: ctx.table, Key: { pk: `CONN#${existing.conn}`, sk: 'META' } }));
    }
    player = { ...existing, conn };
  } else {
    if (players.length >= MAX_PLAYERS) return void (await err(ctx, conn, 'room.full'));
    const playerId = randomBytes(6).toString('base64url');
    player = {
      pk: `ROOM#${code}`, sk: `PLAYER#${playerId}`, playerId, conn,
      name: uniqueName(msg.name, players.map((p) => p.name as string)),
      avatar: undefined, token: token(), ttl,
    };
  }
  await putItem(ctx, player);
  await putItem(ctx, { pk: `CONN#${conn}`, sk: 'META', room: code, role: 'player', playerId: player.playerId, ttl });
  await ctx.send(conn, { t: 'room.joined', playerId: player.playerId, token: player.token, name: player.name });
  if (meta.tvConn) {
    await ctx.send(meta.tvConn as string, {
      t: 'player.joined', player: { id: player.playerId, name: player.name, avatar: player.avatar },
    });
  }
}

/** Resolve a routing target ('tv' or playerId) to a connection id. */
async function resolve(ctx: Ctx, code: string, to: string): Promise<string | undefined> {
  if (to === 'tv') return (await getItem(ctx, `ROOM#${code}`, 'META'))?.tvConn as string | undefined;
  return (await getItem(ctx, `ROOM#${code}`, `PLAYER#${to}`))?.conn as string | undefined;
}

export async function forward(
  ctx: Ctx, conn: string, msg: Extract<ClientToBackend, { t: 'signal' | 'relay' }>,
) {
  const me = await getItem(ctx, `CONN#${conn}`, 'META');
  if (!me) return void (await err(ctx, conn, 'room.notInRoom'));
  const code = me.room as string;
  const from = me.role === 'tv' ? 'tv' : (me.playerId as string);
  const to = msg.to ?? 'tv'; // relay without `to` goes to the TV
  const target = await resolve(ctx, code, to);
  if (!target) return void (await err(ctx, conn, 'room.targetGone'));
  const ok = await ctx.send(target, { t: msg.t, from, data: msg.data });
  if (!ok) await err(ctx, conn, 'room.targetGone');
}

export async function disconnect(ctx: Ctx, conn: string) {
  const me = await getItem(ctx, `CONN#${conn}`, 'META');
  if (!me) return;
  await ctx.ddb.send(new DeleteCommand({ TableName: ctx.table, Key: { pk: `CONN#${conn}`, sk: 'META' } }));
  const code = me.room as string;
  if (me.role === 'tv') {
    const meta = await getItem(ctx, `ROOM#${code}`, 'META');
    // Only clear if this is still the TV connection (it may have reconnected).
    if (meta && meta.tvConn === conn) await putItem(ctx, { ...meta, tvConn: undefined });
    return;
  }
  const p = await getItem(ctx, `ROOM#${code}`, `PLAYER#${me.playerId}`);
  // Keep the player record (identity/score) so rejoinToken can restore it.
  if (p && p.conn === conn) await putItem(ctx, { ...p, conn: undefined });
  const meta = await getItem(ctx, `ROOM#${code}`, 'META');
  if (meta?.tvConn) await ctx.send(meta.tvConn as string, { t: 'player.left', playerId: me.playerId as string });
}
