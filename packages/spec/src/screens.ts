// Screen payloads (TV → phone) and replies (phone → TV), both carried in the
// PeerMsg envelope {t:'screen', name, data}.
//  - TV → phone: data is the screen's payload (ScreenDataSchemas[name]); it never has a `reply` key.
//  - Phone → TV: data is a Reply, discriminated by `reply` ('vote.cast', 'storm.add', …);
//    `name` is REPLY_SCREEN[reply]. Use parseReply / parseScreenData; never guess the direction.
import { z } from 'zod';
import { ControlWidgetSchema } from './controls';
import type { PeerMsg, ScreenName } from './protocol';

// ---- shared pieces ----
const text = (max: number) => z.string().max(max);
const seconds = z.number().finite().min(0).max(600);
const ThemeVarsSchema = z.record(z.string().max(32), z.string().max(64));

/** Art URLs: https: or data:image/* only (they end up inside CSS url()). */
export function isSafeArtUrl(s: string): boolean {
  if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) return true;
  try { return new URL(s).protocol === 'https:'; } catch { return false; }
}
export const ArtUrlSchema = z.string().max(400_000).refine(isSafeArtUrl, 'unsafe art url');

export const PitchOptionSchema = z.union([
  text(60).min(1),
  z.object({ title: text(60).min(1), tagline: text(120).optional(), art: ArtUrlSchema.optional() }),
]);
export const StandingSchema = z.object({
  name: text(40), score: z.number().finite(), avatar: text(20).optional(), you: z.boolean().optional(),
});
const widgets = z.array(ControlWidgetSchema).max(6).default([]);
const base = { themeVars: ThemeVarsSchema.optional() };

export const ScreenDataSchemas = {
  join: z.object(base),
  avatar: z.object({ ...base, taken: z.array(text(20)).max(12).optional() }),
  storm: z.object({ ...base, prompt: text(120).optional(), seconds: seconds.optional() }),
  vote: z.object({ ...base, options: z.array(PitchOptionSchema).min(1).max(6), seconds: seconds.optional() }),
  warmup: z.object({ ...base, title: text(60).optional(), howTo: text(200).optional(), widgets, seconds: seconds.optional() }),
  play: z.object({ ...base, title: text(60).optional(), widgets }),
  results: z.object({
    ...base, title: text(60).optional(), rank: z.number().int().min(1).max(8).optional(),
    standings: z.array(StandingSchema).max(8).optional(),
  }),
  remix: z.object({ ...base, prompt: text(120).optional() }),
  tweak: z.object({ ...base, message: text(200).optional() }),
  wait: z.object({ ...base, message: text(120).optional(), sub: text(200).optional() }),
  blocked: z.object({ ...base, message: text(200).optional() }),
} satisfies Record<ScreenName, z.ZodTypeAny>;

export type ScreenData = { [K in ScreenName]: z.output<(typeof ScreenDataSchemas)[K]> };
export type PitchOption = z.infer<typeof PitchOptionSchema>;
export type Standing = z.infer<typeof StandingSchema>;

export type ParsedScreen = { [K in ScreenName]: { name: K; data: ScreenData[K] } }[ScreenName];

// ---- replies ----
export const ReplySchema = z.discriminatedUnion('reply', [
  z.object({ reply: z.literal('avatar.pick'), avatar: z.string().regex(/^[a-z]{1,20}$/) }),
  z.object({ reply: z.literal('storm.add'), idea: text(40).min(1) }),
  z.object({ reply: z.literal('vote.cast'), vote: z.number().int().min(0).max(5) }),
  z.object({ reply: z.literal('warmup.ready') }),
  z.object({ reply: z.literal('results.pick'), action: z.enum(['again', 'remix']) }),
  z.object({ reply: z.literal('remix.add'), remix: text(40).min(1) }),
  z.object({ reply: z.literal('tweak.set'), key: text(32).min(1), value: z.union([z.number().finite(), z.boolean(), text(40)]) }),
]);
export type Reply = z.infer<typeof ReplySchema>;
export type ReplyKind = Reply['reply'];

export const REPLY_SCREEN: Record<ReplyKind, ScreenName> = {
  'avatar.pick': 'avatar', 'storm.add': 'storm', 'vote.cast': 'vote', 'warmup.ready': 'warmup',
  'results.pick': 'results', 'remix.add': 'remix', 'tweak.set': 'tweak',
};

const hasReplyKey = (d: unknown) => !!d && typeof d === 'object' && 'reply' in (d as object);

/** Phone side: build the envelope for a reply (throws on an invalid reply). */
export function replyMsg(r: Reply): Extract<PeerMsg, { t: 'screen' }> {
  const data = ReplySchema.parse(r);
  return { t: 'screen', name: REPLY_SCREEN[data.reply], data };
}

/** TV side: the phone's reply, or undefined if this is not a (valid) reply. */
export function parseReply(msg: PeerMsg): Reply | undefined {
  if (msg.t !== 'screen' || !hasReplyKey(msg.data)) return undefined;
  const r = ReplySchema.safeParse(msg.data);
  return r.success && REPLY_SCREEN[r.data.reply] === msg.name ? r.data : undefined;
}

export type ScreenParse =
  | { ok: true; screen: ParsedScreen }
  | { ok: false; name: ScreenName; reason: 'reply' | 'invalid' };

/** Phone side: validate a TV screen message. Replies and bad payloads come back ok:false. */
export function parseScreenData(name: ScreenName, data: unknown): ScreenParse {
  if (hasReplyKey(data)) return { ok: false, name, reason: 'reply' };
  const r = ScreenDataSchemas[name].safeParse(data ?? {});
  return r.success ? { ok: true, screen: { name, data: r.data } as ParsedScreen } : { ok: false, name, reason: 'invalid' };
}
