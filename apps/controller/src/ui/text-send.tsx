import { useState } from 'preact/hooks';
import { Btn } from './kit';

export const TEXT_MAX = 40;

/** 40-char text box with a send button. Dictation comes from the OS keyboard mic. */
export function TextSend({ placeholder, onSend, cta = 'Send' }: { placeholder: string; onSend(v: string): void; cta?: string }) {
  const [v, setV] = useState('');
  const [pulse, setPulse] = useState(0);
  const submit = () => {
    const t = v.trim();
    if (!t) return;
    onSend(t);
    setV('');
    setPulse((n) => n + 1);
  };
  return (
    <form class="text-send" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div class="text-send-field" key={pulse} data-pulse={pulse > 0 ? '1' : undefined}>
        <input
          class="text-field"
          value={v}
          placeholder={placeholder}
          maxLength={TEXT_MAX}
          enterKeyHint="send"
          autoCapitalize="sentences"
          onInput={(e) => setV((e.currentTarget as HTMLInputElement).value.slice(0, TEXT_MAX))}
        />
        <span class="text-count">{v.length}/{TEXT_MAX}</span>
      </div>
      <Btn type="submit" class={v.trim() ? '' : 'is-idle'} aria-label={cta}>{cta}</Btn>
    </form>
  );
}
