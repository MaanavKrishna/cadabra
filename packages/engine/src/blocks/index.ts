import type { BlockDef } from '../block';
import type { BlockRegistry } from '../registry';
import { arenaMove } from './arena-move';
import { ballSport } from './ball-sport';
import { collect } from './collect';
import { dodge } from './dodge';
import { drawJudge } from './draw-judge';
import { race } from './race';
import { sneak } from './sneak';
import { trivia } from './trivia';
import { tug } from './tug';

export { arenaMove } from './arena-move';
export { ballSport, type BallSportParams } from './ball-sport';
export { collect } from './collect';
export { dodge } from './dodge';
export { race } from './race';
export { sneak } from './sneak';
export { tug } from './tug';
export { drawJudge, BOT_DRAWING, JUDGE_TIMEOUT_SEC, TIMEOUT_SCORE, type DrawVerdict, type DrawJudgementPayload } from './draw-judge';
export { trivia, FALLBACK_QUESTIONS, GEN_TIMEOUT_SEC, type TriviaQuestion, type TriviaGenPayload } from './trivia';

/** Every built-in block, in registration order. */
export const BUILTIN_BLOCKS: BlockDef[] = [arenaMove, collect, dodge, race, sneak, tug, drawJudge, trivia, ballSport] as BlockDef[];

export function registerBuiltins(registry: BlockRegistry): void {
  for (const def of BUILTIN_BLOCKS) registry.register(def);
}
