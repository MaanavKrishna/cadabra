import type { FxEvent } from '@cadabra/engine';
import { hexToNum } from './theme';

/** Default particle cap (measured on the Fire TV Stick HD: 300 particles ~59 fps). */
export const MAX_PARTICLES = 250;
const SLOW_FPS = 45;
const SLOW_SEC = 2;
const RECOVER_FPS = 56;
const RECOVER_SEC = 6;
const MIN_CAP = 30;

/**
 * Particle allowance. `request(n)` grants up to the free share of the current cap; spent
 * particles are handed back with `release`. Feed it the frame rate every frame: 2 s in a
 * row below 45 fps halves the cap (repeatedly, down to a floor); 6 s of smooth frames
 * doubles it back towards the maximum.
 */
export class FxBudget {
  readonly max: number;
  private _cap: number;
  private _active = 0;
  private slow = 0;
  private smooth = 0;

  constructor(maxParticles: number) {
    this.max = Math.max(0, Math.floor(maxParticles));
    this._cap = this.max;
  }

  get cap(): number {
    return this._cap;
  }

  get active(): number {
    return this._active;
  }

  request(n: number): number {
    const g = Math.max(0, Math.min(Math.floor(n), this._cap - this._active));
    this._active += g;
    return g;
  }

  release(n: number): void {
    this._active = Math.max(0, this._active - Math.max(0, Math.floor(n)));
  }

  /** One sample per rendered frame; `dtSec` defaults to the frame time implied by `fps`. */
  fpsFeedback(fps: number, dtSec = fps > 0 ? 1 / fps : 0.1): void {
    if (fps < SLOW_FPS) {
      this.smooth = 0;
      this.slow += dtSec;
      if (this.slow >= SLOW_SEC - 1e-6) {
        this.slow = 0;
        this._cap = Math.max(Math.min(MIN_CAP, this.max), Math.floor(this._cap / 2));
      }
    } else {
      this.slow = 0;
      if (fps >= RECOVER_FPS && this._cap < this.max) {
        this.smooth += dtSec;
        if (this.smooth >= RECOVER_SEC) {
          this.smooth = 0;
          this._cap = Math.min(this.max, this._cap * 2);
        }
      } else this.smooth = 0;
    }
  }

  /** True while degraded: the view also drops optional eye candy (ambient motes, trails). */
  get degraded(): boolean {
    return this._cap < this.max;
  }
}

/** Screen shake, flash and slow-mo as pure state, ticked in real seconds. */
export class JuiceState {
  /** 0..1; shake amplitude grows with trauma². */
  trauma = 0;
  flashAlpha = 0;
  flashColor = 0xffffff;
  private slowLeft = 0;
  private _timeScale = 1;
  private seed = 1;

  /** Applies shake / flash / slowmo; returns false for events it does not own. */
  apply(e: FxEvent): boolean {
    switch (e.kind) {
      case 'shake':
        this.trauma = Math.min(1, this.trauma + Math.max(0, Math.min(1, e.strength)));
        return true;
      case 'flash':
        this.flashColor = hexToNum(e.color);
        this.flashAlpha = 0.55;
        return true;
      case 'slowmo':
        this.slowLeft = Math.max(this.slowLeft, Math.min(3, e.ms / 1000));
        this._timeScale = SLOWMO_SCALE;
        return true;
      default:
        return false;
    }
  }

  /**
   * Render-time scale. The host loop multiplies its frame dt by this before feeding the
   * fixed-step accumulator, so the simulation stays fixed-step and only the pace of
   * interpolation (and juice) slows down.
   */
  get timeScale(): number {
    return this._timeScale;
  }

  tick(dt: number): void {
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    this.flashAlpha = Math.max(0, this.flashAlpha - dt * 2.2);
    if (this.slowLeft > 0) {
      this.slowLeft = Math.max(0, this.slowLeft - dt);
      this._timeScale = SLOWMO_SCALE;
    } else if (this._timeScale < 1) {
      // ease back out of slow-mo over ~0.3 s
      this._timeScale = Math.min(1, this._timeScale + dt * 2.5);
    }
  }

  /** Pixel offset (and tiny roll) for the shaken stage; pass `out` to avoid allocating. */
  shakeOffset(t: number, out: { x: number; y: number; rot: number } = { x: 0, y: 0, rot: 0 }): { x: number; y: number; rot: number } {
    const k = this.trauma * this.trauma;
    if (k === 0) {
      out.x = out.y = out.rot = 0;
      return out;
    }
    // cheap smooth noise from incommensurate sines
    const s = this.seed;
    const n1 = Math.sin(t * 47 + s) * 0.6 + Math.sin(t * 83 + s * 2) * 0.4;
    const n2 = Math.sin(t * 53 + s * 3) * 0.6 + Math.sin(t * 97 + s * 5) * 0.4;
    const n3 = Math.sin(t * 61 + s * 7);
    out.x = (n1 || 0.5) * 18 * k;
    out.y = (n2 || 0.5) * 14 * k;
    out.rot = n3 * 0.012 * k;
    return out;
  }
}

export const SLOWMO_SCALE = 0.3;

export type ParticleTex = 'dot' | 'glow' | 'spark' | 'confetti' | 'smoke' | 'drop' | 'star' | 'ring' | 'soft';

export interface ParticlePreset {
  count: number;
  tex: ParticleTex[];
  /** Initial speed range, px/s. */
  speed: [number, number];
  /** Emission cone around `dir` (rad); 2π = all round. */
  spread: number;
  dir: number;
  life: [number, number];
  scale: [number, number];
  /** Scale multiplier at end of life. */
  grow: number;
  gravity: number;
  drag: number;
  spin: number;
  /** 'palette' tints from the theme; numbers are fixed tints. */
  colors: (number | 'primary' | 'accent' | 'glow' | 'text')[];
  additive?: boolean;
  /** Start alpha (default 1). */
  alpha?: number;
}

export const PARTICLE_PRESETS: Record<string, ParticlePreset> = {
  sparkle: {
    count: 14, tex: ['spark', 'glow', 'star'], speed: [60, 220], spread: Math.PI * 2, dir: 0, life: [0.35, 0.8],
    scale: [0.35, 0.8], grow: 0, gravity: -40, drag: 2.5, spin: 6, colors: ['glow', 0xffffff, 'primary'], additive: true,
  },
  burst: {
    count: 22, tex: ['dot', 'spark', 'ring'], speed: [180, 520], spread: Math.PI * 2, dir: 0, life: [0.25, 0.6],
    scale: [0.4, 1], grow: 0.2, gravity: 200, drag: 3.5, spin: 4, colors: ['accent', 0xffffff, 'glow'], additive: true,
  },
  smoke: {
    count: 8, tex: ['smoke'], speed: [30, 110], spread: Math.PI * 2, dir: 0, life: [0.5, 1],
    scale: [0.45, 0.75], grow: 1.4, gravity: -50, drag: 1.8, spin: 1, colors: [0xd8d8e8, 0xb0b0c8], alpha: 0.5,
  },
  splash: {
    count: 18, tex: ['drop', 'dot'], speed: [140, 380], spread: Math.PI * 0.9, dir: -Math.PI / 2, life: [0.4, 0.8],
    scale: [0.4, 0.9], grow: -0.4, gravity: 900, drag: 0.8, spin: 0, colors: [0x7fd8ff, 0xffffff, 'primary'],
  },
  confetti: {
    count: 36, tex: ['confetti'], speed: [220, 620], spread: Math.PI * 0.7, dir: -Math.PI / 2, life: [1.1, 2],
    scale: [0.5, 0.9], grow: 0, gravity: 520, drag: 1.6, spin: 10,
    colors: ['primary', 'accent', 'glow', 0x80ed99, 0xb388ff, 0xffffff],
  },
};
