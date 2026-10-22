// Hold button: same edges as a button (true on down, false on up) with a charging visual.
import { createButton, type ButtonOpts } from './button';
import type { Widget } from './core';

export function createHold(o: Omit<ButtonOpts, 'variant'>): Widget {
  return createButton({ ...o, variant: 'hold' });
}
