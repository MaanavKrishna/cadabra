// Settings: one row per RoomSettings field. Up/Down picks a row, Left/Right (or OK) changes it,
// Back returns to the lobby.
import { useEffect } from 'preact/hooks';
import type { HostPersonality } from '@cadabra/spec';
import { Backdrop, TopBar, focus, useFocusable } from '../ui/components';
import { QUICK_GAMES, keyArtFor } from '../fallback';
import type { PartyState, Settings as S } from '../state/machine';

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

function Row({ i, def, settings, onChange }: { i: number; def: RowDef; settings: S; onChange: (p: Partial<S>) => void }) {
  const ref = useFocusable(i, 0, {
    autofocus: i === 0,
    select: () => onChange(def.step(settings, 1)),
    left: () => { onChange(def.step(settings, -1)); return true; },
    right: () => { onChange(def.step(settings, 1)); return true; },
  });
  return (
    <div ref={ref} class="set-row">
      <div class="set-text">
        <div class="set-label">{def.label}</div>
        <div class="set-help">{def.help}</div>
      </div>
      <div class="set-value"><span class="set-arrow">‹</span><b>{def.value(settings)}</b><span class="set-arrow">›</span></div>
    </div>
  );
}

function Done({ onClose }: { onClose: () => void }) {
  const ref = useFocusable(ROWS.length, 0, { select: onClose });
  return <div ref={ref} class="set-done" onClick={onClose}>Done</div>;
}

export function Settings({ state, status, onChange, onClose }: { state: PartyState; status: string; onChange: (p: Partial<S>) => void; onClose: () => void }) {
  useEffect(() => {
    focus.setBack(() => { onClose(); return true; });
    return () => focus.setBack(undefined);
  }, [onClose]);
  return (
    <section class="screen settings">
      <Backdrop art={keyArtFor(QUICK_GAMES[0]!)} dim />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="settings-panel">
        <div class="eyebrow">House rules</div>
        <h1 class="title title-sm">Settings</h1>
        <div class="set-rows">
          {ROWS.map((r, i) => <Row key={r.label} i={i} def={r} settings={state.settings} onChange={onChange} />)}
        </div>
        <Done onClose={onClose} />
        <div class="hint">◀ ▶ change · OK toggle · Back to return</div>
      </div>
    </section>
  );
}
