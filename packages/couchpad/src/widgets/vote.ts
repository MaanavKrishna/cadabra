// Vote: big option cards; tapping one sends its index (can be changed).
import { el, on, type Widget } from './core';

export interface VoteOpts {
  id: string;
  options: string[];
  onVote(i: number): void;
  onPress?(): void;
}

export function createVote(o: VoteOpts): Widget {
  const root = el('div', 'cp-vote', { 'data-widget': o.id, role: 'radiogroup' });
  const offs: (() => void)[] = [];
  const btns = o.options.map((label, i) => {
    const b = el('button', 'cp-vote-option', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-option': String(i) });
    b.append(el('span', 'cp-vote-badge', {}, String.fromCharCode(65 + i)), el('span', 'cp-vote-label', {}, label), el('span', 'cp-vote-check'));
    offs.push(on(b, 'click', () => {
      btns.forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      o.onPress?.();
      o.onVote(i);
    }));
    root.appendChild(b);
    return b;
  });
  return { el: root, destroy: () => offs.forEach((f) => f()) };
}
