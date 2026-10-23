/** Minimal pixi.js stand-in for logic tests: display objects keep state, nothing draws. */

export class Point {
  x = 0;
  y = 0;
  set(x: number, y = x): void {
    this.x = x;
    this.y = y;
  }
}

export class Rectangle {
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
}

let texSeq = 0;
export class Texture {
  static WHITE: Texture;
  readonly uid = ++texSeq;
  width: number;
  height: number;
  source: { width: number; height: number; addressMode: string; update(): void };
  destroyed = false;
  constructor(o: { source?: { width: number; height: number }; frame?: Rectangle } = {}) {
    const src = o.source ?? { width: 64, height: 64 };
    this.source = Object.assign(src as Texture['source'], { addressMode: 'clamp', update() {} });
    this.width = o.frame?.width ?? src.width;
    this.height = o.frame?.height ?? src.height;
  }
  static from(src: { width?: number; height?: number }): Texture {
    return new Texture({ source: { width: src.width ?? 64, height: src.height ?? 64 } });
  }
  destroy(): void {
    this.destroyed = true;
  }
}
Texture.WHITE = new Texture();

export class Container {
  children: Container[] = [];
  parent: Container | null = null;
  position = new Point();
  scale = new Point();
  anchor = new Point();
  pivot = new Point();
  skew = new Point();
  visible = true;
  alpha = 1;
  rotation = 0;
  zIndex = 0;
  tint = 0xffffff;
  blendMode = 'normal';
  sortableChildren = false;
  destroyed = false;
  label = '';
  width = 0;
  height = 0;
  constructor() {
    this.scale.set(1);
  }
  get x(): number {
    return this.position.x;
  }
  get y(): number {
    return this.position.y;
  }
  addChild<T extends Container>(...cs: T[]): T {
    for (const c of cs) {
      c.parent = this;
      this.children.push(c);
    }
    return cs[0]!;
  }
  addChildAt<T extends Container>(c: T, i: number): T {
    c.parent = this;
    this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c: Container): void {
    this.children = this.children.filter((x) => x !== c);
  }
  destroy(): void {
    this.destroyed = true;
  }
}

export class Sprite extends Container {
  texture: Texture;
  constructor(t?: Texture) {
    super();
    this.texture = t ?? Texture.WHITE;
  }
}

export class Graphics extends Container {
  draws = 0;
  clear(): this {
    this.draws = 0;
    return this;
  }
}
for (const m of ['rect', 'roundRect', 'circle', 'ellipse', 'moveTo', 'lineTo', 'arc', 'poly', 'fill', 'stroke', 'closePath']) {
  (Graphics.prototype as unknown as Record<string, unknown>)[m] = function (this: Graphics) {
    this.draws++;
    return this;
  };
}

export class Text extends Container {
  text: string;
  style: Record<string, unknown>;
  constructor(o: { text?: string; style?: Record<string, unknown> } = {}) {
    super();
    this.text = o.text ?? '';
    this.style = { ...o.style };
  }
}

/** document.createElement('canvas') with a do-nothing 2D context. */
export function fakeDocument(): void {
  const noop = () => undefined;
  const ctx = new Proxy(
    {},
    { get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop), set: () => true },
  );
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}

export class Matrix {
  tx = 0;
  ty = 0;
  translate(x: number, y: number): this {
    this.tx += x;
    this.ty += y;
    return this;
  }
}

export class RenderTexture extends Texture {
  static create(o: { width: number; height: number }): RenderTexture {
    return new RenderTexture({ source: { width: o.width, height: o.height } });
  }
}
