// Arcade: the household's saved games (forged games are saved after they are played). Tiles along
// the bottom like the lobby; OK plays the focused game, Back returns home.
import { useEffect, useState } from 'preact/hooks';
import type { ArcadeGameSummary, GameSpec } from '@cadabra/spec';
import { Backdrop, Icon, NeonBg, Tile, TopBar, focus } from '../ui/components';
import { keyArtFor } from '../fallback';
import type { PartyState } from '../state/machine';

export interface ArcadeProps {
  state: PartyState;
  status: string;
  /** undefined while loading. */
  games?: ArcadeGameSummary[];
  loadingId?: string;
  onPlay: (id: string) => void;
  onClose: () => void;
}

const artOf = (g: ArcadeGameSummary) =>
  keyArtFor({ id: g.id, theme: { palette: g.palette } as GameSpec['theme'], arena: { kind: 'topdown', width: 1, height: 1 } }, g.keyArt);

const ago = (ms: number) => {
  const d = Math.max(0, Date.now() - ms) / 60_000;
  return d < 60 ? `${Math.max(1, Math.round(d))} min ago` : d < 1440 ? `${Math.round(d / 60)} h ago` : `${Math.round(d / 1440)} d ago`;
};

export function Arcade({ state, status, games, loadingId, onPlay, onClose }: ArcadeProps) {
  const [focused, setFocused] = useState(0);
  useEffect(() => {
    focus.setBack(() => { onClose(); return true; });
    return () => focus.setBack(undefined);
  }, [onClose]);
  const list = games ?? [];
  const g = list[Math.min(focused, list.length - 1)];
  return (
    <section class="screen lobby arcade">
      {g ? <Backdrop art={artOf(g)} /> : <NeonBg />}
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="hero" key={g?.id ?? 'empty'}>
        <div class="eyebrow">Family arcade{g && <span class="eyebrow-cta"><i>OK</i>{loadingId === g.id ? 'Loading…' : 'Play'}</span>}</div>
        <h1 class="title">{g ? g.title : games ? 'Nothing saved yet' : 'Opening the arcade…'}</h1>
        <p class="hook">{g ? g.hook : games ? 'Every game you forge with Create is saved here after you play it.' : 'Fetching your saved games.'}</p>
        {g && <div class="meta"><span>{g.unplayed ? 'New' : `Played ${g.playedCount}×`}</span>{g.lastPlayed > 0 && <span>{ago(g.lastPlayed)}</span>}</div>}
      </div>
      <nav class="tiles tiles-games">
        {list.slice(0, 6).map((x, i) => (
          <Tile key={x.id} col={i} label={x.title} class="tile-game" autofocus={i === 0} onFocus={() => setFocused(i)} onSelect={() => onPlay(x.id)}>
            <div class="tile-art" style={{ backgroundImage: `url("${artOf(x).backdrop}")` }} />
          </Tile>
        ))}
        <Tile col={Math.min(6, list.length)} label="Back" class="tile-action" autofocus={list.length === 0} onSelect={onClose}>
          <Icon name="home" />
        </Tile>
      </nav>
    </section>
  );
}
