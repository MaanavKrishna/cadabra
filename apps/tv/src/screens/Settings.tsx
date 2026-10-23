// Settings: one row per RoomSettings field. Up/Down picks a row, Left/Right (or OK) changes it,
// Back returns to the lobby.
import { useEffect, useState } from 'preact/hooks';
import type { HostPersonality } from '@cadabra/spec';
import { Backdrop, TopBar, focus, useFocusable } from '../ui/components';
import { QUICK_GAMES, keyArtFor } from '../fallback';
import type { PartyState, Settings as S } from '../state/machine';
import { loadMusicVolume, musicLabel, saveMusicVolume, stepMusic } from '../audio-prefs';

const ROUND_SECS = [60, 75, 90, 105, 120];
const PERSONALITIES: HostPersonality[] = ['cheeky', 'hype', 'calm'];
const PERSONALITY_LABEL: Record<HostPersonality, string> = { cheeky: 'Cheeky', hype: 'Hype', calm: 'Calm' };

interface RowDef {
  label: string;
  help: string;
  value: (s: S) => string;
  step: (s: S, dir: 1 | -1) => Partial<S>;
}

const cycle = <T,>(list: readonly T[], cur: T, dir: 1 | -1): T => {
  const i = list.indexOf(cur);
  return list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + dir))]!;
};

export const ROWS: RowDef[] = [
  { label: 'Family-safe mode', help: 'Screens ideas, names and generated text for all ages.', value: (s) => (s.familySafe ? 'On' : 'Off'), step: (s) => ({ familySafe: !s.familySafe }) },
  { label: 'Bots', help: 'AI players can fill empty seats.', value: (s) => (s.bots ? 'On' : 'Off'), step: (s) => ({ bots: !s.bots }) },
  { label: 'Host voice', help: 'Captions always show, even with the voice off.', value: (s) => (s.hostVoice ? 'On' : 'Off'), step: (s) => ({ hostVoice: !s.hostVoice }) },
  { label: 'Round length', help: 'A surprise mid-round, a twist in the last 10 s.', value: (s) => `${s.roundSec} s`, step: (s, d) => ({ roundSec: cycle(ROUND_SECS, s.roundSec, d) }) },
  { label: 'Rounds per game night', help: 'How many games before the grand finale.', value: (s) => `${s.rounds}`, step: (s, d) => ({ rounds: Math.max(1, Math.min(10, s.rounds + d)) }) },
  { label: 'Host personality', help: 'How the host talks to the room.', value: (s) => PERSONALITY_LABEL[s.hostPersonality], step: (s, d) => ({ hostPersonality: cycle(PERSONALITIES, s.hostPersonality, d) }) },
];

function Row({ i, label, value, onStep, onFocus }: { i: number; label: string; value: string; onStep: (d: 1 | -1) => void; onFocus: () => void }) {
  const ref = useFocusable(i, 0, {
    autofocus: i === 0,
    select: () => onStep(1),
    left: () => { onStep(-1); return true; },
    right: () => { onStep(1); return true; },
    focus: onFocus,
  });
  return (
    <div ref={ref} class="set-row">
      <div class="set-label">{label}</div>
      <div class="set-value"><span class="set-arrow">‹</span><b>{value}</b><span class="set-arrow">›</span></div>
    </div>
  );
}

const MUSIC_HELP = 'Party music under the game. The host voice always ducks it.';

function Done({ onClose }: { onClose: () => void }) {
  const ref = useFocusable(ROWS.length + 1, 0, { select: onClose });
  return <div ref={ref} class="set-done" onClick={onClose}>Done</div>;
}

export function Settings({ state, status, onChange, onClose }: { state: PartyState; status: string; onChange: (p: Partial<S>) => void; onClose: () => void }) {
  const [focused, setFocused] = useState(0);
  const [music, setMusic] = useState(loadMusicVolume);
  useEffect(() => {
    focus.setBack(() => { onClose(); return true; });
    return () => focus.setBack(undefined);
  }, [onClose]);
  const help = focused < ROWS.length ? ROWS[focused]!.help : focused === ROWS.length ? MUSIC_HELP : 'Back to the lobby.';
  const label = focused < ROWS.length ? ROWS[focused]!.label : focused === ROWS.length ? 'Music volume' : 'Done';
  return (
    <section class="screen settings">
      <Backdrop art={keyArtFor(QUICK_GAMES[0]!)} dim />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="settings-panel">
        <div class="eyebrow">House rules</div>
        <h1 class="title title-sm">Settings</h1>
        <div class="set-rows">
          {ROWS.map((r, i) => (
            <Row key={r.label} i={i} label={r.label} value={r.value(state.settings)} onStep={(d) => onChange(r.step(state.settings, d))} onFocus={() => setFocused(i)} />
          ))}
          <Row
            i={ROWS.length} label="Music volume" value={musicLabel(music)} onFocus={() => setFocused(ROWS.length)}
            onStep={(d) => { const v = stepMusic(music, d); setMusic(v); saveMusicVolume(v); }}
          />
        </div>
        <Done onClose={onClose} />
      </div>
      <aside class="set-aside" key={focused}>
        <div class="set-aside-lbl">{label}</div>
        <p>{help}</p>
        <div class="hint">◀ ▶ change · OK toggle · Back to return</div>
      </aside>
    </section>
  );
}
