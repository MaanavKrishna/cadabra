import { describe, expect, test } from 'vitest';
import { AvatarAnim, HitStop, advanceAccumulator, depthCompare, depthKey, hitStopFor, nextMotion, type Motion } from '../src/anim';
import { CameraRig, ZOOM_MAX, capShake } from '../src/camera';
import { easeInOutSine, easeOutBack, easeOutElastic, springStep, type Spring } from '../src/ease';

const DT = 1 / 60;

/** Feeds an anim `sec` seconds of motion at (vx, vy) px/s from its current position. */
function drive(a: AvatarAnim, pos: { x: number; y: number; t: number }, vx: number, vy: number, sec: number, dashing = false): Motion[] {
  const seen: Motion[] = [];
  for (let i = 0; i < Math.round(sec / DT); i++) {
    pos.x += vx * DT;
    pos.y += vy * DT;
    pos.t += DT;
    a.update(pos.x, pos.y, DT, pos.t, dashing);
    if (seen[seen.length - 1] !== a.motion) seen.push(a.motion);
  }
  return seen;
}

describe('easing', () => {
  test('endpoints are exact', () => {
    for (const f of [easeOutBack, easeOutElastic, easeInOutSine]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      // clamped outside [0, 1]
      expect(f(-1)).toBe(0);
      expect(f(2)).toBe(1);
    }
  });

  test('easeOutBack overshoots then settles', () => {
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, easeOutBack(t));
    expect(peak).toBeGreaterThan(1.05);
    expect(easeOutBack(0.99)).toBeGreaterThan(1);
    expect(Math.abs(easeOutBack(0.999) - 1)).toBeLessThan(0.01);
  });

  test('easeInOutSine is monotonic and symmetric', () => {
    let prev = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = easeInOutSine(t);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('spring', () => {
  test('settles on its target', () => {
    const s: Spring = { x: 0, v: 0 };
    for (let i = 0; i < 180; i++) springStep(s, 0.2, DT);
    expect(s.x).toBeCloseTo(0.2, 3);
    expect(Math.abs(s.v)).toBeLessThan(0.01);
  });

  test('a huge frame does not explode it', () => {
    const s: Spring = { x: 0, v: 50 };
    springStep(s, 0, 0.5);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(5);
  });
});

describe('animState from velocity', () => {
  test('idle -> moving -> stopped -> idle, and dash', () => {
    const a = new AvatarAnim(1);
    const p = { x: 100, y: 100, t: 0 };
    a.update(p.x, p.y, DT, 0, false);
    expect(drive(a, p, 0, 0, 0.5)).toEqual(['idle']);
    expect(drive(a, p, 220, 0, 0.5)).toContain('moving');
    expect(a.motion).toBe('moving');
    const stop = drive(a, p, 0, 0, 0.6);
    expect(stop).toContain('stopped');
    expect(stop.indexOf('stopped')).toBeLessThan(stop.indexOf('idle'));
    expect(a.motion).toBe('idle');
    expect(drive(a, p, 220, 0, 0.3, true)).toContain('dash');
    expect(a.motion).toBe('dash');
    // very fast without the flag also reads as a dash (being bumped / launched)
    const b = new AvatarAnim(2);
    const q = { x: 0, y: 0, t: 0 };
    b.update(0, 0, DT, 0, false);
    expect(drive(b, q, 1100, 0, 0.3)).toContain('dash');
  });

  test('nextMotion uses hysteresis around the walk threshold', () => {
    expect(nextMotion('idle', 30, false, 1)).toBe('idle');
    expect(nextMotion('moving', 30, false, 1)).toBe('moving');
    expect(nextMotion('moving', 5, false, 1)).toBe('stopped');
    expect(nextMotion('stopped', 5, false, 0.1)).toBe('stopped');
    expect(nextMotion('stopped', 5, false, 0.5)).toBe('idle');
  });

  test('a teleport is not a dash', () => {
    const a = new AvatarAnim(3);
    a.update(0, 0, DT, 0, false);
    a.update(900, 0, DT, DT, false);
    expect(a.motion).toBe('idle');
    expect(a.speed).toBe(0);
  });
});

describe('squash and stretch', () => {
  test('stays within [0.7, 1.3] under abuse and settles back to 1', () => {
    const a = new AvatarAnim(4);
    const p = { x: 0, y: 0, t: 0 };
    a.update(0, 0, DT, 0, false);
    let lo = 1, hi = 1;
    const track = () => {
      a.pose(p.t);
      lo = Math.min(lo, a.sx, a.sy);
      hi = Math.max(hi, a.sx, a.sy);
    };
    for (let k = 0; k < 40; k++) {
      // jerky: dash, reverse, stop, get hit
      const vx = k % 2 ? 1400 : -1400;
      for (let i = 0; i < 6; i++) {
        p.x += vx * DT;
        p.t += DT;
        a.update(p.x, p.y, DT, p.t, k % 3 === 0);
        if (i === 2) a.hit(1, 0);
        track();
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0.7);
    expect(hi).toBeLessThanOrEqual(1.3);
    // then stand still for 2 s: the spring settles (breathing aside)
    for (let i = 0; i < 120; i++) {
      p.t += DT;
      a.update(p.x, p.y, DT, p.t, false);
    }
    expect(Math.abs(a.squash)).toBeLessThan(0.01);
  });

  test('starting to move kicks a squash', () => {
    const a = new AvatarAnim(5);
    const p = { x: 0, y: 0, t: 0 };
    a.update(0, 0, DT, 0, false);
    drive(a, p, 0, 0, 0.3);
    drive(a, p, 300, 0, 0.1);
    expect(Math.abs(a.squash)).toBeGreaterThan(0.02);
  });
});

describe('waddle', () => {
  test('phase advances with distance, not time', () => {
    const a = new AvatarAnim(6);
    const p = { x: 0, y: 0, t: 0 };
    a.update(0, 0, DT, 0, false);
    const w0 = a.walk;
    drive(a, p, 0, 0, 3);
    expect(a.walk).toBe(w0);
    a.pose(p.t);
    expect(a.hop).toBe(0);
    drive(a, p, 200, 0, 0.5);
    const w1 = a.walk;
    expect(w1).toBeGreaterThan(w0);
    // twice as far (same time) -> twice the phase
    const b = new AvatarAnim(6);
    const q = { x: 0, y: 0, t: 0 };
    b.update(0, 0, DT, 0, false);
    drive(b, q, 400, 0, 0.5);
    expect(b.walk - w0).toBeCloseTo(2 * (w1 - w0), 5);
  });

  test('footsteps fire per stride while moving', () => {
    const a = new AvatarAnim(7);
    const p = { x: 0, y: 0, t: 0 };
    a.update(0, 0, DT, 0, false);
    let steps = 0;
    for (let i = 0; i < 60; i++) {
      p.x += 240 * DT;
      p.t += DT;
      a.update(p.x, p.y, DT, p.t, false);
      if (a.footstep) steps++;
    }
    expect(steps).toBeGreaterThanOrEqual(5);
    expect(steps).toBeLessThanOrEqual(10);
  });

  test('flipping to face the other way squashes and reports a flip', () => {
    const a = new AvatarAnim(8);
    const p = { x: 0, y: 0, t: 0 };
    a.update(0, 0, DT, 0, false);
    drive(a, p, 200, 0, 0.4);
    expect(a.face).toBe(1);
    let flipped = false;
    for (let i = 0; i < 20; i++) {
      p.x -= 200 * DT;
      p.t += DT;
      a.update(p.x, p.y, DT, p.t, false);
      flipped ||= a.flipped;
    }
    expect(flipped).toBe(true);
    expect(a.face).toBe(-1);
  });

  test('a frozen frame (dt 0) changes nothing', () => {
    const a = new AvatarAnim(9);
    a.update(0, 0, DT, 0, false);
    a.update(10, 0, DT, DT, false);
    const snap = { walk: a.walk, motion: a.motion, vx: a.vx, sq: a.squash };
    a.update(10, 0, 0, 2 * DT, false);
    expect({ walk: a.walk, motion: a.motion, vx: a.vx, sq: a.squash }).toEqual(snap);
  });
});

describe('y-sort', () => {
  test('comparator orders by y, ties by id, independent of input order', () => {
    const items = [
      { y: 300, id: 5 }, { y: 100, id: 9 }, { y: 300, id: 2 }, { y: 200, id: 1 }, { y: 300, id: 7 }, { y: 100, id: 3 },
    ];
    const want = [[100, 3], [100, 9], [200, 1], [300, 2], [300, 5], [300, 7]];
    for (let r = 0; r < 5; r++) {
      const shuffled = [...items].sort(() => (r % 2 ? 1 : -1));
      if (r > 1) shuffled.reverse();
      expect(shuffled.sort(depthCompare).map((o) => [o.y, o.id])).toEqual(want);
    }
  });

  test('depthKey (zIndex) agrees with the comparator', () => {
    const items = [{ y: 300.2, id: 5 }, { y: 300.2, id: 2 }, { y: 299.9, id: 9 }, { y: 0, id: 4000 }, { y: 1080, id: 1 }];
    const byCmp = [...items].sort(depthCompare);
    const byKey = [...items].sort((a, b) => depthKey(a.y, a.id) - depthKey(b.y, b.id));
    expect(byKey).toEqual(byCmp);
  });
});

describe('hit-stop', () => {
  test('counts down in render time', () => {
    const h = new HitStop();
    h.trigger(70);
    expect(h.ms).toBe(70);
    h.trigger(40); // a smaller one never shortens it
    expect(h.ms).toBe(70);
    h.tick(16.7);
    expect(h.ms).toBeCloseTo(53.3, 5);
    h.tick(100);
    expect(h.ms).toBe(0);
    h.trigger(500);
    expect(h.ms).toBeLessThanOrEqual(80);
  });

  test('only big hits stop, 50..80 ms', () => {
    expect(hitStopFor(0.15)).toBe(0);
    expect(hitStopFor(0.4)).toBe(50);
    expect(hitStopFor(1)).toBe(80);
    expect(hitStopFor(0.6)).toBeGreaterThan(50);
  });

  test('the host loop pauses the accumulator; sim steps stay fixed', () => {
    // 1 s of 60 fps frames with a 70 ms hit-stop at 0.5 s
    const h = new HitStop();
    let acc = 0, steps = 0, simTime = 0;
    const SIM = 1 / 60;
    for (let f = 0; f < 60; f++) {
      if (f === 30) h.trigger(70);
      acc = advanceAccumulator(acc, 1 / 60, 1, h.ms);
      while (acc >= SIM - 1e-9) {
        acc -= SIM;
        steps++;
        simTime += SIM; // every step is exactly one fixed step
      }
      h.tick(1000 / 60);
    }
    expect(simTime).toBeCloseTo(steps * SIM, 10);
    // ~70 ms of frames (5 frames) did not advance the sim
    expect(steps).toBe(55);
    // slow-mo still scales
    expect(advanceAccumulator(0, 0.1, 0.3, 0)).toBeCloseTo(0.03, 10);
  });
});

describe('camera', () => {
  test('zoom eases toward its target and is clamped', () => {
    const c = new CameraRig(1280, 720);
    c.setFinale(true, 640, 360);
    const zs: number[] = [];
    for (let i = 0; i < 120; i++) {
      c.tick(DT);
      zs.push(c.zoom);
    }
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeGreaterThanOrEqual(zs[i - 1]!);
    expect(zs[0]! - 1).toBeLessThan(0.01); // eased, no jump
    expect(c.zoom).toBeGreaterThan(1.02);
    c.punch(5, 100, 100, 1); // absurd request
    for (let i = 0; i < 60; i++) {
      c.tick(DT);
      expect(c.zoom).toBeLessThanOrEqual(ZOOM_MAX);
      expect(c.zoom).toBeGreaterThanOrEqual(1);
    }
    c.setFinale(false, 640, 360);
    for (let i = 0; i < 300; i++) c.tick(DT);
    expect(c.zoom).toBeCloseTo(1, 3);
  });

  test('drift stays within 2 px and shake is capped', () => {
    const c = new CameraRig(1280, 720);
    const o = { x: 0, y: 0 };
    for (let t = 0; t < 120; t += 0.37) {
      c.drift(t, o);
      expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(2);
    }
    const s = { x: 40, y: -30, rot: 0.2 };
    capShake(s, 16);
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(16, 5);
    expect(s.x / s.y).toBeCloseTo(40 / -30, 5);
  });
});
