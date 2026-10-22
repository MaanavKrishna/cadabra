// Analog stick: normalized axes inside the unit circle, springy knob, direction glow.
import { capture, clamp, el, on, type Axes, type Widget } from './core';

export interface JoystickOpts {
  id: string;
  onChange(a: Axes): void;
  onPress?(): void;
  /** Fraction of the pad's half-size the finger travels for full deflection. */
  reach?: number;
  deadzone?: number;
}

/** Map a finger offset (px) to axes within the unit circle, with a rescaled radial deadzone. */
export function toAxes(dx: number, dy: number, radius: number, deadzone = 0.08): Axes {
  if (radius <= 0) return { x: 0, y: 0 };
  let x = dx / radius, y = dy / radius;
  const m = Math.hypot(x, y);
  if (m < deadzone) return { x: 0, y: 0 };
  const scaled = Math.min(1, (m - deadzone) / (1 - deadzone));
  x = (x / m) * scaled; y = (y / m) * scaled;
  return { x, y };
}

export function createJoystick(o: JoystickOpts): Widget {
  const root = el('div', 'cp-joystick', { 'data-widget': o.id, role: 'slider', 'aria-label': 'Joystick' });
  const glow = el('div', 'cp-joystick-glow');
  const ring = el('div', 'cp-joystick-ring');
  const knob = el('div', 'cp-joystick-knob');
  for (let i = 0; i < 4; i++) ring.appendChild(el('i', `cp-joystick-tick cp-tick-${i}`));
  root.append(glow, ring, knob);

  let active: number | undefined;
  let cx = 0, cy = 0, radius = 1, travel = 1;
  let last: Axes = { x: 0, y: 0 };

  const render = (a: Axes) => {
    const m = Math.hypot(a.x, a.y);
    knob.style.transform = `translate(-50%, -50%) translate(${a.x * travel}px, ${a.y * travel}px)`;
    glow.style.opacity = String(clamp(m * 1.1, 0, 1));
    glow.style.transform = `rotate(${Math.atan2(a.y, a.x) * 180 / Math.PI + 90}deg)`;
  };
  const emit = (a: Axes) => {
    if (a.x === last.x && a.y === last.y) return;
    last = a;
    render(a);
    o.onChange(a);
  };
  const move = (e: PointerEvent) => emit(toAxes(e.clientX - cx, e.clientY - cy, radius, o.deadzone));

  const offs = [
    on<PointerEvent>(root, 'pointerdown', (e) => {
      if (active !== undefined) return;
      e.preventDefault();
      active = e.pointerId;
      capture(root, e.pointerId);
      const r = root.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      const half = Math.min(r.width, r.height) / 2;
      radius = half * (o.reach ?? 0.8);
      travel = half * 0.42;
      root.classList.add('is-active');
      o.onPress?.();
      move(e);
    }),
    on<PointerEvent>(root, 'pointermove', (e) => { if (e.pointerId === active) move(e); }),
  ];
  const release = (e: PointerEvent) => {
    if (e.pointerId !== active) return;
    active = undefined;
    root.classList.remove('is-active');
    emit({ x: 0, y: 0 });
  };
  offs.push(on(root, 'pointerup', release), on(root, 'pointercancel', release), on(root, 'lostpointercapture', release));
  render(last);
  return { el: root, destroy: () => offs.forEach((f) => f()) };
}
