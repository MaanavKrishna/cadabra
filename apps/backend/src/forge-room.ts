import { randomBytes } from 'node:crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ClientToBackend, ForgeIngredient, RoomSettings } from '@cadabra/spec';
import { fallbackPitches } from './ai/designer';
import { themedFallback } from './fallback';
import type { Ctx } from './rooms';

/** A forge holds the room's lock this long at most (Forge Lambda timeout is 120 s). */
export const FORGE_LOCK_SEC = 125;

export interface ForgeEvent {
  code: string;
  forgeId: string;
  /** API Gateway management endpoint, https://{domain}/{stage}. */
  endpoint: string;
  startedAt: number;
  ingredients: ForgeIngredient[];
  players: (string | { id: string; name: string })[];
  settings: RoomSettings;
}

type PitchMsg = Extract<ClientToBackend, { t: 'forge.pitch' }>;
type VoteMsg = Extract<ClientToBackend, { t: 'forge.vote' }>;

const isCondFail = (e: unknown) =>
  e instanceof ConditionalCheckFailedException || (e as { name?: string })?.name === 'ConditionalCheckFailedException';

const post = async (ctx: Ctx, conn: string, msg: Parameters<Ctx['send']>[1]) => {
  try { return await ctx.send(conn, msg); } catch { return true; }
};

/** Only the room's TV may run the forge. */
async function isTvOf(ctx: Ctx, conn: string, code: string) {
  const me = (await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk: `CONN#${conn}`, sk: 'META' } }))).Item;
  return !!me && me.role === 'tv' && me.room === code;
}

async function update(ctx: Ctx, code: string, expr: string, values: Record<string, unknown>, cond?: string) {
  try {
    await ctx.ddb.send(new UpdateCommand({
      TableName: ctx.table, Key: { pk: `ROOM#${code}`, sk: 'META' },
      UpdateExpression: expr, ExpressionAttributeValues: values, ConditionExpression: cond,
    }));
    return true;
  } catch (e) {
    if (isCondFail(e)) return false;
    throw e;
  }
}

/**
 * TV -> forge.pitch: take the room's forge lock (a duplicate while a forge runs is rejected with
 * forge.busy) and start the Forge Lambda asynchronously. If it cannot be started, the TV still gets
 * three generic pitches and a playable fallback for each, so the room never sees an error.
 */
export async function startForge(ctx: Ctx, conn: string, msg: PitchMsg, opts: {
  invoke: (ev: ForgeEvent) => Promise<void>; endpoint: string; nowMs?: number;
}) {
  if (!(await isTvOf(ctx, conn, msg.code))) {
    return void (await post(ctx, conn, { t: 'error', code: 'room.badRequest', message: 'only the room TV can forge' }));
  }
  const nowMs = opts.nowMs ?? Date.now();
  const forgeId = randomBytes(6).toString('base64url');
  const locked = await update(ctx, msg.code,
    'SET forgeId = :f, forgeStartAt = :s, forgeBusyUntil = :u REMOVE forgeWinner, forgeVoteAt, forgePitchIds',
    { ':f': forgeId, ':s': nowMs, ':u': ctx.now() + FORGE_LOCK_SEC, ':now': ctx.now() },
    'attribute_exists(pk) AND (attribute_not_exists(forgeBusyUntil) OR forgeBusyUntil < :now)');
  if (!locked) return void (await post(ctx, conn, { t: 'error', code: 'forge.busy' }));
  const ev: ForgeEvent = {
    code: msg.code, forgeId, endpoint: opts.endpoint, startedAt: nowMs,
    ingredients: msg.ingredients, players: msg.players, settings: msg.settings,
  };
  try {
    await opts.invoke(ev);
  } catch (e) {
    console.warn('[forge] invoke failed; sending fallbacks', (e as Error)?.name, (e as Error)?.message);
    await offlineForge(ctx, conn, ev);
  }
}

/** No Forge Lambda: generic pitches (no unscreened player text) with a reskinned prebuilt game each. */
async function offlineForge(ctx: Ctx, conn: string, ev: ForgeEvent) {
  const pitches = fallbackPitches([]);
  await update(ctx, ev.code, 'SET forgePitchIds = :ids', { ':ids': pitches.map((p) => p.id), ':f': ev.forgeId }, 'forgeId = :f')
    .catch(() => false);
  await post(ctx, conn, { t: 'forge.pitches', forgeId: ev.forgeId, pitches });
  const seats = ev.settings.bots ? 4 : Math.min(4, Math.max(2, ev.players.length));
  const specs = await Promise.all(pitches.map((p) => themedFallback(p, { familySafe: ev.settings.familySafe, seats })));
  for (let i = 0; i < pitches.length; i++) {
    await post(ctx, conn, { t: 'forge.ready', pitchId: pitches[i]!.id, spec: specs[i]!, fallback: true });
  }
  await update(ctx, ev.code, 'REMOVE forgeBusyUntil', { ':f': ev.forgeId }, 'forgeId = :f').catch(() => false);
}

/**
 * TV -> forge.vote: record the winner and vote time once. A repeat of the same vote is a no-op;
 * a different or unknown pitch is forge.badVote. The Forge Lambda polls this to prioritize the winner.
 */
export async function recordVote(ctx: Ctx, conn: string, msg: VoteMsg, nowMs = Date.now()) {
  if (!(await isTvOf(ctx, conn, msg.code))) {
    return void (await post(ctx, conn, { t: 'error', code: 'room.badRequest', message: 'only the room TV can vote' }));
  }
  const ok = await update(ctx, msg.code, 'SET forgeWinner = :p, forgeVoteAt = :t', { ':p': msg.pitchId, ':t': nowMs },
    'contains(forgePitchIds, :p) AND attribute_not_exists(forgeWinner)');
  if (ok) return;
  const meta = (await ctx.ddb.send(new GetCommand({ TableName: ctx.table, Key: { pk: `ROOM#${msg.code}`, sk: 'META' } }))).Item;
  if (meta?.forgeWinner === msg.pitchId) return; // duplicate vote: idempotent
  await post(ctx, conn, { t: 'error', code: 'forge.badVote' });
}
