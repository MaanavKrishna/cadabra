/** Pure camera rig: eased zoom toward the action, tiny idle drift, shake cap. */

export const ZOOM_MAX = 1.06;
const FINALE_ZOOM = 1.035;
const ZOOM_RATE = 3;
const FOCUS_RATE = 2.5;

export class CameraRig {
  zoom = 1;
  /** Zoom focus in screen px (the point that stays put while zooming). */
  fx: number;
  fy: number;
  private finale = false;
  private tx: number;
  private ty: number;
  private punchZ = 0;
  private punchLeft = 0;

  constructor(private readonly W: number, private readonly H: number) {
    this.fx = this.tx = W / 2;
    this.fy = this.ty = H / 2;
  }

  /** Finale on/off, focused on (x, y) (screen px, e.g. the players' centroid). */
  setFinale(on: boolean, x: number, y: number): void {
    this.finale = on;
    if (on && this.punchLeft <= 0) this.aim(x, y);
  }

  /** A big moment: zoom in by `amount` (clamped) toward (x, y) for `sec`. */
  punch(amount: number, x: number, y: number, sec: number): void {
    this.punchZ = Math.max(this.punchZ * (this.punchLeft > 0 ? 1 : 0), Math.min(ZOOM_MAX - 1, Math.max(0, amount)));
    this.punchLeft = Math.max(this.punchLeft, sec);
    this.aim(x, y);
  }

  private aim(x: number, y: number): void {
    // keep the focus off the edges so a zoom never reveals the backdrop's border
    this.tx = Math.max(this.W * 0.25, Math.min(this.W * 0.75, x));
    this.ty = Math.max(this.H * 0.25, Math.min(this.H * 0.75, y));
  }

  tick(dt: number): void {
    if (this.punchLeft > 0) this.punchLeft = Math.max(0, this.punchLeft - dt);
    const want = Math.max(this.finale ? FINALE_ZOOM - 1 : 0, this.punchLeft > 0 ? this.punchZ : 0);
    const target = 1 + Math.min(ZOOM_MAX - 1, want);
    this.zoom += (target - this.zoom) * (1 - Math.exp(-dt * ZOOM_RATE));
    this.zoom = Math.max(1, Math.min(ZOOM_MAX, this.zoom));
    const f = 1 - Math.exp(-dt * FOCUS_RATE);
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
