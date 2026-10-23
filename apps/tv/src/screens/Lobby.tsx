// Lobby: full-bleed art of the focused game, big title left, join card (QR + code + seats) right,
// tile row along the bottom: the quick-play games, "Fill with bots" and Settings.
import { useEffect, useMemo, useState } from 'preact/hooks';
import QRCode from 'qrcode';
import { themeVars } from '@cadabra/render';
import { MAX_PLAYERS, type GameSpec } from '@cadabra/spec';
import { Avatar, Backdrop, Icon, NeonBg, Tile, TopBar, art, focus } from '../ui/components';
import { QUICK_GAMES, cardFor, keyArtFor } from '../fallback';
import { joinUrl } from '../net/room';
import type { PartyState } from '../state/machine';

export interface LobbyProps {
  state: PartyState;
  status: string;
  onPlay: (spec: GameSpec) => void;
  onCreate: () => void;
  onParty: () => void;
  onArcade: () => void;
  onFillBots: () => void;
  onSettings: () => void;
}

type Focused = { kind: 'game'; spec: GameSpec } | { kind: 'bots' } | { kind: 'settings' } | { kind: 'create' } | { kind: 'party' } | { kind: 'quick' } | { kind: 'back' } | { kind: 'arcade' };

function QR({ url }: { url: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0b0e1c', light: '#ffffff' } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(''));
    return () => { live = false; };
  }, [url]);
  return <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Seats({ state }: { state: PartyState }) {
  const seats = Array.from({ length: MAX_PLAYERS }, (_, i) => state.players[i]);
  return (
    <div class="seats">
      {seats.map((p, i) => (
        <div key={p?.id ?? `empty-${i}`} class={`seat ${p ? 'is-taken' : 'is-empty'}`}>
          {p ? <Avatar p={p} size={112} index={i} /> : <div class="seat-empty">+</div>}
          <span class="seat-name">{p ? p.name : 'Open seat'}</span>
        </div>
      ))}
    </div>
  );
}

export function Lobby({ state, status, onPlay, onCreate, onParty, onArcade, onFillBots, onSettings }: LobbyProps) {
  const [mode, setMode] = useState<'home' | 'quick'>('home');
  const [focused, setFocused] = useState<Focused>({ kind: 'create' });
  const lastGame = useMemo(() => (focused.kind === 'game' ? focused.spec : undefined), [focused]);
  const [heroSpec, setHeroSpec] = useState<GameSpec>(QUICK_GAMES[0]!);
  useEffect(() => { if (lastGame) setHeroSpec(lastGame); }, [lastGame]);
  useEffect(() => {
    // Back on the home row closes the app; in Quick Play it returns home
    focus.setBack(mode === 'quick' ? () => { setMode('home'); setFocused({ kind: 'quick' }); return true; } : undefined);
  }, [mode]);

  const keyArt = keyArtFor(heroSpec);
  const humans = state.players.filter((p) => !p.isBot).length;
  const full = state.players.length >= MAX_PLAYERS;
  const card = cardFor(heroSpec, state.settings.roundSec);
  const online = status === 'online' && !!state.code;

  let eyebrow = 'Quick play';
  let title = heroSpec.title;
  let hook = heroSpec.hook;
  let meta = card.meta;
  let cta = 'Play now';
  const showArt = focused.kind === 'game';
  if (focused.kind === 'create') {
    eyebrow = 'AI game forge';
    title = 'Create';
    hook = 'Everyone throws ingredients in from their phone. The AI pitches three brand-new games, you vote, and it builds the winner in seconds.';
    meta = ['20 s idea storm', 'Vote on phones', online ? 'Ready' : 'Needs internet'];
    cta = online ? 'Start' : 'Offline';
  } else if (focused.kind === 'party') {
    eyebrow = 'Quick-fire minigames';
    title = 'Party';
    hook = 'Four short rounds back to back. Points carry over, standings after every round, and one grand champion at the end.';
    meta = ['4 rounds', '45 s each', 'Points table'];
    cta = 'Start party';
  } else if (focused.kind === 'quick' || focused.kind === 'back') {
    eyebrow = 'Pick one game';
    title = focused.kind === 'back' ? 'Back' : 'Quick Play';
    hook = focused.kind === 'back' ? 'Back to Create, Party and Settings.' : `Jump straight into one of ${QUICK_GAMES.length} built-in arcade games.`;
    meta = [`${QUICK_GAMES.length} games`, `${state.settings.roundSec} s rounds`];
    cta = 'Open';
  } else if (focused.kind === 'arcade') {
    eyebrow = 'Saved games';
    title = 'Arcade';
    hook = 'Every game you forge is saved here. Play your family’s favourites again any time.';
    meta = [online ? 'Saved online' : 'Needs internet'];
    cta = 'Open';
  } else if (focused.kind === 'bots') {
    eyebrow = 'Short on players?';
    title = 'Fill with bots';
    hook = state.settings.bots
      ? 'Add AI players until all four seats are taken. Real players can still join and take a bot’s seat.'
      : 'Bots are switched off in Settings.';
    meta = [`${humans} on phones`, `${MAX_PLAYERS - state.players.length} open`];
    cta = full ? 'Seats are full' : 'Add bots';
  } else if (focused.kind === 'settings') {
    eyebrow = 'House rules';
    title = 'Settings';
    hook = 'Family-safe mode, bots, round length and more.';
    meta = [state.settings.familySafe ? 'Family-safe on' : 'Family-safe off', `${state.settings.roundSec} s rounds`];
    cta = 'Open';
  }

  return (
    <section class={`screen lobby mode-${mode}`} style={themeVars(heroSpec.theme)}>
      {showArt ? <Backdrop art={keyArt} /> : <NeonBg />}
      <TopBar code={state.code} players={state.players} status={status} />

      <div class="hero" key={title}>
        <div class="eyebrow">{eyebrow}<span class="eyebrow-cta"><i>OK</i>{cta}</span></div>
        <h1 class="title">{title}</h1>
        <p class="hook">{hook}</p>
        <div class="meta">{meta.map((m) => <span key={m}>{m}</span>)}</div>
      </div>

      <aside class="join-card">
        <div class="join-top">
          {state.code ? <QR url={joinUrl(state.code)} /> : <div class="qr qr-empty">{status === 'offline' ? 'Offline' : '…'}</div>}
          <div class="join-text">
            <div class="join-lbl">Scan to join, or enter</div>
            <div class="code">{(state.code || '····').split('').map((c, i) => <b key={i}>{c}</b>)}</div>
            <div class="join-url">No app · up to {MAX_PLAYERS} players</div>
          </div>
        </div>
        <Seats state={state} />
        {state.spectators.length > 0 && <div class="join-wait">{state.spectators.length} waiting for a seat</div>}
      </aside>

      {mode === 'home' ? (
        <nav class="tiles" key="home">
          <Tile col={0} label="Create" sub="AI forge" class="tile-action tile-hero-create" autofocus={focused.kind !== 'quick'} onFocus={() => setFocused({ kind: 'create' })} onSelect={onCreate}>
            <Icon name="spark" />
          </Tile>
          <Tile col={1} label="Party" sub="4 rounds" class="tile-action tile-hero-party" onFocus={() => setFocused({ kind: 'party' })} onSelect={onParty}>
            <Icon name="party" />
          </Tile>
          <Tile col={2} label="Quick Play" sub="Pick a game" class="tile-action tile-hero-quick" autofocus={focused.kind === 'quick'} onFocus={() => setFocused({ kind: 'quick' })} onSelect={() => { setMode('quick'); setFocused({ kind: 'game', spec: QUICK_GAMES[0]! }); }}>
            <Icon name="grid" />
          </Tile>
          <Tile col={3} label="Arcade" sub="Saved games" class="tile-action" onFocus={() => setFocused({ kind: 'arcade' })} onSelect={onArcade}>
            <Icon name="save" />
          </Tile>
          <Tile col={4} label="Fill with bots" class="tile-action" disabled={!state.settings.bots || full} onFocus={() => setFocused({ kind: 'bots' })} onSelect={onFillBots}>
            <Icon name="bots" />
          </Tile>
          <Tile col={5} label="Settings" class="tile-action" onFocus={() => setFocused({ kind: 'settings' })} onSelect={onSettings}>
            <Icon name="gear" />
          </Tile>
        </nav>
      ) : (
        <nav class="tiles tiles-games" key="quick">
          {QUICK_GAMES.map((spec, i) => {
            const k = keyArtFor(spec);
            const hero = k.sprites.find((s) => s.depth !== 'back');
            return (
              <Tile
                key={spec.id}
                col={i}
                label={spec.title}
                class="tile-game"
                autofocus={i === 0}
                onFocus={() => setFocused({ kind: 'game', spec })}
                onSelect={() => onPlay(spec)}
              >
                <div class="tile-art" style={{ backgroundImage: `url("${k.backdrop}")` }} />
                {hero && art(hero.key) && <img class="tile-hero" src={art(hero.key)} alt="" />}
              </Tile>
            );
          })}
          <Tile col={QUICK_GAMES.length} label="Back" class="tile-action" onFocus={() => setFocused({ kind: 'back' })} onSelect={() => { setMode('home'); setFocused({ kind: 'quick' }); }}>
            <Icon name="home" />
          </Tile>
        </nav>
      )}
    </section>
  );
}
