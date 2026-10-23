import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { Entity, Player } from '@cadabra/engine';
import { AvatarAnim, depthKey } from './anim';
import { arch, easeInBack, easeInOutSine, easeOutBack, easeOutCubic } from './ease';
import type { OneOpts, ParticleSystem } from './particles';
import { fallbackShape, resolveSprite, type SpriteSource } from './sprites';
import type { TextureStore } from './textures';
import type { ParticleTex } from './juice';
import { DISPLAY_FONT, TEAM_COLORS, UI_FONT, darken, hexToNum, lighten, playerColor, type Palette } from './theme';
import { avatarFx, guardVisual, ropeKnotX, secondsLeft, telegraphState } from './visual';
import { NEON, PROP_KEYS, blinkOpen, eyeLook, fuseLeft, fusePulseHz, neonKey, scrollPhase, type NeonArt, type NeonKey } from './neon';
import { LOOKS, type Look, type LookColors } from './looks';
import { isUrl } from './sprites';

export interface FrameCtx {
  palette: Palette;
  art: Record<string, string>;
  defaults: Record<string, string>;
  players: Map<string, Player>;
  playerIndex: Map<string, number>;
  leader?: string | undefined;
  /** Player a guard is chasing right now (their ring flashes red). */
  hunted?: string | undefined;
  /** Interpolated sim time (s). */
  time: number;
  /** Visual clock (s, slow-mo scaled, frozen during hit-stop) and its frame delta. */
  vt: number;
  dt: number;
  degraded: boolean;
}

interface View {
  id: number;
  kind: string;
  root: Container;
  body: Sprite;
  shadow: Sprite;
  floor: Container;
  over: Container;
  born: number;
  px: number;
  py: number;
  face: number;
  srcKey: string;
  tex?: Texture | undefined;
  swapAt: number;
  /** Frame stamp of the last sync that saw this entity. */
  seen: number;
  /** World y of the top of the view (popups go above it). */
  top: number;
  // kind extras
  g?: Graphics;
  og?: Graphics;
  name?: Container;
  crown?: Sprite;
  marks?: Sprite[];
  texts?: Text[];
  knot?: Sprite;
  // neon extras: eyes [whiteL, whiteR, pupilL, pupilR], ribbon trail, held core
  eyes?: Sprite[];
  rib?: Ribbon;
  held?: Sprite;
  // 8b extras
  anim?: AvatarAnim;
  glow?: Sprite;
  flashS?: Sprite;
  xfade?: Sprite;
  cone?: Sprite;
  fxs?: Sprite[];
  /** Noise rings (a loud carrier) / carry pips. */
  wave?: Sprite[];
  /** "!" over a player the guard is chasing. */
  alert?: Graphics;
  trailN: number;
  trailAt: number;
  flags: Record<string, unknown>;
  dieAt?: number | undefined;
  /** Pool key (kind, plus the neon art key: a spike view never comes back as a laser). */
  pk: string;
}

/** Short fading ribbon behind a neon player: a ring buffer of points drawn as beam segments. */
interface Ribbon {
  xs: Float32Array;
  ys: Float32Array;
  n: number;
  at: number;
  segs: Sprite[];
  color: number;
}
const RIB_N = 10;
/** Share of a neon player texture the body fills (squircle ~80 of 128 px). */
const BODY_FRAC = 0.625;
/** Neon name plates: max characters shown in play (the HUD chips carry full names). */
const PLATE_CHARS = 7;
const RIB_EVERY = 0.028;

interface Trail {
  s: Sprite;
  age: number;
  life: number;
  a0: number;
  owner: View | null;
}

const DIE_SEC = 0.24;
const ITEM_FLY_SEC = 0.34;
/** Pooled views kept per kind; extra ones are destroyed. */
const POOL_MAX = 64;
/** Afterimages: per dashing entity and in total. */
const TRAIL_PER = 4;
const TRAIL_MAX = 32;
const TRAIL_EVERY = 0.045;
/** Soft glow sprites drawn per frame at most (halved when degraded). */
const GLOW_MAX = 40;
const BANNERS = ['banner-red', 'banner-blue'] as const;
/** Direction of travel drawn in directional pack art (rad, screen space). */
const ART_HEADING: Record<string, number> = { fireball: (3 * Math.PI) / 4 };
const POP_SEC = 0.36;
/**
 * Readability on a TV (task F §2): characters, guards, hazards and items are drawn this much
 * bigger than their hitboxes' old look. Hitboxes are the engine's; only the art grows.
 */
export const AVATAR_SCALE = 1.75;
export const GUARD_SCALE = 1.7;
export const HAZARD_SCALE = 1.6;
export const ITEM_SCALE = 1.45;
/** Text is rasterised at this resolution (the world is scaled up on a 1080p canvas). */
let textRes = 1;
export function setTextResolution(r: number): void {
  textRes = Math.max(1, Math.min(2, r));
}
const TAU = Math.PI * 2;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** zIndex bands below the y-sorted bodies. */
const Z_PAD = -1e11;
const Z_ZONE = -1e12;
/**
 * Depth sort without a per-frame rebuild: setting `zIndex` marks the whole render group's
 * structure dirty (Pixi rebuilds every draw instruction), so views only record their depth key
 * here and `EntityLayer.resort` writes zIndex only on frames where the order actually changed.
 */
type Depth = Container & { dk?: number };
/** 6 px of y in `depthKey` units (y * 16 * 8192). */
const DEPTH_SLACK = 6 * 16 * 8192;
const zset = (c: Container, z: number): void => {
  (c as Depth).dk = z;
};

export function label(text: string, size: number, color: number, opts: { display?: boolean; weight?: string; stroke?: number } = {}): Text {
  const t = new Text({
    text,
    style: {
      fontFamily: opts.display ? DISPLAY_FONT : UI_FONT,
      fontSize: size,
      fontWeight: (opts.weight ?? '800') as '800',
      fill: color,
      stroke: { color: 0x0b0b18, width: opts.stroke ?? Math.max(3, Math.round(size / 6)), join: 'round' },
      dropShadow: { color: 0x000000, alpha: 0.45, blur: 4, distance: 2, angle: Math.PI / 2 },
      align: 'center',
    },
    resolution: textRes,
  });
  t.anchor.set(0.5);
  return t;
}

/** Sized, depth-sorted, procedurally animated sprites + floor decals + overlays per entity. */
export class EntityLayer {
  readonly floor = new Container();
  /** Additive soft glows (one batch: same atlas, same blend). */
  readonly glows = new Container();
  /** Dash afterimages, under the bodies. */
  readonly trails = new Container();
  readonly bodies = new Container();
  readonly overlay = new Container();
  private views = new Map<number, View>();
  private dying: View[] = [];
  private pool = new Map<string, View[]>();
  /** Views built vs. taken from a pool (debug overlay / tests). */
  readonly stats = { created: 0, reused: 0 };
  private sources = new Map<string, SpriteSource>();
  private lanes = new Graphics();
  private laneKey = '';
  private flag?: Sprite;
  private quiz?: PanelView;
  /** Floor tiles (crumbling arenas): one Graphics for all, redrawn only when the set changes. */
  private tileG = new Graphics();
  private tileWarnG = new Graphics();
  private tileFallG = new Graphics();
  private tileKey = '';
  private tileFallAt = -9;
  private tileList: Entity[] = [];
  private frameNo = 0;
  private trailLive: Trail[] = [];
  private trailFree: Trail[] = [];
  /** Scratch particle options (one object, refilled per puff). */
  private po: OneOpts = {};
  private glowN = 0;
  private glowCap = GLOW_MAX;
  /** Absorbs glow writes beyond the cap (never on stage). */
  private noGlow = new Sprite();
  private flagSrc?: SpriteSource | undefined;
  private bannerSrc: (SpriteSource | undefined)[] = [undefined, undefined];

  /** Neon tiles: one pooled sprite per tile (paint tint changes are a tint write, not a redraw). */
  private tileS = new Map<number, Sprite>();
  private tileFree: Sprite[] = [];
  private tileDying: { s: Sprite; at: number }[] = [];
  private tileLayer = new Container();
  private finishS: Sprite[] = [];
  private readonly look = { x: 0, y: 0 };
  /** Neon: minimum body diameter in world px (the stage sets it from the screen scale). */
  minBody = 0;
  /** Neon avatar views with a plate this frame (de-overlap pass; reused, no allocation). */
  private plated: View[] = [];

  /** `neon` (task N1): procedural neon sprite set instead of the art pack. */
  constructor(private readonly store: TextureStore, private readonly particles: ParticleSystem, private arenaW: number, private arenaH: number, private readonly nx?: NeonArt) {
    this.bodies.sortableChildren = true;
    this.floor.addChild(this.lanes, this.tileFallG, this.tileG, this.tileWarnG, this.tileLayer);
    if (nx) this.trails.blendMode = 'add';
  }

  /** The current look (neon when the art pack draws). */
  private get L(): Look {
    return this.nx ? this.nx.L : LOOKS.neon;
  }

  /** Look colours (danger red, gold, ink, ...). */
  private get C(): LookColors {
    return this.nx ? this.nx.L.c : NEON;
  }

  /** Blend mode for glows, ribbons and light effects in the current look. */
  private get addMode(): 'add' | 'normal' {
    return this.L.additive ? 'add' : 'normal';
  }

  /** The stage switched looks: re-blend the shared layers, rebuild pooled views next frame. */
  applyLook(): void {
    const L = this.L;
    this.trails.blendMode = this.addMode;
    // light / pixel looks have no glow halos: soft shadows (toybox) or nothing (retro)
    this.glows.visible = L.additive;
    this.clear();
    for (const list of this.pool.values()) for (const v of list) {
      v.root.destroy({ children: true });
      v.floor.destroy({ children: true });
      v.over.destroy({ children: true });
      v.glow?.destroy();
      if (v.rib) for (const sp of v.rib.segs) sp.destroy();
    }
    this.pool.clear();
    for (const sp of this.finishS) sp.destroy();
    this.finishS.length = 0;
    for (const sp of this.tileFree) sp.destroy();
    this.tileFree.length = 0;
    this.propFx.length = 0;
  }

  /** Player colour: neon players / teams in the neon look, else the palette set. */
  private colorOf(team: 0 | 1 | undefined, idx: number, c: FrameCtx): number {
    if (this.nx) return team !== undefined ? this.L.teams[team] : this.L.players[idx % this.L.players.length]!;
    return team !== undefined ? TEAM_COLORS[team] : playerColor(idx, c.palette);
  }

  /** Neon texture for an entity's sprite key (falls back by entity kind). */
  private neonTex(e: Entity, kind: string, color: number): Texture {
    return this.nx!.get(neonKey(e.sprite, kind), color);
  }

  setArena(w: number, h: number): void {
    this.arenaW = w;
    this.arenaH = h;
    this.laneKey = '';
  }

  /** Forget resolved sprites (new theme / art arrived). */
  resetSources(): void {
    this.sources.clear();
    this.flagSrc = undefined;
    this.bannerSrc[0] = this.bannerSrc[1] = undefined;
  }

  /** Live dash afterimages (debug / tests). */
  get trailCount(): number {
    return this.trailLive.length;
  }

  /** Visible stun stars over an entity (tests). */
  starsOf(id: number): number {
    const v = this.views.get(id);
    let n = 0;
    if (v?.fxs) for (const s of v.fxs) if (s.visible) n++;
    return n;
  }

  /** Happy hop for the avatar entity `id` (it scored). */
  cheer(id: number): void {
    this.views.get(id)?.anim?.cheer();
  }

  /** Where a popup over entity `id` should start (world coords); false if unknown. */
  headOf(id: number, out: { x: number; y: number }): boolean {
    const v = this.views.get(id);
    if (!v) return false;
    out.x = v.px;
    out.y = v.top;
    return true;
  }

  private source(key: string, c: FrameCtx, kind: string, variant?: 'awake', guardKind?: string, avatar?: string): SpriteSource {
    const k = `${key}|${kind}|${variant ?? ''}|${guardKind ?? ''}|${avatar ?? ''}`;
    let s = this.sources.get(k);
    if (!s) {
      const o: Parameters<typeof resolveSprite>[1] = { art: c.art, defaults: c.defaults, palette: c.palette, kind };
      if (variant) o.variant = variant;
      if (guardKind) o.guardKind = guardKind;
      if (avatar !== undefined) o.avatar = avatar;
      s = resolveSprite(key, o);
      this.sources.set(k, s);
    }
    return s;
  }

  private texFor(v: View, src: SpriteSource, c: FrameCtx, kind: string): Texture {
    const fb = src.type === 'shape' ? src : (fallbackShape(kind, c.palette) as SpriteSource & { type: 'shape' });
    const t = this.store.get(src, fb as SpriteSource & { type: 'shape' });
    if (t !== v.tex) {
      // art arriving mid-round pops in instead of blinking
      if (v.tex) {
        v.swapAt = c.vt;
        v.flags.prevTex = v.tex;
      }
      v.tex = t;
      v.body.texture = t;
    }
    return t;
  }

  /** Texture for HUD chips (same cache as the avatars on the field). */
  avatarTexture(p: Player, c: FrameCtx): Texture {
    if (this.nx) return this.neonFace(p, c).tex;
    const src = this.source(`avatar:${p.id}`, c, 'player', undefined, undefined, p.avatar);
    return this.store.get(src, fallbackShape('player', c.palette) as SpriteSource & { type: 'shape' });
  }

  /**
   * Neon look of a player: a selfie (url avatar) becomes a ring portrait in the player's colour
   * once it has loaded; everyone else is the glowing body (eyes are separate sprites).
   */
  private neonFace(p: Player, c: FrameCtx): { tex: Texture; portrait: boolean } {
    const color = this.colorOf(p.team, c.playerIndex.get(p.id) ?? 0, c);
    if (p.avatar && isUrl(p.avatar)) {
      const src = this.source(`avatar:${p.id}`, c, 'player', undefined, undefined, p.avatar);
      if (src.type === 'url') {
        const raw = this.store.loaded(src.url);
        if (!raw) void this.store.load(src.url, undefined, true);
        const t = raw ? this.nx!.portrait(src.url, raw, color) : undefined;
        if (t) return { tex: t, portrait: true };
      }
    }
    return { tex: this.nx!.get('player', color), portrait: false };
  }

  private make(e: Entity, c: FrameCtx): View {
    const root = new Container();
    const shadow = new Sprite(this.store.cell('soft'));
    shadow.anchor.set(0.5);
    shadow.tint = 0x000000;
    shadow.alpha = 0.35;
    const body = new Sprite();
    body.anchor.set(0.5);
    root.addChild(body);
    const floor = new Container();
    floor.addChild(shadow);
    const over = new Container();
    this.bodies.addChild(root);
    this.floor.addChild(floor);
    this.overlay.addChild(over);
    return {
      id: e.id, kind: e.kind, root, body, shadow, floor, over, born: c.vt, px: e.x, py: e.y, face: 1, srcKey: '', swapAt: -9,
      seen: 0, top: e.y, trailN: 0, trailAt: -9, flags: {}, pk: this.poolKey(e),
    };
  }

  /** One soft particle from the scratch options (no per-call object). */
  private puff(tex: ParticleTex, x: number, y: number, life: number, s0: number, tint: number, add: boolean, a0: number, vx = 0, vy = 0, grow = 0, aspect = 1, spin = 0): void {
    const o = this.po;
    o.life = life;
    o.s0 = s0;
    o.tint = tint;
    o.add = add;
    o.a0 = a0;
    o.vx = vx;
    o.vy = vy;
    o.grow = grow;
    o.aspect = aspect;
    o.spin = spin;
    o.rot = 0;
    o.gravity = 0;
    o.drag = 0;
    this.particles.one(tex, x, y, o);
  }

  private glowOf(v: View): Sprite {
    if (++this.glowN > this.glowCap) {
      if (v.glow) v.glow.visible = false;
      return this.noGlow;
    }
    if (!v.glow) {
      v.glow = new Sprite(this.store.cell('glow'));
      v.glow.anchor.set(0.5);
      v.glow.blendMode = 'add';
      this.glows.addChild(v.glow);
    }
    v.glow.visible = true;
    return v.glow;
  }

  sync(entities: Entity[], pos: (e: Entity) => { x: number; y: number }, c: FrameCtx): void {
    const frame = ++this.frameNo;
    this.frameEnts = entities;
    this.plated.length = 0;
    this.glowN = 0;
    this.glowCap = c.degraded ? GLOW_MAX / 2 : GLOW_MAX;
    let quiz: Entity | undefined;
    const tiles = this.tileList;
    tiles.length = 0;
    for (const e of entities) {
      if (e.kind === 'quiz' || e.kind === 'board') {
        quiz = e;
        continue;
      }
      if (e.kind === 'tile') {
        tiles.push(e);
        continue;
      }
      let v = this.views.get(e.id);
      if (!v) {
        v = this.acquire(e, c);
        this.views.set(e.id, v);
      }
      v.seen = frame;
      const p = pos(e);
      this.update(v, e, p.x, p.y, c);
      v.px = p.x;
      v.py = p.y;
    }
    for (const [id, v] of this.views) {
      if (v.seen === frame) continue;
      this.views.delete(id);
      v.dieAt = c.vt;
      this.onDeath(v, c);
      this.dying.push(v);
    }
    if (this.nx) this.spreadPlates();
    this.animateDying(c);
    this.animateTrails(c);
    this.syncLanes(entities, c);
    this.syncPanel(quiz, c);
    this.syncTiles(tiles, c);
    this.resort();
  }

  /**
   * Re-apply depth keys as zIndex only when the bodies are out of order (see `zset`) by more
   * than a few px of depth: two views sliding past each other swap once, not every frame.
   */
  private resort(): void {
    const ch = this.bodies.children as Depth[];
    let prev = -Infinity;
    for (const k of ch) {
      if (!k.visible) continue; // pooled views do not draw
      const d = k.dk ?? 0;
      if (prev > d + DEPTH_SLACK) {
        for (const c of ch) c.zIndex = c.dk ?? 0;
        return;
      }
      prev = d;
    }
  }

  /**
   * Ice floes over lava: every 'tile' entity is drawn into one Graphics (redrawn only when a
   * tile starts crumbling or falls). Crumbling tiles flash red; fallen ones sink and fade.
   */
  private syncTiles(tiles: Entity[], c: FrameCtx): void {
    if (this.nx) return this.neonTiles(tiles, c);
    let crumbling = 0;
    for (const t of tiles) if (t.props.crumbling === true) crumbling++;
    const key = tiles.length === 0 ? '' : `${tiles.length}|${crumbling}|${tiles[0]!.id}`;
    if (key !== this.tileKey) {
      const before = this.tileKey;
      this.tileKey = key;
      // the tiles that just fell: draw them once more into the sinking layer
      if (before && tiles.length < Number(before.split('|')[0])) {
        const live = new Set(tiles.map((t) => t.id));
        const fg = this.tileFallG.clear();
        for (const t of this.lastTiles) if (!live.has(t.id)) this.drawTile(fg, t, 0x7fb8d8, 0x3d6e8c);
        this.tileFallAt = c.vt;
      }
      this.lastTiles = tiles.slice();
      const g = this.tileG.clear(), w = this.tileWarnG.clear();
      for (const t of tiles) {
        if (t.props.crumbling === true) this.drawTile(w, t, 0xffd6c2, 0xc0542c);
        else this.drawTile(g, t, 0xd9f3ff, 0x6fb3d6);
      }
    }
    this.tileG.visible = this.tileWarnG.visible = tiles.length > 0;
    if (crumbling > 0) {
      // warning flicker, faster as it nears the fall
      this.tileWarnG.alpha = 0.65 + 0.35 * Math.sin(c.vt * 16);
      this.tileWarnG.position.set(Math.sin(c.vt * 41) * 2, Math.cos(c.vt * 37) * 1.5);
    } else this.tileWarnG.position.set(0, 0);
    const k = (c.vt - this.tileFallAt) / 0.5;
    this.tileFallG.visible = k < 1;
    if (k < 1) {
      this.tileFallG.alpha = 1 - k;
      this.tileFallG.position.set(0, k * 18);
      this.tileFallG.tint = 0xff8a50;
    }
  }

  private lastTiles: Entity[] = [];
  private tileSeen = new Set<number>();

  /** Paint colour of a tile: team, owner's colour, or none (unpainted). */
  private paintOf(t: Entity, c: FrameCtx): number | undefined {
    const p = t.props;
    const team = typeof p.paintTeam === 'number' ? p.paintTeam : typeof p.team === 'number' ? p.team : t.team;
    if (team === 0 || team === 1) return this.L.teams[team];
    const owner = typeof p.paintedBy === 'string' && p.paintedBy ? p.paintedBy : typeof p.owner === 'string' && p.owner ? p.owner : t.owner;
    if (owner) {
      const pl = c.players.get(owner);
      return this.colorOf(pl?.team, c.playerIndex.get(owner) ?? 0, c);
    }
    return undefined;
  }

  /**
   * Neon floor tiles: one pooled sprite per tile, white art tinted per frame (painted tiles take
   * their team colour, crumbling ones flicker red, fallen ones shrink and fade into the void).
   */
  private neonTiles(tiles: Entity[], c: FrameCtx): void {
    const tex = this.nx!.get('tile', 0xffffff);
    const seen = this.tileSeen;
    seen.clear();
    const L = this.L;
    const dim = L.id === 'toybox' ? lighten(L.c.cyan, 0.72) : L.id === 'retro' ? 0x4a4466 : L.id === 'cosmos' ? 0x5b7fd6 : darken(hexToNum(c.palette.primary), 0.35);
    const solid = L.id === 'toybox' || L.id === 'retro';
    for (const t of tiles) {
      seen.add(t.id);
      let s = this.tileS.get(t.id);
      if (!s) {
        s = this.tileFree.pop() ?? new Sprite(tex);
        s.texture = tex;
        s.anchor.set(0.5);
        s.visible = true;
        s.rotation = 0;
        this.tileLayer.addChild(s);
        this.tileS.set(t.id, s);
      }
      const hw = num(t.props.hw, t.r), hh = num(t.props.hh, t.r);
      s.position.set(t.x, t.y);
      s.scale.set((hw * 2) / 118, (hh * 2) / 118);
      const paint = this.paintOf(t, c);
      const crumb = t.props.crumbling === true || num(t.props.crumbling) > 0;
      if (crumb) {
        const on = Math.sin(c.vt * 16) > 0;
        s.tint = on ? this.C.red : (paint ?? dim);
        s.alpha = 0.95;
        s.position.set(t.x + Math.sin(c.vt * 41 + t.id) * 2, t.y + Math.cos(c.vt * 37 + t.id) * 1.5);
      } else if (paint !== undefined) {
        // painted floor stays a step below the players so same-colour bodies still pop
        // painted floor sits a step darker (retro) / lighter (toybox) than the same-colour players
        s.tint = L.id === 'retro' ? darken(paint, 0.35) : solid ? lighten(paint, 0.12) : paint;
        s.alpha = solid ? 1 : 0.6;
      } else {
        s.tint = dim;
        s.alpha = solid ? 1 : L.id === 'cosmos' ? 0.85 : 0.45;
      }
    }
    for (const [id, s] of this.tileS) {
      if (seen.has(id)) continue;
      this.tileS.delete(id);
      this.tileDying.push({ s, at: c.vt });
    }
    for (let i = this.tileDying.length - 1; i >= 0; i--) {
      const d = this.tileDying[i]!;
      const k = (c.vt - d.at) / 0.45;
      if (k >= 1) {
        d.s.visible = false;
        this.tileFree.push(d.s);
        this.tileDying.splice(i, 1);
        continue;
      }
      d.s.tint = this.C.red;
      d.s.alpha = 1 - k;
      d.s.scale.set(d.s.scale.x * (1 - 0.04), d.s.scale.y * (1 - 0.04));
      d.s.rotation += c.dt * 2;
    }
  }

  private drawTile(g: Graphics, t: Entity, top: number, edge: number): void {
    const hw = num(t.props.hw, t.r), hh = num(t.props.hh, t.r);
    const gap = Math.min(hw, hh) * 0.07, x = t.x - hw + gap, y = t.y - hh + gap, w = hw * 2 - gap * 2, h = hh * 2 - gap * 2;
    const rr = Math.min(w, h) * 0.16;
    g.roundRect(x, y + 6, w, h, rr).fill({ color: edge });
    g.roundRect(x, y, w, h - 4, rr).fill({ color: top });
    g.roundRect(x + w * 0.08, y + h * 0.08, w * 0.5, h * 0.16, rr * 0.6).fill({ color: 0xffffff, alpha: 0.45 });
    g.moveTo(x + w * 0.62, y + h * 0.55).lineTo(x + w * 0.78, y + h * 0.7).lineTo(x + w * 0.74, y + h * 0.86).stroke({ width: 2, color: edge, alpha: 0.6 });
  }

  private onDeath(v: View, c: FrameCtx): void {
    if (v.kind === 'player' || v.kind === 'runner') {
      this.particles.emit(this.nx ? this.sparkPreset : 'hit', v.px, v.py, this.nx ? 0.4 : 0.6);
    } else if (this.nx && PROP_KEYS.has(String(v.flags.propKey ?? ''))) {
      this.propDeath(v, c);
    } else if (v.kind === 'item') {
      // collected: fly to the nearest avatar, then burst there
      let best: View | undefined, bd = 160 * 160;
      for (const o of this.views.values()) {
        if (o.kind !== 'player' && o.kind !== 'runner') continue;
        const d = (o.px - v.px) ** 2 + (o.py - v.py) ** 2;
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      v.flags.flyTo = best ? best.id : -1;
      v.flags.fx0 = v.root.x;
      v.flags.fy0 = v.root.y;
      if (!best) this.puff('ring', v.px, v.py, 0.3, 0.4, hexToNum(c.palette.glow), true, 1, 0, 0, 1.6);
    }
  }

  private animateDying(c: FrameCtx): void {
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i]!;
      const flying = v.kind === 'item' && num(v.flags.flyTo, -1) >= 0;
      const dur = flying ? ITEM_FLY_SEC : DIE_SEC;
      const k = (c.vt - v.dieAt!) / dur;
      if (k >= 1) {
        if (flying) {
          const t = this.views.get(num(v.flags.flyTo));
          const x = t ? t.px : v.root.x, y = t ? t.top + 30 : v.root.y;
          this.puff('ring', x, y, 0.3, 0.35, hexToNum(c.palette.glow), true, 0.9, 0, 0, 1.8);
        }
        this.dying.splice(i, 1);
        this.release(v);
        continue;
      }
      if (flying) {
        const t = this.views.get(num(v.flags.flyTo));
        const x0 = num(v.flags.fx0), y0 = num(v.flags.fy0);
        const x1 = t ? t.px : x0, y1 = t ? t.top + 30 : y0;
        const p = easeInOutSine(k);
        v.root.position.set(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p - arch(k) * 60);
        v.root.scale.set(1 + 0.3 * arch(k) - 0.5 * k);
        v.root.rotation += c.dt * 14;
        v.root.alpha = 1;
        v.floor.alpha = v.over.alpha = 1 - k;
        if (v.glow) v.glow.alpha *= 0.85;
        continue;
      }
      // anticipation then shrink away
      v.root.scale.set(Math.max(0, 1 - easeInBack(k)));
      v.root.alpha = 1 - k * k;
      v.floor.alpha = v.over.alpha = 1 - k;
      if (v.glow) v.glow.alpha *= 0.8;
      if (v.kind === 'player') v.root.rotation += c.dt * 12;
    }
  }

  /** A view for `e`: from the kind's pool when one is free, else built. */
  private poolKey(e: Entity): string {
    return this.nx ? `${e.kind}|${neonKey(e.sprite, e.kind)}` : e.kind;
  }

  private acquire(e: Entity, c: FrameCtx): View {
    const v = this.pool.get(this.poolKey(e))?.pop();
    if (!v) {
      this.stats.created++;
      return this.make(e, c);
    }
    this.stats.reused++;
    v.id = e.id;
    v.born = c.vt;
    v.px = e.x;
    v.py = e.y;
    v.top = e.y;
    v.face = 1;
    v.srcKey = '';
    v.tex = undefined;
    v.swapAt = -9;
    v.flags = {};
    v.dieAt = undefined;
    v.trailN = 0;
    v.trailAt = -9;
    for (const o of [v.root, v.floor, v.over]) {
      o.visible = true;
      o.alpha = 1;
    }
    v.root.scale.set(1);
    v.root.rotation = 0;
    v.body.alpha = 1;
    v.body.tint = 0xffffff;
    v.body.rotation = 0;
    // per-kind extras: updaters switch on what they use each frame
    v.anim?.reset(e.x, e.y);
    if (v.rib) {
      v.rib.xs.fill(e.x);
      v.rib.ys.fill(e.y);
    }
    v.body.visible = true;
    v.body.position.set(0, 0);
    this.hideExtras(v);
    v.g?.clear();
    v.og?.clear();
    return v;
  }

  private hideExtras(v: View): void {
    if (v.marks && v.kind !== 'rope') for (const m of v.marks) m.visible = false;
    if (v.crown) v.crown.visible = false;
    if (v.glow) v.glow.visible = false;
    if (v.flashS) v.flashS.visible = false;
    if (v.xfade) v.xfade.visible = false;
    if (v.cone) v.cone.visible = false;
    if (v.fxs) for (const s of v.fxs) s.visible = false;
    if (v.wave) for (const s of v.wave) s.visible = false;
    if (v.alert) v.alert.visible = false;
    if (v.eyes) for (const s of v.eyes) s.visible = false;
    if (v.rib) for (const s of v.rib.segs) s.visible = false;
    if (v.held) v.held.visible = false;
  }

  /** Park a finished view in its kind's pool (hidden), or destroy it if the pool is full. */
  private release(v: View): void {
    const list = this.pool.get(v.pk) ?? [];
    if (list.length >= POOL_MAX) {
      v.root.destroy({ children: true });
      v.floor.destroy({ children: true });
      v.over.destroy({ children: true });
      v.glow?.destroy();
      if (v.rib) for (const s of v.rib.segs) s.destroy();
      return;
    }
    v.root.visible = v.floor.visible = v.over.visible = false;
    this.hideExtras(v);
    list.push(v);
    this.pool.set(v.pk, list);
  }

  /** Root container of the live view for an entity id (debug / tests). */
  rootOf(id: number): Container | undefined {
    return this.views.get(id)?.root;
  }

  /** Drop every live view into the pools (new game / theme). */
  clear(): void {
    for (const v of this.views.values()) this.release(v);
    for (const v of this.dying) this.release(v);
    this.views.clear();
    this.dying = [];
    for (const t of this.trailLive) {
      t.s.visible = false;
      t.owner = null;
      this.trailFree.push(t);
    }
    this.trailLive.length = 0;
    this.laneKey = '';
    this.lanes.clear();
    this.tileKey = '';
    this.tileG.clear();
    this.tileWarnG.clear();
    this.tileFallG.clear();
    for (const s of this.tileS.values()) {
      s.visible = false;
      this.tileFree.push(s);
    }
    this.tileS.clear();
    for (const d of this.tileDying) {
      d.s.visible = false;
      this.tileFree.push(d.s);
    }
    this.tileDying.length = 0;
    for (const s of this.finishS) s.visible = false;
    if (this.flag) this.flag.visible = false;
    this.quiz?.destroy();
    this.quiz = undefined;
  }

  private place(v: View, x: number, y: number, size: number, tex: Texture, anchorY = 0.5): number {
    const k = size / Math.max(1, tex.width, tex.height);
    v.root.position.set(x, y);
    zset(v.root, depthKey(y, v.id));
    v.body.anchor.set(0.5, anchorY);
    v.body.scale.set(k * v.face, k);
    return k;
  }

  private popScale(v: View, c: FrameCtx): number {
    const born = easeOutBack((c.vt - v.born) / POP_SEC);
    const swap = c.vt - v.swapAt < 0.25 ? 1 + 0.25 * Math.sin(((c.vt - v.swapAt) / 0.25) * Math.PI) : 1;
    return born * swap;
  }

  private shadowAt(v: View, x: number, y: number, w: number, h = w * 0.38, a = 0.35): void {
    v.shadow.visible = true;
    v.shadow.position.set(x, y);
    v.shadow.width = w;
    v.shadow.height = h;
    v.shadow.alpha = a;
  }

  private update(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    switch (e.kind) {
      case 'player':
      case 'runner':
        return this.avatar(v, e, x, y, c);
      case 'hazard':
        if (this.nx) {
          const hk = neonKey(e.sprite, 'hazard');
          if (hk === 'laser' || hk === 'boost' || hk === 'hole') return this.neonGeneric(v, e, x, y, c);
        }
        return this.hazard(v, e, x, y, c);
      case 'guard':
        return this.guard(v, e, x, y, c);
      case 'safe-zone':
        return this.safeZone(v, e, x, y, c);
      case 'rope':
        return this.rope(v, e, x, y, c);
      case 'goal':
      case 'base':
        return this.nx ? this.neonGoal(v, e, x, y, c) : this.goal(v, e, x, y, c);
      case 'item':
      case 'core':
        return this.item(v, e, x, y, c);
      default:
        return this.nx ? this.neonGeneric(v, e, x, y, c) : this.generic(v, e, x, y, c);
    }
  }

  // ---------- players ----------

  private avatar(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const owner = e.owner ?? '';
    const pl = c.players.get(owner);
    const idx = c.playerIndex.get(owner) ?? 0;
    const color = this.colorOf(e.team, idx, c);
    const nface = this.nx ? (pl ? this.neonFace(pl, c) : { tex: this.nx.get('player', color), portrait: false }) : undefined;
    let tex: Texture;
    if (nface) {
      tex = nface.tex;
      if (tex !== v.tex) {
        if (v.tex) v.swapAt = c.vt;
        v.tex = tex;
        v.body.texture = tex;
      }
    } else tex = this.texFor(v, this.source(e.sprite, c, 'player', undefined, undefined, pl?.avatar), c, 'player');
    const fx = avatarFx(e.props, c.time);
    const dashing = e.props.dashing === true;
    const tiptoe = e.props.tiptoe === true;

    let anim = v.anim;
    if (!anim) {
      anim = v.anim = new AvatarAnim(e.id);
      anim.reset(x, y);
    }
    // a fresh stun / invulnerability window = got hit
    const inv = num(e.props.invulnUntil, -1), stun = num(e.props.stunUntil, -1);
    if (v.flags.inv !== undefined && ((inv > num(v.flags.inv, -1) && inv > c.time) || (stun > num(v.flags.stun, -1) && stun > c.time))) {
      anim.hit(-anim.vx, -anim.vy);
      if (!c.degraded) this.particles.emit(this.nx ? this.sparkPreset : 'burst', x, y - (this.nx ? 0 : e.r), this.nx ? 0.3 : 0.35);
    }
    v.flags.inv = inv;
    v.flags.stun = stun;
    const prevMotion = anim.motion;
    anim.update(x, y, c.dt, c.vt, dashing);
    anim.pose(c.vt);
    v.face = anim.face;

    const jump = num(e.props.jump);
    const jumpHop = jump > 0 ? Math.sin(jump * Math.PI) * 34 * AVATAR_SCALE : 0;
    const N = !!this.nx;
    // neon is top-down: no walk hop (the body stays centred on its floor ring), squash only
    const hop = jumpHop + (N ? 0 : anim.hop * AVATAR_SCALE);
    // neon: the body is at least `minBody` world px across (cosmetic only: hitboxes are the engine's)
    const size = (N ? Math.max(e.r * 5, this.minBody / BODY_FRAC) : e.r * 3.6 * AVATAR_SCALE) * (e.kind === 'runner' ? 0.85 : 1);
    const pop = this.popScale(v, c);
    const bx = x + anim.ox * AVATAR_SCALE, by = y + anim.oy * AVATAR_SCALE;
    const anchorY = N ? 0.5 : 0.72;
    const outK = N && e.props.out === true ? Math.min(1, Math.max(0, (c.time - num(e.props.outAt, c.time)) / 0.6)) : 0;
    const k = this.place(v, bx, by - hop, size, tex, anchorY) * pop;
    if (N) {
      v.root.scale.set(1 - outK * 0.85);
      v.root.alpha = 1 - outK;
    }
    zset(v.root, depthKey(y, v.id));
    v.body.scale.set(k * v.face * anim.sx, k * anim.sy * (tiptoe ? 0.9 : 1));
    v.body.rotation = fx.wobble + (e.props.pulling === true ? (e.team === 0 ? -0.22 : 0.22) + Math.sin(c.vt * 9 + e.id) * 0.04 : anim.rot);
    v.body.alpha = fx.alpha * (tiptoe ? 0.82 : 1) * (e.kind === 'runner' && e.props.leg !== undefined ? 0.75 : 1);
    if (outK > 0) v.body.rotation += outK * 6;
    v.over.alpha = v.floor.alpha = 1 - outK;

    // white hit flash: additive copy of the body for two frames
    if (anim.flash || v.flashS?.visible) {
      if (!v.flashS) {
        v.flashS = new Sprite(tex);
        v.flashS.blendMode = 'add';
        v.root.addChild(v.flashS);
      }
      const f = v.flashS;
      f.visible = anim.flash;
      f.texture = tex;
      f.anchor.set(0.5, anchorY);
      f.scale.set(v.body.scale.x, v.body.scale.y);
      f.rotation = v.body.rotation;
    }

    // contact shadow shrinks and fades as the body leaves the floor
    const lift = Math.min(0.5, hop / (70 * AVATAR_SCALE));
    const R = e.r * AVATAR_SCALE;
    if (N && this.L.shadows) this.shadowAt(v, bx, y + size * 0.3, size * 0.78 * pop * (1 - outK), size * 0.26 * pop * (1 - outK), 0.32);
    else if (N) v.shadow.visible = false;
    else this.shadowAt(v, bx, y + e.r * 0.55, R * 2.2 * (1 - lift) * pop, R * 0.8 * (1 - lift) * pop, 0.45 * (1 - lift * 0.8));

    // team / player ring under the feet (neon: a thin glowing floor ring round the body)
    if (!v.g) {
      v.g = new Graphics();
      v.floor.addChild(v.g);
    }
    if (v.flags.ringColor !== color || (N && v.flags.ringSize !== size)) {
      v.flags.ringColor = color;
      v.flags.ringSize = size;
      const rr = e.r * AVATAR_SCALE;
      if (N) {
        const q = Math.max(e.r * 1.75, size * 0.36);
        const [fa, sa] = this.L.ring;
        if (this.L.pixel) v.g.clear().rect(-q, q * 0.55, q * 2, 3).fill({ color, alpha: sa });
        else v.g.clear().circle(0, 0, q).fill({ color, alpha: fa }).circle(0, 0, q).stroke({ width: 7, color, alpha: this.L.additive ? 0.18 : 0 }).circle(0, 0, q).stroke({ width: 2.5, color, alpha: sa });
      } else v.g.clear().ellipse(0, 0, rr * 1.25, rr * 0.5).fill({ color, alpha: 0.28 }).ellipse(0, 0, rr * 1.25, rr * 0.5).stroke({ width: 6, color, alpha: 0.95 });
    }
    v.g.position.set(bx, N ? y : y + e.r * 0.55);
    if (N) {
      this.neonEyes(v, e, nface!.portrait || !this.L.eyes, size, k, anim.vx, anim.vy, fx.stunned, c);
      if (this.L.ribbon) this.neonRibbon(v, x, y, size / 5, color, c);
      if (this.L.pixel) v.body.rotation = Math.round(v.body.rotation / (Math.PI / 4)) * (Math.PI / 4);
      this.neonHeld(v, e, bx, by - hop + size * 0.12, c);
    }
    const hunted = c.hunted !== undefined && c.hunted === owner;
    v.g.scale.set(pop * (hunted ? 1.15 + 0.12 * Math.sin(c.vt * 18) : 1));
    v.g.tint = hunted && Math.sin(c.vt * 18) > 0 ? 0xff2020 : 0xffffff;

    // soft backlight in the player's colour (reads on any floor); a big pulsing aura when boosted
    const boosted = num(e.props.boost, 1) > 1.001;
    const gl = this.glowOf(v);
    gl.position.set(bx, by - hop - (N ? 0 : size * 0.25));
    if (N && !boosted) {
      gl.tint = color;
      gl.scale.set(((size * 0.84) / 64) * pop);
      gl.alpha = 0.32 + (anim.motion === 'dash' ? 0.35 : 0);
    } else if (boosted) {
      gl.tint = hexToNum(c.palette.glow);
      gl.scale.set(((R * 4.4) / 64) * (1 + Math.sin(c.vt * 6) * 0.1) * pop);
      gl.alpha = 0.5;
    } else {
      gl.tint = color;
      gl.scale.set(((R * 3.4) / 64) * pop);
      gl.alpha = 0.22 + (anim.motion === 'dash' ? 0.25 : 0);
    }

    if (!c.degraded) {
      // (no footstep dust: particles are for meaningful moments only)
      // dash: a puff of dust on take-off, then afterimages
      if (N && anim.motion === 'dash' && prevMotion !== 'dash') {
        // neon take-off: a few sparks kicked out behind
        for (let i = 0; i < 4; i++) {
          const a = Math.atan2(-anim.vy, -anim.vx) + (Math.random() - 0.5) * 1.2, sp = 160 + Math.random() * 160;
          if (this.L.additive) this.puff('spark', bx, by, 0.3, 0.32, i % 2 ? 0xffffff : color, true, 1, Math.cos(a) * sp, Math.sin(a) * sp, -0.5, 1, 6);
          else this.puff(this.L.pixel ? 'px' : 'smoke', bx, by + size * 0.2, 0.35, this.L.pixel ? 0.12 : 0.3, this.L.pixel ? 0xfff1e8 : 0xffffff, false, 0.8, Math.cos(a) * sp * 0.4, Math.sin(a) * sp * 0.4, this.L.pixel ? 0 : 1.2);
        }
      } else if (anim.motion === 'dash' && prevMotion !== 'dash') {
        for (let i = 0; i < 2; i++) {
          this.puff('smoke', bx + (Math.random() - 0.5) * e.r, y + e.r * 0.4, 0.5, 0.3, 0xf0eadf, false, 0.55, -anim.vx * 0.2 + (Math.random() - 0.5) * 60, -20 - Math.random() * 30, 1.5);
        }
      }
      if (anim.motion === 'dash' && c.vt - v.trailAt >= TRAIL_EVERY && v.trailN < TRAIL_PER && c.dt > 0) {
        v.trailAt = c.vt;
        this.spawnTrail(v, color);
      }
      // race: speed lines behind fast runners
      if (e.props.mover === 'race' && anim.speed > 140 && Math.random() < c.dt * (8 + anim.speed / 12)) {
        this.puff('dot', bx - v.face * e.r * 1.4, by - size * 0.3 + (Math.random() - 0.5) * e.r * 1.8, 0.22, 0.9, 0xffffff, true, 0.45, -anim.vx * 0.35, 0, 0.4, 0.07);
      }
    }

    // stun: three stars orbiting the head
    if (fx.stunned || v.fxs) {
      if (!v.fxs) {
        v.fxs = [0, 1, 2].map(() => {
          const s = new Sprite(this.store.cell('star'));
          s.anchor.set(0.5);
          s.tint = 0xffe066;
          v.over.addChild(s);
          return s;
        });
      }
      const headY = by - hop - size * (N ? 0.42 : 0.66);
      const sr = e.r * AVATAR_SCALE;
      for (let i = 0; i < 3; i++) {
        const s = v.fxs[i]!;
        s.visible = fx.stunned;
        if (!fx.stunned) continue;
        const a = c.vt * 6 + (i * TAU) / 3;
        const depth = Math.sin(a);
        s.position.set(bx + Math.cos(a) * sr * 1.05, headY + depth * sr * 0.32);
        s.scale.set(0.45 * (0.8 + 0.2 * depth));
        s.alpha = 0.7 + 0.3 * depth;
        s.rotation = c.vt * 4 + i;
      }
    }

    // loud (carrying a lot / stomping): sound rings ripple out from the feet; carry pips over the head
    const loudness = e.props.loud === true ? 1 : num(e.props.loud);
    const loud = loudness > 0.15;
    const carry = Math.min(5, Math.max(0, Math.round(num(e.props.carry))));
    if (loud || carry > 0 || v.wave) {
      if (!v.wave) {
        v.wave = [];
        for (let i = 0; i < 7; i++) {
          const s = new Sprite(this.store.cell(i < 2 ? 'ring' : 'dot'));
          s.anchor.set(0.5);
          (i < 2 ? v.floor : v.over).addChild(s);
          v.wave.push(s);
        }
      }
      const R = e.r * AVATAR_SCALE;
      for (let i = 0; i < 2; i++) {
        const s = v.wave[i]!;
        s.visible = loud;
        if (!loud) continue;
        const ph = (c.vt * 1.6 + i * 0.5) % 1;
        s.position.set(bx, y + e.r * 0.55);
        s.scale.set(((R * (1.4 + ph * 2.2)) / 28) * 1, ((R * (0.55 + ph * 0.9)) / 28));
        s.alpha = (1 - ph) * (0.35 + 0.6 * Math.min(1, loudness));
        s.tint = loudness > 0.6 ? 0xff5a3c : 0xffc94d;
      }
      const glowC = hexToNum(c.palette.glow);
      for (let i = 0; i < 5; i++) {
        const s = v.wave[2 + i]!;
        s.visible = i < carry;
        if (!s.visible) continue;
        s.position.set(bx + (i - (carry - 1) / 2) * 16, by - hop - size * (N ? 0.4 : 0.72) - 54 + Math.sin(c.vt * 6 + i) * 2);
        s.scale.set(0.24);
        s.tint = glowC;
        s.alpha = 1;
      }
    }

    // hunted: a big red "!" over the chased player (and their ring flashes, above)
    if (hunted || v.alert) {
      if (!v.alert) {
        v.alert = new Graphics()
          .roundRect(-17, -62, 34, 52, 14).fill({ color: 0xff2a2a }).roundRect(-17, -62, 34, 52, 14).stroke({ width: 4, color: 0xffffff })
          .roundRect(-6, -54, 12, 26, 6).fill({ color: 0xffffff }).circle(0, -20, 6).fill({ color: 0xffffff });
        v.over.addChild(v.alert);
      }
      v.alert.visible = hunted;
      if (hunted) {
        v.alert.position.set(bx, by - hop - size * (N ? 0.4 : 0.72) - 40);
        v.alert.scale.set(1.1 + 0.15 * Math.abs(Math.sin(c.vt * 9)));
        v.alert.rotation = Math.sin(c.vt * 14) * 0.12;
      }
    }

    // name plate (does not bob with the waddle: stays readable)
    const plateY = Math.max(24, by - jumpHop - size * (N ? 0.36 : 0.72) - (N ? 14 : 22));
    v.top = plateY - 20;
    if (e.kind === 'player' && pl) {
      if (!v.name || v.flags.name !== pl.name || v.flags.nameColor !== color) {
        v.name?.destroy({ children: true });
        v.name = new Container();
        let bg: Graphics, t: Text;
        if (N) {
          // small pill, first 7 characters (full names live in the HUD chips)
          t = label(pl.name.slice(0, PLATE_CHARS).toUpperCase(), 12, 0xffffff, { stroke: 0, weight: '800' });
          t.style.letterSpacing = 1;
          bg = new Graphics()
            .roundRect(-t.width / 2 - 7, -10, t.width + 14, 20, 10).fill({ color: 0x070a1c, alpha: 0.78 })
            .roundRect(-t.width / 2 - 7, -10, t.width + 14, 20, 10).stroke({ width: 2, color, alpha: 1 });
          v.flags.plateW = t.width + 14;
        } else {
          t = label(pl.name.length > 12 ? `${pl.name.slice(0, 11)}…` : pl.name, 20, 0xffffff, { stroke: 0 });
          bg = new Graphics()
            .roundRect(-t.width / 2 - 12, -16, t.width + 24, 32, 16).fill({ color: 0x0b0b18, alpha: 0.72 })
            .roundRect(-t.width / 2 - 12, -16, t.width + 24, 32, 16).stroke({ width: 3, color, alpha: 1 });
        }
        v.name.addChild(bg, t);
        v.over.addChild(v.name);
        v.flags.name = pl.name;
        v.flags.nameColor = color;
      }
      v.name.position.set(bx, plateY);
      v.name.scale.set(Math.min(1, pop));
      // fade plates that slide under the timer pill
      const underTimer = v.name.y < 120 && Math.abs(x - this.arenaW / 2) < 140;
      v.name.alpha = (pl.connected ? 1 : 0.45) * (underTimer ? 0.3 : 1);
      if (N) {
        v.flags.bodyR = size * BODY_FRAC * 0.5;
        v.flags.plateA = v.name.alpha;
        if (this.plated.length < 8) this.plated.push(v);
      }
      const lead = c.leader === owner;
      if (lead && !v.crown) {
        v.crown = new Sprite(this.store.cell('crown'));
        v.crown.anchor.set(0.5);
        v.crown.tint = 0xffd23f;
        v.over.addChild(v.crown);
      }
      if (v.crown) {
        v.crown.visible = lead;
        if (lead) {
          // the crown lands with a bounce when the lead changes hands
          const since = c.vt - num(v.flags.leadAt, c.vt);
          if (v.flags.lead !== true) v.flags.leadAt = c.vt;
          v.crown.position.set(bx, plateY - (N ? 22 : 30) + Math.sin(c.vt * 4) * 2);
          v.crown.scale.set(0.7 * easeOutBack(since / 0.4));
          v.crown.rotation = Math.sin(c.vt * 3) * 0.08;
          v.top = plateY - 44;
        }
      }
      v.flags.lead = lead;
    }
  }

  private spawnTrail(v: View, tint: number): void {
    let t = this.trailFree.pop();
    if (!t) {
      if (this.trailLive.length >= TRAIL_MAX) return;
      const s = new Sprite();
      this.trails.addChild(s);
      t = { s, age: 0, life: 0.2, a0: 0.5, owner: null };
    }
    const s = t.s;
    s.texture = v.body.texture;
    s.anchor.set(0.5, this.nx ? 0.5 : 0.72);
    if (this.nx) s.blendMode = this.addMode;
    s.position.set(v.root.x, v.root.y);
    s.scale.set(v.body.scale.x, v.body.scale.y);
    s.rotation = v.body.rotation;
    s.tint = lighten(tint, 0.35);
    s.alpha = 0.5;
    s.visible = true;
    t.age = 0;
    t.owner = v;
    v.trailN++;
    this.trailLive.push(t);
  }

  private animateTrails(c: FrameCtx): void {
    const L = this.trailLive;
    for (let i = L.length - 1; i >= 0; i--) {
      const t = L[i]!;
      t.age += c.dt;
      const k = t.age / t.life;
      if (k >= 1) {
        t.s.visible = false;
        if (t.owner) t.owner.trailN = Math.max(0, t.owner.trailN - 1);
        t.owner = null;
        L[i] = L[L.length - 1]!;
        L.pop();
        this.trailFree.push(t);
        continue;
      }
      t.s.alpha = t.a0 * (1 - k);
    }
  }

  // ---------- neon players ----------

  /**
   * Name plates never overlap: overlapping pairs are pushed apart vertically (the higher one
   * goes up), and a plate fades while its body overlaps another body. At most a few players:
   * an O(n²) pass over a reused array, no allocation. Crowns ride on their plate.
   */
  private spreadPlates(): void {
    const L = this.plated, n = L.length, H = 22;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const a = L[i]!.name!;
        for (let j = i + 1; j < n; j++) {
          const b = L[j]!.name!;
          const wa = num(L[i]!.flags.plateW, 60), wb = num(L[j]!.flags.plateW, 60);
          if (Math.abs(a.x - b.x) >= (wa + wb) / 2 + 4) continue;
          const dy = Math.abs(a.y - b.y);
          if (dy >= H) continue;
          const push = H - dy;
          if (a.y <= b.y) a.y -= push;
          else b.y -= push;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const v = L[i]!;
      let hidden = false;
      const r = num(v.flags.bodyR, 20);
      for (let j = 0; j < n && !hidden; j++) {
        if (i === j) continue;
        const o = L[j]!, ro = num(o.flags.bodyR, 20);
        if ((o.px - v.px) ** 2 + (o.py - v.py) ** 2 < (r + ro) * (r + ro) * 0.8) hidden = true;
      }
      const want = num(v.flags.plateA, 1) * (hidden ? 0.15 : 1);
      // ease toward the target so plates don't flicker as bodies brush past
      const cur = num(v.flags.plateCur, want);
      const a = cur + (want - cur) * 0.25;
      v.flags.plateCur = a;
      v.name!.alpha = a;
      // the crown sits above its (possibly pushed) plate, never at the held core's anchor
      if (v.crown?.visible) v.crown.y = v.name!.y - 20;
    }
  }

  /** Two eyes that look where the body is going and blink (hidden on selfie portraits). */
  private neonEyes(v: View, e: Entity, portrait: boolean, size: number, k: number, vx: number, vy: number, stunned: boolean, c: FrameCtx): void {
    if (portrait) {
      if (v.eyes) for (const s of v.eyes) s.visible = false;
      return;
    }
    if (!v.eyes) {
      const white = this.nx!.get('eye', 0xffffff);
      v.eyes = [new Sprite(white), new Sprite(white), new Sprite(this.store.cell('dot')), new Sprite(this.store.cell('dot'))];
      for (const s of v.eyes) {
        s.anchor.set(0.5);
        v.root.addChild(s);
      }
      v.eyes[2]!.tint = v.eyes[3]!.tint = this.L.pupil;
    }
    void k;
    const open = stunned ? 0.55 : blinkOpen(c.vt, e.id);
    const ws = (size * 0.19) / 76;
    const ps = (size * 0.085) / 36;
    const lk = this.look;
    if (stunned) {
      lk.x = Math.cos(c.vt * 14) * size * 0.035;
      lk.y = Math.sin(c.vt * 14) * size * 0.035;
    } else eyeLook(vx, vy, size * 0.045, lk);
    const sx = v.body.scale.x / Math.abs(v.body.scale.x || 1);
    const pop = v.body.scale.y / ((size / 128) || 1);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const ex = side * size * 0.15 * pop + lk.x * 0.5, ey = -size * 0.05 * pop + lk.y * 0.4;
      const w = v.eyes[i]!, p = v.eyes[i + 2]!;
      w.visible = p.visible = true;
      w.position.set(ex, ey);
      w.scale.set(ws * pop, ws * pop * open);
      p.position.set(ex + lk.x, ey + lk.y * open);
      p.scale.set(ps * pop, ps * pop * Math.max(0.15, open));
      p.visible = open > 0.3 && this.L.id !== 'cosmos';
    }
    void sx;
  }

  /** Short fading colour ribbon behind a moving neon player (pooled beam segments). */
  private neonRibbon(v: View, x: number, y: number, r: number, color: number, c: FrameCtx): void {
    let rb = v.rib;
    if (!rb) {
      const segs: Sprite[] = [];
      for (let i = 0; i < RIB_N - 1; i++) {
        const s = new Sprite(this.nx!.get('beam', color));
        s.anchor.set(0, 0.5);
        s.blendMode = 'add';
        this.trails.addChild(s);
        segs.push(s);
      }
      rb = v.rib = { xs: new Float32Array(RIB_N).fill(x), ys: new Float32Array(RIB_N).fill(y), n: RIB_N, at: c.vt, segs, color };
    }
    if (rb.color !== color) {
      rb.color = color;
      const t = this.nx!.get('beam', color);
      for (const s of rb.segs) s.texture = t;
    }
    const jump = (rb.xs[0]! - x) ** 2 + (rb.ys[0]! - y) ** 2;
    if (jump > 200 * 200) {
      rb.xs.fill(x);
      rb.ys.fill(y);
    }
    if (c.dt > 0 && c.vt - rb.at >= RIB_EVERY) {
      rb.at = c.vt;
      rb.xs.copyWithin(1, 0, RIB_N - 1);
      rb.ys.copyWithin(1, 0, RIB_N - 1);
    }
    rb.xs[0] = x;
    rb.ys[0] = y;
    for (let i = 0; i < RIB_N - 1; i++) {
      const s = rb.segs[i]!;
      const x0 = rb.xs[i]!, y0 = rb.ys[i]!, x1 = rb.xs[i + 1]!, y1 = rb.ys[i + 1]!;
      const len = Math.hypot(x1 - x0, y1 - y0);
      s.visible = len > 0.8;
      if (!s.visible) continue;
      const t = i / (RIB_N - 1);
      s.position.set(x0, y0);
      s.rotation = Math.atan2(y1 - y0, x1 - x0);
      s.scale.set((len + 1) / 4, (r * 2.6 * (1 - t * 0.85)) / 64);
      s.alpha = 0.55 * (1 - t);
    }
  }

  /** OVERLOAD: the unstable core floats over its holder, pulsing faster as the fuse runs out. */
  private neonHeld(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const p = e.props;
    const holds = p.core === true || p.hasCore === true || p.holdsCore === true || p.holder === true || p.overload === true || e.tags.has('core') || e.tags.has('holder');
    if (!holds) {
      if (v.held) v.held.visible = false;
      return;
    }
    if (!v.held) {
      v.held = new Sprite(this.nx!.get('core-unstable', this.C.red));
      v.held.anchor.set(0.5);
      v.over.addChild(v.held);
    }
    const left = fuseLeft(p, c.time);
    const hz = fusePulseHz(left);
    const beat = Math.sin(c.vt * hz * TAU);
    const s = v.held;
    s.visible = true;
    s.position.set(x, y + Math.sin(c.vt * 5) * 2);
    s.scale.set((Math.max(e.r * 2.6, this.minBody * 0.55) / 84) * (1 + 0.14 * beat));
    s.rotation += c.dt * (1 + hz * 0.4);
    s.tint = beat > 0.6 && hz > 5 ? 0xffffff : 0xffffff;
    s.alpha = 0.85 + 0.15 * beat;
  }

  // ---------- neon world ----------

  /** A sweeping laser: a glowing beam between two emitter nodes (lanes: across the lane). */
  private neonLaser(v: View, e: Entity, x: number, y: number, c: FrameCtx, len: number, ang: number, on: boolean): void {
    const col = this.C.red;
    const node = this.nx!.get('laser', col);
    if (!v.marks) {
      const beam = new Sprite(this.nx!.get('beam', col));
      const n2 = new Sprite(node);
      const spark = new Sprite(this.store.cell('glow'));
      v.marks = [beam, n2, spark];
      beam.anchor.set(0, 0.5);
      beam.blendMode = this.addMode;
      spark.blendMode = 'add';
      spark.visible = this.L.additive;
      n2.anchor.set(0.5);
      spark.anchor.set(0.5);
      v.floor.addChild(beam, spark);
      v.root.addChild(n2);
    }
    const [beam, n2, spark] = v.marks as [Sprite, Sprite, Sprite];
    v.body.texture = node;
    v.tex = node;
    v.shadow.visible = false;
    const pop = this.popScale(v, c);
    const dx = Math.cos(ang) * len / 2, dy = Math.sin(ang) * len / 2;
    v.root.position.set(0, 0);
    zset(v.root, depthKey(y, v.id));
    const ns = (Math.max(16, e.r) * 1.6) / 60 * pop;
    v.body.position.set(x - dx, y - dy);
    v.body.anchor.set(0.5);
    v.body.scale.set(ns);
    v.body.rotation = 0;
    n2.position.set(x + dx, y + dy);
    n2.scale.set(ns);
    const flick = 0.85 + 0.15 * Math.sin(c.vt * 31 + e.id);
    beam.visible = true;
    beam.position.set(x - dx, y - dy);
    beam.rotation = ang;
    beam.scale.set(len / 4, ((on ? 30 : 10) / 64) * flick * pop);
    beam.alpha = on ? 1 : 0.25 + 0.15 * Math.sin(c.vt * 10);
    // a bright spark sweeping along the beam
    const ph = (c.vt * 1.4 + e.id * 0.3) % 1;
    spark.visible = on && this.L.additive;
    spark.position.set(x - dx + dx * 2 * ph, y - dy + dy * 2 * ph);
    spark.scale.set(0.8);
    spark.tint = 0xffffff;
    spark.alpha = 0.8;
    v.top = Math.min(y - dy, y + dy) - 20;
    const gl = this.glowOf(v);
    gl.tint = col;
    gl.position.set(x, y);
    gl.scale.set((Math.max(len * 0.25, 40)) / 64, (Math.max(len * 0.25, 40)) / 64);
    gl.alpha = on ? 0.25 : 0.05;
  }

  /** Boost pad: a glowing pad with chevrons scrolling in the boost direction. */
  private neonBoost(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const col = this.C.lime;
    const pad = this.nx!.get('boost', col);
    if (v.tex !== pad) {
      v.tex = pad;
      v.body.texture = pad;
    }
    const size = Math.max(60, e.r * 3.2);
    const pop = this.popScale(v, c);
    this.place(v, x, y, size * pop, pad);
    zset(v.root, Z_PAD + depthKey(y, v.id));
    v.shadow.visible = false;
    if (!v.marks) {
      v.marks = [0, 1, 2].map(() => {
        const s = new Sprite(this.store.cell('arrow'));
        s.anchor.set(0.5);
        s.blendMode = this.addMode;
        v.root.addChild(s);
        return s;
      });
    }
    const dir = num(e.props.dir, 0);
    for (let i = 0; i < 3; i++) {
      const s = v.marks[i]!;
      const ph = scrollPhase(c.vt, 1.6, i, 3);
      s.visible = true;
      s.position.set(Math.cos(dir) * (ph - 0.5) * size * 0.55, Math.sin(dir) * (ph - 0.5) * size * 0.55);
      s.rotation = dir;
      s.scale.set((size / 128) * 0.9 * pop);
      s.tint = col;
      s.alpha = Math.sin(ph * Math.PI);
    }
    v.top = y - size * 0.4;
    const gl = this.glowOf(v);
    gl.tint = col;
    gl.position.set(x, y);
    gl.scale.set(((size * 1.3) / 64) * (1 + Math.sin(c.vt * 6 + e.id) * 0.08));
    gl.alpha = 0.22 + Math.sin(c.vt * 6 + e.id) * 0.08;
  }

  /** Goal / base: a glowing zone in the team (or owner) colour with the owner's face over it. */
  private neonGoal(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const owner = e.owner ?? (typeof e.props.owner === 'string' ? e.props.owner : '');
    const idx = owner ? c.playerIndex.get(owner) : undefined;
    if (this.isNet(e)) return this.netGoal(v, e, x, y, c);
    const col = e.team !== undefined ? this.L.teams[e.team] : idx !== undefined ? this.colorOf(undefined, idx, c) : hexToNum(c.palette.glow);
    if (!v.marks) {
      const glow = new Sprite(this.store.cell('glow'));
      const ring = new Sprite(this.store.cell('ring'));
      const face = new Sprite();
      v.marks = [glow, ring, face];
      for (const m of v.marks) m.anchor.set(0.5);
      glow.blendMode = 'add';
      ring.blendMode = this.addMode;
      v.g = new Graphics();
      v.floor.addChild(v.g, glow, ring);
      v.over.addChild(face);
    }
    const [glow, ring, face] = v.marks as [Sprite, Sprite, Sprite];
    const R = Math.max(48, e.r);
    // CRATE CRASH platform zones are rectangles (hw / hh): a mat in the owner's colour, no face
    const zone = e.props.zone === true && typeof e.props.hw === 'number';
    const zw = num(e.props.hw, R), zh = num(e.props.hh, R);
    const pk = R * 4099 + col + (zone ? zw * 7 + zh * 13 : 0);
    if (zone && v.flags.pk !== pk) {
      v.flags.pk = pk;
      const rad = Math.min(zw, zh) * 0.22;
      const g = v.g!.clear();
      const L = this.L;
      if (L.pixel) {
        g.rect(-zw, -zh, zw * 2, zh * 2).fill({ color: col, alpha: 0.14 }).rect(-zw, -zh, zw * 2, zh * 2).stroke({ width: 6, color: col, alpha: 1 });
      } else if (!L.additive) {
        // toy mat: soft tint, white moulded rim, coloured edge
        g.roundRect(-zw, -zh, zw * 2, zh * 2, rad).fill({ color: col, alpha: 0.2 })
          .roundRect(-zw, -zh, zw * 2, zh * 2, rad).stroke({ width: 10, color: 0xffffff, alpha: 0.9 })
          .roundRect(-zw, -zh, zw * 2, zh * 2, rad).stroke({ width: 4, color: col, alpha: 1 });
      } else {
        g.roundRect(-zw, -zh, zw * 2, zh * 2, rad).fill({ color: col, alpha: 0.1 })
          .roundRect(-zw, -zh, zw * 2, zh * 2, rad).stroke({ width: 12, color: col, alpha: 0.14 })
          .roundRect(-zw, -zh, zw * 2, zh * 2, rad).stroke({ width: 2.5, color: lighten(col, 0.6), alpha: 1 });
      }
    }
    if (!zone && v.flags.pk !== pk) {
      v.flags.pk = pk;
      // pixel art has no hexagons: a square zone
      const sides = this.L.pixel ? 4 : 6, rot = this.L.pixel ? Math.PI / 4 : 0;
      const hex = (g: Graphics, r: number) => {
        for (let i = 0; i < sides; i++) {
          const a = rot + (i * Math.PI * 2) / sides;
          if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        g.closePath();
        return g;
      };
      const g = v.g!.clear();
      hex(g, R).fill({ color: col, alpha: 0.1 });
      hex(g, R).stroke({ width: 14, color: col, alpha: 0.12 });
      hex(g, R).stroke({ width: 6, color: col, alpha: 0.35 });
      hex(g, R).stroke({ width: 2.5, color: lighten(col, 0.6), alpha: 1 });
      hex(g, R * 0.7).stroke({ width: 2, color: col, alpha: 0.45 });
    }
    const since = c.vt - num(v.flags.bankAt, -9);
    const thump = since < 0.4 ? 1 + 0.18 * arch(since / 0.4) : 1;
    const pop = this.popScale(v, c);
    v.g!.position.set(x, y);
    v.g!.scale.set(thump * pop);
    v.g!.rotation = zone ? 0 : Math.sin(c.vt * 0.6 + e.id) * 0.05;
    v.body.visible = false;
    v.shadow.visible = false;
    v.root.position.set(x, y);
    zset(v.root, Z_ZONE);
    glow.visible = true;
    ring.visible = !zone;
    glow.position.set(x, y);
    if (zone) glow.scale.set((zw * 2.2) / 64 * thump, (zh * 2.2) / 64 * thump);
    else glow.scale.set(((R * 2.4) / 64) * thump);
    glow.tint = col;
    glow.alpha = 0.16 + Math.sin(c.vt * 3) * 0.05 + (since < 0.4 ? 0.5 * (1 - since / 0.4) : 0);
    const ph = (c.vt * 0.7) % 1;
    ring.position.set(x, y);
    ring.scale.set(((R * 1.9) / 56) * (0.7 + ph * 0.5));
    ring.tint = col;
    ring.alpha = 0.7 * (1 - ph);
    const pl = owner && !zone ? c.players.get(owner) : undefined;
    face.visible = !!pl;
    if (pl) {
      const ft = this.avatarTexture(pl, c);
      face.texture = ft;
      face.scale.set((R * 0.85) / Math.max(1, ft.width, ft.height) * 1.3);
      face.position.set(x, y + Math.sin(c.vt * 2 + e.id) * 3);
      face.alpha = 0.9;
    }
    v.top = y - (zone ? zh : R);
  }

  /** Everything else in neon: by art key (laser, boost, hole, finish, core, gem, ...). */
  private neonGeneric(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const key: NeonKey = neonKey(e.sprite, e.kind);
    if (key === 'boost') return this.neonBoost(v, e, x, y, c);
    if (key === 'laser') {
      const lane = typeof e.props.lane === 'number';
      const lanes = Math.max(1, Math.round(num(e.props.lanes, this.laneCount || 4)));
      const len = lane ? (this.arenaH / lanes) * 0.86 : Math.max(120, num(e.props.len, e.r * 8));
      const ang = lane ? Math.PI / 2 : num(e.props.angle, c.vt * num(e.props.spin, 1.2) + e.id);
      const on = e.props.on !== false && e.props.active !== false && e.props.open !== true && e.props.armed !== false;
      return this.neonLaser(v, e, x, y, c, len, ang, on);
    }
    if (PROP_KEYS.has(key)) return this.prop(v, e, x, y, c, key);
    if (key === 'goal') return this.netGoal(v, e, x, y, c);
    const C = this.C;
    const col = key === 'hole' ? C.magenta : key === 'spike' ? C.red : key === 'core-unstable' ? C.red : key === 'core' ? C.amber
      : key === 'finish' ? C.cyan : key === 'base' ? hexToNum(c.palette.primary) : hexToNum(c.palette.glow);
    const tex = this.nx!.get(key, col);
    if (v.tex !== tex) {
      v.tex = tex;
      v.body.texture = tex;
    }
    if (key === 'finish' && typeof e.props.hh === 'number') {
      // a full-height finish line: the lane renderer draws the checkered strip at its x
      this.finishX = x;
      v.body.visible = false;
      v.shadow.visible = false;
      return;
    }
    const size = Math.max(36, e.r * (key === 'hole' ? 2.5 : 3));
    const pop = this.popScale(v, c);
    const crumb = e.props.crumbling === true || num(e.props.crumbling) > 0;
    const jx = crumb ? Math.sin(c.vt * 47 + e.id) * 3 : 0;
    this.place(v, x + jx, y, size * pop, tex);
    v.body.tint = crumb ? (Math.sin(c.vt * 18) > 0 ? C.red : 0xffffff) : 0xffffff;
    if (this.L.shadows && key !== 'hole' && key !== 'finish' && key !== 'base') this.shadowAt(v, x, y + size * 0.3, size * 0.8 * pop, size * 0.24 * pop, 0.28);
    else v.shadow.visible = false;
    if (key === 'hole' || key === 'finish') zset(v.root, Z_ZONE);
    if (key === 'spike') {
      v.flags.spin = (num(v.flags.spin) + c.dt * 2.5) % TAU;
      v.body.rotation = this.L.pixel ? Math.round(num(v.flags.spin) / (Math.PI / 2)) * (Math.PI / 2) : num(v.flags.spin);
    }
    v.top = y - size * 0.5;
  }

  // ---------- physics props (round R2) ----------

  /** Spark burst preset for the look (additive streaks in the dark looks, puffs / pixels else). */
  get sparkPreset(): string {
    const id = this.L.id;
    return id === 'toybox' ? 'tstar' : id === 'retro' ? 'rpix' : 'nspark';
  }

  /** Dust / debris preset for the look. */
  private get dustPreset(): string {
    const id = this.L.id;
    return id === 'toybox' ? 'tpuff' : id === 'retro' ? 'rdust' : id === 'cosmos' ? 'cdust' : 'nlines';
  }

  /** Big moments the stage turns into camera kicks, flashes and sound (barrel blasts, hard hits). */
  onBoom?: (x: number, y: number, power: number) => void;
  onImpact?: (x: number, y: number, power: number, key: string) => void;
  /** Live bodies this frame (bumper contact checks). */
  private frameEnts: Entity[] = [];
  /** Bumpers / nets with a running pulse (debug / tests). */
  private propFx: View[] = [];

  /** A ball-sport net goal (not the collect block's base zone, which is also kind 'goal'). */
  private isNet(e: Entity): boolean {
    const s = (e.sprite ?? '').toLowerCase();
    return s === 'net' || s === 'goal-net' || e.tags.has('net') || e.props.net === true;
  }

  /** Texture share the prop's body fills (diameter / texture size) per look. */
  private propFrac(key: string): number {
    if (this.L.pixel) return 1;
    switch (key) {
      case 'ball': return 80 / 128;
      case 'crate': return this.L.id === 'cosmos' ? 96 / 128 : this.L.id === 'toybox' ? 100 / 128 : 88 / 128;
      case 'bumper': return 104 / 128;
      default: return this.L.id === 'cosmos' ? 84 / 128 : 88 / 128;
    }
  }

  private propColor(key: string, e: Entity, c: FrameCtx): number {
    const C = this.C, L = this.L;
    switch (key) {
      case 'ball': return L.id === 'toybox' ? C.magenta : L.id === 'retro' ? C.white : L.id === 'cosmos' ? C.cyan : C.amber;
      case 'crate': {
        // CRATE CRASH: crates wear their owner's colour
        const owner = e.owner ?? (typeof e.props.owner === 'string' ? e.props.owner : '');
        if (owner && c.playerIndex.has(owner)) return this.colorOf(c.players.get(owner)?.team, c.playerIndex.get(owner)!, c);
        if (L.id === 'retro') return 0xab5236;
        if (L.id === 'neon') return C.amber;
        return L.players[e.id % 4]!;
      }
      case 'bumper': return L.id === 'neon' ? C.cyan : C.magenta;
      default: return C.red;
    }
  }

  /**
   * A rigid-body prop: rotated by the engine's body angle, squashed and sparked on impacts in
   * proportion to the hit, the ball leaves a motion trail, bumpers flash and pulse when hit.
   */
  private prop(v: View, e: Entity, x: number, y: number, c: FrameCtx, key: NeonKey): void {
    const L = this.L;
    const col = this.propColor(key, e, c);
    const tex = this.nx!.get(key, col);
    if (v.tex !== tex) {
      v.tex = tex;
      v.body.texture = tex;
    }
    v.flags.propKey = key;
    v.flags.propColor = col;
    const hw = num(e.props.hw, e.r), hh = num(e.props.hh, e.r);
    const size = (Math.max(hw, hh) * 2) / this.propFrac(key);
    const pop = this.popScale(v, c);
    const k = this.place(v, x, y, size * pop, tex);
    // body angle: the engine's, else integrate a roll from the ball's speed
    const sp = Math.hypot(e.vx, e.vy);
    let ang = num(e.props.angle, num((e as unknown as { angle?: number }).angle, NaN));
    if (!Number.isFinite(ang)) {
      const prev = num(v.flags.ang, 0);
      ang = key === 'ball' ? prev + (c.dt * sp) / Math.max(8, e.r) * Math.sign(e.vx || 1) * 0.6 : key === 'bumper' ? prev + c.dt * 0.4 : prev;
    }
    v.flags.ang = ang;
    v.body.rotation = L.pixel ? Math.round(ang / (Math.PI / 4)) * (Math.PI / 4) : ang;
    zset(v.root, key === 'bumper' ? depthKey(y - 1000, v.id) : depthKey(y, v.id));

    // impacts: an engine hit stamp, else a sudden change of velocity
    const pvx = num(v.flags.pvx, e.vx), pvy = num(v.flags.pvy, e.vy);
    v.flags.pvx = e.vx;
    v.flags.pvy = e.vy;
    let power = 0;
    const hitAt = num(e.props.hitAt, -1);
    if (hitAt > num(v.flags.hitAt, -1)) {
      if (v.flags.hitAt !== undefined) power = Math.max(0.35, Math.min(1.5, num(e.props.impulse, 0.6)));
      v.flags.hitAt = hitAt;
    }
    const dv = Math.hypot(e.vx - pvx, e.vy - pvy);
    if (key !== 'bumper' && dv > 160) power = Math.max(power, Math.min(1.5, dv / 700));
    if (key === 'bumper') power = Math.max(power, this.bumperContact(v, e));
    if (power > 0.12 && c.vt - num(v.flags.impAt, -9) > 0.09) {
      v.flags.impAt = c.vt;
      v.flags.impK = Math.min(1, power);
      if (!c.degraded) {
        this.particles.emit(this.sparkPreset, x, y, 0.25 + 0.45 * Math.min(1, power));
        if (power > 0.5 && key !== 'bumper') this.particles.emit(this.dustPreset, x, y, 0.3 + 0.3 * Math.min(1, power));
      }
      if (key === 'bumper') {
        this.puff('ring', x, y, 0.32, size / 120, L.pixel ? L.c.white : lighten(col, 0.4), L.additive, 0.9, 0, 0, 1.4);
      }
      this.onImpact?.(x, y, power, key);
    }
    // squash (decaying wobble) proportional to the last impact
    const t = c.vt - num(v.flags.impAt, -9);
    const kk = num(v.flags.impK, 0);
    const wob = t < 0.45 ? kk * Math.exp(-t * 9) * Math.cos(t * 34) : 0;
    const sq = key === 'bumper' ? 0 : wob * 0.28;
    const pulse = key === 'bumper' && t < 0.35 ? 1 + 0.28 * kk * Math.sin((t / 0.35) * Math.PI) : 1;
    v.body.scale.set(k * (1 + sq) * pulse, k * (1 - sq) * pulse);
    // a crate knocked off its platform: debris burst, then it topples and shrinks away
    if (key === 'crate' && (e.props.out === true || e.props.broken === true)) {
      if (v.flags.outAt === undefined) {
        v.flags.outAt = c.vt;
        v.flags.debrisDone = true;
        this.crateDebris(v, x, y, col, c);
      }
      const q = Math.min(1, (c.vt - num(v.flags.outAt)) / 0.7);
      v.body.scale.set(k * (1 - 0.55 * q), k * (1 - 0.55 * q));
      v.body.rotation += q * 1.6;
      v.body.alpha = 1 - q * q;
    } else v.body.alpha = 1;
    // a bumper lights up when hit (white flash: additive copy of its texture)
    if (key === 'bumper') {
      if (!v.flashS) {
        v.flashS = new Sprite(tex);
        v.flashS.blendMode = 'add';
        v.flashS.anchor.set(0.5);
        v.root.addChild(v.flashS);
      }
      v.flashS.texture = tex;
      v.flashS.visible = t < 0.25;
      v.flashS.alpha = Math.max(0, 1 - t / 0.25) * 0.9;
      v.flashS.scale.copyFrom(v.body.scale);
      v.flashS.rotation = v.body.rotation;
    }
    if (L.shadows) this.shadowAt(v, x, y + size * 0.3 * this.propFrac(key), size * 0.8 * this.propFrac(key) * pop, size * 0.24 * this.propFrac(key) * pop, 0.3);
    else v.shadow.visible = false;
    // the ball: a motion trail (light ribbon, or pixel afterimages in retro)
    if (key === 'ball') {
      if (L.pixel) {
        if (sp > 160 && c.dt > 0 && c.vt - v.trailAt >= 0.035 && v.trailN < TRAIL_PER) {
          v.trailAt = c.vt;
          this.spawnTrail(v, 0xffffff);
        }
      } else {
        // the trail takes the last toucher's colour
        const lt = typeof e.props.lastTouch === 'string' ? e.props.lastTouch : '';
        const tc = lt && c.playerIndex.has(lt) ? this.colorOf(c.players.get(lt)?.team, c.playerIndex.get(lt)!, c) : L.id === 'toybox' ? 0xffffff : lighten(col, 0.3);
        this.neonRibbon(v, x, y, (size * this.propFrac(key)) / 3.2, tc, c);
      }
      if (L.additive) {
        const gl = this.glowOf(v);
        gl.tint = col;
        gl.position.set(x, y);
        gl.scale.set((size * 0.9) / 64);
        gl.alpha = 0.25 + Math.min(0.3, sp / 2000);
      }
    } else if (L.additive && key === 'bumper') {
      const gl = this.glowOf(v);
      gl.tint = col;
      gl.position.set(x, y);
      gl.scale.set(((size * 1.1) / 64) * pulse);
      gl.alpha = 0.18 + (t < 0.3 ? 0.5 * (1 - t / 0.3) : 0);
    } else if (L.additive && key === 'barrel') {
      // a slow warning pulse
      const gl = this.glowOf(v);
      gl.tint = this.C.red;
      gl.position.set(x, y);
      gl.scale.set((size * 0.85) / 64);
      gl.alpha = 0.16 + 0.08 * Math.sin(c.vt * 5 + e.id);
    }
    v.top = y - size * 0.5;
  }

  /** Bumper: strength of a fresh contact with any moving body this frame (0 = none). */
  private bumperContact(v: View, e: Entity): number {
    let best = 0;
    for (const o of this.frameEnts) {
      if (o === e || o.kind === 'tile' || o.kind === 'goal' || o.kind === 'base' || o.kind === 'hole') continue;
      const rr = (e.r + o.r) * 1.12;
      const dx = o.x - e.x, dy = o.y - e.y;
      if (dx * dx + dy * dy > rr * rr) continue;
      best = Math.max(best, Math.min(1.2, 0.35 + Math.hypot(o.vx, o.vy) / 700));
    }
    const was = v.flags.touch === true;
    v.flags.touch = best > 0;
    return was ? 0 : best;
  }

  /** A crate breaks: chunks in its colour, dust, a knock. */
  private crateDebris(v: View, x: number, y: number, col: number, c: FrameCtx): void {
    const L = this.L;
    for (let i = 0; i < (c.degraded ? 5 : 10); i++) {
      const a = Math.random() * TAU, sp = 420 * (0.5 + Math.random() * 0.7);
      const o = this.po;
      o.life = 0.55 + Math.random() * 0.35;
      o.s0 = L.pixel ? 0.18 : 0.38 + Math.random() * 0.25;
      o.tint = i % 3 === 0 ? lighten(col, 0.35) : col;
      o.add = false;
      o.a0 = 1;
      o.vx = Math.cos(a) * sp;
      o.vy = Math.sin(a) * sp;
      o.grow = -0.4;
      o.aspect = L.pixel ? 1 : 0.7;
      o.spin = L.pixel ? 0 : (Math.random() - 0.5) * 18;
      o.rot = Math.random() * TAU;
      o.gravity = 0;
      o.drag = 2.6;
      this.particles.one(L.pixel ? 'px' : 'confetti', x, y, o);
    }
    this.particles.emit(this.dustPreset, x, y, 0.7);
    this.onImpact?.(x, y, 0.8, 'crate');
    void v;
  }

  /** A prop left the world: crates break into debris, barrels explode, balls pop. */
  private propDeath(v: View, c: FrameCtx): void {
    const key = String(v.flags.propKey);
    const col = num(v.flags.propColor, 0xffffff);
    const L = this.L;
    const chunk = (n: number, speed: number, tint: number) => {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, sp = speed * (0.5 + Math.random() * 0.7);
        const o = this.po;
        o.life = 0.55 + Math.random() * 0.35;
        o.s0 = L.pixel ? 0.18 : 0.38 + Math.random() * 0.25;
        o.tint = i % 3 === 0 ? lighten(tint, 0.35) : tint;
        o.add = false;
        o.a0 = 1;
        o.vx = Math.cos(a) * sp;
        o.vy = Math.sin(a) * sp;
        o.grow = -0.4;
        o.aspect = L.pixel ? 1 : 0.7;
        o.spin = L.pixel ? 0 : (Math.random() - 0.5) * 18;
        o.rot = Math.random() * TAU;
        o.gravity = 0;
        o.drag = 2.6;
        this.particles.one(L.pixel ? 'px' : 'confetti', v.px, v.py, o);
      }
    };
    if (key === 'crate') {
      if (v.flags.debrisDone !== true) this.crateDebris(v, v.px, v.py, col, c);
    } else if (key === 'barrel') {
      chunk(c.degraded ? 6 : 12, 620, L.id === 'cosmos' ? 0x8a93b8 : col);
      this.particles.emit(this.sparkPreset, v.px, v.py, 1.2);
      this.particles.emit(L.id === 'toybox' ? 'tpuff' : L.id === 'retro' ? 'rdust' : 'nboom', v.px, v.py, 1);
      const wave = L.pixel ? L.c.white : L.id === 'toybox' ? 0xffffff : this.C.amber;
      this.puff('ring', v.px, v.py, 0.5, 0.6, wave, L.additive, 1, 0, 0, 7);
      this.puff('ring', v.px, v.py, 0.7, 0.5, this.C.red, L.additive, 0.9, 0, 0, 5);
      this.onBoom?.(v.px, v.py, 1);
    } else {
      this.particles.emit(this.sparkPreset, v.px, v.py, 0.6);
    }
  }

  /** Ball-sport goal: a stretched net, mouth toward the arena centre; ripples when scored in. */
  private netGoal(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const L = this.L;
    const col = e.team !== undefined ? L.teams[e.team] : L.c.white;
    const tex = this.nx!.get('goal', col);
    if (v.tex !== tex) {
      v.tex = tex;
      v.body.texture = tex;
    }
    const w = num(e.props.w, e.r * 1.4), h = num(e.props.h, e.r * 3);
    const side = num(e.props.side, x < this.arenaW / 2 ? -1 : 1);
    const hitAt = num(e.props.hitAt, -1);
    if (hitAt > num(v.flags.netHit, -1)) {
      if (v.flags.netHit !== undefined) v.flags.bankAt = c.vt;
      v.flags.netHit = hitAt;
    }
    const since = c.vt - num(v.flags.bankAt, -9);
    const rip = since < 0.8 ? Math.exp(-since * 5) * Math.sin(since * 38) : 0;
    v.root.position.set(x, y);
    zset(v.root, Z_ZONE);
    v.body.anchor.set(0.5);
    v.body.rotation = side > 0 ? Math.PI : 0;
    const pop = this.popScale(v, c);
    // the frame spans 108 x 104 of the 128 px art (the whole texture in pixel art)
    const fw = L.pixel ? tex.width : 108 * (tex.width / 128), fh = L.pixel ? tex.height : 104 * (tex.height / 128);
    v.body.scale.set((w / fw) * (1 + rip * 0.14) * pop, (h / fh) * (1 - rip * 0.05) * pop);
    v.shadow.visible = false;
    if (L.additive) {
      const gl = this.glowOf(v);
      gl.tint = col;
      gl.position.set(x, y);
      gl.scale.set(w / 64, h / 64);
      gl.alpha = 0.12 + (since < 0.8 ? 0.5 * (1 - since / 0.8) : 0);
    }
    v.top = y - h / 2;
  }

  // ---------- dodge ----------

  private hazard(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const src = this.nx ? undefined : this.source(e.sprite, c, 'hazard');
    let tex: Texture;
    if (src) tex = this.texFor(v, src, c, 'hazard');
    else {
      tex = this.neonTex(e, 'hazard', this.C.red);
      if (v.tex !== tex) {
        v.tex = tex;
        v.body.texture = tex;
      }
    }
    const tg = telegraphState(e.props, c.time);
    const heading = src?.type === 'url' ? ART_HEADING[src.key] : undefined;
    const fiery = src?.type === 'url' && /fire|lava|bomb/.test(src.key);
    const accent = this.nx ? this.C.red : hexToNum(c.palette.accent);
    if (!v.marks) {
      const ring = new Sprite(this.store.cell('ring'));
      const fill = new Sprite(this.store.cell('dot'));
      const arrows = [0, 1, 2].map(() => new Sprite(this.store.cell('arrow')));
      v.marks = [ring, fill, ...arrows];
      for (const m of v.marks) {
        m.anchor.set(0.5);
        v.floor.addChild(m);
      }
    }
    const marks = v.marks;
    const ring = marks[0]!, fill = marks[1]!;
    const show = !tg.armed;
    ring.visible = fill.visible = show;
    for (let i = 2; i < marks.length; i++) marks[i]!.visible = show && tg.arrow !== null;
    if (show) {
      const d = (e.r * 2.3 * HAZARD_SCALE) / 56;
      // the warning ring breathes faster as arming nears
      const beat = 1 + 0.06 * Math.sin(c.vt * (6 + 14 * tg.progress));
      ring.position.set(x, y);
      ring.scale.set(d * beat);
      ring.tint = accent;
      ring.alpha = 0.55 + 0.45 * tg.progress;
      fill.position.set(x, y);
      fill.scale.set(d * 1.6 * easeOutCubic(tg.progress));
      fill.tint = accent;
      fill.alpha = 0.28;
      if (tg.arrow) {
        const ang = Math.atan2(tg.arrow.dy, tg.arrow.dx);
        for (let i = 2; i < marks.length; i++) {
          const a = marks[i]!, j = i - 2;
          const off = e.r * HAZARD_SCALE + 18 + j * 26;
          a.position.set(x + tg.arrow.dx * off, y + tg.arrow.dy * off);
          a.rotation = ang;
          a.scale.set(0.65);
          a.tint = 0xffffff;
          // chase-light down the arrow, faster as arming nears
          a.alpha = 0.35 + 0.65 * Math.max(0, Math.sin(c.vt * (6 + 10 * tg.progress) - j * 0.9));
        }
      }
    }
    if (tg.armed && v.flags.armed === false) {
      v.flags.armedAt = c.vt;
      // a landing thud: one ring, no smoke clouds
      if (e.props.pattern === 'rain') this.puff('ring', x, y, 0.3, (e.r * HAZARD_SCALE) / 40, accent, true, 0.9, 0, 0, 1.4);
    }
    v.flags.armed = tg.armed;
    const since = c.vt - num(v.flags.armedAt, -9);
    const punch = since < 0.2 ? 1 + 0.35 * Math.sin((since / 0.2) * Math.PI) : 1;
    // telegraph: pulse, shiver and grow into place
    const jit = tg.armed ? 0 : tg.progress * 2.5;
    const jx = jit > 0 ? Math.sin(c.vt * 53 + e.id) * jit : 0, jy = jit > 0 ? Math.cos(c.vt * 47 + e.id * 3) * jit : 0;
    const pulse = tg.armed ? 1 : 1 + Math.sin(c.vt * (8 + 16 * tg.progress)) * 0.06 * tg.progress;
    const scale = (tg.armed ? 1 : 0.7 + 0.3 * easeInOutSine(tg.progress)) * punch * pulse;
    this.place(v, x + jx, y + jy, e.r * 2.5 * HAZARD_SCALE * scale * this.popScale(v, c), tex);
    v.body.alpha = tg.alpha;
    const vx = tg.armed ? e.vx : num(e.props.ax), vy = tg.armed ? e.vy : num(e.props.ay);
    if (heading !== undefined && (vx !== 0 || vy !== 0)) {
      // directional art (a comet tail) flies nose-first, with a little flutter
      v.body.rotation = Math.atan2(vy, vx) - heading + (tg.armed ? Math.sin(c.vt * 20 + e.id) * 0.06 : 0);
    } else {
      v.body.rotation = tg.armed ? (v.body.rotation + c.dt * 5) % TAU : Math.sin(c.vt * 9) * 0.08 * tg.progress;
    }
    if (this.nx) v.shadow.visible = false;
    else this.shadowAt(v, x, y + e.r * 0.7 * HAZARD_SCALE, e.r * 2 * HAZARD_SCALE * scale, e.r * 0.7 * HAZARD_SCALE * scale, 0.35 * tg.alpha);

    // glow: builds during the telegraph, flickers like fire once armed
    const gl = this.glowOf(v);
    gl.tint = fiery ? 0xff7a2e : accent;
    gl.position.set(x + jx, y + jy);
    if (tg.armed) {
      gl.alpha = 0.5 + 0.18 * Math.sin(c.vt * 23 + e.id) + 0.1 * Math.sin(c.vt * 37 + e.id * 2);
      gl.scale.set(((e.r * 3.6 * HAZARD_SCALE) / 64) * (1 + 0.08 * Math.sin(c.vt * 17 + e.id)) * punch);
    } else {
      gl.alpha = 0.12 + 0.3 * tg.progress * (0.6 + 0.4 * Math.sin(c.vt * (6 + 12 * tg.progress)));
      gl.scale.set(((e.r * 3 * HAZARD_SCALE) / 64) * (0.6 + 0.4 * tg.progress));
    }

  }

  private safeZone(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    if (!v.marks) {
      const glow = new Sprite(this.store.cell('glow'));
      const ring = new Sprite(this.store.cell('ring'));
      v.marks = [glow, ring];
      for (const m of v.marks) {
        m.anchor.set(0.5);
        v.floor.addChild(m);
      }
      glow.blendMode = 'add';
    }
    v.body.visible = false;
    v.shadow.visible = false;
    const col = hexToNum(c.palette.primary);
    const [glow, ring] = v.marks;
    glow!.visible = ring!.visible = true;
    const pop = this.popScale(v, c);
    const pulse = (1 + Math.sin(c.vt * 2.5) * 0.04) * pop;
    glow!.position.set(x, y);
    glow!.scale.set(((e.r * 2.4) / 64) * pulse);
    glow!.tint = col;
    glow!.alpha = 0.3 + Math.sin(c.vt * 2.5) * 0.06;
    ring!.position.set(x, y);
    ring!.scale.set(((e.r * 2) / 56) * pulse);
    ring!.tint = lighten(col, 0.3);
    ring!.alpha = 0.8;
    v.root.position.set(x, y);
    zset(v.root, Z_ZONE);
  }

  // ---------- sneak ----------

  private guard(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const gv = guardVisual(e.props);
    const guardKind = typeof e.props.guardKind === 'string' ? e.props.guardKind : undefined;
    const tex = this.texFor(v, this.source(e.sprite, c, 'guard', gv.awake ? 'awake' : undefined, guardKind), c, 'guard');
    if (gv.awake && v.flags.awake === false) {
      v.flags.awokeAt = c.vt;
      v.flags.xfAt = c.vt;
      this.puff('ring', x, y, 0.5, (Math.max(110, e.r * 3.2) * GUARD_SCALE) / 50, 0xff3b3b, true, 1, 0, 0, 2.2);
    }
    if (!gv.awake && v.flags.awake === true) v.flags.xfAt = c.vt;
    v.flags.awake = gv.awake;
    const stirring = e.props.stirring === true && !gv.awake;
    if (stirring && v.flags.stir !== true) v.flags.stirAt = c.vt;
    v.flags.stir = stirring;
    const sinceWake = c.vt - num(v.flags.awokeAt, -9);
    const shiver = gv.waking ? 4 : stirring ? 2 : 0;
    const shake = shiver > 0 ? Math.sin(c.vt * 46) * shiver : 0;
    const breathe = gv.awake ? 1 + Math.sin(c.vt * 5) * 0.015 : 1 + Math.sin(c.vt * 2.2) * 0.035;
    const punch = sinceWake < 0.35 ? 1 + 0.28 * arch(sinceWake / 0.35) : 1;
    // waking: jump up off the floor
    const jump = sinceWake < 0.45 ? arch(sinceWake / 0.45) * 42 : 0;
    const size = Math.max(110, e.r * 3.2) * GUARD_SCALE;
    const k = this.place(v, x + shake, y - jump, size, tex, 0.62);
    zset(v.root, depthKey(y, v.id));
    const m = punch * this.popScale(v, c);
    v.body.scale.set(k * m / Math.sqrt(breathe), k * breathe * m);
    v.body.rotation = gv.waking ? Math.sin(c.vt * 30) * 0.05 : 0;
    // generated art has no awake variant: tint it angry
    v.body.tint = gv.awake && !(v.tex && this.isAwakeArt(e, c, guardKind)) ? 0xff9a9a : 0xffffff;
    // crossfade from the previous art (sleep <-> awake)
    const xf = c.vt - num(v.flags.xfAt, -9);
    const prev = v.flags.prevTex as Texture | undefined;
    if (xf < 0.25 && prev && prev !== tex && !prev.destroyed) {
      if (!v.xfade) {
        v.xfade = new Sprite();
        v.root.addChildAt(v.xfade, 0);
      }
      const s = v.xfade;
      s.visible = true;
      s.texture = prev;
      s.anchor.set(0.5, 0.62);
      const pk = size / Math.max(1, prev.width, prev.height);
      s.scale.set(pk * m, pk * m);
      s.alpha = 1 - xf / 0.25;
      v.body.alpha = xf / 0.25;
    } else {
      if (v.xfade) v.xfade.visible = false;
      v.body.alpha = 1;
    }
    const lift = Math.min(0.5, jump / 80);
    this.shadowAt(v, x, y + size * 0.3, size * 0.9 * (1 - lift), size * 0.3 * (1 - lift), 0.4);

    if (!v.g) {
      v.g = new Graphics();
      v.floor.addChildAt(v.g, 0);
      v.cone = new Sprite();
      v.cone.anchor.set(0, 0.5);
      v.cone.blendMode = 'add';
      v.floor.addChildAt(v.cone, 0);
      v.og = new Graphics();
      v.over.addChild(v.og);
      v.texts = ['z', 'z', 'Z', '!'].map((s, i) => {
        const t = label(s, i === 3 ? 56 : 26 + i * 6, i === 3 ? hexToNum(c.palette.accent) : 0xffffff, { display: true });
        v.over.addChild(t);
        return t;
      });
    }
    // hearing ring: redrawn only when it visibly changes
    const hearing = num(e.props.hearingRadius);
    // numeric change key (no per-frame string)
    const hk = hearing > 0 && !gv.awake ? ((Math.round(x) * 4099 + Math.round(y)) * 8191 + Math.round(hearing)) * 64 + Math.round(gv.noise * 40) + 1 : 0;
    if (v.flags.hk !== hk) {
      v.flags.hk = hk;
      const g = v.g.clear();
      if (hk) {
        g.circle(x, y, hearing).stroke({ width: 2, color: lighten(gv.noiseColor, 0.2), alpha: 0.12 + gv.noise * 0.25 });
        g.circle(x, y, hearing).fill({ color: gv.noiseColor, alpha: 0.03 + gv.noise * 0.06 });
      }
    }
    // vision cone: one soft pre-rendered wedge, pulsing when the room gets loud
    const cone = v.cone!;
    cone.visible = gv.cone !== null;
    if (gv.cone) {
      const { facing, half, range } = gv.cone;
      cone.texture = this.store.cone((half * 180) / Math.PI);
      cone.position.set(x, y);
      cone.rotation = facing;
      cone.scale.set(range / 256);
      cone.tint = gv.awake ? 0xff3b3b : 0xffe08a;
      const loud = Math.max(0, (gv.noise - 0.55) / 0.45);
      cone.alpha = (gv.awake ? 0.5 : 0.3) * (1 + loud * 0.6 * (0.5 + 0.5 * Math.sin(c.vt * 14)));
    }

    // noise meter (redrawn when its fill or alarm blink changes)
    const og = v.og!;
    const mw = 150, my = y - size * 0.62 - 26;
    const blink = gv.noise > 0.8 && !gv.awake ? Math.sin(c.vt * 20) > 0 : false;
    const mk = ((Math.round(x) * 4099 + Math.round(my)) * 128 + Math.round(gv.noise * 96)) * 2 + (blink ? 1 : 0);
    if (v.flags.mk !== mk) {
      v.flags.mk = mk;
      og.clear();
      og.roundRect(x - mw / 2 - 4, my - 4, mw + 8, 22, 11).fill({ color: 0x0b0b18, alpha: 0.8 });
      if (gv.noise > 0.01) og.roundRect(x - mw / 2, my, mw * gv.noise, 14, 7).fill({ color: gv.noiseColor });
      if (blink) og.roundRect(x - mw / 2 - 4, my - 4, mw + 8, 22, 11).stroke({ width: 3, color: 0xff3b3b, alpha: 0.95 });
    }

    const texts = v.texts!;
    for (let i = 0; i < 3; i++) {
      const t = texts[i]!;
      t.visible = !gv.awake;
      if (!t.visible) continue;
      // Zzz drift up and grow as they float off
      const ph = (c.vt * 0.55 + i / 3) % 1;
      t.position.set(x + size * 0.22 + ph * 50 + Math.sin(ph * 6 + i) * 8, my - 18 - ph * 80);
      t.alpha = arch(ph) * 0.9 * (stirring ? 0.4 : 1);
      t.scale.set(0.9 + ph * 0.9);
      t.rotation = Math.sin(ph * 5) * 0.2;
    }
    const bang = texts[3]!;
    bang.visible = gv.awake || stirring;
    if (gv.awake) {
      const s = (sinceWake < 0.35 ? easeOutBack(sinceWake / 0.35) * 1.15 : 1 + Math.sin(c.vt * 10) * 0.06) * 1.5;
      bang.scale.set(s);
      bang.tint = 0xffffff;
      bang.alpha = 1;
      bang.position.set(x, my - 34 - jump);
    } else if (stirring) {
      // a small "!" pops while it stirs
      const st = c.vt - num(v.flags.stirAt, c.vt);
      bang.scale.set(0.55 * easeOutBack(st / 0.3));
      bang.alpha = 0.85;
      bang.position.set(x + size * 0.18, my - 26);
    }
    v.top = my - 40;
  }

  private isAwakeArt(e: Entity, c: FrameCtx, guardKind?: string): boolean {
    const src = this.source(e.sprite, c, 'guard', 'awake', guardKind);
    return src.type === 'url' && /awake/.test(src.key.split('|')[0]!);
  }

  // ---------- tug ----------

  private rope(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const segTex = this.texFor(v, this.source(e.sprite, c, 'rope'), c, 'rope');
    const left = num(e.props.lineLeft, this.arenaW * 0.3);
    const right = num(e.props.lineRight, this.arenaW * 0.7);
    const knot = ropeKnotX(e.props, x);
    const shift = knot - (left + right) / 2;
    const segW = 64;
    // the segment count follows the rope length (live Tweak changes included)
    const n = Math.ceil((right - left + 360) / segW) + 1;
    if (!v.g) {
      v.g = new Graphics();
      v.floor.addChild(v.g);
      v.marks = [];
      v.knot = new Sprite();
      v.knot.anchor.set(0.5);
      v.root.addChild(v.knot);
      v.texts = [label('SUDDEN DEATH', 40, hexToNum(c.palette.accent), { display: true })];
      v.over.addChild(v.texts[0]!);
      // team banners on poles, waving
      v.fxs = [0, 1].map(() => {
        const s = new Sprite();
        s.anchor.set(0.5, 0.05);
        v.floor.addChild(s);
        return s;
      });
    }
    v.shadow.visible = false;
    v.body.visible = false;
    // static backdrop: redrawn only when the lines or arena change
    const H = this.arenaH;
    const bk = `${left}|${right}|${this.arenaW}x${H}`;
    if (v.flags.backdrop !== bk) {
      v.flags.backdrop = bk;
      const g = v.g.clear();
      g.rect(0, 0, left, H).fill({ color: TEAM_COLORS[0], alpha: 0.12 });
      g.rect(right, 0, this.arenaW - right, H).fill({ color: TEAM_COLORS[1], alpha: 0.12 });
      g.rect(left - 4, 0, 8, H).fill({ color: TEAM_COLORS[0], alpha: 0.85 });
      g.rect(right - 4, 0, 8, H).fill({ color: TEAM_COLORS[1], alpha: 0.85 });
      for (let yy = 0; yy < H; yy += 36) g.rect((left + right) / 2 - 2, yy, 4, 20).fill({ color: 0xffffff, alpha: 0.35 });
    }

    // tension from how fast the knot moves (and the beat): taut rope stops sagging
    const pos = num(e.props.pos);
    const dpos = c.dt > 0 ? Math.abs(pos - num(v.flags.pos, pos)) / c.dt : 0;
    v.flags.pos = pos;
    const beat = e.props.onBeat === true;
    const want = Math.min(1, dpos * 6 + (beat ? 0.5 : 0) + (e.props.suddenDeath === true ? 0.3 : 0));
    const ten = num(v.flags.ten, 0) + (want - num(v.flags.ten, 0)) * Math.min(1, c.dt * 6);
    v.flags.ten = ten;
    const slack = 1 - ten;
    const amp = 4 + 14 * slack + Math.sin(c.vt * 2.1) * 5 * slack;
    const segs = v.marks!;
    while (segs.length < n) {
      const sp = new Sprite();
      sp.anchor.set(0.5);
      v.floor.addChild(sp);
      segs.push(sp);
    }
    const k = (segW / Math.max(1, segTex.width)) * 1.08;
    const base = segTex.width < segTex.height ? Math.PI / 2 : 0;
    const vib = ten > 0.6 ? Math.sin(c.vt * 60) * 1.2 * ten : 0;
    for (let i = 0; i < segs.length; i++) {
      const sp = segs[i]!;
      sp.visible = i < n;
      if (!sp.visible) continue;
      const t = n > 1 ? i / (n - 1) : 0;
      sp.texture = segTex;
      sp.position.set(left - 180 + shift + i * segW, y + amp * Math.sin(t * Math.PI) + vib);
      sp.scale.set(k);
      // follow the sag curve's slope
      sp.rotation = base + Math.atan((amp * Math.PI * Math.cos(t * Math.PI)) / Math.max(1, (n - 1) * segW));
    }
    const knotS = v.knot!;
    const mk = this.source('rope-marker', c, 'item');
    knotS.texture = this.store.get(mk, fallbackShape('item', c.palette) as SpriteSource & { type: 'shape' });
    if (beat && v.flags.beat !== true) {
      v.flags.beatAt = c.vt;
      this.puff('ring', knot, y, 0.35, 0.6, hexToNum(c.palette.glow), true, 1, 0, 0, 1.5);
    }
    v.flags.beat = beat;
    // rhythm: an approach ring closes on the knot and lands exactly on the beat (tap now!)
    if (typeof e.props.beat === 'number') {
      if (!v.cone) {
        v.cone = new Sprite(this.store.cell('ring'));
        v.cone.anchor.set(0.5);
        v.over.addChild(v.cone);
      }
      const ph = num(e.props.beat);
      v.cone.visible = e.props.paused !== true;
      v.cone.position.set(knot, y + amp);
      v.cone.scale.set((110 / 56) * (1 + (1 - ph) * 1.4));
      v.cone.alpha = beat ? 1 : 0.35 + 0.5 * ph;
      v.cone.tint = beat ? 0xffffff : hexToNum(c.palette.glow);
    }
    // surge / splash: big team-coloured moments
    const surgeAt = num(e.props.surgeAt, -1), splashAt = num(e.props.splashAt, -1);
    if (v.flags.tugSeen !== true) {
      v.flags.tugSeen = true;
      v.flags.surgeAt = surgeAt;
      v.flags.splashAt = splashAt;
    }
    if (surgeAt > 0 && surgeAt !== num(v.flags.surgeAt, -1)) {
      v.flags.surgeAt = surgeAt;
      this.particles.emit('steal', knot, y);
    }
    if (splashAt > 0 && splashAt !== num(v.flags.splashAt, -1)) {
      v.flags.splashAt = splashAt;
      this.particles.emit('splash', (left + right) / 2, y + 40);
      this.particles.emit('dust', (left + right) / 2, y + 40);
    }
    const sinceBeat = c.vt - num(v.flags.beatAt, -9);
    const bump = sinceBeat < 0.3 ? 1 + 0.3 * arch(sinceBeat / 0.3) : 1;
    knotS.scale.set(bump * (56 / Math.max(1, knotS.texture.width, knotS.texture.height)));
    knotS.position.set(0, amp + vib);
    knotS.rotation = Math.sin(c.vt * 3) * 0.1 * slack;
    v.root.position.set(knot, y);
    zset(v.root, depthKey(y, v.id) - 1);

    // banners
    const banners = v.fxs!;
    for (let i = 0; i < 2; i++) {
      const s = banners[i]!;
      const src = this.bannerSrc[i] ?? (this.bannerSrc[i] = this.source(BANNERS[i]!, c, 'item'));
      s.visible = src.type === 'url';
      if (!s.visible) continue;
      s.texture = this.store.get(src, fallbackShape('item', c.palette) as SpriteSource & { type: 'shape' });
      const bx = i === 0 ? left * 0.5 : right + (this.arenaW - right) * 0.5;
      const bs = 150 / Math.max(1, s.texture.width, s.texture.height);
      s.position.set(bx, H * 0.1);
      s.scale.set(bs * (1 + Math.sin(c.vt * 2.4 + i * 2) * 0.03), bs);
      s.skew.set(Math.sin(c.vt * 3.1 + i * 1.7) * 0.1, 0);
      s.rotation = Math.sin(c.vt * 1.7 + i) * 0.03;
    }

    const sd = v.texts![0]!;
    sd.visible = e.props.suddenDeath === true;
    sd.position.set((left + right) / 2, y - 120);
    sd.scale.set(1 + Math.sin(c.vt * 8) * 0.06);
    v.root.alpha = e.props.paused === true ? 0.6 : 1;
  }

  // ---------- collect / misc ----------

  private item(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const carried = (typeof e.props.carriedBy === 'string' && e.props.carriedBy !== '') || (typeof e.props.holder === 'string' && e.props.holder !== '');
    const golden = e.props.golden === true || e.tags.has('golden');
    let tex: Texture;
    let nk: NeonKey | undefined;
    if (this.nx) {
      nk = neonKey(e.sprite, 'item');
      const col = golden ? this.C.amber : nk === 'core' ? this.C.amber : nk === 'core-unstable' ? this.C.red : nk === 'gem' ? hexToNum(c.palette.glow) : hexToNum(c.palette.primary);
      tex = this.nx.get(nk, col);
      if (v.tex !== tex) {
        v.tex = tex;
        v.body.texture = tex;
      }
    } else tex = this.texFor(v, this.source(e.sprite, c, 'item'), c, 'item');
    const bob = carried ? Math.sin(c.vt * 9 + e.id) * 2 : Math.sin(c.vt * 3.2 + e.id * 1.7) * 5;
    const held = e.kind === 'core' && carried;
    const size = e.r * 2.6 * ITEM_SCALE * (held ? 1.05 : carried ? 0.75 : 1) * (golden ? 1.3 : 1) * (e.props.critical === true ? 1.15 : 1);
    // held: in front of the holder's body (the crown sits above the name plate instead)
    if (held) y += Math.max(e.r * 0.5, this.minBody * 0.3);
    const pop = this.popScale(v, c);
    const k = this.place(v, x, y - 8 + bob, size * pop, tex);
    // slow coin-like spin + wobble
    const spin = 0.72 + 0.28 * Math.abs(Math.cos(c.vt * 1.8 + e.id));
    // unstable cores pulse faster as the fuse runs out
    const hz = nk === 'core-unstable' ? (typeof e.props.pulseHz === 'number' && e.props.pulseHz > 0 ? e.props.pulseHz : fusePulseHz(fuseLeft(e.props, c.time))) : 0;
    const beat = hz ? 1 + 0.14 * Math.sin(c.vt * hz * TAU) : 1;
    if (typeof e.props.angle === 'number' && (e.props.body === 'dynamic' || e.props.flying === true || e.props.group === 'loot')) {
      // a physics body (a knocked-loose core rolling away, a passed core in flight): its real spin
      v.body.scale.set(k * beat, k * beat);
      v.body.rotation = e.props.angle;
    } else if (nk && nk !== 'gem') {
      v.body.scale.set(k * beat, k * beat);
      v.body.rotation += c.dt * (nk === 'core' ? 0.8 : 1 + hz * 0.3);
    } else {
      v.body.scale.set(k * spin, k);
      v.body.rotation = Math.sin(c.vt * 2 + e.id) * 0.12;
    }
    zset(v.root, carried ? depthKey(y + 60, v.id) : depthKey(y, v.id));
    if (this.nx && this.L.shadows && !carried) this.shadowAt(v, x, y + size * 0.32, size * 0.6 * pop, size * 0.18 * pop, 0.25);
    else if (this.nx) v.shadow.visible = false;
    else this.shadowAt(v, x, y + e.r * 0.6, e.r * 1.8 * (1 - bob / 30) * pop, e.r * 0.55 * pop, carried ? 0 : 0.3);
    v.top = y - size;
    const gl = this.glowOf(v);
    gl.visible = !carried || held;
    gl.tint = golden || nk === 'core' ? this.C.amber : nk === 'core-unstable' ? this.C.red : hexToNum(c.palette.glow);
    if (hz) {
      gl.position.set(x, y - 8 + bob);
      gl.scale.set(((e.r * 4.4) / 64) * beat * pop);
      gl.alpha = 0.35 + 0.3 * Math.max(0, Math.sin(c.vt * hz * TAU));
      return;
    }
    gl.position.set(x, y - 8 + bob);
    gl.scale.set(((e.r * ITEM_SCALE * (golden ? 4.6 : 2.6)) / 64) * (1 + Math.sin(c.vt * 4 + e.id) * 0.1) * pop);
    gl.alpha = golden ? 0.85 : 0.22 + Math.sin(c.vt * 4 + e.id) * 0.06;
  }

  /**
   * A goal / home base: a big pad in its owner's colour (shared goals use the palette glow)
   * with the basket on it and the owner's face floating above, so everyone knows where to bank.
   */
  private goal(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const tex = this.texFor(v, this.source(e.kind === 'base' && e.sprite === 'base' ? 'goal' : e.sprite, c, 'goal'), c, 'goal');
    const owner = e.owner ?? (typeof e.props.owner === 'string' ? e.props.owner : '');
    const idx = owner ? c.playerIndex.get(owner) : undefined;
    const col = e.team !== undefined ? TEAM_COLORS[e.team] : idx !== undefined ? playerColor(idx, c.palette) : hexToNum(c.palette.glow);
    if (!v.marks) {
      const glow = new Sprite(this.store.cell('glow'));
      const ring = new Sprite(this.store.cell('ring'));
      const face = new Sprite();
      v.marks = [glow, ring, face];
      for (const m of v.marks) m.anchor.set(0.5);
      v.floor.addChild(glow, ring);
      v.over.addChild(face);
      glow.blendMode = 'add';
      v.g = new Graphics();
      v.floor.addChildAt(v.g, 0);
    }
    const [glow, ring, face] = v.marks;
    const R = Math.max(48, e.r);
    // the pad: redrawn only when its size / colour changes
    const pk = R * 4099 + col;
    if (v.flags.pk !== pk) {
      v.flags.pk = pk;
      v.g!.clear()
        .ellipse(0, 0, R * 1.05, R * 0.62).fill({ color: col, alpha: 0.3 })
        .ellipse(0, 0, R * 1.05, R * 0.62).stroke({ width: 7, color: col, alpha: 0.95 })
        .ellipse(0, 0, R * 0.8, R * 0.46).stroke({ width: 3, color: lighten(col, 0.4), alpha: 0.6 });
    }
    // a bank pulses the pad (flags.bankAt is set by the stage)
    const since = c.vt - num(v.flags.bankAt, -9);
    const thump = since < 0.4 ? 1 + 0.18 * arch(since / 0.4) : 1;
    v.g!.position.set(x, y);
    v.g!.scale.set(thump * this.popScale(v, c));
    glow!.visible = ring!.visible = true;
    glow!.position.set(x, y);
    glow!.scale.set(((R * 2.6) / 64) * thump);
    glow!.tint = col;
    glow!.alpha = 0.22 + Math.sin(c.vt * 3) * 0.06 + (since < 0.4 ? 0.4 * (1 - since / 0.4) : 0);
    ring!.position.set(x, y);
    ring!.scale.set(((R * 2.1) / 56) * (1 + ((c.vt * 0.8) % 1) * 0.25), ((R * 1.25) / 56) * (1 + ((c.vt * 0.8) % 1) * 0.25));
    ring!.tint = col;
    ring!.alpha = 0.6 * (1 - ((c.vt * 0.8) % 1));
    const breathe = 1 + Math.sin(c.vt * 2.6) * 0.025;
    const bsize = Math.max(90, R * 1.5);
    const k = this.place(v, x, y, bsize * this.popScale(v, c) * thump, tex, 0.62);
    v.body.scale.set(k / breathe, k * breathe);
    this.shadowAt(v, x, y + R * 0.25, R * 1.3, R * 0.4, 0.3);
    // owner's face over their basket
    const pl = owner ? c.players.get(owner) : undefined;
    face!.visible = !!pl;
    if (pl) {
      const ft = this.avatarTexture(pl, c);
      face!.texture = ft;
      const fk = (R * 0.9) / Math.max(1, ft.width, ft.height);
      face!.scale.set(fk);
      face!.position.set(x, y - bsize * 0.62 - R * 0.35 + Math.sin(c.vt * 2 + e.id) * 4);
    }
    v.top = y - bsize * 0.62 - R * 0.8;
  }

  /** The stage saw a bank at this goal: thump it. */
  thumpGoal(id: number, vt: number): void {
    const v = this.views.get(id);
    if (v) v.flags.bankAt = vt;
  }

  /** Nearest goal/base view id to a world point (or -1). */
  goalNear(x: number, y: number, owner?: string): number {
    let best = -1, bd = Infinity;
    for (const v of this.views.values()) {
      if (v.kind !== 'goal' && v.kind !== 'base') continue;
      const d = (v.px - x) ** 2 + (v.py - y) ** 2;
      if (d < bd) {
        bd = d;
        best = v.id;
      }
    }
    void owner;
    return best;
  }

  private generic(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const tex = this.texFor(v, this.source(e.sprite, c, e.kind), c, e.kind);
    const mult = e.kind === 'baton' ? 4 : e.kind === 'boost-pad' ? 2.6 : e.kind === 'obstacle' ? 2.6 : 2.4;
    const size = Math.max(22, e.r * mult);
    const pad = e.kind === 'boost-pad';
    const pop = this.popScale(v, c);
    // crumbling tiles (final-10 arena shrink) shiver and flash before they go
    const crumb = e.props.crumbling === true || num(e.props.crumbling) > 0;
    const jx = crumb ? Math.sin(c.vt * 47 + e.id) * 3 : 0;
    this.place(v, x + jx, y, size * pop * (pad ? 1 + Math.sin(c.vt * 6 + e.id) * 0.06 : 1), tex);
    v.body.tint = crumb ? (Math.sin(c.vt * 18) > 0 ? 0xff8a6a : 0xffffff) : 0xffffff;
    v.top = y - size * 0.6;
    if (pad) {
      zset(v.root, Z_PAD + depthKey(y, v.id));
      v.shadow.visible = false;
      const gl = this.glowOf(v);
      gl.tint = hexToNum(c.palette.primary);
      gl.position.set(x, y);
      gl.scale.set(((size * 1.5) / 64) * (1 + Math.sin(c.vt * 6 + e.id) * 0.12));
      gl.alpha = 0.4 + Math.sin(c.vt * 6 + e.id) * 0.2;
    } else {
      this.shadowAt(v, x, y + size * 0.35, size * 0.9, size * 0.3, 0.32);
    }
  }

  // ---------- race lanes ----------

  private syncLanes(entities: Entity[], c: FrameCtx): void {
    let lanes = 0;
    for (const e of entities) if (typeof e.props.lane === 'number' && (e.kind === 'obstacle' || e.kind === 'boost-pad' || e.props.mover === 'race')) lanes = Math.max(lanes, e.props.lane + 1);
    const W = this.arenaW, H = this.arenaH;
    this.laneCount = lanes;
    if (this.nx) return this.neonLanes(lanes, c);
    this.animateFlag(lanes > 0, W - 100, c);
    const key = `${lanes}|${c.palette.primary}|${W}x${H}`;
    if (key === this.laneKey) return;
    this.laneKey = key;
    const g = this.lanes;
    g.clear();
    if (lanes === 0) return;
    const lh = H / lanes;
    const prim = hexToNum(c.palette.primary);
    for (let i = 0; i < lanes; i++) {
      g.rect(0, i * lh, W, lh).fill({ color: i % 2 ? darken(prim, 0.75) : darken(prim, 0.68), alpha: 0.55 });
      if (i > 0) for (let xx = 0; xx < W; xx += 48) g.rect(xx, i * lh - 2, 28, 4).fill({ color: 0xffffff, alpha: 0.35 });
    }
    // start and checkered finish (race START_PAD 80 / END_PAD 60)
    g.rect(78, 0, 4, H).fill({ color: 0xffffff, alpha: 0.7 });
    const fx = W - 60, sq = 14;
    for (let yy = 0, r = 0; yy < H; yy += sq, r++) {
      for (let cc = 0; cc < 2; cc++) g.rect(fx + cc * sq - sq, yy, sq, sq).fill({ color: (r + cc) % 2 ? 0x111111 : 0xffffff, alpha: 0.9 });
    }
  }

  private laneCount = 0;
  /** x of a finish-line entity (race), else the default end pad. */
  private finishX = -1;

  /** Neon race track: dark lanes, glowing dashed dividers, a start line and a checkered neon finish. */
  private neonLanes(lanes: number, c: FrameCtx): void {
    const W = this.arenaW, H = this.arenaH;
    const fx = this.finishX > 0 ? this.finishX + 7 : W - 60;
    // the finish strip glows (sprites, so it can shimmer); the rest is one static Graphics
    for (let i = 0; i < this.finishS.length; i++) this.finishS[i]!.visible = lanes > 0;
    if (lanes > 0) {
      const tex = this.nx!.get('finish', this.C.cyan);
      const n = Math.ceil(H / 128);
      while (this.finishS.length < n) {
        const s = new Sprite(tex);
        s.anchor.set(0.5, 0);
        this.floor.addChild(s);
        this.finishS.push(s);
      }
      for (let i = 0; i < this.finishS.length; i++) {
        const s = this.finishS[i]!;
        s.visible = i < n;
        s.texture = tex;
        s.position.set(fx - 7, i * 128);
        // the last piece is cut to the arena's bottom edge (texture frame unchanged: just squash)
        s.scale.set(1, Math.max(0, Math.min(128, H - i * 128)) / 128);
        s.alpha = 0.85 + 0.15 * Math.sin(c.vt * 4 + i * 0.7);
      }
    }
    const key = `n|${lanes}|${c.palette.primary}|${W}x${H}|${Math.round(fx)}`;
    if (key === this.laneKey) return;
    this.laneKey = key;
    const g = this.lanes;
    g.clear();
    if (lanes === 0) return;
    const lh = H / lanes;
    const prim = hexToNum(c.palette.primary), acc = hexToNum(c.palette.accent);
    for (let i = 0; i < lanes; i++) {
      g.rect(0, i * lh, W, lh).fill({ color: i % 2 ? 0x000000 : prim, alpha: i % 2 ? 0.18 : 0.035 });
      if (i > 0) {
        for (let xx = 0; xx < W; xx += 56) {
          g.rect(xx, i * lh - 4, 30, 8).fill({ color: prim, alpha: 0.12 });
          g.rect(xx, i * lh - 1.5, 30, 3).fill({ color: lighten(prim, 0.5), alpha: 0.75 });
        }
      }
    }
    // start line (race START_PAD 80) and the finish glow band
    g.rect(74, 0, 12, H).fill({ color: acc, alpha: 0.15 }).rect(78, 0, 4, H).fill({ color: lighten(acc, 0.5), alpha: 0.9 });
    g.rect(fx - 34, 0, 54, H).fill({ color: this.C.cyan, alpha: 0.08 });
  }

  /** Waving finish flag over the finish line. */
  private animateFlag(on: boolean, x: number, c: FrameCtx): void {
    const src = on ? (this.flagSrc ??= this.source('finish-flag', c, 'item')) : undefined;
    if (!src || src.type !== 'url') {
      if (this.flag) this.flag.visible = false;
      return;
    }
    if (!this.flag) {
      this.flag = new Sprite();
      this.flag.anchor.set(0.2, 0.95);
      this.floor.addChild(this.flag);
    }
    const f = this.flag;
    f.visible = true;
    f.texture = this.store.get(src, fallbackShape('item', c.palette) as SpriteSource & { type: 'shape' });
    const k = 110 / Math.max(1, f.texture.width, f.texture.height);
    f.position.set(x, 112);
    f.scale.set(k * (1 + Math.sin(c.vt * 5) * 0.04), k);
    f.skew.set(0, Math.sin(c.vt * 4.2) * 0.12);
  }

  // ---------- quiz / draw board ----------

  private syncPanel(e: Entity | undefined, c: FrameCtx): void {
    if (!e) {
      if (this.quiz) {
        this.quiz.destroy();
        this.quiz = undefined;
      }
      return;
    }
    if (!this.quiz) {
      this.quiz = new PanelView(this.arenaW, this.arenaH);
      this.overlay.addChild(this.quiz.root);
    }
    this.quiz.update(e, c);
  }

  destroy(): void {
    this.quiz?.destroy();
    this.floor.destroy({ children: true });
    this.glows.destroy({ children: true });
    this.trails.destroy({ children: true });
    this.bodies.destroy({ children: true });
    this.overlay.destroy({ children: true });
  }
}

const OPTION_COLORS = [0xff4d6d, 0x3d8bff, 0xffb703, 0x2ec27e];

interface OptionCard {
  box: Container;
  g: Graphics;
  t: Text;
  letter: Text;
}

/** Big readable card for quiz (trivia) and board (draw-judge) entities. */
class PanelView {
  readonly root = new Container();
  private head = new Container();
  private card = new Graphics();
  private title: Text;
  private sub: Text;
  private opts: OptionCard[] = [];
  private barBg = new Graphics();
  private bar = new Graphics();
  private last = '';
  private phaseKey = '';
  private phaseLen = 1;
  private barShown = 1;
  private barHot = false;
  private slideAt = -9;
  private qKey = '';

  constructor(private W: number, private H: number) {
    this.title = label('', 40, 0xffffff, { display: true });
    this.title.style.wordWrap = true;
    this.title.style.wordWrapWidth = W * 0.78;
    this.sub = label('', 26, 0xffffff);
    const bw = W * 0.84;
    this.barBg.roundRect(0, 0, bw, 10, 5).fill({ color: 0xffffff, alpha: 0.15 });
    this.bar.roundRect(0, 0, bw, 10, 5).fill({ color: 0xffffff });
    this.barBg.position.set(W * 0.08, H * 0.4);
    this.bar.position.set(W * 0.08, H * 0.4);
    this.head.addChild(this.card, this.title, this.sub, this.barBg, this.bar);
    this.root.addChild(this.head);
    for (let i = 0; i < 4; i++) {
      const box = new Container();
      const g = new Graphics();
      const t = label('', 28, 0xffffff, { weight: '700' });
      t.style.wordWrap = true;
      t.style.wordWrapWidth = W * 0.3;
      const letter = label('ABCD'[i]!, 34, 0xffffff, { display: true });
      box.addChild(g, letter, t);
      this.root.addChild(box);
      this.opts.push({ box, g, t, letter });
    }
  }

  update(e: Entity, c: FrameCtx): void {
    const P = e.props;
    const W = this.W, H = this.H;
    const phase = String(P.phase ?? '');
    const isQuiz = e.kind === 'quiz';
    const left = secondsLeft(P, c.time);
    const key = JSON.stringify([phase, P.q, P.prompt, P.answer, P.answered, P.submitted, P.players, P.lastWinner, P.banner, P.opt0, P.opt1, P.opt2, P.opt3]);
    if (key !== this.last) {
      this.last = key;
      // a new question / prompt: cards slide in again
      const qk = `${P.q ?? ''}|${P.prompt ?? ''}|${P.banner ?? ''}|${phase === 'done'}`;
      if (qk !== this.qKey) {
        this.qKey = qk;
        this.slideAt = c.vt;
      }
      this.card.clear()
        .roundRect(W * 0.08, H * 0.15, W * 0.84, H * 0.23, 28).fill({ color: 0x0b0b18, alpha: 0.72 })
        .roundRect(W * 0.08, H * 0.15, W * 0.84, H * 0.23, 28).stroke({ width: 3, color: hexToNum(c.palette.glow), alpha: 0.6 });
      const thinking = String(P.banner ?? '');
      if (isQuiz) {
        this.title.text = phase === 'done' ? "That's a wrap!" : thinking || String(P.q ?? '');
        this.sub.text = phase === 'question' ? `${num(P.answered)}/${num(P.players)} answered` : phase === 'reveal' ? 'And the answer is…' : '';
      } else {
        const winner = typeof P.lastWinner === 'string' ? c.players.get(P.lastWinner)?.name : undefined;
        this.title.text = phase === 'drawing' ? `Draw: ${String(P.prompt ?? '')}` : thinking || (winner ? `${winner} wins the round!` : String(P.prompt ?? ''));
        this.sub.text = phase === 'drawing' ? `${num(P.submitted)}/${num(P.players)} drawings in` : phase === 'reveal' ? `Round ${num(P.round)} of ${num(P.rounds)}` : '';
      }
      const answer = num(P.answer, -1);
      this.opts.forEach((o, i) => {
        const text = isQuiz && phase !== 'done' && !thinking ? String(P[`opt${i}`] ?? '') : '';
        const vis = text !== '';
        o.box.visible = vis;
        if (!vis) return;
        const col = OPTION_COLORS[i]!;
        const reveal = phase === 'reveal';
        const right = reveal && answer === i;
        const ow = W * 0.41, oh = H * 0.16;
        o.box.pivot.set(ow / 2, oh / 2);
        o.g.clear().roundRect(0, 0, ow, oh, 22).fill({ color: reveal && !right ? darken(col, 0.6) : col, alpha: reveal && !right ? 0.5 : 0.92 });
        o.g.roundRect(6, 6, ow - 12, oh * 0.4, 16).fill({ color: 0xffffff, alpha: reveal && !right ? 0.04 : 0.12 });
        if (right) o.g.roundRect(-4, -4, ow + 8, oh + 8, 26).stroke({ width: 6, color: 0xffffff });
        o.letter.position.set(40, oh / 2);
        o.t.text = text;
        o.t.position.set(ow / 2 + 20, oh / 2);
        o.t.alpha = reveal && !right ? 0.6 : 1;
      });
    }
    // slide in: header drops, cards rise one after another
    const s = c.vt - this.slideAt;
    const hk = easeOutBack(s / 0.4);
    this.head.alpha = Math.min(1, s / 0.2);
    this.head.position.set(0, (1 - hk) * -40);
    this.title.position.set(W / 2, H * 0.245);
    this.sub.position.set(W / 2, H * 0.335);
    const reveal = phase === 'reveal';
    const answer = num(P.answer, -1);
    for (let i = 0; i < this.opts.length; i++) {
      const o = this.opts[i]!;
      if (!o.box.visible) continue;
      const ox = W * (i % 2 === 0 ? 0.08 : 0.51), oy = H * (0.45 + Math.floor(i / 2) * 0.19), ow = W * 0.41, oh = H * 0.16;
      const k = (s - 0.08 - i * 0.07) / 0.45;
      const e2 = easeOutBack(k);
      o.box.alpha = Math.max(0, Math.min(1, k * 3));
      // the right answer throbs during the reveal
      const throb = reveal && answer === i ? 1 + 0.04 * Math.sin(c.vt * 8) : 1;
      o.box.position.set(ox + ow / 2, oy + oh / 2 + (1 - e2) * 90);
      o.box.scale.set((0.85 + 0.15 * e2) * throb);
    }
    // timer bar eases toward the time left
    const timed = phase === 'question' || phase === 'drawing';
    let frac = 0;
    if (timed && left > 0) {
      // the phase length is the largest time-left seen since the phase began
      if (this.phaseKey !== `${phase}|${P.index ?? P.round}`) {
        this.phaseKey = `${phase}|${P.index ?? P.round}`;
        this.phaseLen = left;
        this.barShown = 0;
      }
      this.phaseLen = Math.max(this.phaseLen, left);
      frac = Math.min(1, left / this.phaseLen);
    }
    this.barShown += (frac - this.barShown) * Math.min(1, c.dt * 8);
    const on = timed && left > 0;
    this.bar.visible = this.barBg.visible = on;
    if (on) {
      this.bar.scale.set(Math.max(0.001, this.barShown), 1);
      const hot = left < 5;
      if (hot !== this.barHot || this.bar.tint === 0xffffff) {
        this.barHot = hot;
        this.bar.tint = hot ? 0xff4d6d : hexToNum(c.palette.glow);
      }
      this.bar.alpha = hot ? 0.75 + 0.25 * Math.sin(c.vt * 14) : 1;
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
