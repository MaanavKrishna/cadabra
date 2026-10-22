/**
 * Pure animation state for the renderer: character motion/pose, depth sort keys and the
 * hit-stop clock. No Pixi, no allocation per update: views keep one instance per entity.
 */
import { springStep, type Spring } from './ease';

export type Motion = 'idle' | 'moving' | 'dash' | 'stopped';

/** Walk starts above MOVE_ON px/s and ends below MOVE_OFF (hysteresis). */
export const MOVE_ON = 45;
export const MOVE_OFF = 20;
/** Faster than this reads as a dash even without the dashing prop (launched / bumped). */
export const DASH_ON = 700;
const DASH_OFF = 450;
/** How long 'stopped' (the skid/settle) lasts before 'idle'. */
export const STOP_HOLD = 0.25;
/** Pixels per footstep; the waddle phase advances π per stride. */
export const STRIDE = 34;
const TELEPORT = 240;
const Q_MAX = 0.22;
const DEG = Math.PI / 180;

export function nextMotion(prev: Motion, speed: number, dashing: boolean, inState: number): Motion {
  if (dashing || speed > DASH_ON) return 'dash';
  switch (prev) {
    case 'dash':
      return speed > DASH_OFF ? 'dash' : speed > MOVE_OFF ? 'moving' : 'stopped';
    case 'moving':
      return speed > MOVE_OFF ? 'moving' : 'stopped';
    case 'stopped':
      if (speed > MOVE_ON) return 'moving';
      return inState >= STOP_HOLD ? 'idle' : 'stopped';
    default:
      return speed > MOVE_ON ? 'moving' : 'idle';
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * One character's procedural animation, driven only by its drawn position over time.
 * `update` once per rendered frame (dt = visual dt; 0 while hit-stopped), then `pose` to
 * read the transform: sx/sy (multipliers), rot (rad), hop (px up), ox/oy (recoil px).
 */
export class AvatarAnim {
  motion: Motion = 'idle';
  /** Seconds in the current motion state. */
  inState = 0;
  vx = 0;
  vy = 0;
  speed = 0;
  /** 1 = facing right, -1 = left. */
  face = 1;
  /** Waddle phase (rad); advances with distance travelled, never with time. */
  walk = 0;
  /** True on the frame a footstep lands (dust puff). */
  footstep = false;
  /** True on the frame the character turned around. */
  flipped = false;
  /** 0..1 how much the walk cycle shows (eased from speed). */
  move = 0;

  // pose outputs
  sx = 1;
  sy = 1;
  rot = 0;
  hop = 0;
  ox = 0;
  oy = 0;
  flash = false;

  private x = 0;
  private y = 0;
  private started = false;
  private step = 0;
  private q: Spring = { x: 0, v: 0 };
  private cheerT = 9;
  private hitT = 9;
  private hx = 0;
  private hy = 0;
  private flashFrames = 0;
  private readonly seed: number;

  constructor(seed = 0) {
    this.seed = (seed * 1.618) % (Math.PI * 2);
  }

  /** Current squash/stretch amount (+ taller, - wider). */
  get squash(): number {
    return this.q.x;
  }

  reset(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.started = true;
    this.motion = 'idle';
    this.inState = 0;
    this.vx = this.vy = this.speed = 0;
    this.face = 1;
    this.walk = 0;
    this.step = 0;
    this.move = 0;
    this.q.x = this.q.v = 0;
    this.cheerT = this.hitT = 9;
    this.flashFrames = 0;
    this.footstep = this.flipped = false;
  }

  private kick(v: number): void {
    this.q.v += v;
  }

  /** Happy hop (scored). */
  cheer(): void {
    this.cheerT = 0;
    this.kick(-2.2);
  }

  /** Got hit from direction (dx, dy) (any length): recoil away + 2-frame white flash. */
  hit(dx: number, dy: number): void {
    const l = Math.hypot(dx, dy);
    this.hx = l > 1e-6 ? dx / l : -this.face;
    this.hy = l > 1e-6 ? dy / l : 0;
    this.hitT = 0;
    this.flashFrames = 2;
    this.kick(-3.2);
  }

  update(x: number, y: number, dt: number, time: number, dashing: boolean): void {
    this.footstep = false;
    this.flipped = false;
    if (!this.started) {
      this.reset(x, y);
      return;
    }
    if (dt <= 0) return; // frozen (hit-stop): nothing advances
    const dx = x - this.x, dy = y - this.y;
    this.x = x;
    this.y = y;
    const d = Math.hypot(dx, dy);
    if (d > TELEPORT) {
      // respawn / round change: no fake dash
      this.vx = this.vy = this.speed = 0;
      return;
    }
    const a = 1 - Math.exp(-dt * 18);
    const pvx = this.vx, pvy = this.vy;
    this.vx += (dx / dt - this.vx) * a;
    this.vy += (dy / dt - this.vy) * a;
    this.speed = Math.hypot(this.vx, this.vy);
    const accel = Math.hypot(this.vx - pvx, this.vy - pvy) / dt;

    this.inState += dt;
    const prev = this.motion;
    const m = nextMotion(prev, this.speed, dashing, this.inState);
    if (m !== prev) {
      this.motion = m;
      this.inState = 0;
      if (m === 'dash') this.kick(-4.5);
      else if (m === 'moving' && prev !== 'dash') this.kick(-2.2);
      else if (m === 'stopped') this.kick(-2.4);
    } else if (accel > 4000 && m !== 'dash') {
      // shoved (bumped) mid-walk
      this.kick(-Math.min(3, accel / 4000));
    }

    if (Math.abs(this.vx) > 30 && (this.vx > 0 ? 1 : -1) !== this.face) {
      this.face = this.vx > 0 ? 1 : -1;
      this.flipped = true;
      this.kick(-1.8);
    }

    this.walk += (d / STRIDE) * Math.PI;
    const step = Math.floor(this.walk / Math.PI);
    if (step !== this.step) {
      this.step = step;
      this.footstep = this.motion === 'moving' || this.motion === 'dash';
    }

    const wantMove = this.motion === 'moving' || this.motion === 'dash' ? Math.min(1, this.speed / 160) : 0;
    this.move += (wantMove - this.move) * (1 - Math.exp(-dt * 10));

    // stretch along the velocity at speed: wide when running sideways, tall when vertical
    const sp = Math.min(1, this.speed / 900);
    const target = this.speed > 1 ? 0.16 * sp * sp * ((Math.abs(this.vy) - Math.abs(this.vx)) / this.speed) : 0;
    springStep(this.q, target, dt);
    if (this.q.x > Q_MAX) {
      this.q.x = Q_MAX;
      if (this.q.v > 0) this.q.v = 0;
    } else if (this.q.x < -Q_MAX) {
      this.q.x = -Q_MAX;
      if (this.q.v < 0) this.q.v = 0;
    }
    this.cheerT += dt;
    this.hitT += dt;
  }

  /** Compute the transform for this frame (call after update). */
  pose(time: number): void {
    const still = 1 - this.move;
    const breath = Math.sin(time * (Math.PI * 2 * 0.6) + this.seed) * 0.03 * still;
    const sway = Math.sin(time * (Math.PI * 2 * 0.33) + this.seed) * 0.035 * still;
    const tilt = Math.sin(this.walk) * 6 * DEG * this.move;
    const lean = clamp(this.vx / 450, -1, 1) * 10 * DEG;
    const amp = 4 + 4 * Math.min(1, this.speed / 400);
    let hop = Math.abs(Math.sin(this.walk)) * amp * this.move;
    if (this.cheerT < 0.45) hop += Math.sin((this.cheerT / 0.45) * Math.PI) * 26;
    this.hop = hop;
    const q = this.q.x;
    this.sy = clamp((1 + q) * (1 + breath), 0.7, 1.3);
    this.sx = clamp((1 / (1 + q)) * (1 - breath * 0.5), 0.7, 1.3);
    this.rot = sway + tilt + lean;
    if (this.hitT < 0.28) {
      const k = 1 - this.hitT / 0.28;
      const r = k * k * 16;
      this.ox = this.hx * r;
      this.oy = this.hy * r;
      this.rot += this.hx * k * 0.35;
    } else this.ox = this.oy = 0;
    this.flash = this.flashFrames > 0;
    if (this.flash) this.flashFrames--;
  }
}

// ---------- depth ----------

const DEPTH_Q = 16;
const ID_MASK = 8191;

/** Draw-order comparator: lower y first (further back), ties broken by id. Stable for equal input. */
export function depthCompare(a: { y: number; id: number }, b: { y: number; id: number }): number {
  return Math.round(a.y * DEPTH_Q) - Math.round(b.y * DEPTH_Q) || (a.id & ID_MASK) - (b.id & ID_MASK);
}

/** Integer zIndex that sorts exactly like depthCompare (for sortableChildren). */
export function depthKey(y: number, id: number): number {
  return Math.round(y * DEPTH_Q) * (ID_MASK + 1) + (id & ID_MASK);
}

// ---------- hit-stop ----------

export const HITSTOP_MIN = 50;
export const HITSTOP_MAX = 80;

/** Render-freeze length for a shake of `strength` (0..1): big hits only. */
export function hitStopFor(strength: number): number {
  if (!(strength >= 0.4)) return 0;
  return Math.round(HITSTOP_MIN + ((HITSTOP_MAX - HITSTOP_MIN) * Math.min(1, (strength - 0.4) / 0.6)));
}

/** Milliseconds of render freeze left; ticked by the view in real (render) time. */
export class HitStop {
  ms = 0;

  trigger(ms: number): void {
    this.ms = Math.min(HITSTOP_MAX, Math.max(this.ms, ms));
  }

  tick(dtMs: number): void {
    this.ms = this.ms > dtMs ? this.ms - dtMs : 0;
  }
}

/**
 * The host-loop contract in one line: real frame dt (s) scaled by slow-mo goes into the
 * fixed-step accumulator, except while a hit-stop is running, when it is held. The sim
 * itself always steps by its fixed DT.
 */
export function advanceAccumulator(acc: number, dtSec: number, timeScale: number, hitStopMs: number): number {
  return hitStopMs > 0 ? acc : acc + dtSec * timeScale;
}
