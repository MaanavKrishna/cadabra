// Doodle pad: strokes are kept as vectors. On "Done" they are exported as a <= 256 px JPEG (quality ~0.7, lowered
// until <= 25 KB) so the drawing fits one relay frame, the backend request and the AI judge's image budget.
// Without a usable canvas (tests, odd WebViews) a 128 px 4-bit PNG (~11 KB) is exported instead.
import { capture, el, on, type Widget } from './core';
import { encodeIndexedPng } from './png';

export const DRAW_SIZE = 128; // PNG fallback raster size
export const EXPORT_SIZE = 256; // JPEG long side
export const MAX_EXPORT_BYTES = 25 * 1024;
const JPEG_QUALITIES = [0.7, 0.55, 0.4, 0.3, 0.2];
const PAD_BG = '#14141f';
export const DRAW_COLORS = ['#ffffff', '#ff4d6d', '#ffd166', '#4cc9f0'];
const BRUSH = 0.03; // stroke width as a fraction of the pad

interface Stroke { c: number; pts: number[] } // c = palette index (1-based); pts = x0,y0,x1,y1… in 0..1

export interface DrawOpts {
  id: string;
  prompt: string;
  onDone(png: string): void;
  onPress?(): void;
}

export function rasterize(strokes: Stroke[], size = DRAW_SIZE): Uint8Array {
  const px = new Uint8Array(size * size);
  const r = Math.max(1, (BRUSH * size) / 2);
  const r2 = r * r;
  const stamp = (cx: number, cy: number, c: number) => {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(size - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(size - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) px[y * size + x] = c;
    }
  };
  for (const s of strokes) {
    const p = s.pts;
    stamp(p[0]! * size, p[1]! * size, s.c);
    for (let i = 2; i + 1 < p.length; i += 2) {
      const ax = p[i - 2]! * size, ay = p[i - 1]! * size, bx = p[i]! * size, by = p[i + 1]! * size;
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (r * 0.5)));
      for (let k = 1; k <= n; k++) stamp(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, s.c);
    }
  }
  return px;
}

const approxBytes = (dataUrl: string) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** JPEG <= 25 KB from the vector strokes, or undefined when canvas export is unavailable. */
export function exportJpeg(strokes: Stroke[]): string | undefined {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = EXPORT_SIZE;
    const g = c.getContext('2d');
    if (!g) return undefined;
    g.fillStyle = PAD_BG;
    g.fillRect(0, 0, EXPORT_SIZE, EXPORT_SIZE);
    g.lineCap = g.lineJoin = 'round';
    g.lineWidth = BRUSH * EXPORT_SIZE;
    for (const s of strokes) {
      const p = s.pts;
      g.strokeStyle = DRAW_COLORS[s.c - 1]!;
      g.beginPath();
      g.moveTo(p[0]! * EXPORT_SIZE, p[1]! * EXPORT_SIZE);
      if (p.length === 2) g.lineTo(p[0]! * EXPORT_SIZE + 0.01, p[1]! * EXPORT_SIZE);
      for (let i = 2; i + 1 < p.length; i += 2) g.lineTo(p[i]! * EXPORT_SIZE, p[i + 1]! * EXPORT_SIZE);
      g.stroke();
    }
    for (const q of JPEG_QUALITIES) {
      const url = c.toDataURL('image/jpeg', q);
      if (!url.startsWith('data:image/jpeg')) return undefined;
      if (approxBytes(url) <= MAX_EXPORT_BYTES) return url;
    }
  } catch { /* fall through to PNG */ }
  return undefined;
}

export function exportDrawing(strokes: Stroke[]): string {
  return exportJpeg(strokes) ?? encodeIndexedPng(DRAW_SIZE, DRAW_SIZE, rasterize(strokes, DRAW_SIZE), DRAW_COLORS);
}

export function createDraw(o: DrawOpts): Widget {
  const root = el('div', 'cp-draw', { 'data-widget': o.id });
  const prompt = el('div', 'cp-draw-prompt', {}, o.prompt);
  const pad = el('div', 'cp-draw-pad');
  const canvas = el('canvas', 'cp-draw-canvas');
  pad.appendChild(canvas);
  const tools = el('div', 'cp-draw-tools');
  const swatches = el('div', 'cp-draw-swatches');
  let color = 1;
  const swEls = DRAW_COLORS.map((hex, i) => {
    const b = el('button', 'cp-swatch', { type: 'button', 'aria-label': `Color ${hex}`, 'data-color': String(i + 1) });
    b.style.setProperty('--sw', hex);
    if (i === 0) b.classList.add('is-on');
    swatches.appendChild(b);
    return b;
  });
  const undo = el('button', 'cp-chip', { type: 'button', 'data-action': 'undo' }, 'Undo');
  const clear = el('button', 'cp-chip', { type: 'button', 'data-action': 'clear' }, 'Clear');
  const done = el('button', 'cp-btn cp-draw-done', { type: 'button', 'data-action': 'done' });
  done.appendChild(el('span', 'cp-btn-label', {}, 'Done'));
  tools.append(swatches, el('div', 'cp-draw-row', {}), done);
  tools.lastElementChild!.previousElementSibling!.append(undo, clear);
  root.append(prompt, pad, tools);

  const strokes: Stroke[] = [];
  let cur: Stroke | undefined;
  let curId: number | undefined;
  let rect = { left: 0, top: 0, width: 1, height: 1 };

  const ctx = (): CanvasRenderingContext2D | null => {
    try { return canvas.getContext('2d'); } catch { return null; }
  };
  const fit = () => {
    const r = pad.getBoundingClientRect();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w > 0 && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; redraw(); }
  };
  const paint = (c: CanvasRenderingContext2D, s: Stroke, from = 0) => {
    const W = canvas.width, H = canvas.height, p = s.pts;
    c.strokeStyle = c.fillStyle = DRAW_COLORS[s.c - 1]!;
    c.lineWidth = BRUSH * W; c.lineCap = c.lineJoin = 'round';
    c.beginPath();
    const i0 = Math.max(0, from - 2);
    c.moveTo(p[i0]! * W, p[i0 + 1]! * H);
    if (p.length === 2) c.lineTo(p[0]! * W + 0.01, p[1]! * H);
    for (let i = i0 + 2; i + 1 < p.length; i += 2) c.lineTo(p[i]! * W, p[i + 1]! * H);
    c.stroke();
  };
  function redraw() {
    const c = ctx(); if (!c) return;
    c.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) paint(c, s);
  }
  const point = (e: PointerEvent): [number, number] => [
    Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  ];

  const offs = [
    on<PointerEvent>(pad, 'pointerdown', (e) => {
      if (curId !== undefined) return;
      e.preventDefault();
      capture(pad, e.pointerId);
      const r = pad.getBoundingClientRect();
      rect = { left: r.left, top: r.top, width: r.width || 1, height: r.height || 1 };
      fit();
      curId = e.pointerId;
      cur = { c: color, pts: point(e) };
      strokes.push(cur);
      root.classList.remove('is-sent');
      const c = ctx(); if (c) paint(c, cur);
    }),
    on<PointerEvent>(pad, 'pointermove', (e) => {
      if (e.pointerId !== curId || !cur) return;
      const n = cur.pts.length;
      cur.pts.push(...point(e));
      const c = ctx(); if (c) paint(c, cur, n);
    }),
    on(undo, 'click', () => { strokes.pop(); redraw(); o.onPress?.(); }),
    on(clear, 'click', () => { strokes.length = 0; redraw(); o.onPress?.(); }),
    on(done, 'click', () => {
      o.onPress?.();
      o.onDone(exportDrawing(strokes));
      root.classList.add('is-sent');
    }),
    ...swEls.map((b, i) => on(b, 'click', () => {
      color = i + 1;
      swEls.forEach((x) => x.classList.toggle('is-on', x === b));
      o.onPress?.();
    })),
  ];
  const end = (e: PointerEvent) => { if (e.pointerId === curId) { curId = undefined; cur = undefined; } };
  offs.push(on(pad, 'pointerup', end), on(pad, 'pointercancel', end));
  let ro: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(fit); ro.observe(pad); }
  return { el: root, release: () => { curId = undefined; cur = undefined; }, destroy: () => { offs.forEach((f) => f()); ro?.disconnect(); } };
}
