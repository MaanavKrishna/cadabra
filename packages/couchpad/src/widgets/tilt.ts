// Tilt: device orientation mapped to {x,y} in [-1,1]. iOS needs a tap to grant permission
// ("Enable tilt"); if denied or unavailable, a joystick takes over and drives the same field.
import { clamp, el, on, type Axes, type Widget } from './core';
import { createJoystick } from './joystick';

export interface TiltOpts {
  id: string;
  onChange(a: Axes): void;
  onPress?(): void;
  /** Degrees of tilt for full deflection. */
  range?: number;
  /** Fall back if no orientation event arrives within this long (desktop browsers). */
  probeMs?: number;
}

type DOE = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

function screenAngle(): number {
  const s = (globalThis as any).screen?.orientation?.angle;
  if (typeof s === 'number') return s;
  const w = (globalThis as any).orientation;
  return typeof w === 'number' ? w : 0;
}

/** Orientation angles → axes relative to a calibrated rest pose, rotated for the screen angle. */
export function tiltAxes(beta: number, gamma: number, base: { beta: number; gamma: number }, angle: number, range = 30): Axes {
  const db = beta - base.beta, dg = gamma - base.gamma;
  let x = dg, y = db;
  if (angle === 90) { x = db; y = -dg; } else if (angle === 270 || angle === -90) { x = -db; y = dg; } else if (angle === 180) { x = -dg; y = -db; }
  return { x: clamp(x / range, -1, 1), y: clamp(y / range, -1, 1) };
}

export function createTilt(o: TiltOpts): Widget {
  const root = el('div', 'cp-tilt', { 'data-widget': o.id });
  let child: Widget | undefined;
  const offs: (() => void)[] = [];
  let probe: ReturnType<typeof setTimeout> | undefined;

  const fallback = (why: string) => {
    if (probe) clearTimeout(probe);
    offs.splice(0).forEach((f) => f());
    root.replaceChildren();
    child = createJoystick({ id: o.id, onChange: o.onChange, onPress: o.onPress });
    root.append(el('div', 'cp-tilt-note', {}, why), child.el);
  };

  const listen = () => {
    root.replaceChildren();
    const level = el('div', 'cp-tilt-level');
    const bubble = el('div', 'cp-tilt-bubble');
    level.appendChild(bubble);
    const recenter = el('button', 'cp-chip', { type: 'button', 'data-action': 'recenter' }, 'Recenter');
    root.append(level, el('div', 'cp-tilt-note', {}, 'Tilt your phone to steer'), recenter);
    let base: { beta: number; gamma: number } | undefined;
    let latest = { beta: 0, gamma: 0 };
    offs.push(on(recenter, 'click', () => { base = { ...latest }; o.onPress?.(); }));
    offs.push(on<DeviceOrientationEvent>(globalThis as any, 'deviceorientation', (e) => {
      if (e.beta == null || e.gamma == null) return;
      if (probe) { clearTimeout(probe); probe = undefined; }
      latest = { beta: e.beta, gamma: e.gamma };
      base ??= { ...latest };
      const a = tiltAxes(e.beta, e.gamma, base, screenAngle(), o.range);
      bubble.style.transform = `translate(-50%, -50%) translate(${a.x * 38}px, ${a.y * 38}px)`;
      o.onChange(a);
    }));
    probe = setTimeout(() => fallback('Tilt not available, use the stick'), o.probeMs ?? 1500);
  };

  const DOECtor = (globalThis as any).DeviceOrientationEvent as DOE | undefined;
  if (!DOECtor) {
    fallback('Tilt not available, use the stick');
  } else if (typeof DOECtor.requestPermission === 'function') {
    const btn = el('button', 'cp-btn cp-tilt-enable', { type: 'button', 'data-action': 'enable-tilt' });
    btn.appendChild(el('span', 'cp-btn-label', {}, 'Enable tilt'));
    root.append(el('div', 'cp-tilt-note', {}, 'Steer by tilting your phone'), btn);
    offs.push(on(btn, 'click', async () => {
      o.onPress?.();
      let res: string = 'denied';
      try { res = await DOECtor.requestPermission!(); } catch { /* treated as denied */ }
      if (res === 'granted') listen(); else fallback('Tilt is off, use the stick');
    }));
  } else {
    listen();
  }

  return {
    el: root,
    destroy: () => { if (probe) clearTimeout(probe); offs.forEach((f) => f()); child?.destroy(); },
  };
}
