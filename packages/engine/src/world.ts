export interface Entity {
  id: number;
  kind: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  sprite: string;
  owner?: string;
  team?: 0 | 1;
  tags: Set<string>;
  props: Record<string, number | string | boolean>;
}

export type SpawnOpts = Partial<Omit<Entity, 'id' | 'kind' | 'x' | 'y' | 'tags'>> & { tags?: Iterable<string> };

const CELL = 128;
// numeric cell key; supports |cell index| < 2^15 (±4M px), far beyond any arena
const OFF = 1 << 15;
const cellKey = (cx: number, cy: number) => (cx + OFF) * (OFF * 2) + (cy + OFF);

/**
 * Entity store with a uniform-grid spatial hash. The grid is rebuilt lazily on the
 * first `query` after `invalidate()` (the runtime invalidates before every block call),
 * so blocks may mutate x/y directly.
 */
export class World {
  readonly width: number;
  readonly height: number;
  private entities = new Map<number, Entity>();
  private nextId = 1;
  private grid = new Map<number, Entity[]>();
  /** owner -> avatar (kind 'player'); first spawned wins. */
  private avatars = new Map<string, Entity>();
  private dirty = true;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  spawn(kind: string, x: number, y: number, opts: SpawnOpts = {}): Entity {
    const { tags, ...rest } = opts;
    const e: Entity = {
      vx: 0, vy: 0, r: 16, sprite: kind, props: {},
      ...rest,
      id: this.nextId++, kind, x, y,
      tags: new Set(tags ?? []),
    };
    this.entities.set(e.id, e);
    if (e.kind === 'player' && e.owner !== undefined && !this.avatars.has(e.owner)) this.avatars.set(e.owner, e);
    this.dirty = true;
    return e;
  }

  remove(id: number): boolean {
    const e = this.entities.get(id);
    if (!e) return false;
    this.entities.delete(id);
    if (e.owner !== undefined && this.avatars.get(e.owner) === e) {
      this.avatars.delete(e.owner);
      for (const o of this.entities.values()) {
        if (o.kind === 'player' && o.owner === e.owner) {
          this.avatars.set(e.owner, o);
          break;
        }
      }
    }
    this.dirty = true;
    return true;
  }

  /** The avatar (kind 'player') owned by `owner`, O(1). */
  playerEntity(owner: string): Entity | undefined {
    return this.avatars.get(owner);
  }

  get(id: number): Entity | undefined {
    return this.entities.get(id);
  }

  /** All entities in spawn (id) order. */
  all(): Entity[] {
    return [...this.entities.values()];
  }

  byKind(kind: string): Entity[] {
    return this.all().filter((e) => e.kind === kind);
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Entities whose circle overlaps the circle (x, y, r), sorted by id. */
  query(x: number, y: number, r: number): Entity[] {
    if (this.dirty) this.rebuild();
    // entities may span cells: widen by the largest radius seen
    const pad = r + this.maxR;
    const x0 = Math.floor((x - pad) / CELL), x1 = Math.floor((x + pad) / CELL);
    const y0 = Math.floor((y - pad) / CELL), y1 = Math.floor((y + pad) / CELL);
    const out: Entity[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.grid.get(cellKey(cx, cy));
        if (!cell) continue;
        for (const e of cell) {
          if (!this.entities.has(e.id)) continue;
          const dx = e.x - x, dy = e.y - y, rr = r + e.r;
          if (dx * dx + dy * dy <= rr * rr) out.push(e);
        }
      }
    }
    return out.sort((a, b) => a.id - b.id);
  }

  /** Move every entity by its velocity. */
  integrate(dt: number): void {
    for (const e of this.entities.values()) {
      if (e.vx !== 0 || e.vy !== 0) {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
      }
    }
    this.dirty = true;
  }

  private maxR = 0;

  private rebuild(): void {
    this.grid.clear();
    this.maxR = 0;
    for (const e of this.entities.values()) {
      if (e.r > this.maxR) this.maxR = e.r;
      const key = cellKey(Math.floor(e.x / CELL), Math.floor(e.y / CELL));
      const cell = this.grid.get(key);
      if (cell) cell.push(e);
      else this.grid.set(key, [e]);
    }
    this.dirty = false;
  }
}

export function cloneEntity(e: Entity): Entity {
  return { ...e, tags: new Set(e.tags), props: { ...e.props } };
}
