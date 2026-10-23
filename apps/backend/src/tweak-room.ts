import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { BackendToClient, ClientToBackend } from '@cadabra/spec';
import { tweak } from './ai/tweak';
import { isTvOf } from './forge-room';
import type { Ctx } from './rooms';

export type TweakMsg = Extract<ClientToBackend, { t: 'forge.tweak' }>;
/** Event for the Forge Lambda (it runs tweaks too: it has the engine, the memory and the AI access). */
export interface TweakEvent { kind: 'tweak'; conn: string; endpoint: string; receivedAt: number; msg: TweakMsg }
export const isTweakEvent = (ev: unknown): ev is TweakEvent => !!ev && typeof ev === 'object' && (ev as { kind?: unknown }).kind === 'tweak';

/** Tweaks per room (counter on the room META item). */
export const TWEAK_LIMIT = 60;
/** The hard cap counts from when the ws handler received the request. */
export const TWEAK_HARD_MS = 15_000;

const log = (...a: unknown[]) => console.warn('[tweak-room]', ...a);

/**
 * Runs one tweak and returns forge.tweaked. Never throws: if even the input spec is unusable the TV gets
 * nothing back (it replays its current game after its own timeout).
 */
export async function runTweakMsg(m: TweakMsg, opts: {
  receivedAt?: number; ai?: boolean; post?: (msg: BackendToClient) => void | Promise<unknown>;
} = {}): Promise<BackendToClient | undefined> {
  const t0 = opts.receivedAt ?? Date.now();
  try {
    const r = await tweak(m.spec, m.requests, {
      familySafe: m.familySafe ?? true, seats: m.seats, mode: m.mode, ai: opts.ai,
      hardStop: t0 + TWEAK_HARD_MS,
      onProgress: (step) => { void Promise.resolve(opts.post?.({ t: 'forge.tweakProgress', id: m.id, step })).catch(() => {}); },
    });
    return {
      t: 'forge.tweaked', id: m.id, spec: r.spec, summary: r.summary, changes: r.changes, source: r.source,
      ...(r.blocked ? { blocked: true } : {}), ms: Date.now() - t0,
    };
  } catch (e) {
    log('failed:', (e as Error)?.name, (e as Error)?.message);
    return undefined;
  }
}

/**
 * ws handler side: only the room's TV may tweak. The work runs in the Forge Lambda (async; it replies to
 * the TV itself). If it cannot be started, the chip presets are applied right here (no AI, well under 1 s).
 */
export async function requestTweak(ctx: Ctx, conn: string, m: TweakMsg, opts: {
  invoke: (ev: TweakEvent) => Promise<void>; endpoint: string; nowMs?: number;
}): Promise<void> {
  const reply = async (msg: BackendToClient) => { try { await ctx.send(conn, msg); } catch { /* best-effort */ } };
  if (!(await isTvOf(ctx, conn, m.code))) {
    return reply({ t: 'error', code: 'room.badRequest', message: 'only the room TV can tweak' });
  }
  const receivedAt = opts.nowMs ?? Date.now();
  if (!(await takeBudget(ctx, m.code))) {
    // Over budget: still answer, with presets only.
    const r = await runTweakMsg(m, { receivedAt, ai: false });
    return r ? reply(r) : reply({ t: 'error', code: 'room.rateLimited' });
  }
  try {
    await opts.invoke({ kind: 'tweak', conn, endpoint: opts.endpoint, receivedAt, msg: m });
  } catch (e) {
    log('invoke failed; presets only', (e as Error)?.name);
    const r = await runTweakMsg(m, { receivedAt, ai: false });
    if (r) await reply(r);
  }
}

async function takeBudget(ctx: Ctx, code: string): Promise<boolean> {
  try {
    await ctx.ddb.send(new UpdateCommand({
      TableName: ctx.table, Key: { pk: `ROOM#${code}`, sk: 'META' },
      UpdateExpression: 'ADD #c :one',
      ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(#c) OR #c < :max)',
      ExpressionAttributeNames: { '#c': 'rlTweak' },
      ExpressionAttributeValues: { ':one': 1, ':max': TWEAK_LIMIT },
    }));
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
