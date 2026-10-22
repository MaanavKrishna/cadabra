import { PeerMsgSchema, type PeerMsg } from '@cadabra/spec';

/** Draw payloads (PNG data URLs) above this are dropped before send. */
export const MAX_DRAW_BYTES = 200 * 1024;

export type Listener = (...args: any[]) => void;

export class Emitter {
  private ls = new Map<string, Set<Listener>>();
  on(ev: string, cb: Listener) {
    let s = this.ls.get(ev);
    if (!s) this.ls.set(ev, (s = new Set()));
    s.add(cb);
  }
  off(ev: string, cb: Listener) { this.ls.get(ev)?.delete(cb); }
  emit(ev: string, ...args: unknown[]) {
    for (const cb of this.ls.get(ev) ?? []) {
      try { cb(...args); } catch (e) { queueMicrotask(() => { throw e; }); }
    }
  }
}

/** Accepts a JSON string (data channel) or an object (relay); returns a validated PeerMsg. */
export function parsePeerMsg(raw: unknown): PeerMsg | undefined {
  let v = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return undefined; }
  }
  const r = PeerMsgSchema.safeParse(v);
  return r.success ? r.data : undefined;
}

// ---- relay chunking (API Gateway WS frames cap at ~32 KB) ----

/** Max serialized size of one relay payload. */
export const RELAY_CHUNK_BYTES = 28 * 1024;
export const REASSEMBLY_TIMEOUT_MS = 10_000;

export interface RelayChunk { t: '~chunk'; id: number; seq: number; total: number; part: string }

const utf8Len = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
  }
  return n;
};

let chunkSeq = 0;

/**
 * Returns the relay payloads for `msg`: the message itself when small, else
 * chunks whose serialized envelope is each <= RELAY_CHUNK_BYTES.
 */
export function relayPayloads(msg: unknown): unknown[] {
  const s = JSON.stringify(msg);
  if (utf8Len(s) <= RELAY_CHUNK_BYTES) return [msg];
  const id = ++chunkSeq;
  const budget = RELAY_CHUNK_BYTES - 128; // envelope + relay wrapper headroom
  const parts: string[] = [];
  let i = 0;
  let step = Math.floor(budget / 2);
  while (i < s.length) {
    let n = Math.min(step, s.length - i);
    // escaping/multi-byte chars can inflate a slice: shrink until it fits
    while (n > 1 && utf8Len(JSON.stringify(s.slice(i, i + n))) > budget) n = Math.floor(n * 0.75);
    parts.push(s.slice(i, i + n));
    i += n;
  }
  return parts.map((part, seq) => ({ t: '~chunk', id, seq, total: parts.length, part } satisfies RelayChunk));
}

const isChunk = (d: unknown): d is RelayChunk => {
  const c = d as RelayChunk;
  return !!c && typeof c === 'object' && c.t === '~chunk' && Number.isInteger(c.id) && Number.isInteger(c.seq)
    && Number.isInteger(c.total) && c.total > 0 && c.total <= 64 && c.seq >= 0 && c.seq < c.total
    && typeof c.part === 'string';
};

/** Reassembles chunked relay payloads per sender; partials expire after 10 s. */
export class Reassembler {
  private open = new Map<string, { parts: (string | undefined)[]; got: number; timer: unknown }>();
  constructor(private clock: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }) {}

  /** Returns the complete payload (unchunked data passes through), or undefined while incomplete. */
  accept(from: string, data: unknown): unknown {
    if (!isChunk(data)) return data;
    const key = `${from}:${data.id}`;
    let e = this.open.get(key);
    if (!e) {
      e = { parts: new Array(data.total), got: 0, timer: this.clock.setTimeout(() => this.open.delete(key), REASSEMBLY_TIMEOUT_MS) };
      this.open.set(key, e);
    }
    if (e.parts.length !== data.total || e.parts[data.seq] !== undefined) return undefined;
    e.parts[data.seq] = data.part;
    if (++e.got < data.total) return undefined;
    this.clock.clearTimeout(e.timer);
    this.open.delete(key);
    try { return JSON.parse(e.parts.join('')); } catch { return undefined; }
  }

  clear() {
    for (const e of this.open.values()) this.clock.clearTimeout(e.timer);
    this.open.clear();
  }
}

/** Bounded FIFO for reliable messages while no path is up. */
export class BoundedQueue<T> {
  private items: T[] = [];
  constructor(readonly max = 64) {}
  push(x: T) { if (this.items.length >= this.max) return false; this.items.push(x); return true; }
  drain(): T[] { const x = this.items; this.items = []; return x; }
  get size() { return this.items.length; }
}
