import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import { clamp, stateOf } from './util';

export const triviaQuestionSchema = z.object({
  q: z.string().min(1).max(200),
  options: z.tuple([z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(80), z.string().min(1).max(80)]),
  answer: z.number().int().min(0).max(3),
});
export type TriviaQuestion = z.infer<typeof triviaQuestionSchema>;

export const triviaSchema = z.object({
  /** AI-filled. Empty: the block asks the host for a 'trivia-gen' judgement and falls back to a built-in bank. */
  questions: z.array(triviaQuestionSchema).max(30),
  secondsPerQuestion: z.number().min(5).max(30),
  /** Points for a correct answer in the first half of the question's time. */
  pointsFast: z.number().int().min(1).max(20),
  /** Points for a correct answer after that. */
  pointsSlow: z.number().int().min(0).max(20),
  /** Ask the generator for questions about the players themselves (names in the payload). */
  aboutPlayers: z.boolean(),
});
export type TriviaParams = z.infer<typeof triviaSchema>;

/** Payload of a 'trivia-gen' judgement; resolve with TriviaQuestion[]. */
export interface TriviaGenPayload {
  topic: string;
  hook: string;
  ingredients: string[];
  players: string[];
  n: number;
  aboutPlayers: boolean;
  familySafe: true;
}

/** Generic family-safe questions used when the generator is slow or offline. */
export const FALLBACK_QUESTIONS: TriviaQuestion[] = [
  { q: 'How many legs does a spider have?', options: ['6', '8', '10', '12'], answer: 1 },
  { q: 'Which planet is known as the Red Planet?', options: ['Venus', 'Jupiter', 'Mars', 'Saturn'], answer: 2 },
  { q: 'What do bees make?', options: ['Milk', 'Honey', 'Silk', 'Wax crayons'], answer: 1 },
  { q: 'How many days are in a leap year?', options: ['365', '364', '366', '360'], answer: 2 },
  { q: 'Which animal is the largest on Earth?', options: ['Elephant', 'Blue whale', 'Giraffe', 'Great white shark'], answer: 1 },
  { q: 'What colour do you get by mixing blue and yellow?', options: ['Green', 'Purple', 'Orange', 'Brown'], answer: 0 },
  { q: 'How many sides does a hexagon have?', options: ['5', '6', '7', '8'], answer: 1 },
  { q: 'Which fruit is famous for keeping the doctor away?', options: ['Banana', 'Mango', 'Apple', 'Grape'], answer: 2 },
  { q: 'What is frozen water called?', options: ['Steam', 'Ice', 'Fog', 'Dew'], answer: 1 },
  { q: 'Which is the fastest land animal?', options: ['Cheetah', 'Horse', 'Lion', 'Kangaroo'], answer: 0 },
  { q: 'How many continents are there?', options: ['5', '6', '7', '8'], answer: 2 },
  { q: 'What do caterpillars turn into?', options: ['Beetles', 'Butterflies', 'Spiders', 'Snails'], answer: 1 },
  { q: 'Which instrument has 88 keys?', options: ['Guitar', 'Violin', 'Piano', 'Flute'], answer: 2 },
  { q: 'What is the opposite of "north"?', options: ['East', 'West', 'Up', 'South'], answer: 3 },
  { q: 'Which shape has three sides?', options: ['Square', 'Triangle', 'Circle', 'Pentagon'], answer: 1 },
  { q: 'Where does a penguin live in the wild?', options: ['The Sahara', 'Antarctica', 'The Amazon', 'The Alps'], answer: 1 },
];

type Phase = 'thinking' | 'question' | 'reveal' | 'done';

interface Answer {
  choice: number;
  fast: boolean;
  after: number;
}

interface State {
  phase: Phase;
  phaseAt: number;
  genId?: string;
  generated: TriviaQuestion[];
  /** Bank questions appended when the main list runs out. */
  extra: TriviaQuestion[];
  index: number;
  current?: TriviaQuestion;
  answers: Map<string, Answer>;
  boardId?: number;
  qSeq: number;
  bots: Map<string, { seq: number; at: number; choice: number }>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({ phase: 'thinking', phaseAt: 0, generated: [], extra: [], index: -1, answers: new Map(), qSeq: 0, bots: new Map() }));

/** Sim seconds to wait for generated questions before using the built-in bank. */
export const GEN_TIMEOUT_SEC = 8;
const REVEAL_SEC = 3;
/** Correct answers within this fraction of secondsPerQuestion earn pointsFast. */
const FAST_FRAC = 0.5;
const MAX_GEN = 15;

function shuffled<T>(ctx: BlockCtx<unknown>, arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = ctx.rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function list(ctx: BlockCtx<TriviaParams>, s: State): TriviaQuestion[] {
  const main = ctx.params.questions.length > 0 ? ctx.params.questions : s.generated;
  return s.extra.length > 0 ? [...main, ...s.extra] : main;
}

function wanted(ctx: BlockCtx<TriviaParams>): number {
  return clamp(Math.ceil(ctx.spec.durationSec / (ctx.params.secondsPerQuestion + REVEAL_SEC)), 1, MAX_GEN);
}

function publish(ctx: BlockCtx<TriviaParams>, s: State): void {
  const b = s.boardId !== undefined ? ctx.world.get(s.boardId) : undefined;
  if (!b) return;
  const q = s.current;
  b.props.phase = s.phase;
  b.props.banner = s.phase === 'thinking' ? 'Thinking…' : '';
  b.props.index = s.index;
  b.props.q = q?.q ?? '';
  for (let i = 0; i < 4; i++) b.props[`opt${i}`] = q?.options[i] ?? '';
  // the answer stays hidden from snapshots until the reveal
  b.props.answer = s.phase === 'reveal' && q ? q.answer : -1;
  b.props.answered = s.answers.size;
  b.props.players = ctx.players.filter((p) => p.connected).length;
  b.props.endsAt =
    s.phase === 'question' ? s.phaseAt + ctx.params.secondsPerQuestion
      : s.phase === 'reveal' ? s.phaseAt + REVEAL_SEC
        : s.phase === 'thinking' ? s.phaseAt + GEN_TIMEOUT_SEC : ctx.time;
  b.props.fastUntil = s.phase === 'question' ? s.phaseAt + ctx.params.secondsPerQuestion * FAST_FRAC : 0;
}

function nextQuestion(ctx: BlockCtx<TriviaParams>, s: State): void {
  let qs = list(ctx, s);
  if (s.index + 1 >= qs.length && s.extra.length === 0) {
    // ran out with time to spare: top up from the bank, skipping repeats
    const seen = new Set(qs.map((q) => q.q));
    s.extra = shuffled(ctx as BlockCtx<unknown>, FALLBACK_QUESTIONS.filter((q) => !seen.has(q.q)));
    qs = list(ctx, s);
  }
  if (s.index + 1 >= qs.length) {
    s.phase = 'done';
    s.phaseAt = ctx.time;
    s.current = undefined;
    ctx.emit({ type: 'trivia.done', data: { asked: s.qSeq } });
    return;
  }
  s.index++;
  s.qSeq++;
  s.current = qs[s.index];
  s.answers = new Map();
  s.phase = 'question';
  s.phaseAt = ctx.time;
  ctx.emit({ type: 'trivia.question', data: { index: s.index, q: s.current!.q } });
  ctx.fx({ kind: 'sfx', name: 'whoosh' });
}

function reveal(ctx: BlockCtx<TriviaParams>, s: State): void {
  const P = ctx.params;
  const q = s.current!;
  s.phase = 'reveal';
  s.phaseAt = ctx.time;
  let anyRight = false;
  for (const p of ctx.players) {
    const a = s.answers.get(p.id);
    if (!a) continue;
    const correct = a.choice === q.answer;
    ctx.emit({ type: 'trivia.answer', player: p.id, data: { index: s.index, choice: a.choice, correct, fast: a.fast, after: a.after } });
    if (!correct) continue;
    anyRight = true;
    ctx.score(p.id, a.fast ? P.pointsFast : P.pointsSlow, a.fast ? 'trivia.fast' : 'trivia.correct');
  }
  ctx.emit({ type: 'trivia.reveal', data: { index: s.index, answer: q.answer, answered: s.answers.size } });
  ctx.fx({ kind: 'sfx', name: anyRight ? 'score' : 'lose' });
  if (anyRight) ctx.fx({ kind: 'particles', preset: 'sparkle', x: ctx.world.width / 2, y: ctx.world.height / 2 });
}

function useGenerated(ctx: BlockCtx<TriviaParams>, s: State, qs: TriviaQuestion[], source: 'ai' | 'fallback'): void {
  s.generated = qs;
  s.genId = undefined;
  ctx.emit({ type: 'trivia.generated', data: { source, count: qs.length } });
  nextQuestion(ctx, s);
}

function fallback(ctx: BlockCtx<TriviaParams>, s: State): void {
  if (s.genId) ctx.cancelJudgement(s.genId);
  useGenerated(ctx, s, shuffled(ctx as BlockCtx<unknown>, FALLBACK_QUESTIONS).slice(0, wanted(ctx)), 'fallback');
}

export const trivia: BlockDef<TriviaParams> = {
  id: 'trivia',
  name: 'Trivia',
  summary: 'Multiple-choice quiz on the phones: answer fast for bonus points. Questions are AI-written about the game (or the players).',
  paramsSchema: triviaSchema,
  defaults: {
    questions: [],
    secondsPerQuestion: 12,
    pointsFast: 3,
    pointsSlow: 1,
    aboutPlayers: false,
  },
  controls: ['vote'],
  arenaKinds: ['quiz'],

  setup(ctx) {
    const s = S(ctx);
    s.boardId = ctx.world.spawn('quiz', ctx.world.width / 2, ctx.world.height / 2, { sprite: 'quiz', r: 1, props: {} }).id;
    if (ctx.params.questions.length > 0) {
      nextQuestion(ctx, s);
    } else {
      const payload: TriviaGenPayload = {
        topic: ctx.spec.title,
        hook: ctx.spec.hook,
        ingredients: [...ctx.spec.origin.ingredients],
        players: ctx.players.map((p) => p.name),
        n: wanted(ctx),
        aboutPlayers: ctx.params.aboutPlayers,
        familySafe: true,
      };
      s.genId = ctx.requestJudgement('trivia-gen', payload);
      s.phase = 'thinking';
      s.phaseAt = ctx.time;
      ctx.fx({ kind: 'banner', text: 'Thinking…' });
    }
    publish(ctx, s);
  },

  onInput(ctx, playerId, input) {
    const s = S(ctx);
    const v = input.vote;
    if (s.phase !== 'question' || v === undefined || !Number.isInteger(v) || v < 0 || v > 3) return;
    if (s.answers.has(playerId)) return; // first answer locks
    const after = ctx.time - s.phaseAt;
    s.answers.set(playerId, { choice: v, fast: after <= ctx.params.secondsPerQuestion * FAST_FRAC, after });
    ctx.fx({ kind: 'sfx', name: 'tick' });
  },

  update(ctx) {
    const s = S(ctx);
    const P = ctx.params;
    // deadlines derive from phaseAt + current params, so live tweaks clamp at once
    if (s.phase === 'thinking') {
      if (P.questions.length > 0) {
        // the Tweak panel / remix filled the questions while we waited
        if (s.genId) ctx.cancelJudgement(s.genId);
        s.genId = undefined;
        nextQuestion(ctx, s);
      } else if (ctx.time >= s.phaseAt + GEN_TIMEOUT_SEC) {
        fallback(ctx, s);
      }
    } else if (s.phase === 'question') {
      const live = ctx.players.filter((p) => p.connected);
      const all = live.length > 0 && live.every((p) => s.answers.has(p.id));
      if (all || ctx.time >= s.phaseAt + P.secondsPerQuestion) reveal(ctx, s);
    } else if (s.phase === 'reveal') {
      if (ctx.time >= s.phaseAt + REVEAL_SEC) nextQuestion(ctx, s);
    }
    publish(ctx, s);
  },

  onJudgement(ctx, id, result) {
    const s = S(ctx);
    if (id !== s.genId || s.phase !== 'thinking') return;
    const qs: TriviaQuestion[] = [];
    if (Array.isArray(result)) {
      for (const r of result as unknown[]) {
        const p = triviaQuestionSchema.safeParse(r);
        if (p.success && qs.length < MAX_GEN * 2) qs.push(p.data);
      }
    }
    if (qs.length === 0) fallback(ctx, s);
    else useGenerated(ctx, s, qs, 'ai');
    publish(ctx, s);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    if (s.phase !== 'question' || !s.current || s.answers.has(playerId)) return { t: 0 };
    const sk = clamp(skill, 0, 1);
    let plan = s.bots.get(playerId);
    if (!plan || plan.seq !== s.qSeq) {
      const right = ctx.rng.next() < sk;
      const wrong = (s.current.answer + ctx.rng.int(1, 3)) % 4;
      const T = ctx.params.secondsPerQuestion;
      const delay = Math.min(T * 0.95, T * (0.12 + 0.55 * (1 - sk)) * ctx.rng.range(0.7, 1.3));
      plan = { seq: s.qSeq, at: s.phaseAt + delay, choice: right ? s.current.answer : wrong };
      s.bots.set(playerId, plan);
    }
    return ctx.time >= plan.at ? { t: 0, vote: plan.choice } : { t: 0 };
  },
};
