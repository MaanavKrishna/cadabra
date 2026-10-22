import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { SCREEN_NAMES, type InputFrame, type PeerMsg, type ScreenName } from '@cadabra/spec';
import type { ControllerClient } from './client';
import { CODE_LEN, normalizeCode } from './code';
import { asObj, type AnyScreen, type Reply, type ScreenData } from './protocol';
import { applyTheme } from './theme';
import { avatarUrl } from './avatars';
import { JoinScreen } from './screens/join';
import { AvatarScreen, BlockedScreen, WaitScreen } from './screens/lobby';
import { StormScreen, VoteScreen } from './screens/storm';
import { PlayScreen, WarmupScreen } from './screens/play';
import { RemixScreen, ResultsScreen, TweakScreen } from './screens/after';
import { Mark } from './ui/kit';

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

/** Pure router: a TV PeerMsg → the screen to show (or null to ignore). */
export function routeMessage(msg: PeerMsg): AnyScreen | null {
  if (msg.t !== 'screen' || !(SCREEN_NAMES as readonly string[]).includes(msg.name)) return null;
  return { name: msg.name, data: asObj(msg.data) };
}

export function App({ client, initialCode, autoJoinName }: { client: ControllerClient; initialCode: string; autoJoinName?: string }) {
  const [code, setCode] = useState(normalizeCode(initialCode));
  const [name, setName] = useState(() => autoJoinName ?? load(NAME_KEY));
  const [avatar, setAvatar] = useState<string>();
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<AnyScreen>({ name: 'join', data: {} });
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
      applyTheme(next.data.themeVars);
      setScreen(next);
    });
    client.on('tv.left', () => setTvAway(true));
    client.on('tv.back', () => setTvAway(false));
    client.on('mode', armRelay);
    return () => clearTimeout(relayTimer.current);
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

  const reply: Reply = useCallback((n, data) => { client.send({ t: 'screen', name: n as ScreenName, data }); }, [client]);
  const onFrame = useCallback((f: InputFrame) => client.sendInput(f), [client]);

  const showJoin = !joined || screen.name === 'join';
  const d = screen.data as any;
  const url = avatarUrl(avatar);

  return (
    <div class={`app ${showJoin ? 'is-menu' : ''} on-${showJoin ? 'join' : screen.name}`}>
      <div class="backdrop" aria-hidden="true"><i class="blob b1" /><i class="blob b2" /><i class="blob b3" />{showJoin && <i class="beam" />}<i class="grain" /></div>
      {tvAway && (
        <div class="banner" data-banner="tv-left" role="status">
          <span class="spinner" /> TV disconnected. Hang tight, we'll reconnect automatically.
        </div>
      )}
      {!tvAway && relayBanner && joined && (
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
        {showJoin ? (
          <JoinScreen
            code={code} name={name} busy={busy} error={error}
            onCode={(v) => { setCode(v); setError(''); }}
            onName={(v) => { setName(v); setError(''); }}
            onSubmit={join}
          />
        ) : screen.name === 'avatar' ? <AvatarScreen data={d as ScreenData['avatar']} reply={reply} avatar={avatar} setAvatar={setAvatar} />
          : screen.name === 'storm' ? <StormScreen data={d} reply={reply} />
          : screen.name === 'vote' ? <VoteScreen data={d} reply={reply} />
          : screen.name === 'warmup' ? <WarmupScreen data={d} reply={reply} onFrame={onFrame} />
          : screen.name === 'play' ? <PlayScreen data={d} onFrame={onFrame} />
          : screen.name === 'results' ? <ResultsScreen data={d} reply={reply} />
          : screen.name === 'remix' ? <RemixScreen data={d} reply={reply} />
          : screen.name === 'tweak' ? <TweakScreen data={d} />
          : screen.name === 'blocked' ? <BlockedScreen data={d} />
          : <WaitScreen data={d} name={name} avatar={avatar} />}
      </main>
    </div>
  );
}
