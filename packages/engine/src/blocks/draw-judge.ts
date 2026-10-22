import { z } from 'zod';
import type { BlockCtx, BlockDef } from '../block';
import { clamp, stateOf } from './util';

export const drawJudgeSchema = z.object({
  prompt: z.string().min(1).max(80).describe("What everyone draws (the AI fills it from the game's ingredients)."),
  drawSec: z.number().min(10).max(120).describe('Seconds to draw each round.'),
  rounds: z.number().int().min(1).max(5).describe('Number of draw-and-judge rounds.'),
  judgeStyle: z.enum(['kind', 'savage', 'absurd']).describe("Voice of the AI judge's roasts."),
});
export type DrawJudgeParams = z.infer<typeof drawJudgeSchema>;

/** One judged drawing, as the host resolves a 'draw' judgement. */
export interface DrawVerdict {
  playerId: string;
  /** 0..10 (clamped and rounded by the block). */
  score: number;
  roast: string;
}

/** Payload of a 'draw' judgement. */
export interface DrawJudgementPayload {
  round: number;
  prompt: string;
  judgeStyle: DrawJudgeParams['judgeStyle'];
  /** `bot` entries are bot scribbles: the backend scores them locally instead of calling the AI. */
  entries: { playerId: string; name: string; image: string; bot: boolean }[];
}

type Phase = 'drawing' | 'judging' | 'reveal' | 'done';

interface State {
  phase: Phase;
  round: number;
  phaseAt: number;
  subs: Map<string, string>;
  judgeId?: string;
  boardId?: number;
  lastWinner: string;
  botAt: Map<string, { round: number; at: number }>;
}

const states = new WeakMap<object, State>();
const S = (ctx: object) =>
  stateOf<State>(states, ctx, () => ({ phase: 'drawing', round: 1, phaseAt: 0, subs: new Map(), lastWinner: '', botAt: new Map() }));

/** Sim seconds a round waits for the AI judge before scoring everyone equally. */
export const JUDGE_TIMEOUT_SEC = 8;
/** Points each submitted drawing gets when the judge times out (or answers nonsense). */
export const TIMEOUT_SCORE = 5;
const REVEAL_SEC = 4;
const MAX_IMAGE_CHARS = 2_000_000;
const MAX_ROAST = 160;
/** What bots "draw": a 1×1 transparent PNG. */
export const BOT_DRAWING =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function publish(ctx: BlockCtx<DrawJudgeParams>, s: State): void {
  const b = s.boardId !== undefined ? ctx.world.get(s.boardId) : undefined;
  if (!b) return;
  const P = ctx.params;
  b.props.phase = s.phase;
  b.props.round = s.round;
  b.props.rounds = P.rounds;
  b.props.prompt = P.prompt;
  b.props.judgeStyle = P.judgeStyle;
  b.props.submitted = s.subs.size;
  b.props.players = ctx.players.filter((p) => p.connected).length;
  b.props.thinking = s.phase === 'judging';
  b.props.banner = s.phase === 'judging' ? 'Judging…' : '';
  const ends =
    s.phase === 'drawing' ? s.phaseAt + P.drawSec
      : s.phase === 'judging' ? s.phaseAt + JUDGE_TIMEOUT_SEC
        : s.phase === 'reveal' ? s.phaseAt + REVEAL_SEC : ctx.time;
  b.props.endsAt = ends;
  b.props.lastWinner = s.lastWinner;
}

function startRound(ctx: BlockCtx<DrawJudgeParams>, s: State, round: number): void {
  s.phase = 'drawing';
  s.round = round;
  s.phaseAt = ctx.time;
  s.subs = new Map();
  s.judgeId = undefined;
  ctx.emit({ type: 'draw.round', data: { round, prompt: ctx.params.prompt } });
  ctx.fx({ kind: 'banner', text: `Draw: ${ctx.params.prompt}` });
  ctx.fx({ kind: 'sfx', name: 'whoosh' });
}

function toReveal(ctx: BlockCtx<DrawJudgeParams>, s: State): void {
  s.phase = 'reveal';
  s.phaseAt = ctx.time;
  s.judgeId = undefined;
}

function endDrawing(ctx: BlockCtx<DrawJudgeParams>, s: State): void {
  const P = ctx.params;
  ctx.emit({ type: 'draw.submitted', data: { round: s.round, count: s.subs.size } });
  if (s.subs.size === 0) {
    toReveal(ctx, s);
    return;
  }
  const entries: DrawJudgementPayload['entries'] = [];
  for (const p of ctx.players) {
    const image = s.subs.get(p.id);
    if (image !== undefined) entries.push({ playerId: p.id, name: p.name, image, bot: p.isBot });
  }
  const payload: DrawJudgementPayload = { round: s.round, prompt: P.prompt, judgeStyle: P.judgeStyle, entries };
  s.judgeId = ctx.requestJudgement('draw', payload);
  s.phase = 'judging';
  s.phaseAt = ctx.time;
  ctx.fx({ kind: 'sfx', name: 'tick' });
}

function award(ctx: BlockCtx<DrawJudgeParams>, s: State, scores: Map<string, { score: number; roast: string }>): void {
  let best = -1, winner = '';
  for (const p of ctx.players) {
    const v = scores.get(p.id);
    if (!v) continue;
    ctx.score(p.id, v.score, 'draw.judged');
    ctx.emit({ type: 'draw.judged', player: p.id, data: { round: s.round, score: v.score, roast: v.roast } });
    if (v.score > best) { best = v.score; winner = p.id; }
  }
  if (winner) {
    s.lastWinner = winner;
    ctx.emit({ type: 'draw.winner', player: winner, data: { round: s.round, score: best } });
    ctx.fx({ kind: 'particles', preset: 'confetti', x: ctx.world.width / 2, y: ctx.world.height / 2 });
    ctx.fx({ kind: 'sfx', name: 'win' });
  }
}

function timeout(ctx: BlockCtx<DrawJudgeParams>, s: State, reason: 'timeout' | 'invalid'): void {
  if (s.judgeId) ctx.cancelJudgement(s.judgeId);
  const ids: string[] = [];
  for (const p of ctx.players) {
    if (!s.subs.has(p.id)) continue;
    ids.push(p.id);
    ctx.score(p.id, TIMEOUT_SCORE, 'draw.timeout');
  }
  ctx.emit({
    type: 'draw.timeout',
    data: { round: s.round, reason, score: TIMEOUT_SCORE, players: ids, line: `The judge is speechless. ${TIMEOUT_SCORE} points each!` },
  });
  ctx.fx({ kind: 'banner', text: `The judge is speechless. ${TIMEOUT_SCORE} points each!` });
  ctx.fx({ kind: 'sfx', name: 'score' });
  toReveal(ctx, s);
}

export const drawJudge: BlockDef<DrawJudgeParams> = {
  id: 'draw-judge',
  name: 'Draw & Judge',
  summary: 'Everyone draws the prompt on their phone; an AI judge scores each drawing 0–10 with a roast.',
  paramsSchema: drawJudgeSchema,
  defaults: {
    prompt: 'A cat who just became king',
    drawSec: 30,
    rounds: 2,
    judgeStyle: 'kind',
  },
  controls: ['draw'],
  arenaKinds: ['canvas'],

  setup(ctx) {
    const s = S(ctx);
    s.boardId = ctx.world.spawn('board', ctx.world.width / 2, ctx.world.height / 2, { sprite: 'board', r: 1, props: {} }).id;
    startRound(ctx, s, 1);
    publish(ctx, s);
  },

  onInput(ctx, playerId, input) {
    const s = S(ctx);
    const img = input.draw;
    if (s.phase !== 'drawing' || typeof img !== 'string') return;
    if (!img.startsWith('data:image/') || img.length > MAX_IMAGE_CHARS) return;
    const first = !s.subs.has(playerId);
    s.subs.set(playerId, img); // re-submits replace the drawing until time is up
    if (first) {
      ctx.emit({ type: 'draw.submit', player: playerId, data: { round: s.round } });
      ctx.fx({ kind: 'sfx', name: 'pass' });
    }
  },

  update(ctx) {
    const s = S(ctx);
    const P = ctx.params;
    // all deadlines derive from phaseAt + current params: live tweaks clamp at once
    if (s.phase === 'drawing') {
      const live = ctx.players.filter((p) => p.connected);
      const all = live.length > 0 && live.every((p) => s.subs.has(p.id));
      if (all || ctx.time >= s.phaseAt + P.drawSec) endDrawing(ctx, s);
    } else if (s.phase === 'judging') {
      if (ctx.time >= s.phaseAt + JUDGE_TIMEOUT_SEC) timeout(ctx, s, 'timeout');
    } else if (s.phase === 'reveal') {
      if (ctx.time >= s.phaseAt + REVEAL_SEC) {
        if (s.round < P.rounds) {
          startRound(ctx, s, s.round + 1);
        } else {
          s.phase = 'done';
          s.phaseAt = ctx.time;
          ctx.emit({ type: 'draw.done', data: { rounds: s.round } });
        }
      }
    } else if (s.round < P.rounds) {
      // rounds raised live after the last one: keep going
      startRound(ctx, s, s.round + 1);
    }
    publish(ctx, s);
  },

  onJudgement(ctx, id, result) {
    const s = S(ctx);
    if (id !== s.judgeId || s.phase !== 'judging') return;
    if (!Array.isArray(result)) {
      timeout(ctx, s, 'invalid');
      return;
    }
    const scores = new Map<string, { score: number; roast: string }>();
    for (const r of result as unknown[]) {
      if (!r || typeof r !== 'object') continue;
      const { playerId, score, roast } = r as Partial<DrawVerdict>;
      if (typeof playerId !== 'string' || !s.subs.has(playerId) || scores.has(playerId)) continue;
      if (typeof score !== 'number' || !Number.isFinite(score)) continue;
      scores.set(playerId, {
        score: Math.round(clamp(score, 0, 10)),
        roast: typeof roast === 'string' ? roast.trim().slice(0, MAX_ROAST) : '',
      });
    }
    if (scores.size === 0) {
      timeout(ctx, s, 'invalid');
      return;
    }
    // a drawing the judge skipped still gets the neutral score
    for (const pid of s.subs.keys()) if (!scores.has(pid)) scores.set(pid, { score: TIMEOUT_SCORE, roast: '' });
    award(ctx, s, scores);
    toReveal(ctx, s);
    publish(ctx, s);
  },

  bot(ctx, playerId, skill) {
    const s = S(ctx);
    if (s.phase !== 'drawing' || s.subs.has(playerId)) return { t: 0 };
    let plan = s.botAt.get(playerId);
    if (!plan || plan.round !== s.round) {
      // keener bots take their time; everyone submits well before the bell
      const frac = 0.25 + 0.45 * clamp(skill, 0, 1) * ctx.rng.range(0.6, 1);
      plan = { round: s.round, at: s.phaseAt + ctx.params.drawSec * frac };
      s.botAt.set(playerId, plan);
    }
    return ctx.time >= plan.at ? { t: 0, draw: BOT_DRAWING } : { t: 0 };
  },
};
