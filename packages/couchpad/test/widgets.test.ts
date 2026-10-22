// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InputFrame } from '@cadabra/spec';
import { mountController } from '../src/widgets';
import { EXPORT_SIZE, exportJpeg } from '../src/widgets/draw';
import { CouchClient, CouchHost } from '../src/index';
import { FakeBackend, FakeRTC, MemStorage, resetFakes } from './fakes';

const rect = (el: Element, w = 200, h = 200) => {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
};
// jsdom has no PointerEvent: a MouseEvent carrying a pointerId is what the widgets read.
const ptr = (el: Element, type: string, x = 0, y = 0, pointerId = 1) => {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  return el.dispatchEvent(e);
};

let host: HTMLElement;
let frames: InputFrame[];
let unmount: () => void;
const host_el = () => host;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  frames = [];
  (navigator as any).vibrate = vi.fn(() => true);
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
afterEach(() => {
  unmount?.();
  host.remove();
  delete (globalThis as any).DeviceOrientationEvent;
});

describe('couchpad widgets', () => {
  it('joystick emits normalized axes within unit circle', () => {
    unmount = mountController(host, [{ kind: 'joystick', id: 'move' }], (f) => frames.push(f));
    const pad = host.querySelector('.cp-joystick')!;
    expect(pad).toBeTruthy();
    rect(pad);
    ptr(pad, 'pointerdown', 100, 100);
    ptr(pad, 'pointermove', 900, 950); // far outside: clamps to the rim
    ptr(pad, 'pointermove', 150, 100); // half-way right
    ptr(pad, 'pointermove', 100, 0); // straight up
    const axes = frames.map((f) => f.axes).filter(Boolean) as { x: number; y: number }[];
    expect(axes.length).toBeGreaterThanOrEqual(3);
    for (const a of axes) expect(Math.hypot(a.x, a.y)).toBeLessThanOrEqual(1 + 1e-9);
    const rim = axes.find((a) => a.x > 0.5 && a.y > 0.5)!;
    expect(Math.hypot(rim.x, rim.y)).toBeCloseTo(1, 5);
    expect(axes.some((a) => a.x > 0.3 && a.x < 0.8 && Math.abs(a.y) < 0.05)).toBe(true);
    expect(axes.at(-1)!.y).toBeLessThan(-0.9); // screen-up = negative y
    ptr(pad, 'pointerup', 100, 0);
    expect(frames.at(-1)!.axes).toEqual({ x: 0, y: 0 });
  });

  it('hold emits true on down and false on up', () => {
    unmount = mountController(host, [{ kind: 'hold', id: 'charge', label: 'Charge' }], (f) => frames.push(f));
    const btn = host.querySelector('[data-widget="charge"]')!;
    ptr(btn, 'pointerdown', 10, 10);
    expect(frames.at(-1)!.buttons).toEqual({ charge: true });
    expect(navigator.vibrate).toHaveBeenCalledWith(15);
    ptr(btn, 'pointerup', 10, 10);
    expect(frames.at(-1)!.buttons).toEqual({ charge: false });
  });

  it('tilt without permission renders joystick fallback', async () => {
    (globalThis as any).DeviceOrientationEvent = class {
      static requestPermission = vi.fn(async () => 'denied');
    };
    unmount = mountController(host, [{ kind: 'tilt', id: 'lean' }], (f) => frames.push(f));
    const enable = Array.from(host.querySelectorAll('button')).find((b) => /enable tilt/i.test(b.textContent ?? ''));
    expect(enable).toBeTruthy();
    expect(host.querySelector('.cp-joystick')).toBeNull();
    enable!.click();
    await vi.waitFor(() => expect(host.querySelector('.cp-joystick')).toBeTruthy());
    expect((globalThis as any).DeviceOrientationEvent.requestPermission).toHaveBeenCalled();
    // The fallback stick drives the tilt field.
    const pad = host.querySelector('.cp-joystick')!;
    rect(pad);
    ptr(pad, 'pointerdown', 100, 100);
    ptr(pad, 'pointermove', 200, 100);
    expect(frames.at(-1)!.tilt!.x).toBeCloseTo(1, 5);
  });

  it('draw export stays under 25 KB (PNG fallback without canvas)', () => {
    unmount = mountController(host, [{ kind: 'draw', id: 'doodle', prompt: 'Draw a hat' }], (f) => frames.push(f));
    const pad = host.querySelector('.cp-draw-pad')!;
    rect(pad, 360, 360);
    // Dense, noisy scribble across the whole pad (worst case for compression).
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let s = 0; s < 40; s++) {
      ptr(pad, 'pointerdown', rnd() * 360, rnd() * 360);
      for (let i = 0; i < 60; i++) ptr(pad, 'pointermove', rnd() * 360, rnd() * 360);
      ptr(pad, 'pointerup', 0, 0);
    }
    const done = host.querySelector('[data-action="done"]') as HTMLButtonElement;
    done.click();
    const f = frames.find((x) => x.draw)!;
    expect(f.draw!.startsWith('data:image/png;base64,')).toBe(true);
    expect(f.draw!.length * 0.75).toBeLessThan(25 * 1024);
    const bin = atob(f.draw!.slice('data:image/png;base64,'.length));
    expect([...bin.slice(0, 8)].map((c) => c.charCodeAt(0))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it('draw export uses JPEG <= 256 px and lowers quality until <= 25 KB', () => {
    const calls: number[] = [];
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    const orig = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const e = orig(tag);
      if (tag === 'canvas') {
        (e as any).getContext = () => ctx;
        (e as any).toDataURL = (_t: string, q: number) => { calls.push(q); return 'data:image/jpeg;base64,' + 'A'.repeat(q > 0.5 ? 60000 : 20000); };
      }
      return e;
    }) as any);
    try {
      const strokes = [{ c: 1, pts: [0.1, 0.1, 0.9, 0.9] }];
      const url = exportJpeg(strokes)!;
      expect(url.startsWith('data:image/jpeg')).toBe(true);
      expect(calls).toEqual([0.7, 0.55, 0.4]);
      expect(url.length * 0.75).toBeLessThanOrEqual(25 * 1024);
      expect(EXPORT_SIZE).toBeLessThanOrEqual(256);
    } finally { spy.mockRestore(); }
  });

  it('text caps at 40 chars and vote emits the option index', () => {
    unmount = mountController(host, [
      { kind: 'text', id: 'say', placeholder: 'Say something' },
      { kind: 'vote', id: 'pick', options: ['Lava', 'Ocean'] },
    ], (f) => frames.push(f));
    const input = host.querySelector('input') as HTMLInputElement;
    expect(input.maxLength).toBe(40);
    input.value = 'x'.repeat(60);
    input.dispatchEvent(new Event('input'));
    (host.querySelector('[data-action="send"]') as HTMLButtonElement).click();
    expect(frames.find((f) => f.text)!.text).toHaveLength(40);
    (host.querySelectorAll('[data-option]')[1] as HTMLButtonElement).click();
    expect(frames.find((f) => f.vote !== undefined)!.vote).toBe(1);
  });

  it('unmount removes the controller', () => {
    const off = mountController(host, [{ kind: 'button', id: 'a', label: 'Jump' }], () => {});
    expect(host.children.length).toBeGreaterThan(0);
    off();
    expect(host.children.length).toBe(0);
  });

  it('unmount while a button is held emits a release, and the keepalive stops', async () => {
    vi.useFakeTimers();
    try {
      resetFakes();
      const backend = new FakeBackend();
      const host = new CouchHost({ wsUrl: 'wss://x', household: 'h', WebSocket: backend.WebSocket as any, RTCPeerConnection: FakeRTC as any, storage: new MemStorage() });
      const created = host.create();
      await vi.advanceTimersByTimeAsync(0);
      const { code } = await created;
      const client = new CouchClient({ wsUrl: 'wss://x', WebSocket: backend.WebSocket as any, RTCPeerConnection: FakeRTC as any, storage: new MemStorage(), random: () => 0.5 });
      const joined = client.join(code, 'Ana');
      await vi.advanceTimersByTimeAsync(0);
      await joined;
      await vi.advanceTimersByTimeAsync(100);
      const got: InputFrame[] = [];
      host.on('input', (_id: string, f: InputFrame) => got.push(f));

      const off = mountController(host_el(), [{ kind: 'hold', id: 'a', label: 'A' }], (f) => client.sendInput(f), { now: () => Date.now() });
      ptr(document.querySelector('[data-widget="a"]')!, 'pointerdown', 1, 1);
      await vi.advanceTimersByTimeAsync(500);
      expect(got.at(-1)!.buttons).toEqual({ a: true });
      off(); // unmounted mid-hold (e.g. the TV switched screens)
      await vi.advanceTimersByTimeAsync(100);
      expect(got.at(-1)!.buttons).toEqual({ a: false });
      const n = got.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(got.length).toBe(n);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('window blur and a hidden tab release everything', () => {
    unmount = mountController(host, [{ kind: 'joystick', id: 'm' }, { kind: 'button', id: 'b', label: 'B' }], (f) => frames.push(f));
    const pad = host.querySelector('.cp-joystick')!;
    rect(pad);
    ptr(pad, 'pointerdown', 100, 100);
    ptr(pad, 'pointermove', 200, 100);
    ptr(host.querySelector('[data-widget="b"]')!, 'pointerdown', 1, 1, 2);
    expect(frames.at(-1)).toMatchObject({ axes: { x: 1, y: 0 }, buttons: { b: true } });
    window.dispatchEvent(new Event('blur'));
    expect(frames.at(-1)).toMatchObject({ axes: { x: 0, y: 0 }, buttons: { b: false } });
    expect(host.querySelector('.cp-btn.is-down')).toBeNull();
    // press again, then hide the tab
    ptr(host.querySelector('[data-widget="b"]')!, 'pointerdown', 1, 1, 3);
    expect(frames.at(-1)!.buttons).toEqual({ b: true });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.at(-1)!.buttons).toEqual({ b: false });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('tilt recalibrates after a screen rotation', () => {
    (globalThis as any).DeviceOrientationEvent = class {}; // Android-style: no permission prompt
    unmount = mountController(host, [{ kind: 'tilt', id: 'lean' }], (f) => frames.push(f));
    const orient = (beta: number, gamma: number) => {
      const e = new Event('deviceorientation');
      Object.assign(e, { beta, gamma });
      window.dispatchEvent(e);
    };
    orient(10, 0); // first event = rest pose
    expect(frames.at(-1)!.tilt).toEqual({ x: 0, y: 0 });
    orient(10, 15);
    expect(frames.at(-1)!.tilt!.x).toBeCloseTo(0.5, 5);
    window.dispatchEvent(new Event('orientationchange'));
    expect(frames.at(-1)!.tilt).toEqual({ x: 0, y: 0 }); // zeroed while recalibrating
    orient(40, 15); // new rest pose after rotating
    expect(frames.at(-1)!.tilt).toEqual({ x: 0, y: 0 });
    orient(40, 30);
    expect(frames.at(-1)!.tilt!.x).toBeCloseTo(0.5, 5);
    unmount();
    expect(frames.at(-1)!.tilt).toEqual({ x: 0, y: 0 });
  });

  it('swipe ignores pointercancel', () => {
    unmount = mountController(host, [{ kind: 'swipe', id: 's' }], (f) => frames.push(f));
    const pad = host.querySelector('.cp-swipe')!;
    ptr(pad, 'pointerdown', 100, 100);
    ptr(pad, 'pointercancel', 100, 10);
    ptr(pad, 'pointerup', 100, 10);
    expect(frames.filter((f) => f.swipe)).toHaveLength(0);
    ptr(pad, 'pointerdown', 100, 100);
    ptr(pad, 'pointermove', 160, 100);
    expect(frames.filter((f) => f.swipe).map((f) => f.swipe)).toEqual(['right']);
  });

  it('joystick exposes accessible role and value', () => {
    unmount = mountController(host, [{ kind: 'joystick', id: 'm' }], () => {});
    const pad = host.querySelector('.cp-joystick')!;
    expect(pad.getAttribute('role')).toBe('application');
    expect(pad.getAttribute('aria-roledescription')).toBe('joystick');
  });
});
