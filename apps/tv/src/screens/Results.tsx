// Results: the podium reveal (the screen's one orchestrated moment), then Play again / Next game /
// Lobby along the bottom.
import { useEffect } from 'preact/hooks';
import { themeVars } from '@cadabra/render';
import type { Player } from '@cadabra/engine';
import { Avatar, Backdrop, Pill, TopBar, focus } from '../ui/components';
import { displayTitle } from '../ui/hero';
import { keyArtFor } from '../fallback';
import { TEAM_NAME } from '../play/flow';
import type { PartyState } from '../state/machine';

export interface ResultsProps {
  state: PartyState;
  status: string;
  winnerTeam?: 0 | 1;
  /** A game from the AI forge: "Next game" forges another. */
  forged?: boolean;
  onAgain: () => void;
  onNext: () => void;
  onLobby: () => void;
}

const PLACE = ['1st', '2nd', '3rd', '4th'];
const CONFETTI = Array.from({ length: 28 }, (_, i) => i);

export function Results({ state, status, winnerTeam, forged, onAgain, onNext, onLobby }: ResultsProps) {
  const spec = state.spec!;
  useEffect(() => {
    focus.setBack(() => { onLobby(); return true; });
    return () => focus.setBack(undefined);
  }, [onLobby]);

  const byId = new Map(state.players.map((p) => [p.id, p]));
  const indexOf = new Map(state.players.map((p, i) => [p.id, i]));
  const ranked = state.ranking
    .map((r) => ({ r, p: byId.get(r.id) ?? ({ id: r.id, name: 'Player', avatar: '', isBot: false, connected: false, score: 0 } as Player) }))
    .slice(0, 4);
  const winner = ranked[0];
  // podium order: 2nd, 1st, 3rd
  const podium = [ranked[1], ranked[0], ranked[2]];
  const teamGame = spec.teams === 2 && state.ranking.some((r) => r.team === 0 || r.team === 1);
  const headline = teamGame
    ? (winnerTeam !== undefined ? `Team ${TEAM_NAME[winnerTeam]} wins!` : 'It’s a draw!')
    : winner ? `${winner.p.name} wins!` : 'Round over';
  const teams = ([0, 1] as const)
    .map((t) => {
      const members = state.ranking.filter((r) => r.team === t).map((r) => ({ r, p: byId.get(r.id) }));
      return { t, members, total: members.reduce((a, m) => a + m.r.score, 0) };
    })
    .sort((a, b) => (a.t === winnerTeam ? -1 : b.t === winnerTeam ? 1 : a.t - b.t));

  return (
    <section class="screen results" style={themeVars(spec.theme)}>
      <Backdrop art={keyArtFor(spec, state.art.keyArt)} dim />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="confetti" aria-hidden="true">
        {CONFETTI.map((i) => <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${0.9 + (i % 7) * 0.18}s`, ['--hue' as string]: `${(i * 47) % 360}` }} />)}
      </div>
      <div class="results-head">
        <div class="eyebrow">{displayTitle(spec.title)}, round {state.round}</div>
        <h1 class="title title-sm">{headline}</h1>
      </div>
      {teamGame ? (
        <div class="teams">
          {teams.map((tm, k) => (
            <div key={tm.t} class={`team-panel team-${tm.t} ${tm.t === winnerTeam ? 'is-win' : ''}`} style={{ animationDelay: `${0.2 + k * 0.35}s` }}>
              <div class="team-head">
                <span class="team-name">Team {TEAM_NAME[tm.t]}</span>
                {tm.t === winnerTeam && <span class="team-badge">Winners</span>}
                <span class="team-total">{tm.total}</span>
              </div>
              <div class="team-members">
                {tm.members.map(({ r, p }) => p && (
                  <div key={r.id} class="team-m">
                    <Avatar p={p} size={tm.t === winnerTeam ? 150 : 112} index={indexOf.get(p.id) ?? 0} />
                    <b>{p.name}</b>
                    <span>{r.score} pts</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
      <div class="podium">
        {podium.map((e, col) => {
          if (!e) return <div key={`empty-${col}`} class="podium-col is-empty" />;
          const place = state.ranking.findIndex((r) => r.id === e.r.id);
          return (
            <div key={e.r.id} class={`podium-col place-${place + 1}`} style={{ animationDelay: `${[0.45, 0.9, 0.15][col]}s` }}>
              {place === 0 && (
                <svg class="crown" viewBox="0 0 64 44" aria-hidden="true">
                  <path d="M4 14 L18 26 L32 4 L46 26 L60 14 L54 40 H10 Z" fill="#f4d58d" />
                </svg>
              )}
              <Avatar p={e.p} size={place === 0 ? 210 : 160} index={indexOf.get(e.p.id) ?? 0} />
              <div class="podium-name">{e.p.name}</div>
              <div class="podium-block">
                <span class="podium-place">{PLACE[place]}</span>
                <span class="podium-score">{e.r.score}</span>
                <span class="podium-pts">points</span>
              </div>
            </div>
          );
        })}
      </div>
      )}
      {!teamGame && ranked[3] && (
        <div class="fourth">
          <span>4th</span><Avatar p={ranked[3].p} size={72} index={indexOf.get(ranked[3].p.id) ?? 3} /><b>{ranked[3].p.name}</b><span>{ranked[3].r.score}</span>
        </div>
      )}
      <nav class="actions">
        <Pill row={0} col={0} label="Play again" icon="again" primary autofocus onSelect={onAgain} />
        <Pill row={0} col={1} label={forged ? 'Create another' : 'Next game'} icon={forged ? 'spark' : 'next'} onSelect={onNext} />
        <Pill row={0} col={2} label="Home" icon="home" onSelect={onLobby} />
      </nav>
    </section>
  );
}
