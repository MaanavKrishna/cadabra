/**
 * Pure camera rig: a soft zoom (1.0–1.15) that frames all players, punches toward big moments,
 * a slow-mo close-up on the winner at the end, a tiny idle drift and a shake cap.
 * The zoom pivots about a focus point that always stays on screen, so a zoom-in never reveals
 * anything outside the baked background.
 */

/** Gameplay zoom ceiling (framing + punches). */
export const ZOOM_MAX = 1.15;
/** The end-of-round winner close-up may go further. */
export const SHOT_ZOOM = 1.4;
const FINALE_ZOOM = 1.04;
const ZOOM_RATE = 2.2;
const FOCUS_RATE = 2;
/** Framing keeps this margin (px) around the players' box. */
const FRAME_PAD = 220;
/** Framing alone never zooms past this. */
const FRAME_ZOOM = 1.08;

export class CameraRig {
  zoom = 1;
  /** Zoom focus in screen px (the point that stays put while zooming). */
  fx: number;
  fy: number;
  private finale = false;
  private tx: number;
  private ty: number;
  private frameZ = 0;
  private punchZ = 0;
  private punchLeft = 0;
  private shot = false;
  private shotZ = 0;

  constructor(private readonly W: number, private readonly H: number) {
    this.fx = this.tx = W / 2;
    this.fy = this.ty = H / 2;
  }

  /** Finale on/off, focused on (x, y) (screen px, e.g. the players' centroid). */
  setFinale(on: boolean, x: number, y: number): void {
    this.finale = on;
    if (on && this.punchLeft <= 0 && !this.shot) this.aim(x, y);
  }

  /**
   * Frame the players' bounding box (screen px at zoom 1): the zoom that fits it with a margin,
   * clamped to 1..ZOOM_MAX, centred on the box. Spread-out players = no zoom.
   */
  frame(x0: number, y0: number, x1: number, y1: number): void {
    if (this.shot) return;
    const bw = Math.max(1, x1 - x0 + FRAME_PAD * 2), bh = Math.max(1, y1 - y0 + FRAME_PAD * 2);
    const z = Math.min(this.W / bw, this.H / bh);
    // framing stays gentle (the themed frame should mostly stay in view); punches add the rest
    this.frameZ = Math.max(0, Math.min(FRAME_ZOOM, z) - 1);
    if (this.punchLeft <= 0) this.aim((x0 + x1) / 2, (y0 + y1) / 2);
  }

  /** A big moment: zoom in by `amount` (clamped) toward (x, y) for `sec`. */
  punch(amount: number, x: number, y: number, sec: number): void {
    if (this.shot) return;
    this.punchZ = Math.max(this.punchZ * (this.punchLeft > 0 ? 1 : 0), Math.min(ZOOM_MAX - 1, Math.max(0, amount)));
    this.punchLeft = Math.max(this.punchLeft, sec);
    this.aim(x, y);
  }

  /** End-of-round close-up on (x, y): eases in to SHOT_ZOOM and holds until `endShot()`. */
  closeUp(x: number, y: number, zoom = SHOT_ZOOM): void {
    this.shot = true;
    this.shotZ = Math.max(0, Math.min(SHOT_ZOOM, zoom) - 1);
    this.tx = Math.max(this.W * 0.2, Math.min(this.W * 0.8, x));
    this.ty = Math.max(this.H * 0.2, Math.min(this.H * 0.8, y));
  }

  endShot(): void {
    this.shot = false;
    this.shotZ = 0;
  }

  get inShot(): boolean {
    return this.shot;
  }

  private aim(x: number, y: number): void {
    this.tx = Math.max(this.W * 0.25, Math.min(this.W * 0.75, x));
    this.ty = Math.max(this.H * 0.25, Math.min(this.H * 0.75, y));
  }

  tick(dt: number): void {
    if (this.punchLeft > 0) this.punchLeft = Math.max(0, this.punchLeft - dt);
    let target: number;
    if (this.shot) target = 1 + this.shotZ;
    else {
      const want = Math.max(this.frameZ, this.finale ? FINALE_ZOOM - 1 : 0) + (this.punchLeft > 0 ? this.punchZ : 0);
      target = 1 + Math.min(ZOOM_MAX - 1, want);
    }
    const rate = this.shot ? 1.6 : ZOOM_RATE;
    this.zoom += (target - this.zoom) * (1 - Math.exp(-dt * rate));
    this.zoom = Math.max(1, Math.min(SHOT_ZOOM, this.zoom));
    const f = 1 - Math.exp(-dt * (this.shot ? 2.5 : FOCUS_RATE));
    this.fx += (this.tx - this.fx) * f;
    this.fy += (this.ty - this.fy) * f;
  }

  /** Slow idle drift (≤ 2 px), written into `out`. */
  drift(t: number, out: { x: number; y: number }): void {
    out.x = Math.sin(t * 0.37) * 0.9 + Math.sin(t * 0.61 + 1) * 0.5;
    out.y = Math.cos(t * 0.29) * 0.9 + Math.sin(t * 0.53 + 2) * 0.5;
  }
}

/** Clamp a shake offset's length to `max` px, keeping its direction. */
export function capShake(s: { x: number; y: number }, max: number): void {
  const l = Math.hypot(s.x, s.y);
  if (l > max) {
    s.x *= max / l;
    s.y *= max / l;
  }
}
