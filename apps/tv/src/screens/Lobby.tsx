// Lobby: full-bleed art of the focused game, big title left, join card (QR + code + seats) right,
// tile row along the bottom: the quick-play games, "Fill with bots" and Settings.
import { useEffect, useMemo, useState } from 'preact/hooks';
import QRCode from 'qrcode';
import { themeVars } from '@cadabra/render';
import { MAX_PLAYERS, type GameSpec } from '@cadabra/spec';
import { Avatar, Backdrop, Icon, Tile, TopBar, art, focus } from '../ui/components';
import { QUICK_GAMES, cardFor, keyArtFor } from '../fallback';
import { joinUrl } from '../net/room';
import type { PartyState } from '../state/machine';

export interface LobbyProps {
  state: PartyState;
  status: string;
  onPlay: (spec: GameSpec) => void;
  onFillBots: () => void;
  onSettings: () => void;
}

type Focused = { kind: 'game'; spec: GameSpec } | { kind: 'bots' } | { kind: 'settings' };

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

export function Lobby({ state, status, onPlay, onFillBots, onSettings }: LobbyProps) {
  const [focused, setFocused] = useState<Focused>({ kind: 'game', spec: QUICK_GAMES[0]! });
  const lastGame = useMemo(() => (focused.kind === 'game' ? focused.spec : undefined), [focused]);
  const [heroSpec, setHeroSpec] = useState<GameSpec>(QUICK_GAMES[0]!);
  useEffect(() => { if (lastGame) setHeroSpec(lastGame); }, [lastGame]);
  useEffect(() => {
    focus.setBack(undefined); // Back on the lobby closes the app
  }, []);

  const keyArt = keyArtFor(heroSpec);
  const humans = state.players.filter((p) => !p.isBot).length;
  const full = state.players.length >= MAX_PLAYERS;
  const card = cardFor(heroSpec, state.settings.roundSec);

  let eyebrow = 'Quick play';
  let title = heroSpec.title;
  let hook = heroSpec.hook;
  let meta = card.meta;
  let cta = 'Play now';
  if (focused.kind === 'bots') {
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
    hook = 'Family-safe mode, bots, host voice, round length and more.';
    meta = [state.settings.familySafe ? 'Family-safe on' : 'Family-safe off', state.settings.hostVoice ? 'Host voice on' : 'Host voice off', `${state.settings.roundSec} s rounds`];
    cta = 'Open';
  }

  return (
    <section class="screen lobby" style={themeVars(heroSpec.theme)}>
      <Backdrop art={keyArt} />
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

      <nav class="tiles">
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
        <Tile
          col={QUICK_GAMES.length}
          label="Fill with bots"
          class="tile-action"
          disabled={!state.settings.bots || full}
          onFocus={() => setFocused({ kind: 'bots' })}
          onSelect={onFillBots}
        >
          <Icon name="bots" />
        </Tile>
        <Tile col={QUICK_GAMES.length + 1} label="Settings" class="tile-action" onFocus={() => setFocused({ kind: 'settings' })} onSelect={onSettings}>
          <Icon name="gear" />
        </Tile>
      </nav>
    </section>
  );
}
