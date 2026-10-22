// Swipe pad: one direction per gesture, fired as soon as the finger travels far enough.
import { capture, el, on, type Widget } from './core';

export type SwipeDir = 'up' | 'down' | 'left' | 'right';

export interface SwipeOpts {
  id: string;
  onSwipe(d: SwipeDir): void;
  threshold?: number;
}

export function swipeDir(dx: number, dy: number, threshold: number): SwipeDir | undefined {
  if (Math.hypot(dx, dy) < threshold) return undefined;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}

export function createSwipe(o: SwipeOpts): Widget {
  const root = el('div', 'cp-swipe', { 'data-widget': o.id });
  const arrows: Record<SwipeDir, HTMLElement> = {
    up: el('i', 'cp-swipe-arrow is-up'), down: el('i', 'cp-swipe-arrow is-down'),
    left: el('i', 'cp-swipe-arrow is-left'), right: el('i', 'cp-swipe-arrow is-right'),
  };
  root.append(...Object.values(arrows), el('div', 'cp-swipe-hint', {}, 'Swipe'));
  const th = o.threshold ?? 36;
  let start: { id: number; x: number; y: number; fired: boolean } | undefined;

  const fire = (d: SwipeDir) => {
    const a = arrows[d];
    a.classList.remove('is-flash'); void a.offsetWidth; a.classList.add('is-flash');
    o.onSwipe(d);
  };
  const offs = [
    on<PointerEvent>(root, 'pointerdown', (e) => {
      e.preventDefault();
      capture(root, e.pointerId);
      start = { id: e.pointerId, x: e.clientX, y: e.clientY, fired: false };
      root.classList.add('is-active');
    }),
    on<PointerEvent>(root, 'pointermove', (e) => {
      if (!start || e.pointerId !== start.id || start.fired) return;
      const d = swipeDir(e.clientX - start.x, e.clientY - start.y, th);
      if (d) { start.fired = true; fire(d); }
    }),
  ];
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    if (!start.fired) {
      const d = swipeDir(e.clientX - start.x, e.clientY - start.y, th * 0.6);
      if (d) fire(d);
    }
    start = undefined;
    root.classList.remove('is-active');
  };
  offs.push(on(root, 'pointerup', end), on(root, 'pointercancel', end));
  return { el: root, destroy: () => offs.forEach((f) => f()) };
}
