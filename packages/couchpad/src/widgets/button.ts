// Momentary action button: true on press, false on release. Glossy, with ripple and haptic.
import { capture, el, on, ripple, type Widget } from './core';

export interface ButtonOpts {
  id: string;
  label: string;
  onChange(down: boolean): void;
  onPress?(): void;
  variant?: 'tap' | 'hold';
}

export function createButton(o: ButtonOpts): Widget {
  const hold = o.variant === 'hold';
  const root = el('button', hold ? 'cp-btn cp-hold' : 'cp-btn', { type: 'button', 'data-widget': o.id, 'aria-label': o.label });
  if (hold) root.appendChild(el('span', 'cp-hold-fill'));
  root.appendChild(el('span', 'cp-btn-label', {}, o.label));
  if (hold) root.appendChild(el('span', 'cp-btn-hint', {}, 'Hold'));

  const pointers = new Set<number>();
  const set = (down: boolean) => {
    root.classList.toggle('is-down', down);
    o.onChange(down);
  };
  const offs = [
    on<PointerEvent>(root, 'pointerdown', (e) => {
      e.preventDefault();
      capture(root, e.pointerId);
      const first = pointers.size === 0;
      pointers.add(e.pointerId);
      ripple(root, e);
      if (first) { o.onPress?.(); set(true); }
    }),
    on(root, 'contextmenu', (e) => e.preventDefault()),
  ];
  const up = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId) || pointers.size > 0) return;
    set(false);
  };
  offs.push(on(root, 'pointerup', up), on(root, 'pointercancel', up), on(root, 'lostpointercapture', up));
  const release = () => { pointers.clear(); root.classList.remove('is-down'); };
  return { el: root, release, destroy: () => offs.forEach((f) => f()) };
}
