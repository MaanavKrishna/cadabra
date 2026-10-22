/**
 * jsfxr-style procedural sound bank. Every sound is synthesised into an AudioBuffer on
 * first use (no audio files, nothing copyrighted) and replayed from cache. Silently does
 * nothing when WebAudio is unavailable (tests, locked-down WebViews).
 */

type Wave = 'square' | 'saw' | 'tri' | 'sine' | 'noise';

interface Voice {
  wave: Wave;
  /** Start frequency, Hz. */
  freq: number;
  /** Frequency multiplier reached by the end (exponential slide). */
  slide?: number;
  /** Arpeggio steps: at time t (s), multiply the base frequency by m. */
  arp?: [number, number][];
  attack: number;
  sustain: number;
  decay: number;
  /** Extra loudness in the first part of the sustain (sfxr "punch"). */
  punch?: number;
  vibDepth?: number;
  vibHz?: number;
  duty?: number;
  /** One-pole low-pass cutoff sweep, Hz (noise shaping). */
  lp?: [number, number];
  vol?: number;
  delay?: number;
}

export type SfxName = 'score' | 'hit' | 'whoosh' | 'win' | 'lose' | 'tick' | 'wake' | 'pass' | 'splash' | 'coin';

export const SFX_BANK: Record<SfxName, Voice[]> = {
  coin: [{ wave: 'square', freq: 988, arp: [[0.065, 1.335]], attack: 0.002, sustain: 0.07, decay: 0.24, punch: 0.4, duty: 0.25, vol: 0.5 }],
  score: [
    { wave: 'square', freq: 660, arp: [[0.07, 1.335], [0.14, 2]], attack: 0.003, sustain: 0.16, decay: 0.22, punch: 0.3, duty: 0.3, vol: 0.45 },
    { wave: 'tri', freq: 1320, arp: [[0.07, 1.335], [0.14, 2]], attack: 0.003, sustain: 0.16, decay: 0.3, vol: 0.3 },
  ],
  hit: [
    { wave: 'noise', freq: 1, attack: 0.001, sustain: 0.03, decay: 0.2, punch: 0.6, lp: [6000, 600], vol: 0.7 },
    { wave: 'square', freq: 260, slide: 0.3, attack: 0.001, sustain: 0.04, decay: 0.18, duty: 0.5, vol: 0.45 },
  ],
  whoosh: [{ wave: 'noise', freq: 1, attack: 0.09, sustain: 0.04, decay: 0.22, lp: [500, 4200], vol: 0.55 }],
  win: [
    { wave: 'square', freq: 523, arp: [[0.1, 1.26], [0.2, 1.5], [0.3, 2]], attack: 0.004, sustain: 0.42, decay: 0.45, punch: 0.25, duty: 0.35, vol: 0.38 },
    { wave: 'tri', freq: 1046, arp: [[0.1, 1.26], [0.2, 1.5], [0.3, 2]], attack: 0.004, sustain: 0.42, decay: 0.6, vibDepth: 0.01, vibHz: 6, vol: 0.32 },
    { wave: 'noise', freq: 1, attack: 0.005, sustain: 0.02, decay: 0.25, lp: [9000, 3000], vol: 0.12, delay: 0.3 },
  ],
  lose: [{ wave: 'saw', freq: 440, slide: 0.35, attack: 0.005, sustain: 0.35, decay: 0.35, vibDepth: 0.04, vibHz: 7, lp: [3000, 900], vol: 0.4 }],
  tick: [{ wave: 'sine', freq: 1760, attack: 0.001, sustain: 0.012, decay: 0.035, vol: 0.35 }],
  wake: [
    { wave: 'saw', freq: 75, slide: 1.9, attack: 0.04, sustain: 0.35, decay: 0.3, vibDepth: 0.12, vibHz: 22, lp: [900, 1800], vol: 0.6 },
    { wave: 'noise', freq: 1, attack: 0.05, sustain: 0.3, decay: 0.3, lp: [300, 700], vol: 0.35 },
  ],
  pass: [{ wave: 'tri', freq: 700, arp: [[0.06, 1.43]], attack: 0.002, sustain: 0.08, decay: 0.12, vol: 0.45 }],
  splash: [
    { wave: 'noise', freq: 1, attack: 0.003, sustain: 0.05, decay: 0.38, punch: 0.4, lp: [5000, 400], vol: 0.6 },
    { wave: 'sine', freq: 900, slide: 0.3, attack: 0.002, sustain: 0.03, decay: 0.12, vol: 0.3 },
  ],
};

/** Per-set flavour: pitch multiplier and what square waves become. */
const SETS: Record<string, { pitch: number; square: Wave }> = {
  arcade: { pitch: 1, square: 'square' },
  cartoon: { pitch: 1.12, square: 'tri' },
  spooky: { pitch: 0.78, square: 'saw' },
  scifi: { pitch: 1.05, square: 'saw' },
  nature: { pitch: 0.95, square: 'sine' },
};

let set = SETS.arcade!;
let setName = 'arcade';
let ctx: AudioContext | null | undefined;
let master: GainNode | undefined;
const cache = new Map<string, AudioBuffer>();
const lastAt = new Map<string, number>();
let voices = 0;
const MAX_VOICES = 10;
const MIN_GAP_MS = 35;
let muted = false;

/** Pick the sound flavour for the current game (Theme.sfxSet). */
export function setSfxSet(name: string): void {
  if (name === setName) return;
  set = SETS[name] ?? SETS.arcade!;
  setName = SETS[name] ? name : 'arcade';
  cache.clear();
}

export function setSfxMuted(m: boolean): void {
  muted = m;
}

function audio(): AudioContext | null {
  if (ctx !== undefined) return ctx;
  try {
    const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const AC = g.AudioContext ?? g.webkitAudioContext;
    ctx = AC ? new AC() : null;
    if (ctx) {
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Deterministic noise so a sound is the same every time. */
function noiseGen(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Render voices to samples (exported for offline checks). */
export function synth(voicesIn: Voice[], rate: number, pitch = 1, square: Wave = 'square'): Float32Array {
  const len = Math.ceil(rate * Math.max(...voicesIn.map((v) => (v.delay ?? 0) + v.attack + v.sustain + v.decay)) + rate * 0.01);
  const out = new Float32Array(len);
  voicesIn.forEach((v, vi) => {
    const wave = v.wave === 'square' ? square : v.wave;
    const rnd = noiseGen(9301 + vi * 7919);
    const total = v.attack + v.sustain + v.decay;
    const n = Math.ceil(total * rate);
    const off = Math.floor((v.delay ?? 0) * rate);
    let phase = 0;
    let lp = 0;
    for (let i = 0; i < n && off + i < len; i++) {
      const t = i / rate;
      let env: number;
      if (t < v.attack) env = t / Math.max(1e-4, v.attack);
      else if (t < v.attack + v.sustain) env = 1 + (v.punch ?? 0) * (1 - (t - v.attack) / Math.max(1e-4, v.sustain));
      else env = Math.pow(1 - (t - v.attack - v.sustain) / Math.max(1e-4, v.decay), 2);
      let f = v.freq * pitch * Math.pow(v.slide ?? 1, t / total);
      if (v.arp) for (const [at, m] of v.arp) if (t >= at) f = v.freq * pitch * m * Math.pow(v.slide ?? 1, t / total);
      if (v.vibDepth) f *= 1 + Math.sin(t * Math.PI * 2 * (v.vibHz ?? 6)) * v.vibDepth;
      phase += f / rate;
      const p = phase - Math.floor(phase);
      let s: number;
      switch (wave) {
        case 'square': s = p < (v.duty ?? 0.5) ? 0.8 : -0.8; break;
        case 'saw': s = (1 - 2 * p) * 0.8; break;
        case 'tri': s = (p < 0.5 ? 4 * p - 1 : 3 - 4 * p) * 0.9; break;
        case 'sine': s = Math.sin(p * Math.PI * 2); break;
        case 'noise': s = rnd(); break;
      }
      if (v.lp) {
        const cut = v.lp[0] + (v.lp[1] - v.lp[0]) * (t / total);
        const a = 1 - Math.exp((-2 * Math.PI * cut) / rate);
        lp += (s - lp) * a;
        s = lp;
      }
      out[off + i]! += s * env * (v.vol ?? 0.5);
    }
  });
  // soft clip keeps stacked voices clean
  for (let i = 0; i < len; i++) out[i] = Math.tanh(out[i]! * 1.2);
  return out;
}

/** Play a named sound effect. Unknown names, missing WebAudio and errors are ignored. */
export function sfx(name: string): void {
  if (muted) return;
  const bank = SFX_BANK[name as SfxName];
  if (!bank) return;
  try {
    const ac = audio();
    if (!ac || !master) return;
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
    const now = ac.currentTime * 1000;
    if (now - (lastAt.get(name) ?? -Infinity) < MIN_GAP_MS || voices >= MAX_VOICES) return;
    lastAt.set(name, now);
    let buf = cache.get(name);
    if (!buf) {
      const data = synth(bank, ac.sampleRate, set.pitch, set.square);
      buf = ac.createBuffer(1, data.length, ac.sampleRate);
      buf.getChannelData(0).set(data);
      cache.set(name, buf);
    }
    const src = ac.createBufferSource();
    src.buffer = buf;
    // a hair of pitch variation keeps repeats from sounding robotic
    src.playbackRate.value = 0.97 + Math.random() * 0.06;
    src.connect(master);
    voices++;
    src.onended = () => {
      voices = Math.max(0, voices - 1);
      src.disconnect();
    };
    src.start();
  } catch {
    // audio is optional: never break the frame
  }
}
