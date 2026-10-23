// Trophy toasts: small "Trophy unlocked" cards for fun firsts in a round, driven by engine events
// (EVENTS.md). Each trophy fires once per round; at most MAX_PER_ROUND, spaced TROPHY_GAP_SEC apart.
import type { MomentEvent } from './flow';

export type TrophyTier = 'bronze' | 'silver' | 'gold';

export interface Trophy {
  id: string;
  name: string;
  /** Who earned it ("Asha"), shown under the name. */
  who?: string;
  tier: TrophyTier;
}

export const MAX_PER_ROUND = 3;
export const TROPHY_GAP_SEC = 5;

interface Rule { id: string; name: string; tier: TrophyTier; match: (e: MomentEvent) => boolean; who?: (e: MomentEvent) => string | undefined }

const moment = (e: MomentEvent) => (typeof e.data?.moment === 'string' ? e.data.moment : '');

const RULES: Rule[] = [
  { id: 'ringout', name: 'First Ring Out', tier: 'bronze', match: (e) => moment(e) === 'ringout' },
  { id: 'overload', name: 'Too Hot to Hold', tier: 'bronze', match: (e) => moment(e) === 'overload' },
  { id: 'clutch', name: 'Clutch Pass', tier: 'silver', match: (e) => moment(e) === 'core.pass' && e.data?.clutch === true },
  { id: 'golden', name: 'Mega Core', tier: 'gold', match: (e) => moment(e) === 'golden' && e.data?.phase === 'grab' },
  { id: 'steal', name: 'Pickpocket', tier: 'bronze', match: (e) => moment(e) === 'steal' },
  { id: 'knockout', name: 'Knockout', tier: 'silver', match: (e) => moment(e) === 'knockout' },
  { id: 'finish', name: 'First Across the Line', tier: 'gold', match: (e) => e.type === 'race.finish' },
  { id: 'zapped', name: 'Zapped', tier: 'bronze', match: (e) => e.type === 'race.stumble' },
];

/** Per-round trophy watcher. */
export class TrophyWatch {
  private won = new Set<string>();
  private lastAt = -Infinity;

  /** The trophy this event unlocks (and records it), or undefined. `t` = sim seconds. */
  next(e: MomentEvent, t: number, name: (id?: string) => string): Trophy | undefined {
    if (this.won.size >= MAX_PER_ROUND || t - this.lastAt < TROPHY_GAP_SEC) return undefined;
    const r = RULES.find((x) => !this.won.has(x.id) && x.match(e));
    if (!r) return undefined;
    this.won.add(r.id);
    this.lastAt = t;
    return { id: r.id, name: r.name, tier: r.tier, ...(e.player ? { who: name(e.player) } : {}) };
  }
}
