// Text entry: 40 chars max; dictation comes from the OS keyboard's mic.
import { el, on, type Widget } from './core';

export const TEXT_MAX = 40;

export interface TextOpts {
  id: string;
  placeholder: string;
  onSend(text: string): void;
  onPress?(): void;
}

export function createText(o: TextOpts): Widget {
  const root = el('form', 'cp-text', { 'data-widget': o.id, autocomplete: 'off' });
  const field = el('div', 'cp-text-field');
  const input = el('input', 'cp-text-input', {
    type: 'text', placeholder: o.placeholder, enterkeyhint: 'send', autocapitalize: 'sentences', spellcheck: 'true',
  });
  input.maxLength = TEXT_MAX;
  const count = el('span', 'cp-text-count', {}, `0/${TEXT_MAX}`);
  const send = el('button', 'cp-btn cp-text-send', { type: 'submit', 'data-action': 'send', 'aria-label': 'Send' });
  send.appendChild(el('span', 'cp-btn-label', {}, 'Send'));
  field.append(input, count);
  root.append(field, send);

  const sync = () => {
    if (input.value.length > TEXT_MAX) input.value = input.value.slice(0, TEXT_MAX);
    count.textContent = `${input.value.length}/${TEXT_MAX}`;
    root.classList.toggle('is-empty', input.value.trim() === '');
  };
  sync();
  const submit = () => {
    sync();
    const v = input.value.trim();
    if (!v) return;
    o.onPress?.();
    o.onSend(v);
    input.value = '';
    sync();
    root.classList.remove('is-sent'); void root.offsetWidth; root.classList.add('is-sent');
  };
  const offs = [
    on(input, 'input', sync),
    on(root, 'submit', (e) => { e.preventDefault(); submit(); }),
    on(send, 'click', (e) => { e.preventDefault(); submit(); }),
  ];
  return { el: root, destroy: () => offs.forEach((f) => f()) };
}
