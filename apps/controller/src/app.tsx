import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { SCREEN_NAMES, parseScreenData, replyMsg, type InputFrame, type ParsedScreen, type PeerMsg } from '@cadabra/spec';
import type { ControllerClient } from './client';
import { CODE_LEN, normalizeCode } from './code';
import type { SendReply } from './protocol';
import { applyTheme } from './theme';
import { avatarUrl } from './avatars';
import { JoinScreen } from './screens/join';
import { AvatarScreen, BlockedScreen, WaitScreen } from './screens/lobby';
import { StormScreen, VoteScreen } from './screens/storm';
import { PlayScreen, WarmupScreen } from './screens/play';
import { RemixScreen, ResultsScreen, TweakScreen } from './screens/after';
import { Mark } from './ui/kit';
import { ScreenBoundary } from './ui/boundary';

const NAME_KEY = 'cadabra.name';
const RELAY_BANNER_DELAY_MS = 6000;

const JOIN_ERRORS: Record<string, string> = {
  'room.notFound': "We couldn't find that room. Check the code on the TV.",
  'room.full': 'That room is full (4 players max).',
  'room.badRequest': 'Hmm, that code or name looks off. Try again.',
  'join.timeout': "Couldn't reach the room. Check your Wi‑Fi and try again.",
};

const load = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

const WAITING: ParsedScreen = { name: 'wait', data: { message: 'Waiting for the TV…', sub: 'Hang tight, the next screen is on its way.' } };
const ERROR_BANNER_MS = 4000;

/**
 * Pure router: a TV PeerMsg → the screen to show, or null to ignore it.
 * Payloads are validated per screen; a bad payload shows the waiting state instead of crashing.
 */
export function routeMessage(msg: PeerMsg): ParsedScreen | null {
  if (msg.t !== 'screen' || !(SCREEN_NAMES as readonly string[]).includes(msg.name)) return null;
  const r = parseScreenData(msg.name, msg.data);
  if (r.ok) return r.screen;
  return r.reason === 'reply' ? null : WAITING;
}

const themeOf = (data: unknown) => (data && typeof data === 'object' ? (data as { themeVars?: unknown }).themeVars : undefined);

export function App({ client, initialCode, autoJoinName }: { client: ControllerClient; initialCode: string; autoJoinName?: string }) {
  const [code, setCode] = useState(normalizeCode(initialCode));
  const [name, setName] = useState(() => autoJoinName ?? load(NAME_KEY));
  const [avatar, setAvatar] = useState<string>();
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<ParsedScreen>({ name: 'join', data: {} });
  const [seq, setSeq] = useState(0);
  const [linkDown, setLinkDown] = useState(false);
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const [netError, setNetError] = useState(false);
  const errTimer = useRef<ReturnType<typeof setTimeout>>();
  const [tvAway, setTvAway] = useState(false);
  const [relayBanner, setRelayBanner] = useState(false);
  const relayTimer = useRef<ReturnType<typeof setTimeout>>();
  const joinedRef = useRef(false);

  useEffect(() => {
    const armRelay = (mode: string) => {
      clearTimeout(relayTimer.current);
      if (mode === 'direct') { setRelayBanner(false); return; }
      relayTimer.current = setTimeout(() => setRelayBanner(joinedRef.current), RELAY_BANNER_DELAY_MS);
    };
    client.on('msg', (m: PeerMsg) => {
      const next = routeMessage(m);
      if (!next) return;
      if (m.t === 'screen') applyTheme(themeOf(m.data));
      setScreen(next);
      setSeq((n) => n + 1);
    });
    client.on('error', () => {
      setNetError(true);
      clearTimeout(errTimer.current);
      errTimer.current = setTimeout(() => setNetError(false), ERROR_BANNER_MS);
    });
    client.on('link', (state: 'up' | 'down') => setLinkDown(state === 'down'));
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    client.on('tv.left', () => setTvAway(true));
    client.on('tv.back', () => setTvAway(false));
    client.on('mode', armRelay);
    return () => {
      clearTimeout(relayTimer.current);
      clearTimeout(errTimer.current);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [client]);

  useEffect(() => {
    document.documentElement.dataset.screen = screen.name;
  }, [screen.name]);

  const join = async () => {
    const c = normalizeCode(code);
    const n = name.trim();
    if (c.length !== CODE_LEN) return setError('Enter the 4-letter code shown on your TV.');
    if (!n) return setError('What should we call you?');
    setError('');
    setBusy(true);
    save(NAME_KEY, n);
    try {
      await client.join(c, n);
      joinedRef.current = true;
      setJoined(true);
      setScreen((s) => (s.name === 'join' ? { name: 'wait', data: {} } : s));
      setSeq((n) => n + 1);
      if (client.mode === 'relay') {
        clearTimeout(relayTimer.current);
        relayTimer.current = setTimeout(() => setRelayBanner(joinedRef.current && client.mode === 'relay'), RELAY_BANNER_DELAY_MS);
      }
    } catch (e) {
      setError(JOIN_ERRORS[(e as Error).message] ?? 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { if (autoJoinName) void join(); }, []);

  const reply: SendReply = useCallback((r) => {
    try { client.send(replyMsg(r)); } catch (e) { console.warn('[controller] invalid reply dropped', e); }
  }, [client]);
  const onFrame = useCallback((f: InputFrame) => client.sendInput(f), [client]);

  const showJoin = !joined || screen.name === 'join';
  const url = avatarUrl(avatar);
  const reconnecting = joined && (linkDown || offline);

  return (
    <div class={`app ${showJoin ? 'is-menu' : ''} on-${showJoin ? 'join' : screen.name}`}>
      <div class="backdrop" aria-hidden="true"><i class="blob b1" /><i class="blob b2" /><i class="blob b3" />{showJoin && <i class="beam" />}<i class="grain" /></div>
      {tvAway && (
        <div class="banner" data-banner="tv-left" role="status">
          <span class="spinner" /> TV disconnected. Hang tight, we'll reconnect automatically.
        </div>
      )}
      {!tvAway && reconnecting && (
        <div class="banner" data-banner="reconnecting" role="status">
          <span class="spinner" /> {offline ? "You're offline. Reconnecting when your Wi‑Fi is back…" : 'Connection dropped. Reconnecting…'}
        </div>
      )}
      {!tvAway && !reconnecting && netError && (
        <div class="banner" data-banner="error" role="status">Hmm, a message didn't get through. Retrying…</div>
      )}
      {!tvAway && !reconnecting && !netError && relayBanner && joined && (
        <div class="banner subtle" data-banner="relay" role="status">Playing over the internet · tiny bit of lag</div>
      )}
      {!showJoin && screen.name !== 'play' && (
        <div class="topbar">
          <div class="tb-brand"><Mark size={24} /><span>{code}</span></div>
          <div class="tb-me">
            <span>{name}</span>
            <span class="tb-av">{url ? <img src={url} alt="" /> : name.slice(0, 1).toUpperCase()}</span>
          </div>
        </div>
      )}
      <main class="stage" key={showJoin ? 'join' : screen.name}>
        <ScreenBoundary resetKey={seq} fallback={<WaitScreen data={WAITING.data} name={name} avatar={avatar} />}>
        {showJoin ? (
          <JoinScreen
            code={code} name={name} busy={busy} error={error}
            onCode={(v) => { setCode(v); setError(''); }}
            onName={(v) => { setName(v); setError(''); }}
            onSubmit={join}
          />
        ) : renderScreen(screen, { reply, onFrame, name, avatar, setAvatar })}
        </ScreenBoundary>
      </main>
    </div>
  );
}

interface Ctx { reply: SendReply; onFrame(f: InputFrame): void; name: string; avatar?: string; setAvatar(a: string): void }

function renderScreen(s: ParsedScreen, c: Ctx) {
  switch (s.name) {
    case 'avatar': return <AvatarScreen data={s.data} reply={c.reply} avatar={c.avatar} setAvatar={c.setAvatar} />;
    case 'storm': return <StormScreen data={s.data} reply={c.reply} />;
    case 'vote': return <VoteScreen data={s.data} reply={c.reply} />;
    case 'warmup': return <WarmupScreen data={s.data} reply={c.reply} onFrame={c.onFrame} />;
    case 'play': return <PlayScreen data={s.data} onFrame={c.onFrame} />;
    case 'results': return <ResultsScreen data={s.data} reply={c.reply} />;
    case 'remix': return <RemixScreen data={s.data} reply={c.reply} />;
    case 'tweak': return <TweakScreen data={s.data} />;
    case 'blocked': return <BlockedScreen data={s.data} />;
    case 'wait': return <WaitScreen data={s.data} name={c.name} avatar={c.avatar} />;
    default: return <WaitScreen data={{}} name={c.name} avatar={c.avatar} />;
  }
}
