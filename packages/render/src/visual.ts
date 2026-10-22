/** Pure visual-state helpers: entity props + sim time -> what to draw. No Pixi here. */

type Props = Record<string, number | string | boolean>;

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Beyond this jump (px) between snapshots an entity teleported: no lerp. */
export const TELEPORT_PX = 240;

export function lerpPos(a: { x: number; y: number }, b: { x: number; y: number }, t: number): { x: number; y: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx * dx + dy * dy > TELEPORT_PX * TELEPORT_PX) return { x: b.x, y: b.y };
  const k = clamp01(t);
  return { x: a.x + dx * k, y: a.y + dy * k };
}

export interface TelegraphState {
  armed: boolean;
  /** 0 when the warning appears, 1 when the hazard arms. */
  progress: number;
  /** Body alpha: translucent pulse while telegraphing, solid when armed. */
  alpha: number;
  /** Unit direction it will travel once armed, or null for stationary/homing hazards. */
  arrow: { dx: number; dy: number } | null;
}

/**
 * Dodge hazard telegraph from props (armed, armAt, warnMs, ax, ay). The pulse speeds up as
 * arming approaches, so the room reads "about to go" without any text.
 */
export function telegraphState(props: Props, time: number): TelegraphState {
  if (props.armed !== false) return { armed: true, progress: 1, alpha: 1, arrow: null };
  const warn = Math.max(0.05, num(props.warnMs, 700) / 1000);
  const armAt = num(props.armAt, time);
  const progress = clamp01(1 - (armAt - time) / warn);
  const freq = 3 + progress * 9; // Hz
  const pulse = 0.5 + 0.5 * Math.sin(time * freq * Math.PI * 2);
  const alpha = 0.3 + 0.2 * progress + 0.18 * pulse;
  const ax = num(props.ax), ay = num(props.ay);
  const l = Math.hypot(ax, ay);
  return { armed: false, progress, alpha, arrow: l > 1e-6 ? { dx: ax / l, dy: ay / l } : null };
}

export interface GuardVisual {
  awake: boolean;
  waking: boolean;
  noise: number;
  noiseColor: number;
  cone: { facing: number; half: number; range: number } | null;
}

/** Noise meter colour: calm green -> amber -> alarm red. */
export function noiseColor(n: number): number {
  const v = clamp01(n);
  if (v < 0.5) return lerpColor(0x5be37d, 0xffc94d, v / 0.5);
  return lerpColor(0xffc94d, 0xff3b3b, (v - 0.5) / 0.5);
}

function lerpColor(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t)) << s;
  return ch(16) | ch(8) | ch(0);
}

export function guardVisual(props: Props): GuardVisual {
  const noise = clamp01(num(props.noise));
  const cone = props.visionOn === true
    ? { facing: num(props.facing), half: (num(props.visionConeDeg, 70) / 2) * (Math.PI / 180), range: num(props.visionRange, 380) }
    : null;
  return { awake: props.awake === true, waking: props.waking === true, noise, noiseColor: noiseColor(noise), cone };
}

export interface AvatarFx {
  alpha: number;
  /** Rotation wobble (rad) while stunned. */
  wobble: number;
  stunned: boolean;
}

/** Invulnerable -> 12 Hz blink; stunned -> dizzy wobble. */
export function avatarFx(props: Props, time: number): AvatarFx {
  const stunned = time < num(props.stunUntil, -1);
  const inv = time < num(props.invulnUntil, -1);
  const alpha = inv ? (Math.floor(time * 12) % 2 === 0 ? 0.35 : 1) : 1;
  const wobble = stunned ? Math.sin(time * 18) * 0.22 : 0;
  return { alpha, wobble, stunned };
}

/** Tug rope pull position (-1..1) -> knot x between the two lines. */
export function ropeKnotX(props: Props, fallbackX: number): number {
  const l = num(props.lineLeft, NaN), r = num(props.lineRight, NaN);
  if (!Number.isFinite(l) || !Number.isFinite(r)) return fallbackX;
  return (l + r) / 2 + num(props.pos) * ((r - l) / 2);
}

/** Seconds left from an endsAt prop (quiz / board phases). */
export function secondsLeft(props: Props, time: number): number {
  return Math.max(0, num(props.endsAt, time) - time);
}

type Pt = { x: number; y: number };

/**
 * Holds the last two *distinct* simulation states. Hosts call snapshot() every display
 * frame and get a fresh object each time, so states are told apart by sim time, never by
 * object identity: frames without a sim step keep lerping between the same two states.
 */
export class SnapInterp {
  private prev = new Map<number, Pt>();
  private cur = new Map<number, Pt>();
  private curTime = NaN;

  /** Returns true when `snap` is a new sim state (time changed). */
  push(snap: { time: number; entities: readonly { id: number; x: number; y: number }[] }): boolean {
    if (snap.time === this.curTime) return false;
    // time went backwards: a new round, nothing to lerp from
    if (snap.time < this.curTime) this.cur.clear();
    const old = this.prev;
    this.prev = this.cur;
    this.cur = old;
    this.cur.clear();
    for (const e of snap.entities) this.cur.set(e.id, { x: e.x, y: e.y });
    this.curTime = snap.time;
    return true;
  }

  /** Drawn position of `e` (current state) at accumulator fraction `alpha`. */
  pos(e: { id: number; x: number; y: number }, alpha: number): Pt {
    const p0 = this.prev.get(e.id);
    return p0 ? lerpPos(p0, e, alpha) : e;
  }

  reset(): void {
    this.prev.clear();
    this.cur.clear();
    this.curTime = NaN;
  }
}
