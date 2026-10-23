/**
 * Procedural party music (task F §5). No audio files and nothing copyrighted: an upbeat 4-bar
 * loop is synthesised per sfx set (drums, bass, chord stabs) plus a "finale" layer (16th hats
 * and a lead arpeggio) of the same length. Both loop in sync; the finale fades the layer in
 * and nudges the tempo up. The host voice ducks the whole bus. Synthesis runs once per set at
 * a low sample rate (cheap on the stick) and is cached. Every entry point is a silent no-op
 * without WebAudio.
 */
import { audioContext } from './sfx';

export interface MusicStyle {
  bpm: number;
  /** MIDI note of the key's root (bass octave). */
  root: number;
  minor: boolean;
  /** Chord degrees (0-based scale steps) per bar. */
  prog: [number, number, number, number];
  bass: 'square' | 'tri' | 'saw' | 'sine';
  stab: 'square' | 'tri' | 'saw' | 'sine';
  lead: 'square' | 'tri' | 'saw' | 'sine';
  /** Swing 0..0.3 on off-beat 8ths. */
  swing: number;
}

export const MUSIC_STYLES: Record<string, MusicStyle> = {
  arcade: { bpm: 128, root: 45, minor: false, prog: [0, 4, 5, 3], bass: 'square', stab: 'square', lead: 'square', swing: 0 },
  cartoon: { bpm: 118, root: 43, minor: false, prog: [0, 3, 4, 0], bass: 'tri', stab: 'tri', lead: 'square', swing: 0.18 },
  spooky: { bpm: 108, root: 40, minor: true, prog: [0, 5, 3, 4], bass: 'saw', stab: 'tri', lead: 'tri', swing: 0.12 },
  scifi: { bpm: 124, root: 41, minor: true, prog: [0, 6, 5, 4], bass: 'saw', stab: 'saw', lead: 'square', swing: 0 },
  nature: { bpm: 112, root: 48, minor: false, prog: [0, 5, 3, 4], bass: 'sine', stab: 'tri', lead: 'tri', swing: 0.1 },
};

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
export const MUSIC_RATE = 22050;
/** Finale tempo factor (playbackRate: slightly higher and faster, Mario "hurry up" style). */
export const FINALE_RATE = 1.1;
const BASE_GAIN = 0.32;
const DUCK = 0.35;

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** Scale step -> MIDI note (steps beyond 7 wrap up an octave). */
export function stepNote(style: MusicStyle, step: number, octave = 0): number {
  const sc = style.minor ? MINOR : MAJOR;
  const o = Math.floor(step / 7);
  return style.root + sc[((step % 7) + 7) % 7]! + 12 * (o + octave);
}

/** Loop length in samples (4 bars of 4/4). */
export function loopSamples(style: MusicStyle, rate = MUSIC_RATE): number {
  return Math.round((16 * 60 * rate) / style.bpm);
}

function osc(wave: MusicStyle['bass'], ph: number): number {
  const p = ph - Math.floor(ph);
  switch (wave) {
    case 'square': return p < 0.5 ? 0.7 : -0.7;
    case 'saw': return (1 - 2 * p) * 0.7;
    case 'tri': return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    default: return Math.sin(p * Math.PI * 2);
  }
}

/** Add one tone into `out` (wraps at the loop end so long tails continue seamlessly). */
function tone(out: Float32Array, rate: number, at: number, dur: number, hz: number, wave: MusicStyle['bass'], vol: number, slide = 1): void {
  const n = Math.ceil(dur * rate), start = Math.round(at * rate), L = out.length;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = (i < 40 ? i / 40 : 1) * (1 - t) * (1 - t);
    ph += (hz * Math.pow(slide, t)) / rate;
    out[(start + i) % L]! += osc(wave, ph) * env * vol;
  }
}

let seed = 1;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
};

function noise(out: Float32Array, rate: number, at: number, dur: number, vol: number, bright: number): void {
  const n = Math.ceil(dur * rate), start = Math.round(at * rate), L = out.length;
  let lp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const s = rnd();
    lp += (s - lp) * bright;
    // bright > 0.6: crude high-pass (hats), else low-passed (snare body)
    const v = bright > 0.6 ? s - prev : lp;
    prev = s;
    out[(start + i) % L]! += v * (1 - t) * (1 - t) * vol;
  }
}

/** Base layer (drums, bass, stabs) and finale layer (16th hats, lead arp). Pure; deterministic. */
export function renderLoop(style: MusicStyle, rate = MUSIC_RATE): { base: Float32Array; final: Float32Array } {
  seed = 0x9e3779b9;
  const L = loopSamples(style, rate);
  const base = new Float32Array(L), fin = new Float32Array(L);
  const beat = 60 / style.bpm;
  const e8 = (i: number) => (i * beat) / 2 + (i % 2 === 1 ? style.swing * beat * 0.5 : 0);
  for (let bar = 0; bar < 4; bar++) {
    const deg = style.prog[bar]!;
    const b0 = bar * 4 * beat;
    const root = stepNote(style, deg);
    const chord = [stepNote(style, deg, 1), stepNote(style, deg + 2, 1), stepNote(style, deg + 4, 1)];
    for (let q = 0; q < 4; q++) {
      const t = b0 + q * beat;
      // kick on 1 and 3 (and a pickup on the "and" of 4 in the last bar), snare on 2 and 4
      if (q % 2 === 0) tone(base, rate, t, 0.22, 110, 'sine', 0.95, 0.35);
      else {
        noise(base, rate, t, 0.16, 0.45, 0.35);
        tone(base, rate, t, 0.08, 190, 'tri', 0.25, 0.7);
      }
    }
    if (bar === 3) tone(base, rate, b0 + 3.5 * beat, 0.18, 110, 'sine', 0.7, 0.35);
    for (let i = 0; i < 8; i++) {
      const t = b0 + e8(i);
      // offbeat 8th hats (light) in the base, bouncing octave bass
      if (i % 2 === 1) noise(base, rate, t, 0.04, 0.16, 0.9);
      const bn = i % 2 === 0 ? root : root + 12;
      tone(base, rate, t, beat * 0.45, midiHz(bn), style.bass, 0.3);
    }
    // chord stabs on the off-beats of 2 and 4
    for (const q of [1.5, 3.5]) for (const m of chord) tone(base, rate, b0 + e8(q * 2), beat * 0.4, midiHz(m), style.stab, 0.09);
    // finale: 16th hats + an arpeggio over the chord, an octave up
    for (let s = 0; s < 16; s++) {
      const t = b0 + (s * beat) / 4;
      noise(fin, rate, t, 0.03, s % 4 === 0 ? 0.22 : 0.12, 0.9);
      const m = chord[[0, 1, 2, 1][s % 4]!]! + 12 + (s >= 12 ? 12 : 0) * (s % 2);
      tone(fin, rate, t, beat * 0.22, midiHz(m), style.lead, 0.07);
    }
  }
  for (const a of [base, fin]) for (let i = 0; i < a.length; i++) a[i] = Math.tanh(a[i]! * 1.1);
  return { base, final: fin };
}

// ---------- playback ----------

interface Playing {
  base: AudioBufferSourceNode;
  final: AudioBufferSourceNode;
  layer: GainNode;
}

const cache = new Map<string, { base: AudioBuffer; final: AudioBuffer }>();
let bus: GainNode | undefined;
let duckG: GainNode | undefined;
let playing: Playing | undefined;
let volume = 0.7;
let ducked = false;
let intense = false;

function ramp(p: AudioParam, v: number, ac: AudioContext, tc = 0.12): void {
  try {
    p.setTargetAtTime(v, ac.currentTime, tc);
  } catch {
    p.value = v;
  }
}

function buffers(ac: AudioContext, set: string): { base: AudioBuffer; final: AudioBuffer } {
  const key = MUSIC_STYLES[set] ? set : 'arcade';
  let b = cache.get(key);
  if (!b) {
    const { base, final } = renderLoop(MUSIC_STYLES[key]!);
    const mk = (d: Float32Array) => {
      const buf = ac.createBuffer(1, d.length, MUSIC_RATE);
      buf.getChannelData(0).set(d);
      return buf;
    };
    b = { base: mk(base), final: mk(final) };
    cache.set(key, b);
  }
  return b;
}

/** Synthesise a set's loop now (call while a loading card is up). No-op without WebAudio. */
export function prewarmMusic(set: string): void {
  try {
    const ac = audioContext();
    if (ac) buffers(ac, set);
  } catch {
    // music is optional
  }
}

/** Start (or restart) the loop for `set`. */
export function startMusic(set: string): void {
  try {
    stopMusic();
    const ac = audioContext();
    if (!ac) return;
    if (ac.state !== 'running') void ac.resume().catch(() => undefined);
    if (!bus) {
      duckG = ac.createGain();
      duckG.gain.value = ducked ? DUCK : 1;
      duckG.connect(ac.destination);
      bus = ac.createGain();
      bus.gain.value = BASE_GAIN * volume;
      bus.connect(duckG);
    }
    const b = buffers(ac, set);
    const layer = ac.createGain();
    layer.gain.value = intense ? 1 : 0;
    layer.connect(bus);
    const mk = (buf: AudioBuffer, to: AudioNode) => {
      const s = ac.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = intense ? FINALE_RATE : 1;
      s.connect(to);
      return s;
    };
    const base = mk(b.base, bus), final = mk(b.final, layer);
    const t = ac.currentTime + 0.05;
    base.start(t);
    final.start(t);
    playing = { base, final, layer };
  } catch {
    playing = undefined;
  }
}

export function stopMusic(): void {
  const p = playing;
  playing = undefined;
  intense = false;
  if (!p) return;
  for (const s of [p.base, p.final]) {
    try {
      s.stop();
      s.disconnect();
    } catch {
      // already stopped
    }
  }
  try {
    p.layer.disconnect();
  } catch {
    // ignore
  }
}

/** Finale: the extra layer fades in and the tempo lifts (and back). */
export function setMusicIntensity(finale: boolean): void {
  intense = finale;
  const ac = audioContext();
  if (!ac || !playing) return;
  try {
    ramp(playing.layer.gain, finale ? 1 : 0, ac, 0.2);
    ramp(playing.base.playbackRate, finale ? FINALE_RATE : 1, ac, 0.4);
    ramp(playing.final.playbackRate, finale ? FINALE_RATE : 1, ac, 0.4);
  } catch {
    // optional
  }
}

/** Duck the music under the host voice. */
export function duckMusic(on: boolean): void {
  ducked = on;
  const ac = audioContext();
  if (ac && duckG) ramp(duckG.gain, on ? DUCK : 1, ac, 0.08);
}

/** Music volume 0..1 (Settings). */
export function setMusicVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  const ac = audioContext();
  if (ac && bus) ramp(bus.gain, BASE_GAIN * volume, ac, 0.05);
}

export function musicVolume(): number {
  return volume;
}

export function musicPlaying(): boolean {
  return playing !== undefined;
}
