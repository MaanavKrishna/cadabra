// Home, PS5 style: a row of rounded-square tiles across the top (the focused one grows and its name
// appears beside it), a full-bleed hero background that crossfades with the focus, the hero content
// bottom-left (wordmark title, one-line pitch, meta pills, Play + round secondary buttons), the
// players cluster top-right and a "Join on your phone" card until two phones are in.
import { useEffect, useState } from 'preact/hooks';
import QRCode from 'qrcode';
import { MAX_PLAYERS, type GameSpec } from '@cadabra/spec';
import { HeroLayers, Icon, Pill, RoundBtn, TopBar, focus, useFocusable, type IconName } from '../ui/components';
import { QUICK_GAMES } from '../fallback';
import { introFor } from '../play/intro';
import { HERO, displayTitle, gameStill } from '../ui/hero';
import { joinUrl } from '../net/room';
import { NeonIcon } from './Play';
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

type Kind = 'create' | 'party' | 'game' | 'arcade' | 'settings';
interface Item { key: string; kind: Kind; label: string; image: string; icon?: IconName; glyph?: string; tint?: string; spec?: GameSpec }

const GLYPH: Record<string, string> = {
  'fallback-ring-out': 'ring', 'fallback-overload': 'bomb', 'fallback-paint-wars': 'paint', 'fallback-core-rush': 'core', 'fallback-neon-dash': 'flag',
};

const ITEMS: Item[] = [
  { key: 'create', kind: 'create', label: 'Create', image: HERO.create, icon: 'spark' },
  { key: 'party', kind: 'party', label: 'Party', image: HERO.party, icon: 'party' },
  ...QUICK_GAMES.map((spec): Item => ({
    key: spec.id, kind: 'game', label: displayTitle(spec.title), image: gameStill(spec.id) ?? HERO.calm,
    glyph: GLYPH[spec.id] ?? 'star', tint: spec.theme.palette.primary, spec,
  })),
  { key: 'arcade', kind: 'arcade', label: 'Arcade', image: HERO.arcade, icon: 'grid' },
  { key: 'settings', kind: 'settings', label: 'Settings', image: HERO.calm, icon: 'gear' },
];

/** Tile geometry (1080p px): size, gap, focused scale, the name slot beside the focused tile. */
const T = 148;
const GAP = 22;
const GROW = 1.22;
const NAME_W = 330;
/** Remembered across visits (back from Settings / Arcade / a game lands on the same tile). */
let lastIndex = 0;

function QR({ url }: { url: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0b0d16', light: '#ffffff' } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(''));
    return () => { live = false; };
  }, [url]);
  return <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function HomeTile({ item, i, focused, x, onFocus, onSelect }: { item: Item; i: number; focused: boolean; x: number; onFocus: () => void; onSelect: () => void }) {
  const ref = useFocusable(0, i, { autofocus: i === lastIndex, focus: onFocus, select: onSelect });
  return (
    <div
      ref={ref}
      class={`htile htile-${item.kind}`}
      style={{ transform: `translate3d(${x}px, 0, 0) scale(${focused ? GROW : 1})` }}
      onClick={onSelect}
    >
      <div class="htile-art" style={{ backgroundImage: `url("${item.image}")` }} />
      <div class="htile-shade" />
      {item.icon && <Icon name={item.icon} />}
      {item.glyph && <span class="htile-glyph" style={{ color: item.tint }}><NeonIcon name={item.glyph} /></span>}
    </div>
  );
}

interface HeroCopy { title: string; pitch: string; meta: string[]; cta: string; ctaIcon: IconName; steps: string[] }

function copyFor(item: Item, state: PartyState, online: boolean): HeroCopy {
  const s = state.settings;
  switch (item.kind) {
    case 'create':
      return {
        title: 'Create', cta: online ? 'Create' : 'Needs internet', ctaIcon: 'spark',
        pitch: 'Throw ideas in from your phones. The AI pitches three new games and builds the winner.',
        meta: ['2–4 players', '20 s idea storm', online ? 'AI forge' : 'Offline'],
        steps: ['Everyone types ideas on their phone for 20 s', 'Vote for one of three AI pitches', 'The game is built in seconds, then you play'],
      };
    case 'party':
      return {
        title: 'Party', cta: 'Start Party', ctaIcon: 'play',
        pitch: 'Four quick rounds back to back. Points carry over and one champion takes the crown.',
        meta: ['2–4 players', '4 × 45 s', 'FFA + Teams'],
        steps: ['Four built-in games, picked at random', 'Points for every place, every round', 'Standings after each round, a champion at the end'],
      };
    case 'arcade':
      return {
        title: 'Arcade', cta: 'Open', ctaIcon: 'grid',
        pitch: 'Every game you create is saved here. Replay the family favourites any time.',
        meta: [online ? 'Saved online' : 'Needs internet', 'Your games'],
        steps: ['Games you create land here after you play them', 'New ones are marked, most recent first'],
      };
    case 'settings':
      return {
        title: 'Settings', cta: 'Open', ctaIcon: 'gear',
        pitch: 'Family-safe mode, bots, round length and music.',
        meta: [s.familySafe ? 'Family-safe on' : 'Family-safe off', s.bots ? 'Bots on' : 'Bots off', `${s.roundSec} s rounds`],
        steps: ['Up and down pick a setting', 'Left and right change it'],
      };
    case 'game': {
      const spec = item.spec!;
      const team = spec.teams === 2;
      const intro = introFor(spec);
      return {
        title: item.label, cta: 'Play', ctaIcon: 'play',
        pitch: intro.line ?? spec.hook,
        meta: [team ? '4 players' : '2–4 players', `${s.roundSec} s`, team ? 'Teams' : 'FFA'],
        steps: [...intro.steps.map((x) => x.text), `On your phone: ${intro.controls.map((c) => (c.kind === 'hold' ? `hold ${c.label}` : c.label)).join(', ')}`],
      };
    }
  }
}

export function Lobby({ state, status, onPlay, onCreate, onParty, onArcade, onFillBots, onSettings }: LobbyProps) {
  const [fi, setFi] = useState(Math.min(lastIndex, ITEMS.length - 1));
  const [info, setInfo] = useState(false);
  const item = ITEMS[fi]!;
  const online = status === 'online' && !!state.code;
  const humans = state.players.filter((p) => !p.isBot).length;
  const full = state.players.length >= MAX_PLAYERS;
  const copy = copyFor(item, state, online);

  // lastIndex is only written on select: while the screen unmounts, the focus manager hops through
  // the tiles being removed and their focus handlers fire
  const focusTile = (i: number) => { setFi(i); setInfo(false); };
  const act = (it: Item) => {
    lastIndex = Math.max(0, ITEMS.indexOf(it));
    if (it.kind === 'create') onCreate();
    else if (it.kind === 'party') onParty();
    else if (it.kind === 'arcade') onArcade();
    else if (it.kind === 'settings') onSettings();
    else if (it.spec) onPlay(it.spec);
  };

  useEffect(() => {
    focus.setBack(() => {
      if (info) { setInfo(false); return true; }
      const cur = focus.current;
      if (cur && !cur.classList.contains('htile')) {
        const t = document.querySelectorAll<HTMLElement>('.htile')[fi];
        if (t) { focus.focus(t); return true; }
      }
      return false; // home row: Back exits the app
    });
    return () => focus.setBack(undefined);
  }, [info, fi]);

  // row geometry: tiles after the focused one make room for its growth and its name
  const scroll = Math.max(0, fi - 3) * (T + GAP);
  const xOf = (i: number) => i * (T + GAP) + (i > fi ? T * (GROW - 1) + NAME_W : 0) - scroll;
  const nameX = xOf(fi) + T * GROW + 30;

  return (
    <section class={`screen home kind-${item.kind}`}>
      <div class="home-bg">
        <HeroLayers url={item.image} shift={fi * 6} />
        <div class="scrim scrim-home" />
      </div>
      <TopBar code={state.code} players={state.players} status={status} hideCode={humans < 2} />

      <nav class="hrow">
        {ITEMS.map((it, i) => (
          <HomeTile key={it.key} item={it} i={i} focused={i === fi} x={xOf(i)} onFocus={() => focusTile(i)} onSelect={() => act(it)} />
        ))}
        <div class="hrow-name" key={item.key} style={{ left: `${nameX}px` }}>{item.label}</div>
      </nav>

      <div class="hero-copy">
        <div class="hero-text" key={item.key}>
          <h1 class="wordmark">{copy.title}</h1>
          <p class="pitch">{copy.pitch}</p>
          <div class="meta">{copy.meta.map((m) => <span key={m}>{m}</span>)}</div>
        </div>
        <div class="hero-actions">
          <Pill col={fi} label={copy.cta} icon={copy.ctaIcon} primary onSelect={() => act(item)} />
          <RoundBtn col={fi + 1} label={info ? 'Hide' : 'How to play'} icon="info" onSelect={() => setInfo((v) => !v)} />
          <RoundBtn col={fi + 2} label={full ? 'Seats full' : 'Fill with bots'} icon="bots" disabled={!state.settings.bots || full} onSelect={onFillBots} />
        </div>
      </div>

      {info && (
        <aside class="howto glass" key={`info-${item.key}`}>
          <h2>How to play</h2>
          <ol>{copy.steps.map((s, i) => <li key={i} style={{ animationDelay: `${i * 0.05}s` }}>{s}</li>)}</ol>
        </aside>
      )}

      {humans < 2 && !info && (
        <aside class="join glass">
          {state.code ? <QR url={joinUrl(state.code)} /> : <div class="qr qr-empty">{status === 'offline' ? 'Offline' : '…'}</div>}
          <div class="join-text">
            <h2>Join on your phone</h2>
            <p>Scan with the camera, no app needed. Up to {MAX_PLAYERS} players.</p>
            <div class="join-code">{(state.code || '····').split('').map((c, i) => <b key={i}>{c}</b>)}</div>
          </div>
        </aside>
      )}
    </section>
  );
}
