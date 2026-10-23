/** Shared demo game specs (render-demo and the device benchmark), plus scripted neon scenes. */
import { FALLBACK_SPECS, type BlockUse, type GameSpec, type Theme } from '@cadabra/spec';
import type { Entity, FxEvent, GameEvent, Player } from '@cadabra/engine';
import heistJson from '../../../packages/spec/test/fixtures/heist.json';

export const heist = heistJson as unknown as GameSpec;

/** The neon arcade theme (task N1 palette). */
export const NEON_DEMO_THEME: Theme = {
  palette: { bg: '#0A0E27', primary: '#00E5FF', accent: '#FF2BD6', glow: '#B6FF3B', text: '#FFFFFF' },
  artStyle: 'neon arcade',
  keyArtPrompt: 'neon arcade arena',
  sprites: {},
  sfxSet: 'neon',
};

function variant(blocks: BlockUse[], kind: GameSpec['arena']['kind'], over: Partial<GameSpec> = {}): GameSpec {
  return {
    ...heist,
    id: `demo-${kind}`,
    arena: { kind, width: 1280, height: 720 },
    blocks,
    modifiers: [],
    timeline: [
      { atSec: 20, kind: 'surprise', params: {}, hostLine: 'Surprise! Things just got spicy!' },
      { atSec: 50, kind: 'twist', params: {}, hostLine: 'Final stretch!' },
    ],
    durationSec: 60,
    theme: NEON_DEMO_THEME,
    ...over,
  };
}

export const GAMES: Record<string, () => GameSpec> = {
  heist: () => ({ ...heist, theme: NEON_DEMO_THEME }),
  dodge: () => variant([{ block: 'dodge', params: { pattern: 'rain', onHit: 'stun', safeZones: 1 } }], 'topdown'),
  sweep: () => variant([{ block: 'dodge', params: { pattern: 'ring', startRate: 1.2 } }, { block: 'collect', params: {} }], 'topdown'),
  race: () => variant([{ block: 'race', params: { laneCount: 4 } }], 'lanes'),
  tug: () => variant([{ block: 'tug', params: {} }], 'tug', { teams: 2 }),
  quiz: () => variant([{ block: 'trivia', params: {} }], 'quiz'),
  draw: () => variant([{ block: 'draw-judge', params: {} }], 'canvas'),
};
// the built-in fallback games (what players see without AI): fallback-0.. and by spec id
FALLBACK_SPECS.forEach((s, i) => {
  GAMES[`fallback-${i}`] = () => s;
  GAMES[s.id] = () => s;
});

// ------------------------------------------------------------------ scripted neon scenes
// Synthetic snapshots (no engine): every art key and effect, and a stand-in for each neon game
// so the renderer can be judged before the engine's games land.

export interface DemoFrame {
  snap: { entities: Entity[]; players: Player[]; time: number; remaining: number; banner?: string };
  fx: FxEvent[];
  events: GameEvent[];
}

export interface DemoScene {
  arena: { width: number; height: number; kind: GameSpec['arena']['kind'] };
  step(t: number, dt: number): DemoFrame;
}

const NAMES = ['NOVA', 'BYTE', 'PIXEL', 'ZED'];

function players(n: number, teams = false, selfie?: string): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`, name: NAMES[i]!, avatar: i === 1 && selfie ? selfie : `bot:${i}`, isBot: true, connected: true, score: 0,
    ...(teams ? { team: (i % 2) as 0 | 1 } : {}),
  }));
}

let nextId = 1;
function ent(kind: string, x: number, y: number, o: Partial<Entity> = {}): Entity {
  return { id: nextId++, kind, x, y, vx: 0, vy: 0, r: 22, sprite: kind, tags: new Set(), props: {}, ...o };
}

/** A procedural "toon selfie" as a data URL (stands in for a real player selfie). */
export function fakeSelfie(): string {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#ff9a8b');
  gr.addColorStop(1, '#ff6a88');
  g.fillStyle = gr;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#3b2a20';
  g.beginPath();
  g.ellipse(128, 100, 92, 80, 0, Math.PI, 0);
  g.fill();
  g.fillStyle = '#f2c4a0';
  g.beginPath();
  g.ellipse(128, 140, 70, 82, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#222';
  for (const x of [102, 154]) {
    g.beginPath();
    g.arc(x, 132, 9, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = '#a0402a';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(128, 160, 26, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
  return c.toDataURL('image/png');
}

/** Moves a player entity toward (tx, ty) with a little inertia; sets vx/vy and dashing. */
function steer(e: Entity, tx: number, ty: number, dt: number, speed = 260): void {
  const dx = tx - e.x, dy = ty - e.y, d = Math.hypot(dx, dy) || 1;
  const sp = Math.min(speed, d * 4);
  e.vx += ((dx / d) * sp - e.vx) * Math.min(1, dt * 6);
  e.vy += ((dy / d) * sp - e.vy) * Math.min(1, dt * 6);
  e.x += e.vx * dt;
  e.y += e.vy * dt;
}

function avatarsFor(ps: Player[], at: (i: number) => [number, number], r = 22): Entity[] {
  return ps.map((p, i) => ent('player', at(i)[0], at(i)[1], { owner: p.id, sprite: `avatar:${p.id}`, r, ...(p.team !== undefined ? { team: p.team } : {}) }));
}

function score(ev: GameEvent[], t: number, p: Player, delta: number, reason: string): void {
  p.score += delta;
  ev.push({ t, type: 'score', player: p.id, data: { delta, reason } } as GameEvent);
}

function moment(ev: GameEvent[], t: number, type: string, m: string, x: number, y: number, player?: string): void {
  ev.push({ t, type, ...(player ? { player } : {}), data: { moment: m, x, y } } as GameEvent);
}

const DUR = 75;

/** Every key and effect on one screen. */
function gallery(selfie: string): DemoScene {
  const ps = players(4, false, selfie);
  const av = avatarsFor(ps, (i) => [200 + i * 150, 150]);
  const gem = ent('item', 860, 150, { sprite: 'gem', r: 18, props: { carriedBy: '' } });
  const core = ent('item', 980, 150, { sprite: 'core', r: 22, props: { carriedBy: '' } });
  const unstable = ent('item', 1100, 150, { sprite: 'core-unstable', r: 22, props: { carriedBy: '' } });
  const spike = ent('hazard', 180, 380, { sprite: 'spike', r: 30, props: {} });
  const laser = ent('obstacle', 400, 380, { sprite: 'laser', r: 18, props: { len: 220 } });
  const boost = ent('boost-pad', 620, 380, { sprite: 'boost', r: 30, props: {} });
  const base0 = ent('base', 830, 380, { sprite: 'base', r: 70, team: 0 });
  const base1 = ent('base', 1080, 380, { sprite: 'base', r: 70, team: 1 });
  const tiles: Entity[] = [];
  for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 4; gx++) {
    const t = ent('tile', 120 + gx * 64, 560 + gy * 64 - 64, { sprite: 'tile', r: 32, props: { hw: 32, hh: 32 } });
    if (gx === 1) t.props.team = 0;
    if (gx === 2) t.props.team = 1;
    if (gx === 3 && gy === 1) t.props.crumbling = true;
    tiles.push(t);
  }
  const hole = ent('hazard', 480, 560, { sprite: 'hole', r: 46 });
  const finish = ent('finish', 640, 560, { sprite: 'finish', r: 50 });
  let fuse = 9;
  let nextFx = 1;
  let k = 0;
  return {
    arena: { width: 1280, height: 720, kind: 'topdown' },
    step(t, dt) {
      const ev: GameEvent[] = [];
      fuse -= dt;
      if (fuse <= 0) {
        fuse = 9;
        moment(ev, t, 'overload.detonate', 'detonate', unstable.x, unstable.y);
        score(ev, t, ps[3]!, -3, 'OVERLOAD!');
      }
      unstable.props.fuseLeft = fuse;
      av[0]!.props.hasCore = true;
      av[0]!.props.fuseLeft = fuse;
      // players wander the lower right so eyes and ribbons show
      av.forEach((e, i) => {
        const a = t * (0.6 + i * 0.13) + i * 1.7;
        steer(e, 960 + Math.cos(a) * (150 + i * 20), 590 + Math.sin(a * 1.3) * 70, dt, 300);
        e.props.dashing = Math.sin(t * 1.1 + i) > 0.92;
      });
      if (t >= nextFx) {
        nextFx = t + 1.6;
        const c = k++ % 4;
        const who = ps[c]!, e = av[c]!;
        if (c === 0) {
          moment(ev, t, 'ringout.ringout', 'ringout', e.x, e.y, who.id);
          score(ev, t, who, 3, 'RING OUT!');
        } else if (c === 1) {
          moment(ev, t, 'rush.bank', 'bank', base0.x, base0.y, who.id);
          score(ev, t, who, 1, 'BANKED');
        } else if (c === 2) {
          moment(ev, t, 'rush.steal', 'steal', e.x, e.y, who.id);
          score(ev, t, who, 1, 'STOLEN!');
        } else {
          moment(ev, t, 'play.golden', 'golden', gem.x, gem.y, who.id);
          score(ev, t, who, 2, 'GEM');
        }
      }
      laser.props.angle = t * 1.2;
      return {
        snap: { entities: [...tiles, hole, finish, base0, base1, boost, spike, laser, gem, core, unstable, ...av], players: ps, time: t, remaining: DUR - (t % DUR) },
        fx: [],
        events: ev,
      };
    },
  };
}

/** RING OUT: a round tile arena over the void, the edge crumbles; shoves knock rivals out. */
function ringout(): DemoScene {
  const ps = players(4);
  const cx = 640, cy = 360, T = 44;
  const tiles: Entity[] = [];
  for (let gy = -7; gy <= 7; gy++) for (let gx = -12; gx <= 12; gx++) {
    const x = cx + gx * T, y = cy + gy * T;
    const d = Math.hypot(gx * 0.62, gy);
    if (d <= 7.2) tiles.push(ent('tile', x, y, { sprite: 'tile', r: T / 2, props: { hw: T / 2, hh: T / 2, ring: Math.floor(7.2 - d) } }));
  }
  const av = avatarsFor(ps, (i) => [cx + Math.cos(i * 1.57) * 140, cy + Math.sin(i * 1.57) * 100]);
  const spikes = [ent('hazard', cx - 220, cy + 40, { sprite: 'spike', r: 26 }), ent('hazard', cx + 240, cy - 60, { sprite: 'spike', r: 26 })];
  let ko = 3, crumbleRing = 0, crumbleAt = 6;
  const out = new Map<string, number>();
  return {
    arena: { width: 1280, height: 720, kind: 'topdown' },
    step(t, dt) {
      const ev: GameEvent[] = [];
      if (t > crumbleAt && crumbleRing < 3) {
        for (const tl of tiles) if (tl.props.ring === crumbleRing) tl.props.crumbling = true;
        if (t > crumbleAt + 1.5) {
          for (let i = tiles.length - 1; i >= 0; i--) if (tiles[i]!.props.ring === crumbleRing) tiles.splice(i, 1);
          crumbleRing++;
          crumbleAt = t + 8;
        }
      }
      av.forEach((e, i) => {
        const p = ps[i]!;
        const back = out.get(p.id);
        if (back !== undefined) {
          if (t < back) return;
          out.delete(p.id);
          e.x = cx;
          e.y = cy;
          e.vx = e.vy = 0;
          e.props.invulnUntil = t + 1;
        }
        const tgt = av[(i + 1) % 4]!;
        const a = t * 0.9 + i * 2;
        steer(e, tgt.x + Math.cos(a) * 120, tgt.y + Math.sin(a) * 90, dt, 280);
        e.props.dashing = Math.sin(t * 2 + i * 1.3) > 0.85;
      });
      if (t > ko) {
        ko = t + 3.2;
        const v = Math.floor(t * 7) % 4, s = (v + 1) % 4;
        const e = av[v]!;
        moment(ev, t, 'ringout.ringout', 'ringout', e.x, e.y, ps[s]!.id);
        score(ev, t, ps[s]!, 3, 'RING OUT!');
        score(ev, t, ps[v]!, -1, 'FELL');
        out.set(ps[v]!.id, t + 1.5);
      }
      const live = av.filter((_, i) => !out.has(ps[i]!.id));
      return { snap: { entities: [...tiles, ...spikes, ...live], players: ps, time: t, remaining: DUR - (t % DUR) }, fx: [], events: ev };
    },
  };
}

/** OVERLOAD: hot potato with an unstable core and a telegraphed fuse. */
function overload(): DemoScene {
  const ps = players(4);
  const av = avatarsFor(ps, (i) => [300 + i * 220, 360]);
  let holder = 0, fuse = 9, passAt = 2;
  return {
    arena: { width: 1280, height: 720, kind: 'topdown' },
    step(t, dt) {
      const ev: GameEvent[] = [];
      fuse -= dt;
      const h = av[holder]!;
      av.forEach((e, i) => {
        e.props.hasCore = i === holder;
        e.props.fuseLeft = fuse;
        if (i === holder) {
          const tgt = av[(holder + 1) % 4]!;
          steer(e, tgt.x, tgt.y, dt, 330);
          e.props.dashing = Math.hypot(tgt.x - e.x, tgt.y - e.y) < 160;
        } else {
          const a = t * 0.8 + i * 1.6;
          steer(e, 640 + Math.cos(a) * 420 + (e.x - h.x) * 0.3, 360 + Math.sin(a * 1.2) * 220 + (e.y - h.y) * 0.3, dt, 270);
          e.props.dashing = false;
        }
      });
      if (t > passAt) {
        passAt = t + 1.8 + (holder % 2);
        const to = (holder + 1) % 4;
        moment(ev, t, 'overload.pass', 'steal', av[to]!.x, av[to]!.y, ps[to]!.id);
        holder = to;
      }
      if (fuse <= 0) {
        const e = av[holder]!;
        moment(ev, t, 'overload.detonate', 'detonate', e.x, e.y, ps[holder]!.id);
        score(ev, t, ps[holder]!, -3, 'OVERLOAD!');
        ps.forEach((p, i) => i !== holder && score(ev, t, p, 1, 'SURVIVED'));
        e.props.stunUntil = t + 0.8;
        holder = (holder + 2) % 4;
        fuse = 7 + ((t * 13) % 6);
      }
      for (const e of av) e.props.stunned = typeof e.props.stunUntil === 'number' && t < e.props.stunUntil;
      return { snap: { entities: av, players: ps, time: t, remaining: DUR - (t % DUR) }, fx: [], events: ev };
    },
  };
}

/** PAINT WARS: 2v2 territory on a tile grid. */
function paint(): DemoScene {
  const ps = players(4, true);
  const T = 64, cols = 20, rows = 11;
  const tiles: Entity[] = [];
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) tiles.push(ent('tile', 32 + gx * T, 40 + gy * T, { sprite: 'tile', r: 32, props: { hw: 32, hh: 32 } }));
  const av = avatarsFor(ps, (i) => [i % 2 ? 1100 : 180, 200 + i * 90]);
  let tally = 5;
  return {
    arena: { width: 1280, height: 720, kind: 'topdown' },
    step(t, dt) {
      const ev: GameEvent[] = [];
      av.forEach((e, i) => {
        const a = t * (0.5 + i * 0.11) + i * 2.1;
        steer(e, 640 + Math.cos(a) * 520, 360 + Math.sin(a * 1.4 + i) * 270, dt, 300);
        const dash = Math.sin(t * 1.7 + i * 2) > 0.9;
        e.props.dashing = dash;
        const gx = Math.round((e.x - 32) / T), gy = Math.round((e.y - 40) / T);
        for (let dy = dash ? -1 : 0; dy <= (dash ? 1 : 0); dy++) for (let dx = dash ? -1 : 0; dx <= (dash ? 1 : 0); dx++) {
          const x = gx + dx, y = gy + dy;
          if (x >= 0 && x < cols && y >= 0 && y < rows) tiles[y * cols + x]!.props.team = e.team!;
        }
      });
      if (t > tally) {
        tally = t + 5;
        const n = [0, 0];
        for (const tl of tiles) if (typeof tl.props.team === 'number') n[tl.props.team as 0 | 1]!++;
        const win = n[0]! >= n[1]! ? 0 : 1;
        const p = ps.find((q) => q.team === win)!;
        const e = av[ps.indexOf(p)]!;
        moment(ev, t, 'paint.share', 'bank', e.x, e.y, p.id);
        score(ev, t, p, 2, 'TERRITORY');
      }
      return { snap: { entities: [...tiles, ...av], players: ps, time: t, remaining: DUR - (t % DUR) }, fx: [], events: ev };
    },
  };
}

/** CORE RUSH: carry cores from the middle to your team base. */
function corerush(): DemoScene {
  const ps = players(4, true);
  const bases = [ent('base', 160, 360, { sprite: 'base', r: 90, team: 0 }), ent('base', 1120, 360, { sprite: 'base', r: 90, team: 1 })];
  const av = avatarsFor(ps, (i) => [i % 2 ? 1050 : 230, 260 + i * 70]);
  const cores: Entity[] = [];
  const carry = new Map<string, number>();
  let spawnAt = 0;
  return {
    arena: { width: 1280, height: 720, kind: 'topdown' },
    step(t, dt) {
      const ev: GameEvent[] = [];
      if (t > spawnAt && cores.filter((c) => c.props.carriedBy === '').length < 4) {
        spawnAt = t + 1.2;
        cores.push(ent('item', 560 + ((t * 97) % 160), 200 + ((t * 61) % 320), { sprite: 'core', r: 20, props: { carriedBy: '' } }));
      }
      av.forEach((e, i) => {
        const p = ps[i]!, n = carry.get(p.id) ?? 0;
        const home = bases[p.team!]!;
        if (n >= 2 || (n > 0 && Math.sin(t + i) > 0.5)) {
          steer(e, home.x, home.y, dt, 280 - n * 50);
          if (Math.hypot(home.x - e.x, home.y - e.y) < 70) {
            for (let k = cores.length - 1; k >= 0; k--) if (cores[k]!.props.carriedBy === p.id) cores.splice(k, 1);
            carry.set(p.id, 0);
            moment(ev, t, 'rush.bank', 'bank', home.x, home.y, p.id);
            score(ev, t, p, n, 'BANKED');
          }
        } else {
          const free = cores.filter((c) => c.props.carriedBy === '');
          const tgt = free[i % Math.max(1, free.length)];
          if (tgt) {
            steer(e, tgt.x, tgt.y, dt, 280);
            if (Math.hypot(tgt.x - e.x, tgt.y - e.y) < 30) {
              tgt.props.carriedBy = p.id;
              carry.set(p.id, n + 1);
              moment(ev, t, 'rush.pick', 'pickup', tgt.x, tgt.y, p.id);
            }
          } else steer(e, 640, 360, dt);
        }
        e.props.carry = carry.get(p.id) ?? 0;
        let k = 0;
        for (const c of cores) if (c.props.carriedBy === p.id) {
          c.x = e.x + (k === 0 ? -18 : 18);
          c.y = e.y - 50;
          k++;
        }
      });
      return { snap: { entities: [...bases, ...cores, ...av], players: ps, time: t, remaining: DUR - (t % DUR) }, fx: [], events: ev };
    },
  };
}

/** NEON DASH: a lane race with boost pads, laser gates and a finish line. */
function dash(): DemoScene {
  const ps = players(4);
  const lanes = 4, lh = 720 / lanes;
  const av = avatarsFor(ps, (i) => [100, lh * i + lh / 2]);
  for (const e of av) e.props.mover = 'race';
  av.forEach((e, i) => (e.props.lane = i));
  const gates: Entity[] = [], pads: Entity[] = [];
  for (let i = 0; i < lanes; i++) {
    for (const x of [420 + i * 40, 860 - i * 30]) gates.push(ent('obstacle', x, lh * i + lh / 2, { sprite: 'laser', r: 18, props: { lane: i } }));
    pads.push(ent('boost-pad', 640 + (i % 2) * 120, lh * i + lh / 2, { sprite: 'boost', r: 28, props: { lane: i } }));
  }
  const speed = [0, 0, 0, 0];
  let lap = 0;
  return {
    arena: { width: 1280, height: 720, kind: 'lanes' },
    step(t, dt) {
      const ev: GameEvent[] = [];
      gates.forEach((g, i) => (g.props.on = Math.sin(t * 2.2 + i * 1.1) > -0.2));
      av.forEach((e, i) => {
        speed[i] = 230 + Math.sin(t * 0.7 + i * 1.9) * 70;
        e.vx = speed[i]!;
        e.vy = 0;
        e.x += e.vx * dt;
        e.props.speed = speed[i]!;
        e.props.boost = Math.sin(t * 0.7 + i * 1.9) > 0.8 ? 1.5 : 1;
        if (e.x > 1220) {
          e.x = 100;
          if (i === lap % 4) {
            moment(ev, t, 'race.finish', 'bank', 1220, e.y, ps[i]!.id);
            score(ev, t, ps[i]!, 3, 'FINISH!');
          }
          lap++;
        }
      });
      return { snap: { entities: [...pads, ...gates, ...av], players: ps, time: t, remaining: DUR - (t % DUR) }, fx: [], events: ev };
    },
  };
}

export const SCENES: Record<string, (selfie: string) => DemoScene> = {
  gallery,
  ringout: () => ringout(),
  overload: () => overload(),
  paint: () => paint(),
  corerush: () => corerush(),
  dash: () => dash(),
};
