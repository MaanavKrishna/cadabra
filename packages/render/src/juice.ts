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

export type ParticleTex = 'dot' | 'glow' | 'spark' | 'confetti' | 'smoke' | 'drop' | 'star' | 'ring' | 'soft' | 'line';

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
  /** Point each particle along its flight direction (line streaks), no spin. */
  align?: boolean;
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
  // ---- event combos (director.ts): one distinct look per meaningful moment ----
  pickup: {
    count: 7, tex: ['spark', 'star'], speed: [80, 200], spread: Math.PI * 1.2, dir: -Math.PI / 2, life: [0.3, 0.55],
    scale: [0.35, 0.6], grow: -0.3, gravity: 120, drag: 2.5, spin: 6, colors: ['glow', 0xffffff], additive: true,
  },
  fountain: {
    count: 16, tex: ['dot', 'star', 'spark'], speed: [260, 520], spread: Math.PI * 0.45, dir: -Math.PI / 2, life: [0.55, 0.9],
    scale: [0.35, 0.7], grow: 0, gravity: 1100, drag: 0.6, spin: 8, colors: ['glow', 0xffe27a, 0xffffff], additive: true,
  },
  steal: {
    count: 10, tex: ['spark', 'dot'], speed: [200, 420], spread: Math.PI * 2, dir: 0, life: [0.25, 0.45],
    scale: [0.4, 0.8], grow: -0.2, gravity: 0, drag: 4, spin: 8, colors: ['accent', 0xffffff], additive: true,
  },
  hit: {
    count: 12, tex: ['star', 'spark', 'dot'], speed: [220, 480], spread: Math.PI * 2, dir: 0, life: [0.25, 0.5],
    scale: [0.45, 0.9], grow: 0, gravity: 300, drag: 3.5, spin: 9, colors: [0xff5a4a, 0xffffff, 0xffd166], additive: true,
  },
  dust: {
    count: 4, tex: ['smoke'], speed: [40, 110], spread: Math.PI * 0.8, dir: -Math.PI / 2, life: [0.35, 0.6],
    scale: [0.3, 0.45], grow: 1, gravity: -30, drag: 2, spin: 1, colors: [0xefe8dc], alpha: 0.5,
  },
  golden: {
    count: 20, tex: ['star', 'spark'], speed: [160, 440], spread: Math.PI * 2, dir: 0, life: [0.5, 0.9],
    scale: [0.5, 1], grow: -0.3, gravity: 80, drag: 2.2, spin: 7, colors: [0xffd23f, 0xfff1a8, 0xffffff], additive: true,
  },
  shock: {
    count: 8, tex: ['smoke'], speed: [140, 260], spread: Math.PI * 2, dir: 0, life: [0.4, 0.7],
    scale: [0.45, 0.7], grow: 1.2, gravity: 0, drag: 3, spin: 1, colors: [0xe8dccb], alpha: 0.55,
  },
  // ---- neon arcade (task N1): sparks and line bursts, all additive ----
  nspark: {
    count: 14, tex: ['spark', 'dot'], speed: [160, 520], spread: Math.PI * 2, dir: 0, life: [0.25, 0.55],
    scale: [0.25, 0.55], grow: -0.3, gravity: 0, drag: 3.5, spin: 8, colors: ['primary', 0xffffff, 'accent'], additive: true,
  },
  nlines: {
    count: 12, tex: ['line'], speed: [320, 760], spread: Math.PI * 2, dir: 0, life: [0.18, 0.38],
    scale: [0.5, 0.95], grow: -0.5, gravity: 0, drag: 4, spin: 0, colors: [0xffffff, 'primary', 'accent'], additive: true, align: true,
  },
  ngem: {
    count: 9, tex: ['line', 'spark'], speed: [180, 380], spread: Math.PI * 2, dir: 0, life: [0.2, 0.4],
    scale: [0.3, 0.55], grow: -0.4, gravity: 0, drag: 4, spin: 0, colors: ['glow', 0xffffff], additive: true, align: true,
  },
  nboom: {
    count: 22, tex: ['line', 'spark', 'dot'], speed: [380, 900], spread: Math.PI * 2, dir: 0, life: [0.25, 0.55],
    scale: [0.5, 1.1], grow: -0.4, gravity: 0, drag: 3.6, spin: 0, colors: [0xff3355, 0xffb020, 0xffffff], additive: true, align: true,
  },
  ngold: {
    count: 16, tex: ['spark', 'line'], speed: [200, 520], spread: Math.PI * 2, dir: 0, life: [0.35, 0.7],
    scale: [0.4, 0.8], grow: -0.3, gravity: 0, drag: 2.8, spin: 0, colors: [0xffb020, 0xffe08a, 0xffffff], additive: true, align: true,
  },
  confetti: {
    count: 36, tex: ['confetti'], speed: [220, 620], spread: Math.PI * 0.7, dir: -Math.PI / 2, life: [1.1, 2],
    scale: [0.5, 0.9], grow: 0, gravity: 520, drag: 1.6, spin: 10,
    colors: ['primary', 'accent', 'glow', 0x80ed99, 0xb388ff, 0xffffff],
  },
};
