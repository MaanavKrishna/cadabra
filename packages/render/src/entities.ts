import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { Entity, Player } from '@cadabra/engine';
import type { ParticleSystem } from './particles';
import { fallbackShape, resolveSprite, type SpriteSource } from './sprites';
import type { TextureStore } from './textures';
import { DISPLAY_FONT, TEAM_COLORS, UI_FONT, darken, hexToNum, lighten, playerColor, type Palette } from './theme';
import { avatarFx, guardVisual, ropeKnotX, secondsLeft, telegraphState } from './visual';

export interface FrameCtx {
  palette: Palette;
  art: Record<string, string>;
  defaults: Record<string, string>;
  players: Map<string, Player>;
  playerIndex: Map<string, number>;
  leader?: string;
  /** Interpolated sim time (s). */
  time: number;
  /** Visual clock (s, slow-mo scaled) and its frame delta. */
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
  tex?: Texture;
  swapAt: number;
  // kind extras
  g?: Graphics;
  og?: Graphics;
  name?: Container;
  crown?: Sprite;
  aura?: Sprite;
  marks?: Sprite[];
  texts?: Text[];
  knot?: Sprite;
  flags: Record<string, unknown>;
  dieAt?: number;
}

const DIE_SEC = 0.22;
/** Pooled views kept per kind; extra ones are destroyed. */
const POOL_MAX = 64;
/** Direction of travel drawn in directional pack art (rad, screen space). */
const ART_HEADING: Record<string, number> = { fireball: (3 * Math.PI) / 4 };
const POP_SEC = 0.32;
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function easeOutBack(t: number): number {
  const k = Math.max(0, Math.min(1, t)) - 1;
  return 1 + k * k * (2.7 * k + 1.7);
}

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

/** Sized, depth-sorted sprites + floor decals + overlays for every snapshot entity. */
export class EntityLayer {
  readonly floor = new Container();
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
  private quiz?: PanelView;

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
      if (v.tex) v.swapAt = c.vt;
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
      flags: {},
    };
  }

  sync(entities: Entity[], pos: (e: Entity) => { x: number; y: number }, c: FrameCtx): void {
    const seen = new Set<number>();
    let quiz: Entity | undefined;
    for (const e of entities) {
      if (e.kind === 'quiz' || e.kind === 'board') {
        quiz = e;
        continue;
      }
      seen.add(e.id);
      let v = this.views.get(e.id);
      if (!v) {
        v = this.acquire(e, c);
        this.views.set(e.id, v);
      }
      const p = pos(e);
      this.update(v, e, p.x, p.y, c);
      v.px = p.x;
      v.py = p.y;
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      this.views.delete(id);
      v.dieAt = c.vt;
      this.onDeath(v, c);
      this.dying.push(v);
    }
    this.animateDying(c);
    this.syncLanes(entities, c);
    this.syncPanel(quiz, c);
  }

  private onDeath(v: View, c: FrameCtx): void {
    if (v.kind === 'player' || v.kind === 'runner') {
      this.particles.emit('smoke', v.px, v.py, 1);
      this.particles.emit('burst', v.px, v.py, 0.5);
    } else if (v.kind === 'item') {
      this.particles.one('ring', v.px, v.py, { s0: 0.4, grow: 1.6, life: 0.3, tint: hexToNum(c.palette.glow) });
    }
  }

  private animateDying(c: FrameCtx): void {
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i]!;
      const k = (c.vt - v.dieAt!) / DIE_SEC;
      if (k >= 1) {
        this.dying.splice(i, 1);
        this.release(v);
        continue;
      }
      const s = v.kind === 'item' ? 1 + k * 0.6 : 1 - k;
      v.root.scale.set(s);
      v.root.alpha = 1 - k;
      v.floor.alpha = v.over.alpha = 1 - k;
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
    v.face = 1;
    v.srcKey = '';
    v.tex = undefined;
    v.swapAt = -9;
    v.flags = {};
    v.dieAt = undefined;
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
    if (v.aura) v.aura.visible = false;
    if (v.marks) for (const m of v.marks) m.visible = false;
    if (v.crown) v.crown.visible = false;
    v.g?.clear();
    v.og?.clear();
    return v;
  }

  /** Park a finished view in its kind's pool (hidden), or destroy it if the pool is full. */
  private release(v: View): void {
    const list = this.pool.get(v.kind) ?? [];
    if (list.length >= POOL_MAX) {
      v.root.destroy({ children: true });
      v.floor.destroy({ children: true });
      v.over.destroy({ children: true });
      return;
    }
    v.root.visible = v.floor.visible = v.over.visible = false;
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
    this.laneKey = '';
    this.lanes.clear();
    this.quiz?.destroy();
    this.quiz = undefined;
  }

  private place(v: View, x: number, y: number, size: number, tex: Texture, anchorY = 0.5): number {
    const k = size / Math.max(1, tex.width, tex.height);
    v.root.position.set(x, y);
    v.root.zIndex = y;
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

    const dx = x - v.px;
    const speed = c.dt > 0 ? Math.hypot(dx, y - v.py) / c.dt : 0;
    if (Math.abs(dx) > 0.4) v.face = dx < 0 ? -1 : 1;
    const moving = Math.min(1, speed / 220);
    const jump = num(e.props.jump);
    const hop = jump > 0 ? Math.sin(jump * Math.PI) * 34 : Math.abs(Math.sin(c.vt * 11 + e.id)) * 5 * moving;
    const size = e.r * 3.6 * (e.kind === 'runner' ? 0.85 : 1);
    const k = this.place(v, x, y - hop, size, tex, 0.72) * this.popScale(v, c);
    const tiptoe = e.props.tiptoe === true;
    const dashing = e.props.dashing === true;
    const squash = 1 + Math.sin(c.vt * 22 + e.id) * 0.05 * moving;
    v.body.scale.set(k * v.face * (dashing ? 1.15 : 1) / squash, k * squash * (tiptoe ? 0.9 : 1) * (dashing ? 0.9 : 1));
    const lean = e.props.pulling === true ? (e.team === 0 ? -0.22 : 0.22) : Math.max(-0.18, Math.min(0.18, (dx / Math.max(1e-3, c.dt)) * 0.0004));
    v.body.rotation = fx.wobble + lean;
    v.body.alpha = fx.alpha * (tiptoe ? 0.82 : 1) * (e.kind === 'runner' && e.props.leg !== undefined ? 0.75 : 1);
    this.shadowAt(v, x, y + e.r * 0.55, e.r * 2.2 * (1 - Math.min(0.4, hop / 80)), e.r * 0.8, 0.4);

    // team / player ring under the feet
    if (!v.g) {
      v.g = new Graphics();
      v.floor.addChild(v.g);
    }
    if (v.flags.ringColor !== color) {
      v.flags.ringColor = color;
      v.g.clear().ellipse(0, 0, e.r * 1.25, e.r * 0.5).stroke({ width: 4, color, alpha: 0.9 }).ellipse(0, 0, e.r * 1.25, e.r * 0.5).fill({ color, alpha: 0.18 });
    }
    v.g.position.set(x, y + e.r * 0.55);

    // comeback boost aura
    const boosted = num(e.props.boost, 1) > 1.001;
    if (boosted || v.aura) {
      if (!v.aura) {
        v.aura = new Sprite(this.store.cell('glow'));
        v.aura.anchor.set(0.5);
        v.aura.blendMode = 'add';
        v.floor.addChildAt(v.aura, 0);
      }
      v.aura.visible = boosted;
      v.aura.tint = hexToNum(c.palette.glow);
      v.aura.position.set(x, y);
      const s = (e.r * 4) / 64 * (1 + Math.sin(c.vt * 6) * 0.1);
      v.aura.scale.set(s);
      v.aura.alpha = 0.55;
      if (boosted && !c.degraded && Math.random() < c.dt * 6) {
        this.particles.one('spark', x + (Math.random() - 0.5) * e.r * 2, y, { vy: -70, life: 0.6, s0: 0.25, tint: hexToNum(c.palette.glow) });
      }
    }
    if (dashing && !c.degraded) this.particles.one('soft', x, y, { life: 0.25, s0: e.r / 32, tint: color, add: false, a0: 0.45 });
    if (fx.stunned && !c.degraded && Math.random() < c.dt * 10) {
      const a = c.vt * 8;
      this.particles.one('star', x + Math.cos(a) * e.r, y - size * 0.75, { life: 0.4, s0: 0.22, tint: 0xffe066 });
    }

    // name plate
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
      v.name.position.set(x, Math.max(18, y - hop - size * 0.72 - 20));
      // fade plates that slide under the timer pill
      const underTimer = v.name.y < 120 && Math.abs(x - this.arenaW / 2) < 140;
      v.name.alpha = (pl.connected ? 1 : 0.45) * (underTimer ? 0.3 : 1);
      const lead = c.leader === owner;
      if (lead && !v.crown) {
        v.crown = new Sprite(this.store.cell('crown'));
        v.crown.anchor.set(0.5);
        v.crown.tint = 0xffd23f;
        v.crown.scale.set(0.5);
        v.over.addChild(v.crown);
      }
      if (v.crown) {
        v.crown.visible = lead;
        v.crown.position.set(x, y - hop - size * 0.72 - 44 + Math.sin(c.vt * 4) * 2);
      }
    }
  }

  // ---------- dodge ----------

  private hazard(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const src = this.source(e.sprite, c, 'hazard');
    const tex = this.texFor(v, src, c, 'hazard');
    const tg = telegraphState(e.props, c.time);
    const heading = src.type === 'url' ? ART_HEADING[src.key] : undefined;
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
    const [ring, fill, ...arrows] = v.marks;
    const show = !tg.armed;
    ring!.visible = fill!.visible = show;
    for (const a of arrows) a.visible = show && tg.arrow !== null;
    if (show) {
      const d = (e.r * 2.3) / 56;
      ring!.position.set(x, y);
      ring!.scale.set(d);
      ring!.tint = accent;
      ring!.alpha = 0.55 + 0.45 * tg.progress;
      fill!.position.set(x, y);
      fill!.scale.set(d * 1.6 * tg.progress);
      fill!.tint = accent;
      fill!.alpha = 0.28;
      if (tg.arrow) {
        const ang = Math.atan2(tg.arrow.dy, tg.arrow.dx);
        arrows.forEach((a, i) => {
          const off = e.r + 14 + i * 20;
          a.position.set(x + tg.arrow!.dx * off, y + tg.arrow!.dy * off);
          a.rotation = ang;
          a.scale.set(0.45);
          a.tint = 0xffffff;
          // chase-light down the arrow, faster as arming nears
          a.alpha = 0.35 + 0.65 * Math.max(0, Math.sin(c.vt * (6 + 10 * tg.progress) - i * 0.9));
        });
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
    const punch = c.vt - num(v.flags.armedAt, -9) < 0.2 ? 1 + 0.35 * Math.sin(((c.vt - num(v.flags.armedAt)) / 0.2) * Math.PI) : 1;
    const scale = (tg.armed ? 1 : 0.75 + 0.25 * tg.progress) * punch;
    this.place(v, x, y, e.r * 2.5 * scale * this.popScale(v, c), tex);
    v.body.alpha = tg.alpha;
    const vx = tg.armed ? e.vx : num(e.props.ax), vy = tg.armed ? e.vy : num(e.props.ay);
    if (heading !== undefined && (vx !== 0 || vy !== 0)) {
      // directional art (a comet tail) flies nose-first
      v.body.rotation = Math.atan2(vy, vx) - heading;
    } else {
      v.body.rotation = tg.armed ? (v.body.rotation + c.dt * 3) % (Math.PI * 2) : Math.sin(c.vt * 9) * 0.08 * tg.progress;
    }
    this.shadowAt(v, x, y + e.r * 0.7, e.r * 2, e.r * 0.7, 0.3 * tg.alpha);
    const moving = e.vx !== 0 || e.vy !== 0;
    if (tg.armed && moving && !c.degraded && e.id % 3 === 0 && this.particles.budget.active < this.particles.budget.cap * 0.5 && Math.random() < c.dt * 18) {
      this.particles.one('glow', x - e.vx * 0.03, y - e.vy * 0.03, {
        life: 0.35, s0: e.r / 40, grow: -0.6, tint: Math.random() < 0.5 ? accent : hexToNum(c.palette.glow), a0: 0.7,
      });
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
      v.body.visible = false;
      v.shadow.visible = false;
    }
    const col = hexToNum(c.palette.primary);
    const [glow, ring] = v.marks;
    glow!.visible = ring!.visible = true;
    const pulse = 1 + Math.sin(c.vt * 2.5) * 0.04;
    glow!.position.set(x, y);
    glow!.scale.set(((e.r * 2.4) / 64) * pulse);
    glow!.tint = col;
    glow!.alpha = 0.35;
    ring!.position.set(x, y);
    ring!.scale.set(((e.r * 2) / 56) * pulse);
    ring!.tint = lighten(col, 0.3);
    ring!.alpha = 0.8;
    v.root.position.set(x, y);
    v.root.zIndex = -1e6;
  }

  // ---------- sneak ----------

  private guard(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const gv = guardVisual(e.props);
    const guardKind = typeof e.props.guardKind === 'string' ? e.props.guardKind : undefined;
    const tex = this.texFor(v, this.source(e.sprite, c, 'guard', gv.awake ? 'awake' : undefined, guardKind), c, 'guard');
    if (gv.awake && v.flags.awake === false) {
      v.flags.awokeAt = c.vt;
      this.particles.emit('burst', x, y - e.r, 0.6);
    }
    v.flags.awake = gv.awake;
    const sinceWake = c.vt - num(v.flags.awokeAt, -9);
    const shake = gv.waking || e.props.stirring === true ? Math.sin(c.vt * 40) * 3 : 0;
    const breathe = gv.awake ? 1 : 1 + Math.sin(c.vt * 2.2) * 0.03;
    const punch = sinceWake < 0.3 ? 1 + 0.25 * Math.sin((sinceWake / 0.3) * Math.PI) : 1;
    const size = Math.max(110, e.r * 3.2);
    const k = this.place(v, x + shake, y, size, tex, 0.62);
    const m = punch * this.popScale(v, c);
    v.body.scale.set(k * m, k * breathe * m);
    // generated art has no awake variant: tint it angry
    v.body.tint = gv.awake && !(v.tex && this.isAwakeArt(e, c, guardKind)) ? 0xff9a9a : 0xffffff;
    this.shadowAt(v, x, y + size * 0.3, size * 0.9, size * 0.3, 0.4);

    if (!v.g) {
      v.g = new Graphics();
      v.floor.addChildAt(v.g, 0);
      v.og = new Graphics();
      v.over.addChild(v.og);
      v.texts = ['z', 'z', 'Z', '!'].map((s, i) => {
        const t = label(s, i === 3 ? 56 : 26 + i * 6, i === 3 ? hexToNum(c.palette.accent) : 0xffffff, { display: true });
        v.over.addChild(t);
        return t;
      });
    }
    const g = v.g;
    g.clear();
    const hearing = num(e.props.hearingRadius);
    if (hearing > 0 && !gv.awake) {
      g.circle(x, y, hearing).stroke({ width: 2, color: lighten(gv.noiseColor, 0.2), alpha: 0.12 + gv.noise * 0.25 });
      g.circle(x, y, hearing).fill({ color: gv.noiseColor, alpha: 0.03 + gv.noise * 0.06 });
    }
    if (gv.cone) {
      const { facing, half, range } = gv.cone;
      const col = gv.awake ? 0xff3b3b : 0xffe08a;
      g.moveTo(x, y).arc(x, y, range, facing - half, facing + half).lineTo(x, y).fill({ color: col, alpha: gv.awake ? 0.22 : 0.12 });
      g.moveTo(x, y).arc(x, y, range * 0.55, facing - half, facing + half).lineTo(x, y).fill({ color: col, alpha: 0.1 });
      g.moveTo(x, y).arc(x, y, range, facing - half, facing + half).lineTo(x, y).stroke({ width: 2, color: col, alpha: 0.5 });
    }

    // noise meter
    const og = v.og!;
    og.clear();
    const mw = 96, my = y - size * 0.62 - 26;
    og.roundRect(x - mw / 2 - 3, my - 3, mw + 6, 16, 8).fill({ color: 0x0b0b18, alpha: 0.7 });
    if (gv.noise > 0.01) og.roundRect(x - mw / 2, my, mw * gv.noise, 10, 5).fill({ color: gv.noiseColor });
    if (gv.noise > 0.8 && !gv.awake) og.roundRect(x - mw / 2 - 3, my - 3, mw + 6, 16, 8).stroke({ width: 2, color: 0xff3b3b, alpha: 0.5 + 0.5 * Math.sin(c.vt * 20) });

    const [z1, z2, z3, bang] = v.texts!;
    const zs = [z1!, z2!, z3!];
    zs.forEach((t, i) => {
      t.visible = !gv.awake;
      const ph = (c.vt * 0.6 + i / 3) % 1;
      t.position.set(x + size * 0.25 + ph * 30 + Math.sin(ph * 6) * 6, my - 14 - ph * 50);
      t.alpha = Math.sin(ph * Math.PI) * 0.9;
    });
    bang!.visible = gv.awake;
    if (gv.awake) {
      const s = sinceWake < 0.35 ? easeOutBack(sinceWake / 0.35) : 1 + Math.sin(c.vt * 10) * 0.06;
      bang!.scale.set(s);
      bang!.position.set(x, my - 34);
    }
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
      v.shadow.visible = false;
      v.body.visible = false;
      v.texts = [label('SUDDEN DEATH', 40, hexToNum(c.palette.accent), { display: true })];
      v.over.addChild(v.texts[0]!);
    }
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

    const segs = v.marks!;
    while (segs.length < n) {
      const sp = new Sprite();
      sp.anchor.set(0.5);
      v.floor.addChild(sp);
      segs.push(sp);
    }
    const k = (segW / Math.max(1, segTex.width)) * 1.08;
    const sag = Math.sin(c.vt * 3) * 2;
    segs.forEach((sp, i) => {
      sp.visible = i < n;
      if (!sp.visible) return;
      sp.texture = segTex;
      sp.position.set(left - 180 + shift + i * segW, y + sag * Math.sin((i / n) * Math.PI));
      sp.scale.set(k);
      sp.rotation = segTex.width < segTex.height ? Math.PI / 2 : 0;
    });
    const knotS = v.knot!;
    const mk = this.source('rope-marker', c, 'item');
    knotS.texture = this.store.get(mk, fallbackShape('item', c.palette) as SpriteSource & { type: 'shape' });
    const beat = e.props.onBeat === true;
    knotS.scale.set((beat ? 1.25 : 1) * (56 / Math.max(1, knotS.texture.width, knotS.texture.height)));
    knotS.position.set(0, 0);
    v.root.position.set(knot, y);
    v.root.zIndex = y - 1;
    if (beat && v.flags.beat !== true) this.particles.one('ring', knot, y, { s0: 0.6, grow: 1.5, life: 0.35, tint: hexToNum(c.palette.glow) });
    v.flags.beat = beat;
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
    const bob = carried ? 0 : Math.sin(c.vt * 3.2 + e.id * 1.7) * 4;
    const size = e.r * 2.6 * (carried ? 0.8 : 1) * (golden ? 1.15 : 1);
    this.place(v, x, y - 6 + bob, size * this.popScale(v, c), tex);
    v.body.rotation = Math.sin(c.vt * 2 + e.id) * 0.12;
    v.root.zIndex = carried ? y + 1000 : y;
    this.shadowAt(v, x, y + e.r * 0.6, e.r * 1.8 * (1 - bob / 30), e.r * 0.55, carried ? 0 : 0.3);
    if (golden || v.aura) {
      if (!v.aura) {
        v.aura = new Sprite(this.store.cell('glow'));
        v.aura.anchor.set(0.5);
        v.aura.blendMode = 'add';
        v.floor.addChild(v.aura);
      }
      v.aura.visible = golden;
      v.aura.tint = 0xffc83d;
      v.aura.position.set(x, y - 6 + bob);
      v.aura.scale.set(((e.r * 4) / 64) * (1 + Math.sin(c.vt * 5) * 0.12));
      v.aura.alpha = 0.7;
      if (golden && !c.degraded && Math.random() < c.dt * 4) {
        this.particles.one('spark', x + (Math.random() - 0.5) * e.r * 2, y - e.r, { vy: -40, life: 0.6, s0: 0.22, tint: 0xfff1a8, spin: 4 });
      }
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
    this.place(v, x, y, Math.max(56, e.r * 1.4) * this.popScale(v, c), tex, 0.6);
    this.shadowAt(v, x, y + e.r * 0.3, e.r * 1.3, e.r * 0.4, 0.3);
  }

  private generic(v: View, e: Entity, x: number, y: number, c: FrameCtx): void {
    const tex = this.texFor(v, this.source(e.sprite, c, e.kind), c, e.kind);
    const mult = e.kind === 'baton' ? 4 : e.kind === 'boost-pad' ? 2.6 : e.kind === 'obstacle' ? 2.6 : 2.4;
    const size = Math.max(22, e.r * mult);
    const pad = e.kind === 'boost-pad';
    this.place(v, x, y, size * this.popScale(v, c) * (pad ? 1 + Math.sin(c.vt * 6 + e.id) * 0.05 : 1), tex);
    if (pad) {
      v.root.zIndex = -1e5 + y;
      v.shadow.visible = false;
      if (!v.aura) {
        v.aura = new Sprite(this.store.cell('glow'));
        v.aura.anchor.set(0.5);
        v.aura.blendMode = 'add';
        v.floor.addChild(v.aura);
      }
      v.aura.visible = true;
      v.aura.tint = hexToNum(c.palette.primary);
      v.aura.position.set(x, y);
      v.aura.scale.set((size * 1.4) / 64);
      v.aura.alpha = 0.35 + Math.sin(c.vt * 6 + e.id) * 0.15;
    } else {
      this.shadowAt(v, x, y + size * 0.35, size * 0.9, size * 0.3, 0.32);
    }
  }

  // ---------- race lanes ----------

  private syncLanes(entities: Entity[], c: FrameCtx): void {
    let lanes = 0;
    for (const e of entities) if (typeof e.props.lane === 'number' && (e.kind === 'obstacle' || e.kind === 'boost-pad' || e.props.mover === 'race')) lanes = Math.max(lanes, e.props.lane + 1);
    const key = `${lanes}|${c.palette.primary}|${this.arenaW}x${this.arenaH}`;
    if (key === this.laneKey) return;
    this.laneKey = key;
    const g = this.lanes;
    g.clear();
    if (lanes === 0) return;
    const W = this.arenaW, H = this.arenaH, lh = H / lanes;
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
    this.bodies.destroy({ children: true });
    this.overlay.destroy({ children: true });
  }
}

const OPTION_COLORS = [0xff4d6d, 0x3d8bff, 0xffb703, 0x2ec27e];

/** Big readable card for quiz (trivia) and board (draw-judge) entities. */
class PanelView {
  readonly root = new Container();
  private card = new Graphics();
  private title: Text;
  private sub: Text;
  private opts: { g: Graphics; t: Text; letter: Text }[] = [];
  private bar = new Graphics();
  private last = '';
  private phaseKey = '';
  private phaseLen = 1;
  private barKey = '';

  constructor(private W: number, private H: number) {
    this.title = label('', 40, 0xffffff, { display: true });
    this.title.style.wordWrap = true;
    this.title.style.wordWrapWidth = W * 0.78;
    this.sub = label('', 26, 0xffffff);
    this.root.addChild(this.card, this.title, this.sub, this.bar);
    for (let i = 0; i < 4; i++) {
      const g = new Graphics();
      const t = label('', 28, 0xffffff, { weight: '700' });
      t.style.wordWrap = true;
      t.style.wordWrapWidth = W * 0.3;
      const letter = label('ABCD'[i]!, 34, 0xffffff, { display: true });
      this.root.addChild(g, letter, t);
      this.opts.push({ g, t, letter });
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
        o.g.visible = o.t.visible = o.letter.visible = vis;
        if (!vis) return;
        const col = OPTION_COLORS[i]!;
        const reveal = phase === 'reveal';
        const right = reveal && answer === i;
        const ox = W * (i % 2 === 0 ? 0.08 : 0.51), oy = H * (0.45 + Math.floor(i / 2) * 0.19), ow = W * 0.41, oh = H * 0.16;
        o.g.clear().roundRect(ox, oy, ow, oh, 22).fill({ color: reveal && !right ? darken(col, 0.6) : col, alpha: reveal && !right ? 0.5 : 0.92 });
        if (right) o.g.roundRect(ox - 4, oy - 4, ow + 8, oh + 8, 26).stroke({ width: 6, color: 0xffffff });
        o.letter.position.set(ox + 40, oy + oh / 2);
        o.t.text = text;
        o.t.position.set(ox + ow / 2 + 20, oy + oh / 2);
        o.t.alpha = reveal && !right ? 0.6 : 1;
      });
    }
    this.title.position.set(W / 2, H * 0.245);
    this.sub.position.set(W / 2, H * 0.335);
    const timed = phase === 'question' || phase === 'drawing';
    let barKey = '';
    let frac = 0;
    if (timed && left > 0) {
      // the phase length is the largest time-left seen since the phase began
      if (this.phaseKey !== `${phase}|${P.index ?? P.round}`) {
        this.phaseKey = `${phase}|${P.index ?? P.round}`;
        this.phaseLen = left;
      }
      this.phaseLen = Math.max(this.phaseLen, left);
      frac = Math.min(1, left / this.phaseLen);
      // ~1 px steps at TV width: redraw only when the bar visibly moves
      barKey = `${Math.round(frac * 1000)}|${left < 5}|${c.palette.glow}`;
    }
    if (barKey !== this.barKey) {
      this.barKey = barKey;
      this.bar.clear();
      if (barKey) {
        const bw = W * 0.84;
        this.bar.roundRect(W * 0.08, H * 0.4, bw, 10, 5).fill({ color: 0xffffff, alpha: 0.15 });
        this.bar.roundRect(W * 0.08, H * 0.4, bw * frac, 10, 5).fill({ color: left < 5 ? 0xff4d6d : hexToNum(c.palette.glow) });
      }
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
