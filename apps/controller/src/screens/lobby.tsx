import { useRef, useState } from 'preact/hooks';
import { AVATARS, avatarUrl } from '../avatars';
import type { ScreenData, SendReply } from '../protocol';
import { Btn, Eyebrow, Mark } from '../ui/kit';
import { selfieToToon } from '../toon';

export function AvatarScreen({ data, reply, avatar, setAvatar }: {
  data: ScreenData['avatar']; reply: SendReply; avatar?: string; setAvatar(a: string): void;
}) {
  const [pick, setPick] = useState(avatar);
  const [locked, setLocked] = useState(false);
  const [toast, setToast] = useState('');
  const [selfie, setSelfie] = useState<string>();
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ring = () => {
    const c = getComputedStyle(document.documentElement).getPropertyValue('--c-primary').trim();
    return /^#[0-9a-f]{6}$/i.test(c) ? c : '#ffb400';
  };
  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return; // camera cancelled or permission denied: keep the premade picker
    setBusy(true);
    setToast('');
    const r = await selfieToToon(file, ring());
    setBusy(false);
    if (r.ok) { setSelfie(r.dataUrl); setPick(r.dataUrl); navigator.vibrate?.(15); }
    else setToast("Couldn't use that photo. Pick a character instead!");
  };
  const taken = new Set(data.taken ?? []);
  return (
    <section class="screen screen-avatar" data-screen="avatar">
      <div class="screen-head">
        <Eyebrow>Your character</Eyebrow>
        <h1 class="display sm">Pick your <em>hero</em></h1>
      </div>
      <div class="avatar-grid" role="radiogroup">
        {selfie && (
          <button
            type="button" role="radio" aria-checked={pick === selfie} aria-label="your selfie hero" disabled={locked}
            class={`avatar-tile is-selfie ${pick === selfie ? 'is-on' : ''}`}
            onClick={() => { setPick(selfie); navigator.vibrate?.(15); }}
          >
            <img src={selfie} alt="" draggable={false} />
          </button>
        )}
        {AVATARS.map((a) => {
          const isTaken = taken.has(a.key) && a.key !== avatar;
          return (
            <button
              key={a.key}
              type="button"
              role="radio"
              aria-checked={pick === a.key}
              aria-label={a.key}
              disabled={isTaken || locked}
              class={`avatar-tile ${pick === a.key ? 'is-on' : ''} ${isTaken ? 'is-taken' : ''}`}
              onClick={() => { setPick(a.key); navigator.vibrate?.(15); }}
            >
              <img src={a.url} alt="" draggable={false} />
            </button>
          );
        })}
      </div>
      <div class="dock two">
        {toast && <div class="toast" role="status">{toast}</div>}
        <input
          ref={fileRef} type="file" accept="image/*" capture="user" hidden data-testid="selfie-input"
          onChange={onFile}
        />
        <Btn variant="glass" disabled={locked || busy} onClick={() => fileRef.current?.click()}>
          <CameraIcon /> {busy ? 'Toonifying…' : selfie ? 'Retake' : 'Selfie'}
        </Btn>
        <Btn
          class="wide"
          disabled={!pick || locked}
          onClick={() => { if (!pick) return; setLocked(true); setAvatar(pick); reply({ reply: 'avatar.pick', avatar: pick }); }}
        >
          {locked ? 'Locked in ✓' : 'Lock in'}
        </Btn>
      </div>
    </section>
  );
}

function CameraIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" stroke-linejoin="round" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

export function WaitScreen({ data, name, avatar }: { data: ScreenData['wait']; name: string; avatar?: string }) {
  const url = avatarUrl(avatar);
  return (
    <section class="screen screen-wait" data-screen="wait">
      <div class="orb" aria-hidden="true">
        <div class="orb-ring" />
        <div class="orb-ring r2" />
        {url ? <img class="orb-avatar" src={url} alt="" /> : <Mark size={72} />}
      </div>
      <h1 class="display sm center">{data.message ?? <>You're in{name ? <>, <em>{name}</em></> : null}!</>}</h1>
      <p class="lede center">{data.sub ?? 'Eyes on the TV. The fun starts there.'}</p>
    </section>
  );
}

export function BlockedScreen({ data }: { data: ScreenData['blocked'] }) {
  return (
    <section class="screen screen-blocked" data-screen="blocked">
      <div class="badge-icon" aria-hidden="true">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" stroke-linejoin="round" />
          <path d="M9 12l2 2 4-4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <h1 class="display sm center">Let's keep it <em>family‑friendly</em></h1>
      <p class="lede center">{data.message ?? "That one didn't make it past the filter. Try something else!"}</p>
    </section>
  );
}
