import { useRef } from 'preact/hooks';
import { CODE_LEN, normalizeCode } from '../code';
import { Btn, Wordmark } from '../ui/kit';

export const NAME_MAX = 16;

interface Props {
  code: string;
  name: string;
  busy: boolean;
  error: string;
  onCode(v: string): void;
  onName(v: string): void;
  onSubmit(): void;
}

export function JoinScreen(p: Props) {
  const nameRef = useRef<HTMLInputElement>(null);
  const slots = Array.from({ length: CODE_LEN }, (_, i) => p.code[i] ?? '');
  return (
    <section class="screen screen-join" data-screen="join">
      <header class="join-head">
        <Wordmark />
      </header>
      <div class="join-hero">
        <h1 class="display">Join the<br /><em>party.</em></h1>
        <p class="lede">Enter the code on your TV. Your phone is the controller.</p>
      </div>
      <form
        class="join-form"
        autocomplete="off"
        onSubmit={(e) => { e.preventDefault(); p.onSubmit(); }}
      >
        <label class="field-label" for="code">Room code</label>
        <div class={`code ${p.code.length === CODE_LEN ? 'is-full' : ''}`}>
          {slots.map((c, i) => (
            <span key={i} class={`code-slot ${c ? 'has' : ''} ${i === p.code.length ? 'is-next' : ''}`}>{c}</span>
          ))}
          <input
            id="code"
            name="code"
            class="code-input"
            value={p.code}
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellcheck={false}
            enterKeyHint="next"
            maxLength={CODE_LEN}
            aria-label="Room code"
            onInput={(e) => {
              const el = e.currentTarget as HTMLInputElement;
              const v = normalizeCode(el.value);
              el.value = v;
              p.onCode(v);
              if (v.length === CODE_LEN && !p.name) nameRef.current?.focus();
            }}
          />
        </div>
        <label class="field-label" for="name">Your name</label>
        <input
          ref={nameRef}
          id="name"
          name="name"
          class="text-field"
          value={p.name}
          placeholder="e.g. Maya"
          maxLength={NAME_MAX}
          autoCapitalize="words"
          autoComplete="nickname"
          enterKeyHint="go"
          onInput={(e) => p.onName((e.currentTarget as HTMLInputElement).value.slice(0, NAME_MAX))}
        />
        <div class="form-error" role="alert">{p.error}</div>
        <Btn type="submit" class="wide" disabled={p.busy}>{p.busy ? 'Joining…' : 'Join game'}</Btn>
      </form>
      <footer class="join-foot">No app to install · up to 4 players</footer>
    </section>
  );
}
