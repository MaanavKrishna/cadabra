// mountController: lays out a game's ControlWidget[] and turns touches into InputFrames.
import type { ControlWidget, InputFrame } from '@cadabra/spec';
import { el, haptic, PRESS_HAPTIC_MS, type Axes, type Widget } from './core';
import { createButton } from './button';
import { createDraw } from './draw';
import { createHold } from './hold';
import { createJoystick } from './joystick';
import { createSwipe } from './swipe';
import { createText } from './text';
import { createTilt } from './tilt';
import { createVote } from './vote';
import { ensureStyles } from './styles';

export * from './core';
export * from './button';
export * from './draw';
export * from './hold';
export * from './joystick';
export * from './png';
export * from './swipe';
export * from './text';
export * from './tilt';
export * from './vote';
export { ensureStyles, WIDGET_CSS } from './styles';

export interface MountOpts {
  /** Timestamp source for frames (ms). Defaults to performance.now(). */
  now?: () => number;
}

const STICK = new Set(['joystick', 'tilt', 'swipe']);
const ACTION = new Set(['button', 'hold']);

export function mountController(
  host: HTMLElement,
  widgets: ControlWidget[],
  onFrame: (f: InputFrame) => void,
  opts: MountOpts = {},
): () => void {
  ensureStyles();
  const now = opts.now ?? (() => (globalThis.performance?.now?.() ?? Date.now()));
  const hasAxes = widgets.some((w) => w.kind === 'joystick');
  const hasTilt = widgets.some((w) => w.kind === 'tilt');
  const buttonIds = widgets.filter((w) => ACTION.has(w.kind)).map((w) => w.id);

  let axes: Axes = { x: 0, y: 0 };
  let tilt: Axes = { x: 0, y: 0 };
  const buttons: Record<string, boolean> = Object.fromEntries(buttonIds.map((id) => [id, false]));

  const hasContinuous = hasAxes || hasTilt || buttonIds.length > 0;
  let dead = false;
  const frame = (): InputFrame => {
    const f: InputFrame = { t: now() };
    if (hasAxes) f.axes = { ...axes };
    if (hasTilt) f.tilt = { ...tilt };
    if (buttonIds.length) f.buttons = { ...buttons };
    return f;
  };
  const emitContinuous = () => { if (!dead) onFrame(frame()); };
  const isActive = () => axes.x !== 0 || axes.y !== 0 || tilt.x !== 0 || tilt.y !== 0 || buttonIds.some((id) => buttons[id]);
  const zero = () => {
    axes = { x: 0, y: 0 };
    tilt = { x: 0, y: 0 };
    for (const id of buttonIds) buttons[id] = false;
  };
  /** Drop every held input (focus lost, tab hidden). One zeroed frame stops the transport keepalive. */
  const releaseAll = () => {
    for (const p of parts) p.release?.();
    const was = isActive();
    zero();
    if (was) emitContinuous();
  };
  const press = () => haptic(PRESS_HAPTIC_MS);

  const stickZone = el('div', 'cp-zone cp-zone-stick');
  const actionZone = el('div', 'cp-zone cp-zone-actions');
  const panelZone = el('div', 'cp-zone cp-zone-panel');
  const parts: Widget[] = [];

  for (const w of widgets) {
    let part: Widget;
    switch (w.kind) {
      case 'joystick':
        part = createJoystick({ id: w.id, onPress: press, onChange: (a) => { axes = a; emitContinuous(); } });
        break;
      case 'tilt':
        part = createTilt({ id: w.id, onPress: press, onChange: (a) => { tilt = a; emitContinuous(); } });
        break;
      case 'button':
      case 'hold': {
        const make = w.kind === 'hold' ? createHold : createButton;
        part = make({ id: w.id, label: w.label, onPress: press, onChange: (d) => { buttons[w.id] = d; emitContinuous(); } });
        break;
      }
      case 'swipe':
        part = createSwipe({ id: w.id, onSwipe: (d) => { if (dead) return; press(); onFrame({ t: now(), swipe: d }); } });
        break;
      case 'draw':
        part = createDraw({ id: w.id, prompt: w.prompt, onPress: press, onDone: (png) => { if (!dead) onFrame({ t: now(), draw: png }); } });
        break;
      case 'vote':
        part = createVote({ id: w.id, options: w.options, onPress: press, onVote: (i) => { if (!dead) onFrame({ t: now(), vote: i }); } });
        break;
      case 'text':
        part = createText({ id: w.id, placeholder: w.placeholder, onPress: press, onSend: (s) => { if (!dead) onFrame({ t: now(), text: s }); } });
        break;
      default:
        continue;
    }
    parts.push(part);
    (STICK.has(w.kind) ? stickZone : ACTION.has(w.kind) ? actionZone : panelZone).appendChild(part.el);
  }

  const root = el('div', 'cp-controller');
  const zones = [stickZone, actionZone, panelZone].filter((z) => z.childElementCount > 0);
  root.dataset.layout = stickZone.childElementCount && actionZone.childElementCount ? 'pad' : 'stack';
  root.dataset.zones = String(zones.length);
  actionZone.dataset.count = String(actionZone.childElementCount);
  // Portrait, one thumb: panels on top, actions in the middle, the stick nearest the thumb.
  root.append(...[panelZone, actionZone, stickZone].filter((z) => z.childElementCount > 0));
  host.appendChild(root);

  const onBlur = () => releaseAll();
  const onVis = () => { if (document.visibilityState === 'hidden') releaseAll(); };
  globalThis.addEventListener?.('blur', onBlur);
  document.addEventListener('visibilitychange', onVis);

  return () => {
    if (dead) return;
    globalThis.removeEventListener?.('blur', onBlur);
    document.removeEventListener('visibilitychange', onVis);
    for (const p of parts) p.release?.();
    dead = true; // widget callbacks during teardown are ignored
    for (const p of parts) p.destroy();
    root.remove();
    // Unmounted mid-hold: always send one zeroed frame so nothing stays pressed on the TV.
    if (hasContinuous) { zero(); onFrame(frame()); }
  };
}
