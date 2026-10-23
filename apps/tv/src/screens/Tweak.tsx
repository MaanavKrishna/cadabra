// Tweak / Remix (R2): change the rules between rounds. Three beats on one screen:
//  ask        10 s: phones tap chips or type; requests land as glass chips in three slots (max 3).
//             The TV can add chips with the D-pad too, so a room with no phones is never stuck.
//  rebuilding the AI patches the spec (a thin shimmer line and the backend's step).
//  done       a "What changed" card ("Gravity ×0.4 · Bounce ↑"), then the replay starts.
// Timers live in the app; this only renders state.
import { useEffect } from 'preact/hooks';
import { themeVars } from '@cadabra/render';
import { Avatar, HeroLayers, Pill, TopBar, focus, useFocusable } from '../ui/components';
import { displayTitle } from '../ui/hero';
import { keyArtFor } from '../fallback';
import { Ring, useSecondsLeft } from './Forge';
import { MAX_TWEAKS, TWEAK_CHIPS, TWEAK_CHIP_LABELS, askLabel, type TweakChip } from '../tweak/tweak';
import type { PartyState } from '../state/machine';

export interface TweakProps {
  state: PartyState;
  status: string;
  endsAt?: number;
  total: number;
  /** The "What changed" card's replay countdown ends here (performance.now clock). */
  playAt?: number;
  onChip: (chip: TweakChip) => void;
  onRebuild: () => void;
  onCancel: () => void;
}

const CHIP_ICON: Record<TweakChip, string> = {
  'low-gravity': 'M32 8a24 24 0 1 0 0 48a18 18 0 1 1 0-48z',
  faster: 'M8 20h22M4 32h26M8 44h22M34 14l20 18-20 18z',
  'bigger-arena': 'M10 24V10h14M54 24V10H40M10 40v14h14M54 40v14H40',
  bouncier: 'M8 52h48M20 40a8 8 0 1 0 16 0a8 8 0 1 0-16 0M30 28c4-10 10-16 18-18',
  'more-chaos': 'M32 6l6 18 18-6-12 14 14 10-18 2 2 18-10-14-10 14 2-18-18-2 14-10L8 18l18 6z',
  'harder-for-leader': 'M10 46l10-24 12 14 12-26 10 36zM10 54h44',
};

function ChipIcon({ chip }: { chip: TweakChip }) {
  return (
    <svg class="tw-ico" viewBox="0 0 64 64" aria-hidden="true">
      <path d={CHIP_ICON[chip]} fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  );
}

function ChipBtn({ chip, i, on, full, onSelect }: { chip: TweakChip; i: number; on: boolean; full: boolean; onSelect: () => void }) {
  const ref = useFocusable(0, i, { autofocus: i === 0, select: onSelect });
  return (
    <div ref={ref} class={`tw-chip ${on ? 'is-on' : ''} ${full && !on ? 'is-off' : ''}`} onClick={onSelect}>
      <ChipIcon chip={chip} /><span>{TWEAK_CHIP_LABELS[chip]}</span>
    </div>
  );
}

function Countdown({ at }: { at?: number }) {
  const left = useSecondsLeft(at);
  return <span>{left === undefined ? 'Get set…' : left > 0 ? `Replaying in ${left}…` : 'Here we go!'}</span>;
}

export function Tweak({ state, status, endsAt, total, playAt, onChip, onRebuild, onCancel }: TweakProps) {
  const t = state.tweak!;
  const spec = t.base;
  const stage = t.stage;
  useEffect(() => {
    focus.setBack(() => { if (stage === 'ask') onCancel(); return true; });
    return () => focus.setBack(undefined);
  }, [onCancel, stage]);

  const byId = new Map(state.players.map((p, i) => [p.id, { p, i }]));
  const art = keyArtFor(spec, t.art.keyArt ?? state.art.keyArt);
  const title = displayTitle(spec.title);
  const picked = new Set(t.asks.map((a) => a.chip).filter(Boolean));
  const full = t.asks.length >= MAX_TWEAKS;
  const slots = Array.from({ length: MAX_TWEAKS }, (_, i) => t.asks[i]);
  const r = t.result;

  return (
    <section class={`screen tweak-screen is-${stage}`} style={themeVars(spec.theme)}>
      <div class="forge-bg">
        <HeroLayers url={art.backdrop} />
        <div class="scrim" />
      </div>
      <TopBar code={state.code} players={state.players} status={status} />

      {stage !== 'done' && (
        <div class="tw-stage" key="ask">
          <div class="eyebrow">{t.mode === 'remix' ? 'Remix' : 'Tweak'} · {title}</div>
          <h1 class="title">{stage === 'ask' ? 'Change the rules' : 'Rebuilding…'}</h1>
          <p class="hook">
            {stage === 'ask'
              ? 'Tap a chip on your phone or type anything: “giant players”, “ice floor”, “double points”.'
              : t.step ?? 'Patching the game and letting the bots try it.'}
          </p>
          {stage === 'ask' ? (
            <>
              <div class="tw-chips">
                {TWEAK_CHIPS.map((c, i) => (
                  <ChipBtn key={c} chip={c} i={i} on={picked.has(c)} full={full} onSelect={() => onChip(c)} />
                ))}
              </div>
              <div class="tw-actions">
                <Pill row={1} col={0} label={t.asks.length ? 'Rebuild now' : 'Replay as is'} icon={t.asks.length ? 'spark' : 'again'} primary onSelect={onRebuild} />
                <span class="hint">Back cancels</span>
              </div>
            </>
          ) : (
            <div class="forge-line tw-line"><i /></div>
          )}
        </div>
      )}

      {stage !== 'done' && (
        <aside class="tw-side">
          {stage === 'ask' && <Ring endsAt={endsAt} total={total} />}
          <div class="tw-slots">
            {slots.map((a, i) => {
              const who = a ? byId.get(a.by) : undefined;
              return a ? (
                <div key={`${i}-${askLabel(a)}`} class="tw-slot is-in" style={{ animationDelay: '0s' }}>
                  {who ? <Avatar p={who.p} size={64} index={who.i} /> : <span class="tw-tv">TV</span>}
                  <b>{askLabel(a)}</b>
                  {a.chip && <ChipIcon chip={a.chip} />}
                </div>
              ) : (
                <div key={`empty-${i}`} class="tw-slot is-empty"><span>{stage === 'ask' ? 'Waiting for an idea…' : '—'}</span></div>
              );
            })}
          </div>
        </aside>
      )}

      {stage === 'done' && r && (
        <div class="tw-done glass" key="done">
          <div class="eyebrow">What changed</div>
          <h1 class="title title-sm">{r.source === 'none' ? 'Same rules, round two' : displayTitle(r.spec.title)}</h1>
          <p class="tw-summary">{r.source === 'none' ? 'Nothing to change this time. Replaying!' : r.summary}</p>
          {r.changes.length > 0 && (
            <div class="tw-tags">{r.changes.map((c, i) => <span key={c} class="tw-tag" style={{ animationDelay: `${0.25 + i * 0.12}s` }}>{c}</span>)}</div>
          )}
          <div class="tw-foot"><Countdown at={playAt} /></div>
        </div>
      )}
    </section>
  );
}
