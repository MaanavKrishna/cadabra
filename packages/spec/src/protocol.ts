// Append-only: later tasks add their own message types (backend, forge, arcade) below.
import { z } from 'zod';
import { InputFrameSchema } from './controls';
import { GameSpecSchema, PaletteSchema, PitchSchema } from './game-spec';
import { RoomSettingsSchema } from './settings';
import { ArtUrlSchema, TWEAK_TEXT_MAX, TweakChipSchema } from './screens';

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
  // Host voice / judgements (Task 18)
  'room.rateLimited',
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

export const HostLineKindSchema = z.enum(['join', 'pitches', 'forge', 'event', 'finale', 'results', 'remix', 'fallback']);

// ---- Arcade (Task 24) ----
const ArcadeHousehold = z.string().min(1).max(64).regex(NoControlChars);
const ArcadeSpecId = z.string().min(1).max(64);
/** Art for a saved game: key art plus sprite images (https or data:image URLs). */
export const ArcadeArtSchema = z.object({
  keyArt: ArtUrlSchema.optional(),
  sprites: z.record(z.string().max(64), ArtUrlSchema).optional(),
});
export type ArcadeArt = z.infer<typeof ArcadeArtSchema>;
/** One tile in arcade.items: light on purpose (API Gateway caps server->client messages at 128 KB). */
export const ArcadeGameSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  hook: z.string(),
  palette: PaletteSchema,
  /** https URL only (data: art is omitted here; arcade.play returns the full art). */
  keyArt: z.string().optional(),
  playedCount: z.number(),
  lastPlayed: z.number(),
  unplayed: z.boolean(),
});
export type ArcadeGameSummary = z.infer<typeof ArcadeGameSummarySchema>;

// ---- Tweak / Remix (R2) ----
/** One room request: a chip, or free text a player typed. */
export const TweakRequestSchema = z.union([
  z.object({ chip: TweakChipSchema, playerId: z.string().max(32).optional() }),
  z.object({ text: z.string().min(1).max(TWEAK_TEXT_MAX).regex(NoControlChars), playerId: z.string().max(32).optional() }),
]);
export type TweakRequest = z.infer<typeof TweakRequestSchema>;
/** Where a tweaked spec came from: the AI designer, the deterministic chip presets, or unchanged. */
export const TweakSourceSchema = z.enum(['ai', 'preset', 'none']);

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
  // ---- Host voice and AI judgements (Task 18): TV only ----
  /** Speak `text`, or have the AI write a line for `kind`+`ctx` first. Answered with host.audio (url omitted when voice failed). */
  z.object({
    t: z.literal('host.say'),
    code: z.string().regex(ROOM_CODE_RE),
    id: z.string().max(64).optional(),
    text: z.string().min(1).max(240).optional(),
    kind: HostLineKindSchema.optional(),
    ctx: z.record(z.unknown()).optional(),
    personality: z.enum(['cheeky', 'hype', 'calm']).optional(),
    familySafe: z.boolean().optional(),
    /** false: return the caption only (host voice off). */
    voice: z.boolean().optional(),
  }),
  /** End-of-game roast from raw engine events; answered with host.roasted. */
  z.object({
    t: z.literal('host.roast'),
    code: z.string().regex(ROOM_CODE_RE),
    id: z.string().max(64),
    events: z.array(z.object({
      t: z.number(), type: z.string().max(40), player: z.string().max(40).optional(), data: z.record(z.unknown()).optional(),
    })).max(800),
    players: z.array(z.object({ id: z.string().max(40), name: z.string().max(40) })).max(MAX_PLAYERS),
    title: z.string().max(80),
    hook: z.string().max(200),
    personality: z.enum(['cheeky', 'hype', 'calm']).optional(),
    familySafe: z.boolean().optional(),
    voice: z.boolean().optional(),
  }),
  /** Engine judgement ('draw' | 'trivia-gen') for the AI; answered with judge.result. */
  z.object({
    t: z.literal('judge.request'),
    code: z.string().regex(ROOM_CODE_RE),
    id: z.string().min(1).max(64),
    kind: z.enum(['draw', 'trivia-gen']),
    payload: z.unknown(),
  }),
  // ---- Arcade (Task 24): TV only; `household` must be the room's household ----
  z.object({ t: z.literal('arcade.list'), household: ArcadeHousehold }),
  z.object({ t: z.literal('arcade.save'), household: ArcadeHousehold, spec: z.unknown(), art: ArcadeArtSchema.optional() }),
  z.object({ t: z.literal('arcade.play'), household: ArcadeHousehold, specId: ArcadeSpecId }),
  z.object({ t: z.literal('arcade.delete'), household: ArcadeHousehold, specId: ArcadeSpecId }),
  /** A round of this game was played: bump playedCount/lastPlayed (saves it first when `spec` is given and new). */
  z.object({ t: z.literal('arcade.played'), household: ArcadeHousehold, specId: ArcadeSpecId, spec: z.unknown().optional(), art: ArcadeArtSchema.optional() }),
  // ---- Tweak / Remix (R2): TV only. Patch `spec` with the room's requests; answered by forge.tweaked (always). ----
  z.object({
    t: z.literal('forge.tweak'),
    code: z.string().regex(ROOM_CODE_RE),
    /** TV's request id, echoed on forge.tweakProgress / forge.tweaked. */
    id: z.string().min(1).max(64),
    /** The current GameSpec (validated server side). */
    spec: z.unknown(),
    requests: z.array(TweakRequestSchema).min(1).max(3),
    familySafe: z.boolean().optional(),
    /** Seats in the next round incl. bots (1..4; playtests use max(2, seats)). */
    seats: z.number().int().min(1).max(4).optional(),
    /** 'remix': an Arcade game being remixed (same flow; the TV saves the result as a new entry). */
    mode: z.enum(['tweak', 'remix']).optional(),
  }),
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
  z.object({ t: z.literal('forge.progress'), forgeId: z.string().optional(), pitchId: z.string(), step: z.string(), pct: z.number().min(0).max(100) }),
  /** `fallback`: a reskinned prebuilt game (AI design failed or ran out of time). */
  z.object({ t: z.literal('forge.ready'), forgeId: z.string().optional(), pitchId: z.string(), spec: GameSpecSchema, fallback: z.boolean().optional() }),
  // ---- Host voice and AI judgements (Task 18) ----
  /** `url` (mp3) is absent when voice synthesis failed: show the caption only. */
  z.object({ t: z.literal('host.audio'), id: z.string().optional(), text: z.string(), url: z.string().optional() }),
  z.object({ t: z.literal('host.roasted'), id: z.string(), lines: z.array(z.string()), urls: z.array(z.string().nullable()).optional() }),
  z.object({ t: z.literal('judge.result'), id: z.string(), result: z.unknown() }),
  // ---- Arcade (Task 24) ----
  z.object({ t: z.literal('arcade.items'), games: z.array(ArcadeGameSummarySchema) }),
  z.object({ t: z.literal('arcade.game'), spec: GameSpecSchema, art: ArcadeArtSchema.optional() }),
  // ---- Art (Task 17): one message per finished image; absent when no image model is available ----
  /** `key` is 'keyArt' or a sprite key; `url` is https on the assets CDN. `specId` is set once the spec exists. */
  z.object({ t: z.literal('forge.art'), forgeId: z.string().optional(), pitchId: z.string(), key: z.string().max(64), url: ArtUrlSchema, specId: z.string().max(64).optional() }),
  // ---- Tweak / Remix (R2) ----
  /** Cosmetic progress for the "Rebuilding…" card. */
  z.object({ t: z.literal('forge.tweakProgress'), id: z.string(), step: z.string().max(60) }),
  /**
   * The tweaked game: a new spec id with origin.parentId = the original id (source 'none': the original spec,
   * unchanged). `summary` is the one-line "what changed" ("Gravity ×0.4, bounce up"); `changes` are short tags
   * for chips ("Gravity ×0.4", "Bounce ↑"). `blocked`: some typed requests were dropped by family-safe screening.
   */
  z.object({
    t: z.literal('forge.tweaked'),
    id: z.string(),
    spec: GameSpecSchema,
    summary: z.string().max(120),
    changes: z.array(z.string().max(40)).max(6),
    source: TweakSourceSchema,
    blocked: z.boolean().optional(),
    ms: z.number().optional(),
  }),
]);
export type BackendToClient = z.infer<typeof BackendToClientSchema>;
