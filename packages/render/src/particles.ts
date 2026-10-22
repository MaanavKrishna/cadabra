import { Container, Particle, ParticleContainer } from 'pixi.js';
import { FxBudget, PARTICLE_PRESETS, type ParticlePreset, type ParticleTex } from './juice';
import type { Palette } from './theme';
import { hexToNum } from './theme';
import type { TextureStore } from './textures';

interface Live {
  p: Particle;
  add: boolean;
  vx: number;
  vy: number;
  age: number;
  life: number;
  s0: number;
  grow: number;
  spin: number;
  gravity: number;
  drag: number;
  a0: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Two ParticleContainers (normal + additive) over one atlas texture, fed from a fixed pool
 * and gated by FxBudget so a burst storm can never sink the frame rate.
 */
export class ParticleSystem {
  readonly view = new Container();
  private normal: ParticleContainer;
  private additive: ParticleContainer;
  private live: Live[] = [];
  private pool: Particle[] = [];
  private palette: Palette = { bg: '#101030', primary: '#4cc9f0', accent: '#f72585', glow: '#ffd166', text: '#ffffff' };

  constructor(private readonly store: TextureStore, readonly budget: FxBudget) {
    const opts = {
      texture: store.atlasTex,
      dynamicProperties: { position: true, rotation: true, vertex: true, color: true, uvs: true },
    };
    this.normal = new ParticleContainer(opts);
    this.additive = new ParticleContainer(opts);
    this.additive.blendMode = 'add';
    this.view.addChild(this.normal, this.additive);
  }

  setPalette(p: Palette): void {
    this.palette = p;
  }

  get count(): number {
    return this.live.length;
  }

  private color(c: ParticlePreset['colors'][number]): number {
    return typeof c === 'number' ? c : hexToNum(this.palette[c]);
  }

  /** Emit a named preset; `scale` multiplies the count. Returns particles granted. */
  emit(preset: string, x: number, y: number, scale = 1, dir?: number): number {
    const P = PARTICLE_PRESETS[preset];
    if (!P) return 0;
    const n = this.budget.request(Math.max(1, Math.round(P.count * scale)));
    for (let i = 0; i < n; i++) this.spawn(P, x, y, dir);
    return n;
  }

  /** A single custom particle (trails, embers, motes). */
  one(tex: ParticleTex, x: number, y: number, o: Partial<Omit<Live, 'p' | 'add' | 'age'>> & { tint?: number; add?: boolean; rot?: number }): void {
    if (this.budget.request(1) === 0) return;
    const p = this.take(tex);
    p.x = x;
    p.y = y;
    p.rotation = o.rot ?? 0;
    p.tint = o.tint ?? 0xffffff;
    const s0 = o.s0 ?? 0.5;
    p.scaleX = p.scaleY = s0;
    const a0 = o.a0 ?? 1;
    p.alpha = a0;
    const add = o.add ?? true;
    (add ? this.additive : this.normal).addParticle(p);
    this.live.push({
      p, add, vx: o.vx ?? 0, vy: o.vy ?? 0, age: 0, life: o.life ?? 0.5, s0, grow: o.grow ?? 0, spin: o.spin ?? 0,
      gravity: o.gravity ?? 0, drag: o.drag ?? 0, a0,
    });
  }

  private take(tex: ParticleTex): Particle {
    const t = this.store.cell(tex);
    const p = this.pool.pop() ?? new Particle({ texture: t, anchorX: 0.5, anchorY: 0.5 });
    p.texture = t;
    p.anchorX = p.anchorY = 0.5;
    return p;
  }

  private spawn(P: ParticlePreset, x: number, y: number, dir?: number): void {
    const tex = P.tex[(Math.random() * P.tex.length) | 0]!;
    const p = this.take(tex);
    const a = (dir ?? P.dir) + (Math.random() - 0.5) * P.spread;
    const sp = rand(P.speed[0], P.speed[1]);
    const s0 = rand(P.scale[0], P.scale[1]);
    p.x = x;
    p.y = y;
    p.rotation = Math.random() * Math.PI * 2;
    p.scaleX = s0;
    p.scaleY = tex === 'confetti' ? s0 * rand(0.5, 1) : s0;
    p.tint = this.color(P.colors[(Math.random() * P.colors.length) | 0]!);
    const a0 = P.alpha ?? 1;
    p.alpha = a0;
    const add = P.additive === true;
    (add ? this.additive : this.normal).addParticle(p);
    this.live.push({
      p, add, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, life: rand(P.life[0], P.life[1]), s0,
      grow: P.grow, spin: (Math.random() - 0.5) * 2 * P.spin, gravity: P.gravity, drag: P.drag, a0,
    });
  }

  update(dt: number): void {
    const L = this.live;
    let dead = 0;
    for (let i = L.length - 1; i >= 0; i--) {
      const o = L[i]!;
      o.age += dt;
      const k = o.age / o.life;
      if (k >= 1) {
        (o.add ? this.additive : this.normal).removeParticle(o.p);
        this.pool.push(o.p);
        L[i] = L[L.length - 1]!;
        L.pop();
        dead++;
        continue;
      }
      const damp = Math.max(0, 1 - o.drag * dt);
      o.vx *= damp;
      o.vy = o.vy * damp + o.gravity * dt;
      const p = o.p;
      p.x += o.vx * dt;
      p.y += o.vy * dt;
      p.rotation += o.spin * dt;
      const s = o.s0 * (1 + o.grow * k);
      const sy = p.scaleY / (p.scaleX || 1);
      p.scaleX = s;
      p.scaleY = s * sy;
      // ease out: hold, then fade over the last 40%
      p.alpha = o.a0 * (k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4);
    }
    if (dead > 0) this.budget.release(dead);
  }

  clear(): void {
    for (const o of this.live) {
      (o.add ? this.additive : this.normal).removeParticle(o.p);
      this.pool.push(o.p);
    }
    this.budget.release(this.live.length);
    this.live = [];
  }

  destroy(): void {
    this.clear();
    this.view.destroy({ children: true });
  }
}
