// Play: the deterministic GameRuntime at a fixed 60 Hz (HostLoop), drawn by the cinematic
// GameView (HUD is in Pixi). The DOM only shows the title card before the round and the pause
// menu; nothing in the DOM updates per frame during play.
import { useEffect, useRef, useState } from 'preact/hooks';
import { BlockRegistry, GameRuntime, registerBuiltins, stubJudgement, type GameEvent, type Judgement, type Player } from '@cadabra/engine';
import { GameView, advanceAccumulator, themeVars } from '@cadabra/render';
import type { InputFrame } from '@cadabra/spec';
import { HostLoop } from '../play/loop';
import { Avatar, Backdrop, Icon, Tile, focus } from '../ui/components';
import { cardFor, keyArtFor } from '../fallback';
import type { PartyState, RankEntry } from '../state/machine';

const INTRO_MIN_MS = 4200;
const OUTRO_MS = 3200;
/** Internal render size. Native 1080p holds ~60 fps on the stick since the render perf pass (8c). */
export const INTERNAL = { w: 1920, h: 1080 };

/** What the app talks to while a round runs. */
export interface PlaySession {
  input(id: string, f: InputFrame): void;
  setConnected(id: string, on: boolean): void;
  resolveJudgement(id: string, result: unknown): void;
  togglePause(): void;
  fps(): number;
}

export interface PlayProps {
  state: PartyState;
  /** The app keeps a handle to feed inputs and judgements. */
  session: { current?: PlaySession };
  /** Ask the backend; false = not sent (the stub answers at once). */
  judge: (j: Judgement) => boolean;
  say: (text: string) => void;
  onDone: (ranking: RankEntry[], events: GameEvent[], winnerTeam?: 0 | 1) => void;
  onQuit: () => void;
  onRestart: () => void;
}

const registry = (() => {
  const r = new BlockRegistry();
  registerBuiltins(r);
  return r;
})();

function PauseMenu({ onResume, onRestart, onQuit }: { onResume: () => void; onRestart: () => void; onQuit: () => void }) {
  return (
    <div class="pause">
      <div class="pause-inner">
        <div class="eyebrow">Game paused</div>
        <h1 class="title title-sm">Take a breather</h1>
        <nav class="tiles tiles-inline">
          <Tile col={0} label="Resume" class="tile-action" autofocus onSelect={onResume}><Icon name="resume" /></Tile>
          <Tile col={1} label="Restart" class="tile-action" onSelect={onRestart}><Icon name="again" /></Tile>
          <Tile col={2} label="Quit to lobby" class="tile-action" onSelect={onQuit}><Icon name="home" /></Tile>
        </nav>
        <div class="hint">⏯ Play/Pause to resume</div>
      </div>
    </div>
  );
}

export function Play({ state, session, judge, say, onDone, onQuit, onRestart }: PlayProps) {
  const spec = state.spec!;
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'intro' | 'live' | 'over'>('intro');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const ctl = useRef<{ loop?: HostLoop }>({});
  const props = useRef({ judge, say, onDone });
  props.current = { judge, say, onDone };

  const setPause = (on: boolean) => {
    pausedRef.current = on;
    setPaused(on);
    if (ctl.current.loop) ctl.current.loop.paused = on;
  };

  useEffect(() => {
    const el = host.current!;
    const players: Player[] = state.players.map((p) => ({ ...p, score: 0 }));
    const bots = players.filter((p) => p.isBot).map((p) => p.id);
    const seated = new Set(players.map((p) => p.id));
    const rt = new GameRuntime(spec, players, registry, (Math.random() * 0x7fffffff) | 0);
    for (const p of players) if (!p.isBot && !p.connected) rt.setConnected(p.id, false);
    const view = new GameView(el, { internalW: INTERNAL.w, internalH: INTERNAL.h, arena: { width: spec.arena.width, height: spec.arena.height } });
    const onJudgement = (j: Judgement) => {
      if (!props.current.judge(j)) rt.resolveJudgement(j.id, stubJudgement(j));
    };
    const loop = new HostLoop(rt, bots, { advance: advanceAccumulator, onJudgement });
    loop.paused = true;
    ctl.current.loop = loop;
    let frames = 0, fpsT = performance.now(), fps = 60;
    session.current = {
      input: (id, f) => { if (seated.has(id)) rt.input(id, f); },
      setConnected: (id, on) => { if (seated.has(id)) rt.setConnected(id, on); },
      resolveJudgement: (id, r) => { rt.resolveJudgement(id, r); },
      togglePause: () => { if (!loop.paused || pausedRef.current) setPause(!pausedRef.current); },
      fps: () => fps,
    };

    let raf = 0;
    let dead = false;
    let last = performance.now();
    let live = false;
    let overAt = 0;
    const said = new Set<number>();
    const frame = (now: number) => {
      if (dead) return;
      const dt = (now - last) / 1000;
      last = now;
      if (live) {
        const { alpha } = loop.tick(dt, view.timeScale, view.hitStopMs);
        view.render(rt.snapshot(), rt.drainFx(), alpha);
        // host lines on the timeline beats (surprise, twist)
        spec.timeline.forEach((ev, i) => {
          if (!said.has(i) && rt.time >= ev.atSec && ev.hostLine) { said.add(i); props.current.say(ev.hostLine); }
        });
        if (rt.state === 'over' && !overAt) {
          overAt = now;
          setPhase('over');
          props.current.say(spec.host.finale);
        }
        if (overAt && now - overAt > OUTRO_MS) {
          dead = true;
          const res = rt.result();
          props.current.onDone(res.ranking.map((p) => ({ id: p.id, score: p.score })), [...rt.events], res.winnerTeam);
          return;
        }
      }
      frames++;
      if (now - fpsT >= 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const t0 = performance.now();
    say(spec.host.intro);
    // selfie avatars ride in as theme art (`avatar:<playerId>`); forge.art overrides as they arrived
    const art: Record<string, string> = { ...state.art };
    for (const p of players) if (p.avatar.startsWith('data:image/')) art[`avatar:${p.id}`] = p.avatar;
    void view.loadTheme(spec.theme, art).then(() => {
      const wait = Math.max(0, INTRO_MIN_MS - (performance.now() - t0));
      setTimeout(() => {
        if (dead) return;
        view.render(rt.snapshot(), [], 1);
        live = true;
        last = performance.now();
        loop.paused = pausedRef.current;
        setPhase('live');
      }, wait);
    });

    focus.setBack(() => { setPause(!pausedRef.current); return true; });
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      session.current = undefined;
      focus.setBack(undefined);
      view.destroy();
    };
  }, []);

  const card = cardFor(spec, spec.durationSec);
  return (
    <section class="screen play" style={themeVars(spec.theme)}>
      <div class="play-host" ref={host} />
      {phase === 'intro' && (
        <div class="intro">
          <Backdrop art={keyArtFor(spec, state.art.keyArt)} />
          <div class="hero hero-intro">
            <div class="eyebrow">Round {state.round} · get ready</div>
            <h1 class="title">{spec.title}</h1>
            <p class="hook">{spec.host.tutorial}</p>
            <div class="meta">{card.meta.map((m) => <span key={m}>{m}</span>)}</div>
            <div class="lineup">
              {state.players.map((p, i) => (
                <div key={p.id} class="lineup-p" style={{ animationDelay: `${0.2 + i * 0.12}s` }}>
                  <Avatar p={p} size={96} index={i} /><span>{p.name}</span>
                </div>
              ))}
            </div>
            <div class="loading-bar"><i /></div>
          </div>
        </div>
      )}
      {paused && <PauseMenu onResume={() => setPause(false)} onRestart={onRestart} onQuit={onQuit} />}
    </section>
  );
}
