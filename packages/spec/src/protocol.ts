// Append-only: later tasks add their own message types (backend, forge, arcade) below.
import { z } from 'zod';
import { InputFrameSchema } from './controls';

export const SCREEN_NAMES = [
  'join', 'avatar', 'storm', 'vote', 'warmup', 'play', 'results', 'remix', 'tweak', 'wait', 'blocked',
] as const;
export type ScreenName = (typeof SCREEN_NAMES)[number];
export const ScreenNameSchema = z.enum(SCREEN_NAMES);

export const PeerMsgSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), frame: InputFrameSchema }),
  z.object({ t: z.literal('screen'), name: ScreenNameSchema, data: z.unknown().optional() }),
  z.object({ t: z.literal('ping'), id: z.number() }),
  z.object({ t: z.literal('pong'), id: z.number() }),
]);
export type PeerMsg = z.infer<typeof PeerMsgSchema>;
