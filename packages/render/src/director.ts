/**
 * Juice rules (task F §3): particles only for meaningful moments, each with its own combo,
 * and never a storm. The director turns engine fx / game events into named combos, drops
 * near-duplicates (the same moment reported twice), rate-limits noisy kinds and caps how many
 * combos may start in a short window. Pure: no Pixi, no clock of its own (pass `now`, s).
 */

export type ComboKind = 'pickup' | 'bank' | 'steal' | 'hit' | 'wake' | 'dash' | 'golden' | 'splash' | 'win' | 'chase';

/** Engine particle preset -> combo during play. Confetti is end-of-round only. */
export function comboForPreset(preset: string): ComboKind | null {
  switch (preset) {
    case 'sparkle': return 'pickup';
    case 'confetti': return 'bank';
    case 'burst': return 'hit';
    case 'smoke': return 'dash';
    case 'splash': return 'splash';
    default: return null;
  }
}

/**
 * Game event -> combo. Headline events carry `data.moment` (see engine EVENTS.md; AI games use a
 * `play.` namespace), so match the moment first and fall back to the type's suffix.
 */
export function comboForEvent(type: string, moment?: string): ComboKind | null {
  const m = moment ?? (type.includes('.') ? type.slice(type.indexOf('.') + 1) : '');
  switch (m) {
    case 'bank': return 'bank';
    case 'steal': return 'steal';
    case 'golden': return 'golden';
    case 'caught':
    case 'knockout': return 'hit';
    case 'chase.start': return 'chase';
    case 'splash': return 'splash';
    case 'surge': return 'steal';
    default: return null;
  }
}

/** Minimum seconds between two combos of a kind (anywhere on screen). */
export const COMBO_GAP: Record<ComboKind, number> = {
  pickup: 0.06, bank: 0.2, steal: 0.25, hit: 0.15, wake: 0.8, dash: 0.3, golden: 0.5, splash: 0.4, win: 0, chase: 1,
};

/** Higher wins when the window is full. */
const PRIORITY: Record<ComboKind, number> = {
  win: 9, golden: 8, bank: 7, wake: 6, chase: 6, steal: 5, hit: 5, splash: 5, pickup: 3, dash: 1,
};

export interface DirectorOpts {
  /** Most combos started per window (default 5). */
  maxPerWindow?: number;
  windowSec?: number;
  /** Same kind closer than this (px) within `dedupeSec` is one moment (default 90 px, 0.18 s). */
  dedupePx?: number;
  dedupeSec?: number;
}

interface Started { kind: ComboKind; x: number; y: number; at: number }

export class FxDirector {
  private started: Started[] = [];
  private lastKind = new Map<ComboKind, number>();
  private readonly max: number;
  private readonly win: number;
  private readonly dpx: number;
  private readonly dsec: number;
  /** Combos refused (debug / tests). */
  dropped = 0;

  constructor(o: DirectorOpts = {}) {
    this.max = o.maxPerWindow ?? 5;
    this.win = o.windowSec ?? 0.6;
    this.dpx = o.dedupePx ?? 90;
    this.dsec = o.dedupeSec ?? 0.18;
  }

  /** May a `kind` combo start at (x, y) now? Records it when yes. */
  allow(kind: ComboKind, x: number, y: number, now: number): boolean {
    const s = this.started;
    // forget old starts (array stays tiny: <= max + a few)
    while (s.length > 0 && now - s[0]!.at > Math.max(this.win, this.dsec)) s.shift();
    for (const o of s) {
      if (o.kind === kind && now - o.at <= this.dsec && (o.x - x) ** 2 + (o.y - y) ** 2 <= this.dpx * this.dpx) {
        this.dropped++;
        return false;
      }
    }
    const last = this.lastKind.get(kind);
    if (last !== undefined && now - last < COMBO_GAP[kind]) {
      this.dropped++;
      return false;
    }
    let inWin = 0;
    let weakest: Started | undefined;
    for (const o of s) {
      if (now - o.at > this.win) continue;
      inWin++;
      if (!weakest || PRIORITY[o.kind] < PRIORITY[weakest.kind]) weakest = o;
    }
    if (inWin >= this.max && kind !== 'win' && (!weakest || PRIORITY[kind] <= PRIORITY[weakest.kind])) {
      this.dropped++;
      return false;
    }
    s.push({ kind, x, y, at: now });
    this.lastKind.set(kind, now);
    return true;
  }

  reset(): void {
    this.started.length = 0;
    this.lastKind.clear();
    this.dropped = 0;
  }
}
