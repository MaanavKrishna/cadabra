// Soft procedural UI sounds (WebAudio, no files): a focus tick, a select chime, a back blip and a
// trophy ding. Each is a couple of sine/triangle oscillators with a short envelope, a few ms of CPU.
export type UiSound = 'move' | 'select' | 'back' | 'trophy' | 'deny';

let ctx: AudioContext | null | undefined;
let out: GainNode | undefined;
let muted = false;
let lastMove = 0;

function audio(): AudioContext | null {
  if (ctx === undefined) {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      ctx = AC ? new AC() : null;
      if (ctx) {
        out = ctx.createGain();
        out.gain.value = 0.5;
        out.connect(ctx.destination);
      }
    } catch {
      ctx = null;
    }
  }
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

export function setUiMuted(m: boolean): void {
  muted = m;
}

/** One note: frequency glide f0 -> f1 over `dur` s, peak gain `g`, starting `at` s from now. */
function note(a: AudioContext, type: OscillatorType, f0: number, f1: number, at: number, dur: number, g: number): void {
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const v = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  v.gain.setValueAtTime(0.0001, t);
  v.gain.exponentialRampToValueAtTime(g, t + 0.008);
  v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(v).connect(out!);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export function uiSound(s: UiSound): void {
  if (muted) return;
  const a = audio();
  if (!a || !out) return;
  try {
    switch (s) {
      case 'move': {
        // key repeat: at most one tick every 45 ms
        const now = performance.now();
        if (now - lastMove < 45) return;
        lastMove = now;
        note(a, 'sine', 2200, 1900, 0, 0.045, 0.05);
        break;
      }
      case 'select':
        note(a, 'sine', 880, 880, 0, 0.12, 0.07);
        note(a, 'sine', 1320, 1320, 0.05, 0.18, 0.06);
        break;
      case 'back':
        note(a, 'sine', 990, 660, 0, 0.12, 0.06);
        break;
      case 'deny':
        note(a, 'triangle', 220, 196, 0, 0.14, 0.06);
        break;
      case 'trophy':
        note(a, 'sine', 1046, 1046, 0, 0.5, 0.07);
        note(a, 'sine', 1568, 1568, 0.07, 0.6, 0.05);
        note(a, 'triangle', 2093, 2093, 0.14, 0.7, 0.025);
        break;
    }
  } catch {
    /* audio is decoration: never break a key press */
  }
}
