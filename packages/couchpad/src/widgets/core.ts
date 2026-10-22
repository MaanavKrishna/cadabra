// Shared plumbing for the framework-free controller widgets.
// Theming is CSS-variable only (see styles.ts): --cp-primary, --cp-accent, --cp-glow, --cp-text,
// --cp-surface, --cp-font, --cp-display-font. No product branding lives in here.
import type { InputFrame } from '@cadabra/spec';

export type Axes = { x: number; y: number };

export interface WidgetEnv {
  /** Continuous state: merged into every continuous frame. */
  setAxes(a: Axes): void;
  setTilt(a: Axes): void;
  setButton(id: string, down: boolean): void;
  /** One-shot fields (swipe/vote/text/draw), delivered reliably by the transport. */
  oneShot(f: Omit<InputFrame, 't'>): void;
  haptic(pattern?: number | number[]): void;
}

export interface Widget {
  el: HTMLElement;
  destroy(): void;
}

export const PRESS_HAPTIC_MS = 15;

export function haptic(pattern: number | number[] = PRESS_HAPTIC_MS) {
  try {
    const nav = globalThis.navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    nav?.vibrate?.(pattern);
  } catch { /* unsupported or blocked */ }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, attrs: Record<string, string> = {}, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

export function capture(target: Element, pointerId: number) {
  try { (target as HTMLElement).setPointerCapture?.(pointerId); } catch { /* jsdom / synthetic */ }
}

/** Adds a listener and returns its remover. */
export function on<T extends Event>(
  target: EventTarget, type: string, fn: (e: T) => void, opts?: AddEventListenerOptions,
): () => void {
  const h = fn as EventListener;
  target.addEventListener(type, h, opts);
  return () => target.removeEventListener(type, h, opts);
}

/** Expanding ripple at the pointer, purely cosmetic. */
export function ripple(host: HTMLElement, e: PointerEvent) {
  const r = host.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const dot = el('span', 'cp-ripple');
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${e.clientX - r.left - size / 2}px`;
  dot.style.top = `${e.clientY - r.top - size / 2}px`;
  host.appendChild(dot);
  setTimeout(() => dot.remove(), 600);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
