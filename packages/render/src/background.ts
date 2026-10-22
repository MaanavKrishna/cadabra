import { Container, Matrix, RenderTexture, Sprite, Texture } from 'pixi.js';

/** Renders `stack` into `target` (cleared) with `transform` (the renderer, injected for tests). */
export type BakeRender = (stack: Container, target: RenderTexture, transform: Matrix) => void;

/**
 * The static background (gradient, floor tile, light pool, vignette, palette glows) baked into
 * ONE opaque texture, drawn as a single unblended sprite. The Fire TV GPU pays ~2.5 ms per
 * full-screen alpha layer at 1280x720 (docs/DEVICE_LIMITS.md), so the old 6-7 layer stack cost
 * 15 fps; this is one opaque layer. The bake runs only after `invalidate()` (new theme, palette,
 * floor or arena), never per frame: `ensure()` is a flag check on every other frame.
 *
 * Layers go into `stack` (off-stage) in screen coordinates; the bake covers
 * [-pad, W + pad] x [-pad, H + pad] so shake / camera zoom never reveal an edge.
 */
export class BackgroundBake {
  /** Off-stage source layers (screen px, may extend `pad` beyond the screen). */
  readonly stack = new Container();
  /** The one on-stage quad. */
  readonly sprite = new Sprite();
  /** Times the stack was rendered (tests / debug). */
  bakes = 0;
  private rt?: RenderTexture;
  private dirty = true;
  private readonly tf: Matrix;

  constructor(private readonly W: number, private readonly H: number, private readonly pad: number, private readonly draw: BakeRender) {
    this.sprite.position.set(-pad, -pad);
    // fully opaque: no blending at all for the biggest quad on screen
    this.sprite.blendMode = 'none';
    this.tf = new Matrix().translate(pad, pad);
  }

  /** The stack changed: re-bake before the next frame is drawn. */
  invalidate(): void {
    this.dirty = true;
  }

  get pending(): boolean {
    return this.dirty;
  }

  /** Call once per frame before rendering; bakes only when invalidated. True if it baked. */
  ensure(): boolean {
    if (!this.dirty) return false;
    this.dirty = false;
    if (!this.rt) {
      this.rt = RenderTexture.create({ width: this.W + this.pad * 2, height: this.H + this.pad * 2 });
      this.sprite.texture = this.rt;
    }
    this.draw(this.stack, this.rt, this.tf);
    this.bakes++;
    return true;
  }

  destroy(): void {
    this.stack.destroy({ children: true });
    this.sprite.destroy();
    this.rt?.destroy(true);
  }
}

function edgeTexture(horizontal: boolean): Texture {
  // alpha falls off from the edge (index 0) inward, eased so it reads like the old radial glow
  const N = 64;
  const c = document.createElement('canvas');
  c.width = horizontal ? N : 2;
  c.height = horizontal ? 2 : N;
  const g = c.getContext('2d')!;
  const gr = horizontal ? g.createLinearGradient(0, 0, N, 0) : g.createLinearGradient(0, 0, 0, N);
  gr.addColorStop(0, 'rgba(255,255,255,0.85)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.4)');
  gr.addColorStop(0.7, 'rgba(255,255,255,0.1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, c.width, c.height);
  return Texture.from(c);
}

/**
 * A screen-edge glow from four thin additive border strips (not a full-screen quad): the
 * finale pulse and the hit flash. Invisible (zero cost) whenever its alpha is ~0.
 */
export class EdgeGlow {
  readonly root = new Container();
  private strips: Sprite[] = [];
  private texV: Texture;
  private texH: Texture;

  constructor(W: number, H: number, thick: number) {
    this.texV = edgeTexture(false);
    this.texH = edgeTexture(true);
    const mk = (tex: Texture, x: number, y: number, sx: number, sy: number) => {
      const s = new Sprite(tex);
      s.position.set(x, y);
      s.scale.set(sx, sy);
      this.strips.push(s);
      this.root.addChild(s);
    };
    const kv = thick / this.texV.height, kh = thick / this.texH.width;
    mk(this.texV, 0, 0, W / this.texV.width, kv); // top
    mk(this.texV, 0, H, W / this.texV.width, -kv); // bottom (flipped)
    mk(this.texH, 0, 0, kh, H / this.texH.height); // left
    mk(this.texH, W, 0, -kh, H / this.texH.height); // right (flipped)
    this.root.blendMode = 'add';
    for (const s of this.strips) s.blendMode = 'add';
    this.root.visible = false;
    this.root.alpha = 0;
  }

  set(alpha: number, tint: number): void {
    this.root.alpha = alpha;
    this.root.visible = alpha > 0.003;
    if (!this.root.visible) return;
    for (const s of this.strips) s.tint = tint;
  }

  get alpha(): number {
    return this.root.alpha;
  }

  get visible(): boolean {
    return this.root.visible;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.texV.destroy(true);
    this.texH.destroy(true);
  }
}
