import { z } from 'zod';
import { resolvePhysics, type BlockUse, type GameSpec, type InputFrame } from '@cadabra/spec';
import type { BlockCtx, BlockDef, JudgementKind, Player } from './block';
import { FxQueue, type FxEvent, type GameEvent } from './fx';
import { Physics } from './physics';
import type { BlockRegistry } from './registry';
import { Rng } from './rng';
import { World, cloneEntity, type Entity } from './world';

export const STEPS_PER_SEC = 60;
export const DT = 1 / STEPS_PER_SEC;
/** Inputs older than this many steps (500 ms) count as empty frames. */
export const STALE_STEPS = 30;
export const FINALE_SEC = 10;
export const COMEBACK_EVERY_SEC = 5;
export const BANNER_SEC = 3;
export const FIRST_TO_DEFAULT = 10;
/** Positive score deltas are multiplied by this during the final FINALE_SEC ("FINAL 10: DOUBLE POINTS"). */
export const FINAL_MULTIPLIER = 2;
/** At most one `lead.change` event per this many seconds (the TV banner would spam otherwise). */
export const LEAD_THROTTLE_SEC = 6;

export interface RuntimeOpts {
  /** Multiplier for positive score deltas in the final FINALE_SEC (default FINAL_MULTIPLIER; 1 = off). */
  finalMultiplier?: number;
}

export type RuntimeState = 'intro' | 'playing' | 'finale' | 'over';

export interface Snapshot {
  entities: Entity[];
  players: Player[];
  time: number;
  remaining: number;
  banner?: string;
}

export interface GameResult {
  ranking: Player[];
  winnerTeam?: 0 | 1;
  events: GameEvent[];
}

export interface Judgement {
  id: string;
  kind: JudgementKind;
  payload: unknown;
}

type OneShot = Pick<InputFrame, 'swipe' | 'vote' | 'text' | 'draw'>;
const ONE_SHOT_KEYS = ['swipe', 'vote', 'text', 'draw'] as const;
const HELD_KEYS = ['axes', 'buttons', 'tilt'] as const;

interface ActiveBlock {
  def: BlockDef;
  ctx: BlockCtx<unknown>;
}

/** Param names a block accepts: its object schema's keys (else its defaults' keys). */
export function paramKeys(def: BlockDef): string[] {
  const schema = def.paramsSchema as unknown;
  if (schema instanceof z.ZodObject) return Object.keys(schema.shape as object);
  return Object.keys((def.defaults ?? {}) as object);
}

/**
 * AI-readable errors for keys `params` sets that the block does not have (zod would strip
 * them silently, so a misspelt param would play on its default).
 */
export function unknownParamErrors(def: BlockDef, params: Record<string, unknown>): string[] {
  const known = paramKeys(def);
  return Object.keys(params)
    .filter((k) => !known.includes(k))
    .map((k) => `unknown param "${k}" for block ${def.id} (known: ${known.join(', ')})`);
}

/** Validate a block's params strictly: unknown keys are errors, then the schema decides. */
function parseParams(def: BlockDef, params: Record<string, unknown>, patch: Record<string, unknown> = params): unknown {
  const unknown = unknownParamErrors(def, patch);
  if (unknown.length > 0) throw new Error(unknown.join('; '));
  const r = def.paramsSchema.safeParse(params);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`invalid params for block ${def.id}: ${issues}`);
  }
  return r.data;
}

/**
 * Headless, deterministic simulation of one round. No DOM, timers, Date or Math.random:
 * time only advances via step(), randomness only via the seeded Rng.
 */
export class GameRuntime {
  private readonly spec: GameSpec;
  private readonly players: Player[];
  private readonly world: World;
  private readonly rng: Rng;
  private readonly fxq = new FxQueue();
  private readonly log: GameEvent[] = [];
  private readonly blocks: ActiveBlock[] = [];
  /** Latest held state (axes/buttons/tilt) per player, with the step it arrived on. */
  private readonly held = new Map<string, { frame: InputFrame; step: number }>();
  /**
   * Buttons pressed (went true) since the last step, with the frame time of the first press:
   * a quick down+up that arrives between two steps still reaches blocks as one step of "down".
   */
  private readonly pressed = new Map<string, { keys: Set<string>; t: number }>();
  /** One-shot fields (swipe/vote/text/draw) received since the last step; delivered exactly once. */
  private readonly pending = new Map<string, OneShot>();
  private readonly eliminated: string[] = [];
  private readonly fired = new Set<number>();
  private steps = 0;
  private _state: RuntimeState = 'intro';
  private banner?: { text: string; until: number };
  /** Open judgements in request order (Map preserves insertion order). */
  private readonly judgements = new Map<string, { kind: JudgementKind; payload: unknown; block: ActiveBlock; result?: { v: unknown } }>();
  private judgementSeq = 0;
  private readonly finalMultiplier: number;
  /** Unique leader right now (player id, or 'team:N' in team games); undefined on a tie / nobody scored. */
  private rawLeader?: string;
  /** Leader last announced with lead.change, and when. */
  private announcedLeader?: string;
  private lastLeadAt = -Infinity;
  private _leadChanges = 0;
  /** Rigid-body layer (undefined = classic velocity integration). */
  private physics?: Physics;

  constructor(spec: GameSpec, players: Player[], registry: BlockRegistry, seed: number, opts: RuntimeOpts = {}) {
    this.spec = spec;
    this.finalMultiplier = Math.max(1, opts.finalMultiplier ?? FINAL_MULTIPLIER);
    // own copies: the runtime never mutates the caller's objects
    this.players = players.map((p) => ({ ...p, score: 0 }));
    this.world = new World(spec.arena.width, spec.arena.height);
    this.rng = new Rng(seed);

    if (spec.teams === 2) {
      this.players.forEach((p, i) => {
        if (p.team === undefined) p.team = (i % 2) as 0 | 1;
      });
    }

    const uses: BlockUse[] = [...spec.blocks, ...spec.modifiers];
    const parsed: { def: BlockDef; params: unknown }[] = [];
    for (const use of uses) {
      const def = registry.get(use.block);
      if (!def) throw new Error(`unknown block: ${use.block}`);
      parsed.push({ def, params: parseParams(def, { ...(def.defaults as object), ...use.params }, use.params) });
    }
    const phys = resolvePhysics(spec, parsed.some(({ def, params }) => def.usesPhysics?.(params) === true));
    if (phys) {
      this.physics = new Physics({
        world: this.world, rng: this.rng, time: () => this.time,
        emit: (e) => this.emit(e), fx: (e) => this.fxq.push(e),
      }, phys);
    }
    for (const { def, params } of parsed) {
      const ab = { def, ctx: undefined as unknown as BlockCtx<unknown> };
      ab.ctx = this.makeCtx(params, ab);
      this.blocks.push(ab);
    }

    for (const b of this.blocks) {
      this.world.invalidate();
      b.def.setup(b.ctx);
    }
    if (this.physics && spec.world?.props?.length) this.physics.spawnWorldProps(spec.world.props);
    for (const e of this.world.all()) {
      if (e.kind === 'player' && e.props.boost === undefined) e.props.boost = 1;
    }
  }

  // ---------- public API ----------

  get state(): RuntimeState {
    return this._state;
  }

  get time(): number {
    return this.steps / STEPS_PER_SEC;
  }

  get remaining(): number {
    return Math.max(0, this.spec.durationSec - this.time);
  }

  /** Live entity count, O(1) (playtest budget checks; no snapshot copy). */
  get entityCount(): number {
    return this.world.size;
  }

  /**
   * How often the unique leader changed hands this round (unthrottled; the first leader is
   * not a change). Balance metric: close rounds have several.
   */
  get leadChanges(): number {
    return this._leadChanges;
  }

  /** Current score multiplier for positive deltas (FINAL_MULTIPLIER in the finale, else 1). */
  get scoreMultiplier(): number {
    return this._state === 'finale' ? this.finalMultiplier : 1;
  }

  /** Append-only event log (copy). */
  get events(): readonly GameEvent[] {
    return [...this.log];
  }

  /**
   * Buffer a phone frame. Held fields (axes/buttons/tilt) replace the previous held state
   * and go stale after 500 ms; one-shot fields (swipe/vote/text/draw) are merged into a
   * queue and delivered on the next step only. A frame carrying only one-shot fields does
   * not touch held state.
   */
  input(playerId: string, frame: InputFrame): void {
    let hasOneShot = false;
    let shot = this.pending.get(playerId);
    for (const k of ONE_SHOT_KEYS) {
      if (frame[k] === undefined) continue;
      shot ??= {};
      (shot as Record<string, unknown>)[k] = frame[k];
      hasOneShot = true;
    }
    if (shot) this.pending.set(playerId, shot);
    const hasHeld = HELD_KEYS.some((k) => frame[k] !== undefined);
    if (frame.buttons) {
      const prev = this.held.get(playerId)?.frame.buttons;
      for (const [k, down] of Object.entries(frame.buttons)) {
        if (!down || prev?.[k]) continue;
        let l = this.pressed.get(playerId);
        if (!l) this.pressed.set(playerId, (l = { keys: new Set(), t: frame.t }));
        l.keys.add(k);
      }
    }
    if (hasHeld || !hasOneShot) {
      const h: InputFrame = { t: frame.t };
      if (frame.axes) h.axes = frame.axes;
      if (frame.buttons) h.buttons = frame.buttons;
      if (frame.tilt) h.tilt = frame.tilt;
      this.held.set(playerId, { frame: h, step: this.steps });
    }
  }

  setConnected(playerId: string, connected: boolean): void {
    const p = this.players.find((q) => q.id === playerId);
    if (p) p.connected = connected;
  }

  /**
   * Merged bot input across all blocks (later blocks override earlier fields). Consumes
   * the shared seeded rng: call exactly once per step per bot (then input() + step()) to
   * keep rounds deterministic and replayable.
   */
  botInput(playerId: string, skill: number): InputFrame {
    let out: InputFrame = { t: this.simMs() };
    for (const b of this.blocks) {
      const f = b.def.bot(b.ctx, playerId, skill);
      out = { ...out, ...f, buttons: { ...out.buttons, ...f.buttons }, t: out.t };
    }
    return out;
  }

  /** Judgements awaiting a result, in request order. The host resolves them asynchronously. */
  pendingJudgements(): Judgement[] {
    const out: Judgement[] = [];
    for (const [id, j] of this.judgements) if (!j.result) out.push({ id, kind: j.kind, payload: j.payload });
    return out;
  }

  /**
   * Hand in a judgement result. It is buffered and applied at the start of the next step,
   * in request order, so replays that resolve at the same step are identical. Returns false
   * for unknown, cancelled or already-resolved ids (late results are dropped).
   */
  resolveJudgement(id: string, result: unknown): boolean {
    const j = this.judgements.get(id);
    if (!j || j.result || this._state === 'over') return false;
    j.result = { v: result };
    return true;
  }

  step(): void {
    if (this._state === 'over') return;
    if (this._state === 'intro') {
      this._state = 'playing';
      this.emit({ type: 'start' });
    }

    // 0. apply judgement results received since the last step, in request order
    this.deliverJudgements();

    // 1. deliver latest inputs (stale/missing/disconnected => empty frame)
    this.world.invalidate();
    for (const p of this.players) {
      if (this.isEliminated(p.id)) {
        this.pending.delete(p.id);
        continue;
      }
      const frame = this.frameFor(p);
      for (const b of this.blocks) b.def.onInput(b.ctx, p.id, frame);
    }

    // 2. update blocks then integrate velocities
    for (const b of this.blocks) {
      this.world.invalidate();
      b.def.update(b.ctx, DT);
    }
    if (this.physics) {
      const ph = this.physics;
      ph.step(DT);
      this.world.integrate(DT, (e) => ph.owns(e));
    } else {
      this.world.integrate(DT);
    }

    // 3. advance time and run scheduled rules
    this.steps++;
    this.runTimeline();
    if (this.spec.comeback.enabled && this.steps % (COMEBACK_EVERY_SEC * STEPS_PER_SEC) === 0) this.comeback();
    if (this._state === 'playing' && this.remaining <= FINALE_SEC) {
      this._state = 'finale';
      this.emit({ type: 'finale' });
      this.emit({ type: 'final.start', data: { multiplier: this.finalMultiplier, remainingSec: Math.round(this.remaining) } });
      this.showBanner(this.spec.host.finale);
    }
    this.trackLead();
    if (this.remaining <= 0 || this.winReached()) this.end();
  }

  /**
   * Render-safe copies of the current state. Renderers draw `banner` from here; the
   * FxEvent 'banner' (via drainFx) is a one-off cue for the host / voice layer.
   */
  snapshot(): Snapshot {
    const s: Snapshot = {
      entities: this.world.all().map(cloneEntity),
      players: this.players.map((p) => ({ ...p })),
      time: this.time,
      remaining: this.remaining,
    };
    if (this.banner && this.steps < this.banner.until) s.banner = this.banner.text;
    return s;
  }

  drainFx(): FxEvent[] {
    return this.fxq.drain();
  }

  result(): GameResult {
    const order = new Map(this.players.map((p, i) => [p.id, i]));
    const elimIdx = (id: string) => this.eliminated.indexOf(id);
    const ranking = this.players
      .map((p) => ({ ...p }))
      .sort((a, b) => {
        if (this.spec.win.type === 'lastStanding') {
          // survivors first, then later-eliminated before earlier-eliminated
          const ea = elimIdx(a.id), eb = elimIdx(b.id);
          const ka = ea < 0 ? Infinity : ea, kb = eb < 0 ? Infinity : eb;
          if (ka !== kb) return kb - ka;
        }
        return b.score - a.score || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
      });
    const res: GameResult = { ranking, events: this.events as GameEvent[] };
    const wt = this.winnerTeam();
    if (wt !== undefined) res.winnerTeam = wt;
    return res;
  }

  /** Live Tweak-panel patch; index spans blocks then modifiers. Takes effect next step. */
  applyParams(blockIndex: number, patch: Record<string, unknown>): void {
    const b = this.blocks[blockIndex];
    if (!b) throw new Error(`applyParams: no block at index ${blockIndex}`);
    b.ctx.params = parseParams(b.def, { ...(b.ctx.params as object), ...patch }, patch);
  }

  // ---------- internals ----------

  private makeCtx(params: unknown, block: ActiveBlock): BlockCtx<unknown> {
    const rt = this;
    return {
      params,
      spec: this.spec,
      physics: this.physics,
      world: this.world,
      players: this.players,
      rng: this.rng,
      get time() {
        return rt.time;
      },
      get remaining() {
        return rt.remaining;
      },
      score: (playerId, delta, reason) => this.score(playerId, delta, reason),
      emit: (e) => this.emit(e),
      fx: (e) => this.fxq.push(e),
      eliminate: (playerId) => this.eliminate(playerId),
      entityOf: (playerId) => this.entityOf(playerId),
      requestJudgement: (kind, payload) => {
        const id = `${kind}-${++this.judgementSeq}`;
        this.judgements.set(id, { kind, payload, block });
        this.emit({ type: 'judgement.requested', data: { id, kind } });
        return id;
      },
      cancelJudgement: (id) => {
        if (this.judgements.delete(id)) this.emit({ type: 'judgement.cancelled', data: { id } });
      },
    };
  }

  private deliverJudgements(): void {
    if (this.judgements.size === 0) return;
    const ready: [string, { block: ActiveBlock; result?: { v: unknown } }][] = [];
    for (const e of this.judgements) if (e[1].result) ready.push(e);
    for (const [id, j] of ready) {
      this.judgements.delete(id);
      this.emit({ type: 'judgement.resolved', data: { id } });
      this.world.invalidate();
      j.block.def.onJudgement?.(j.block.ctx, id, j.result!.v);
    }
  }

  private simMs(): number {
    return Math.round((this.steps * 1000) / STEPS_PER_SEC);
  }

  private frameFor(p: Player): InputFrame {
    const shot = this.pending.get(p.id);
    this.pending.delete(p.id);
    const latch = this.pressed.get(p.id);
    this.pressed.delete(p.id);
    if (!p.connected) return { t: this.simMs() };
    const h = this.held.get(p.id);
    let base = h && this.steps - h.step <= STALE_STEPS ? h.frame : { t: this.simMs() };
    if (latch && [...latch.keys].some((k) => !base.buttons?.[k])) {
      // a press released before this step: deliver it as down for one step, stamped with the press time
      const buttons = { ...base.buttons };
      for (const k of latch.keys) buttons[k] = true;
      base = { ...base, buttons, t: latch.t };
    }
    return shot ? { ...base, ...shot } : base;
  }

  private emit(e: Omit<GameEvent, 't'>): void {
    this.log.push({ ...e, t: this.time });
  }

  private score(playerId: string, delta: number, reason: string): void {
    if (this._state === 'over') return;
    const p = this.players.find((q) => q.id === playerId);
    if (!p || delta === 0) return;
    const mult = delta > 0 ? this.scoreMultiplier : 1;
    const d = delta * mult;
    p.score += d;
    const data: Record<string, unknown> = { delta: d, reason };
    if (mult !== 1) Object.assign(data, { base: delta, mult });
    this.emit({ type: 'score', player: playerId, data });
  }

  /** Unique leader by score (team total in team games), or undefined on a tie / all zero. */
  private leaderNow(): string | undefined {
    if (this.spec.teams === 2) {
      const [a, b] = this.teamTotals();
      if (a === b) return undefined;
      return a > b ? 'team:0' : 'team:1';
    }
    let best: Player | undefined, tie = false;
    for (const p of this.players) {
      if (!best || p.score > best.score) { best = p; tie = false; }
      else if (p.score === best.score) tie = true;
    }
    return best && !tie && best.score > 0 ? best.id : undefined;
  }

  /** Count raw lead changes and emit throttled `lead.change` events. */
  private trackLead(): void {
    const now = this.leaderNow();
    if (now === undefined) return;
    if (this.rawLeader !== undefined && now !== this.rawLeader) this._leadChanges++;
    this.rawLeader = now;
    if (now === this.announcedLeader || this.time - this.lastLeadAt < LEAD_THROTTLE_SEC) return;
    const prev = this.announcedLeader;
    this.announcedLeader = now;
    this.lastLeadAt = this.time;
    const data: Record<string, unknown> = { prev: prev ?? null };
    let player = now;
    if (now.startsWith('team:')) {
      const team = Number(now.slice(5)) as 0 | 1;
      data.team = team;
      data.score = this.teamTotals()[team];
      player = this.players.find((p) => p.team === team)?.id ?? now;
      if (prev?.startsWith('team:')) data.prev = Number(prev.slice(5));
    } else {
      data.score = this.players.find((p) => p.id === now)?.score ?? 0;
    }
    this.emit({ type: 'lead.change', player, data });
  }

  private isEliminated(id: string): boolean {
    return this.eliminated.includes(id);
  }

  private eliminate(playerId: string): void {
    if (this.isEliminated(playerId) || !this.players.some((p) => p.id === playerId)) return;
    this.eliminated.push(playerId);
    for (let e = this.world.playerEntity(playerId); e; e = this.world.playerEntity(playerId)) this.world.remove(e.id);
    this.emit({ type: 'eliminated', player: playerId });
  }

  private entityOf(playerId: string): Entity | undefined {
    return this.world.playerEntity(playerId);
  }

  private showBanner(text: string): void {
    this.banner = { text, until: this.steps + BANNER_SEC * STEPS_PER_SEC };
    this.fxq.push({ kind: 'banner', text });
  }

  private runTimeline(): void {
    const t = this.time;
    this.spec.timeline.forEach((ev, i) => {
      if (this.fired.has(i) || ev.atSec > t) return;
      this.fired.add(i);
      for (const b of this.blocks) {
        this.world.invalidate();
        b.def.onTimeline?.(b.ctx, ev);
      }
      this.emit({ type: 'timeline', data: { kind: ev.kind, atSec: ev.atSec } });
      this.showBanner(ev.hostLine);
    });
  }

  private comeback(): void {
    const live = this.players.filter((p) => p.connected && !this.isEliminated(p.id));
    if (live.length === 0) return;
    const low = Math.min(...live.map((p) => p.score));
    const boost = 1 + 0.15 * this.spec.comeback.strength;
    const boosted: string[] = [];
    for (const p of this.players) {
      const e = this.entityOf(p.id);
      const last = live.includes(p) && p.score === low;
      if (last) boosted.push(p.id);
      if (e) e.props.boost = last ? boost : 1;
    }
    this.emit({ type: 'comeback', data: { players: boosted, boost } });
  }

  private readonly totals: [number, number] = [0, 0];

  /** Team score totals (a reused tuple: read it before the next call). */
  private teamTotals(): [number, number] {
    const t = this.totals;
    t[0] = 0;
    t[1] = 0;
    for (const p of this.players) if (p.team !== undefined) t[p.team] += p.score;
    return t;
  }

  private winnerTeam(): 0 | 1 | undefined {
    if (this.spec.teams !== 2) return undefined;
    const [a, b] = this.teamTotals();
    return a === b ? undefined : a > b ? 0 : 1;
  }

  private winReached(): boolean {
    const { type, target } = this.spec.win;
    switch (type) {
      case 'firstTo': {
        const goal = target ?? FIRST_TO_DEFAULT;
        return this.players.some((p) => p.score >= goal);
      }
      case 'teamScore':
        if (target === undefined) return false;
        const [a, b] = this.teamTotals();
        return a >= target || b >= target;
      case 'lastStanding':
        return this.players.length > 1 && this.players.length - this.eliminated.length <= 1;
      case 'highScore':
      default:
        return false;
    }
  }

  private end(): void {
    this._state = 'over';
    this.emit({ type: 'over' });
  }
}
