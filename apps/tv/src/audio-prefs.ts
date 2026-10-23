// TV-local audio preferences (not room settings): music volume, remembered on this TV.
import { setMusicVolume } from '@cadabra/render';

const KEY = 'cadabra.musicVolume';
export const MUSIC_STEPS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

export function loadMusicVolume(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (localStorage.getItem(KEY) !== null && Number.isFinite(v)) return Math.max(0, Math.min(1, v));
  } catch {
    // storage blocked
  }
  return 0.75;
}

export function saveMusicVolume(v: number): void {
  setMusicVolume(v);
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    // storage blocked: still applies for this session
  }
}

/** Next step up/down from `v`. */
export function stepMusic(v: number, dir: 1 | -1): number {
  const i = MUSIC_STEPS.reduce<number>((best, s, k) => (Math.abs(s - v) < Math.abs(MUSIC_STEPS[best]! - v) ? k : best), 0);
  return MUSIC_STEPS[Math.max(0, Math.min(MUSIC_STEPS.length - 1, i + dir))]!;
}

export const musicLabel = (v: number) => (v <= 0 ? 'Off' : `${Math.round(v * 100)}%`);
