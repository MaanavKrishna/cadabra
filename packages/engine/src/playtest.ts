import { parseSpec, type ControlWidget, type GameSpec } from '@cadabra/spec';
import type { BlockCtx, BlockDef, RequiredControl } from './block';
import { driveBots, makeBots } from './bots';
import { stubJudgement } from './judgements';
import { BlockRegistry } from './registry';
import { Rng } from './rng';
import { GameRuntime, STEPS_PER_SEC, unknownParamErrors } from './runtime';

export interface PlaytestReport {
  ok: boolean;
  /** AI-readable reasons the spec was rejected (empty when ok). */
  reasons: string[];
  stats: { scoringPlayers: number; endedAtSec: number; events: number; maxEntities: number; msWall: number };
}

export interface PlaytestOpts {
  /** Bots in the round (default 4). Skills cycle through BOT_SKILLS. */
  players?: number;
  seed?: number;
  /** Wall clock in ms (default performance.now); injectable so tests are deterministic. */
  now?: () => number;
}

export const BOT_SKILLS = [0.4, 0.6, 0.8, 0.9] as const;
export const MAX_ENTITIES = 400;
export const MAX_WALL_MS = 3000;
/** A round may not end before this fraction of durationSec unless its win type ends early by design. */
export const MIN_END_FRACTION = 0.8;

/** Requirements for `def` with these params: its own requiredControls, else any widget of a kind in `controls`. */
function requiredControls(def: BlockDef, params: unknown): RequiredControl[] {
  if (def.requiredControls) return def.requiredControls(params);
  const [first, ...rest] = def.controls;
  if (!first) return [];
  return [{ kind: first, id: '', alt: rest.map((kind) => ({ kind, id: '' })) }];
}

const widget = (c: { kind: ControlWidget['kind']; id: string }) => `a ${c.kind} widget${c.id ? ` with id "${c.id}"` : ''}`;

/** "a hold widget with id "tiptoe" (params.tiptoeButton) or a button widget with id "tiptoe"" */
function describeNeed(c: RequiredControl): string {
  const main = `${widget(c)}${c.param ? ` (params.${c.param})` : ''}`;
  return [main, ...(c.alt ?? []).map(widget)].join(' or ');
}

function satisfied(c: RequiredControl, controller: ControlWidget[]): boolean {
  const alts = [{ kind: c.kind, id: c.id }, ...(c.alt ?? [])];
  return controller.some((w) => alts.some((a) => a.kind === w.kind && (a.id === '' || a.id === w.id)));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

class BlockFault extends Error {}

/** Copy of `def` whose hooks rethrow with the block id, hook and sim time attached. */
/** Per block: points taken away and players eliminated during the round. */
type Blame = Map<string, { penalties: number; eliminations: number }>;

/**
 * Copy of `def` whose hooks rethrow with the block id, hook and sim time attached, and
 * whose ctx records the penalties and eliminations the block hands out (into `blame`).
 */
function attributed(def: BlockDef, blame: Blame): BlockDef {
  const tracked = new WeakSet<object>();
  const track = (ctx: BlockCtx<unknown>) => {
    if (tracked.has(ctx)) return;
    tracked.add(ctx);
    const entry = () => {
      let e = blame.get(def.id);
      if (!e) blame.set(def.id, (e = { penalties: 0, eliminations: 0 }));
      return e;
    };
    const { score, eliminate } = ctx;
    ctx.score = (id, delta, reason) => {
      if (delta < 0) entry().penalties++;
      score(id, delta, reason);
    };
    ctx.eliminate = (id) => {
      entry().eliminations++;
      eliminate(id);
    };
  };
  const wrap = <F extends (...a: any[]) => any>(hook: string, f: F | undefined): F | undefined => {
    if (!f) return undefined;
    return ((...a: any[]) => {
      try {
        track(a[0] as BlockCtx<unknown>);
        return f(...a);
      } catch (e) {
        if (e instanceof BlockFault) throw e;
        const t = hook === 'setup' ? '' : ` at t=${(a[0] as { time: number }).time.toFixed(2)}s`;
        throw new BlockFault(`block ${def.id} threw in ${hook}${t}: ${message(e)}`);
      }
    }) as F;
  };
  const out: BlockDef = {
    ...def,
    setup: wrap('setup', def.setup)!,
    update: wrap('update', def.update)!,
    onInput: wrap('onInput', def.onInput)!,
    bot: wrap('bot', def.bot)!,
  };
  const onTimeline = wrap('onTimeline', def.onTimeline);
  const onJudgement = wrap('onJudgement', def.onJudgement);
  if (onTimeline) out.onTimeline = onTimeline;
  if (onJudgement) out.onJudgement = onJudgement;
  return out;
}

function defaultNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/**
 * Headless quality gate for a (usually AI-written) spec: static checks, then a full round
 * with bots (skills 0.4/0.6/0.8/0.9) and stub-resolved judgements. Never throws; every
 * problem becomes a reason string the designer can read and fix.
 */
export function playtest(spec: GameSpec, registry: BlockRegistry, opts: PlaytestOpts = {}): PlaytestReport {
  const now = opts.now ?? defaultNow;
  const seed = opts.seed ?? 1;
  const n = Math.max(1, Math.floor(opts.players ?? 4));
  const reasons: string[] = [];
  const stats: PlaytestReport['stats'] = { scoringPlayers: 0, endedAtSec: 0, events: 0, maxEntities: 0, msWall: 0 };
  const done = (): PlaytestReport => ({ ok: reasons.length === 0, reasons, stats });

  // ---- static checks ----
  const parsed = parseSpec(spec);
  if (!parsed.ok) {
    for (const e of parsed.errors) reasons.push(`spec: ${e}`);
    return done();
  }
  const s = parsed.spec;

  const seen = new Set<string>();
  for (const w of s.controller) {
    if (seen.has(w.id)) reasons.push(`duplicate controller widget id: ${w.id}`);
    seen.add(w.id);
  }

  let runnable = true;
  const local = new BlockRegistry();
  const blame: Blame = new Map();
  for (const use of [...s.blocks, ...s.modifiers]) {
    const def = registry.get(use.block);
    if (!def) {
      reasons.push(`unknown block: ${use.block}`);
      runnable = false;
      continue;
    }
    if (!local.get(def.id)) local.register(attributed(def, blame));
    if (!def.arenaKinds.includes(s.arena.kind)) {
      reasons.push(`block ${def.id} does not support arena kind "${s.arena.kind}" (supports: ${def.arenaKinds.join(', ')})`);
    }
    const unknown = unknownParamErrors(def, use.params);
    if (unknown.length > 0) {
      reasons.push(...unknown);
      runnable = false;
      continue;
    }
    const r = def.paramsSchema.safeParse({ ...(def.defaults as object), ...use.params });
    if (!r.success) {
      const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      reasons.push(`invalid params for block ${def.id}: ${issues}`);
      runnable = false;
      continue;
    }
    for (const need of requiredControls(def, r.data)) {
      if (!satisfied(need, s.controller)) reasons.push(`missing controller widget for ${def.id}: needs ${describeNeed(need)}`);
    }
  }
  if (!runnable) return done();

  // ---- the round ----
  const bots = makeBots(n, new Rng(seed ^ 0x5eed));
  const t0 = now();
  let rt: GameRuntime;
  try {
    rt = new GameRuntime(s, bots, local, seed);
  } catch (e) {
    stats.msWall = now() - t0;
    reasons.push(e instanceof BlockFault ? e.message : `runtime setup failed: ${message(e)}`);
    return done();
  }

  let crashed = false, timedOut = false;
  stats.maxEntities = rt.entityCount;
  const maxSteps = s.durationSec * STEPS_PER_SEC + STEPS_PER_SEC;
  try {
    for (let i = 1; i <= maxSteps && rt.state !== 'over'; i++) {
      for (const j of rt.pendingJudgements()) rt.resolveJudgement(j.id, stubJudgement(j));
      bots.forEach((b, k) => driveBots(rt, [b], BOT_SKILLS[k % BOT_SKILLS.length]!));
      rt.step();
      if (rt.entityCount > stats.maxEntities) stats.maxEntities = rt.entityCount;
      if (i % STEPS_PER_SEC === 0 && now() - t0 > MAX_WALL_MS) {
        timedOut = true;
        break;
      }
    }
    stats.scoringPlayers = rt.result().ranking.filter((p) => p.score > 0).length;
  } catch (e) {
    crashed = true;
    reasons.push(e instanceof BlockFault ? e.message : `exception at t=${rt.time.toFixed(2)}s: ${message(e)}`);
  }
  stats.msWall = now() - t0;
  stats.endedAtSec = rt.time;
  stats.events = rt.events.length;

  if (stats.msWall > MAX_WALL_MS || timedOut) {
    reasons.push(`wall time ${Math.round(stats.msWall)} ms > ${MAX_WALL_MS} ms: the round is too heavy to simulate (fewer entities or lower spawn rates)`);
  }
  if (stats.maxEntities > MAX_ENTITIES) {
    reasons.push(`maxEntities ${stats.maxEntities} > ${MAX_ENTITIES}: too many things on screen (lower spawn rates, counts or caps)`);
  }
  if (crashed || timedOut) return done();
  if (stats.scoringPlayers < 2) {
    const eliminated = rt.events.filter((e) => e.type === 'eliminated').length;
    const harsh = [...blame].map(([id, b]) => `${id} (${b.penalties} penalties, ${b.eliminations} eliminations)`);
    reasons.push(
      `scoringPlayers ${stats.scoringPlayers} < 2: only ${stats.scoringPlayers} of ${n} bots scored; ${eliminated} of ${n} bots were eliminated; ` +
        `blocks that penalised or eliminated: ${harsh.length ? harsh.join(', ') : 'none'}; make scoring reachable (easier hazards, smaller penalties, more points sources)`,
    );
  }
  const early = s.win.type !== 'lastStanding' && s.win.type !== 'firstTo';
  if (early && stats.endedAtSec < s.durationSec * MIN_END_FRACTION) {
    reasons.push(
      `round ended at ${stats.endedAtSec.toFixed(1)} s, before ${MIN_END_FRACTION * 100}% of durationSec (${s.durationSec} s); raise win.target or use win.type lastStanding/firstTo for early finishes`,
    );
  }
  return done();
}
