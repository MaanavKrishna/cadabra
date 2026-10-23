// Shared 10-foot UI pieces: wordmark, top bar, backdrop, avatars, focusable tiles, captions.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AVATAR_ART, DEFAULT_ART_URLS, avatarArtFor, playerColor } from '@cadabra/render';
import type { Player } from '@cadabra/engine';
import { FocusManager, type FocusHandlers } from './focus';
import type { KeyArt } from '../fallback';

/** The one focus manager for the app (the key bridge drives it). */
export const focus = new FocusManager();

export const art = (key: string): string | undefined => DEFAULT_ART_URLS[key];

/** A phone's on-device stylized selfie (data:image/jpeg|webp). */
export const isSelfie = (a: string | undefined): a is string => !!a && a.startsWith('data:image/');

export function avatarUrl(p: { id: string; avatar?: string }): string | undefined {
  if (isSelfie(p.avatar)) return p.avatar;
  const name = avatarArtFor({ id: p.id, avatar: p.avatar ?? '' }, DEFAULT_ART_URLS);
  return name ? DEFAULT_ART_URLS[name] : DEFAULT_ART_URLS[AVATAR_ART[0]!];
}

export const colorOf = (i: number) => `#${playerColor(i).toString(16).padStart(6, '0')}`;

/** Register an element with the focus manager for as long as it is mounted. */
export function useFocusable(row: number, col: number, h: FocusHandlers & { autofocus?: boolean } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const hr = useRef(h);
  hr.current = h;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const off = focus.register(el, row, col, {
      select: () => (hr.current.select ? hr.current.select() : el.click()),
      left: () => hr.current.left?.() ?? false,
      right: () => hr.current.right?.() ?? false,
      focus: () => hr.current.focus?.(),
    });
    if (h.autofocus) focus.focus(el);
    return off;
  }, [row, col]);
  return ref;
}

export function Wordmark({ size = 44 }: { size?: number }) {
  return (
    <div class="brand" style={{ fontSize: `${size}px` }}>
      <svg class="brand-mark" viewBox="0 0 64 64" width={size * 1.15} height={size * 1.15} aria-hidden="true">
        <defs>
          <linearGradient id="beam" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stop-color="var(--c-primary)" stop-opacity="0" />
            <stop offset="0.55" stop-color="var(--c-primary)" stop-opacity="0.75" />
            <stop offset="1" stop-color="#ffffff" />
          </linearGradient>
        </defs>
        <path d="M4 60 L40 18 L48 26 Z" fill="url(#beam)" />
        <path d="M46 6 L49.5 16.5 L60 20 L49.5 23.5 L46 34 L42.5 23.5 L32 20 L42.5 16.5 Z" fill="#fff" />
        <circle cx="46" cy="20" r="3" fill="var(--c-glow)" />
      </svg>
      <span>cadabra</span>
    </div>
  );
}

function Clock() {
  const fmt = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const [t, setT] = useState(fmt);
  useEffect(() => {
    const id = setInterval(() => setT(fmt()), 15_000);
    return () => clearInterval(id);
  }, []);
  return <span class="clock">{t}</span>;
}

export function TopBar({ code, players, status }: { code: string; players: Player[]; status: string }) {
  return (
    <header class="topbar">
      <Wordmark />
      <div class="top-right">
        {status !== 'online' && <span class="pill pill-warn">{status === 'connecting' ? 'Connecting…' : 'Offline · bots only'}</span>}
        {code && <span class="pill">Room <b>{code}</b></span>}
        <span class="mini-avatars">
          {players.map((p, i) => (
            <img key={p.id} src={avatarUrl(p)} alt="" style={{ borderColor: colorOf(i) }} class={p.connected ? '' : 'is-away'} />
          ))}
        </span>
        <Clock />
      </div>
    </header>
  );
}

/** Full-bleed key art with a crossfade between games, plus the readability scrim. */
export function Backdrop({ art: k, dim = false }: { art: KeyArt; dim?: boolean }) {
  const [layers, setLayers] = useState<{ k: KeyArt; id: number }[]>([{ k, id: 0 }]);
  useEffect(() => {
    setLayers((ls) => (ls[ls.length - 1]!.k === k ? ls : [...ls.slice(-1), { k, id: ls[ls.length - 1]!.id + 1 }]));
  }, [k]);
  return (
    <div class={`backdrop ${dim ? 'is-dim' : ''}`}>
      {layers.map((l, i) => (
        <div key={l.id} class={`art-layer ${i === layers.length - 1 ? 'is-on' : 'is-off'}`}>
          <div class="art" style={{ backgroundImage: `url("${l.k.backdrop}")` }} />
          {l.k.sprites.filter((s) => s.depth === 'back').map((s, j) => <Sprite key={j} s={s} />)}
        </div>
      ))}
      <div class="scrim" />
      {layers.slice(-1).map((l) => (
        <div key={l.id} class="art-front">
          {l.k.sprites.filter((s) => s.depth !== 'back').map((s, j) => <Sprite key={j} s={s} />)}
        </div>
      ))}
    </div>
  );
}

function Sprite({ s }: { s: KeyArt['sprites'][number] }) {
  const url = art(s.key);
  if (!url) return null;
  const style: JSX.CSSProperties = {
    left: `${s.x - s.w / 2}px`, top: `${s.y}px`, width: `${s.w}px`,
    transform: `translateY(-50%) rotate(${s.rot ?? 0}deg)`,
  };
  return <img class={`hero-sprite ${s.float ? 'is-float' : ''}`} src={url} alt="" style={style} />;
}

export function Avatar({ p, size, index, ring = true }: { p: Player; size: number; index: number; ring?: boolean }) {
  return (
    <div class={`avatar ${p.connected ? '' : 'is-away'}`} style={{ width: `${size}px`, height: `${size}px`, ['--ring' as string]: ring ? colorOf(index) : 'transparent' }}>
      <img src={avatarUrl(p)} alt="" />
      {p.isBot && <span class="bot-chip">BOT</span>}
    </div>
  );
}

export interface TileProps {
  row?: number;
  col: number;
  label: string;
  sub?: string;
  onSelect: () => void;
  onFocus?: () => void;
  autofocus?: boolean;
  disabled?: boolean;
  class?: string;
  children?: ComponentChildren;
  style?: JSX.CSSProperties;
}

export function Tile(p: TileProps) {
  const ref = useFocusable(p.row ?? 0, p.col, { select: () => !p.disabled && p.onSelect(), focus: p.onFocus, autofocus: p.autofocus });
  return (
    <div ref={ref} class={`tile ${p.class ?? ''} ${p.disabled ? 'is-disabled' : ''}`} style={p.style} onClick={() => !p.disabled && p.onSelect()}>
      <div class="tile-body">{p.children}</div>
      <div class="tile-label">
        <span>{p.label}</span>
        {p.sub && <small>{p.sub}</small>}
      </div>
    </div>
  );
}

/** The neon arcade backdrop: a pre-made gradient grid with two glows (no filters, no per-frame work). */
export function NeonBg({ quiet = false }: { quiet?: boolean }) {
  return (
    <div class={`neon-bg ${quiet ? 'is-quiet' : ''}`} aria-hidden="true">
      <div class="neon-floor" />
      <div class="neon-horizon" />
    </div>
  );
}

/** The host's line as a big animated caption (no voice): words rise in one after another. */
export function Caption({ text }: { text: string | null }) {
  const [shown, setShown] = useState(text);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (text) { setShown(text); setSeq((n) => n + 1); }
  }, [text]);
  const words = (shown ?? '').split(/\s+/).filter(Boolean);
  return (
    <div class={`caption ${text ? 'is-on' : ''}`} aria-live="polite">
      <span class="caption-dot" />
      <span class="caption-text" key={seq}>
        {words.map((w, i) => <span key={i} class="cw" style={{ animationDelay: `${Math.min(i, 24) * 0.045}s` }}>{w} </span>)}
      </span>
    </div>
  );
}

export function Toast({ text }: { text: string | null }) {
  return <div class={`toast ${text ? 'is-on' : ''}`}>{text}</div>;
}

export function Icon({ name }: { name: 'bots' | 'gear' | 'play' | 'again' | 'home' | 'next' | 'resume' | 'quit' | 'spark' | 'party' | 'grid' }) {
  const paths: Record<string, JSX.Element> = {
    bots: (
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="14" y="22" width="36" height="28" rx="9" />
        <path d="M32 22v-9" /><circle cx="32" cy="11" r="3" fill="currentColor" />
        <circle cx="25" cy="35" r="3.5" fill="currentColor" stroke="none" /><circle cx="39" cy="35" r="3.5" fill="currentColor" stroke="none" />
        <path d="M26 43h12" /><path d="M8 32v8M56 32v8" />
      </g>
    ),
    gear: (
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round">
        <circle cx="32" cy="32" r="9" />
        <path d="M32 8v8M32 48v8M8 32h8M48 32h8M15 15l6 6M43 43l6 6M15 49l6-6M43 21l6-6" />
      </g>
    ),
    play: <path d="M22 14 L52 32 L22 50 Z" fill="currentColor" />,
    resume: <path d="M22 14 L52 32 L22 50 Z" fill="currentColor" />,
    again: <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M50 32a18 18 0 1 1-6-13.4" /><path d="M46 8v12H34" /></g>,
    home: <g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"><path d="M10 30 L32 12 L54 30" /><path d="M16 26v26h32V26" /></g>,
    next: <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 32h34" /><path d="M36 18l14 14-14 14" /></g>,
    spark: (
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
        <path d="M30 6 L35 25 L54 30 L35 35 L30 54 L25 35 L6 30 L25 25 Z" />
        <path d="M50 8v8M46 12h8M12 46v8M8 50h8" />
      </g>
    ),
    party: (
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
        <path d="M18 54h28M32 54V40M20 10h24v10a12 12 0 0 1-24 0Z" />
        <path d="M20 14H10v4a8 8 0 0 0 10 8M44 14h10v4a8 8 0 0 1-10 8" />
      </g>
    ),
    grid: (
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round">
        <rect x="10" y="10" width="18" height="18" rx="4" /><rect x="36" y="10" width="18" height="18" rx="4" />
        <rect x="10" y="36" width="18" height="18" rx="4" /><rect x="36" y="36" width="18" height="18" rx="4" />
      </g>
    ),
    quit: <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M18 18l28 28M46 18L18 46" /></g>,
  };
  return <svg class="icon" viewBox="0 0 64 64" aria-hidden="true">{paths[name]}</svg>;
}
