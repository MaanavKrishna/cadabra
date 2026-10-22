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

// ---- Backend (Task 9): room join, WebRTC signaling, relay fallback ----
export const ROOM_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZA]{4}$/;
export const MAX_PLAYERS = 4;

export const BackendErrorCodeSchema = z.enum([
  'room.notFound', 'room.full', 'room.badRequest', 'room.notInRoom', 'room.targetGone',
]);
export type BackendErrorCode = z.infer<typeof BackendErrorCodeSchema>;

export const PlayerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
});
export type PlayerInfo = z.infer<typeof PlayerInfoSchema>;

export const ClientToBackendSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('room.create'), household: z.string().max(64).optional() }),
  z.object({
    t: z.literal('room.join'),
    code: z.string().length(4),
    name: z.string().min(1),
    rejoinToken: z.string().optional(),
  }),
  z.object({ t: z.literal('signal'), to: z.string(), data: z.unknown() }),
  z.object({ t: z.literal('relay'), to: z.string().optional(), data: z.unknown() }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientToBackend = z.infer<typeof ClientToBackendSchema>;

export const BackendToClientSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('room.created'), code: z.string(), tvToken: z.string() }),
  z.object({ t: z.literal('room.joined'), playerId: z.string(), token: z.string(), name: z.string() }),
  z.object({ t: z.literal('player.joined'), player: PlayerInfoSchema }),
  z.object({ t: z.literal('player.left'), playerId: z.string() }),
  z.object({ t: z.literal('signal'), from: z.string(), data: z.unknown() }),
  z.object({ t: z.literal('relay'), from: z.string(), data: z.unknown() }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('error'), code: BackendErrorCodeSchema, message: z.string().optional() }),
]);
export type BackendToClient = z.infer<typeof BackendToClientSchema>;
