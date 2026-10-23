// The TV app: party state machine + room (phones) + key bridge + host captions + screens.
// Flows: Create (AI forge: storm -> pitches -> vote -> forge -> play), Party (4 quick rounds with a
// points table) and Quick Play (one built-in game). The host never speaks: lines are big captions.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { setMusicVolume } from '@cadabra/render';
import { loadMusicVolume } from './audio-prefs';
import type { GameEvent, Judgement } from '@cadabra/engine';
import { MAX_PLAYERS, isSafeArtUrl, type ArcadeGameSummary, type BackendToClient, type GameSpec, type PeerMsg } from '@cadabra/spec';
import { initialState, reduce, humans, type Action, type PartyState, type Settings as S } from './state/machine';
import { Room } from './net/room';
import { phoneAction } from './net/replies';
import { phoneScreen } from './net/screens';
import { VoiceQueue, browserVoiceDeps } from './host/voice';
import { installKeyBridge, MenuTaps } from './ui/keys';
import { uiSound } from './ui/sound';
import { preloadHeroes } from './ui/hero';
import { Caption, Toast, focus } from './ui/components';
import { DebugOverlay } from './ui/Debug';
import { QUICK_GAMES, cardFor, withRoundLength } from './fallback';
import {
  ALL_VOTED_MS, DEFAULT_INGREDIENTS, FORGE_MIN_MS, FORGE_TIMEOUT_MS, PITCH_TIMEOUT_MS, STORM_SEC, VOTE_SEC,
  fallbackGame, isForgeMsg, pickWinner,
} from './forge/forge';
import { finishRound, isOver, newParty, nextRound, type PartyRun } from './play/party';
import { TEAM_NAME } from './play/flow';
import { ForgeBuild, Pitches, Storm } from './screens/Forge';
import { PartyChampion, PartyStandings } from './screens/Party';
import { Lobby } from './screens/Lobby';
import { Arcade } from './screens/Arcade';
import { Settings } from './screens/Settings';
import { Play, type PlaySession } from './screens/Play';
import { Results } from './screens/Results';

const SAY_TIMEOUT_MS = 4500;
/** "Game ready" stays on the forge screen this long before the intro card. */
const READY_HOLD_MS = 900;
const FORGE_PHASES = ['storm', 'pitching', 'voting', 'forge'] as const;
const inForge = (p: string) => (FORGE_PHASES as readonly string[]).includes(p);

export function App() {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState());
  const stateRef = useRef<PartyState>(state);
  stateRef.current = state;
  const [view, setView] = useState<'main' | 'settings' | 'arcade'>('main');
  const [arcadeGames, setArcadeGames] = useState<ArcadeGameSummary[] | undefined>();
  const [arcadeLoading, setArcadeLoading] = useState<string | undefined>();
  const arcadeTimer = useRef<ReturnType<typeof setTimeout>>();
  const arcadeWant = useRef<string>();
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
  // ---- forge flow timers and party run ----
  const [endsAt, setEndsAt] = useState<number | undefined>();
  const forgeTimer = useRef<ReturnType<typeof setTimeout>>();
  const voteCloseTimer = useRef<ReturnType<typeof setTimeout>>();
  const forgeAt = useRef(0);
  const focusedPitch = useRef(1);
  const busyRetried = useRef(false);
  const [party, setPartyState] = useState<PartyRun | undefined>();
  const partyRef = useRef<PartyRun | undefined>();
  const setParty = (r: PartyRun | undefined) => { partyRef.current = r; setPartyState(r); };

  const showToast = (t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  // No host voice (N3): the queue only paces the captions (voiceOn is always false, no audio URL).
  const voice = useMemo(
    () => new VoiceQueue(browserVoiceDeps({ caption: setCaption, duck: () => {}, voiceOn: () => false })),
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
      personality: s.settings.hostPersonality, familySafe: s.settings.familySafe, voice: false,
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
      voice.say({ text: m.text });
    } else if (m.t === 'host.roasted') {
      const t = pendingSay.current.get(m.id);
      if (!t) return;
      clearTimeout(t);
      pendingSay.current.delete(m.id);
      m.lines.forEach((text) => voice.say({ text }));
    } else if (isForgeMsg(m)) {
      // the reducer drops messages of another forge (forgeId) or a stale phase
      dispatch({ type: 'forge', msg: m });
    } else if (m.t === 'error') {
      const phase = stateRef.current.phase;
      if (m.code === 'forge.busy' && phase === 'pitching') {
        // the room's last forge still holds the lock: retry once, then a built-in game
        if (busyRetried.current) return forgeFallback();
        busyRetried.current = true;
        showToast('The forge is warming up…');
        clearTimeout(forgeTimer.current);
        forgeTimer.current = setTimeout(() => sendPitch(), 3500);
      } else if (m.code === 'room.rateLimited' && phase === 'pitching') {
        forgeFallback();
      }
    } else if (m.t === 'arcade.items') {
      setArcadeGames([...m.games].sort((a, b) => Number(b.unplayed) - Number(a.unplayed) || b.lastPlayed - a.lastPlayed));
    } else if (m.t === 'arcade.game') {
      if (!arcadeWant.current || stateRef.current.phase !== 'lobby') return;
      clearTimeout(arcadeTimer.current);
      arcadeWant.current = undefined;
      setArcadeLoading(undefined);
      const art: Record<string, string> = {};
      if (m.art?.keyArt) art.keyArt = m.art.keyArt;
      for (const [k, v] of Object.entries(m.art?.sprites ?? {})) art[k] = v;
      setParty(undefined);
      start(m.spec, art);
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
      if (s.phase !== 'results' || partyRef.current) return;
      if (a.action === 'again') again.current.add(id);
      const want = humans(s).filter((p) => p.connected).length;
      if (want > 0 && again.current.size * 2 > want) actions.current.again();
    } else if (a.type === 'ingredient' || a.type === 'vote') {
      dispatch(a);
    }
  }

  // ---- game flow ----
  const start = (spec: GameSpec, art?: Record<string, string>, durationSec?: number) => {
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
    setCaption(null); // the last screen's line does not follow us into the intro
    // dev only: ?dur=N shortens rounds for a quick look at the finale and results
    const dur = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('dur')) : 0;
    dispatch({ type: 'start', spec: withRoundLength(spec, dur >= 30 ? dur : durationSec ?? s.settings.roundSec), ...(art ? { art } : {}) });
  };

  // ---- Create: the AI forge ----
  const clearForgeTimers = () => {
    clearTimeout(forgeTimer.current);
    clearTimeout(voteCloseTimer.current);
    voteCloseTimer.current = undefined;
    setEndsAt(undefined);
  };

  /** The forge could not deliver (offline, busy, timeout): play a built-in game, never an error. */
  function forgeFallback() {
    if (!inForge(stateRef.current.phase)) return;
    clearForgeTimers();
    const game = fallbackGame(QUICK_GAMES, Date.now() / 1000);
    say(`The forge needs a breather, so let's play ${game.title}!`);
    start(game);
  }

  function sendPitch() {
    const s = stateRef.current;
    if (s.phase !== 'pitching') return;
    const ingredients = s.ingredients.length
      ? s.ingredients.map((g) => ({ text: g.text.slice(0, 80), playerId: g.by.slice(0, 32) }))
      : DEFAULT_INGREDIENTS;
    const ok = !!s.code && room.send({
      t: 'forge.pitch', code: s.code, ingredients: ingredients.slice(-12),
      players: s.players.slice(0, MAX_PLAYERS).map((p) => ({ id: p.id.slice(0, 32), name: p.name.slice(0, 40) })),
      settings: { ...s.settings, hostVoice: false },
    });
    if (!ok) return forgeFallback();
    clearTimeout(forgeTimer.current);
    forgeTimer.current = setTimeout(forgeFallback, PITCH_TIMEOUT_MS);
  }

  function endStorm() {
    if (stateRef.current.phase !== 'storm') return;
    clearForgeTimers();
    dispatch({ type: 'phase', phase: 'pitching' });
    stateRef.current = { ...stateRef.current, phase: 'pitching' };
    sendPitch();
  }

  function closeVote() {
    const s = stateRef.current;
    if (s.phase !== 'voting' || s.pitches.length === 0) return;
    clearForgeTimers();
    const pitch = s.pitches[pickWinner(s.votes, s.pitches.length, s.forge.tvVote, focusedPitch.current)]!;
    room.send({ t: 'forge.vote', code: s.code, pitchId: pitch.id });
    forgeAt.current = performance.now();
    dispatch({ type: 'winner', pitchId: pitch.id });
    forgeTimer.current = setTimeout(forgeFallback, FORGE_TIMEOUT_MS);
  }

  function create() {
    const s = stateRef.current;
    if (room.status !== 'online' || !s.code) {
      showToast('Create needs the internet. Try Party or Quick Play!');
      return;
    }
    setParty(undefined);
    busyRetried.current = false;
    focusedPitch.current = 1;
    voice.clear();
    dispatch({ type: 'storm' });
    const end = performance.now() + STORM_SEC * 1000;
    setEndsAt(end);
    clearTimeout(forgeTimer.current);
    forgeTimer.current = setTimeout(endStorm, STORM_SEC * 1000);
  }

  // ---- Party: 4 quick rounds ----
  const playPartyRound = (run: PartyRun) => {
    const r = run.rounds[run.index]!;
    const spec = QUICK_GAMES.find((g) => g.id === r.gameId) ?? QUICK_GAMES[0]!;
    start(spec, undefined, r.durationSec);
  };
  function startParty() {
    const run = newParty(QUICK_GAMES.map((g) => g.id), (Date.now() & 0x7fffffff) || 1);
    setParty(run);
    playPartyRound(run);
  }

  const actions = useRef({ again: () => {}, next: () => {}, lobby: () => {} });
  actions.current = {
    again: () => {
      const spec = stateRef.current.spec;
      if (!spec) return;
      const base = QUICK_GAMES.find((g) => g.id === spec.id) ?? spec;
      const run = partyRef.current;
      if (run) return start(base, undefined, run.rounds[run.index]?.durationSec);
      start(base, stateRef.current.art);
    },
    next: () => {
      const i = QUICK_GAMES.findIndex((g) => g.id === stateRef.current.spec?.id);
      if (i < 0) return create(); // after a forged game: forge another
      start(QUICK_GAMES[(i + 1) % QUICK_GAMES.length]!);
    },
    lobby: () => {
      voice.clear();
      clearForgeTimers();
      setParty(undefined);
      dispatch({ type: 'lobby' });
    },
  };

  const onDone = useCallback((ranking: { id: string; score: number; team?: number }[], events: GameEvent[], team?: 0 | 1) => {
    const s = stateRef.current;
    setWinnerTeam(team);
    if (partyRef.current) setParty(finishRound(partyRef.current, ranking, team));
    // a forged (or arcade) game was played: save it to the family arcade / bump its play count
    if (s.spec && !QUICK_GAMES.some((g) => g.id === s.spec!.id)) {
      const keyArt = s.art.keyArt;
      const sprites = Object.fromEntries(Object.entries(s.art).filter(([k, v]) => k !== 'keyArt' && !k.startsWith('avatar:') && k.length <= 64 && v.startsWith('https:')));
      const art = { ...(keyArt && keyArt.startsWith('https:') && isSafeArtUrl(keyArt) ? { keyArt } : {}), ...(Object.keys(sprites).length ? { sprites } : {}) };
      room.send({ t: 'arcade.played', household: room.household, specId: s.spec.id, spec: s.spec, ...(Object.keys(art).length ? { art } : {}) });
    }
    dispatch({ type: 'results', ranking });
    const names = new Map(s.players.map((p) => [p.id, p.name]));
    const winner = names.get(ranking[0]?.id ?? '') ?? 'Everyone';
    const fallback = team !== undefined ? `Team ${TEAM_NAME[team]} pulls it off!` : `${winner} takes the crown!`;
    const id = `roast-${++sayId.current}`;
    const ok = s.code && s.spec && room.send({
      t: 'host.roast', code: s.code, id,
      events: events.slice(-800).map((e) => ({ t: e.t, type: e.type.slice(0, 40), ...(e.player ? { player: e.player.slice(0, 40) } : {}), ...(e.data ? { data: e.data } : {}) })),
      players: s.players.map((p) => ({ id: p.id.slice(0, 40), name: p.name.slice(0, 40) })),
      title: s.spec.title.slice(0, 80), hook: s.spec.hook.slice(0, 200),
      personality: s.settings.hostPersonality, familySafe: s.settings.familySafe, voice: false,
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
    preloadHeroes();
    // soft UI sounds: a tick when the focus moves, a chime on select, a blip on back (menus only)
    let moved = false;
    focus.onChange = () => { moved = true; };
    const menu = () => stateRef.current.phase !== 'play' || !!document.querySelector('.pause');
    const off = installKeyBridge({
      onAny: (name) => {
        if (!menu()) { moved = false; return; }
        if ((name === 'up' || name === 'down' || name === 'left' || name === 'right') && moved) uiSound('move');
        else if (name === 'select') uiSound('select');
        else if (name === 'back') uiSound('back');
        moved = false;
      },
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

  // ---- forge flow: pitches arrived -> vote; everyone voted -> close early; spec ready -> play ----
  useEffect(() => {
    if (state.phase === 'voting' && endsAt === undefined) {
      clearTimeout(forgeTimer.current);
      setEndsAt(performance.now() + VOTE_SEC * 1000);
      forgeTimer.current = setTimeout(closeVote, VOTE_SEC * 1000);
    }
    if (state.phase === 'voting') {
      const voters = humans(state).filter((p) => p.connected);
      const all = voters.length > 0 && voters.every((p) => state.votes[p.id] !== undefined);
      if (all && !voteCloseTimer.current) voteCloseTimer.current = setTimeout(closeVote, ALL_VOTED_MS);
    }
    if (state.phase === 'forge') {
      const ready = state.forge.ready[state.forge.winner ?? ''];
      if (ready && !voteCloseTimer.current) {
        const wait = Math.max(0, FORGE_MIN_MS - (performance.now() - forgeAt.current)) + READY_HOLD_MS;
        clearTimeout(forgeTimer.current);
        voteCloseTimer.current = setTimeout(() => {
          voteCloseTimer.current = undefined;
          const s = stateRef.current;
          const w = s.forge.winner ?? '';
          const r = s.forge.ready[w];
          if (s.phase !== 'forge' || !r) return;
          setEndsAt(undefined);
          if (r.fallback) say(`Here's ${r.spec.title}, fresh from the forge!`);
          start(r.spec, s.forge.art[w]);
        }, wait);
      }
    }
  }, [state.phase, state.votes, state.forge, state.players]);

  const openArcade = () => {
    if (room.status !== 'online') return showToast('The arcade needs the internet.');
    setArcadeGames(undefined);
    setArcadeLoading(undefined);
    setView('arcade');
    if (!room.send({ t: 'arcade.list', household: room.household })) setArcadeGames([]);
    // no answer: show the empty arcade rather than a spinner forever
    clearTimeout(arcadeTimer.current);
    arcadeTimer.current = setTimeout(() => setArcadeGames((g) => g ?? []), 8000);
  };
  const playArcade = (id: string) => {
    if (!room.send({ t: 'arcade.play', household: room.household, specId: id })) return showToast('Could not reach the arcade.');
    setArcadeLoading(id);
    arcadeWant.current = id;
    clearTimeout(arcadeTimer.current);
    arcadeTimer.current = setTimeout(() => { arcadeWant.current = undefined; setArcadeLoading(undefined); showToast('That game would not load. Try another!'); }, 9000);
  };
  const closeArcade = useCallback(() => setView('main'), []);

  const changeSettings = useCallback((p: Partial<S>) => dispatch({ type: 'settings', patch: p }), []);
  const closeSettings = useCallback(() => setView('main'), []);
  const toLobby = useCallback(() => actions.current.lobby(), []);

  let screen;
  const nextPartySpec = party && !isOver(party) ? QUICK_GAMES.find((g) => g.id === party.rounds[Math.min(party.rounds.length - 1, party.played)]?.gameId) : undefined;
  if (state.phase === 'storm') {
    screen = <Storm state={state} status={status} endsAt={endsAt} total={STORM_SEC} onCook={endStorm} onCancel={toLobby} />;
  } else if (state.phase === 'pitching' || state.phase === 'voting') {
    screen = (
      <Pitches
        state={state} status={status} endsAt={endsAt} total={VOTE_SEC} onCancel={toLobby}
        onTvVote={(i) => dispatch({ type: 'tvVote', vote: i })}
        onFocusPitch={(i) => { focusedPitch.current = i; }}
      />
    );
  } else if (state.phase === 'forge') {
    screen = <ForgeBuild state={state} status={status} />;
  } else if (state.phase === 'results' && state.spec && party) {
    screen = isOver(party)
      ? <PartyChampion state={state} status={status} run={party} onAgain={startParty} onLobby={toLobby} />
      : (
        <PartyStandings
          state={state} status={status} run={party} {...(nextPartySpec ? { next: nextPartySpec } : {})} onQuit={toLobby}
          onNext={() => { const r = partyRef.current; if (!r || stateRef.current.phase !== 'results') return; const n = nextRound(r); setParty(n); playPartyRound(n); }}
        />
      );
  } else if (state.phase === 'play' && state.spec) {
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
    screen = <Results state={state} status={status} winnerTeam={winnerTeam} forged={!QUICK_GAMES.some((g) => g.id === state.spec?.id)} onAgain={() => actions.current.again()} onNext={() => actions.current.next()} onLobby={toLobby} />;
  } else if (view === 'arcade') {
    screen = <Arcade state={state} status={status} {...(arcadeGames ? { games: arcadeGames } : {})} {...(arcadeLoading ? { loadingId: arcadeLoading } : {})} onPlay={playArcade} onClose={closeArcade} />;
  } else if (view === 'settings') {
    screen = <Settings state={state} status={status} onChange={changeSettings} onClose={closeSettings} />;
  } else {
    screen = (
      <Lobby
        state={state}
        status={status}
        onPlay={(spec) => { setParty(undefined); start(spec); }}
        onCreate={create}
        onParty={startParty}
        onArcade={openArcade}
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
