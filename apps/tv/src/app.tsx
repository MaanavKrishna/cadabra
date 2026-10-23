// The TV app: party state machine + room (phones) + key bridge + host voice + screens.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { duckMusic, setMusicVolume, setSfxVolume } from '@cadabra/render';
import { loadMusicVolume } from './audio-prefs';
import type { GameEvent, Judgement } from '@cadabra/engine';
import { MAX_PLAYERS, type BackendToClient, type GameSpec, type PeerMsg } from '@cadabra/spec';
import { initialState, reduce, humans, type Action, type PartyState, type Settings as S } from './state/machine';
import { Room } from './net/room';
import { phoneAction } from './net/replies';
import { phoneScreen } from './net/screens';
import { VoiceQueue, browserVoiceDeps } from './host/voice';
import { installKeyBridge, MenuTaps } from './ui/keys';
import { Caption, Toast, focus } from './ui/components';
import { DebugOverlay } from './ui/Debug';
import { QUICK_GAMES, cardFor, withRoundLength } from './fallback';
import { Lobby } from './screens/Lobby';
import { Settings } from './screens/Settings';
import { Play, type PlaySession } from './screens/Play';
import { Results } from './screens/Results';

const SAY_TIMEOUT_MS = 4500;

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const stateRef = useRef<PartyState>(state);
  stateRef.current = state;
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [caption, setCaption] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [winnerTeam, setWinnerTeam] = useState<0 | 1 | undefined>();
  const session = useRef<PlaySession | undefined>();
  const picked = useRef(new Set<string>());
  const sent = useRef(new Map<string, string>());
  const pendingSay = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const again = useRef(new Set<string>());
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const sayId = useRef(0);

  const showToast = (t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const voice = useMemo(
    () => new VoiceQueue(browserVoiceDeps({
      caption: setCaption,
      // the host voice ducks the music and lowers (not mutes) the sound effects
      duck: (on) => { duckMusic(on); setSfxVolume(on ? 0.4 : 1); },
      voiceOn: () => stateRef.current.settings.hostVoice,
    })),
    [],
  );

  const room = useMemo(() => new Room({
    code: (code) => dispatch({ type: 'room', code }),
    status: setStatus,
    join: (id, name, avatar) => {
      const s = stateRef.current;
      const known = s.players.some((p) => p.id === id) || s.spectators.includes(id);
      sent.current.delete(id); // (re)joined phone: resend its screen
      if (avatar) picked.current.add(id);
      dispatch({ type: 'join', id, name, ...(avatar ? { avatar } : {}) });
      session.current?.setConnected(id, true);
      if (!known) {
        showToast(`${name} joined`);
        hostSayRef.current({ kind: 'join', ctx: { name } }, `Welcome to the party, ${name}!`);
      }
    },
    left: (id) => {
      dispatch({ type: 'left', id });
      session.current?.setConnected(id, false);
      sent.current.delete(id);
    },
    input: (id, f) => session.current?.input(id, f),
    msg: (id, m: PeerMsg) => onPhone(id, m),
    backend: (m) => onBackend(m),
  }), []);

  // ---- host voice: AI line via the backend when online, else the local fallback text ----
  const hostSayRef = useRef((_req: { text?: string; kind?: 'join' | 'results' | 'finale'; ctx?: Record<string, unknown> }, _fallback: string) => {});
  hostSayRef.current = (req, fallback) => {
    const s = stateRef.current;
    const id = `say-${++sayId.current}`;
    const ok = s.code && room.send({
      t: 'host.say', code: s.code, id, ...req,
      ...(req.text ? { text: req.text.slice(0, 240) } : {}),
      personality: s.settings.hostPersonality, familySafe: s.settings.familySafe, voice: s.settings.hostVoice,
    });
    if (!ok) return voice.say({ text: fallback });
    pendingSay.current.set(id, setTimeout(() => {
      pendingSay.current.delete(id);
      voice.say({ text: fallback });
    }, SAY_TIMEOUT_MS));
  };
  const say = useCallback((text: string) => hostSayRef.current({ text }, text), []);

  function onBackend(m: BackendToClient) {
    if (m.t === 'host.audio') {
      const t = m.id ? pendingSay.current.get(m.id) : undefined;
      if (m.id && !t) return; // too late: the fallback caption already ran
      if (t) { clearTimeout(t); pendingSay.current.delete(m.id!); }
      voice.say({ text: m.text, ...(m.url ? { url: m.url } : {}) });
    } else if (m.t === 'host.roasted') {
      const t = pendingSay.current.get(m.id);
      if (!t) return;
      clearTimeout(t);
      pendingSay.current.delete(m.id);
      m.lines.forEach((text, i) => {
        const url = m.urls?.[i];
        voice.say({ text, ...(url ? { url } : {}) });
      });
    } else if (m.t === 'forge.art') {
      // generated art for the coming game (absent while the image model is unavailable)
      const spec = stateRef.current.spec;
      if (!m.specId || !spec || m.specId === spec.id) dispatch({ type: 'art', key: m.key, url: m.url });
    } else if (m.t === 'judge.result') {
      session.current?.resolveJudgement(m.id, m.result);
    }
  }

  function onPhone(id: string, m: PeerMsg) {
    const a = phoneAction(id, m);
    if (!a) return;
    if (a.type === 'avatar') {
      picked.current.add(id);
      dispatch(a);
    } else if (a.type === 'pick') {
      const s = stateRef.current;
      if (s.phase !== 'results') return;
      if (a.action === 'again') again.current.add(id);
      const want = humans(s).filter((p) => p.connected).length;
      if (want > 0 && again.current.size * 2 > want) actions.current.again();
    } else if (a.type === 'ingredient' || a.type === 'vote') {
      dispatch(a);
    }
  }

  // ---- game flow ----
  const start = (spec: GameSpec) => {
    const s = stateRef.current;
    const card = cardFor(spec);
    const seats = humans(s).length === 0 ? MAX_PLAYERS : card.seats;
    let next = s;
    if (s.players.length < seats) {
      if (!s.settings.bots) {
        showToast(`${spec.title} needs ${seats} players. Join on your phone, or turn bots on.`);
        return;
      }
      next = reduce(next, { type: 'fillBots' });
      dispatch({ type: 'fillBots' });
    }
    if (next.players.length < seats) return showToast(`${spec.title} needs ${seats} players.`);
    again.current.clear();
    setWinnerTeam(undefined);
    voice.clear();
    // dev only: ?dur=N shortens rounds for a quick look at the finale and results
    const dur = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('dur')) : 0;
    dispatch({ type: 'start', spec: withRoundLength(spec, dur >= 30 ? dur : s.settings.roundSec) });
  };

  const actions = useRef({ again: () => {}, next: () => {}, lobby: () => {} });
  actions.current = {
    again: () => {
      const spec = stateRef.current.spec;
      if (!spec) return;
      const base = QUICK_GAMES.find((g) => g.id === spec.id) ?? spec;
      start(base);
    },
    next: () => {
      const i = QUICK_GAMES.findIndex((g) => g.id === stateRef.current.spec?.id);
      start(QUICK_GAMES[(i + 1) % QUICK_GAMES.length]!);
    },
    lobby: () => {
      voice.clear();
      dispatch({ type: 'lobby' });
    },
  };

  const onDone = useCallback((ranking: { id: string; score: number }[], events: GameEvent[], team?: 0 | 1) => {
    const s = stateRef.current;
    setWinnerTeam(team);
    dispatch({ type: 'results', ranking });
    const names = new Map(s.players.map((p) => [p.id, p.name]));
    const winner = names.get(ranking[0]?.id ?? '') ?? 'Everyone';
    const fallback = team !== undefined ? `Team ${team === 0 ? 'Red' : 'Blue'} pulls it off!` : `${winner} takes the crown!`;
    const id = `roast-${++sayId.current}`;
    const ok = s.code && s.spec && room.send({
      t: 'host.roast', code: s.code, id,
      events: events.slice(-800).map((e) => ({ t: e.t, type: e.type.slice(0, 40), ...(e.player ? { player: e.player.slice(0, 40) } : {}), ...(e.data ? { data: e.data } : {}) })),
      players: s.players.map((p) => ({ id: p.id.slice(0, 40), name: p.name.slice(0, 40) })),
      title: s.spec.title.slice(0, 80), hook: s.spec.hook.slice(0, 200),
      personality: s.settings.hostPersonality, familySafe: s.settings.familySafe, voice: s.settings.hostVoice,
    });
    if (!ok) return voice.say({ text: fallback });
    pendingSay.current.set(id, setTimeout(() => { pendingSay.current.delete(id); voice.say({ text: fallback }); }, 9000));
  }, []);

  const judge = useCallback((j: Judgement) => {
    const s = stateRef.current;
    return !!s.code && room.send({ t: 'judge.request', code: s.code, id: j.id, kind: j.kind, payload: j.payload });
  }, []);

  // ---- boot: room, keys, scale ----
  useEffect(() => {
    setMusicVolume(loadMusicVolume());
    room.start();
    const taps = new MenuTaps();
    const off = installKeyBridge({
      focus,
      phase: () => stateRef.current.phase,
      onPlayPause: () => session.current?.togglePause(),
      onMenu: () => { if (taps.tap(performance.now())) setDebug((d) => !d); },
    });
    return () => { off(); room.close(); };
  }, []);

  // ---- phones: each one shows the screen for the current state ----
  useEffect(() => {
    for (const id of [...state.players.filter((p) => !p.isBot).map((p) => p.id), ...state.spectators]) {
      const scr = phoneScreen(state, id, picked.current.has(id));
      if (!scr) continue;
      const key = JSON.stringify(scr);
      if (sent.current.get(id) === key) continue;
      sent.current.set(id, key);
      room.screen(id, scr.name, scr.data as never);
    }
  }, [state]);

  // a screen change resets focus targets; settings view only exists in the lobby
  useEffect(() => { if (state.phase !== 'lobby') setView('main'); }, [state.phase]);

  const changeSettings = useCallback((p: Partial<S>) => dispatch({ type: 'settings', patch: p }), []);
  const closeSettings = useCallback(() => setView('main'), []);
  const toLobby = useCallback(() => actions.current.lobby(), []);

  let screen;
  if (state.phase === 'play' && state.spec) {
    screen = (
      <Play
        key={state.round}
        state={state}
        session={session}
        judge={judge}
        say={say}
        onDone={onDone}
        onQuit={toLobby}
        onRestart={() => actions.current.again()}
      />
    );
  } else if (state.phase === 'results' && state.spec) {
    screen = <Results state={state} status={status} winnerTeam={winnerTeam} onAgain={() => actions.current.again()} onNext={() => actions.current.next()} onLobby={toLobby} />;
  } else if (view === 'settings') {
    screen = <Settings state={state} status={status} onChange={changeSettings} onClose={closeSettings} />;
  } else {
    screen = (
      <Lobby
        state={state}
        status={status}
        onPlay={start}
        onFillBots={() => dispatch({ type: 'fillBots' } satisfies Action)}
        onSettings={() => setView('settings')}
      />
    );
  }

  return (
    <div class="stage">
      {screen}
      <Caption text={caption} />
      <Toast text={toast} />
      {debug && (
        <DebugOverlay
          players={() => room.players()}
          fps={() => session.current?.fps()}
          info={() => `${state.phase} · ${status}${state.code ? ` · ${state.code}` : ''} · ${state.players.length}p ${state.spectators.length}s`}
        />
      )}
    </div>
  );
}
