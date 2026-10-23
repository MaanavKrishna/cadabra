// Shared 10-foot UI pieces: wordmark, top bar, backdrop, avatars, focusable tiles, captions.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AVATAR_ART, DEFAULT_ART_URLS, avatarArtFor, playerColor } from '@cadabra/render';
import type { Player } from '@cadabra/engine';
import { FocusManager, type FocusHandlers } from './focus';
import type { KeyArt } from '../fallback';
import { HERO } from './hero';
import { uiSound } from './sound';

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

export function Wordmark({ size = 34 }: { size?: number }) {
  return (
    <div class="brand" style={{ fontSize: `${size}px` }}>
      <svg class="brand-mark" viewBox="0 0 64 64" width={size * 0.95} height={size * 0.95} aria-hidden="true">
        <path d="M32 4 L37 27 L60 32 L37 37 L32 60 L27 37 L4 32 L27 27 Z" fill="#fff" />
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

/** The PS5-style corner: who is here (avatars), the room code chip, the clock. */
export function TopBar({ code, players, status, hideCode = false }: { code: string; players: Player[]; status: string; hideCode?: boolean }) {
  return (
    <header class="topbar">
      <Wordmark />
      <div class="top-right">
        {status !== 'online' && <span class="chip-status">{status === 'connecting' ? 'Connecting…' : 'Offline, bots only'}</span>}
        {players.length > 0 && (
          <span class="cluster">
            {players.slice(0, 4).map((p, i) => (
              <span key={p.id} class={`cluster-av ${p.connected ? '' : 'is-away'}`} style={{ ['--ring' as string]: colorOf(i), zIndex: 10 - i }}>
                <img src={avatarUrl(p)} alt="" />
              </span>
            ))}
          </span>
        )}
        {code && !hideCode && (
          <span class="code-chip"><Icon name="phone" /><b>{code}</b></span>
        )}
        <Clock />
      </div>
    </header>
  );
}

/** Full-bleed key art with a crossfade between games, plus the readability scrim. */
export function Backdrop({ art: k, dim = false }: { art: KeyArt; dim?: boolean }) {
  return (
    <div class={`backdrop ${dim ? 'is-dim' : ''}`}>
      <HeroLayers url={k.backdrop} />
      {k.sprites.length > 0 && (
        <div class="art-front">
          {k.sprites.map((s, j) => <Sprite key={`${k.backdrop.length}-${j}`} s={s} />)}
        </div>
      )}
      <div class="scrim" />
    </div>
  );
}

/**
 * Crossfading full-bleed images (about 400 ms). At most two layers exist, and only while a fade
 * runs; `shift` pans the art a little (parallax) when the focus moves along the tile row.
 */
export function HeroLayers({ url, shift = 0 }: { url: string; shift?: number }) {
  const [layers, setLayers] = useState<{ url: string; id: number }[]>([{ url, id: 0 }]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    setLayers((ls) => {
      const top = ls[ls.length - 1]!;
      if (top.url === url) return ls;
      return [top, { url, id: top.id + 1 }];
    });
    t = setTimeout(() => setLayers((ls) => (ls.length > 1 ? ls.slice(-1) : ls)), 520);
    return () => clearTimeout(t);
  }, [url]);
  return (
    <div class="hero-layers" style={{ transform: `translate3d(${-shift}px, 0, 0)` }}>
      {layers.map((l, i) => (
        <div key={l.id} class={`hero-img ${i > 0 ? 'is-in' : ''}`} style={{ backgroundImage: `url("${l.url}")` }} />
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
  return <img class="hero-sprite" src={url} alt="" style={style} />;
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

/** The calm backdrop for menus without key art (a baked soft wash, one opaque layer). */
export function NeonBg({ quiet = false, url }: { quiet?: boolean; url?: string }) {
  return (
    <div class={`calm-bg ${quiet ? 'is-quiet' : ''}`} aria-hidden="true">
      <HeroLayers url={url ?? HERO.calm} />
      <div class="scrim" />
    </div>
  );
}

/** A focusable pill button (white when focused, PS5 style). */
export function Pill({ row = 1, col, label, icon, primary = false, autofocus, onSelect, onFocus, disabled }: {
  row?: number; col: number; label: string; icon?: IconName; primary?: boolean; autofocus?: boolean; disabled?: boolean;
  onSelect: () => void; onFocus?: () => void;
}) {
  const ref = useFocusable(row, col, { autofocus, focus: onFocus, select: () => (disabled ? uiSound('deny') : onSelect()) });
  return (
    <div ref={ref} class={`pill-btn ${primary ? 'is-primary' : ''} ${disabled ? 'is-disabled' : ''}`} onClick={() => !disabled && onSelect()}>
      {icon && <Icon name={icon} />}<span>{label}</span>
    </div>
  );
}

/** A round secondary button; its label shows under it while focused. */
export function RoundBtn({ row = 1, col, label, icon, onSelect, onFocus, disabled }: {
  row?: number; col: number; label: string; icon: IconName; disabled?: boolean; onSelect: () => void; onFocus?: () => void;
}) {
  const ref = useFocusable(row, col, { focus: onFocus, select: () => (disabled ? uiSound('deny') : onSelect()) });
  return (
    <div ref={ref} class={`round-btn ${disabled ? 'is-disabled' : ''}`} onClick={() => !disabled && onSelect()}>
      <Icon name={icon} />
      <span class="round-lbl">{label}</span>
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

export type IconName = 'bots' | 'gear' | 'play' | 'again' | 'home' | 'next' | 'resume' | 'quit' | 'spark' | 'party' | 'grid' | 'save' | 'info' | 'phone' | 'trophy';

export function Icon({ name }: { name: IconName }) {
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
    save: (
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
        <path d="M14 8h28l10 10v38H14z" /><path d="M22 8v14h18V8" /><rect x="22" y="34" width="20" height="14" rx="2" />
      </g>
    ),
    grid: (
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round">
        <rect x="10" y="10" width="18" height="18" rx="4" /><rect x="36" y="10" width="18" height="18" rx="4" />
        <rect x="10" y="36" width="18" height="18" rx="4" /><rect x="36" y="36" width="18" height="18" rx="4" />
      </g>
    ),
    info: <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><circle cx="32" cy="32" r="24" /><path d="M32 29v15" /><circle cx="32" cy="20" r="1.5" fill="currentColor" /></g>,
    phone: <g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"><rect x="18" y="6" width="28" height="52" rx="6" /><path d="M28 49h8" /></g>,
    trophy: <path d="M20 8h24v6h10v6a12 12 0 0 1-11 12a12 12 0 0 1-8 6v8h9v8H20v-8h9v-8a12 12 0 0 1-8-6A12 12 0 0 1 10 20v-6h10z" fill="currentColor" />,
    quit: <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M18 18l28 28M46 18L18 46" /></g>,
  };
  return <svg class="icon" viewBox="0 0 64 64" aria-hidden="true">{paths[name]}</svg>;
}

/** PS5-style "Trophy unlocked" toast (top-right, small). */
export function TrophyToast({ t }: { t: { id: string; name: string; who?: string; tier: 'bronze' | 'silver' | 'gold' } }) {
  return (
    <div class={`trophy tier-${t.tier}`} key={t.id}>
      <span class="trophy-cup"><Icon name="trophy" /></span>
      <span class="trophy-text">
        <small>Trophy unlocked</small>
        <b>{t.name}</b>
        {t.who && <em>{t.who}</em>}
      </span>
    </div>
  );
}
