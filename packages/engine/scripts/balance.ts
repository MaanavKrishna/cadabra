/**
 * Balance pass for the fallback games: many seeded headless rounds with 4 bots of mixed skill
 * (0.5..0.9), reporting how close and eventful they are.
 *
 *   npx tsx packages/engine/scripts/balance.ts [gameIdSubstring] [rounds=40]
 *
 * Per game: mean lead changes (raw and announced lead.change events), share of rounds with
 * >= 2 lead changes, final spread (1st - 2nd, 1st - last, as % of the winner's score),
 * winner skill rank, and mean counts of the headline events.
 */
import { FALLBACK_SPECS, type GameSpec } from '@cadabra/spec';
import { BlockRegistry, GameRuntime, Rng, STEPS_PER_SEC, makeBots, registerBuiltins } from '../src/index';

export interface RoundStats {
  leadChanges: number;
  leadEvents: number;
  /** Final scores (teams: the two team totals), high to low. */
  scores: number[];
  /** Skill rank of the winner (0 = best bot won). */
  winnerSkillRank: number;
  events: Record<string, number>;
}

const HEADLINE = /^(lead\.change|final\.start|[a-z]+\.(bank|steal|golden|chase\.start|caught|knockout|crumble|surge|splash|ringout|overload|core\.pass|core\.critical|tally|tally\.final)|race\.(finish|lapLead|stumble)|arena\.(fall|shove))$/;

export function playRound(spec: GameSpec, seed: number, seats = 4): RoundStats {
  const reg = new BlockRegistry();
  registerBuiltins(reg);
  const rng = new Rng(seed * 7919 + 13);
  const bots = makeBots(seats, rng);
  const skills = bots.map(() => 0.5 + 0.4 * rng.next());
  const rt = new GameRuntime(spec, bots, reg, seed);
  const max = spec.durationSec * STEPS_PER_SEC + STEPS_PER_SEC;
  for (let i = 0; i < max && rt.state !== 'over'; i++) {
    bots.forEach((b, k) => rt.input(b.id, rt.botInput(b.id, skills[k]!)));
    rt.step();
  }
  const res = rt.result();
  let scores: number[];
  let winnerIdx: number[];
  if (spec.teams === 2) {
    const t = [0, 0];
    for (const p of res.ranking) if (p.team !== undefined) t[p.team] = (t[p.team] ?? 0) + p.score;
    scores = [...t].sort((a, b) => b - a);
    const wt = t[0]! >= t[1]! ? 0 : 1;
    winnerIdx = bots.map((b, i) => (res.ranking.find((p) => p.id === b.id)?.team === wt ? i : -1)).filter((i) => i >= 0);
  } else {
    scores = res.ranking.map((p) => p.score);
    winnerIdx = [bots.findIndex((b) => b.id === res.ranking[0]!.id)];
  }
  const order = skills.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s).map((x) => x.i);
  const winnerSkillRank = Math.min(...winnerIdx.map((i) => order.indexOf(i)));
  const events: Record<string, number> = {};
  for (const e of rt.events) if (HEADLINE.test(e.type)) events[e.type] = (events[e.type] ?? 0) + 1;
  return { leadChanges: rt.leadChanges, leadEvents: events['lead.change'] ?? 0, scores, winnerSkillRank, events };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f1 = (x: number) => x.toFixed(1);

export function balance(spec: GameSpec, rounds: number, seats = 4): string {
  const rs = Array.from({ length: rounds }, (_, i) => playRound(spec, i + 1, seats));
  const lines: string[] = [];
  const top = rs.map((r) => r.scores[0]!);
  const gap12 = rs.map((r) => r.scores[0]! - r.scores[1]!);
  const gapAll = rs.map((r) => r.scores[0]! - r.scores[r.scores.length - 1]!);
  const pct = rs.map((r) => (r.scores[0]! > 0 ? (100 * (r.scores[0]! - r.scores[1]!)) / r.scores[0]! : 0));
  lines.push(`== ${spec.title} (${spec.id}) — ${rounds} rounds, ${seats} bots, skills 0.5–0.9`);
  lines.push(`lead changes: raw ${f1(mean(rs.map((r) => r.leadChanges)))} | announced ${f1(mean(rs.map((r) => r.leadEvents)))} | rounds with >=2 changes ${Math.round((100 * rs.filter((r) => r.leadChanges >= 2).length) / rounds)}%`);
  lines.push(`winner score ${f1(mean(top))} | 1st-2nd ${f1(mean(gap12))} (${f1(mean(pct))}% of winner) | 1st-last ${f1(mean(gapAll))} | photo finishes (<=10%) ${Math.round((100 * pct.filter((p) => p <= 10).length) / rounds)}%`);
  const wr = [0, 0, 0, 0];
  for (const r of rs) wr[r.winnerSkillRank] = (wr[r.winnerSkillRank] ?? 0) + 1;
  lines.push(`winner skill rank (0 = best bot): ${wr.map((n, i) => `${i}:${Math.round((100 * n) / rounds)}%`).join(' ')}`);
  const keys = [...new Set(rs.flatMap((r) => Object.keys(r.events)))].sort();
  lines.push(`events/round: ${keys.map((k) => `${k} ${f1(mean(rs.map((r) => r.events[k] ?? 0)))}`).join(', ')}`);
  return lines.join('\n');
}

const isMain = typeof process !== 'undefined' && process.argv[1]?.endsWith('balance.ts');
if (isMain) {
  const filter = process.argv[2] ?? '';
  const rounds = Number(process.argv[3] ?? 40);
  for (const spec of FALLBACK_SPECS) {
    if (filter && !spec.id.includes(filter)) continue;
    console.log(balance(spec, rounds));
    console.log('');
  }
}
