// Keep the screen awake during play; re-acquired when the tab becomes visible again.
type Sentinel = { release(): Promise<void> };

export function holdWakeLock(): () => void {
  const wl = (navigator as any).wakeLock as { request(t: 'screen'): Promise<Sentinel> } | undefined;
  if (!wl) return () => {};
  let s: Sentinel | undefined;
  let alive = true;
  const get = () => {
    if (!alive || document.visibilityState !== 'visible') return;
    wl.request('screen').then((x) => { if (alive) s = x; else void x.release(); }).catch(() => {});
  };
  const vis = () => get();
  document.addEventListener('visibilitychange', vis);
  get();
  return () => {
    alive = false;
    document.removeEventListener('visibilitychange', vis);
    void s?.release().catch(() => {});
  };
}
