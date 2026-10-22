/** Shared easing curves and a spring. Pure, allocation-free. All curves clamp t to [0, 1]. */

export const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

const BACK = 1.70158;

/** Overshoots ~10% past 1 then settles: pop-ins. */
export function easeOutBack(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  const k = x - 1;
  return 1 + k * k * ((BACK + 1) * k + BACK);
}

/** Dips below 0 first: wind-up before shrinking away. */
export function easeInBack(t: number): number {
  const x = clamp01(t);
  if (x === 1) return 1;
  return x * x * ((BACK + 1) * x - BACK);
}

/** Springy settle: big pops and punches. */
export function easeOutElastic(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}

export function easeInOutSine(t: number): number {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return -(Math.cos(Math.PI * x) - 1) / 2;
}

export function easeOutCubic(t: number): number {
  const k = 1 - clamp01(t);
  return 1 - k * k * k;
}

/** 0 -> 1 -> 0 bump over t in [0, 1] (sin arch). */
export function arch(t: number): number {
  return t <= 0 || t >= 1 ? 0 : Math.sin(t * Math.PI);
}

/** Damped spring state; mutate in place with springStep. */
export interface Spring {
  x: number;
  v: number;
}

const SPRING_SUB = 1 / 120;

/**
 * Advance a damped spring toward `target` (semi-implicit Euler, sub-stepped at 120 Hz so a
 * long frame cannot blow it up). Defaults are lightly under-damped: a visible wobble that
 * settles in ~0.6 s.
 */
export function springStep(s: Spring, target: number, dt: number, k = 260, damp = 13): void {
  let left = Math.min(dt, 0.25);
  while (left > 1e-9) {
    const h = left > SPRING_SUB ? SPRING_SUB : left;
    s.v += (-(s.x - target) * k - s.v * damp) * h;
    s.x += s.v * h;
    left -= h;
  }
}
