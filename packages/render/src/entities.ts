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

export interface FrameCtx {
  palette: Palette;
  art: Record<string, string>;
  defaults: Record<string, string>;
  players: Map<string, Player>;
  playerIndex: Map<string, number>;
  leader?: string | undefined;
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
  // 8b extras
  anim?: AvatarAnim;
  glow?: Sprite;
  flashS?: Sprite;
  xfade?: Sprite;
  cone?: Sprite;
  fxs?: Sprite[];
  trailN: number;
  trailAt: number;
  flags: Record<string, unknown>;
  dieAt?: number | undefined;
}

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
const TAU = Math.PI * 2;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** zIndex bands below the y-sorted bodies. */
const Z_PAD = -1e11;
const Z_ZONE = -1e12;

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

  constructor(private readonly store: TextureStore, private readonly particles: ParticleSystem, private arenaW: number, private arenaH: number) {
    this.bodies.sortableChildren = true;
    this.floor.addChild(this.lanes);
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
    const src = this.source(`avatar:${p.id}`, c, 'player', undefined, undefined, p.avatar);
    return this.store.get(src, fallbackShape('player', c.palette) as SpriteSource & { type: 'shape' });
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
      seen: 0, top: e.y, trailN: 0, trailAt: -9, flags: {},
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
    this.glowN = 0;
    this.glowCap = c.degraded ? GLOW_MAX / 2 : GLOW_MAX;
    let quiz: Entity | undefined;
    for (const e of entities) {
      if (e.kind === 'quiz' || e.kind === 'board') {
        quiz = e;
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
    this.animateDying(c);
    this.animateTrails(c);
    this.syncLanes(entities, c);
    this.syncPanel(quiz, c);
  }

  private onDeath(v: View, c: FrameCtx): void {
    if (v.kind === 'player' || v.kind === 'runner') {
      this.particles.emit('smoke', v.px, v.py, 1);
      this.particles.emit('burst', v.px, v.py, 0.5);
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
          this.particles.emit('sparkle', x, y, 0.3);
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
  private acquire(e: Entity, c: FrameCtx): View {
    const v = this.pool.get(e.kind)?.pop();
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
  }

  /** Park a finished view in its kind's pool (hidden), or destroy it if the pool is full. */
  private release(v: View): void {
    const list = this.pool.get(v.kind) ?? [];
    if (list.length >= POOL_MAX) {
      v.root.destroy({ children: true });
      v.floor.destroy({ children: true });
      v.over.destroy({ children: true });
      v.glow?.destroy();
      return;
    }
    v.root.visible = v.floor.visible = v.over.visible = false;
    this.hideExtras(v);
    list.push(v);
    this.pool.set(v.kind, list);
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
    if (this.flag) this.flag.visible = false;
    this.quiz?.destroy();
    this.quiz = undefined;
  }

  private place(v: View, x: number, y: number, size: number, tex: Texture, anchorY = 0.5): number {
    const k = size / Math.max(1, tex.width, tex.height);
    v.root.position.set(x, y);
    v.root.zIndex = depthKey(y, v.id);
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
        return this.hazard(v, e, x, y, c);
      case 'guard':
        return this.guard(v, e, x, y, c);
      case 'safe-zone':
        return this.safeZone(v, e, x, y, c);
      case 'rope':
        return this.rope(v, e, x, y, c);
      case 'goal':
        return this.goal(v, e, x, y, c);
      case 'item':
        return this.item(v, e, x, y, c);
      default:
        return this.generic(v, e, x, y, c);
    }
  }

  // ---------- players ----------

  private avatar(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const owner = e.owner ?? '';
    const pl = c.players.get(owner);
    const idx = c.playerIndex.get(owner) ?? 0;
    const color = e.team !== undefined ? TEAM_COLORS[e.team] : playerColor(idx, c.palette);
    const tex = this.texFor(v, this.source(e.sprite, c, 'player', undefined, undefined, pl?.avatar), c, 'player');
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
      if (!c.degraded) this.particles.emit('burst', x, y - e.r, 0.35);
    }
    v.flags.inv = inv;
    v.flags.stun = stun;
    const prevMotion = anim.motion;
    anim.update(x, y, c.dt, c.vt, dashing);
    anim.pose(c.vt);
    v.face = anim.face;

    const jump = num(e.props.jump);
    const jumpHop = jump > 0 ? Math.sin(jump * Math.PI) * 34 : 0;
    const hop = jumpHop + anim.hop;
    const size = e.r * 3.6 * (e.kind === 'runner' ? 0.85 : 1);
    const pop = this.popScale(v, c);
    const bx = x + anim.ox, by = y + anim.oy;
    const k = this.place(v, bx, by - hop, size, tex, 0.72) * pop;
    v.root.zIndex = depthKey(y, v.id);
    v.body.scale.set(k * v.face * anim.sx, k * anim.sy * (tiptoe ? 0.9 : 1));
    v.body.rotation = fx.wobble + (e.props.pulling === true ? (e.team === 0 ? -0.22 : 0.22) + Math.sin(c.vt * 9 + e.id) * 0.04 : anim.rot);
    v.body.alpha = fx.alpha * (tiptoe ? 0.82 : 1) * (e.kind === 'runner' && e.props.leg !== undefined ? 0.75 : 1);

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
      f.anchor.set(0.5, 0.72);
      f.scale.set(v.body.scale.x, v.body.scale.y);
      f.rotation = v.body.rotation;
    }

    // contact shadow shrinks and fades as the body leaves the floor
    const lift = Math.min(0.5, hop / 70);
    this.shadowAt(v, bx, y + e.r * 0.55, e.r * 2.2 * (1 - lift) * pop, e.r * 0.8 * (1 - lift) * pop, 0.42 * (1 - lift * 0.8));

    // team / player ring under the feet
    if (!v.g) {
      v.g = new Graphics();
      v.floor.addChild(v.g);
    }
    if (v.flags.ringColor !== color) {
      v.flags.ringColor = color;
      v.g.clear().ellipse(0, 0, e.r * 1.25, e.r * 0.5).stroke({ width: 4, color, alpha: 0.9 }).ellipse(0, 0, e.r * 1.25, e.r * 0.5).fill({ color, alpha: 0.18 });
    }
    v.g.position.set(bx, y + e.r * 0.55);
    v.g.scale.set(pop);

    // soft backlight in the player's colour (reads on any floor); a big pulsing aura when boosted
    const boosted = num(e.props.boost, 1) > 1.001;
    const gl = this.glowOf(v);
    gl.position.set(bx, by - hop - size * 0.25);
    if (boosted) {
      gl.tint = hexToNum(c.palette.glow);
      gl.scale.set(((e.r * 4.4) / 64) * (1 + Math.sin(c.vt * 6) * 0.1) * pop);
      gl.alpha = 0.6;
      if (!c.degraded && Math.random() < c.dt * 6) this.puff('spark', x + (Math.random() - 0.5) * e.r * 2, y, 0.6, 0.25, hexToNum(c.palette.glow), true, 1, 0, -70);
    } else {
      gl.tint = color;
      gl.scale.set(((e.r * 3.4) / 64) * pop);
      gl.alpha = 0.22 + (anim.motion === 'dash' ? 0.25 : 0);
    }

    if (!c.degraded) {
      // footstep dust
      if (anim.footstep && anim.speed > 60 && e.props.mover !== 'race') {
        this.puff('smoke', bx - v.face * e.r * 0.4, y + e.r * 0.45, 0.45, 0.2 + Math.random() * 0.06, 0xe9e2d6, false, 0.4, -anim.vx * 0.12, -14, 1.3);
      }
      // dash: burst of dust on take-off, then afterimages
      if (anim.motion === 'dash' && prevMotion !== 'dash') {
        for (let i = 0; i < 3; i++) {
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
      const headY = by - hop - size * 0.66;
      for (let i = 0; i < 3; i++) {
        const s = v.fxs[i]!;
        s.visible = fx.stunned;
        if (!fx.stunned) continue;
        const a = c.vt * 6 + (i * TAU) / 3;
        const depth = Math.sin(a);
        s.position.set(bx + Math.cos(a) * e.r * 1.05, headY + depth * e.r * 0.32);
        s.scale.set(0.3 * (0.8 + 0.2 * depth));
        s.alpha = 0.7 + 0.3 * depth;
        s.rotation = c.vt * 4 + i;
      }
    }

    // name plate (does not bob with the waddle: stays readable)
    const plateY = Math.max(18, by - jumpHop - size * 0.72 - 20);
    v.top = plateY - 20;
    if (e.kind === 'player' && pl) {
      if (!v.name || v.flags.name !== pl.name || v.flags.nameColor !== color) {
        v.name?.destroy({ children: true });
        v.name = new Container();
        const t = label(pl.name.length > 14 ? `${pl.name.slice(0, 13)}…` : pl.name, 20, 0xffffff, { stroke: 0 });
        const bg = new Graphics()
          .roundRect(-t.width / 2 - 12, -15, t.width + 24, 30, 15).fill({ color: 0x0b0b18, alpha: 0.62 })
          .roundRect(-t.width / 2 - 12, -15, t.width + 24, 30, 15).stroke({ width: 2, color, alpha: 0.95 });
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
          v.crown.position.set(bx, plateY - 24 + Math.sin(c.vt * 4) * 2);
          v.crown.scale.set(0.5 * easeOutBack(since / 0.4));
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
    s.anchor.set(0.5, 0.72);
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

  // ---------- dodge ----------

  private hazard(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const src = this.source(e.sprite, c, 'hazard');
    const tex = this.texFor(v, src, c, 'hazard');
    const tg = telegraphState(e.props, c.time);
    const heading = src.type === 'url' ? ART_HEADING[src.key] : undefined;
    const fiery = src.type === 'url' && /fire|lava|bomb/.test(src.key);
    const accent = hexToNum(c.palette.accent);
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
      const d = (e.r * 2.3) / 56;
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
          const off = e.r + 14 + j * 20;
          a.position.set(x + tg.arrow.dx * off, y + tg.arrow.dy * off);
          a.rotation = ang;
          a.scale.set(0.45);
          a.tint = 0xffffff;
          // chase-light down the arrow, faster as arming nears
          a.alpha = 0.35 + 0.65 * Math.max(0, Math.sin(c.vt * (6 + 10 * tg.progress) - j * 0.9));
        }
      }
    }
    if (tg.armed && v.flags.armed === false) {
      v.flags.armedAt = c.vt;
      if (e.props.pattern === 'rain') {
        this.particles.emit('smoke', x, y, 0.4);
        this.particles.emit('burst', x, y, 0.35);
      }
    }
    v.flags.armed = tg.armed;
    const since = c.vt - num(v.flags.armedAt, -9);
    const punch = since < 0.2 ? 1 + 0.35 * Math.sin((since / 0.2) * Math.PI) : 1;
    // telegraph: pulse, shiver and grow into place
    const jit = tg.armed ? 0 : tg.progress * 2.5;
    const jx = jit > 0 ? Math.sin(c.vt * 53 + e.id) * jit : 0, jy = jit > 0 ? Math.cos(c.vt * 47 + e.id * 3) * jit : 0;
    const pulse = tg.armed ? 1 : 1 + Math.sin(c.vt * (8 + 16 * tg.progress)) * 0.06 * tg.progress;
    const scale = (tg.armed ? 1 : 0.7 + 0.3 * easeInOutSine(tg.progress)) * punch * pulse;
    this.place(v, x + jx, y + jy, e.r * 2.5 * scale * this.popScale(v, c), tex);
    v.body.alpha = tg.alpha;
    const vx = tg.armed ? e.vx : num(e.props.ax), vy = tg.armed ? e.vy : num(e.props.ay);
    if (heading !== undefined && (vx !== 0 || vy !== 0)) {
      // directional art (a comet tail) flies nose-first, with a little flutter
      v.body.rotation = Math.atan2(vy, vx) - heading + (tg.armed ? Math.sin(c.vt * 20 + e.id) * 0.06 : 0);
    } else {
      v.body.rotation = tg.armed ? (v.body.rotation + c.dt * 5) % TAU : Math.sin(c.vt * 9) * 0.08 * tg.progress;
    }
    this.shadowAt(v, x, y + e.r * 0.7, e.r * 2 * scale, e.r * 0.7 * scale, 0.3 * tg.alpha);

    // glow: builds during the telegraph, flickers like fire once armed
    const gl = this.glowOf(v);
    gl.tint = fiery ? 0xff7a2e : accent;
    gl.position.set(x + jx, y + jy);
    if (tg.armed) {
      gl.alpha = 0.5 + 0.18 * Math.sin(c.vt * 23 + e.id) + 0.1 * Math.sin(c.vt * 37 + e.id * 2);
      gl.scale.set(((e.r * 3.6) / 64) * (1 + 0.08 * Math.sin(c.vt * 17 + e.id)) * punch);
    } else {
      gl.alpha = 0.12 + 0.3 * tg.progress * (0.6 + 0.4 * Math.sin(c.vt * (6 + 12 * tg.progress)));
      gl.scale.set(((e.r * 3) / 64) * (0.6 + 0.4 * tg.progress));
    }

    const moving = e.vx !== 0 || e.vy !== 0;
    const b = this.particles.budget;
    if (tg.armed && moving && !c.degraded && b.active < b.cap * 0.6 && Math.random() < c.dt * 16) {
      const r = Math.random();
      this.puff('glow', x - e.vx * 0.03, y - e.vy * 0.03, 0.35, e.r / 40, r < 0.5 ? (fiery ? 0xff9a3d : accent) : hexToNum(c.palette.glow), true, 0.7, 0, 0, -0.6);
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
    v.root.zIndex = Z_ZONE;
  }

  // ---------- sneak ----------

  private guard(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const gv = guardVisual(e.props);
    const guardKind = typeof e.props.guardKind === 'string' ? e.props.guardKind : undefined;
    const tex = this.texFor(v, this.source(e.sprite, c, 'guard', gv.awake ? 'awake' : undefined, guardKind), c, 'guard');
    if (gv.awake && v.flags.awake === false) {
      v.flags.awokeAt = c.vt;
      v.flags.xfAt = c.vt;
      this.particles.emit('burst', x, y - e.r, 0.6);
      this.particles.emit('smoke', x, y, 0.6);
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
    const size = Math.max(110, e.r * 3.2);
    const k = this.place(v, x + shake, y - jump, size, tex, 0.62);
    v.root.zIndex = depthKey(y, v.id);
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
    const mw = 96, my = y - size * 0.62 - 26;
    const blink = gv.noise > 0.8 && !gv.awake ? Math.sin(c.vt * 20) > 0 : false;
    const mk = ((Math.round(x) * 4099 + Math.round(my)) * 128 + Math.round(gv.noise * 96)) * 2 + (blink ? 1 : 0);
    if (v.flags.mk !== mk) {
      v.flags.mk = mk;
      og.clear();
      og.roundRect(x - mw / 2 - 3, my - 3, mw + 6, 16, 8).fill({ color: 0x0b0b18, alpha: 0.7 });
      if (gv.noise > 0.01) og.roundRect(x - mw / 2, my, mw * gv.noise, 10, 5).fill({ color: gv.noiseColor });
      if (blink) og.roundRect(x - mw / 2 - 3, my - 3, mw + 6, 16, 8).stroke({ width: 2, color: 0xff3b3b, alpha: 0.9 });
    }

    const texts = v.texts!;
    for (let i = 0; i < 3; i++) {
      const t = texts[i]!;
      t.visible = !gv.awake;
      if (!t.visible) continue;
      // Zzz drift up and grow as they float off
      const ph = (c.vt * 0.55 + i / 3) % 1;
      t.position.set(x + size * 0.22 + ph * 34 + Math.sin(ph * 6 + i) * 6, my - 14 - ph * 56);
      t.alpha = arch(ph) * 0.9 * (stirring ? 0.4 : 1);
      t.scale.set(0.6 + ph * 0.6);
      t.rotation = Math.sin(ph * 5) * 0.2;
    }
    const bang = texts[3]!;
    bang.visible = gv.awake || stirring;
    if (gv.awake) {
      const s = sinceWake < 0.35 ? easeOutBack(sinceWake / 0.35) * 1.15 : 1 + Math.sin(c.vt * 10) * 0.06;
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
    const sinceBeat = c.vt - num(v.flags.beatAt, -9);
    const bump = sinceBeat < 0.3 ? 1 + 0.3 * arch(sinceBeat / 0.3) : 1;
    knotS.scale.set(bump * (56 / Math.max(1, knotS.texture.width, knotS.texture.height)));
    knotS.position.set(0, amp + vib);
    knotS.rotation = Math.sin(c.vt * 3) * 0.1 * slack;
    v.root.position.set(knot, y);
    v.root.zIndex = depthKey(y, v.id) - 1;

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
    const tex = this.texFor(v, this.source(e.sprite, c, 'item'), c, 'item');
    const carried = typeof e.props.carriedBy === 'string' && e.props.carriedBy !== '';
    const golden = e.props.golden === true || e.tags.has('golden');
    const bob = carried ? Math.sin(c.vt * 9 + e.id) * 2 : Math.sin(c.vt * 3.2 + e.id * 1.7) * 5;
    const size = e.r * 2.6 * (carried ? 0.8 : 1) * (golden ? 1.15 : 1);
    const pop = this.popScale(v, c);
    const k = this.place(v, x, y - 8 + bob, size * pop, tex);
    // slow coin-like spin + wobble
    const spin = 0.72 + 0.28 * Math.abs(Math.cos(c.vt * 1.8 + e.id));
    v.body.scale.set(k * spin, k);
    v.body.rotation = Math.sin(c.vt * 2 + e.id) * 0.12;
    v.root.zIndex = carried ? depthKey(y + 60, v.id) : depthKey(y, v.id);
    this.shadowAt(v, x, y + e.r * 0.6, e.r * 1.8 * (1 - bob / 30) * pop, e.r * 0.55 * pop, carried ? 0 : 0.3);
    v.top = y - size;
    const gl = this.glowOf(v);
    gl.visible = !carried;
    gl.tint = golden ? 0xffc83d : hexToNum(c.palette.glow);
    gl.position.set(x, y - 8 + bob);
    gl.scale.set(((e.r * (golden ? 4.2 : 3)) / 64) * (1 + Math.sin(c.vt * 4 + e.id) * 0.1) * pop);
    gl.alpha = golden ? 0.75 : 0.32 + Math.sin(c.vt * 4 + e.id) * 0.08;
    if (!c.degraded && !carried) {
      // periodic glint, staggered per item
      const gp = Math.floor((c.vt + e.id * 0.37) / 2.3);
      if (gp !== num(v.flags.glint, gp)) this.puff('spark', x + e.r * 0.45, y - 8 + bob - e.r * 0.55, 0.5, 0.55, 0xffffff, true, 1, 0, 0, -0.9, 1, 3);
      v.flags.glint = gp;
      if (golden && Math.random() < c.dt * 4) this.puff('spark', x + (Math.random() - 0.5) * e.r * 2, y - e.r, 0.6, 0.22, 0xfff1a8, true, 1, 0, -40, 0, 1, 4);
    }
  }

  private goal(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const tex = this.texFor(v, this.source(e.sprite, c, 'goal'), c, 'goal');
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
    const col = hexToNum(c.palette.glow);
    const [glow, ring] = v.marks;
    glow!.visible = ring!.visible = true;
    glow!.position.set(x, y);
    glow!.scale.set((e.r * 2.6) / 64);
    glow!.tint = col;
    glow!.alpha = 0.3 + Math.sin(c.vt * 3) * 0.08;
    ring!.position.set(x, y);
    ring!.scale.set(((e.r * 2) / 56) * (1 + Math.sin(c.vt * 3) * 0.03));
    ring!.tint = col;
    ring!.alpha = 0.75;
    const breathe = 1 + Math.sin(c.vt * 2.6) * 0.025;
    const k = this.place(v, x, y, Math.max(56, e.r * 1.4) * this.popScale(v, c), tex, 0.6);
    v.body.scale.set(k / breathe, k * breathe);
    this.shadowAt(v, x, y + e.r * 0.3, e.r * 1.3, e.r * 0.4, 0.3);
    v.top = y - e.r;
  }

  private generic(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const tex = this.texFor(v, this.source(e.sprite, c, e.kind), c, e.kind);
    const mult = e.kind === 'baton' ? 4 : e.kind === 'boost-pad' ? 2.6 : e.kind === 'obstacle' ? 2.6 : 2.4;
    const size = Math.max(22, e.r * mult);
    const pad = e.kind === 'boost-pad';
    const pop = this.popScale(v, c);
    this.place(v, x, y, size * pop * (pad ? 1 + Math.sin(c.vt * 6 + e.id) * 0.06 : 1), tex);
    v.top = y - size * 0.6;
    if (pad) {
      v.root.zIndex = Z_PAD + depthKey(y, v.id);
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
