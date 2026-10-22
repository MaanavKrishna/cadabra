// Results: the podium reveal (the screen's one orchestrated moment), then Play again / Next game /
// Lobby along the bottom.
import { useEffect } from 'preact/hooks';
import { themeVars } from '@cadabra/render';
import type { Player } from '@cadabra/engine';
import { Avatar, Backdrop, Icon, Tile, TopBar, focus } from '../ui/components';
import { keyArtFor } from '../fallback';
import type { PartyState } from '../state/machine';

export interface ResultsProps {
  state: PartyState;
  status: string;
  winnerTeam?: 0 | 1;
  onAgain: () => void;
  onNext: () => void;
  onLobby: () => void;
}

const PLACE = ['1st', '2nd', '3rd', '4th'];
const CONFETTI = Array.from({ length: 28 }, (_, i) => i);

export function Results({ state, status, winnerTeam, onAgain, onNext, onLobby }: ResultsProps) {
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
  const headline = winnerTeam !== undefined ? `Team ${winnerTeam === 0 ? 'Red' : 'Blue'} wins!` : winner ? `${winner.p.name} wins!` : 'Round over';

  return (
    <section class="screen results" style={themeVars(spec.theme)}>
      <Backdrop art={keyArtFor(spec, state.art.keyArt)} dim />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="confetti" aria-hidden="true">
        {CONFETTI.map((i) => <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${0.9 + (i % 7) * 0.18}s`, ['--hue' as string]: `${(i * 47) % 360}` }} />)}
      </div>
      <div class="results-head">
        <div class="eyebrow">{spec.title} · round {state.round}</div>
        <h1 class="title title-sm">{headline}</h1>
      </div>
      <div class="podium">
        {podium.map((e, col) => {
          if (!e) return <div key={`empty-${col}`} class="podium-col is-empty" />;
          const place = state.ranking.findIndex((r) => r.id === e.r.id);
          return (
            <div key={e.r.id} class={`podium-col place-${place + 1}`} style={{ animationDelay: `${[0.35, 0.75, 0.15][col]}s` }}>
              <Avatar p={e.p} size={place === 0 ? 176 : 136} index={indexOf.get(e.p.id) ?? 0} />
              <div class="podium-name">{e.p.name}</div>
              <div class="podium-block">
                <span class="podium-place">{PLACE[place]}</span>
                <span class="podium-score">{e.r.score}</span>
              </div>
            </div>
          );
        })}
      </div>
      {ranked[3] && (
        <div class="fourth">
          <span>4th</span><Avatar p={ranked[3].p} size={72} index={indexOf.get(ranked[3].p.id) ?? 3} /><b>{ranked[3].p.name}</b><span>{ranked[3].r.score}</span>
        </div>
      )}
      <nav class="tiles tiles-results">
        <Tile col={0} label="Play again" class="tile-pill" autofocus onSelect={onAgain}><Icon name="again" />Play again</Tile>
        <Tile col={1} label="Next game" class="tile-pill" onSelect={onNext}><Icon name="next" />Next game</Tile>
        <Tile col={2} label="Lobby" class="tile-pill" onSelect={onLobby}><Icon name="home" />Lobby</Tile>
      </nav>
    </section>
  );
}
