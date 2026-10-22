import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { BackendErrorCode, BackendToClient, ClientToBackend } from '@cadabra/spec';
import { MAX_PLAYERS } from '@cadabra/spec';

export const ROOM_TTL_SEC = 12 * 3600;
// No vowels except A, so codes cannot spell words.
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZA';
const NAME_MAX = 16;
/** Max stored player records per room (live + disconnected "ghosts"). */
const MAX_RECORDS = MAX_PLAYERS * 2;

export interface Ctx {
  ddb: DynamoDBDocumentClient;
  table: string;
  /** Returns false when the connection is gone. */
  send: (conn: string, msg: BackendToClient) => Promise<boolean>;
  now: () => number; // epoch seconds
}

type Item = Record<string, any>;
const token = () => randomBytes(16).toString('base64url');
const tokenEq = (a: unknown, b: unknown) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const newCode = () => {
  const b = randomBytes(4);
  return Array.from(b, (x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
};

/** Best-effort send: never throws; resolves false if the connection is gone or the post failed. */
const post = async (ctx: Ctx, conn: string, msg: BackendToClient) => {
  try { return await ctx.send(conn, msg); } catch { return true; /* transient: do not treat as gone */ }
};
const err = (ctx: Ctx, conn: string, code: BackendErrorCode, message?: string) =>
  post(ctx, conn, { t: 'error', code, message });

const getItem = async (ctx: Ctx, pk: string, sk: string): Promise<Item | undefined> =>
  (await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk, sk } }))).Item;
const putItem = (ctx: Ctx, item: Item, condition?: string) =>
  ctx.ddb.send(new PutCommand({ TableName: ctx.table, Item: item, ConditionExpression: condition }));
const delItem = (ctx: Ctx, pk: string, sk: string) =>
  ctx.ddb.send(new DeleteCommand({ TableName: ctx.table, Key: { pk, sk } }));
const listPlayers = async (ctx: Ctx, code: string): Promise<Item[]> =>
  (await ctx.ddb.send(new QueryCommand({
    TableName: ctx.table,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
    ExpressionAttributeValues: { ':pk': `ROOM#${code}`, ':p': 'PLAYER#' },
  }))).Items ?? [];

/** Conditional update; true if applied, false if the condition failed. */
async function update(
  ctx: Ctx, pk: string, sk: string, expr: string, values: Item,
  condition?: string, names?: Record<string, string>,
): Promise<boolean> {
  try {
    await ctx.ddb.send(new UpdateCommand({
      TableName: ctx.table, Key: { pk, sk }, UpdateExpression: expr, ConditionExpression: condition,
      ExpressionAttributeValues: values, ExpressionAttributeNames: names,
    }));
    return true;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException || (e as any)?.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

// ---- atomic slot accounting on ROOM META (liveCount) ----
const claimSlot = (ctx: Ctx, code: string) =>
  update(ctx, `ROOM#${code}`, 'META', 'SET liveCount = if_not_exists(liveCount, :zero) + :one',
    { ':zero': 0, ':one': 1, ':max': MAX_PLAYERS },
    'attribute_not_exists(liveCount) OR liveCount < :max');
const releaseSlot = (ctx: Ctx, code: string) =>
  update(ctx, `ROOM#${code}`, 'META', 'SET liveCount = liveCount - :one', { ':one': 1, ':zero': 0 }, 'liveCount > :zero');

/** Mark a player disconnected only if `conn` is still theirs. Releases the slot on success. */
async function dropPlayer(ctx: Ctx, code: string, playerId: string, conn: string): Promise<boolean> {
  const ok = await update(ctx, `ROOM#${code}`, `PLAYER#${playerId}`, 'SET leftAt = :t REMOVE conn',
    { ':t': ctx.now(), ':me': conn }, 'conn = :me');
  if (ok) await releaseSlot(ctx, code);
  return ok;
}
const dropTv = (ctx: Ctx, code: string, conn: string) =>
  update(ctx, `ROOM#${code}`, 'META', 'REMOVE tvConn', { ':me': conn }, 'tvConn = :me');

const liveInfo = (p: Item) => ({ id: p.playerId as string, name: p.name as string, avatar: p.avatar as string | undefined });

async function hasConn(ctx: Ctx, conn: string) {
  return !!(await getItem(ctx, `CONN#${conn}`, 'META'));
}

async function notifyTv(ctx: Ctx, code: string, tvConn: unknown, msg: BackendToClient) {
  if (typeof tvConn !== 'string') return;
  if (!(await post(ctx, tvConn, msg))) await dropTv(ctx, code, tvConn).catch(() => {});
}
async function notifyPlayer(ctx: Ctx, code: string, p: Item, msg: BackendToClient) {
  if (typeof p.conn !== 'string') return;
  if (!(await post(ctx, p.conn, msg))) await dropPlayer(ctx, code, p.playerId, p.conn).catch(() => {});
}

export async function createRoom(ctx: Ctx, conn: string, household?: string) {
  if (await hasConn(ctx, conn)) return void (await err(ctx, conn, 'room.badRequest', 'already in a room'));
  const ttl = ctx.now() + ROOM_TTL_SEC;
  const tvToken = token();
  for (let i = 0; i < 10; i++) {
    const code = newCode();
    try {
      await putItem(ctx, {
        pk: `ROOM#${code}`, sk: 'META', tvConn: conn, tvToken, household, liveCount: 0, createdAt: ctx.now(), ttl,
      }, 'attribute_not_exists(pk)');
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException || (e as any)?.name === 'ConditionalCheckFailedException') continue;
      throw e;
    }
    await putItem(ctx, { pk: `CONN#${conn}`, sk: 'META', room: code, role: 'tv', ttl });
    await post(ctx, conn, { t: 'room.created', code, tvToken });
    return;
  }
  await err(ctx, conn, 'room.badRequest', 'could not allocate room code');
}

export async function resumeRoom(
  ctx: Ctx, conn: string, msg: Extract<ClientToBackend, { t: 'room.resume' }>,
) {
  if (await hasConn(ctx, conn)) return void (await err(ctx, conn, 'room.badRequest', 'already in a room'));
  const meta = await getItem(ctx, `ROOM#${msg.code}`, 'META');
  if (!meta || (meta.ttl as number) < ctx.now()) return void (await err(ctx, conn, 'room.notFound'));
  if (!tokenEq(meta.tvToken, msg.tvToken)) return void (await err(ctx, conn, 'room.badToken'));
  const old = meta.tvConn as string | undefined;
  await update(ctx, `ROOM#${msg.code}`, 'META', 'SET tvConn = :c', { ':c': conn });
  if (old && old !== conn) await delItem(ctx, `CONN#${old}`, 'META').catch(() => {});
  await putItem(ctx, { pk: `CONN#${conn}`, sk: 'META', room: msg.code, role: 'tv', ttl: meta.ttl });
  const live = (await listPlayers(ctx, msg.code)).filter((p) => p.conn);
  await post(ctx, conn, { t: 'room.resumed', players: live.map(liveInfo) });
  await Promise.all(live.map((p) => notifyPlayer(ctx, msg.code, p, { t: 'tv.back' })));
}

function uniqueName(raw: string, liveNames: string[]) {
  const base = raw.trim().slice(0, NAME_MAX) || 'Player';
  const used = new Set(liveNames.map((n) => n.toLowerCase()));
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
  if (await hasConn(ctx, conn)) return void (await err(ctx, conn, 'room.badRequest', 'already in a room'));
  const code = msg.code.toUpperCase();
  const meta = await getItem(ctx, `ROOM#${code}`, 'META');
  if (!meta || (meta.ttl as number) < ctx.now()) return void (await err(ctx, conn, 'room.notFound'));
  const ttl = meta.ttl as number;
  const players = await listPlayers(ctx, code);
  const live = players.filter((p) => p.conn);
  const ghosts = players.filter((p) => !p.conn).sort((a, b) => (a.leftAt ?? 0) - (b.leftAt ?? 0));
  const wanted = msg.name.trim().slice(0, NAME_MAX).toLowerCase();

  let player: Item | undefined;
  const existing = msg.rejoinToken ? players.find((p) => tokenEq(p.token, msg.rejoinToken)) : undefined;
  if (existing) {
    // Same identity. A ghost needs a live slot; a still-"live" stale conn is just replaced.
    if (!existing.conn && !(await claimSlot(ctx, code))) return void (await err(ctx, conn, 'room.full'));
    await update(ctx, `ROOM#${code}`, `PLAYER#${existing.playerId}`, 'SET conn = :c REMOVE leftAt', { ':c': conn });
    if (existing.conn && existing.conn !== conn) await delItem(ctx, `CONN#${existing.conn}`, 'META').catch(() => {});
    player = { ...existing, conn };
  } else {
    // Ghost with the same name -> reclaim that slot (new token). Else, if the room is
    // crowded with ghosts, recycle the oldest ghost.
    const sameName = ghosts.find((g) => (g.name as string).toLowerCase() === wanted);
    let reuse = sameName;
    if (!reuse && players.length >= MAX_RECORDS) reuse = ghosts[0];
    if (!(await claimSlot(ctx, code))) return void (await err(ctx, conn, 'room.full'));
    if (reuse && reuse === sameName) {
      const t = token();
      await update(ctx, `ROOM#${code}`, `PLAYER#${reuse.playerId}`, 'SET conn = :c, #tk = :t REMOVE leftAt',
        { ':c': conn, ':t': t }, undefined, { '#tk': 'token' });
      player = { ...reuse, conn, token: t };
    } else {
      if (reuse) await delItem(ctx, reuse.pk, reuse.sk);
      const playerId = randomBytes(6).toString('base64url');
      player = {
        pk: `ROOM#${code}`, sk: `PLAYER#${playerId}`, playerId, conn,
        name: uniqueName(msg.name, live.map((p) => p.name as string)), token: token(), ttl,
      };
      try { await putItem(ctx, player, 'attribute_not_exists(pk)'); } catch (e) { await releaseSlot(ctx, code); throw e; }
    }
  }
  await putItem(ctx, { pk: `CONN#${conn}`, sk: 'META', room: code, role: 'player', playerId: player.playerId, ttl });
  await post(ctx, conn, { t: 'room.joined', playerId: player.playerId, token: player.token, name: player.name });
  await notifyTv(ctx, code, meta.tvConn, { t: 'player.joined', player: liveInfo(player) });
  if (!meta.tvConn) await post(ctx, conn, { t: 'tv.left' });
}

export async function forward(
  ctx: Ctx, conn: string, msg: Extract<ClientToBackend, { t: 'signal' | 'relay' }>,
) {
  const me = await getItem(ctx, `CONN#${conn}`, 'META');
  if (!me) return void (await err(ctx, conn, 'room.notInRoom'));
  const code = me.room as string;
  const isTv = me.role === 'tv';
  const from = isTv ? 'tv' : (me.playerId as string);
  // Phones may only reach the TV; the TV must name a player.
  if (!isTv && msg.to && msg.to !== 'tv') return void (await err(ctx, conn, 'room.badRequest', 'phones can only target the tv'));
  if (isTv && (!msg.to || msg.to === 'tv')) return void (await err(ctx, conn, 'room.badRequest', 'tv must target a player'));

  if (isTv) {
    const p = await getItem(ctx, `ROOM#${code}`, `PLAYER#${msg.to}`);
    if (!p || typeof p.conn !== 'string') return void (await err(ctx, conn, 'room.targetGone'));
    if (!(await post(ctx, p.conn, { t: msg.t, from, data: msg.data }))) {
      await dropPlayer(ctx, code, p.playerId, p.conn).catch(() => {});
      await err(ctx, conn, 'room.targetGone');
    }
    return;
  }
  const meta = await getItem(ctx, `ROOM#${code}`, 'META');
  const tvConn = meta?.tvConn;
  if (typeof tvConn !== 'string') return void (await err(ctx, conn, 'room.targetGone'));
  if (!(await post(ctx, tvConn, { t: msg.t, from, data: msg.data }))) {
    await dropTv(ctx, code, tvConn).catch(() => {});
    await err(ctx, conn, 'room.targetGone');
  }
}

export async function disconnect(ctx: Ctx, conn: string) {
  const me = await getItem(ctx, `CONN#${conn}`, 'META');
  if (!me) return;
  await delItem(ctx, `CONN#${conn}`, 'META');
  const code = me.room as string;
  if (me.role === 'tv') {
    // A stale disconnect (TV already resumed on another conn) must not clear the new tvConn.
    if (!(await dropTv(ctx, code, conn))) return;
    const live = (await listPlayers(ctx, code)).filter((p) => p.conn);
    await Promise.all(live.map((p) => notifyPlayer(ctx, code, p, { t: 'tv.left' })));
    return;
  }
  // Keep the player record (identity/score) as a ghost so rejoinToken can restore it.
  if (!(await dropPlayer(ctx, code, me.playerId as string, conn))) return;
  const meta = await getItem(ctx, `ROOM#${code}`, 'META');
  await notifyTv(ctx, code, meta?.tvConn, { t: 'player.left', playerId: me.playerId as string });
}
