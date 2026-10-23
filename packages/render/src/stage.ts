import { Application, Container, FillGradient, Graphics, Point, Sprite, Text, Texture } from 'pixi.js';
import type { Entity, FxEvent, GameEvent, GameRuntime, Player } from '@cadabra/engine';
import type { Theme } from '@cadabra/spec';
import { Ambience } from './ambience';
import { HitStop, hitStopFor } from './anim';
import { BackgroundBake, EdgeGlow } from './background';
import { DEFAULT_ART_URLS } from './assets';
import { CameraRig, capShake } from './camera';
import { FxDirector, comboForEvent, comboForPreset, type ComboKind } from './director';
import { arch, easeInOutSine, easeOutBack, easeOutCubic } from './ease';
import { EntityLayer, label, setTextResolution, type FrameCtx } from './entities';
import { Hud } from './hud';
import { FxBudget, JuiceState, MAX_PARTICLES } from './juice';
import { ParticleSystem } from './particles';
import { itemNoun, popupText, popupTone } from './popups';
import { arenaRect, buildScenery, SCENE_ART, sceneFor, type Rect, type SceneKind } from './scenery';
import { prewarmSfx, setSfxSet, sfx } from './sfx';
import { AVATAR_ART, DEFAULT_SPRITES } from './sprites';
import { TextureStore } from './textures';
import { darken, hexToNum, lighten, type Palette } from './theme';
import { SnapInterp } from './visual';
import { NEON, NEON_PALETTE, NeonArt, type RenderStyle } from './neon';
import { bandTexture, buildNeonScenery } from './neonScene';
import { DISPLAY_FONT } from './theme';

export type Snapshot = ReturnType<GameRuntime['snapshot']>;

export interface GameViewOpts {
  /** Internal render size; 1280x720 by default (960x540 if the device gate says so). */
  internalW: number;
  internalH: number;
  /** World size the snapshot coordinates live in (GameSpec.arena); defaults to the internal size. */
  arena?: { width: number; height: number };
  /** GameSpec.arena.kind (tug draws a mud pit, ...). */
  arenaKind?: string;
  /** Draw timer, score chips and banner (default true). */
  hud?: boolean;
  /** Draw the snapshot's host-line banner (default true; the TV captions host lines itself). */
  banner?: boolean;
  /** Visual style: 'neon' (default, task N1) or the legacy 'cartoon' art pack. */
  style?: RenderStyle;
}

const SIM_DT = 1 / 60;
const PRELOAD_MS = 4000;
const SHAKE_PAD = 40;
/** Shake never moves the picture more than this (px). */
const SHAKE_CAP = 16;
/** Popups kept as ready-rasterised Text per distinct string (no re-raster per popup). */
const POPUP_CACHE = 28;

const DEFAULT_PALETTE: Palette = NEON_PALETTE;

/** Hue (0..360) and lightness of a '#rrggbb'. */
function hsl(hex: string): { h: number; l: number; s: number } {
  const n = hexToNum(hex);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, l, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) };
}

/** Default floor tile that suits the palette (warm -> kitchen, green -> grass, ...). */
export function pickFloor(p: Palette, present: Record<string, string>): string | undefined {
  const { h, s } = hsl(p.primary);
  const want = s < 0.15 ? 'floor-ice'
    : h >= 70 && h < 170 ? 'floor-grass'
      : h >= 170 && h < 260 ? 'floor-ice'
        : h < 15 || h >= 330 ? 'floor-volcanic'
          : 'floor-kitchen';
  const order = [want, 'floor-kitchen', 'floor-grass', 'floor-ice', 'floor-volcanic'];
  return order.find((f) => present[f] !== undefined);
}

function vignetteTexture(): Texture {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 180;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(160, 90, 60, 160, 90, 210);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.05)');
  gr.addColorStop(1, 'rgba(255,255,255,0.7)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 320, 180);
  return Texture.from(c);
}

interface Float {
  t: Text;
  str: string;
  at: number;
  /** Start position, screen px. */
  x: number;
  y: number;
  /** Player whose HUD chip this popup flies to ('' = just rise and fade). */
  pid: string;
  big: boolean;
  live: boolean;
  /** Stack slot (0 = at the head): concurrent popups near one spot take different slots. */
  slot: number;
}

/** Pulls only the new GameEvents from a runtime each frame (hosts: `feed.next(rt)`). */
export class EventFeed {
  private n = 0;
  next(rt: { readonly events: readonly GameEvent[] }): GameEvent[] {
    const all = rt.events;
    if (all.length < this.n) this.n = 0; // a new runtime
    const out = all.length > this.n ? all.slice(this.n) : [];
    this.n = all.length;
    return out as GameEvent[];
  }
  reset(): void {
    this.n = 0;
  }
}

/**
 * Draws GameRuntime snapshots with PixiJS. Pixi's own ticker paints every display frame;
 * `render()` hands over the newest snapshot (+ fx, + new game events) and the host loop's
 * interpolation alpha.
 *
 * Host-loop contract (the sim always steps by its fixed DT):
 * - slow-mo: multiply real frame dt by `timeScale` before adding it to the accumulator;
 * - hit-stop: while `hitStopMs > 0`, do not add to the accumulator at all.
 * i.e. `acc = advanceAccumulator(acc, dt, view.timeScale, view.hitStopMs)`.
 *
 * Presentation cues for the match flow (the TV drives them): `punch()` on GO,
 * `setMultiplier()` for the final 10, `freeze()` for TIME!, `celebrate()` for the winner shot.
 */
export class GameView {
  readonly ready: Promise<void>;
  private app = new Application();
  private W: number;
  private H: number;
  private arenaW: number;
  private arenaH: number;
  private arenaKind: string | undefined;
  private showHud: boolean;
  private showBanner: boolean;
  /** Neon arcade look (default) vs the cartoon art pack. */
  readonly neon: boolean;
  private nart?: NeonArt;
  /** Neon: one soft band drifting down the arena (the slow scanline pulse). */
  private sweep?: Sprite;
  private sweepTex?: Texture;
  private destroyed = false;
  private started = false;

  private store!: TextureStore;
  private budget = new FxBudget(MAX_PARTICLES);
  private juice = new JuiceState();
  private director = new FxDirector();
  private particles!: ParticleSystem;
  private entities!: EntityLayer;
  private hud!: Hud;
  private hudScale = 1;

  private shaker = new Container();
  private world = new Container();
  /** Static background baked into one opaque sprite (see BackgroundBake). */
  private bake!: BackgroundBake;
  private bgGrad = new Graphics();
  private scene?: Container;
  private sceneKind: SceneKind = 'generic';
  private sceneKey = '';
  private rect: Rect & { k: number } = { x: 0, y: 0, w: 0, h: 0, k: 1 };
  private ambience!: Ambience;
  private floats: Float[] = [];
  private popCache = new Map<string, Text[]>();
  /** Score popups live in screen space so big ones can fly to the HUD. */
  private popLayer = new Container();
  private hitStop = new HitStop();
  private freezeMs = 0;
  private cam: CameraRig;
  private rt = 0;
  // scratch (no per-frame allocation)
  private readonly shakeO = { x: 0, y: 0, rot: 0 };
  private readonly driftO = { x: 0, y: 0 };
  private readonly tmpA = new Point();
  private readonly tmpB = new Point();
  private readonly tmpC = { x: 0, y: 0 };
  private readonly playersM = new Map<string, Player>();
  private readonly indexM = new Map<string, number>();
  private ctx?: FrameCtx;
  /** Last fx location (screen px) and when: big moments zoom toward it. */
  private fxX = 0;
  private fxY = 0;
  private fxAt = -9;
  private vignette!: Sprite;
  /** Finale pulse and hit flash: thin additive edge strips, drawn only while active. */
  private finaleGlow!: EdgeGlow;
  private flash!: EdgeGlow;
  private vignetteTex?: Texture;
  private grad?: FillGradient;

  private finaleTint = hexToNum(DEFAULT_PALETTE.accent);
  private finaleA = 0;
  private palette: Palette = DEFAULT_PALETTE;
  private theme?: Theme;
  private art: Record<string, string> = {};
  private defaults: Record<string, string> = DEFAULT_ART_URLS;
  private itemSprite = '';

  private snap?: Snapshot;
  private alpha = 1;
  private interp = new SnapInterp();
  private scores = new Map<string, number>();
  /** Score events arrived this round (then snapshot deltas are not used for popups). */
  private eventPopups = false;
  private vt = 0;
  private fpsAvg = 60;
  private celebrateId = '';
  private celebrateAt = -9;
  private confettiLeft = 0;

  constructor(canvasParent: HTMLElement, opts: GameViewOpts = { internalW: 1280, internalH: 720 }) {
    this.W = opts.internalW || 1280;
    this.H = opts.internalH || 720;
    this.arenaW = opts.arena?.width ?? this.W;
    this.arenaH = opts.arena?.height ?? this.H;
    this.arenaKind = opts.arenaKind;
    this.showHud = opts.hud !== false;
    this.showBanner = opts.banner !== false;
    this.neon = (opts.style ?? 'neon') === 'neon';
    this.cam = new CameraRig(this.W, this.H);
    this.ready = this.init(canvasParent);
  }

  private async init(parent: HTMLElement): Promise<void> {
    await this.app.init({
      width: this.W, height: this.H, background: this.palette.bg, antialias: false, resolution: 1,
      autoDensity: false, preference: 'webgl', powerPreference: 'high-performance', hello: false,
    });
    if (this.destroyed) {
      this.app.destroy(true);
      return;
    }
    const cv = this.app.canvas;
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.objectFit = 'contain';
    cv.style.display = 'block';
    parent.appendChild(cv);

    // text is rasterised at the canvas scale (crisp names and popups on a 1080p canvas)
    this.hudScale = this.H / 720;
    setTextResolution(Math.max(this.hudScale, 1.4));
    this.store = new TextureStore();
    this.particles = new ParticleSystem(this.store, this.budget);
    if (this.neon) this.particles.additiveFrameCap = 28;
    if (this.neon) this.nart = new NeonArt();
    this.entities = new EntityLayer(this.store, this.particles, this.arenaW, this.arenaH, this.nart);
    this.hud = new Hud(this.W / this.hudScale, this.H / this.hudScale);
    this.hud.root.scale.set(this.hudScale);

    this.ambience = new Ambience(this.store.cell('glow'), this.W, this.H, SHAKE_PAD);
    const renderer = this.app.renderer;
    this.bake = new BackgroundBake(this.W, this.H, SHAKE_PAD, (container, target, transform) => {
      renderer.render({ container, target, clear: true, transform });
    });
    // baked stack (off-stage): gradient, [scene: surround, framed floor, props], light pool, vignette
    const vt = vignetteTexture();
    this.vignetteTex = vt;
    this.vignette = new Sprite(vt);
    this.vignette.tint = 0x000000;
    this.vignette.position.set(-SHAKE_PAD, -SHAKE_PAD);
    this.vignette.width = this.W + SHAKE_PAD * 2;
    this.vignette.height = this.H + SHAKE_PAD * 2;
    this.bake.stack.addChild(this.bgGrad, this.ambience.light, this.vignette);
    const en = this.entities;
    this.world.addChild(en.floor, en.glows, en.trails, en.bodies, this.particles.view, en.overlay);
    // on stage: ONE opaque background quad, then the world (no ambient motes: particles mean something)
    this.shaker.addChild(this.bake.sprite);
    if (this.neon) {
      // the neon background bakes its own vignette and scanlines
      this.vignette.visible = false;
      this.ambience.light.visible = false;
      this.sweepTex = bandTexture();
      this.sweep = new Sprite(this.sweepTex);
      this.sweep.blendMode = 'add';
      this.sweep.anchor.set(0, 1);
      this.shaker.addChild(this.sweep);
    }
    this.shaker.addChild(this.world);
    this.finaleGlow = new EdgeGlow(this.W, this.H, 110);
    this.flash = new EdgeGlow(this.W, this.H, 200);
    this.app.stage.addChild(this.shaker, this.finaleGlow.root, this.flash.root, this.popLayer);
    if (this.showHud) this.app.stage.addChild(this.hud.root);
    this.layout();
    this.applyPalette();
    this.app.ticker.add(() => this.frame());
    this.started = true;
  }

  /** Arena (world) size of the current game; snapshot coordinates are in this space. */
  setArena(width: number, height: number, kind?: string): void {
    this.arenaW = width;
    this.arenaH = height;
    if (kind !== undefined) this.arenaKind = kind;
    if (this.started) {
      this.entities.setArena(width, height);
      this.layout();
      this.sceneKey = '';
      this.rebuildScene();
    }
  }

  private layout(): void {
    this.rect = arenaRect(this.W, this.H, this.arenaW, this.arenaH);
    this.world.scale.set(this.rect.k);
    this.world.position.set(this.rect.x, this.rect.y);
    // neon bodies are at least ~72 px across on a 1080p screen, whatever the engine radius
    if (this.entities) this.entities.minBody = this.neon ? (72 * (this.H / 1080)) / this.rect.k : 0;
  }

  /**
   * Apply a game's palette and art. `art` (sprite key -> url, from the forge) overrides the
   * default pack; keys without either get procedural shapes. Resolves after the art in use
   * has loaded or after a few seconds, whichever is first; never rejects.
   */
  async loadTheme(theme: Theme, art: Record<string, string>): Promise<void> {
    await this.ready;
    if (this.destroyed) return;
    this.palette = theme.palette;
    this.theme = theme;
    this.art = { ...art };
    setSfxSet(theme.sfxSet);
    prewarmSfx();
    // a new game: no view may keep showing the previous game's art before it is evicted
    this.entities.clear();
    this.entities.resetSources();
    this.hud.clear();
    this.interp.reset();
    this.director.reset();
    this.snap = undefined;
    this.scores.clear();
    this.eventPopups = false;
    this.itemSprite = '';
    this.celebrateId = '';
    this.celebrateAt = -9;
    this.cam.endShot();
    this.hud.setMultiplier(1, this.vt);
    this.sceneKind = sceneFor(theme, this.arenaKind);
    this.store.beginTheme(Object.values(this.art));
    this.applyPalette();
    const jobs: Promise<unknown>[] = [];
    if (this.neon) {
      // procedural sprites: nothing to download (player selfies load lazily)
      this.sceneKey = '';
      this.rebuildScene();
      return;
    }
    for (const url of Object.values(this.art)) jobs.push(this.store.load(url, undefined, true));
    const sa = SCENE_ART[this.sceneKind];
    const wanted = new Set<string>([
      ...Object.values(DEFAULT_SPRITES).slice(0, 8), 'bear-awake', 'rope-marker',
      ...AVATAR_ART,
      ...Object.keys(theme.sprites).map((k) => DEFAULT_SPRITES[k] ?? k),
      ...(sa.surround ? [sa.surround] : []), ...sa.props,
    ]);
    for (const name of wanted) {
      const url = this.defaults[name];
      if (url) jobs.push(this.store.load(url));
    }
    // floors tile: loaded at 512 px
    for (const f of [sa.floor, sa.surround]) if (f && this.defaults[f]) jobs.push(this.store.load(this.defaults[f]!, 512));
    const custom = this.art.floor ?? this.art.background;
    if (custom) jobs.push(this.store.load(custom, 1280, true));
    jobs.push(this.store.useFxArt(this.defaults));
    await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, PRELOAD_MS))]);
    if (this.destroyed) return;
    this.sceneKey = '';
    this.rebuildScene();
  }

  /** The framed arena + themed surround, rebuilt into the bake once per theme (never per frame). */
  private rebuildScene(): void {
    if (!this.started) return;
    if (this.neon) {
      const key = `neon|${this.palette.bg}|${this.palette.primary}|${this.palette.accent}|${this.rect.w}x${this.rect.h}|${this.arenaKind ?? ''}`;
      if (key === this.sceneKey) return;
      this.sceneKey = key;
      this.scene?.destroy({ children: true, texture: true, textureSource: true });
      this.scene = buildNeonScenery(this.rect, this.W, this.H, SHAKE_PAD, this.palette, this.arenaKind);
      this.bake.stack.addChildAt(this.scene, 1);
      this.bake.invalidate();
      return;
    }
    const custom = this.art.floor ?? this.art.background;
    const key = `${this.sceneKind}|${this.palette.bg}|${this.palette.primary}|${custom ?? ''}|${this.rect.w}x${this.rect.h}|${this.arenaKind ?? ''}`;
    if (key === this.sceneKey) return;
    this.sceneKey = key;
    this.scene?.destroy({ children: true });
    const sa = SCENE_ART[this.sceneKind];
    const tex = (name: string): Texture | undefined => {
      const url = this.defaults[name];
      if (!url) return undefined;
      return name === sa.floor || name === sa.surround ? this.store.loaded(url, 512) : this.store.loaded(url);
    };
    const customTex = custom ? this.store.loaded(custom, 1280) : undefined;
    this.scene = buildScenery(this.sceneKind, this.rect, this.W, this.H, SHAKE_PAD, tex, this.palette, customTex, this.arenaKind);
    this.bake.stack.addChildAt(this.scene, 1);
    this.bake.invalidate();
  }

  private applyPalette(): void {
    if (!this.started) return;
    const p = this.palette;
    const bg = hexToNum(p.bg);
    this.app.renderer.background.color = bg;
    const grad = new FillGradient({
      type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, textureSpace: 'local',
      colorStops: [{ offset: 0, color: lighten(bg, 0.1) }, { offset: 1, color: darken(bg, 0.45) }],
    });
    this.bgGrad.clear().rect(-SHAKE_PAD, -SHAKE_PAD, this.W + SHAKE_PAD * 2, this.H + SHAKE_PAD * 2).fill(grad);
    this.grad?.destroy();
    this.grad = grad;
    this.ambience.setPalette(p, true);
    this.ambience.light.alpha = 0.55;
    this.finaleTint = hexToNum(p.accent);
    this.particles.setPalette(p);
    this.hud.setPalette(p);
    this.rebuildScene();
    this.bake.invalidate();
  }

  /**
   * Hand over the newest snapshot, the fx drained with it and (optionally) the game events
   * logged since the last call (`EventFeed`). `alpha` (0..1) is the host loop's accumulator
   * fraction. With events, score popups carry their reason ("+3 Banked!").
   */
  render(snap: Snapshot, fx: FxEvent[], alpha = 1, events?: readonly GameEvent[]): void {
    if (this.destroyed) return;
    const fresh = this.interp.push(snap);
    this.snap = snap;
    this.alpha = alpha;
    if (!this.started) return;
    if (events) for (const e of events) this.onEvent(e, snap);
    if (fresh) this.scoreJuice(snap);
    for (const e of fx) this.onFx(e);
  }

  private onEvent(e: GameEvent, snap: Snapshot): void {
    if (e.type === 'score') {
      const d = e.data ?? {};
      const delta = typeof d.delta === 'number' ? d.delta : 0;
      if (!delta || !e.player) return;
      this.eventPopups = true;
      const mult = typeof d.mult === 'number' ? d.mult : 1;
      const reason = typeof d.reason === 'string' ? d.reason : '';
      this.popupFor(e.player, popupText(delta, reason, itemNoun(this.itemSprite), mult), popupTone(delta, reason), snap);
      return;
    }
    if (typeof e.data?.phase === 'string' && e.data.phase === 'spawn') return;
    const kind = comboForEvent(e.type, typeof e.data?.moment === 'string' ? e.data.moment : undefined);
    if (!kind || typeof e.data?.moment !== 'string') return;
    const av = e.player ? this.avatarOf(snap, e.player) : undefined;
    const x = typeof e.data?.x === 'number' ? e.data.x : av?.x;
    const y = typeof e.data?.y === 'number' ? e.data.y : av?.y;
    if (x === undefined || y === undefined) return;
    this.combo(kind, x, y);
  }

  private avatarOf(snap: Snapshot, pid: string): Entity | undefined {
    for (const e of snap.entities) if ((e.kind === 'player' || e.kind === 'runner') && e.owner === pid) return e;
    return undefined;
  }

  private onFx(e: FxEvent): void {
    switch (e.kind) {
      case 'particles': {
        const kind = comboForPreset(e.preset);
        if (kind) this.combo(kind, e.x, e.y);
        break;
      }
      case 'sfx':
        sfx(e.name);
        break;
      case 'banner':
        break;
      case 'shake': {
        this.juice.apply(e);
        // big hits freeze the picture for a beat and punch the camera in toward them
        const stop = hitStopFor(e.strength);
        if (stop > 0) {
          this.hitStop.trigger(stop);
          const near = this.rt - this.fxAt < 0.25;
          this.cam.punch(0.03 + 0.05 * Math.min(1, e.strength), near ? this.fxX : this.W / 2, near ? this.fxY : this.H / 2, 0.55);
        }
        break;
      }
      case 'slowmo':
        // slow-mo is reserved for the end-of-round winner shot (it read as lag mid-round)
        break;
      default:
        this.juice.apply(e);
    }
  }

  /** One meaningful moment: its own particles, ring and (for big ones) a little shake. */
  private combo(kind: ComboKind, x: number, y: number): void {
    if (!this.director.allow(kind, x, y, this.rt)) return;
    if (this.neon) this.neonCombo(kind, x, y);
    else this.cartoonCombo(kind, x, y);
    this.toScreen(x, y, this.tmpC);
    this.fxX = this.tmpC.x;
    this.fxY = this.tmpC.y;
    this.fxAt = this.rt;
  }

  /** Neon juice: sparks, line bursts, shockwave rings; knockouts / detonations flash the edges. */
  private neonCombo(kind: ComboKind, x: number, y: number): void {
    const P = this.particles;
    const prim = hexToNum(this.palette.primary), glow = hexToNum(this.palette.glow), acc = hexToNum(this.palette.accent);
    switch (kind) {
      case 'pickup':
        P.emit('ngem', x, y);
        this.ring(x, y, 0.25, 1.4, glow);
        break;
      case 'bank': {
        P.emit('nspark', x, y);
        this.ring(x, y, 0.45, 3, glow);
        this.ring(x, y, 0.3, 1.8, 0xffffff);
        this.juice.apply({ kind: 'shake', strength: 0.12 });
        const g = this.entities.goalNear(x, y);
        if (g >= 0) this.entities.thumpGoal(g, this.vt);
        break;
      }
      case 'golden':
        P.emit('ngold', x, y);
        this.ring(x, y, 0.5, 3.4, NEON.amber);
        break;
      case 'steal':
        P.emit('nlines', x, y, 0.7);
        this.ring(x, y, 0.3, 1.8, acc);
        break;
      case 'hit':
        P.emit('nspark', x, y, 0.5);
        this.ring(x, y, 0.3, 2, NEON.red);
        break;
      case 'blast':
        P.emit('nboom', x, y, 0.7);
        P.emit('nlines', x, y, 0.4);
        this.ring(x, y, 0.55, 5.5, 0xffffff);
        this.ring(x, y, 0.7, 4, NEON.red);
        this.juice.apply({ kind: 'flash', color: '#FF3355' });
        this.juice.apply({ kind: 'shake', strength: 0.4 });
        break;
      case 'wake':
      case 'chase':
        this.ring(x, y, 0.55, 4, NEON.red);
        break;
      case 'dash':
        break;
      case 'splash':
        P.emit('nspark', x, y);
        this.ring(x, y, 0.4, 2.6, prim);
        break;
      case 'win':
        P.emit('confetti', x, y);
        P.emit('ngold', x, y, 0.6);
        break;
    }
  }

  private cartoonCombo(kind: ComboKind, x: number, y: number): void {
    const P = this.particles;
    const glow = hexToNum(this.palette.glow);
    switch (kind) {
      case 'pickup':
        P.emit('pickup', x, y - 10);
        break;
      case 'bank': {
        P.emit('fountain', x, y - 20);
        this.ring(x, y, 0.45, 2.6, glow);
        this.juice.apply({ kind: 'shake', strength: 0.12 });
        const g = this.entities.goalNear(x, y);
        if (g >= 0) this.entities.thumpGoal(g, this.vt);
        break;
      }
      case 'golden':
        P.emit('golden', x, y - 10);
        this.ring(x, y, 0.5, 3, 0xffd23f);
        break;
      case 'steal':
        P.emit('steal', x, y - 10);
        this.ring(x, y, 0.3, 1.6, hexToNum(this.palette.accent));
        break;
      case 'hit':
        P.emit('hit', x, y - 10);
        this.ring(x, y, 0.3, 2, 0xff5a4a);
        break;
      case 'wake':
      case 'chase':
        P.emit('shock', x, y);
        this.ring(x, y, 0.55, 4, 0xff3b3b);
        break;
      case 'dash':
        P.emit('dust', x, y + 10);
        break;
      case 'splash':
        P.emit('splash', x, y);
        P.emit('splash', x, y, 0.6);
        this.ring(x, y, 0.4, 2.6, 0x7a4a24);
        break;
      case 'win':
        P.emit('confetti', x, y);
        P.emit('golden', x, y, 0.6);
        break;
      case 'blast':
        P.emit('hit', x, y - 10);
        this.ring(x, y, 0.4, 3, 0xff5a4a);
        break;
    }
  }

  private readonly ringO = { life: 0.4, s0: 0.5, tint: 0xffffff, add: true, a0: 1, vx: 0, vy: 0, grow: 2, aspect: 0.62, spin: 0, rot: 0, gravity: 0, drag: 0 };
  private ring(x: number, y: number, life: number, grow: number, tint: number): void {
    const o = this.ringO;
    o.life = life;
    o.grow = grow;
    o.tint = tint;
    o.aspect = this.neon ? 1 : 0.62;
    this.particles.one('ring', x, y, o);
  }

  /** Arena coords -> screen px (ignores the camera's zoom; fine for aiming). */
  private toScreen(x: number, y: number, out: { x: number; y: number }): void {
    out.x = this.world.x + x * this.world.scale.x;
    out.y = this.world.y + y * this.world.scale.y;
  }

  /** Snapshot score deltas: hop on gain; popups only when no score events are flowing. */
  private scoreJuice(snap: Snapshot): void {
    for (const e of snap.entities) if (e.kind === 'item' && !this.itemSprite) this.itemSprite = e.sprite;
    for (const p of snap.players) {
      const before = this.scores.get(p.id);
      this.scores.set(p.id, p.score);
      if (before === undefined || p.score === before) continue;
      const d = p.score - before;
      const av = this.avatarOf(snap, p.id);
      if (av && d > 0) this.entities.cheer(av.id);
      if (!this.eventPopups) this.popupFor(p.id, popupText(d, undefined), popupTone(d, undefined), snap);
    }
  }

  private popupFor(pid: string, text: string, tone: 'gain' | 'loss' | 'big', snap: Snapshot): void {
    const av = this.avatarOf(snap, pid);
    const head = this.tmpA;
    if (!(av && this.entities.headOf(av.id, head))) head.set(av?.x ?? this.arenaW / 2, (av?.y ?? this.arenaH / 2) - (av ? av.r * 6 : 0));
    this.world.toGlobal(head, this.tmpB);
    const big = tone === 'big';
    const color = this.neon ? (tone === 'loss' ? NEON.red : big ? NEON.amber : hexToNum(this.palette.glow))
      : tone === 'loss' ? 0xff6b6b : big ? 0xffffff : hexToNum(this.palette.glow);
    if (this.neon) text = text.toUpperCase();
    this.spawnFloat(text, color, this.tmpB.x, this.tmpB.y, big && this.showHud ? pid : '', big);
  }

  /** A ready Text for `str` (rasterised once per distinct string, kept in a small cache). */
  private textFor(str: string, color: number, big: boolean): Text {
    const key = `${str}|${color}|${big ? 1 : 0}`;
    const list = this.popCache.get(key) ?? [];
    for (const t of list) if (!t.visible) return t;
    if (this.popCache.size >= POPUP_CACHE && list.length === 0) {
      // evict an idle string
      for (const [k, l] of this.popCache) {
        if (l.every((t) => !t.visible)) {
          for (const t of l) t.destroy();
          this.popCache.delete(k);
          break;
        }
      }
    }
    const t = this.neon ? this.neonLabel(str, big ? 50 : 40, color) : label(str, big ? 46 : 38, color, { display: true, stroke: big ? 9 : 7 });
    if (big && !this.neon) t.style.stroke = { color: darken(hexToNum(this.palette.glow), 0.5), width: 9, join: 'round' };
    t.visible = false;
    this.popLayer.addChild(t);
    list.push(t);
    this.popCache.set(key, list);
    return t;
  }

  /** Chunky glowing arcade text: white-hot fill, coloured outline and a soft colour glow. */
  private neonLabel(str: string, size: number, color: number): Text {
    const t = new Text({
      text: str,
      style: {
        fontFamily: DISPLAY_FONT, fontSize: size, fontWeight: '800', letterSpacing: 2,
        fill: lighten(color, 0.55),
        stroke: { color: darken(color, 0.35), width: Math.round(size / 7), join: 'round' },
        dropShadow: { color, alpha: 0.95, blur: 12, distance: 0, angle: 0 },
        align: 'center', padding: 16,
      },
      resolution: Math.max(1, Math.min(2, this.hudScale)),
    });
    t.anchor.set(0.5);
    return t;
  }

  private slotH(): number {
    return (this.neon ? 60 : 46) * this.hudScale;
  }

  private spawnFloat(text: string, color: number, x: number, y: number, pid: string, big: boolean): void {
    let f: Float | undefined;
    for (const o of this.floats) if (!o.live) f = o;
    if (!f) {
      if (this.floats.length >= 12) {
        f = this.floats[0]!;
        for (const o of this.floats) if (o.at < f.at) f = o;
        f.t.visible = false;
      } else {
        f = { t: undefined as unknown as Text, str: '', at: 0, x: 0, y: 0, pid: '', big: false, live: false, slot: 0 };
        this.floats.push(f);
      }
    }
    f.t = this.textFor(text, color, big);
    f.str = text;
    f.t.visible = true;
    f.t.alpha = 1;
    f.t.scale.set(0);
    f.at = this.vt;
    f.x = x;
    y = Math.max(y, 120 * this.hudScale); // room to rise without leaving the screen
    // stack popups near the same spot into slots: a live neighbour's slot is taken, use the lowest free one
    let used = 0;
    for (const o of this.floats) if (o !== f && o.live && Math.abs(o.x - x) < 260 && Math.abs(o.y - y) < 160 + o.slot * this.slotH()) used |= 1 << o.slot;
    let slot = 0;
    while (used & (1 << slot) && slot < 6) slot++;
    f.slot = slot;
    // near the top edge the stack grows downward so nothing is pushed off screen
    f.y = y < this.H * 0.3 ? y + slot * this.slotH() : y - slot * this.slotH();
    f.pid = pid;
    f.big = big;
    f.live = true;
  }

  // ---------- match-flow cues (the TV app drives these) ----------

  /** GO!: a camera punch at the arena centre and a white edge flash. */
  punch(): void {
    if (!this.started) return;
    this.cam.punch(0.08, this.W / 2, this.H / 2, 0.5);
    this.juice.apply({ kind: 'flash', color: '#ffffff' });
    this.juice.apply({ kind: 'shake', strength: 0.25 });
  }

  /** Final-10 double points (1 = off): timer badge. */
  setMultiplier(m: number): void {
    if (this.started) this.hud.setMultiplier(m, this.vt);
  }

  /** TIME!: hold the picture for `ms` (visuals freeze; shake and flash play on). */
  freeze(ms = 450): void {
    this.freezeMs = Math.max(this.freezeMs, ms);
    this.juice.apply({ kind: 'flash', color: '#ffffff' });
    this.juice.apply({ kind: 'shake', strength: 0.35 });
  }

  /**
   * The payoff: slow-mo close-up on the winner's avatar (or the arena centre), then confetti
   * bursts around them. The only confetti in a round.
   */
  celebrate(winnerId?: string): void {
    if (!this.started) return;
    this.celebrateId = winnerId ?? '';
    this.celebrateAt = this.rt;
    this.confettiLeft = 3;
    this.juice.apply({ kind: 'slowmo', ms: 2200 });
  }

  /** Slow-mo factor for the host loop's accumulator (1 = normal speed). */
  get timeScale(): number {
    return this.juice.timeScale;
  }

  /** Milliseconds of render freeze left after a big hit (host must hold its accumulator). */
  get hitStopMs(): number {
    return this.hitStop.ms + this.freezeMs;
  }

  /** Smoothed render fps (for the debug overlay). */
  get fps(): number {
    return this.fpsAvg;
  }

  get particleCount(): number {
    return this.started ? this.particles.count : 0;
  }

  private frame(): void {
    const dt = Math.min(0.1, this.app.ticker.deltaMS / 1000);
    const fps = dt > 0 ? 1 / dt : 60;
    this.fpsAvg += (fps - this.fpsAvg) * 0.05;
    this.budget.fpsFeedback(fps, dt);
    this.rt += dt;
    // hit-stop / TIME! freeze everything that moves with the game; shake, flash and camera play on
    const frozen = this.hitStop.ms > 0 || this.freezeMs > 0;
    this.hitStop.tick(dt * 1000);
    this.freezeMs = Math.max(0, this.freezeMs - dt * 1000);
    this.juice.tick(dt);
    const vdt = frozen ? 0 : dt * this.juice.timeScale;
    this.vt += vdt;

    // the static background is re-rendered only after a theme / palette / scene change
    this.bake.ensure();
    const snap = this.snap;
    let finale = false;
    if (snap) {
      const players = this.playersM, index = this.indexM;
      players.clear();
      index.clear();
      let leader: string | undefined;
      let best = 0, tie = false;
      for (let i = 0; i < snap.players.length; i++) {
        const p = snap.players[i]!;
        players.set(p.id, p);
        index.set(p.id, i);
        if (p.score > best) {
          best = p.score;
          leader = p.id;
          tie = false;
        } else if (p.score === best && best > 0) tie = true;
      }
      const ctx = this.ctx ?? (this.ctx = {
        palette: this.palette, art: this.art, defaults: this.defaults, players, playerIndex: index, time: 0, vt: 0, dt: 0, degraded: false,
      });
      ctx.palette = this.palette;
      ctx.art = this.art;
      ctx.defaults = this.defaults;
      ctx.time = snap.time - (1 - this.alpha) * SIM_DT;
      ctx.vt = this.vt;
      ctx.dt = vdt;
      ctx.degraded = this.budget.degraded;
      ctx.leader = leader && !tie ? leader : undefined;
      let hunted: string | undefined;
      for (const e of snap.entities) {
        if (e.kind === 'guard' && typeof e.props.chaseTarget === 'string' && e.props.chaseTarget) hunted = e.props.chaseTarget;
      }
      ctx.hunted = hunted;
      this.entities.sync(snap.entities, this.posFn, ctx);
      if (this.showHud) this.hud.update(snap.players, snap.remaining, this.showBanner ? snap.banner : undefined, this.vt, this.avatarFn);
      finale = snap.remaining > 0 && snap.remaining <= 10;
      // camera: frame every player (soft zoom 1.0–1.15); the finale leans in a touch more
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
      let wx = 0, wy = 0, found = false;
      for (const e of snap.entities) {
        const isAv = e.kind === 'player' || e.kind === 'runner';
        // frame the players and the places they run to (bases / goals)
        if (!isAv && e.kind !== 'goal' && e.kind !== 'base' && e.kind !== 'guard') continue;
        this.toScreen(e.x, e.y, this.tmpC);
        if (this.tmpC.x < x0) x0 = this.tmpC.x;
        if (this.tmpC.x > x1) x1 = this.tmpC.x;
        if (this.tmpC.y < y0) y0 = this.tmpC.y;
        if (this.tmpC.y > y1) y1 = this.tmpC.y;
        n++;
        if (isAv && this.celebrateId && e.owner === this.celebrateId) {
          wx = this.tmpC.x;
          wy = this.tmpC.y;
          found = true;
        }
      }
      if (this.celebrateId !== '' || this.celebrateAt > 0) this.winnerShot(found, wx, wy);
      else if (n > 0) {
        this.cam.frame(x0, y0, x1, y1);
        this.cam.setFinale(finale, (x0 + x1) / 2, (y0 + y1) / 2);
      }
      this.finaleA = finale ? 0.2 + 0.16 * Math.sin(this.rt * 6) : Math.max(0, this.finaleA - dt);
      this.finaleGlow.set(this.finaleA, this.finaleTint);
    }
    this.particles.update(vdt);
    this.animateFloats();
    if (this.sweep) {
      // a faint band rolls down the arena every 6 s (the "pulsing scanlines")
      const r = this.rect, ph = (this.rt / 6) % 1;
      this.sweep.position.set(r.x, r.y + ph * (r.h + 90));
      this.sweep.width = r.w;
      this.sweep.height = 90;
      this.sweep.tint = hexToNum(this.palette.primary);
      this.sweep.alpha = 0.07 * Math.sin(ph * Math.PI);
      this.sweep.visible = this.sweep.alpha > 0.004 && this.sweep.y < r.y + r.h + 4;
    }

    // camera: eased zoom about the focus + ≤ 2 px drift + capped shake (real time)
    this.cam.tick(dt);
    this.cam.drift(this.rt, this.driftO);
    const o = this.juice.shakeOffset(this.rt, this.shakeO);
    capShake(o, SHAKE_CAP);
    const z = this.cam.zoom;
    this.shaker.pivot.set(this.cam.fx, this.cam.fy);
    this.shaker.position.set(this.cam.fx + o.x + this.driftO.x, this.cam.fy + o.y + this.driftO.y);
    this.shaker.scale.set(z);
    this.shaker.rotation = o.rot;
    this.flash.set(this.juice.flashAlpha * 0.9, this.juice.flashColor);
  }

  private winnerShot(found: boolean, sx: number, sy: number): void {
    const x = found ? sx : this.W / 2, y = found ? sy : this.H / 2;
    if (!this.cam.inShot) this.cam.closeUp(x, y - 40 * this.hudScale);
    // confetti bursts around the winner (in world coords), staggered
    const since = this.rt - this.celebrateAt;
    const want = since > 1.2 ? 0 : since > 0.7 ? 1 : since > 0.25 ? 2 : 3;
    while (this.confettiLeft > want) {
      this.confettiLeft--;
      const wxw = (x - this.world.x) / this.world.scale.x, wyw = (y - this.world.y) / this.world.scale.y;
      const off = [0, -110, 110][this.confettiLeft] ?? 0;
      this.particles.emit('confetti', wxw + off, wyw - 40, 1.2);
      if (this.confettiLeft === 2) this.particles.emit('golden', wxw, wyw - 40);
    }
  }

  private readonly posO = { x: 0, y: 0 };
  private readonly posFn = (e: Entity) => this.interp.posInto(e, this.alpha, this.posO);
  private readonly avatarFn = (p: Player) => this.entities.avatarTexture(p, this.ctx!);

  private animateFloats(): void {
    for (const f of this.floats) {
      if (!f.live) continue;
      const age = this.vt - f.at;
      const pop = easeOutBack(age / 0.28);
      if (!f.pid) {
        const k = age / (f.big ? 1.3 : 1.05);
        if (k >= 1) {
          f.t.visible = false;
          f.live = false;
          continue;
        }
        f.t.position.set(f.x, f.y - easeOutCubic(k) * 70 * this.hudScale);
        f.t.scale.set(pop);
        f.t.alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
        continue;
      }
      // big score: pop, hang, then fly into the player's HUD chip and bump it
      const rise = easeOutCubic(age / 0.45) * 50 * this.hudScale;
      const q = (age - 0.75) / 0.45;
      if (q < 0) {
        f.t.position.set(f.x, f.y - rise);
        f.t.scale.set(pop * 1.15);
        continue;
      }
      const to = this.tmpC;
      if (!this.hud.chipCenter(f.pid, to) || q >= 1) {
        if (q >= 1) this.hud.bump(f.pid, this.vt);
        f.t.visible = false;
        f.live = false;
        continue;
      }
      to.x *= this.hudScale;
      to.y *= this.hudScale;
      const e = easeInOutSine(q);
      const x0 = f.x, y0 = f.y - 50 * this.hudScale;
      f.t.position.set(x0 + (to.x - x0) * e, y0 + (to.y - y0) * e - arch(q) * 80 * this.hudScale);
      f.t.scale.set(1.15 - 0.6 * e);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.started) return;
    this.app.ticker.stop();
    this.particles.destroy();
    this.entities.destroy();
    this.ambience.destroy();
    this.finaleGlow.destroy();
    this.flash.destroy();
    this.bake.destroy();
    this.hud.destroy();
    this.store.destroy();
    this.grad?.destroy();
    this.vignetteTex?.destroy(true);
    this.sweepTex?.destroy(true);
    this.nart?.destroy();
    this.app.destroy(true, { children: true });
  }
}
