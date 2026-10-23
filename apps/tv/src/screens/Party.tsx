// Party mode screens: the standings between rounds (rows climb from their old place) and the grand
// champion podium at the end.
import { useEffect, useState } from 'preact/hooks';
import type { GameSpec } from '@cadabra/spec';
import type { Player } from '@cadabra/engine';
import { Avatar, NeonBg, Pill, TopBar, focus } from '../ui/components';
import { HERO, displayTitle, gameStill } from '../ui/hero';
import { champions, standings, type PartyRun } from '../play/party';
import type { PartyState } from '../state/machine';

/** Standings auto-advance after this long (OK skips). */
export const STANDINGS_MS = 12_000;
const ROW_H = 120;

const ghost = (id: string): Player => ({ id, name: 'Player', avatar: '', isBot: false, connected: false, score: 0 });

export interface StandingsProps {
  state: PartyState; status: string; run: PartyRun; next?: GameSpec;
  onNext: () => void; onQuit: () => void;
}

export function PartyStandings({ state, status, run, next, onNext, onQuit }: StandingsProps) {
  const ids = state.players.map((p) => p.id);
  const rows = standings(run, ids);
  const byId = new Map(state.players.map((p, i) => [p.id, { p, i }]));
  const max = Math.max(1, ...rows.map((r) => r.points));
  const [left, setLeft] = useState(Math.round(STANDINGS_MS / 1000));
  useEffect(() => {
    focus.setBack(() => { onQuit(); return true; });
    const t0 = performance.now();
    const id = setInterval(() => {
      const l = Math.max(0, Math.ceil((STANDINGS_MS - (performance.now() - t0)) / 1000));
      setLeft(l);
      if (l === 0) { clearInterval(id); onNext(); }
    }, 250);
    return () => { clearInterval(id); focus.setBack(undefined); };
  }, []);
  return (
    <section class="screen party-standings">
      <NeonBg url={HERO.party} quiet />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="party-head">
        <div class="eyebrow">Party, round {run.played} of {run.rounds.length}</div>
        <h1 class="title title-sm">Standings</h1>
      </div>
      <div class="standings" style={{ height: `${rows.length * ROW_H}px` }}>
        {rows.map((r, i) => {
          const e = byId.get(r.id) ?? { p: ghost(r.id), i: 0 };
          const climb = r.prevRank - r.rank;
          return (
            <div
              key={r.id}
              class={`srow rank-${r.rank} ${climb > 0 ? 'is-up' : ''}`}
              style={{ top: `${i * ROW_H}px`, ['--from' as string]: `${climb * ROW_H}px`, animationDelay: `${0.2 + i * 0.1}s` }}
            >
              <span class="srow-rank">{r.rank}</span>
              <Avatar p={e.p} size={96} index={e.i} />
              <span class="srow-name">{e.p.name}</span>
              <span class="srow-bar"><i style={{ transform: `scaleX(${r.points / max})`, animationDelay: `${0.5 + i * 0.1}s` }} /></span>
              {r.gained > 0 && <span class="srow-gain">+{r.gained}</span>}
              {climb > 0 && <span class="srow-climb">▲{climb}</span>}
              <span class="srow-pts">{r.points}</span>
            </div>
          );
        })}
      </div>
      <aside class="party-next glass">
        {next && (
          <>
            <div class="party-next-art" style={{ backgroundImage: `url("${gameStill(next.id) ?? HERO.party}")` }} />
            <div class="party-next-body"><div class="eyebrow">Up next</div><div class="party-next-title">{displayTitle(next.title)}</div><p>{next.hook}</p></div>
          </>
        )}
      </aside>
      <nav class="actions">
        <Pill row={0} col={0} label={`Next round in ${left}`} icon="next" primary autofocus onSelect={onNext} />
        <Pill row={0} col={1} label="Quit party" icon="home" onSelect={onQuit} />
      </nav>
    </section>
  );
}

const CONFETTI = Array.from({ length: 34 }, (_, i) => i);

export function PartyChampion({ state, status, run, onAgain, onLobby }: { state: PartyState; status: string; run: PartyRun; onAgain: () => void; onLobby: () => void }) {
  const ids = state.players.map((p) => p.id);
  const rows = standings(run, ids);
  const champs = champions(run, ids);
  const byId = new Map(state.players.map((p, i) => [p.id, { p, i }]));
  useEffect(() => {
    focus.setBack(() => { onLobby(); return true; });
    return () => focus.setBack(undefined);
  }, [onLobby]);
  const names = champs.map((id) => byId.get(id)?.p.name ?? 'Player');
  const headline = names.length === 1 ? `${names[0]} is the champion!` : `${names.join(' & ')} share the crown!`;
  return (
    <section class="screen party-champion">
      <NeonBg url={HERO.party} quiet />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="confetti" aria-hidden="true">
        {CONFETTI.map((i) => <i key={i} style={{ left: `${(i * 29) % 100}%`, animationDelay: `${0.6 + (i % 9) * 0.16}s`, ['--hue' as string]: `${[186, 312, 84, 38][i % 4]}` }} />)}
      </div>
      <div class="results-head">
        <div class="eyebrow">Party over, {run.rounds.length} rounds</div>
        <h1 class="title title-sm">{headline}</h1>
      </div>
      <div class="champ-row">
        {champs.map((id, k) => {
          const e = byId.get(id) ?? { p: ghost(id), i: 0 };
          return (
            <div key={id} class="champ" style={{ animationDelay: `${0.3 + k * 0.2}s` }}>
              <svg class="crown" viewBox="0 0 64 44" aria-hidden="true">
                <path d="M4 14 L18 26 L32 4 L46 26 L60 14 L54 40 H10 Z" fill="#f4d58d" />
              </svg>
              <Avatar p={e.p} size={230} index={e.i} />
              <div class="champ-name">{e.p.name}</div>
              <div class="champ-pts">{run.points[id] ?? 0} pts</div>
            </div>
          );
        })}
      </div>
      <div class="champ-rest">
        {rows.filter((r) => !champs.includes(r.id)).map((r) => {
          const e = byId.get(r.id) ?? { p: ghost(r.id), i: 0 };
          return <div key={r.id} class="champ-rest-row"><span>{r.rank}</span><Avatar p={e.p} size={64} index={e.i} /><b>{e.p.name}</b><span>{r.points}</span></div>;
        })}
      </div>
      <nav class="actions">
        <Pill row={0} col={0} label="Party again" icon="party" primary autofocus onSelect={onAgain} />
        <Pill row={0} col={1} label="Home" icon="home" onSelect={onLobby} />
      </nav>
    </section>
  );
}
