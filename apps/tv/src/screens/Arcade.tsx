// Arcade: the household's saved games (forged games are saved after they are played). Tiles along
// the bottom like the lobby; OK plays the focused game, Down reaches Play / Remix for it, Back
// returns home.
import { useEffect, useState } from 'preact/hooks';
import type { ArcadeGameSummary, GameSpec } from '@cadabra/spec';
import { NeonBg, Pill, TopBar, focus, useFocusable } from '../ui/components';
import { HERO } from '../ui/hero';
import { keyArtFor } from '../fallback';
import type { PartyState } from '../state/machine';

export interface ArcadeProps {
  state: PartyState;
  status: string;
  /** undefined while loading. */
  games?: ArcadeGameSummary[];
  loadingId?: string;
  onPlay: (id: string) => void;
  /** Remix the focused game: the Tweak flow, saved as a new Arcade entry (the original stays). */
  onRemix?: (id: string) => void;
  onClose: () => void;
}

const artOf = (g: ArcadeGameSummary) =>
  keyArtFor({ id: g.id, theme: { palette: g.palette } as GameSpec['theme'], arena: { kind: 'topdown', width: 1, height: 1 } }, g.keyArt);

const ago = (t: number) => {
  const ms = t < 1e12 ? t * 1000 : t; // the backend stores epoch seconds
  const d = Math.max(0, Date.now() - ms) / 60_000;
  return d < 60 ? `${Math.max(1, Math.round(d))} min ago` : d < 1440 ? `${Math.round(d / 60)} h ago` : `${Math.round(d / 1440)} d ago`;
};

const COLS = 4;

function GameCard({ g, i, loading, onFocus, onSelect }: { g: ArcadeGameSummary; i: number; loading: boolean; onFocus: () => void; onSelect: () => void }) {
  const ref = useFocusable(Math.floor(i / COLS), i % COLS, { autofocus: i === 0, focus: onFocus, select: onSelect });
  return (
    <div ref={ref} class="lib-card" style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }} onClick={onSelect}>
      <div class="lib-art" style={{ backgroundImage: `url("${artOf(g).backdrop}")` }}>
        {g.unplayed && <span class="lib-new">New</span>}
        {loading && <span class="lib-loading">Loading…</span>}
      </div>
      <div class="lib-title">{g.title}</div>
      <div class="lib-sub">{g.unplayed ? 'Not played yet' : `Played ${g.playedCount}×`}{g.lastPlayed > 0 ? `, ${ago(g.lastPlayed)}` : ''}</div>
    </div>
  );
}

export function Arcade({ state, status, games, loadingId, onPlay, onRemix, onClose }: ArcadeProps) {
  const [focused, setFocused] = useState(0);
  useEffect(() => {
    focus.setBack(() => { onClose(); return true; });
    return () => focus.setBack(undefined);
  }, [onClose]);
  const list = (games ?? []).slice(0, 12);
  const g = list[Math.min(focused, list.length - 1)];
  // the grid scrolls a row at a time so the focused card stays on screen
  const row = Math.floor(focused / COLS);
  return (
    <section class="screen library">
      <NeonBg url={HERO.arcade} quiet />
      <TopBar code={state.code} players={state.players} status={status} />
      <div class="lib-head">
        <h1 class="title title-sm">Arcade</h1>
        <span class="lib-count">{games ? `${games.length} saved ${games.length === 1 ? 'game' : 'games'}` : 'Opening…'}</span>
      </div>
      {list.length === 0 ? (
        <div class="lib-empty glass">
          <h2>{games ? 'Nothing saved yet' : 'Opening the arcade…'}</h2>
          <p>{games ? 'Every game you make with Create is saved here after you play it.' : 'Fetching your saved games.'}</p>
          <span class="hint">Back to return home</span>
        </div>
      ) : (
        <>
          <div class="lib-grid" style={{ transform: `translate3d(0, ${-Math.max(0, row - 1) * 330}px, 0)` }}>
            {list.map((x, i) => (
              <GameCard key={x.id} g={x} i={i} loading={loadingId === x.id} onFocus={() => setFocused(i)} onSelect={() => onPlay(x.id)} />
            ))}
          </div>
          {g && (
            <div class="lib-hook" key={g.id}>
              <div class="lib-hook-text"><b>{g.title}</b><span>{g.hook}</span></div>
              <div class="lib-actions">
                <Pill row={100} col={0} label="Play" icon="play" onSelect={() => onPlay(g.id)} />
                {onRemix && <Pill row={100} col={1} label="Remix" icon="tweak" onSelect={() => onRemix(g.id)} />}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
