import type { BlockUse, GameSpec, InputFrame } from '@cadabra/spec';
import type { BlockCtx, BlockDef, Player } from './block';
import { FxQueue, type FxEvent, type GameEvent } from './fx';
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

interface ActiveBlock {
  def: BlockDef;
  ctx: BlockCtx<unknown>;
}

function parseParams(def: BlockDef, params: Record<string, unknown>): unknown {
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
  private readonly latest = new Map<string, { frame: InputFrame; step: number }>();
  private readonly eliminated: string[] = [];
  private readonly fired = new Set<number>();
  private steps = 0;
  private _state: RuntimeState = 'intro';
  private banner?: { text: string; until: number };

  constructor(spec: GameSpec, players: Player[], registry: BlockRegistry, seed: number) {
    this.spec = spec;
    this.players = [...players];
    this.world = new World(spec.arena.width, spec.arena.height);
    this.rng = new Rng(seed);

    if (spec.teams === 2) {
      this.players.forEach((p, i) => {
        if (p.team === undefined) p.team = (i % 2) as 0 | 1;
      });
    }

    const uses: BlockUse[] = [...spec.blocks, ...spec.modifiers];
    for (const use of uses) {
      const def = registry.get(use.block);
      if (!def) throw new Error(`unknown block: ${use.block}`);
      const params = parseParams(def, { ...(def.defaults as object), ...use.params });
      this.blocks.push({ def, ctx: this.makeCtx(params) });
    }

    for (const b of this.blocks) {
      this.world.invalidate();
      b.def.setup(b.ctx);
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

  get events(): GameEvent[] {
    return this.log;
  }

  input(playerId: string, frame: InputFrame): void {
    this.latest.set(playerId, { frame, step: this.steps });
  }

  setConnected(playerId: string, connected: boolean): void {
    const p = this.players.find((q) => q.id === playerId);
    if (p) p.connected = connected;
  }

  /** Merged bot input across all blocks (later blocks override earlier fields). */
  botInput(playerId: string, skill: number): InputFrame {
    let out: InputFrame = { t: this.simMs() };
    for (const b of this.blocks) {
      const f = b.def.bot(b.ctx, playerId, skill);
      out = { ...out, ...f, buttons: { ...out.buttons, ...f.buttons }, t: out.t };
    }
    return out;
  }

  step(): void {
    if (this._state === 'over') return;
    if (this._state === 'intro') {
      this._state = 'playing';
      this.emit({ type: 'start' });
    }

    // 1. deliver latest inputs (stale/missing/disconnected => empty frame)
    for (const p of this.players) {
      if (this.isEliminated(p.id)) continue;
      const frame = this.frameFor(p);
      for (const b of this.blocks) {
        this.world.invalidate();
        b.def.onInput(b.ctx, p.id, frame);
      }
    }

    // 2. update blocks then integrate velocities
    for (const b of this.blocks) {
      this.world.invalidate();
      b.def.update(b.ctx, DT);
    }
    this.world.integrate(DT);

    // 3. advance time and run scheduled rules
    this.steps++;
    this.runTimeline();
    if (this.spec.comeback.enabled && this.steps % (COMEBACK_EVERY_SEC * STEPS_PER_SEC) === 0) this.comeback();
    if (this._state === 'playing' && this.remaining <= FINALE_SEC) {
      this._state = 'finale';
      this.emit({ type: 'finale' });
      this.showBanner(this.spec.host.finale);
    }
    if (this.remaining <= 0 || this.winReached()) this.end();
  }

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
    const res: GameResult = { ranking, events: [...this.log] };
    const wt = this.winnerTeam();
    if (wt !== undefined) res.winnerTeam = wt;
    return res;
  }

  /** Live Tweak-panel patch; index spans blocks then modifiers. Takes effect next step. */
  applyParams(blockIndex: number, patch: Record<string, unknown>): void {
    const b = this.blocks[blockIndex];
    if (!b) throw new Error(`applyParams: no block at index ${blockIndex}`);
    b.ctx.params = parseParams(b.def, { ...(b.ctx.params as object), ...patch });
  }

  // ---------- internals ----------

  private makeCtx(params: unknown): BlockCtx<unknown> {
    const rt = this;
    return {
      params,
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
    };
  }

  private simMs(): number {
    return Math.round((this.steps * 1000) / STEPS_PER_SEC);
  }

  private frameFor(p: Player): InputFrame {
    const l = this.latest.get(p.id);
    if (!p.connected || !l || this.steps - l.step > STALE_STEPS) return { t: this.simMs() };
    return l.frame;
  }

  private emit(e: Omit<GameEvent, 't'>): void {
    this.log.push({ ...e, t: this.time });
  }

  private score(playerId: string, delta: number, reason: string): void {
    if (this._state === 'over') return;
    const p = this.players.find((q) => q.id === playerId);
    if (!p || delta === 0) return;
    p.score += delta;
    this.emit({ type: 'score', player: playerId, data: { delta, reason } });
  }

  private isEliminated(id: string): boolean {
    return this.eliminated.includes(id);
  }

  private eliminate(playerId: string): void {
    if (this.isEliminated(playerId) || !this.players.some((p) => p.id === playerId)) return;
    this.eliminated.push(playerId);
    for (const e of this.world.all()) if (e.owner === playerId && e.kind === 'player') this.world.remove(e.id);
    this.emit({ type: 'eliminated', player: playerId });
  }

  private entityOf(playerId: string): Entity | undefined {
    return this.world.all().find((e) => e.owner === playerId && e.kind === 'player');
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

  private teamTotals(): [number, number] {
    const t: [number, number] = [0, 0];
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
        return target !== undefined && this.teamTotals().some((s) => s >= target);
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
