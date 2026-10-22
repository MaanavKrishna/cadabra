import type { BackendToClient, ForgeIngredient, GameSpec, Pitch, RoomSettings } from '@cadabra/spec';
import { pickFallback } from '@cadabra/spec';
import { screen } from './ai/bedrock';
import { artForSpec } from './ai/art';
import { design as aiDesign, fallbackPitches, newSpecId, pitch as aiPitch } from './ai/designer';
import { themedFallback } from './fallback';

/**
 * Forge: ingredients -> 3 pitches (≤ 8 s) -> all 3 designed in parallel while the room votes ->
 * the winner is playable ≤ 25 s after the vote (AI spec, or a reskinned prebuilt game).
 * All times are epoch ms. Nothing here runs past `job.hardStop` (the Lambda's own deadline).
 */
export const FORGE_BUDGETS = {
  /** From the TV's forge.pitch to forge.pitches. */
  pitchMs: 8000,
  /** Each design's own deadline, from when designs start. */
  designMs: 50_000,
  /** Winner must be ready this long after the vote closes (then: fallback). */
  winnerMs: 25_000,
  /** Art for the winner is abandoned this long after the vote (the TV keeps its default pack). */
  artMs: 25_000,
  /** How often the room (vote, TV connection) is polled. */
  pollMs: 400,
  /** After every pitch is resolved, wait this long for a vote (to hand losers to the arcade). */
  voteWaitMs: 30_000,
  /** Cap on ingredient screening. */
  screenMs: 2500,
};
export type ForgeBudgets = typeof FORGE_BUDGETS;

export interface ForgeJob {
  code: string;
  forgeId: string;
  /** When the backend received forge.pitch. */
  startedAt: number;
  /** Absolute time the forge must have finished by. */
  hardStop: number;
  ingredients: ForgeIngredient[];
  /** Live players: name for the designer, conn for phone messages and blocked-ingredient notices. */
  players: { id?: string; name: string; conn?: string }[];
  settings: RoomSettings;
  budgets?: Partial<ForgeBudgets>;
}

export interface RoomView { tvConn?: string; winner?: string; voteAt?: number }

export interface ForgeDeps {
  /** Returns false if the connection is gone. */
  post(conn: string, msg: BackendToClient): Promise<boolean>;
  room(): Promise<RoomView>;
  /** Record the pitch ids so the room can validate forge.vote. */
  setPitchIds(ids: string[]): Promise<void>;
  /** Forge finished: release the room's forge lock. */
  done(): Promise<void>;
  pitch?: typeof aiPitch;
  design?: typeof aiDesign;
  screen?: typeof screen;
  fallback?: typeof themedFallback;
  /** Task 17: Stability art for the winner (default: ./ai/art). Never throws; no-ops when no image model is usable. */
  art?: typeof artForSpec;
  /** Task 24 hook: an AI-designed spec for a pitch the room did not pick (store as an unplayed Arcade entry). */
  onLoserReady?(pitch: Pitch, spec: GameSpec): void | Promise<void>;
  log?(...a: unknown[]): void;
}

export interface ForgeResult {
  pitchesMs?: number;
  winner?: string;
  winnerReadyMs?: number;
  /** forge.ready messages sent. */
  readies: number;
  outcome: Record<string, 'ai' | 'fallback' | 'dropped'>;
}


async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => { timer = setTimeout(() => r(fallback), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Progress label (from the designer) -> percent. Never goes backwards; tuning steps creep forward. */
const STEP_PCT: [RegExp, number][] = [
  [/^Reading/, 5],
  [/^Picking/, 15],
  [/^(Tuning|Wiring|Plotting|Designing)/, 30],
  [/^Checking/, 45],
  [/^Bots are/, 60],
  [/^Final bot/, 90],
  [/^Game ready/, 100],
];
export function pctFor(step: string, prev: number): number {
  const hit = STEP_PCT.find(([re]) => re.test(step));
  const target = hit ? hit[1] : prev + 5;
  if (target >= 100) return 100;
  return Math.min(95, Math.max(target, prev + (target <= prev ? 3 : 0)));
}

const POST_TIMEOUT_MS = 3000;
/** Max extra wait for in-flight art at the very end of a forge. */
const ART_FINAL_WAIT_MS = 2000;

type Status = 'running' | 'ready' | 'fallback' | 'dropped';

export async function runForge(job: ForgeJob, deps: ForgeDeps): Promise<ForgeResult> {
  const B = { ...FORGE_BUDGETS, ...job.budgets };
  const now = () => Date.now();
  const log = deps.log ?? (() => {});
  const doPitch = deps.pitch ?? aiPitch;
  const doDesign = deps.design ?? aiDesign;
  const doScreen = deps.screen ?? screen;
  const doFallback = deps.fallback ?? themedFallback;
  const doArt = deps.art ?? artForSpec;
  const familySafe = job.settings.familySafe;
  const result: ForgeResult = { readies: 0, outcome: {} };
  const phones = job.players.map((p) => p.conn).filter((c): c is string => !!c);

  // ---- outbound messages: one ordered queue; TV messages are kept to replay after a TV reconnect
  let view: RoomView = {};
  try { view = await within(deps.room(), 1000, {}); } catch { /* polled again below */ }
  let tvConn = view.tvConn;
  let queue = Promise.resolve();
  const replay: BackendToClient[] = [];
  // A hung post must not stall the queue (and the forge) behind it.
  const postSafe = (conn: string, msg: BackendToClient) => within(deps.post(conn, msg).catch(() => true), POST_TIMEOUT_MS, true);
  const toTv = (msg: BackendToClient, keep = true) => {
    if (keep) replay.push(msg);
    queue = queue.then(async () => { if (tvConn) await postSafe(tvConn, msg); });
    return queue;
  };
  const toPhones = (msg: BackendToClient) => {
    queue = queue.then(async () => { await Promise.all(phones.map((c) => postSafe(c, msg))); });
    return queue;
  };

  try {
    // ---- 1. screen ingredients (fail closed), tell the player whose ingredient was blocked
    const pitchDeadline = Math.min(job.startedAt + B.pitchMs, job.hardStop);
    const items = job.ingredients.map((i) => (typeof i === 'string' ? { text: i } : i));
    const screenBudget = Math.min(B.screenMs, Math.max(300, pitchDeadline - now() - 1500));
    const verdicts = await Promise.all(items.map((i) => within(
      doScreen(i.text, 'INPUT', familySafe).catch(() => ({ allowed: false, reason: 'outage' as const })),
      screenBudget, { allowed: false, reason: 'outage' as const },
    )));
    const allowed = items.filter((_, i) => verdicts[i]!.allowed).map((i) => i.text.trim()).slice(0, 8);
    const told = new Set<string>();
    items.forEach((it, i) => {
      if (verdicts[i]!.reason !== 'policy' || !('playerId' in it) || !it.playerId) return;
      const conn = job.players.find((p) => p.id === it.playerId)?.conn;
      if (conn && !told.has(conn)) { told.add(conn); queue = queue.then(() => postSafe(conn, { t: 'screen', name: 'blocked' }).then(() => {})); }
    });
    const dropped = items.length - allowed.length;
    if (dropped) log(`dropped ${dropped} ingredient(s)`);

    // ---- 2. three pitches by the pitch deadline, whatever happens
    const names = job.players.map((p) => p.name);
    // Seats in the round: bots fill up to 4 when the room allows them.
    const seats = job.settings.bots ? 4 : Math.min(4, Math.max(2, names.length));
    const fill = fallbackPitches(allowed);
    let pitches = await within(
      doPitch(allowed, names, { familySafe, deadlineMs: Math.max(pitchDeadline - 250, now() + 1) })
        .catch(() => fill),
      pitchDeadline - now(), fill,
    );
    pitches = pitches.slice(0, 3);
    for (let i = 0; pitches.length < 3; i++) pitches.push(fill[i % fill.length]!);
    const seen = new Set<string>();
    pitches = pitches.map((p, i) => {
      const id = seen.has(p.id) ? `${p.id}-${i}` : p.id;
      seen.add(id);
      return { ...p, id };
    });
    try { await within(deps.setPitchIds(pitches.map((p) => p.id)), 1500, undefined); } catch (e) { log('setPitchIds failed', e); }
    const pitchesMsg: BackendToClient = { t: 'forge.pitches', forgeId: job.forgeId, pitches };
    toTv(pitchesMsg);
    toPhones(pitchesMsg);
    await queue;
    result.pitchesMs = now() - job.startedAt;

    // ---- 3. design all three in parallel, each with its own deadline
    const designsAt = now();
    const ownDeadline = Math.min(designsAt + B.designMs, job.hardStop - 3000);
    const status: Status[] = pitches.map(() => 'running');
    const aiSpecs: (GameSpec | undefined)[] = pitches.map(() => undefined);
    const pct = pitches.map(() => 0);
    let winner: number | undefined;
    let winnerDeadline = -Infinity;
    let lastResolved = now();
    let wake: () => void = () => {};
    const pending: Promise<unknown>[] = [];
    const artPending: Promise<unknown>[] = [];
    const kick = () => wake();

    const resolved = () => status.every((s) => s !== 'running');
    const isLoser = (i: number) => winner !== undefined && winner !== i;
    const markDone = (i: number, s: Status) => {
      status[i] = s;
      result.outcome[pitches[i]!.id] = s === 'ready' ? 'ai' : s === 'fallback' ? 'fallback' : 'dropped';
      lastResolved = now();
      kick();
    };
    const sendReady = (i: number, spec: GameSpec, fallback: boolean) => {
      result.readies++;
      readySpecs[i] = spec;
      if (winner === i) startArt(i);
      if (winner === i) result.winnerReadyMs = now() - (view.voteAt ?? now());
      return toTv({ t: 'forge.ready', forgeId: job.forgeId, pitchId: pitches[i]!.id, spec, ...(fallback ? { fallback: true } : {}) });
    };
    // ---- winner art (Stability): key art starts at the vote from the pitch, sprites once the spec exists.
    // Both are best effort: no image quota / blocked prompt / late = no message, and the TV uses its default pack.
    const readySpecs: (GameSpec | undefined)[] = pitches.map(() => undefined);
    const artStarted = { key: false, sprites: false };
    const artDeadline = () => Math.min((view.voteAt ?? now()) + B.artMs, job.hardStop - 3000);
    const artTo = (i: number) => (key: string, url: string) => {
      void toTv({ t: 'forge.art', forgeId: job.forgeId, pitchId: pitches[i]!.id, key, url });
    };
    const startArt = (i: number) => {
      if (winner !== i) return;
      const p = pitches[i]!;
      const run = (spec: Parameters<typeof artForSpec>[0], only: Parameters<typeof artForSpec>[4]) => {
        artPending.push(doArt(spec, artTo(i), artDeadline(), familySafe, only).catch((e: unknown) => log('art failed', (e as Error)?.message)));
      };
      if (!artStarted.key) {
        artStarted.key = true;
        run({ id: `${job.forgeId}-${p.id}`, theme: { palette: p.palette, artStyle: '', keyArtPrompt: p.keyArtPrompt, sprites: {} } },
          { keyArt: true, sprites: false });
      }
      const spec = readySpecs[i];
      if (spec && !artStarted.sprites) {
        artStarted.sprites = true;
        run(spec, { keyArt: false, sprites: true });
      }
    };
    const fallbackFor = (i: number) => {
      markDone(i, 'fallback');
      const p = doFallback(pitches[i]!, { ingredients: allowed, familySafe, seats, deadline: Math.min(now() + 2000, job.hardStop) })
        .catch((e: unknown) => {
          // Reskin failed: the plain prebuilt game is still playable.
          log('themed fallback failed', (e as Error)?.message);
          const spec = structuredClone(pickFallback(pitches[i]!.blocksSketch, { seats })) as GameSpec;
          spec.id = newSpecId(spec.title);
          return spec;
        })
        .then((spec) => sendReady(i, spec, true));
      pending.push(p);
      return p;
    };
    const loserReady = (i: number) => {
      const spec = aiSpecs[i];
      if (!spec) return;
      try {
        const r = deps.onLoserReady?.(pitches[i]!, spec);
        if (r) pending.push(Promise.resolve(r).catch(() => {}));
      } catch { /* hook is best effort */ }
    };

    pitches.forEach((p, i) => {
      const onProgress = (step: string) => {
        if (status[i] !== 'running') return;
        const next = pctFor(step, pct[i]!);
        if (next === pct[i] && step !== 'Game ready') return;
        pct[i] = next;
        const msg: BackendToClient = { t: 'forge.progress', forgeId: job.forgeId, pitchId: p.id, step, pct: next };
        void toTv(msg, false);
        void toPhones(msg);
      };
      doDesign(p, {
        ingredients: allowed, players: names, seats, householdBlocks: [], deadlineMs: ownDeadline, familySafe, onProgress,
      }).then((r) => {
        aiSpecs[i] = r.spec;
        if (status[i] !== 'running') {
          // Late (the winner already got a fallback, or a loser past its deadline): arcade only.
          if (winner !== i) loserReady(i);
          return;
        }
        markDone(i, 'ready');
        pending.push(sendReady(i, r.spec, false));
        if (isLoser(i)) loserReady(i);
      }, (e: unknown) => {
        log(`design ${p.id} failed: ${(e as Error)?.name}: ${(e as Error)?.message}`);
        if (status[i] !== 'running') return;
        if (isLoser(i)) markDone(i, 'dropped');
        else void fallbackFor(i);
      });
    });

    // ---- 4. watch the room: vote, TV reconnects, deadlines
    for (;;) {
      const v = await within(deps.room().catch(() => view), Math.max(50, B.pollMs), view);
      view = { ...view, ...v };
      if (v.tvConn && v.tvConn !== tvConn) {
        // TV resumed on a new connection (or was unknown): replay pitches and ready specs.
        tvConn = v.tvConn;
        const conn = tvConn;
        for (const msg of replay) queue = queue.then(() => postSafe(conn, msg).then(() => {}));
      }
      if (winner === undefined && v.winner) {
        const w = pitches.findIndex((p) => p.id === v.winner);
        if (w >= 0) {
          winner = w;
          result.winner = pitches[w]!.id;
          // The winner always gets the full window after the vote (capped by the hard stop).
          winnerDeadline = Math.min((v.voteAt ?? now()) + B.winnerMs, job.hardStop);
          if (status[w] === 'ready' || status[w] === 'fallback') result.winnerReadyMs = 0;
          startArt(w);
          pitches.forEach((_, i) => { if (i !== w && status[i] === 'ready') loserReady(i); });
        }
      }
      const t = now();
      for (let i = 0; i < pitches.length; i++) {
        if (status[i] !== 'running') continue;
        // Winner: exactly vote + winnerMs (not cut short by its own design deadline, never later
        // than the vote budget); everyone else: their own design deadline.
        const deadline = winner === i ? winnerDeadline : ownDeadline;
        if (t < deadline && t < job.hardStop - 2500) continue;
        if (isLoser(i)) markDone(i, 'dropped');
        else void fallbackFor(i);
      }
      if (resolved() && (winner !== undefined || t >= lastResolved + B.voteWaitMs)) break;
      if (t >= job.hardStop - 2500) break;
      await new Promise<void>((r) => {
        const timer = setTimeout(r, B.pollMs);
        wake = () => { clearTimeout(timer); r(); };
      });
    }
    await within(Promise.allSettled(pending).then(() => queue), Math.max(0, job.hardStop - now()), undefined);
    // Art is best effort: wait for it at most 2 s so a slow or hung image provider never holds the forge lock.
    await within(Promise.allSettled(artPending).then(() => queue), Math.min(ART_FINAL_WAIT_MS, Math.max(0, job.hardStop - now())), undefined);
    return result;
  } finally {
    await within(deps.done().catch(() => {}), 1000, undefined);
  }
}
