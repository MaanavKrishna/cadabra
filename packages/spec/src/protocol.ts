// Append-only: later tasks add their own message types (backend, forge, arcade) below.
import { z } from 'zod';
import { InputFrameSchema } from './controls';
import { GameSpecSchema, PitchSchema } from './game-spec';
import { RoomSettingsSchema } from './settings';

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
  'room.notFound', 'room.full', 'room.badRequest', 'room.notInRoom', 'room.targetGone', 'room.badToken',
  // Forge (Task 16)
  'forge.busy', 'forge.badVote',
]);
export type BackendErrorCode = z.infer<typeof BackendErrorCodeSchema>;

export const PlayerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
});
export type PlayerInfo = z.infer<typeof PlayerInfoSchema>;

const NoControlChars = /^[^\u0000-\u001f\u007f-\u009f]*$/;

/** An Idea Storm ingredient: plain text, or text attributed to the player who typed it. */
export const ForgeIngredientSchema = z.union([
  z.string().min(1).max(80).regex(NoControlChars),
  z.object({ text: z.string().min(1).max(80).regex(NoControlChars), playerId: z.string().max(32).optional() }),
]);
export type ForgeIngredient = z.infer<typeof ForgeIngredientSchema>;

export const ClientToBackendSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('room.create'), household: z.string().max(64).regex(NoControlChars).optional() }),
  z.object({
    t: z.literal('room.join'),
    code: z.string().regex(ROOM_CODE_RE),
    name: z.string().max(40).regex(NoControlChars),
    rejoinToken: z.string().max(64).optional(),
  }),
  z.object({ t: z.literal('room.resume'), code: z.string().regex(ROOM_CODE_RE), tvToken: z.string().max(64) }),
  z.object({ t: z.literal('signal'), to: z.string().max(32), data: z.unknown() }),
  z.object({ t: z.literal('relay'), to: z.string().max(32).optional(), data: z.unknown() }),
  z.object({ t: z.literal('ping') }),
  // ---- Forge (Task 16): TV asks for pitches, then reports the room's vote ----
  z.object({
    t: z.literal('forge.pitch'),
    code: z.string().regex(ROOM_CODE_RE),
    ingredients: z.array(ForgeIngredientSchema).max(12),
    players: z.array(z.union([z.string().max(40), PlayerInfoSchema])).max(MAX_PLAYERS),
    settings: RoomSettingsSchema,
  }),
  z.object({ t: z.literal('forge.vote'), code: z.string().regex(ROOM_CODE_RE), pitchId: z.string().min(1).max(64) }),
]);
export type ClientToBackend = z.infer<typeof ClientToBackendSchema>;

export const BackendToClientSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('room.created'), code: z.string(), tvToken: z.string() }),
  z.object({ t: z.literal('room.resumed'), players: z.array(PlayerInfoSchema).optional() }),
  z.object({ t: z.literal('room.joined'), playerId: z.string(), token: z.string(), name: z.string() }),
  z.object({ t: z.literal('player.joined'), player: PlayerInfoSchema }),
  z.object({ t: z.literal('player.left'), playerId: z.string() }),
  z.object({ t: z.literal('tv.left') }),
  z.object({ t: z.literal('tv.back') }),
  z.object({ t: z.literal('signal'), from: z.string(), data: z.unknown() }),
  z.object({ t: z.literal('relay'), from: z.string(), data: z.unknown() }),
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('error'), code: BackendErrorCodeSchema, message: z.string().optional() }),
  // ---- Forge (Task 16) ----
  /** Sent to a player whose ingredient was blocked by family-safe screening. */
  z.object({ t: z.literal('screen'), name: ScreenNameSchema }),
  z.object({ t: z.literal('forge.pitches'), forgeId: z.string().optional(), pitches: z.array(PitchSchema).length(3) }),
  z.object({ t: z.literal('forge.progress'), pitchId: z.string(), step: z.string(), pct: z.number().min(0).max(100) }),
  /** `fallback`: a reskinned prebuilt game (AI design failed or ran out of time). */
  z.object({ t: z.literal('forge.ready'), pitchId: z.string(), spec: GameSpecSchema, fallback: z.boolean().optional() }),
]);
export type BackendToClient = z.infer<typeof BackendToClientSchema>;
