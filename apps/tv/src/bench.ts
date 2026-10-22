/**
 * Device performance benchmark for @cadabra/render (dev tool).
 *
 * Runs ONE cell per page load and then navigates to the next (`?i=N&grp=G`), so every cell
 * starts from a fresh WebView page / GL context. Results go to the console as
 * `BENCH {json}` (logcat tag CadabraWeb); `BENCH_MEM id` marks a 3 s hold during which the
 * host script (apps/tv/bench/tv-bench.mjs) samples `dumpsys meminfo`.
 *
 * Build it as the installed app's index with `VITE_ENTRY=bench` (see vite.config.ts), or open
 * /bench.html in the dev server. Groups: stress | matrix | finale | thermal | input | all
 * (all = stress + matrix + finale). `&list=1` prints the plan and stops.
 *
 * packages/render is untouched: effect level is forced through the (private) FxBudget of the
 * view, which is reached with casts below.
 */
import { BlockRegistry, GameRuntime, Rng, driveBots, makeBots, registerBuiltins, stubJudgement, DT } from '@cadabra/engine';
import type { GameSpec } from '@cadabra/spec';
import { DEFAULT_ART_URLS, FxBudget, GameView, advanceAccumulator } from '@cadabra/render';
import {
  Application, BitmapText, PerspectiveMesh, BlurFilter, ColorMatrixFilter, Container, Matrix, RenderTexture, Sprite, Text, Texture, UPDATE_PRIORITY,
} from 'pixi.js';
import { GAMES } from './demo-games';
import * as THREE from 'three';

type Fx = 'full' | 'low' | 'auto';
interface Cell {
  id: string;
  grp: string;
  kind: 'game' | 'particles' | 'entities' | 'raw' | 'text' | 'fill' | 'filter' | 'tex' | 'dom' | 'idle' | 'three' | 'tilt';
  w: number;
  h: number;
  game?: string;
  bots?: number;
  fx?: Fx;
  n?: number;
  /** text: dynamic (re-set every frame) / bitmap font; fill: additive; filter: which; tex: art px (0 = none); game: finale */
  mode?: string;
  durMs?: number;
}

const GAME_LIST = ['heist', 'dodge', 'sweep', 'race', 'tug', 'quiz'] as const;
const WARM_MS = 2000;
const RUN_MS = 8000;
const MEM_HOLD_MS = 3000;

function buildPlan(): Cell[] {
  const plan: Cell[] = [];
  const add = (c: Cell) => plan.push(c);
  // ---- stress -------------------------------------------------------------------------
  add({ id: 'idle-blank-1280', grp: 'stress', kind: 'idle', w: 1280, h: 720 });
  add({ id: 'idle-blank-1920', grp: 'stress', kind: 'idle', w: 1920, h: 1080 });
  for (const n of [100, 250, 500, 1000, 2000]) add({ id: `particles-${n}`, grp: 'stress', kind: 'particles', w: 1280, h: 720, n });
  for (const n of [100, 250, 500, 1000]) add({ id: `particles-${n}-1920`, grp: 'stress', kind: 'particles', w: 1920, h: 1080, n });
  for (const n of [50, 150, 300, 400, 600]) add({ id: `entities-${n}`, grp: 'stress', kind: 'entities', w: 1280, h: 720, n });
  for (const n of [150, 400]) add({ id: `entities-${n}-1920`, grp: 'stress', kind: 'entities', w: 1920, h: 1080, n });
  for (const n of [100, 300, 600, 1000, 2000, 4000]) add({ id: `raw-sprites-${n}`, grp: 'stress', kind: 'raw', w: 1280, h: 720, n });
  for (const n of [300, 1000, 2000]) add({ id: `raw-sprites-${n}-1920`, grp: 'stress', kind: 'raw', w: 1920, h: 1080, n });
  for (const n of [20, 100, 200]) add({ id: `text-static-${n}`, grp: 'stress', kind: 'text', w: 1280, h: 720, n, mode: 'static' });
  for (const n of [5, 20, 60]) add({ id: `text-dynamic-${n}`, grp: 'stress', kind: 'text', w: 1280, h: 720, n, mode: 'dynamic' });
  add({ id: 'bitmap-static-200', grp: 'stress', kind: 'text', w: 1280, h: 720, n: 200, mode: 'bitmap-static' });
  add({ id: 'bitmap-dynamic-60', grp: 'stress', kind: 'text', w: 1280, h: 720, n: 60, mode: 'bitmap-dynamic' });
  for (const w of [1280, 1920]) {
    const h = w === 1280 ? 720 : 1080;
    for (const n of [2, 8, 16]) add({ id: `fill-alpha-${n}-${w}`, grp: 'stress', kind: 'fill', w, h, n, mode: 'normal' });
    for (const n of [4, 8]) add({ id: `fill-add-${n}-${w}`, grp: 'stress', kind: 'fill', w, h, n, mode: 'add' });
  }
  for (const w of [1280, 1920]) {
    const h = w === 1280 ? 720 : 1080;
    for (const f of ['none', 'blur4', 'blur12', 'colormatrix', 'bloom']) {
      add({ id: `filter-${f}-heist4-${w}`, grp: 'stress', kind: 'filter', w, h, game: 'heist', bots: 4, mode: f });
    }
  }
  for (const m of ['css-transform', 'backdrop-blur']) add({ id: `dom-${m}`, grp: 'stress', kind: 'dom', w: 1280, h: 720, game: 'heist', bots: 4, mode: m, n: 24 });
  for (const s of [0, 192, 512]) add({ id: `tex-${s || 'none'}`, grp: 'stress', kind: 'tex', w: 1280, h: 720, mode: String(s) });
  // ---- diag: which GameView layer costs what (hide layers via casts; heist 4p, full fx) ----
  const DIAG: [string, string][] = [['base', ''], ['no-blobs', 'blobs'], ['no-vignette-finale', 'vignette,finale'], ['no-floor', 'floor'],
    ['no-light-motes', 'light,motes'], ['no-hud', 'hud'], ['no-bg-all', 'blobs,vignette,finale,floor,light,motes'], ['no-bg-all-no-hud', 'blobs,vignette,finale,floor,light,motes,hud']];
  for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
    for (const [name, hide] of DIAG) add({ id: `diag-${name}-${w}`, grp: 'diag', kind: 'game', w, h, game: 'heist', bots: 4, fx: 'full', mode: `hide:${hide}` });
  }
  // ---- three.js (grp 'three'); mode = key=value;... ----
  const T = (id: string, w: number, h: number, mode: string, n = 50) => add({ id: `three-${id}`, grp: 'three', kind: 'three', w, h, n, mode });
  T('empty-lambert', 1280, 720, 'mat=lambert', 0);
  for (const n of [20, 50, 100]) T(`props${n}-lambert-noshadow`, 1280, 720, 'mat=lambert', n);
  T('props50-lambert-shadow512', 1280, 720, 'mat=lambert;shadow=512');
  T('props50-lambert-shadow1024', 1280, 720, 'mat=lambert;shadow=1024');
  for (const m of ['standard', 'toon', 'basic']) T(`props50-${m}`, 1280, 720, `mat=${m}`);
  T('props50-standard-shadow1024', 1280, 720, 'mat=standard;shadow=1024');
  for (const [w, h] of [[1280, 720], [960, 540], [1920, 1080]] as const) {
    for (const aa of [0, 1]) T(`props50-lambert-${w}-aa${aa}`, w, h, `mat=lambert;aa=${aa}`);
  }
  for (const n of [500, 2000]) T(`instanced-${n}-lambert`, 1280, 720, 'mat=lambert;inst=1', n);
  T('instanced-2000-standard', 1280, 720, 'mat=standard;inst=1', 2000);
  add({ id: 'tilt-2p5d-30', grp: 'three', kind: 'tilt', w: 1280, h: 720, n: 30 });
  add({ id: 'tilt-2p5d-120', grp: 'three', kind: 'tilt', w: 1280, h: 720, n: 120 });
  // ---- matrix: 6 games x 3 player counts x 2 resolutions x 2 effect levels ----------------
  for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
    for (const game of GAME_LIST) {
      for (const bots of [2, 4, 8]) {
        for (const fx of ['full', 'low'] as const) {
          add({ id: `${game}-${bots}p-${w}-${fx}`, grp: 'matrix', kind: 'game', w, h, game, bots, fx });
        }
      }
    }
  }
  // ---- finale (last 10 s of a round: camera lean, glow, most juice) with the real adaptive budget ----
  for (const game of ['heist', 'dodge', 'sweep']) {
    for (const [w, h] of [[1280, 720], [1920, 1080]] as const) {
      add({ id: `finale-${game}-8p-${w}-auto`, grp: 'finale', kind: 'game', w, h, game, bots: 8, fx: 'auto', mode: 'finale' });
    }
  }
  add({ id: 'input-heist-8p', grp: 'input', kind: 'game', w: 1280, h: 720, game: 'heist', bots: 8, fx: 'auto', durMs: 70000 });
  add({ id: 'thermal-heist-8p-1280', grp: 'thermal', kind: 'game', w: 1280, h: 720, game: 'heist', bots: 8, fx: 'auto', durMs: 180000 });
  return plan;
}

const qs = new URLSearchParams(location.search);
const grp = qs.get('grp') ?? 'all';
const idx = Math.max(0, Number(qs.get('i') ?? 0) || 0);
const all = buildPlan();
const plan = all.filter((c) => (grp === 'all' ? c.grp === 'stress' || c.grp === 'matrix' || c.grp === 'finale' : c.grp === grp || c.id === grp));
const log = (tag: string, data: unknown) => console.log(tag, typeof data === 'string' ? data : JSON.stringify(data));
const stage = document.getElementById('stage')!;
const status = document.getElementById('status')!;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const q = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]! : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

// ---- input latency probe: the Android shell calls window.cadabraKey(name) on key-down ----
let keyPending = 0;
(window as unknown as { cadabraKey: (n: string) => string }).cadabraKey = (name) => {
  keyPending = performance.now();
  log('BENCHKEY', { name, wall: Date.now(), perf: r2(performance.now()) });
  return name === 'back' ? 'exit' : '';
};

interface Setup {
  app?: Application;
  gl?: WebGLRenderingContext;
  /** Advance the scenario by one display frame. */
  step(dtMs: number, now: number): void;
  info?(): Record<string, unknown>;
  loadMs?: number;
}

async function ownApp(w: number, h: number): Promise<Application> {
  const app = new Application();
  await app.init({ width: w, height: h, background: '#14102b', antialias: false, resolution: 1, autoDensity: false, preference: 'webgl', powerPreference: 'high-performance', hello: false });
  app.canvas.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
  stage.appendChild(app.canvas);
  return app;
}

function clampFx(view: GameView, fx: Fx): void {
  if (fx === 'auto') return;
  const b = (view as unknown as { budget: FxBudget }).budget as unknown as { _cap: number; fpsFeedback: () => void };
  b.fpsFeedback = () => {}; // freeze the adaptive loop so the cell measures ONE effect level
  if (fx === 'low') b._cap = 30; // degraded: ambient motes halved, trails off, glows halved
}

async function loadArt(names: string[], px: number): Promise<Texture[]> {
  const out: Texture[] = [];
  await Promise.all(names.map(async (n, i) => {
    const url = DEFAULT_ART_URLS[n];
    if (!url) return;
    const blob = await (await fetch(url)).blob();
    const bmp0 = await createImageBitmap(blob);
    let bmp = bmp0;
    if (px > 0) {
      const k = px / Math.max(bmp0.width, bmp0.height);
      bmp = await createImageBitmap(blob, { resizeWidth: Math.round(bmp0.width * k), resizeHeight: Math.round(bmp0.height * k), resizeQuality: 'high' });
    }
    out[i] = Texture.from(bmp);
  }));
  return out.filter(Boolean);
}

// ---- game scenarios --------------------------------------------------------------------
async function setupGame(c: Cell, over: { synthetic?: number } = {}): Promise<Setup & { view: GameView; app: Application }> {
  const base = (GAMES[c.game ?? 'heist'] ?? GAMES.heist!)();
  const finale = c.mode === 'finale';
  const spec: GameSpec = finale ? { ...base, durationSec: 14, timeline: [] } : base;
  const registry = new BlockRegistry();
  registerBuiltins(registry);
  const view = new GameView(stage, { internalW: c.w, internalH: c.h, arena: { width: spec.arena.width, height: spec.arena.height } });
  await view.ready;
  const t0 = performance.now();
  await view.loadTheme(spec.theme, {});
  const loadMs = performance.now() - t0;
  clampFx(view, c.fx ?? 'full');
  if (c.mode?.startsWith('hide:')) {
    const v = view as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const k of c.mode.slice(5).split(',').filter(Boolean)) {
      if (k === 'blobs') v.blobs.forEach((b: Sprite) => { b.visible = false; });
      else if (k === 'vignette') v.vignette.visible = false;
      else if (k === 'finale') v.finaleGlow.visible = false;
      else if (k === 'floor' && v.floor) v.floor.visible = false;
      else if (k === 'light') v.ambience.light.visible = false;
      else if (k === 'motes') v.ambience.motes.visible = false;
      else if (k === 'hud') v.hud.root.visible = false;
    }
  }
  let seed = 7;
  let bots = makeBots(c.bots ?? 4, new Rng(seed++));
  let rt = new GameRuntime(spec, bots, registry, seed);
  let acc = 0;
  let overAt = 0;
  let entMax = 0, entSum = 0, entN = 0, partSum = 0;
  // synthetic entities (entity ramp): replace the snapshot's entities with N moving coins/hazards/crates
  let ents: ReturnType<GameRuntime['snapshot']>['entities'] = [];
  let simT = 0;
  if (over.synthetic) {
    const kinds: [string, string][] = [['item', 'item'], ['item', 'item'], ['hazard', 'hazard'], ['obstacle', 'obstacle']];
    const R = new Rng(3);
    for (let i = 0; i < over.synthetic; i++) {
      const [kind, sprite] = kinds[i % kinds.length]!;
      ents.push({
        id: 1000 + i, kind, x: R.next() * spec.arena.width, y: R.next() * spec.arena.height, vx: (R.next() - 0.5) * 240, vy: (R.next() - 0.5) * 240,
        r: 16, sprite, tags: new Set<string>(), props: {},
      } as ReturnType<GameRuntime['snapshot']>['entities'][number]);
    }
  }
  return {
    app: (view as unknown as { app: Application }).app,
    view,
    loadMs,
    step(dtMs, now) {
      const dt = Math.min(0.1, dtMs / 1000);
      if (over.synthetic) {
        simT += DT;
        for (const e of ents) {
          e.x += e.vx * DT;
          e.y += e.vy * DT;
          if (e.x < 0 || e.x > spec.arena.width) e.vx = -e.vx;
          if (e.y < 0 || e.y > spec.arena.height) e.vy = -e.vy;
        }
        const s = rt.snapshot();
        s.entities = ents;
        s.time = simT;
        view.render(s, [], 1);
        entMax = ents.length;
        partSum += view.particleCount;
        entN++;
        return;
      }
      acc = advanceAccumulator(acc, dt, view.timeScale, view.hitStopMs);
      let steps = 0;
      while (acc >= DT && steps < 5) {
        driveBots(rt, bots, 0.7);
        for (const j of rt.pendingJudgements()) rt.resolveJudgement(j.id, stubJudgement(j));
        rt.step();
        acc -= DT;
        steps++;
      }
      if (steps === 5) acc = 0;
      const snap = rt.snapshot();
      view.render(snap, rt.drainFx(), acc / DT);
      const n = snap.entities.length;
      entMax = Math.max(entMax, n);
      entSum += n;
      entN++;
      partSum += view.particleCount;
      if (rt.state === 'over') {
        overAt ||= now;
        if (now - overAt > 3000) {
          overAt = 0;
          bots = makeBots(c.bots ?? 4, new Rng(seed++));
          rt = new GameRuntime(spec, bots, registry, seed);
        }
      }
    },
    info() {
      const b = (view as unknown as { budget: FxBudget }).budget;
      return { entMax, entAvg: entN ? r1(entSum / entN) : 0, particlesAvg: entN ? r1(partSum / entN) : 0, fxCap: b.cap, fxMax: b.max, degraded: b.degraded };
    },
  };
}

function setupThree(c: Cell): Setup {
  const o = Object.fromEntries((c.mode ?? '').split(';').map((kv) => kv.split('=') as [string, string]));
  const renderer = new THREE.WebGLRenderer({ antialias: o.aa === '1', powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(c.w, c.h, false);
  renderer.domElement.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;position:fixed;inset:0';
  const shadow = Number(o.shadow ?? 0);
  if (shadow) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
  }
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14102b);
  const cam = new THREE.PerspectiveCamera(50, c.w / c.h, 0.1, 100);
  cam.position.set(0, 9, 11);
  cam.lookAt(0, 0, 0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, 12, 6);
  if (shadow) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadow, shadow);
    const sc = sun.shadow.camera;
    sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 1; sc.far = 40;
  }
  scene.add(sun);
  const mk = (color: number): THREE.Material => {
    switch (o.mat) {
      case 'standard': return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1 });
      case 'toon': return new THREE.MeshToonMaterial({ color });
      case 'basic': return new THREE.MeshBasicMaterial({ color });
      default: return new THREE.MeshLambertMaterial({ color });
    }
  };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), mk(0x3a3470));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const R = new Rng(4);
  const chars: THREE.Mesh[] = [];
  const colors = [0x4cc9f0, 0xf72585, 0xffd166, 0x80ed99];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1, 6, 16), mk(colors[i]!));
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
    chars.push(m);
  }
  const props: { m: THREE.Object3D; a: number; r: number; s: number }[] = [];
  const dummy = new THREE.Object3D();
  let inst: THREE.InstancedMesh | undefined;
  const n = c.n ?? 0;
  if (o.inst === '1') {
    inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mk(0xffd166), n);
    inst.castShadow = true;
    scene.add(inst);
    for (let i = 0; i < n; i++) props.push({ m: new THREE.Object3D(), a: R.next() * 6.28, r: 2 + R.next() * 12, s: 0.2 + R.next() });
  } else {
    const box = new THREE.BoxGeometry(0.8, 0.8, 0.8), sph = new THREE.SphereGeometry(0.5, 16, 12);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(i % 2 ? box : sph, mk(0xffffff * R.next()));
      m.castShadow = true;
      m.receiveShadow = true;
      scene.add(m);
      props.push({ m, a: R.next() * 6.28, r: 2 + R.next() * 12, s: 0.2 + R.next() });
    }
  }
  let t = 0;
  return {
    gl: renderer.getContext() as WebGLRenderingContext,
    step(dtMs) {
      t += dtMs / 1000;
      chars.forEach((m, i) => m.position.set(Math.cos(t * 0.7 + i * 1.6) * 4, 1, Math.sin(t * 0.7 + i * 1.6) * 4));
      props.forEach((p, i) => {
        const x = Math.cos(p.a + t * 0.1 * p.s) * p.r, z = Math.sin(p.a + t * 0.1 * p.s) * p.r;
        if (inst) {
          dummy.position.set(x, 0.5 + 0.3 * Math.sin(t + i), z);
          dummy.rotation.set(t * p.s, t * p.s, 0);
          dummy.updateMatrix();
          inst!.setMatrixAt(i, dummy.matrix);
        } else {
          p.m.position.set(x, 0.5, z);
          p.m.rotation.y = t * p.s;
        }
      });
      if (inst) inst.instanceMatrix.needsUpdate = true;
      renderer.render(scene, cam);
    },
    info: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, geoms: renderer.info.memory.geometries, aa: o.aa === '1' }),
  };
}

function blobDom(n: number, mode: string): HTMLElement {
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5';
  const st = document.createElement('style');
  st.textContent = '@keyframes dm{0%{transform:translate3d(0,0,0) rotate(0)}100%{transform:translate3d(60px,30px,0) rotate(8deg)}}';
  root.appendChild(st);
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    const x = 40 + (i % 6) * 200, y = 40 + Math.floor(i / 6) * 150;
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:170px;height:110px;border-radius:18px;background:rgba(20,16,43,0.6);color:#fff;font:700 28px sans-serif;padding:12px;box-sizing:border-box;` +
      `animation:dm ${2 + (i % 3)}s ease-in-out infinite alternate;` + (mode === 'backdrop-blur' ? 'backdrop-filter:blur(8px);' : '');
    d.textContent = `Card ${i}`;
    root.appendChild(d);
  }
  document.body.appendChild(root);
  return root;
}

async function setup(c: Cell): Promise<Setup> {
  switch (c.kind) {
    case 'game':
      return setupGame(c);
    case 'entities':
      return setupGame({ ...c, game: 'heist', bots: 4, fx: 'full' }, { synthetic: c.n });
    case 'dom': {
      const s = await setupGame({ ...c, fx: 'full' });
      blobDom(c.n ?? 24, c.mode ?? '');
      return s;
    }
    case 'filter': {
      const s = await setupGame({ ...c, fx: 'full' });
      const app = s.app;
      const f = c.mode;
      if (f === 'blur4') app.stage.filters = [new BlurFilter({ strength: 4, quality: 2 })];
      else if (f === 'blur12') app.stage.filters = [new BlurFilter({ strength: 12, quality: 4 })];
      else if (f === 'colormatrix') {
        const m = new ColorMatrixFilter();
        m.saturate(1.3, true);
        m.brightness(1.05, true);
        app.stage.filters = [m];
      } else if (f === 'bloom') {
        // quarter-res copy of the whole scene, blurred, drawn back additively (one frame late)
        const rt = RenderTexture.create({ width: c.w / 4, height: c.h / 4 });
        const glow = new Sprite(rt);
        glow.scale.set(4);
        glow.blendMode = 'add';
        glow.alpha = 0.6;
        glow.filters = [new BlurFilter({ strength: 3, quality: 2 })];
        const tf = new Matrix().scale(0.25, 0.25);
        app.stage.addChild(glow);
        app.ticker.add(() => {
          glow.visible = false;
          app.renderer.render({ container: app.stage, target: rt, transform: tf, clear: true });
          glow.visible = true;
        }, undefined, UPDATE_PRIORITY.HIGH);
      }
      return s;
    }
    case 'three':
      return setupThree(c);
    case 'tilt': {
      const app = await ownApp(c.w, c.h);
      const names = ['floor-kitchen', 'coin', 'gem', 'star', 'bomb', 'crate', 'avatar-cat', 'avatar-fox'];
      const [floorT, ...sprT] = await loadArt(names, 256);
      // perspective floor: far edge narrower (trapezoid) -> receding tiles
      floorT!.source.addressMode = 'repeat';
      const floor = new PerspectiveMesh({
        texture: floorT!, verticesX: 20, verticesY: 20,
        x0: c.w * 0.3, y0: c.h * 0.3, x1: c.w * 0.7, y1: c.h * 0.3, x2: c.w * 1.05, y2: c.h, x3: -c.w * 0.05, y3: c.h,
      });
      app.stage.addChild(floor);
      const R = new Rng(2);
      const items: { s: Sprite; x: number; z: number; vx: number; vz: number }[] = [];
      const layer = new Container();
      app.stage.addChild(layer);
      for (let i = 0; i < c.n!; i++) {
        const s = new Sprite(sprT[i % sprT.length]!);
        s.anchor.set(0.5, 1);
        layer.addChild(s);
        items.push({ s, x: R.next(), z: R.next(), vx: (R.next() - 0.5) * 0.004, vz: (R.next() - 0.5) * 0.004 });
      }
      return {
        app,
        step() {
          for (const o of items) {
            o.x += o.vx; o.z += o.vz;
            if (o.x < 0 || o.x > 1) o.vx = -o.vx;
            if (o.z < 0 || o.z > 1) o.vz = -o.vz;
            const k = 0.35 + 0.65 * o.z; // depth scale
            const half = (0.2 + 0.55 * o.z) * c.w * 0.5;
            o.s.position.set(c.w / 2 + (o.x - 0.5) * 2 * half, c.h * (0.3 + 0.7 * o.z));
            o.s.scale.set(0.45 * k);
            o.s.zIndex = o.z;
          }
          layer.sortDirty = true;
        },
      };
    }
    case 'idle': {
      const app = await ownApp(c.w, c.h);
      return { app, step() {} };
    }
    case 'particles': {
      const s = await setupGame({ ...c, game: 'heist', bots: 2, fx: 'full' });
      const view = s.view as unknown as { budget: FxBudget; particles: { budget: FxBudget; one: (...a: unknown[]) => boolean; count: number } };
      const budget = new FxBudget(c.n!);
      view.budget = budget;
      (view.particles as { budget: FxBudget }).budget = budget;
      budget.fpsFeedback = () => {};
      const R = new Rng(11);
      const base = s.step;
      let spawned = 0;
      return {
        ...s,
        step(dtMs, now) {
          void base; // the scene itself is static here: only particles are exercised
          void now;
          void dtMs;
          // keep the pool topped up to N live particles (half additive, half normal), 1.2 s life
          const room = budget.max - budget.active;
          for (let i = 0; i < room; i++) {
            const add = i % 2 === 0;
            view.particles.one(add ? 'glow' : 'confetti', R.next() * c.w, R.next() * c.h, {
              vx: (R.next() - 0.5) * 120, vy: (R.next() - 0.5) * 120, life: 1.2, s0: 0.4 + R.next() * 0.5, grow: 0.2, spin: 2, add, a0: 0.8, tint: 0xffffff * R.next(),
            });
            spawned++;
          }
        },
        info: () => ({ live: view.particles.count, spawned }),
      };
    }
    case 'raw': {
      const app = await ownApp(c.w, c.h);
      const t0 = performance.now();
      const names = ['coin', 'gem', 'star', 'bomb', 'crate', 'fireball', 'gift-box', 'ladoo', 'ice-shard', 'spiky-ball', 'treasure-chest', 'golden-fish'];
      const texs = await loadArt(names, 192);
      const R = new Rng(5);
      const layer = new Container();
      app.stage.addChild(layer);
      const sp: { s: Sprite; vx: number; vy: number; rot: number }[] = [];
      for (let i = 0; i < c.n!; i++) {
        const s = new Sprite(texs[i % texs.length]!);
        s.anchor.set(0.5);
        s.scale.set(0.3 + R.next() * 0.2); // ~60-100 px sprites
        s.position.set(R.next() * c.w, R.next() * c.h);
        layer.addChild(s);
        sp.push({ s, vx: (R.next() - 0.5) * 3, vy: (R.next() - 0.5) * 3, rot: (R.next() - 0.5) * 0.04 });
      }
      return {
        app,
        loadMs: performance.now() - t0,
        step() {
          for (const o of sp) {
            o.s.x += o.vx;
            o.s.y += o.vy;
            o.s.rotation += o.rot;
            if (o.s.x < 0 || o.s.x > c.w) o.vx = -o.vx;
            if (o.s.y < 0 || o.s.y > c.h) o.vy = -o.vy;
          }
        },
      };
    }
    case 'text': {
      const app = await ownApp(c.w, c.h);
      const R = new Rng(9);
      const items: (Text | BitmapText)[] = [];
      const bitmap = c.mode!.startsWith('bitmap');
      for (let i = 0; i < c.n!; i++) {
        const style = { fontFamily: 'Figtree, sans-serif', fontSize: 28 + (i % 4) * 6, fill: 0xffffff, stroke: { color: 0x14102b, width: 4 } };
        const t = bitmap ? new BitmapText({ text: `Player ${i} 100`, style }) : new Text({ text: `Player ${i} 100`, style });
        t.position.set(R.next() * (c.w - 200), R.next() * (c.h - 50));
        app.stage.addChild(t);
        items.push(t);
      }
      const dyn = c.mode!.endsWith('dynamic');
      let k = 0;
      return {
        app,
        step() {
          if (!dyn) return;
          k++;
          for (let i = 0; i < items.length; i++) items[i]!.text = `P${i} ${k * 7 + i}`;
        },
      };
    }
    case 'fill': {
      const app = await ownApp(c.w, c.h);
      const layers: Sprite[] = [];
      for (let i = 0; i < c.n!; i++) {
        const s = new Sprite(Texture.WHITE);
        s.width = c.w;
        s.height = c.h;
        s.tint = [0x4cc9f0, 0xf72585, 0xffd166, 0x80ed99][i % 4]!;
        s.alpha = c.mode === 'add' ? 0.25 : 0.35;
        if (c.mode === 'add') s.blendMode = 'add';
        app.stage.addChild(s);
        layers.push(s);
      }
      let t = 0;
      return {
        app,
        step() {
          t += 0.016;
          for (let i = 0; i < layers.length; i++) layers[i]!.alpha = (c.mode === 'add' ? 0.2 : 0.3) + 0.05 * Math.sin(t + i);
        },
      };
    }
    case 'tex': {
      const app = await ownApp(c.w, c.h);
      const px = Number(c.mode);
      const t0 = performance.now();
      const names = Object.keys(DEFAULT_ART_URLS);
      const texs = px >= 0 && c.mode !== '0' ? await loadArt(names, px === 512 ? 0 : px) : [];
      const grid = new Container();
      app.stage.addChild(grid);
      texs.forEach((tx, i) => {
        const s = new Sprite(tx);
        s.anchor.set(0.5);
        s.scale.set(70 / Math.max(tx.width, tx.height));
        s.position.set(60 + (i % 17) * 72, 60 + Math.floor(i / 17) * 100);
        grid.addChild(s);
      });
      let texBytes = 0;
      for (const tx of texs) texBytes += tx.source.pixelWidth * tx.source.pixelHeight * 4;
      return {
        app,
        step() {},
        loadMs: performance.now() - t0,
        info: () => ({ textures: texs.length, textureMB: r1(texBytes / 1048576), artPx: px }),
      };
    }
  }
}

// ---- measurement ---------------------------------------------------------------------------------
function glInfo(app?: Application, glIn?: WebGLRenderingContext): Record<string, unknown> {
  try {
    const gl = glIn ?? (app?.renderer as unknown as { gl?: WebGLRenderingContext } | undefined)?.gl;
    if (!gl) return {};
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      glRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      glVersion: gl.getParameter(gl.VERSION),
      maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  } catch {
    return {};
  }
}

function heap(): Record<string, number> {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  return m ? { heapUsedMB: r1(m.usedJSHeapSize / 1048576), heapTotalMB: r1(m.totalJSHeapSize / 1048576) } : {};
}

function stats(ft: number[], js: number[], secs: number[], measureMs: number): Record<string, number> {
  const s = [...ft].sort((a, b) => a - b);
  const jsS = [...js].sort((a, b) => a - b);
  const n = ft.length;
  const tail = s.slice(Math.floor(s.length * 0.99));
  const buckets = secs.slice(0, Math.floor(measureMs / 1000)); // complete seconds only
  return {
    frames: n,
    fps: r1((n * 1000) / ft.reduce((a, b) => a + b, 0)),
    fpsMinSec: buckets.length ? Math.min(...buckets) : 0,
    fps1pLow: r1(1000 / (tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : 16.7)),
    ftP50: r1(q(s, 50)),
    ftP95: r1(q(s, 95)),
    ftP99: r1(q(s, 99)),
    ftMax: r1(s[s.length - 1] ?? 0),
    long33: ft.filter((x) => x > 33.4).length,
    over20: ft.filter((x) => x > 20).length,
    jsAvg: r2(js.reduce((a, b) => a + b, 0) / Math.max(1, js.length)),
    jsP95: r2(q(jsS, 95)),
  };
}

async function main(): Promise<void> {
  if (qs.get('list')) {
    log('BENCH_PLAN', plan.map((c, i) => `${i}:${c.id}`).join(' '));
    return;
  }
  const c = plan[idx];
  if (!c) {
    log('BENCH_DONE', { grp, cells: plan.length });
    status.textContent = `done (${plan.length} cells)`;
    return;
  }
  status.textContent = `${idx + 1}/${plan.length} ${c.id}`;
  log('BENCH_START', { i: idx, of: plan.length, id: c.id, wall: Date.now() });
  const tBoot = performance.now();
  const s = await setup(c);
  const app = s.app;
  const runMs = c.durMs ?? RUN_MS;
  // JS cost of the Pixi tick (update + render submission) via bracketing ticker callbacks
  let jsMark = 0, jsTick = 0;
  app?.ticker.add(() => { jsMark = performance.now(); }, undefined, 100 as UPDATE_PRIORITY);
  app?.ticker.add(() => { jsTick = performance.now() - jsMark; }, undefined, -100 as UPDATE_PRIORITY);

  const ft: number[] = [], js: number[] = [];
  const secs: number[] = [];
  let last = 0, startAt = 0, ttff = 0, bucketN = 0, bucketStart = 0;
  let winFt: number[] = [], winStart = 0;
  await new Promise<void>((resolve) => {
    const loop = (now: number): void => {
      if (!last) {
        last = now;
        startAt = now;
        ttff = performance.now() - tBoot;
        log('BENCH_FIRSTFRAME', { id: c.id, wall: Date.now(), sinceNavMs: r1(performance.now()), setupMs: r1(ttff) });
        requestAnimationFrame(loop);
        return;
      }
      const dtMs = now - last;
      last = now;
      const t = now - startAt;
      const b0 = performance.now();
      s.step(dtMs, now);
      const body = performance.now() - b0;
      if (keyPending) {
        log('BENCHKEYFRAME', { framesMs: r1(performance.now() - keyPending), wall: Date.now() });
        keyPending = 0;
      }
      if (t >= WARM_MS) {
        if (!bucketStart) { bucketStart = now; winStart = now; }
        ft.push(dtMs);
        js.push(body + jsTick);
        winFt.push(dtMs);
        bucketN++;
        if (now - bucketStart >= 1000) {
          secs.push(r1((bucketN * 1000) / (now - bucketStart)));
          bucketN = 0;
          bucketStart = now;
        }
        if (c.grp === 'thermal' && now - winStart >= 10000) {
          const w = [...winFt].sort((a, b) => a - b);
          log('BENCH_T', { id: c.id, t: Math.round((now - startAt - WARM_MS) / 1000), fps: r1((w.length * 1000) / w.reduce((a, b) => a + b, 0)), p95: r1(q(w, 95)), long33: w.filter((x) => x > 33.4).length, ...(s.info?.() ?? {}), ...heap() });
          winFt = [];
          winStart = now;
        }
        if (t >= WARM_MS + runMs) return resolve();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const row = {
    id: c.id, grp: c.grp, kind: c.kind, w: c.w, h: c.h, game: c.game, bots: c.bots, fx: c.fx, n: c.n, mode: c.mode,
    ...stats(ft, js, secs, runMs), loadMs: s.loadMs !== undefined ? Math.round(s.loadMs) : undefined, setupMs: Math.round(ttff),
    ...heap(), ...(s.info?.() ?? {}), ...glInfo(app, s.gl), dpr: window.devicePixelRatio, vw: innerWidth, vh: innerHeight,
  };
  log('BENCH', row);
  // memory hold: keep the scene alive & drawing while the host samples dumpsys meminfo
  if (c.grp !== 'thermal' && c.grp !== 'input') {
    log('BENCH_MEM', c.id);
    const holdEnd = performance.now() + MEM_HOLD_MS;
    await new Promise<void>((r) => {
      const l = (now: number) => {
        s.step(16.7, now);
        if (performance.now() < holdEnd) requestAnimationFrame(l);
        else r();
      };
      requestAnimationFrame(l);
    });
  } else if (c.grp === 'thermal') {
    log('BENCH_MEM', c.id);
    await sleep(MEM_HOLD_MS);
  }
  if (c.grp === 'input') return log('BENCH_DONE', { grp, cells: plan.length });
  goNext();
}

function goNext(): void {
  const next = new URLSearchParams(location.search);
  next.set('i', String(idx + 1));
  next.set('grp', grp);
  location.replace(`${location.pathname}?${next.toString()}`);
}

main().catch((e) => {
  log('BENCH_ERROR', { idx, id: plan[idx]?.id, error: String(e), stack: String((e as Error).stack ?? '').slice(0, 600) });
  setTimeout(goNext, 500); // a broken cell never stalls the run
});
