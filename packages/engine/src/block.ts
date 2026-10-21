import type { z } from 'zod';
import type { ControlWidget, GameSpec, InputFrame, TimelineEvent } from '@cadabra/spec';
import type { FxEvent, GameEvent } from './fx';
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

export interface BlockCtx<P> {
  params: P;
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
}

export interface BlockDef<P = any> {
  id: string;
  name: string;
  summary: string;
  paramsSchema: z.ZodType<P>;
  defaults: P;
  controls: ControlWidget['kind'][];
  arenaKinds: GameSpec['arena']['kind'][];
  setup(ctx: BlockCtx<P>): void;
  update(ctx: BlockCtx<P>, dt: number): void;
  onInput(ctx: BlockCtx<P>, playerId: string, input: InputFrame): void;
  bot(ctx: BlockCtx<P>, playerId: string, skill: number): InputFrame;
  onTimeline?(ctx: BlockCtx<P>, ev: TimelineEvent): void;
}
