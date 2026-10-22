// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { FocusManager } from '../src/ui/focus';
import { routeKey } from '../src/ui/keys';

function tiles(fm: FocusManager, n: number, row = 0): HTMLElement[] {
  return Array.from({ length: n }, (_, col) => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    fm.register(el, row, col);
    return el;
  });
}

describe('focus', () => {
  test('focus moves right along tile row and wraps not', () => {
    const fm = new FocusManager();
    const row = tiles(fm, 3);
    expect(fm.current).toBe(row[0]);
    expect(row[0]!.classList.contains('is-focused')).toBe(true);
    fm.move('right');
    expect(fm.current).toBe(row[1]);
    expect(row[0]!.classList.contains('is-focused')).toBe(false);
    fm.move('right');
    fm.move('right'); // at the end: stays, no wrap
    expect(fm.current).toBe(row[2]);
    fm.move('left');
    expect(fm.current).toBe(row[1]);
  });

  test('up/down jump between rows to the nearest column; select clicks', () => {
    const fm = new FocusManager();
    const top = tiles(fm, 2, 0);
    const bottom = tiles(fm, 5, 1);
    fm.focus(bottom[4]!);
    fm.move('up');
    expect(fm.current).toBe(top[1]);
    const onClick = vi.fn();
    top[1]!.addEventListener('click', onClick);
    fm.select();
    expect(onClick).toHaveBeenCalledOnce();
    fm.move('down');
    expect(fm.current).toBe(bottom[1]);
  });

  test('item handlers consume left/right (settings rows)', () => {
    const fm = new FocusManager();
    const el = document.createElement('div');
    const right = vi.fn(() => true);
    fm.register(el, 0, 0, { right });
    const other = tiles(fm, 1, 0)[0]!;
    fm.focus(el);
    fm.move('right');
    expect(right).toHaveBeenCalled();
    expect(fm.current).toBe(el);
    expect(other.classList.contains('is-focused')).toBe(false);
  });

  test('unregister moves focus to a neighbour', () => {
    const fm = new FocusManager();
    const els = [document.createElement('div'), document.createElement('div')];
    const offs = els.map((el, i) => fm.register(el, 0, i));
    offs[0]!();
    expect(fm.current).toBe(els[1]);
  });

  test('back from lobby returns exit', () => {
    const fm = new FocusManager();
    tiles(fm, 3);
    expect(routeKey('back', { focus: fm, phase: () => 'lobby' })).toBe('exit');
    // elsewhere Back is handled (never closes the app mid-party)
    expect(routeKey('back', { focus: fm, phase: () => 'play' })).toBe('handled');
    expect(routeKey('back', { focus: fm, phase: () => 'results' })).toBe('handled');
    // a screen that handles Back itself (settings) keeps the app open
    fm.setBack(() => true);
    expect(routeKey('back', { focus: fm, phase: () => 'lobby' })).toBe('handled');
    // other keys route to focus / callbacks
    const playPause = vi.fn();
    expect(routeKey('playpause', { focus: fm, phase: () => 'play', onPlayPause: playPause })).toBe('handled');
    expect(playPause).toHaveBeenCalledOnce();
    expect(routeKey('nonsense', { focus: fm, phase: () => 'lobby' })).toBe('handled');
  });
});

import { MenuTaps } from '../src/ui/keys';
test('menu pressed 3 times quickly toggles the debug overlay', () => {
  const m = new MenuTaps(1500);
  expect(m.tap(0)).toBe(false);
  expect(m.tap(400)).toBe(false);
  expect(m.tap(800)).toBe(true);
  expect(m.tap(5000)).toBe(false);
  expect(m.tap(7000)).toBe(false); // too slow: window restarts
  expect(m.tap(7100)).toBe(false);
  expect(m.tap(7200)).toBe(true);
});
