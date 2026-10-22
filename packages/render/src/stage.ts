import { Application, Container, FillGradient, Graphics, Sprite, Texture, TilingSprite, type Text } from 'pixi.js';
import type { Entity, FxEvent, GameRuntime, Player } from '@cadabra/engine';
import type { Theme } from '@cadabra/spec';
import { DEFAULT_ART_URLS } from './assets';
import { EntityLayer, label, type FrameCtx } from './entities';
import { Hud } from './hud';
import { FxBudget, JuiceState, MAX_PARTICLES } from './juice';
import { ParticleSystem } from './particles';
import { prewarmSfx, setSfxSet, sfx } from './sfx';
import { AVATAR_ART, DEFAULT_SPRITES } from './sprites';
import { TextureStore } from './textures';
import { darken, hexToNum, lighten, mix, type Palette } from './theme';
import { SnapInterp } from './visual';

export type Snapshot = ReturnType<GameRuntime['snapshot']>;

export interface GameViewOpts {
  /** Internal render size; 1280x720 by default (960x540 if the device gate says so). */
  internalW: number;
  internalH: number;
  /** World size the snapshot coordinates live in (GameSpec.arena); defaults to the internal size. */
  arena?: { width: number; height: number };
  /** Draw timer, score chips and banner (default true). */
  hud?: boolean;
}

const SIM_DT = 1 / 60;
const PRELOAD_MS = 4000;
const SHAKE_PAD = 40;

const DEFAULT_PALETTE: Palette = { bg: '#14102b', primary: '#4cc9f0', accent: '#f72585', glow: '#ffd166', text: '#ffffff' };

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
  const gr = g.createRadialGradient(160, 90, 40, 160, 90, 200);
  gr.addColorStop(0, 'rgba(255,255,255,0)');
  gr.addColorStop(0.55, 'rgba(255,255,255,0.08)');
  gr.addColorStop(1, 'rgba(255,255,255,0.85)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 320, 180);
  return Texture.from(c);
}

interface Float {
  t: Text;
  at: number;
  x: number;
  y: number;
}

/**
 * Draws GameRuntime snapshots with PixiJS. Pixi's own ticker paints every display frame;
 * `render()` hands over the newest snapshot (+ fx) and the host loop's interpolation alpha.
 * Contract for the host loop: multiply real frame dt by `timeScale` before feeding the
 * fixed-step accumulator; that is how slow-mo works while the sim stays fixed-step.
 */
export class GameView {
  readonly ready: Promise<void>;
  private app = new Application();
  private W: number;
  private H: number;
  private arenaW: number;
  private arenaH: number;
  private showHud: boolean;
  private destroyed = false;
  private started = false;

  private store!: TextureStore;
  private budget = new FxBudget(MAX_PARTICLES);
  private juice = new JuiceState();
  private particles!: ParticleSystem;
  private entities!: EntityLayer;
  private hud!: Hud;

  private shaker = new Container();
  private world = new Container();
  private bg = new Container();
  private bgGrad = new Graphics();
  private floor?: TilingSprite | Sprite;
  private floorShade = new Graphics();
  private blobs: Sprite[] = [];
  private floats: Float[] = [];
  private floatLayer = new Container();
  private vignette!: Sprite;
  private finaleGlow!: Sprite;
  private flash!: Sprite;
  private vignetteTex?: Texture;
  private grad?: FillGradient;

  private palette: Palette = DEFAULT_PALETTE;
  private art: Record<string, string> = {};
  private defaults: Record<string, string> = DEFAULT_ART_URLS;
  private floorKey = '';

  private snap?: Snapshot;
  private alpha = 1;
  private interp = new SnapInterp();
  private scores = new Map<string, number>();
  private vt = 0;
  private fpsAvg = 60;

  constructor(canvasParent: HTMLElement, opts: GameViewOpts = { internalW: 1280, internalH: 720 }) {
    this.W = opts.internalW || 1280;
    this.H = opts.internalH || 720;
    this.arenaW = opts.arena?.width ?? this.W;
    this.arenaH = opts.arena?.height ?? this.H;
    this.showHud = opts.hud !== false;
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

    this.store = new TextureStore();
    this.particles = new ParticleSystem(this.store, this.budget);
    this.entities = new EntityLayer(this.store, this.particles, this.arenaW, this.arenaH);
    this.hud = new Hud(this.W, this.H);

    this.bg.addChild(this.bgGrad, this.floorShade);
    for (let i = 0; i < 3; i++) {
      const s = new Sprite(this.store.cell('glow'));
      s.anchor.set(0.5);
      s.blendMode = 'add';
      this.blobs.push(s);
      this.bg.addChild(s);
    }
    this.world.addChild(this.entities.floor, this.entities.bodies, this.particles.view, this.entities.overlay, this.floatLayer);
    this.shaker.addChild(this.bg, this.world);
    const vt = vignetteTexture();
    this.vignetteTex = vt;
    this.flash = new Sprite(Texture.WHITE);
    this.flash.width = this.W;
    this.flash.height = this.H;
    this.flash.visible = false;
    this.vignette = new Sprite(vt);
    this.vignette.tint = 0x000000;
    this.finaleGlow = new Sprite(vt);
    this.finaleGlow.blendMode = 'add';
    this.finaleGlow.alpha = 0;
    for (const v of [this.vignette, this.finaleGlow]) {
      v.width = this.W;
      v.height = this.H;
    }
    this.app.stage.addChild(this.shaker, this.vignette, this.finaleGlow, this.flash);
    if (this.showHud) this.app.stage.addChild(this.hud.root);
    this.layout();
    this.applyPalette();
    this.app.ticker.add(() => this.frame());
    this.started = true;
  }

  /** Arena (world) size of the current game; snapshot coordinates are in this space. */
  setArena(width: number, height: number): void {
    this.arenaW = width;
    this.arenaH = height;
    if (this.started) {
      this.entities.setArena(width, height);
      this.layout();
    }
  }

  private layout(): void {
    const k = Math.min(this.W / this.arenaW, this.H / this.arenaH);
    this.world.scale.set(k);
    this.world.position.set((this.W - this.arenaW * k) / 2, (this.H - this.arenaH * k) / 2);
    this.shaker.pivot.set(this.W / 2, this.H / 2);
    this.shaker.position.set(this.W / 2, this.H / 2);
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
    this.art = { ...art };
    setSfxSet(theme.sfxSet);
    prewarmSfx();
    // a new game: no view may keep showing the previous game's art before it is evicted
    this.entities.clear();
    this.entities.resetSources();
    this.hud.clear();
    this.interp.reset();
    this.snap = undefined;
    this.scores.clear();
    if (this.floor && this.floorKey.startsWith('art|')) this.dropFloor();
    this.store.beginTheme(Object.values(this.art));
    this.applyPalette();
    const jobs: Promise<unknown>[] = [];
    for (const url of Object.values(this.art)) jobs.push(this.store.load(url, undefined, true));
    const wanted = new Set<string>([
      ...Object.values(DEFAULT_SPRITES).slice(0, 8), 'bear-awake', 'rope-marker',
      ...AVATAR_ART,
      ...Object.keys(theme.sprites).map((k) => DEFAULT_SPRITES[k] ?? k),
    ]);
    for (const name of wanted) {
      const url = this.defaults[name];
      if (url) jobs.push(this.store.load(url));
    }
    jobs.push(this.store.useFxArt(this.defaults));
    jobs.push(this.loadFloor());
    await Promise.race([Promise.allSettled(jobs), new Promise((r) => setTimeout(r, PRELOAD_MS))]);
  }

  private async loadFloor(): Promise<void> {
    const { url, custom } = this.floorUrl();
    // keyed by URL: a new game with a new floor always swaps it in
    const key = url ? `${custom ? 'art' : 'pack'}|${url}` : '';
    if (!url || key === this.floorKey) return;
    const tex = await this.store.load(url, custom ? 1280 : 512, custom);
    // a later loadTheme may have asked for another floor meanwhile
    if (!tex || this.destroyed || this.floorUrl().url !== url) return;
    this.dropFloor();
    if (custom) {
      // full-bleed generated backdrop: cover the arena
      const s = new Sprite(tex);
      const k = Math.max((this.W + SHAKE_PAD * 2) / tex.width, (this.H + SHAKE_PAD * 2) / tex.height);
      s.scale.set(k);
      s.anchor.set(0.5);
      s.position.set(this.W / 2, this.H / 2);
      this.floor = s;
    } else {
      tex.source.addressMode = 'repeat';
      const t = new TilingSprite({ texture: tex, width: this.W + SHAKE_PAD * 2, height: this.H + SHAKE_PAD * 2 });
      t.position.set(-SHAKE_PAD, -SHAKE_PAD);
      t.tileScale.set(0.75);
      this.floor = t;
    }
    this.floorKey = key;
    this.bg.addChildAt(this.floor, 1);
    this.applyPalette();
  }

  /** Generated floor/background art, else the pack floor that suits the palette. */
  private floorUrl(): { url: string | undefined; custom: boolean } {
    const custom = this.art.floor ?? this.art.background;
    if (custom) return { url: custom, custom: true };
    const name = pickFloor(this.palette, this.defaults);
    return { url: name ? this.defaults[name] : undefined, custom: false };
  }

  private dropFloor(): void {
    this.floor?.destroy();
    this.floor = undefined;
    this.floorKey = '';
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
    // floors are toned into the palette so sprites always read on top
    if (this.floor) this.floor.tint = mix(0xffffff, lighten(bg, 0.2), 0.5);
    this.floorShade.clear();
    if (this.floor) this.floorShade.rect(-SHAKE_PAD, -SHAKE_PAD, this.W + SHAKE_PAD * 2, this.H + SHAKE_PAD * 2).fill({ color: darken(bg, 0.3), alpha: 0.52 });
    const cols = [hexToNum(p.primary), hexToNum(p.accent), hexToNum(p.glow)];
    this.blobs.forEach((b, i) => {
      b.tint = cols[i]!;
    });
    this.finaleGlow.tint = hexToNum(p.accent);
    this.particles.setPalette(p);
    this.hud.setPalette(p);
  }

  /**
   * Hand over the newest snapshot and the fx drained with it. `alpha` (0..1) is the host
   * loop's accumulator fraction: positions are lerped from the previous snapshot by it.
   * The fx 'banner' event is ignored on purpose: the banner is drawn from `snap.banner`.
   */
  render(snap: Snapshot, fx: FxEvent[], alpha = 1): void {
    if (this.destroyed) return;
    // hosts call snapshot() every frame (a new object each time): only a new sim time
    // rotates the interpolation pair, so frames without a step keep lerping smoothly
    if (this.interp.push(snap) && this.started) this.scoreJuice(snap);
    this.snap = snap;
    this.alpha = alpha;
    if (!this.started) return;
    for (const e of fx) this.onFx(e);
  }

  private onFx(e: FxEvent): void {
    switch (e.kind) {
      case 'particles': {
        const n = this.particles.emit(e.preset, e.x, e.y);
        if (e.preset === 'confetti' && n > 0) this.particles.emit('sparkle', e.x, e.y, 0.5);
        break;
      }
      case 'sfx':
        sfx(e.name);
        break;
      case 'banner':
        break;
      default:
        this.juice.apply(e);
    }
  }

  /** "+N" pops over avatars when scores go up. */
  private scoreJuice(snap: Snapshot): void {
    for (const p of snap.players) {
      const before = this.scores.get(p.id);
      this.scores.set(p.id, p.score);
      if (before === undefined || p.score === before) continue;
      const av = snap.entities.find((e) => e.kind === 'player' && e.owner === p.id);
      const d = p.score - before;
      const x = av?.x ?? this.arenaW / 2, y = (av?.y ?? this.arenaH / 2) - (av ? av.r * 3.2 : 0);
      this.spawnFloat(d > 0 ? `+${d}` : `${d}`, d > 0 ? hexToNum(this.palette.glow) : 0xff6b6b, x, y);
    }
  }

  private spawnFloat(text: string, color: number, x: number, y: number): void {
    let f = this.floats.find((o) => !o.t.visible);
    if (!f) {
      if (this.floats.length >= 12) f = this.floats.reduce((a, b) => (a.at < b.at ? a : b));
      else {
        f = { t: label('', 30, 0xffffff, { display: true }), at: 0, x: 0, y: 0 };
        this.floatLayer.addChild(f.t);
        this.floats.push(f);
      }
    }
    f.t.text = text;
    f.t.style.fill = color;
    f.t.visible = true;
    f.at = this.vt;
    f.x = x;
    f.y = y;
  }

  /** Slow-mo factor for the host loop's accumulator (1 = normal speed). */
  get timeScale(): number {
    return this.juice.timeScale;
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
    this.juice.tick(dt);
    const vdt = dt * this.juice.timeScale;
    this.vt += vdt;

    this.animateBackground();
    const snap = this.snap;
    if (snap) {
      const players = new Map<string, Player>();
      const index = new Map<string, number>();
      let leader: string | undefined;
      let best = 0, tie = false;
      snap.players.forEach((p, i) => {
        players.set(p.id, p);
        index.set(p.id, i);
        if (p.score > best) {
          best = p.score;
          leader = p.id;
          tie = false;
        } else if (p.score === best && best > 0) tie = true;
      });
      const ctx: FrameCtx = {
        palette: this.palette, art: this.art, defaults: this.defaults, players, playerIndex: index,
        time: snap.time - (1 - this.alpha) * SIM_DT, vt: this.vt, dt: vdt, degraded: this.budget.degraded,
      };
      if (leader && !tie) ctx.leader = leader;
      const a = this.alpha;
      const pos = (e: Entity) => this.interp.pos(e, a);
      this.entities.sync(snap.entities, pos, ctx);
      if (this.showHud) this.hud.update(snap.players, snap.remaining, snap.banner, this.vt, (p) => this.entities.avatarTexture(p, ctx));
      const finale = snap.remaining > 0 && snap.remaining <= 10;
      this.finaleGlow.alpha = finale ? 0.18 + 0.14 * Math.sin(this.vt * 6) : Math.max(0, this.finaleGlow.alpha - dt);
    }
    this.particles.update(vdt);
    this.animateFloats();

    const o = this.juice.shakeOffset(this.vt);
    this.shaker.position.set(this.W / 2 + o.x, this.H / 2 + o.y);
    this.shaker.rotation = o.rot;
    const fa = this.juice.flashAlpha;
    this.flash.visible = fa > 0.001;
    if (this.flash.visible) {
      this.flash.tint = this.juice.flashColor;
      this.flash.alpha = fa * 0.6;
    }
  }

  private animateBackground(): void {
    const t = this.vt;
    this.blobs.forEach((b, i) => {
      b.position.set(this.W * (0.25 + 0.5 * ((i * 0.37) % 1)) + Math.sin(t * 0.13 + i * 2) * 160, this.H * (0.3 + 0.4 * (i % 2)) + Math.cos(t * 0.11 + i) * 90);
      b.scale.set(9 + Math.sin(t * 0.2 + i) * 1.5);
      b.alpha = this.floor ? 0.07 : 0.14;
    });
    if (this.floor instanceof TilingSprite) this.floor.tilePosition.set(Math.sin(t * 0.05) * 20, t * 2);
  }

  private animateFloats(): void {
    for (const f of this.floats) {
      if (!f.t.visible) continue;
      const k = (this.vt - f.at) / 0.9;
      if (k >= 1) {
        f.t.visible = false;
        continue;
      }
      f.t.position.set(f.x, f.y - k * 60);
      f.t.scale.set(k < 0.2 ? 0.6 + 2.5 * k : 1);
      f.t.alpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.started) return;
    this.app.ticker.stop();
    this.particles.destroy();
    this.entities.destroy();
    this.hud.destroy();
    this.store.destroy();
    this.grad?.destroy();
    this.vignetteTex?.destroy(true);
    this.app.destroy(true, { children: true });
  }
}

