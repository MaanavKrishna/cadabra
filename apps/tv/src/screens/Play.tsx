// Play: the deterministic GameRuntime at a fixed 60 Hz (HostLoop), drawn by the cinematic
// GameView (HUD is in Pixi), wrapped in the match flow (play/flow.ts): intro card -> 3-2-1-GO ->
// play -> FINAL 10 -> TIME! -> winner shot -> podium. The DOM only shows the intro card, the
// countdown, rare callout banners and the pause menu; nothing in the DOM updates per frame.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BlockRegistry, GameRuntime, registerBuiltins, stubJudgement, type GameEvent, type Judgement, type Player } from '@cadabra/engine';
import {
  EventFeed, GameView, advanceAccumulator, prewarmMusic, setMusicIntensity, sfx, startMusic, stopMusic, themeVars,
} from '@cadabra/render';
import type { GameSpec, InputFrame } from '@cadabra/spec';
import { HostLoop } from '../play/loop';
import { FINAL_SEC, LeadWatch, TEAM_NAME, flowAt, momentCallout, type FlowClock, type FlowPhase } from '../play/flow';
import { introFor, type IntroControl } from '../play/intro';
import { Avatar, Backdrop, Icon, Tile, art, colorOf, focus } from '../ui/components';
import { keyArtFor } from '../fallback';
import type { PartyState, RankEntry } from '../state/machine';

/** Internal render size. Native 1080p holds ~60 fps on the stick since the render perf pass (8c). */
export const INTERNAL = { w: 1920, h: 1080 };
const CALLOUT_MS = 1900;
/** Headline moments (chase, golden, knockout, splash) get a banner at most this often. */
const MOMENT_GAP_MS = 3500;


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

interface Callout {
  id: number;
  kind: 'lead' | 'moment' | 'final' | 'time' | 'winner';
  title: string;
  sub?: string;
  color?: string;
}

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

/** A phone-button glyph: what the control looks like on the phone, with its label. */
export function ControlGlyph({ c }: { c: IntroControl }) {
  return (
    <div class={`ctl ctl-${c.kind}`}>
      <div class="ctl-glyph" aria-hidden="true">
        {c.kind === 'stick' ? (
          <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" class="ctl-ring" /><circle cx="38" cy="27" r="13" class="ctl-knob" /><path d="M32 8v6M32 50v6M8 32h6M50 32h6" class="ctl-tick" /></svg>
        ) : (
          <svg viewBox="0 0 64 64"><circle cx="32" cy="34" r="26" class="ctl-shadow" /><circle cx="32" cy="30" r="26" class="ctl-face" />{c.kind === 'hold' && <path d="M22 30h20" class="ctl-tick" />}</svg>
        )}
      </div>
      <div class="ctl-text"><b>{c.kind === 'hold' ? `Hold ${c.label}` : c.label}</b>{c.hint && <small>{c.hint}</small>}</div>
    </div>
  );
}

/** Neon line-art icons for the intro goal steps (no raster art). */
export function NeonIcon({ name }: { name: string }) {
  const d: Record<string, JSX.Element> = {
    ring: <><circle cx="32" cy="32" r="24" /><circle cx="32" cy="32" r="12" stroke-dasharray="6 5" /></>,
    shove: <><circle cx="20" cy="32" r="9" /><path d="M32 32h22M46 24l8 8-8 8" /></>,
    skull: <><path d="M16 30a16 16 0 1 1 32 0v8h-6v8H22v-8h-6z" /><circle cx="26" cy="30" r="3" /><circle cx="38" cy="30" r="3" /></>,
    core: <><path d="M32 8l20 12v24L32 56 12 44V20z" /><circle cx="32" cy="32" r="7" /></>,
    bomb: <><circle cx="28" cy="36" r="17" /><path d="M40 22l6-6M46 10v6h6" /></>,
    paint: <><rect x="10" y="10" width="20" height="20" /><rect x="34" y="34" width="20" height="20" /><rect x="34" y="10" width="20" height="20" stroke-dasharray="5 4" /></>,
    splash: <><circle cx="32" cy="32" r="8" /><path d="M32 8v10M32 46v10M8 32h10M46 32h10M15 15l7 7M42 42l7 7M15 49l7-7M42 22l7-7" /></>,
    base: <><path d="M10 50h44M16 50V26l16-12 16 12v24" /><path d="M26 50V36h12v14" /></>,
    bolt: <path d="M36 6L14 36h16l-4 22 24-32H34z" />,
    gate: <><path d="M14 10v44M50 10v44" /><path d="M14 22h36M14 32h36M14 42h36" stroke-dasharray="4 4" /></>,
    flag: <><path d="M14 56V8" /><path d="M14 10h32l-6 9 6 9H14" /></>,
    star: <path d="M32 6l7 17 18 1-14 11 5 18-16-10-16 10 5-18L7 24l18-1z" />,
  };
  return <svg class={`neon-icon ni-${name}`} viewBox="0 0 64 64" aria-hidden="true">{d[name] ?? d.star}</svg>;
}

function IntroCard({ state, spec, loaded }: { state: PartyState; spec: GameSpec; loaded: boolean }) {
  const intro = introFor(spec);
  return (
    <div class="intro">
      <Backdrop art={keyArtFor(spec, state.art.keyArt)} />
      <div class="hero hero-intro">
        <div class="eyebrow">Round {state.round} · how to win</div>
        <h1 class="title">{spec.title}</h1>
        <div class="goal">
          {intro.steps.map((s, i) => (
            <div key={i} class="goal-step" style={{ animationDelay: `${0.15 + i * 0.18}s` }}>
              {i > 0 && <span class="goal-arrow">→</span>}
              {s.icon?.startsWith('neon:') ? <NeonIcon name={s.icon.slice(5)} /> : s.icon && art(s.icon) && <img src={art(s.icon)} alt="" />}
              <span>{s.text}</span>
            </div>
          ))}
        </div>
        <div class="controls">
          <span class="controls-lbl">On your phone</span>
          {intro.controls.map((c, i) => <ControlGlyph key={i} c={c} />)}
        </div>
      </div>
      <div class="lineup">
        {state.players.map((p, i) => (
          <div key={p.id} class="lineup-p" style={{ animationDelay: `${0.35 + i * 0.14}s`, ['--ring' as string]: colorOf(i) }}>
            <Avatar p={p} size={120} index={i} /><span>{p.name}</span>
          </div>
        ))}
      </div>
      <div class={`loading-bar ${loaded ? 'is-done' : ''}`}><i /></div>
    </div>
  );
}

export function Play({ state, session, judge, say, onDone, onQuit, onRestart }: PlayProps) {
  const spec = state.spec!;
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<FlowPhase>('intro');
  const [count, setCount] = useState<3 | 2 | 1 | 'GO' | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [callout, setCallout] = useState<Callout | undefined>();
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const ctl = useRef<{ pause?: (on: boolean) => void }>({});
  const props = useRef({ judge, say, onDone });
  props.current = { judge, say, onDone };

  const setPause = (on: boolean) => {
    if (pausedRef.current === on) return;
    pausedRef.current = on;
    setPaused(on);
    ctl.current.pause?.(on);
  };

  useEffect(() => {
    const el = host.current!;
    const players: Player[] = state.players.map((p) => ({ ...p, score: 0 }));
    const bots = players.filter((p) => p.isBot).map((p) => p.id);
    const seated = new Set(players.map((p) => p.id));
    const names = new Map(players.map((p) => [p.id, p.name]));
    const rt = new GameRuntime(spec, players, registry, (Math.random() * 0x7fffffff) | 0);
    for (const p of players) if (!p.isBot && !p.connected) rt.setConnected(p.id, false);
    const view = new GameView(el, {
      internalW: INTERNAL.w, internalH: INTERNAL.h, arena: { width: spec.arena.width, height: spec.arena.height }, arenaKind: spec.arena.kind, banner: false,
    });
    const onJudgement = (j: Judgement) => {
      if (!props.current.judge(j)) rt.resolveJudgement(j.id, stubJudgement(j));
    };
    const loop = new HostLoop(rt, bots, { advance: advanceAccumulator, onJudgement });
    loop.paused = true;
    const feed = new EventFeed();
    const lead = new LeadWatch();
    const clock: FlowClock = { mountAt: performance.now() };
    let frames = 0, fpsT = performance.now(), fps = 60;
    session.current = {
      input: (id, f) => { if (seated.has(id)) rt.input(id, f); },
      setConnected: (id, on) => { if (seated.has(id)) rt.setConnected(id, on); },
      resolveJudgement: (id, r) => { rt.resolveJudgement(id, r); },
      togglePause: () => setPause(!pausedRef.current),
      fps: () => fps,
    };

    // ---- callouts: one at a time, newest lead call replaces a queued one ----
    let calloutSeq = 0;
    let lastMomentAt = -Infinity;
    const nameOf = (id?: string) => (names.get(id ?? '') ?? 'Someone').toUpperCase();
    const noun = (spec.blocks.map((b) => (b.params as Record<string, unknown>).itemSprite).find((x) => typeof x === 'string') as string | undefined ?? 'loot').toUpperCase();
    let shownUntil = 0;
    const queue: Callout[] = [];
    const show = (c: Omit<Callout, 'id'>, now: number, urgent = false) => {
      const item = { ...c, id: ++calloutSeq };
      if (urgent) {
        queue.length = 0;
        shownUntil = 0;
      }
      if (c.kind === 'moment') {
        // small stuff never queues behind other banners, and big moments are spaced out
        if (now - lastMomentAt < MOMENT_GAP_MS || queue.length > 0 || now < shownUntil - 600) return;
        lastMomentAt = now;
      }
      if (c.kind === 'lead') {
        const i = queue.findIndex((q) => q.kind === 'lead');
        if (i >= 0) queue.splice(i, 1);
      }
      queue.push(item);
      pump(now);
    };
    const pump = (now: number) => {
      if (now < shownUntil) return;
      const next = queue.shift();
      if (next) {
        setCallout(next);
        shownUntil = now + CALLOUT_MS;
      } else if (shownUntil > 0) {
        setCallout(undefined);
        shownUntil = 0;
      }
    };
    const leadText = (player?: string, team?: number) =>
      team === 0 || team === 1
        ? { title: `${TEAM_NAME[team].toUpperCase()} TEAM`, sub: 'takes the lead!', color: team === 0 ? '#ff4d5e' : '#3d8bff' }
        : { title: (names.get(player ?? '') ?? 'Someone').toUpperCase(), sub: 'takes the lead!', color: colorOf(Math.max(0, players.findIndex((p) => p.id === player))) };

    // ---- pause shifts the whole flow clock ----
    let pausedAt = 0;
    ctl.current.pause = (on) => {
      const now = performance.now();
      if (on) pausedAt = now;
      else if (pausedAt) {
        const d = now - pausedAt;
        clock.mountAt += d;
        if (clock.loadedAt !== undefined) clock.loadedAt += d;
        if (clock.overAt !== undefined) clock.overAt += d;
        shownUntil += d;
        pausedAt = 0;
      }
      loop.paused = on || !runningNow;
    };

    let raf = 0;
    let dead = false;
    let last = performance.now();
    let lastPhase: FlowPhase = 'intro';
    let lastCount: 3 | 2 | 1 | 'GO' | undefined;
    let runningNow = false;
    let lastSec = -1;
    let finalMult = 1;
    const said = new Set<number>();
    const frame = (now: number) => {
      if (dead) return;
      const dt = (now - last) / 1000;
      last = now;
      if (pausedRef.current) {
        raf = requestAnimationFrame(frame);
        return;
      }
      if (rt.state === 'over' && clock.overAt === undefined) clock.overAt = now;
      const f = flowAt(clock, now, rt.remaining);
      runningNow = f.running;
      loop.paused = !f.running;
      if (f.count !== lastCount) {
        lastCount = f.count;
        setCount(f.count);
        if (f.count === 'GO') {
          sfx('win');
          view.punch();
        } else if (f.count !== undefined) sfx('tick');
      }
      if (f.phase !== lastPhase) {
        const prev = lastPhase;
        lastPhase = f.phase;
        setPhase(f.phase);
        if (f.phase === 'countdown') startMusic(spec.theme.sfxSet);
        if (f.phase === 'final' && prev === 'play') {
          view.setMultiplier(finalMult);
          setMusicIntensity(true);
          show({ kind: 'final', title: 'FINAL 10', sub: finalMult > 1 ? `${finalMult === 2 ? 'DOUBLE' : `${finalMult}×`} POINTS!` : 'Give it everything!' }, now, true);
          sfx('wake');
        }
        if (f.phase === 'time') {
          stopMusic();
          view.freeze(500);
          view.setMultiplier(1);
          sfx('hit');
          show({ kind: 'time', title: 'TIME!' }, now, true);
          props.current.say(spec.host.finale);
        }
        if (f.phase === 'winner') {
          const res = rt.result();
          const team = res.winnerTeam;
          const top = team !== undefined ? res.ranking.find((p) => p.team === team) : res.ranking[0];
          view.celebrate(top?.id);
          sfx('win');
          if (team !== undefined) show({ kind: 'winner', title: `${TEAM_NAME[team].toUpperCase()} TEAM WINS!`, color: team === 0 ? '#ff4d5e' : '#3d8bff' }, now, true);
          else if (top) show({ kind: 'winner', title: `${top.name.toUpperCase()} WINS!`, sub: `${top.score} points`, color: colorOf(Math.max(0, players.findIndex((p) => p.id === top.id))) }, now, true);
        }
        if (f.phase === 'done') {
          dead = true;
          const res = rt.result();
          props.current.onDone(res.ranking.map((p) => ({ id: p.id, score: p.score, ...(p.team !== undefined ? { team: p.team } : {}) })), [...rt.events], res.winnerTeam);
          return;
        }
      }
      if (f.phase !== 'intro') {
        const { alpha } = loop.tick(dt, view.timeScale, view.hitStopMs);
        const events = feed.next(rt);
        for (const e of events) {
          if (e.type === 'lead.change' && f.running) {
            const who = lead.fromEvent(e.player, typeof e.data?.team === 'number' ? e.data.team : undefined);
            if (who) show({ kind: 'lead', ...leadText(who.player, who.team) }, now);
          } else if (f.running && typeof e.data?.moment === 'string') {
            const m = momentCallout(e, nameOf, noun);
            if (m) show({ kind: 'moment', ...m }, now);
          } else if (e.type === 'final.start' && typeof e.data?.multiplier === 'number') {
            finalMult = e.data.multiplier;
          }
        }
        const snap = rt.snapshot();
        if (f.running) {
          const who = lead.fromScores(snap.players, rt.time);
          if (who) show({ kind: 'lead', ...leadText(who) }, now);
          // final 10: a tick on every second
          const sec = Math.ceil(rt.remaining);
          if (rt.remaining <= FINAL_SEC && sec !== lastSec && sec > 0) sfx('tick');
          lastSec = sec;
        }
        view.render(snap, rt.drainFx(), alpha, events);
        // host lines on the timeline beats (surprise, twist)
        spec.timeline.forEach((ev, i) => {
          if (!said.has(i) && rt.time >= ev.atSec && ev.hostLine) { said.add(i); props.current.say(ev.hostLine); }
        });
      }
      pump(now);
      frames++;
      if (now - fpsT >= 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    say(spec.host.intro);
    prewarmMusic(spec.theme.sfxSet);
    // selfie avatars ride in as theme art (`avatar:<playerId>`); forge.art overrides as they arrived
    const art: Record<string, string> = { ...state.art };
    for (const p of players) if (p.avatar.startsWith('data:image/')) art[`avatar:${p.id}`] = p.avatar;
    void view.loadTheme(spec.theme, art).then(() => {
      if (dead) return;
      view.render(rt.snapshot(), [], 1);
      clock.loadedAt = performance.now();
      setLoaded(true);
    });

    focus.setBack(() => { setPause(!pausedRef.current); return true; });
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      stopMusic();
      session.current = undefined;
      focus.setBack(undefined);
      view.destroy();
    };
  }, []);

  return (
    <section class={`screen play phase-${phase}`} style={themeVars(spec.theme)}>
      <div class="play-host" ref={host} />
      {phase === 'intro' && <IntroCard state={state} spec={spec} loaded={loaded} />}
      {count !== undefined && (
        <div class={`countdown-big ${count === 'GO' ? 'is-go' : ''}`} key={String(count)} aria-live="assertive">
          <span>{count === 'GO' ? 'GO!' : count}</span>
        </div>
      )}
      {callout && (
        <div class={`callout callout-${callout.kind}`} key={callout.id} style={callout.color ? { ['--cc' as string]: callout.color } : undefined}>
          <div class="callout-title">{callout.title}</div>
          {callout.sub && <div class="callout-sub">{callout.sub}</div>}
        </div>
      )}
      {paused && <PauseMenu onResume={() => setPause(false)} onRestart={onRestart} onQuit={onQuit} />}
    </section>
  );
}
