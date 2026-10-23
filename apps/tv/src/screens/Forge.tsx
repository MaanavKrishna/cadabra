// The AI forge screens (Task 19 / N3): Idea Storm, Pitches (cooking + vote) and the Forge build.
// Each screen has one orchestrated moment (chips popping in, cards dealing in, steps snapping in);
// timers live in the app, these only render state.
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Pitch } from '@cadabra/spec';
type Palette = Pitch['palette'];
import { Avatar, NeonBg, TopBar, colorOf, focus, useFocusable } from '../ui/components';
import { pickWinner, shownPct, stepRows, tally } from '../forge/forge';
import type { PartyState } from '../state/machine';

export const paletteVars = (p: Palette): JSX.CSSProperties =>
  ({ '--c-bg': p.bg, '--c-primary': p.primary, '--c-accent': p.accent, '--c-glow': p.glow, '--c-text': p.text }) as JSX.CSSProperties;

/** Seconds left until `endsAt` (ms, performance.now clock), refreshed 4x a second. */
function useSecondsLeft(endsAt: number | undefined): number | undefined {
  const calc = () => (endsAt === undefined ? undefined : Math.max(0, Math.ceil((endsAt - performance.now()) / 1000)));
  const [s, setS] = useState(calc);
  useEffect(() => {
    setS(calc());
    if (endsAt === undefined) return;
    const id = setInterval(() => setS(calc()), 250);
    return () => clearInterval(id);
  }, [endsAt]);
  return s;
}

function Ring({ endsAt, total }: { endsAt?: number; total: number }) {
  const left = useSecondsLeft(endsAt);
  const r = 88;
  const c = 2 * Math.PI * r;
  const frac = left === undefined ? 1 : left / total;
  return (
    <div class={`ring ${left !== undefined && left <= 5 ? 'is-hot' : ''}`}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r={r} class="ring-bg" />
        <circle cx="100" cy="100" r={r} class="ring-fg" style={{ strokeDasharray: `${c}`, strokeDashoffset: `${c * (1 - frac)}` }} />
      </svg>
      <b>{left ?? '…'}</b>
    </div>
  );
}

/** Where ingredient chips land in the cloud (deterministic slots, 1080p px). */
const SLOTS = [
  [1180, 330], [1500, 250], [1360, 470], [1080, 560], [1620, 420], [1250, 690],
  [1560, 620], [980, 400], [1420, 800], [1700, 760], [1080, 800], [1300, 190],
] as const;
const TILT = [-4, 3, -2, 5, -3, 2, -5, 4, -1, 3, -4, 2];

function Chips({ state }: { state: PartyState }) {
  const idx = new Map(state.players.map((p, i) => [p.id, i]));
  return (
    <div class="chips" aria-live="polite">
      {state.ingredients.map((g, i) => {
        const [x, y] = SLOTS[i % SLOTS.length]!;
        const c = colorOf(idx.get(g.by) ?? i);
        return (
          <div key={`${i}-${g.text}`} class="chip" style={{ left: `${x}px`, top: `${y}px`, ['--chip' as string]: c, ['--tilt' as string]: `${TILT[i % TILT.length]}deg` }}>
            {g.text}
          </div>
        );
      })}
    </div>
  );
}

export interface StormProps { state: PartyState; status: string; endsAt?: number; total: number; onCook: () => void; onCancel: () => void }

export function Storm({ state, status, endsAt, total, onCook, onCancel }: StormProps) {
  const ref = useFocusable(0, 0, { autofocus: true, select: onCook });
  useEffect(() => {
    focus.setBack(() => { onCancel(); return true; });
    return () => focus.setBack(undefined);
  }, [onCancel]);
  const humans = state.players.filter((p) => !p.isBot);
  const counts = new Map<string, number>();
  for (const g of state.ingredients) counts.set(g.by, (counts.get(g.by) ?? 0) + 1);
  return (
    <section class="screen forge-screen storm">
      <NeonBg />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="hero hero-storm">
        <div class="eyebrow">Idea Storm · create a game</div>
        <h1 class="title">Throw in <em>ingredients!</em></h1>
        <p class="hook">Type anything on your phone: a place, a creature, a silly rule. The AI mixes them into three brand-new games.</p>
        <div class="storm-row">
          <Ring endsAt={endsAt} total={total} />
          <div class="storm-who">
            {humans.length === 0 && <span class="hint">No phones yet: scan the code to join, or cook with our ideas.</span>}
            {humans.map((p) => (
              <div key={p.id} class="storm-p">
                <Avatar p={p} size={84} index={state.players.indexOf(p)} />
                <b>{counts.get(p.id) ?? 0}</b>
              </div>
            ))}
          </div>
        </div>
        <div ref={ref} class="btn-neon">{state.ingredients.length ? 'Cook it now' : 'Surprise us'}</div>
        <div class="hint">OK to cook early · Back to cancel</div>
      </div>
      <Chips state={state} />
    </section>
  );
}

function PitchCard({ p, i, art, count, voters, tv, onFocus, onSelect }: {
  p: Pitch; i: number; art?: string; count: number; voters: PartyState['players']; tv: boolean;
  onFocus: () => void; onSelect: () => void;
}) {
  const ref = useFocusable(0, i, { autofocus: i === 1, focus: onFocus, select: onSelect });
  return (
    <div ref={ref} class={`pitch-card ${tv ? 'is-tv' : ''}`} style={{ ...paletteVars(p.palette), animationDelay: `${0.12 + i * 0.14}s` }} onClick={onSelect}>
      <div class="pitch-art" style={art ? { backgroundImage: `url("${art}")` } : undefined} />
      <div class="pitch-letter">{String.fromCharCode(65 + i)}</div>
      <div class="pitch-body">
        <h2>{p.title}</h2>
        <p>{p.hook}</p>
      </div>
      <div class="pitch-votes">
        <b key={count} class="pitch-count">{count}</b>
        <span class="pitch-voters">
          {voters.map((v) => <Avatar key={v.id} p={v} size={56} index={0} ring={false} />)}
        </span>
        {tv && <span class="pitch-tv">TV pick</span>}
      </div>
    </div>
  );
}

export interface PitchesProps { state: PartyState; status: string; endsAt?: number; total: number; onTvVote: (i: number) => void; onFocusPitch: (i: number) => void; onCancel: () => void }

export function Pitches({ state, status, endsAt, total, onTvVote, onFocusPitch, onCancel }: PitchesProps) {
  useEffect(() => {
    focus.setBack(() => { onCancel(); return true; });
    return () => focus.setBack(undefined);
  }, [onCancel]);
  const cooking = state.phase === 'pitching' || state.pitches.length === 0;
  const counts = tally(state.votes, state.pitches.length);
  const lead = state.pitches.length ? pickWinner(state.votes, state.pitches.length, state.forge.tvVote) : -1;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  return (
    <section class={`screen forge-screen pitches ${cooking ? 'is-cooking' : ''}`}>
      <NeonBg />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="pitches-head">
        <div>
          <div class="eyebrow">{cooking ? 'The AI is cooking' : 'Vote on your phone'}</div>
          <h1 class="title title-sm">{cooking ? 'Dreaming up three games…' : 'Which one do we play?'}</h1>
        </div>
        {!cooking && <Ring endsAt={endsAt} total={total} />}
      </div>
      {cooking ? (
        <div class="pitch-row">
          {[0, 1, 2].map((i) => <div key={i} class="pitch-card is-blank" style={{ animationDelay: `${i * 0.2}s` }}><div class="pitch-shimmer" /></div>)}
          <div class="cook-chips">{state.ingredients.slice(-8).map((g, i) => <span key={i} class="chip chip-sm">{g.text}</span>)}</div>
        </div>
      ) : (
        <div class="pitch-row">
          {state.pitches.map((p, i) => (
            <PitchCard
              key={p.id} p={p} i={i} art={state.forge.art[p.id]?.keyArt} count={counts[i] ?? 0}
              voters={Object.entries(state.votes).filter(([, v]) => v === i).map(([id]) => byId.get(id)!).filter(Boolean)}
              tv={state.forge.tvVote === i}
              onFocus={() => onFocusPitch(i)} onSelect={() => onTvVote(i)}
            />
          ))}
        </div>
      )}
      {!cooking && (
        <div class="hint pitches-hint">
          {lead >= 0 && <span class="lead-pill" style={paletteVars(state.pitches[lead]!.palette)}>Leading: {state.pitches[lead]!.title}</span>}
          OK casts the TV's tie-break vote
        </div>
      )}
    </section>
  );
}

export interface ForgeProps { state: PartyState; status: string }

export function ForgeBuild({ state, status }: ForgeProps) {
  const w = state.forge.winner ?? '';
  const p = state.pitches.find((x) => x.id === w);
  const progress = state.forge.progress[w];
  const ready = !!state.forge.ready[w];
  const rows = stepRows(progress, ready);
  const pct = shownPct(progress, ready);
  const art = state.forge.art[w]?.keyArt;
  useEffect(() => {
    focus.setBack(() => true); // no way out mid-build: it takes seconds
    return () => focus.setBack(undefined);
  }, []);
  return (
    <section class={`screen forge-screen forge ${ready ? 'is-ready' : ''}`} style={p ? paletteVars(p.palette) : undefined}>
      <NeonBg />
      {art && <div class="forge-art" style={{ backgroundImage: `url("${art}")` }} />}
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="hero hero-forge">
        <div class="eyebrow">Forging your game</div>
        <h1 class="title">{p?.title ?? 'Your game'}</h1>
        <p class="hook">{p?.hook}</p>
      </div>
      <div class="forge-steps">
        {rows.map((r, i) => (
          <div key={r.label} class={`fstep is-${r.state}`} style={{ animationDelay: `${0.1 + i * 0.12}s` }}>
            <span class="fstep-box">{r.state === 'done' ? '✓' : i + 1}</span>
            <span class="fstep-label">
              {r.label}
              {r.state === 'active' && progress?.step && progress.step !== r.label && <small>{progress.step}</small>}
            </span>
          </div>
        ))}
      </div>
      <div class="forge-bar">
        <div class="forge-fill" style={{ transform: `scaleX(${pct / 100})` }} />
        <b>{pct}%</b>
      </div>
      <div class="forge-ings">{state.ingredients.slice(-6).map((g, i) => <span key={i} class="chip chip-sm">{g.text}</span>)}</div>
    </section>
  );
}
