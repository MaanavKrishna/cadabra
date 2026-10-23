// The AI forge screens (Task 19 / N3): Idea Storm, Pitches (cooking + vote) and the Forge build.
// Each screen has one orchestrated moment (chips popping in, cards dealing in, steps snapping in);
// timers live in the app, these only render state.
import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Pitch } from '@cadabra/spec';
type Palette = Pitch['palette'];
import { Avatar, HeroLayers, NeonBg, TopBar, colorOf, focus, useFocusable } from '../ui/components';
import { HERO } from '../ui/hero';
import { NeonIcon } from './Play';
import { pickWinner, shownPct, stepRows, tally } from '../forge/forge';
import type { PartyState } from '../state/machine';

export const paletteVars = (p: Palette): JSX.CSSProperties =>
  ({ '--c-bg': p.bg, '--c-primary': p.primary, '--c-accent': p.accent, '--c-glow': p.glow, '--c-text': p.text }) as JSX.CSSProperties;

/** Seconds left until `endsAt` (ms, performance.now clock), refreshed 4x a second. */
export function useSecondsLeft(endsAt: number | undefined): number | undefined {
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

export function Ring({ endsAt, total }: { endsAt?: number; total: number }) {
  const left = useSecondsLeft(endsAt);
  const r = 92;
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
          <div key={`${i}-${g.text}`} class="chip" style={{ left: `${x}px`, top: `${y}px`, ['--chip' as string]: c, ['--tilt' as string]: `${(TILT[i % TILT.length] ?? 0) * 0.4}deg`, ['--d' as string]: `${(i % 4) * 0.9}s` }}>
            <i />{g.text}
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
      <NeonBg url={HERO.create} />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="hero hero-storm">
        <div class="eyebrow">Idea Storm</div>
        <h1 class="title">Throw in your ideas</h1>
        <p class="hook">Type anything on your phone: a place, a creature, a silly rule. The AI mixes them into three new games.</p>
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
        <div class="storm-actions">
          <div ref={ref} class="pill-btn is-primary"><span>{state.ingredients.length ? 'Cook it now' : 'Surprise us'}</span></div>
          <span class="hint">Back cancels</span>
        </div>
      </div>
      <Chips state={state} />
    </section>
  );
}

const SKETCH_ICON: [RegExp, string][] = [
  [/ring|shove|push|arena/i, 'shove'], [/collect|grab|core|loot/i, 'core'], [/sneak|guard|stealth/i, 'eye'], [/dodge|hazard|avoid/i, 'gate'],
  [/race|run|lap/i, 'flag'], [/tug|pull/i, 'bolt'], [/trivia|quiz/i, 'star'], [/draw|paint/i, 'paint'], [/bomb|overload|pass/i, 'bomb'], [/goal|base|bank/i, 'base'],
];
const sketchIcons = (p: Pitch) => {
  const out: string[] = [];
  for (const b of p.blocksSketch) {
    const hit = SKETCH_ICON.find(([re]) => re.test(b));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out.slice(0, 4);
};

function PitchCard({ p, i, art, count, total, voters, tv, lead, onFocus, onSelect }: {
  p: Pitch; i: number; art?: string; count: number; total: number; voters: PartyState['players']; tv: boolean; lead: boolean;
  onFocus: () => void; onSelect: () => void;
}) {
  const ref = useFocusable(0, i, { autofocus: i === 1, focus: onFocus, select: onSelect });
  const share = total > 0 ? count / total : 0;
  return (
    <div ref={ref} class={`pitch-card ${tv ? 'is-tv' : ''} ${lead && total > 0 ? 'is-lead' : ''}`} style={{ ...paletteVars(p.palette), animationDelay: `${0.08 + i * 0.1}s` }} onClick={onSelect}>
      <div class="pitch-art" style={art ? { backgroundImage: `url("${art}")` } : undefined}>
        <span class="pitch-icons">{sketchIcons(p).map((n) => <NeonIcon key={n} name={n} />)}</span>
      </div>
      <div class="pitch-body">
        <h2>{p.title}</h2>
        <p>{p.hook}</p>
      </div>
      <div class="pitch-votes">
        <div class="vote-bar"><i style={{ transform: `scaleX(${share})` }} /></div>
        <div class="vote-row">
          <span class="pitch-voters">{voters.map((v) => <Avatar key={v.id} p={v} size={44} index={0} ring={false} />)}</span>
          {tv && <span class="pitch-tv">TV pick</span>}
          <b key={count} class="pitch-count">{count} {count === 1 ? 'vote' : 'votes'}</b>
        </div>
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
  const votes = counts.reduce((a, b) => a + b, 0);
  const lead = state.pitches.length ? pickWinner(state.votes, state.pitches.length, state.forge.tvVote) : -1;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  return (
    <section class={`screen forge-screen pitches ${cooking ? 'is-cooking' : ''}`}>
      <NeonBg url={HERO.create} />
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
          {[0, 1, 2].map((i) => (
            <div key={i} class="pitch-card is-blank" style={{ animationDelay: `${i * 0.12}s`, ['--sd' as string]: `${i * 0.25}s` }} aria-hidden="true">
              <div class="sk-art"><i class="sk-chip" /><i class="sk-chip" /></div>
              <div class="sk-body"><i class="sk-title" /><i class="sk-line" /><i class="sk-line" /><i class="sk-line is-short" /></div>
              <div class="sk-foot"><i class="sk-bar" /></div>
              <div class="pitch-shimmer" />
            </div>
          ))}
          <div class="cook-chips">{state.ingredients.slice(-8).map((g, i) => <span key={i} class="chip chip-sm">{g.text}</span>)}</div>
        </div>
      ) : (
        <div class="pitch-row">
          {state.pitches.map((p, i) => (
            <PitchCard
              key={p.id} p={p} i={i} art={state.forge.art[p.id]?.keyArt} count={counts[i] ?? 0} total={votes}
              voters={Object.entries(state.votes).filter(([, v]) => v === i).map(([id]) => byId.get(id)!).filter(Boolean)}
              tv={state.forge.tvVote === i} lead={lead === i}
              onFocus={() => onFocusPitch(i)} onSelect={() => onTvVote(i)}
            />
          ))}
        </div>
      )}
      {!cooking && <div class="hint pitches-hint">OK casts the TV's tie-break vote</div>}
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
  const active = rows.find((r) => r.state === 'active') ?? rows[rows.length - 1];
  useEffect(() => {
    focus.setBack(() => true); // no way out mid-build: it takes seconds
    return () => focus.setBack(undefined);
  }, []);
  return (
    <section class={`screen forge-screen forge ${ready ? 'is-ready' : ''}`} style={p ? paletteVars(p.palette) : undefined}>
      <div class="forge-bg">
        <HeroLayers url={art ?? HERO.create} />
        <div class="scrim" />
      </div>
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="forge-stage">
        <div class="eyebrow">{ready ? 'Ready to play' : 'Building your game'}</div>
        <h1 class="title">{p?.title ?? 'Your game'}</h1>
        <p class="hook">{p?.hook}</p>
        <div class="forge-line"><i style={{ transform: `scaleX(${Math.max(0.02, pct / 100)})` }} /></div>
        <div class="forge-now">
          <b key={active?.label}>{ready ? 'Game ready' : progress?.step && progress.step !== active?.label ? progress.step : active?.label}</b>
          <span>{pct}%</span>
        </div>
        <div class="forge-steps">
          {rows.map((r) => <span key={r.label} class={`fstep is-${r.state}`}>{r.label}</span>)}
        </div>
      </div>
      {!art && p && (
        <div class={`forge-blocks ${rows[0]?.state === 'done' ? 'is-on' : ''}`} aria-hidden="true">
          {(sketchIcons(p).length ? sketchIcons(p) : ['star']).map((n, i) => (
            <span key={n} class={`fblock fb-${i}`} style={{ animationDelay: `${i * 0.18}s` }}><NeonIcon name={n} /></span>
          ))}
        </div>
      )}
      <div class="forge-ings">{state.ingredients.slice(-6).map((g, i) => <span key={i} class="chip chip-sm">{g.text}</span>)}</div>
    </section>
  );
}
