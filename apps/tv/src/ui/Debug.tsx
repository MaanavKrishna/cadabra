// Debug overlay (Menu x3): fps, per-player round-trip time and transport (direct / relay).
import { useEffect, useState } from 'preact/hooks';
import type { PlayerView } from '@cadabra/couchpad';

export function DebugOverlay({ players, fps, info }: { players: () => Map<string, PlayerView>; fps: () => number | undefined; info: () => string }) {
  const [, tick] = useState(0);
  const [own, setOwn] = useState(0);
  useEffect(() => {
    let frames = 0, t0 = performance.now(), raf = 0;
    const loop = (now: number) => {
      frames++;
      if (now - t0 >= 1000) { setOwn(Math.round((frames * 1000) / (now - t0))); frames = 0; t0 = now; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => { cancelAnimationFrame(raf); clearInterval(id); };
  }, []);
  const rows = [...players()];
  return (
    <div class="debug">
      <div><b>{fps() ?? own}</b> fps</div>
      <div class="debug-dim">{info()}</div>
      {rows.length === 0 && <div class="debug-dim">no phones</div>}
      {rows.map(([id, p]) => (
        <div key={id}>
          {p.name.slice(0, 12)} · {p.connected ? `${Math.round(p.rttMs)} ms · ${p.transport}` : 'away'}
        </div>
      ))}
    </div>
  );
}
