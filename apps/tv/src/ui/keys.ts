// Remote key bridge. The Android shell calls window.cadabraKey(name) on key-down with
// up|down|left|right|select|back|playpause|menu. For 'back', returning 'exit' lets the app
// close (lobby only); anything else means handled. Never throws: a throw also closes the app.
import type { Phase } from '../state/machine';
import type { FocusManager } from './focus';

export type KeyName = 'up' | 'down' | 'left' | 'right' | 'select' | 'back' | 'playpause' | 'menu';

export interface KeyTarget {
  focus: FocusManager;
  phase: () => Phase;
  onPlayPause?: () => void;
  onMenu?: () => void;
  /** Any key (after routing): wake-up / activity hooks. */
  onAny?: (name: string) => void;
}

export function routeKey(name: string, t: KeyTarget): 'exit' | 'handled' {
  switch (name) {
    case 'up': case 'down': case 'left': case 'right':
      t.focus.move(name);
      break;
    case 'select':
      t.focus.select();
      break;
    case 'back':
      if (t.focus.back()) break;
      if (t.phase() === 'lobby') return 'exit';
      break;
    case 'playpause':
      t.onPlayPause?.();
      break;
    case 'menu':
      t.onMenu?.();
      break;
  }
  t.onAny?.(name);
  return 'handled';
}

/** Menu pressed `count` times within `windowMs` -> true (debug overlay toggle). */
export class MenuTaps {
  private taps: number[] = [];
  constructor(private windowMs = 1500, private count = 3) {}
  tap(now: number): boolean {
    this.taps = [...this.taps.filter((t) => now - t <= this.windowMs), now];
    if (this.taps.length >= this.count) {
      this.taps = [];
      return true;
    }
    return false;
  }
}

const KEYBOARD: Record<string, KeyName> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'select', ' ': 'playpause', Escape: 'back', Backspace: 'back', m: 'menu', M: 'menu',
  MediaPlayPause: 'playpause', ContextMenu: 'menu',
};

/** Install window.cadabraKey (native shell) and a keyboard fallback (dev in a desktop browser). */
export function installKeyBridge(t: KeyTarget): () => void {
  const w = window as unknown as { cadabraKey?: (n: string) => string };
  w.cadabraKey = (name: string) => {
    try {
      return routeKey(name, t);
    } catch (e) {
      console.error('[tv] key handler failed', e);
      return 'handled';
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const k = KEYBOARD[e.key];
    if (!k) return;
    e.preventDefault();
    if (w.cadabraKey?.(k) === 'exit') console.info('[tv] back on lobby: exit');
  };
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    delete w.cadabraKey;
  };
}
