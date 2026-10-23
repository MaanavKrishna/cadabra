import type { z } from 'zod';
import type { ControlWidget, GameSpec, InputFrame, TimelineEvent } from '@cadabra/spec';
import type { FxEvent, GameEvent } from './fx';
import type { PhysicsApi } from './physics';
import type { Rng } from './rng';
import type { Entity, World } from './world';

export interface Player {
  id: string;
  name: string;
  avatar: string;
  team?: 0 | 1;
  isBot: boolean;
  connected: boolean;
  score: number;
}

/** Async AI work the host resolves out-of-band (TV via backend; playtest via stubJudgement). */
export type JudgementKind = 'draw' | 'trivia-gen';

export interface BlockCtx<P> {
  params: P;
  /** The spec being played (read-only: title/ingredients/teams for blocks that need them). */
  readonly spec: Readonly<GameSpec>;
  world: World;
  players: Player[];
  rng: Rng;
  time: number;
  remaining: number;
  score(playerId: string, delta: number, reason: string): void;
  emit(e: Omit<GameEvent, 't'>): void;
  fx(e: FxEvent): void;
  eliminate(playerId: string): void;
  /**
   * The player's avatar entity. Avatars MUST be spawned with `kind: 'player'` and
   * `owner: playerId`; anything else is invisible to entityOf and to comeback boosts.
   */
  entityOf(playerId: string): Entity | undefined;
  /**
   * Ask the host for an async judgement (AI scoring / generation). Returns a deterministic
   * id. The result arrives through BlockDef.onJudgement at a step boundary, in request
   * order. Blocks own their timeouts (sim time) and must play on without a result.
   */
  requestJudgement(kind: JudgementKind, payload: unknown): string;
  /** Withdraw a judgement (e.g. after a timeout); a late result for it is then ignored. */
  cancelJudgement(id: string): void;
  /** Rigid-body physics, when the spec (world.physics / world.props) or a block turned it on. */
  readonly physics?: PhysicsApi;
}

/**
 * A controller widget a block cannot be played without. `id` is the widget id the phone
 * sends (buttons[id]); '' means any widget of that kind. `param` names the block param the
 * requirement comes from. `alt` lists other widgets that would do instead (any one of them).
 */
export interface RequiredControl {
  kind: ControlWidget['kind'];
  id: string;
  param?: string;
  alt?: { kind: ControlWidget['kind']; id: string }[];
}

export interface BlockDef<P = any> {
  id: string;
  name: string;
  summary: string;
  paramsSchema: z.ZodType<P>;
  defaults: P;
  /** Every widget kind the block understands (not all are required: see requiredControls). */
  controls: ControlWidget['kind'][];
  /**
   * The widgets this block needs for these params (playtest rejects specs without them).
   * Absent: any one widget of a kind in `controls` will do.
   */
  requiredControls?(params: P): RequiredControl[];
  arenaKinds: GameSpec['arena']['kind'][];
  /** True when the block needs rigid-body physics with these params (the runtime turns it on). */
  usesPhysics?(params: P): boolean;
  setup(ctx: BlockCtx<P>): void;
  update(ctx: BlockCtx<P>, dt: number): void;
  onInput(ctx: BlockCtx<P>, playerId: string, input: InputFrame): void;
  /**
   * Bot input for one step (skill 0..1). Bots draw from ctx.rng, the same stream as the
   * game, so determinism requires the host to call GameRuntime.botInput exactly once per
   * step per bot, before step(). Return only the fields you have an opinion on (e.g. omit
   * `axes` when idle) so bots of composed blocks merge sensibly.
   */
  bot(ctx: BlockCtx<P>, playerId: string, skill: number): InputFrame;
  onTimeline?(ctx: BlockCtx<P>, ev: TimelineEvent): void;
  /** Result of a judgement this block requested (shape per kind; validate it, it is untrusted). */
  onJudgement?(ctx: BlockCtx<P>, id: string, result: unknown): void;
}
