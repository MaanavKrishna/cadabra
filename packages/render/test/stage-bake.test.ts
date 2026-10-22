import { beforeAll, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ renders: [] as unknown[], tickers: [] as (() => void)[] }));

vi.mock('pixi.js', async () => {
  const m = await import('./pixi-mock');
  class Application {
    canvas = { style: {} as Record<string, string> };
    stage = new m.Container();
    ticker = { deltaMS: 16.7, add: (fn: () => void) => h.tickers.push(fn), stop() {} };
    renderer = { background: { color: 0 }, render: (o: unknown) => h.renders.push(o) };
    async init(): Promise<void> {}
    destroy(): void {}
  }
  class TilingSprite extends m.Sprite {
    tilePosition = new m.Point();
    tileScale = new m.Point();
    constructor(o: { texture: InstanceType<typeof m.Texture> }) {
      super(o.texture);
    }
  }
  class FillGradient {
    destroy(): void {}
  }
  class Particle {
    constructor(public o: unknown) {}
  }
  class ParticleContainer extends m.Container {
    addParticle(): void {}
    removeParticle(): void {}
  }
  return { ...m, Application, TilingSprite, FillGradient, Particle, ParticleContainer };
});

import { fakeDocument } from './pixi-mock';
import { GameView } from '../src/stage';

beforeAll(() => fakeDocument());

const theme = (bg: string) => ({
  palette: { bg, primary: '#4cc9f0', accent: '#f72585', glow: '#ffd166', text: '#ffffff' },
  sprites: {}, sfxSet: 'arcade',
}) as unknown as Parameters<GameView['loadTheme']>[0];

const frames = (n: number) => {
  for (let i = 0; i < n; i++) for (const t of h.tickers) t();
};

describe('GameView background bake', () => {
  test('re-renders the background on theme change only, not per frame', async () => {
    const view = new GameView({ appendChild() {} } as unknown as HTMLElement, { internalW: 1280, internalH: 720 });
    await view.ready;
    frames(60);
    expect(h.renders).toHaveLength(1);
    await view.loadTheme(theme('#202040'), {});
    frames(1);
    const afterTheme = h.renders.length;
    expect(afterTheme).toBeGreaterThan(1);
    frames(300);
    expect(h.renders).toHaveLength(afterTheme);
    await view.loadTheme(theme('#402020'), {});
    frames(120);
    expect(h.renders.length).toBeGreaterThan(afterTheme);
    expect(h.renders.length).toBeLessThanOrEqual(afterTheme + 2);
    view.destroy();
  }, 15000);
});
