import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ArcadeArt, ArcadeGameSummary, BackendToClient, ClientToBackend, GameSpec } from '@cadabra/spec';
import { parseSpec } from '@cadabra/spec';
import type { Ctx } from './rooms';

/** Max games kept per household; the oldest unplayed / least recently played fall off. */
export const ARCADE_CAP = 50;
/** Max serialized size of {spec, art} accepted for one game. */
export const MAX_GAME_BYTES = 300_000;
/** arcade.game replies above this drop data: art (API GW caps server->client messages at 128 KB). */
const MAX_REPLY_BYTES = 120_000;

export type ArcadeMsg = Extract<ClientToBackend, { t: 'arcade.list' | 'arcade.save' | 'arcade.play' | 'arcade.delete' | 'arcade.played' }>;
export const ARCADE_MSG_TYPES = new Set<string>(['arcade.list', 'arcade.save', 'arcade.play', 'arcade.delete', 'arcade.played']);

type StoreCtx = Pick<Ctx, 'ddb' | 'table' | 'now'>;
const pk = (household: string) => `HH#${household}`;
const sk = (id: string) => `GAME#${id}`;
const isCondFail = (e: unknown) =>
  e instanceof ConditionalCheckFailedException || (e as { name?: string })?.name === 'ConditionalCheckFailedException';
const isHttps = (s?: string) => typeof s === 'string' && s.startsWith('https://');

const post = async (ctx: Ctx, conn: string, msg: BackendToClient) => {
  try { return await ctx.send(conn, msg); } catch { return true; }
};
const bad = (ctx: Ctx, conn: string, message: string) => post(ctx, conn, { t: 'error', code: 'room.badRequest', message });

/** Validate a spec + art for storage; returns the item fields or an error string. */
export function prepareGame(specIn: unknown, art: ArcadeArt | undefined): { spec: GameSpec; art: ArcadeArt | undefined } | string {
  const r = parseSpec(specIn);
  if (!r.ok) return `invalid spec: ${r.errors[0]}`;
  if (Buffer.byteLength(JSON.stringify({ spec: r.spec, art: art ?? null })) > MAX_GAME_BYTES) return 'game too large';
  return { spec: r.spec, art };
}

/** Store a new game. Never overwrites an existing one (returns false then). Trims to the cap. */
export async function putGame(
  ctx: StoreCtx, household: string, spec: GameSpec, art: ArcadeArt | undefined, opts: { played: boolean },
): Promise<boolean> {
  const now = ctx.now();
  try {
    await ctx.ddb.send(new PutCommand({
      TableName: ctx.table,
      Item: {
        pk: pk(household), sk: sk(spec.id), spec, art, title: spec.title, hook: spec.hook,
        palette: spec.theme.palette, keyArt: isHttps(art?.keyArt) ? art!.keyArt : undefined,
        playedCount: opts.played ? 1 : 0, lastPlayed: opts.played ? now : 0, unplayed: !opts.played,
        version: spec.version, createdAt: now,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (e) {
    if (isCondFail(e)) return false;
    throw e;
  }
  await trim(ctx, household, spec.id).catch(() => {});
  return true;
}

const LIGHT = 'sk, title, hook, palette, keyArt, playedCount, lastPlayed, unplayed, createdAt';
const LIGHT_NAMES = { '#t': 'title', '#h': 'hook' };
async function lightItems(ctx: StoreCtx, household: string) {
  const out: Record<string, any>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const r = await ctx.ddb.send(new QueryCommand({
      TableName: ctx.table, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :g)',
      ExpressionAttributeValues: { ':pk': pk(household), ':g': 'GAME#' },
      ProjectionExpression: LIGHT.replace('title', '#t').replace('hook', '#h'), ExpressionAttributeNames: LIGHT_NAMES,
      ExclusiveStartKey: key, ConsistentRead: true,
    }));
    out.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return out;
}

/** Most recently played first; unplayed pitches after the played ones (newest first). */
const sorted = (items: Record<string, any>[]) => [...items].sort((a, b) =>
  Number(!!a.unplayed) - Number(!!b.unplayed) || (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));

async function trim(ctx: StoreCtx, household: string, keepId: string) {
  const all = sorted(await lightItems(ctx, household));
  const drop = all.slice(ARCADE_CAP).filter((i) => i.sk !== sk(keepId));
  for (let i = 0; i < drop.length; i += 25) {
    await ctx.ddb.send(new BatchWriteCommand({
      RequestItems: { [ctx.table]: drop.slice(i, i + 25).map((d) => ({ DeleteRequest: { Key: { pk: pk(household), sk: d.sk } } })) },
    }));
  }
}

export async function listGames(ctx: StoreCtx, household: string): Promise<ArcadeGameSummary[]> {
  return sorted(await lightItems(ctx, household)).slice(0, ARCADE_CAP).map((i) => ({
    id: String(i.sk).slice('GAME#'.length), title: i.title, hook: i.hook, palette: i.palette,
    ...(isHttps(i.keyArt) ? { keyArt: i.keyArt } : {}),
    playedCount: i.playedCount ?? 0, lastPlayed: i.lastPlayed ?? 0, unplayed: !!i.unplayed,
  }));
}

/** Bump playedCount/lastPlayed on an existing game. */
async function bump(ctx: StoreCtx, household: string, id: string): Promise<boolean> {
  try {
    await ctx.ddb.send(new UpdateCommand({
      TableName: ctx.table, Key: { pk: pk(household), sk: sk(id) },
      UpdateExpression: 'SET lastPlayed = :t, unplayed = :f ADD playedCount :one',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':t': ctx.now(), ':f': false, ':one': 1 },
    }));
    return true;
  } catch (e) {
    if (isCondFail(e)) return false;
    throw e;
  }
}

/** Played: bump, or save as a new played game when unknown and a spec is given. */
export async function markPlayed(ctx: StoreCtx, household: string, id: string, spec?: GameSpec, art?: ArcadeArt) {
  if (await bump(ctx, household, id)) return;
  if (!spec) return;
  if (!(await putGame(ctx, household, { ...spec, id }, art, { played: true }))) await bump(ctx, household, id);
}

/** Forge hook: store a losing pitch's spec as an unplayed entry (never overwrites). */
export async function saveUnplayed(ctx: StoreCtx, household: string, spec: GameSpec) {
  const p = prepareGame(spec, undefined);
  if (typeof p === 'string') return false;
  return putGame(ctx, household, p.spec, undefined, { played: false });
}

/** The household the connection's TV room was created with, or undefined when not a TV. */
async function tvHousehold(ctx: Ctx, conn: string): Promise<string | undefined> {
  const me = (await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk: `CONN#${conn}`, sk: 'META' } }))).Item;
  if (!me || me.role !== 'tv' || typeof me.room !== 'string') return undefined;
  const meta = (await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk: `ROOM#${me.room}`, sk: 'META' } }))).Item;
  return typeof meta?.household === 'string' ? meta.household : undefined;
}

export async function handleArcade(ctx: Ctx, conn: string, m: ArcadeMsg) {
  const hh = await tvHousehold(ctx, conn);
  if (!hh || hh !== m.household) return void (await bad(ctx, conn, 'arcade is for the room TV and its own household'));
  if (m.t === 'arcade.list') return void (await post(ctx, conn, { t: 'arcade.items', games: await listGames(ctx, hh) }));
  if (m.t === 'arcade.delete') {
    await ctx.ddb.send(new DeleteCommand({ TableName: ctx.table, Key: { pk: pk(hh), sk: sk(m.specId) } }));
    return;
  }
  if (m.t === 'arcade.play') {
    const it = (await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk: pk(hh), sk: sk(m.specId) } }))).Item;
    if (!it) return void (await bad(ctx, conn, 'no such game'));
    let art: ArcadeArt | undefined = it.art;
    if (art && Buffer.byteLength(JSON.stringify({ spec: it.spec, art })) > MAX_REPLY_BYTES) {
      // Too big for one message: keep https art only.
      const sprites = Object.fromEntries(Object.entries(art.sprites ?? {}).filter(([, v]) => isHttps(v)));
      art = { ...(isHttps(art.keyArt) ? { keyArt: art.keyArt } : {}), ...(Object.keys(sprites).length ? { sprites } : {}) };
    }
    return void (await post(ctx, conn, { t: 'arcade.game', spec: it.spec, ...(art ? { art } : {}) }));
  }
  // save / played
  if (m.t === 'arcade.played' && m.spec === undefined) return void (await markPlayed(ctx, hh, m.specId));
  const p = prepareGame(m.spec, m.art);
  if (typeof p === 'string') return void (await bad(ctx, conn, p));
  if (m.t === 'arcade.played') return void (await markPlayed(ctx, hh, m.specId, p.spec, p.art));
  if (await putGame(ctx, hh, p.spec, p.art, { played: false })) return;
  // Already saved: refresh the art only.
  if (p.art) {
    await ctx.ddb.send(new UpdateCommand({
      TableName: ctx.table, Key: { pk: pk(hh), sk: sk(p.spec.id) }, UpdateExpression: 'SET art = :a, keyArt = :k',
      ExpressionAttributeValues: { ':a': p.art, ':k': isHttps(p.art.keyArt) ? p.art.keyArt : null },
    }));
  }
}
