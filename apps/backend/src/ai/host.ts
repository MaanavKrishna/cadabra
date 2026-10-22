import type { GameEvent, Player } from '@cadabra/engine';
import type { TriviaQuestion } from '@cadabra/engine';
import { z } from 'zod';
import type { RoomSettings } from '@cadabra/spec';
import { converse, screenOutput, type Message } from './bedrock';

/**
 * The voiced AI host: one-liners, end-of-game roast, AI drawing judge and trivia writer.
 * Every generated string goes through the guardrail (`screenOutput`); a blocked line, an outage or any AI
 * failure yields a generic safe line instead, so the room never sees an error.
 */
type Personality = RoomSettings['hostPersonality'];
export type HostLineKind = 'join' | 'pitches' | 'forge' | 'event' | 'finale' | 'results' | 'remix' | 'fallback';
const log = (...a: unknown[]) => console.warn('[host]', ...a);

const MAX_WORDS = 22;
const LINE_TIMEOUT_MS = 4000;
const ROAST_TIMEOUT_MS = 5000;
export const DRAW_TIMEOUT_MS = 7000; // the draw-judge block gives up at 8 s
export const TRIVIA_TIMEOUT_MS = 6500; // the trivia block gives up at 8 s
const MAX_DRAWINGS = 4;
const MAX_IMAGE_BYTES = 1_500_000;

// ---------- helpers ----------
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};
const pick = <T>(arr: readonly T[], seed: string): T => arr[hash(seed) % arr.length]!;

/** Strip wrapping quotes/markdown and cap to MAX_WORDS words. */
export function tidyLine(raw: string, maxWords = MAX_WORDS): string {
  let t = raw.replace(/```[a-z]*|```/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  const words = t.split(' ').filter(Boolean);
  return words.length > maxWords ? words.slice(0, maxWords).join(' ').replace(/[,;:\-–]$/, '') + '…' : words.join(' ');
}

/** Pull the first JSON array out of model text (tolerates fences and chatter). */
export function parseJsonArray(text: string): unknown[] | undefined {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return undefined;
  try { const v = JSON.parse(text.slice(a, b + 1)); return Array.isArray(v) ? v : undefined; } catch { return undefined; }
}

/** Screened text, or the supplied safe replacement. */
async function safe(text: string, familySafe: boolean, replacement: string): Promise<string> {
  if (!text) return replacement;
  try {
    const r = await screenOutput(text, familySafe);
    return r.allowed ? text : replacement;
  } catch { return replacement; }
}

const PERSONA: Record<Personality, string> = {
  cheeky: 'a cheeky, quick-witted game-show host who teases players with warm sarcasm',
  hype: 'an over-the-top hype-man host, all caps energy but no actual shouting, lots of excitement',
  calm: 'a calm, dry, deadpan host with gentle understatement',
};
const HOST_SYSTEM = (p: Personality) =>
  `You are the voiced host of a living-room party game on a TV, ${PERSONA[p]}. The room is a family with kids and grandparents: ` +
  'keep it playful and family-friendly, never cruel, never about appearance, family, or anything sensitive. English only. ' +
  'Reply with plain text only, no quotes, no emojis, no stage directions.';

// ---------- host lines ----------
const FALLBACK_LINES: Record<HostLineKind, readonly string[]> = {
  join: ['Welcome in! Grab a seat, the chaos starts shortly.', 'Another player appears! The room just got more interesting.'],
  pitches: ['Three wild ideas, one winner. Choose wisely!', 'Behold, three game ideas fresh from the magic oven.'],
  forge: ['Cooking up your game right now. Stay hungry.', 'Magic in progress. Please do not poke the wizard.'],
  event: ['Plot twist! Hold on to your snacks.', 'Something just changed. Stay sharp, everybody!'],
  finale: ['Final seconds! Give it everything you have!', 'Last chance, make it count!'],
  results: ['And that is the game! What a performance.', 'The scores are in, and nobody will forget this one.'],
  remix: ['Remixing the game! Fresh rules coming right up.', 'A twist of the dial and the game is brand new.'],
  fallback: ['Let the games begin!', 'Ready when you are, champions.'],
};
const KIND_BRIEF: Record<HostLineKind, string> = {
  join: 'a player just joined the room',
  pitches: 'three game ideas are about to be shown for the room to vote on',
  forge: 'the AI is building the winning game right now',
  event: 'a surprise event just hit mid-round',
  finale: 'the final 10 seconds of the round just started',
  results: 'the game just ended and results are shown',
  remix: 'the game is being remixed with a new twist',
  fallback: 'a generic moment, keep things moving',
};

/** One host line (≤ 22 words) for a moment of the show. Never throws. */
export async function hostLine(
  kind: HostLineKind, ctx: object, personality: Personality, opts: { familySafe?: boolean } = {},
): Promise<string> {
  const familySafe = opts.familySafe ?? true;
  const generic = pick(FALLBACK_LINES[kind] ?? FALLBACK_LINES.fallback, JSON.stringify(ctx ?? {}) + kind);
  try {
    const out = await converse({
      model: 'fast',
      system: HOST_SYSTEM(personality),
      messages: [{ role: 'user', content: [{ text:
        `Moment: ${KIND_BRIEF[kind] ?? KIND_BRIEF.fallback}.\nContext (JSON): ${JSON.stringify(ctx ?? {}).slice(0, 1200)}\n` +
        `Say ONE short line, at most ${MAX_WORDS} words. Mention a player or detail from the context if it helps.` }] }],
      maxTokens: 120,
      timeoutMs: LINE_TIMEOUT_MS,
    });
    const line = tidyLine(out.text);
    if (!line) return generic;
    return await safe(line, familySafe, generic);
  } catch (e) {
    log('hostLine failed:', (e as Error)?.name);
    return generic;
  }
}

// ---------- roast ----------
const EVENT_PHRASE: Record<string, string> = {
  'sneak.woke': 'woke the guard',
  'sneak.caught': 'got caught sneaking',
  'collect.stolen': 'stole loot',
  'collect.golden': 'grabbed the golden prize',
  'collect.banked': 'banked loot',
  'dodge.hit': 'got hit',
  'race.stumble': 'stumbled',
  'race.finish': 'finished the race',
  'arena.dash': 'dashed around',
  'draw.winner': 'won a drawing round',
  'tug.won': 'won a tug round',
};
const MAX_PROMPT_CHARS = 1500;
const MAX_PARTS_PER_PLAYER = 4;

/** Per-player counts by event type, e.g. "Dad: woke the guard 4 times; Riya: stole loot 3 times". */
export function summarizeEvents(events: GameEvent[], players: Pick<Player, 'id' | 'name'>[]): string {
  const names = new Map(players.map((p) => [p.id, p.name]));
  const per = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (!e.player) continue;
    let phrase = EVENT_PHRASE[e.type];
    if (e.type === 'trivia.answer') phrase = e.data?.correct ? 'nailed a trivia question' : 'flubbed a trivia question';
    if (!phrase) continue;
    const m = per.get(e.player) ?? new Map<string, number>();
    m.set(phrase, (m.get(phrase) ?? 0) + 1);
    per.set(e.player, m);
  }
  const rows = [...per].map(([id, m]) => {
    const parts = [...m].sort((a, b) => b[1] - a[1]).slice(0, MAX_PARTS_PER_PLAYER)
      .map(([phrase, n]) => `${phrase} ${n} ${n === 1 ? 'time' : 'times'}`);
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    return { total, text: `${names.get(id) ?? id}: ${parts.join(', ')}` };
  }).sort((a, b) => b.total - a.total);
  return rows.map((r) => r.text).join('; ').slice(0, MAX_PROMPT_CHARS);
}

const GENERIC_ROASTS = [
  'Everyone played like it was a rehearsal, and honestly it was glorious.',
  'No notes. Well, a few notes, but they are all affectionate.',
  'A round of applause for everyone, and a round of snacks for the losers.',
];

export async function roast(
  events: GameEvent[], players: Player[], spec: Pick<{ title: string; hook: string }, 'title' | 'hook'>,
  opts: { familySafe?: boolean; personality?: Personality } = {},
): Promise<string[]> {
  const familySafe = opts.familySafe ?? true;
  const summary = summarizeEvents(events, players);
  const fallback = (): string[] => {
    const first = summary.split('; ')[0];
    const lines = first ? [`${first.replace(':', ' --')}. Respect.`.replace(' --', ':')] : [];
    return [...lines, ...GENERIC_ROASTS].slice(0, 3);
  };
  if (!summary) return GENERIC_ROASTS.slice(0, 2);
  try {
    const out = await converse({
      model: 'fast',
      system: HOST_SYSTEM(opts.personality ?? 'cheeky'),
      messages: [{ role: 'user', content: [{ text:
        `Game: "${spec.title}" - ${spec.hook}\nWhat happened (counts per player): ${summary}\n` +
        'Write 2 or 3 short, funny, affectionate roast lines (max 22 words each) that cite these real numbers and use the players\' names. ' +
        'Reply ONLY with a JSON array of strings.' }] }],
      maxTokens: 400,
      timeoutMs: ROAST_TIMEOUT_MS,
    });
    const arr = (parseJsonArray(out.text) ?? out.text.split('\n')).map((x) => (typeof x === 'string' ? tidyLine(x) : '')).filter(Boolean).slice(0, 3);
    if (arr.length === 0) return fallback();
    const checked = await Promise.all(arr.map((l, i) => safe(l, familySafe, GENERIC_ROASTS[i % GENERIC_ROASTS.length]!)));
    return checked.length >= 2 ? checked : [...checked, ...fallback()].slice(0, 2);
  } catch (e) {
    log('roast failed:', (e as Error)?.name);
    return fallback();
  }
}

// ---------- draw judging ----------
export interface DrawInput { playerId: string; png: string; name?: string; bot?: boolean }
export interface DrawResult { playerId: string; score: number; roast: string }

const BOT_ROASTS = [
  'A bold scribble from our robot friend.', 'The bot is calling it abstract art.', 'Mysterious. Possibly a cloud. Possibly a cat.',
  'Minimalism at its finest, courtesy of a machine.',
];
const MIDDLING_ROASTS = [
  'The judge squinted and gave a polite nod.', 'Bold lines, bolder choices.', 'Solid effort. The paper survived.',
];
const middling = (playerId: string, round = ''): number => 4 + (hash(playerId + round) % 3); // 4..6
const middlingResult = (d: Pick<DrawInput, 'playerId' | 'bot'>, round = ''): DrawResult =>
  ({ playerId: d.playerId, score: middling(d.playerId, round), roast: pick(d.bot ? BOT_ROASTS : MIDDLING_ROASTS, d.playerId + round) });

const STYLE: Record<string, string> = {
  kind: 'warm and encouraging, finding something to praise',
  savage: 'savage but playful, a comedy-roast style with no cruelty about the person',
  absurd: 'absurdist and surreal, wildly over-interpreting the drawings',
};

function decodePng(dataUrl: string): { format: 'png' | 'jpeg' | 'webp' | 'gif'; bytes: Uint8Array } | undefined {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return undefined;
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return undefined;
  return { format: (m[1] === 'jpg' ? 'jpeg' : m[1]) as 'png' | 'jpeg' | 'webp' | 'gif', bytes };
}

/** Score each drawing 0..10 with a roast. Bots are scored locally; AI failure leaves humans a middling score. */
export async function judgeDrawings(
  prompt: string, drawings: DrawInput[], style: string, opts: { familySafe?: boolean; round?: number } = {},
): Promise<DrawResult[]> {
  const familySafe = opts.familySafe ?? true;
  const round = String(opts.round ?? '');
  const results = new Map<string, DrawResult>();
  const humans: (DrawInput & { img: NonNullable<ReturnType<typeof decodePng>> })[] = [];
  for (const d of drawings) {
    if (d.bot) { results.set(d.playerId, middlingResult(d, round)); continue; }
    const img = decodePng(d.png);
    if (img && humans.length < MAX_DRAWINGS) humans.push({ ...d, img });
  }
  if (humans.length) {
    try {
      const content: Message['content'] = [{ text:
        `Prompt everyone was asked to draw: "${prompt}". Judge style: ${STYLE[style] ?? STYLE.kind}.\n` +
        `You will see ${humans.length} drawing(s) in order, each preceded by its playerId.` }];
      for (const h of humans) {
        content.push({ text: `Drawing by playerId=${h.playerId}:` });
        content.push({ image: { format: h.img.format, source: { bytes: h.img.bytes } } });
      }
      content.push({ text:
        'Score each drawing 0-10 for how well it fits the prompt and for creativity (blank or scribbled drawings score low). ' +
        'Give each a one-sentence roast (max 20 words, family-friendly, about the drawing not the person). ' +
        'Reply ONLY with a JSON array: [{"playerId":"...","score":7,"roast":"..."}]' });
      const out = await converse({
        model: 'designer',
        system: 'You are the witty AI judge of a family drawing game. Be fair, funny and kind to kids.',
        messages: [{ role: 'user', content }],
        maxTokens: 500,
        timeoutMs: DRAW_TIMEOUT_MS,
      });
      const arr = parseJsonArray(out.text) ?? [];
      const wanted = new Set(humans.map((h) => h.playerId));
      await Promise.all(arr.map(async (r) => {
        const { playerId, score, roast: rr } = (r ?? {}) as Partial<DrawResult>;
        if (typeof playerId !== 'string' || !wanted.has(playerId) || results.has(playerId)) return;
        if (typeof score !== 'number' || !Number.isFinite(score)) return;
        const fb = pick(MIDDLING_ROASTS, playerId + round);
        const text = typeof rr === 'string' ? tidyLine(rr, 24) : '';
        results.set(playerId, {
          playerId, score: Math.round(Math.min(10, Math.max(0, score))), roast: await safe(text, familySafe, fb),
        });
      }));
    } catch (e) {
      log('judgeDrawings failed:', (e as Error)?.name);
    }
  }
  return drawings.map((d) => results.get(d.playerId) ?? middlingResult(d, round));
}

// ---------- trivia ----------
/** Mirrors the trivia block's own validation (engine does not export its schema). */
const triviaQuestionSchema = z.object({
  q: z.string().min(1).max(200),
  options: z.tuple([z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(80)]),
  answer: z.number().int().min(0).max(3),
});
export async function triviaQuestions(
  topic: string, players: string[], n: number,
  opts: { hook?: string; ingredients?: string[]; aboutPlayers?: boolean; familySafe?: boolean } = {},
): Promise<TriviaQuestion[]> {
  const familySafe = opts.familySafe ?? true;
  const count = Math.max(1, Math.min(15, Math.floor(n) || 5));
  try {
    const out = await converse({
      model: 'fast',
      system: 'You write multiple-choice trivia for a family party game. Questions are fun, clear, factually correct, and suitable for ages 8 and up. English only.',
      messages: [{ role: 'user', content: [{ text:
        `Write ${count} questions themed on: "${topic}"${opts.hook ? ` (${opts.hook})` : ''}.` +
        (opts.ingredients?.length ? ` Ideas to draw on: ${opts.ingredients.slice(0, 8).join(', ')}.` : '') +
        (opts.aboutPlayers && players.length ? ` Include some playful questions about the players: ${players.slice(0, 4).join(', ')}.` : '') +
        ' Each has exactly 4 short options, and "answer" is the 0-based index of the correct option (vary the position). ' +
        'Reply ONLY with a JSON array: [{"q":"...","options":["a","b","c","d"],"answer":0}]' }] }],
      maxTokens: 2500,
      timeoutMs: TRIVIA_TIMEOUT_MS,
    });
    const valid: TriviaQuestion[] = [];
    for (const r of parseJsonArray(out.text) ?? []) {
      const p = triviaQuestionSchema.safeParse(r);
      if (p.success) valid.push(p.data);
    }
    const verdicts = await Promise.all(valid.map(async (q) => {
      try { return (await screenOutput(`${q.q} ${q.options.join(' | ')}`, familySafe)).allowed; } catch { return false; }
    }));
    return valid.filter((_, i) => verdicts[i]).slice(0, count);
  } catch (e) {
    log('triviaQuestions failed:', (e as Error)?.name);
    return []; // the block falls back to its built-in bank
  }
}

// ---------- engine judgement dispatch ----------
type Obj = Record<string, unknown>;
const asEntries = (p: Obj) => (Array.isArray(p.entries) ? p.entries : []) as Obj[];

/** Resolve an engine 'draw' / 'trivia-gen' judgement payload to the result the block validates. */
export async function resolveJudgement(kind: string, payload: unknown): Promise<unknown> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Obj;
  if (kind === 'draw') {
    const drawings: DrawInput[] = asEntries(p).flatMap((e) =>
      typeof e.playerId === 'string' ? [{ playerId: e.playerId, png: typeof e.image === 'string' ? e.image : '', name: String(e.name ?? ''), bot: e.bot === true }] : []);
    return judgeDrawings(String(p.prompt ?? 'a drawing'), drawings, String(p.judgeStyle ?? 'kind'),
      { familySafe: true, round: typeof p.round === 'number' ? p.round : undefined });
  }
  if (kind === 'trivia-gen') {
    return triviaQuestions(String(p.topic ?? 'party'), Array.isArray(p.players) ? p.players.map(String) : [], Number(p.n) || 5, {
      hook: typeof p.hook === 'string' ? p.hook : undefined,
      ingredients: Array.isArray(p.ingredients) ? p.ingredients.map(String) : undefined,
      aboutPlayers: p.aboutPlayers === true,
      familySafe: true,
    });
  }
  return [];
}

/** AI-free result for when the judgement worker cannot even be started. */
export function offlineJudgement(kind: string, payload: unknown): unknown {
  if (kind !== 'draw') return [];
  const p = (payload && typeof payload === 'object' ? payload : {}) as Obj;
  const round = typeof p.round === 'number' ? String(p.round) : '';
  return asEntries(p).flatMap((e) =>
    typeof e.playerId === 'string' ? [middlingResult({ playerId: e.playerId, bot: e.bot === true }, round)] : []);
}
