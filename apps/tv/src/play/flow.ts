// Match flow (task F §1), as pure functions of wall time + runtime state, shared by every game:
// intro card (>= 3 s, also covers loading) -> 3-2-1-GO -> play -> FINAL 10 -> TIME! freeze ->
// slow-mo winner shot -> podium. The Play screen samples this every frame and reacts to changes.

export const INTRO_MS = 3000;
export const COUNT_MS = 3000;
/** "GO!" stays on screen this long after play starts. */
export const GO_MS = 800;
/** TIME!: the picture holds, then the winner shot. */
export const TIME_MS = 1000;
export const WINNER_MS = 2800;
export const FINAL_SEC = 10;
/** At most one lead-change banner per this many seconds. */
export const LEAD_GAP_SEC = 6;

/** Matches the neon team colours (render TEAM_COLORS: cyan 0, magenta 1). */
export const TEAM_NAME = ['Cyan', 'Magenta'] as const;

export type FlowPhase = 'intro' | 'countdown' | 'play' | 'final' | 'time' | 'winner' | 'done';

export interface FlowClock {
  /** When the Play screen mounted (ms). */
  mountAt: number;
  /** When the theme / art finished loading (ms); undefined while loading. */
  loadedAt?: number;
  /** When the runtime reported 'over' (ms). */
  overAt?: number;
}

export interface Flow {
  phase: FlowPhase;
  /** Countdown digit (3, 2, 1) or 'GO' while it shows; undefined otherwise. */
  count?: 3 | 2 | 1 | 'GO';
  /** The simulation may step. */
  running: boolean;
  /** ms into the current phase. */
  t: number;
}

/** When the countdown starts: the intro has shown for INTRO_MS and the art is loaded. */
export function countdownAt(c: FlowClock): number | undefined {
  return c.loadedAt === undefined ? undefined : Math.max(c.mountAt + INTRO_MS, c.loadedAt);
}

/** When play starts (GO!). */
export function playAt(c: FlowClock): number | undefined {
  const cd = countdownAt(c);
  return cd === undefined ? undefined : cd + COUNT_MS;
}

/** The flow at `now` (ms). `remaining`: runtime seconds left. */
export function flowAt(c: FlowClock, now: number, remaining: number): Flow {
  if (c.overAt !== undefined) {
    const t = now - c.overAt;
    if (t < TIME_MS) return { phase: 'time', running: false, t };
    if (t < TIME_MS + WINNER_MS) return { phase: 'winner', running: false, t: t - TIME_MS };
    return { phase: 'done', running: false, t: t - TIME_MS - WINNER_MS };
  }
  const cd = countdownAt(c);
  if (cd === undefined || now < cd) return { phase: 'intro', running: false, t: now - c.mountAt };
  const go = cd + COUNT_MS;
  if (now < go) {
    const t = now - cd;
    return { phase: 'countdown', count: (3 - Math.floor(t / 1000)) as 3 | 2 | 1, running: false, t };
  }
  const t = now - go;
  const f: Flow = { phase: remaining > 0 && remaining <= FINAL_SEC ? 'final' : 'play', running: true, t };
  if (t < GO_MS) f.count = 'GO';
  return f;
}

/**
 * Lead-change announcer: who to call out ("X TAKES THE LEAD!"), throttled to one per
 * LEAD_GAP_SEC of sim time. Prefer the engine's own `lead.change` events (feed them with
 * `fromEvent`); `fromScores` is the fallback for engines without them.
 */
export class LeadWatch {
  private announced?: string;
  private lastAt = -Infinity;
  private engineEvents = false;

  /** A runtime `lead.change` event (already throttled by the engine). */
  fromEvent(player: string | undefined, team: number | undefined): { player?: string; team?: number } | undefined {
    this.engineEvents = true;
    if (team === 0 || team === 1) return { team };
    return player ? { player } : undefined;
  }

  /** Scores fallback: the unique leader, when it changed and the gap allows. */
  fromScores(scores: readonly { id: string; score: number }[], t: number): string | undefined {
    if (this.engineEvents) return undefined;
    let best: { id: string; score: number } | undefined, tie = false;
    for (const s of scores) {
      if (!best || s.score > best.score) {
        best = s;
        tie = false;
      } else if (s.score === best.score) tie = true;
    }
    if (!best || tie || best.score <= 0 || best.id === this.announced) return undefined;
    if (t - this.lastAt < LEAD_GAP_SEC) return undefined;
    this.announced = best.id;
    this.lastAt = t;
    return best.id;
  }
}

/** The headline-moment slice of an engine GameEvent. */
export interface MomentEvent {
  type: string;
  player?: string;
  data?: Record<string, unknown>;
}

/** Banner text for a headline engine event (EVENTS.md `data.moment`); undefined = popup/sfx only. */
export function momentCallout(e: MomentEvent, name: (id?: string) => string, noun: string): { title: string; sub?: string } | undefined {
  const m = typeof e.data?.moment === 'string' ? e.data.moment : undefined;
  const who = name(e.player);
  switch (m) {
    case 'chase.start': return { title: `RUN, ${who}!`, sub: 'It’s awake and coming for you' };
    case 'caught': return { title: 'CAUGHT!', sub: `${who} dropped the loot` };
    case 'golden':
      if (e.data?.phase === 'spawn') return { title: `GOLDEN ${noun}!`, sub: 'Worth a fortune. Go!' };
      if (e.data?.phase === 'grab') return { title: `${who} GOT THE GOLD!`, sub: 'Bump them to steal it' };
      return undefined;
    case 'knockout': return { title: 'KNOCKOUT!', sub: `${who} shoved ${name(typeof e.data?.victim === 'string' ? e.data.victim : undefined)} in` };
    case 'splash': {
      const w = e.data?.winners;
      return { title: 'SPLASH!', sub: w === 0 || w === 1 ? `${TEAM_NAME[w]} team pulls them in!` : 'Into the mud!' };
    }
    default: return undefined;
  }
}
