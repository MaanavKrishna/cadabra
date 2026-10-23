import type { BackendToClient, ClientToBackend, RoomSettings } from '@cadabra/spec';
import { hostLine, offlineJudgement, resolveJudgement, roast, tidyLine } from './ai/host';
import { screenOutput } from './ai/bedrock';
import { speak } from './ai/voice';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Ctx } from './rooms';
import { isTvOf } from './forge-room';

export type HostMsg = Extract<ClientToBackend, { t: 'host.say' | 'host.roast' | 'judge.request' }>;
/** Event for the Host Lambda (invoked async by the ws handler). */
export interface HostEvent { conn: string; endpoint: string; msg: HostMsg }
export const HOST_MSG_TYPES = new Set<string>(['host.say', 'host.roast', 'judge.request']);

/** judge.request payloads above this (serialized) are rejected: WS messages cap at 128 KB, async invokes at 256 KB. */
export const MAX_JUDGE_PAYLOAD_BYTES = 110_000;
/** Per-room cap per kind of request (counters live on the room META item). */
export const HOST_LIMITS = { 'host.roast': 30, 'judge.request': 60, 'host.say': 300 } as const;
const COUNTER = { 'host.roast': 'rlRoast', 'judge.request': 'rlJudge', 'host.say': 'rlSay' } as const;

const log = (...a: unknown[]) => console.warn('[host-room]', ...a);
type Personality = NonNullable<RoomSettings['hostPersonality']>;
const personalityOf = (m: { personality?: RoomSettings['hostPersonality'] }) => m.personality ?? 'cheeky';

/** Speak a caption; voice failure just means no url (the TV shows the caption anyway). */
async function audioFor(text: string, voice: boolean | undefined, personality: Personality): Promise<string | undefined> {
  if (voice === false) return undefined;
  try { return await speak(text, personality); } catch (e) { log('speak failed:', (e as Error)?.name); return undefined; }
}

/** Runs one host/judge request and returns the single reply for the requesting TV. Never throws. */
export async function runHostMsg(m: HostMsg): Promise<BackendToClient | undefined> {
  const familySafe = m.t === 'judge.request' ? true : m.familySafe ?? true;
  try {
    if (m.t === 'host.say') {
      let text = m.text ? tidyLine(m.text, 40) : '';
      if (text) {
        const ok = await screenOutput(text, familySafe).catch(() => ({ allowed: false }));
        if (!ok.allowed) text = '';
      }
      if (!text) text = await hostLine(m.kind ?? 'fallback', m.ctx ?? {}, personalityOf(m), { familySafe });
      const url = await audioFor(text, m.voice, personalityOf(m));
      return { t: 'host.audio', id: m.id, text, ...(url ? { url } : {}) };
    }
    if (m.t === 'host.roast') {
      const players = m.players.map((p) => ({ ...p, avatar: '', isBot: false, connected: true, score: 0 }));
      const lines = await roast(m.events, players, { title: m.title, hook: m.hook }, { familySafe, personality: personalityOf(m) });
      const urls = await Promise.all(lines.map((l) => audioFor(l, m.voice, personalityOf(m)).then((u) => u ?? null)));
      return { t: 'host.roasted', id: m.id, lines, urls };
    }
    return { t: 'judge.result', id: m.id, result: await resolveJudgement(m.kind, m.payload) };
  } catch (e) {
    log('failed:', (e as Error)?.name);
    return m.t === 'judge.request' ? { t: 'judge.result', id: m.id, result: offlineJudgement(m.kind, m.payload) } : undefined;
  }
}

/**
 * ws handler side: only the room's TV may ask. Hands the work to the Host Lambda asynchronously (the ws Lambda
 * stays under its 10 s limit; a judged drawing alone can take 7 s). If the worker cannot be started, a judgement
 * is answered locally with deterministic middling results and a host.say gets its caption back unvoiced.
 */
export async function requestHost(ctx: Ctx, conn: string, m: HostMsg, opts: {
  invoke: (ev: HostEvent) => Promise<void>; endpoint: string;
}): Promise<void> {
  const reply = async (msg: BackendToClient) => { try { await ctx.send(conn, msg); } catch { /* best-effort */ } };
  if (!(await isTvOf(ctx, conn, m.code))) {
    return reply({ t: 'error', code: 'room.badRequest', message: 'only the room TV can ask the host' });
  }
  if (m.t === 'judge.request' && Buffer.byteLength(JSON.stringify(m.payload ?? null)) > MAX_JUDGE_PAYLOAD_BYTES) {
    return reply({ t: 'error', code: 'room.badRequest', message: 'judge payload too large' });
  }
  if (!(await takeBudget(ctx, m.code, m.t))) return reply({ t: 'error', code: 'room.rateLimited' });
  try {
    await opts.invoke({ conn, endpoint: opts.endpoint, msg: m });
  } catch (e) {
    log('invoke failed', (e as Error)?.name);
    if (m.t === 'judge.request') await reply({ t: 'judge.result', id: m.id, result: offlineJudgement(m.kind, m.payload) });
    else if (m.t === 'host.say' && m.text) await reply({ t: 'host.audio', id: m.id, text: m.text });
  }
}

/** Atomically count one request against the room's budget; false once the cap is reached. */
async function takeBudget(ctx: Ctx, code: string, kind: keyof typeof HOST_LIMITS): Promise<boolean> {
  try {
    await ctx.ddb.send(new UpdateCommand({
      TableName: ctx.table, Key: { pk: `ROOM#${code}`, sk: 'META' },
      UpdateExpression: 'ADD #c :one',
      ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(#c) OR #c < :max)',
      ExpressionAttributeNames: { '#c': COUNTER[kind] },
      ExpressionAttributeValues: { ':one': 1, ':max': HOST_LIMITS[kind] },
    }));
    return true;
  } catch (e) {
    if ((e as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
