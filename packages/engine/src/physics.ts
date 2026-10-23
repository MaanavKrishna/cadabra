/**
 * Rigid-body physics (planck.js, a Box2D port) layered under the block system.
 *
 * Opt-in per spec (`spec.world.physics`, `spec.world.props`) or per block (`BlockDef.usesPhysics`).
 * Blocks keep writing entity x/y/vx/vy as before; the layer diffs entities against the state it
 * read back after the last step, so a block that sets a velocity (target-velocity steering, a
 * dash) or teleports an entity (respawn) is applied to its body, and everything else is
 * simulated: momentum, bounces, spin, stacking crates, a rolling ball.
 *
 * Bodies: every `player` (a circle; player vs player bumps stay with arena-move, which owns the
 * scoring bookkeeping) and every entity with `props.body` = 'dynamic' | 'static'
 * (`props.shape` 'circle' (r) | 'box' (hw, hh)). `props.group` 'loot' collides with walls and
 * props but not players (players drive through loot to grab it).
 *
 * Read back into props for renderers: `angle` (rad), `av` (rad/s), and on a hit `hitAt` (sim s)
 * and `impulse` (0..2, 1 ≈ a hard dash hit).
 */
import { BoxShape, CircleShape, EdgeShape, World as PWorld, type Body, type Contact as PContact } from 'planck';
import { PROP_KINDS, type PropKind, type WorldPhysics, type WorldProp } from '@cadabra/spec';
import type { FxEvent, GameEvent } from './fx';
import type { Rng } from './rng';
import type { Entity, World } from './world';

/** Pixels per planck metre (bodies are 0.5–2 m: the range Box2D is tuned for). */
export const PPM = 32;
const CAT_WALL = 0x1, CAT_PLAYER = 0x2, CAT_PROP = 0x4, CAT_LOOT = 0x8;
/** A crate's mass (the unit of `playerMass`). */
const CRATE_HALF = 22;
const CRATE_MASS = ((2 * CRATE_HALF) / PPM) ** 2;
/** Approach speed (px/s) that counts as an impact worth a squash / sparks. */
const IMPACT_MIN = 90;
/** Approach speed that maps to impulse 1. */
const IMPACT_REF = 600;
/** A barrel goes off when slammed this hard (px/s) or touched by a dashing player. */
export const BARREL_TRIGGER = 380;
export const BLAST_RADIUS = 220;
/** Seconds a bumper / blast victim can't steer (so the kick isn't steered away at once). */
const KICK_STUN = 0.22;
const BLAST_STUN = 0.45;
/** Kinds that may carry a body. */
const BODY_KINDS = ['player', ...PROP_KINDS, 'item'] as const;

export interface PhysicsContact {
  a: Entity;
  b: Entity;
  /** Unit normal from a to b. */
  nx: number;
  ny: number;
  x: number;
  y: number;
  /** Approach speed along the normal, px/s (≥ 0). */
  speed: number;
}

/** What blocks see as ctx.physics. */
export interface PhysicsApi {
  readonly params: Readonly<Required<WorldPhysics>>;
  /** Contacts that began during the last physics step. */
  contacts(): readonly PhysicsContact[];
  /** Radial blast: px/s at the centre falling off linearly to 0 at `radius`; credits `by`. */
  blast(x: number, y: number, radius: number, power: number, by?: string): void;
  /** Body mass in crate units (0 for static / no body). */
  massOf(e: Entity): number;
  /** Spawn a physics prop (ball/crate/bumper/barrel) at (x, y); `size` 1 ≈ a player. */
  spawnProp(kind: PropKind, x: number, y: number, size?: number, extra?: Entity['props']): Entity;
}

export interface PhysicsHost {
  world: World;
  rng: Rng;
  time(): number;
  emit(e: Omit<GameEvent, 't'>): void;
  fx(e: FxEvent): void;
}

interface Rec {
  body: Body;
  e: Entity;
  x: number; y: number; vx: number; vy: number; angle: number; av: number;
  r: number; hw: number; hh: number;
  active: boolean;
  isStatic: boolean;
}

interface Respawn { kind: PropKind; x: number; y: number; size: number; at: number; extra: Entity['props'] }

const num = (v: unknown, d = 0): number => (typeof v === 'number' ? v : d);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

export function propRadius(kind: PropKind, size = 1): number {
  switch (kind) {
    case 'ball': return 24 * size;
    case 'bumper': return 28 * size;
    case 'barrel': return 20 * size;
    case 'crate': return CRATE_HALF * size * Math.SQRT2;
  }
}

export class Physics implements PhysicsApi {
  readonly params: Required<WorldPhysics>;
  private readonly host: PhysicsHost;
  private readonly pw: PWorld;
  private readonly recs = new Map<number, Rec>();
  private began: PhysicsContact[] = [];
  private last: PhysicsContact[] = [];
  private readonly respawns: Respawn[] = [];
  private fxBudget = 0;
  private stepN = 0;

  constructor(host: PhysicsHost, params: Required<WorldPhysics>) {
    this.host = host;
    this.params = params;
    this.pw = new PWorld({ gravity: { x: params.gravityX / PPM, y: params.gravityY / PPM } });
    if (params.walls) {
      const { width: w, height: h } = host.world;
      const wall = this.pw.createBody({ type: 'static' });
      const corners = [[0, 0], [w, 0], [w, h], [0, h]] as const;
      for (let i = 0; i < 4; i++) {
        const [x1, y1] = corners[i]!, [x2, y2] = corners[(i + 1) % 4]!;
        wall.createFixture({
          shape: new EdgeShape({ x: x1 / PPM, y: y1 / PPM }, { x: x2 / PPM, y: y2 / PPM }),
          restitution: params.restitution, friction: params.friction,
          filterCategoryBits: CAT_WALL, filterMaskBits: CAT_PROP | CAT_LOOT,
        });
      }
    }
    this.pw.on('begin-contact', (c: PContact) => this.onBegin(c));
  }

  contacts(): readonly PhysicsContact[] {
    return this.last;
  }

  massOf(e: Entity): number {
    const r = this.recs.get(e.id);
    return r && !r.isStatic ? r.body.getMass() / CRATE_MASS : 0;
  }

  spawnProp(kind: PropKind, x: number, y: number, size = 1, extra: Entity['props'] = {}): Entity {
    const r = propRadius(kind, size);
    const props: Entity['props'] = { body: kind === 'bumper' ? 'static' : 'dynamic', shape: kind === 'crate' ? 'box' : 'circle', size, angle: 0, av: 0, ...extra };
    if (kind === 'crate') { props.hw = CRATE_HALF * size; props.hh = CRATE_HALF * size; }
    return this.host.world.spawn(kind, x, y, { r, sprite: kind, props });
  }

  /** Spawn the spec's `world.props` (after blocks set up, so layouts see the arena they built). */
  spawnWorldProps(props: readonly WorldProp[]): void {
    const { width: w, height: h } = this.host.world;
    const rng = this.host.rng;
    const cx = w / 2, cy = h / 2;
    for (const p of props) {
      const size = p.size ?? 1;
      const n = p.count;
      for (let i = 0; i < n; i++) {
        let x = cx, y = cy;
        switch (p.layout ?? 'scatter') {
          case 'center': {
            const a = (i / n) * Math.PI * 2, d = n === 1 ? 0 : 30 + 12 * n;
            x = cx + Math.cos(a) * d; y = cy + Math.sin(a) * d;
            break;
          }
          case 'ring': {
            const a = (i / n) * Math.PI * 2 + Math.PI / 4, d = p.radius ?? 200;
            x = cx + Math.cos(a) * d; y = cy + Math.sin(a) * d;
            break;
          }
          case 'edges': {
            const side = i % 4, f = (Math.floor(i / 4) + 1) / (Math.ceil(n / 4) + 1);
            const m = 70;
            [x, y] = side === 0 ? [w * f, m] : side === 1 ? [w - m, h * f] : side === 2 ? [w * (1 - f), h - m] : [m, h * (1 - f)];
            break;
          }
          case 'corners': {
            const m = 110, k = i % 4, ring = Math.floor(i / 4) * 50;
            x = k % 2 === 0 ? m + ring : w - m - ring;
            y = k < 2 ? m : h - m;
            break;
          }
          default:
            x = rng.range(w * 0.12, w * 0.88);
            y = rng.range(h * 0.15, h * 0.85);
        }
        this.spawnProp(p.kind, x, y, size, { home: `${Math.round(x)},${Math.round(y)}`, respawnSec: p.respawnSec ?? 6 });
      }
    }
  }

  blast(x: number, y: number, radius: number, power: number, by?: string): void {
    const t = this.host.time();
    for (const rec of this.recs.values()) {
      if (rec.isStatic || !rec.active) continue;
      const e = rec.e;
      const dx = e.x - x, dy = e.y - y, d = Math.hypot(dx, dy);
      if (d > radius || d < 1e-6) continue;
      const k = power * (1 - d / radius);
      const isPlayer = e.kind === 'player';
      const mul = isPlayer ? this.params.knockback / Math.sqrt(this.params.playerMass) : 1;
      e.vx += (dx / d) * k * mul;
      e.vy += (dy / d) * k * mul;
      if (this.params.spin) e.props.av = num(e.props.av) + ((dx * 7 + dy * 3) % 2 > 0 ? 1 : -1) * k / 60;
      e.props.hitAt = t;
      e.props.impulse = Math.min(2, k / IMPACT_REF);
      if (isPlayer) e.props.stunUntil = Math.max(num(e.props.stunUntil), t + BLAST_STUN);
      else if (by) { e.props.touchedBy = by; e.props.touchedAt = t; }
      if (isPlayer && by && e.owner !== by) { e.props.touchedBy = by; e.props.touchedAt = t; e.props.shovedBy = by; e.props.shovedAt = t; }
    }
  }

  /** One fixed step: entity → body diffs, planck step, body → entity, contact rules. */
  step(dt: number): void {
    this.stepN++;
    this.fxBudget = Math.min(6, this.fxBudget + dt * 6);
    this.syncIn();
    this.began = [];
    this.pw.step(dt, 8, 3);
    this.readBack();
    this.last = this.began;
    this.rules();
    this.respawn();
  }

  /** True when `e` is moved by its body this step (the runtime integrates everything else). */
  owns(e: Entity): boolean {
    const r = this.recs.get(e.id);
    return !!r && r.active;
  }

  // ---------------------------------------------------------------- internals

  private wants(e: Entity): boolean {
    return e.kind === 'player' || e.props.body === 'dynamic' || e.props.body === 'static';
  }

  private activeFor(e: Entity): boolean {
    if (e.props.out === true || e.props.exploded === true || e.props.ghost === true) return false;
    const c = e.props.carriedBy;
    return !(typeof c === 'string' && c !== '');
  }

  private create(e: Entity): Rec {
    const P = this.params;
    const isPlayer = e.kind === 'player';
    const isStatic = e.props.body === 'static';
    const loot = e.props.group === 'loot';
    const body = this.pw.createBody({
      type: isStatic ? 'static' : 'dynamic',
      position: { x: e.x / PPM, y: e.y / PPM },
      angle: num(e.props.angle),
      linearVelocity: { x: e.vx / PPM, y: e.vy / PPM },
      angularVelocity: num(e.props.av),
      linearDamping: isPlayer ? 0 : num(e.props.damping, P.linearDamping),
      angularDamping: P.angularDamping,
      fixedRotation: !P.spin,
      bullet: e.kind === 'ball',
      gravityScale: isPlayer ? 0.35 : 1,
      userData: e.id,
    });
    const box = e.props.shape === 'box';
    const hw = num(e.props.hw, e.r), hh = num(e.props.hh, e.r);
    const shape = box ? new BoxShape(hw / PPM, hh / PPM) : new CircleShape(e.r / PPM);
    const area = box ? (4 * hw * hh) / (PPM * PPM) : (Math.PI * e.r * e.r) / (PPM * PPM);
    const mass = isPlayer ? P.playerMass * CRATE_MASS : num(e.props.mass, e.kind === 'ball' ? 0.35 : e.kind === 'barrel' ? 1.1 : 1) * CRATE_MASS;
    body.createFixture({
      shape,
      density: isStatic ? 0 : mass / area,
      friction: P.friction,
      restitution: num(e.props.restitution, P.restitution),
      filterCategoryBits: isPlayer ? CAT_PLAYER : loot ? CAT_LOOT : CAT_PROP,
      filterMaskBits: isPlayer ? CAT_PROP : loot ? CAT_WALL | CAT_PROP | CAT_LOOT : CAT_WALL | CAT_PLAYER | CAT_PROP | CAT_LOOT,
    });
    const rec: Rec = { body, e, x: e.x, y: e.y, vx: e.vx, vy: e.vy, angle: num(e.props.angle), av: num(e.props.av), r: e.r, hw, hh, active: true, isStatic };
    this.recs.set(e.id, rec);
    return rec;
  }

  private syncIn(): void {
    const world = this.host.world;
    for (const [id, rec] of this.recs) {
      if (world.get(id) !== rec.e || !this.wants(rec.e)) {
        this.pw.destroyBody(rec.body);
        this.recs.delete(id);
      }
    }
    for (const kind of BODY_KINDS) {
      for (const e of world.ofKind(kind)) {
        if (!this.wants(e)) continue;
        let rec = this.recs.get(e.id);
        if (rec && (!near(rec.r, e.r) || !near(rec.hw, num(e.props.hw, e.r)))) {
          this.pw.destroyBody(rec.body);
          this.recs.delete(e.id);
          rec = undefined;
        }
        if (!rec) rec = this.create(e);
        const active = this.activeFor(e);
        if (active !== rec.active) { rec.body.setActive(active); rec.active = active; }
        if (!active) continue;
        const b = rec.body;
        const angle = num(e.props.angle);
        if (!near(e.x, rec.x) || !near(e.y, rec.y) || !near(angle, rec.angle)) {
          b.setTransform({ x: e.x / PPM, y: e.y / PPM }, angle);
          b.setAwake(true);
        }
        if (rec.isStatic) continue;
        if (!near(e.vx, rec.vx) || !near(e.vy, rec.vy)) { b.setLinearVelocity({ x: e.vx / PPM, y: e.vy / PPM }); b.setAwake(true); }
        const av = num(e.props.av);
        if (!near(av, rec.av)) b.setAngularVelocity(av);
      }
    }
  }

  private readBack(): void {
    for (const rec of this.recs.values()) {
      if (!rec.active) continue;
      const e = rec.e, b = rec.body;
      if (!rec.isStatic) {
        const p = b.getPosition(), v = b.getLinearVelocity();
        e.x = p.x * PPM; e.y = p.y * PPM;
        e.vx = v.x * PPM; e.vy = v.y * PPM;
        e.props.angle = b.getAngle();
        e.props.av = b.getAngularVelocity();
      }
      rec.x = e.x; rec.y = e.y; rec.vx = e.vx; rec.vy = e.vy;
      rec.angle = num(e.props.angle); rec.av = num(e.props.av);
    }
  }

  private onBegin(c: PContact): void {
    const fa = c.getFixtureA(), fb = c.getFixtureB();
    const ba = fa.getBody(), bb = fb.getBody();
    const ia = ba.getUserData() as number | null, ib = bb.getUserData() as number | null;
    if (ia == null || ib == null) {
      // wall hit: impact props on the moving body
      const body = ia == null ? bb : ba, id = (ia ?? ib) as number | null;
      const rec = id == null ? undefined : this.recs.get(id);
      if (!rec) return;
      const v = body.getLinearVelocity(), wm = c.getWorldManifold(null);
      const n = wm?.normal ?? { x: 0, y: 0 };
      const speed = Math.abs((v.x * n.x + v.y * n.y) * PPM);
      this.impact(rec.e, speed, rec.e.x, rec.e.y);
      return;
    }
    const ra = this.recs.get(ia), rb = this.recs.get(ib);
    if (!ra || !rb) return;
    const wm = c.getWorldManifold(null);
    const nx = wm?.normal.x ?? 1, ny = wm?.normal.y ?? 0;
    const va = ba.getLinearVelocity(), vb = bb.getLinearVelocity();
    const speed = Math.max(0, ((va.x - vb.x) * nx + (va.y - vb.y) * ny) * PPM);
    const pt = wm?.points[0];
    const x = pt ? pt.x * PPM : (ra.e.x + rb.e.x) / 2, y = pt ? pt.y * PPM : (ra.e.y + rb.e.y) / 2;
    this.began.push({ a: ra.e, b: rb.e, nx, ny, x, y, speed });
  }

  private impact(e: Entity, speed: number, x: number, y: number): void {
    if (speed < IMPACT_MIN) return;
    const t = this.host.time();
    e.props.hitAt = t;
    e.props.impulse = Math.min(2, speed / IMPACT_REF);
    if (speed > 320 && this.fxBudget >= 1) {
      this.fxBudget--;
      this.host.fx({ kind: 'particles', preset: e.kind === 'crate' ? 'smoke' : 'burst', x, y });
      this.host.fx({ kind: 'sfx', name: e.kind === 'ball' ? 'kick' : e.kind === 'crate' ? 'crate' : 'hit' });
    }
  }

  /** Generic contact rules: impacts, touch credit, bumper kicks, barrels. */
  private rules(): void {
    const t = this.host.time();
    const P = this.params;
    const boom: [Entity, string | undefined][] = [];
    for (const c of this.last) {
      for (const [self, other, sgn] of [[c.a, c.b, -1], [c.b, c.a, 1]] as const) {
        this.impact(self, c.speed, c.x, c.y);
        // touch credit: players tag props; moving props pass a recent tag on (chain hits)
        if (self.kind !== 'player' && self.props.body === 'dynamic') {
          if (other.kind === 'player' && other.owner !== undefined) {
            self.props.touchedBy = other.owner; self.props.touchedAt = t;
          } else if (typeof other.props.touchedBy === 'string' && t - num(other.props.touchedAt) < 3 && num(other.props.touchedAt) > num(self.props.touchedAt, -1)) {
            self.props.touchedBy = other.props.touchedBy; self.props.touchedAt = num(other.props.touchedAt);
          }
        }
        if (self.kind === 'bumper' && other.props.body !== 'static') {
          // pinball kick: fire `other` away from the bumper (normal points a→b)
          const kx = c.nx * -sgn, ky = c.ny * -sgn;
          const k = P.bumperKick * (other.kind === 'player' ? P.knockback / Math.sqrt(P.playerMass) : 1);
          other.vx += kx * k; other.vy += ky * k;
          self.props.hitAt = t;
          self.props.impulse = Math.min(2, (c.speed + k) / IMPACT_REF);
          if (other.kind === 'player') other.props.stunUntil = Math.max(num(other.props.stunUntil), t + KICK_STUN);
          this.host.emit({ type: 'phys.bumper', player: other.kind === 'player' ? other.owner : undefined, data: { x: self.x, y: self.y } });
          this.host.fx({ kind: 'sfx', name: 'bumper' });
        }
        if (self.kind === 'barrel' && self.props.exploded !== true) {
          const dashing = other.kind === 'player' && other.props.dashing === true;
          if (dashing || c.speed >= BARREL_TRIGGER) {
            const by = other.kind === 'player' ? other.owner : typeof other.props.touchedBy === 'string' ? other.props.touchedBy : undefined;
            boom.push([self, by]);
          }
        }
      }
    }
    for (const [b, by] of boom) this.explode(b, by);
  }

  /** Detonate a barrel: blast, event, removal and (optional) respawn at its spawn point. */
  explode(b: Entity, by?: string): void {
    if (b.props.exploded === true || !this.host.world.get(b.id)) return;
    b.props.exploded = true;
    this.blast(b.x, b.y, BLAST_RADIUS, this.params.barrelPower, by);
    const data: Record<string, unknown> = { x: b.x, y: b.y, moment: 'detonate' };
    if (by) data.by = by;
    this.host.emit(by ? { type: 'explode', player: by, data } : { type: 'explode', data });
    this.host.fx({ kind: 'shake', strength: 0.5 });
    this.host.fx({ kind: 'particles', preset: 'burst', x: b.x, y: b.y });
    this.host.fx({ kind: 'sfx', name: 'boom' });
    this.queueRespawn(b);
    this.host.world.remove(b.id);
  }

  /** Remember a prop that left play so it returns after its respawnSec (0 = never). */
  queueRespawn(e: Entity): void {
    const sec = num(e.props.respawnSec, 0);
    if (sec <= 0 || !(PROP_KINDS as readonly string[]).includes(e.kind)) return;
    const [hx, hy] = typeof e.props.home === 'string' ? e.props.home.split(',').map(Number) : [e.x, e.y];
    const extra: Entity['props'] = {};
    for (const k of ['home', 'respawnSec', 'restitution', 'mass', 'damping'] as const) if (e.props[k] !== undefined) extra[k] = e.props[k]!;
    this.respawns.push({ kind: e.kind as PropKind, x: hx!, y: hy!, size: num(e.props.size, 1), at: this.host.time() + sec, extra });
  }

  private respawn(): void {
    const world = this.host.world;
    // dynamic props with no floor under them (ring-out platform) fall out of play
    if (this.stepN % 6 === 0 && world.ofKind('tile').size > 0) {
      const gone: Entity[] = [];
      for (const rec of this.recs.values()) {
        const e = rec.e;
        if (e.kind === 'player' || e.props.group === 'loot' || !rec.active) continue;
        if (!onTiles(world, e.x, e.y)) gone.push(e);
      }
      for (const e of gone) {
        this.host.emit({ type: 'phys.fall', data: { kind: e.kind, x: e.x, y: e.y } });
        this.queueRespawn(e);
        world.remove(e.id);
      }
    }
    if (this.respawns.length === 0) return;
    const t = this.host.time();
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i]!;
      if (t < r.at) continue;
      this.respawns.splice(i, 1);
      let { x, y } = r;
      if (world.ofKind('tile').size > 0 && !onTiles(world, x, y)) { x = world.width / 2; y = world.height / 2; }
      this.spawnProp(r.kind, x, y, r.size, { ...r.extra, spawnedAt: t });
    }
  }
}

function onTiles(world: World, x: number, y: number): boolean {
  for (const t of world.ofKind('tile')) {
    const hw = num(t.props.hw, t.r), hh = num(t.props.hh, t.r);
    if (Math.abs(x - t.x) <= hw && Math.abs(y - t.y) <= hh) return true;
  }
  return false;
}
