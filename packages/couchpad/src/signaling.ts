// WebSocket signaling/relay link with auto-reconnect and backoff.
import type { BackendErrorCode, BackendToClient, ClientToBackend } from '@cadabra/spec';

// Room resume and TV presence (Task 9 fix round). Defined locally until they land in
// @cadabra/spec's protocol.ts; structurally compatible with the planned wire format.
export type ResumeOut = { t: 'room.resume'; code: string; tvToken: string };
export type ExtraIn =
  | { t: 'room.resumed'; code?: string }
  | { t: 'tv.left' }
  | { t: 'tv.back' }
  | { t: 'error'; code: BackendErrorCode | 'room.badToken'; message?: string };
export type WireOut = ClientToBackend | ResumeOut;
export type WireIn = BackendToClient | ExtraIn;

export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}
/** Globals looked up lazily so test fake timers installed later still apply. */
export const defaultClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as any),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as any),
};

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
export function defaultStorage(): StorageLike {
  try {
    const s = (globalThis as any).sessionStorage as StorageLike | undefined;
    if (s) return s;
  } catch { /* blocked storage */ }
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

export const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000] as const;

export interface SignalingOpts {
  url: string;
  WebSocket?: WebSocketCtor;
  clock: Clock;
  /** called on every (re)open; use it to (re)join or resume. */
  onOpen: (reconnect: boolean) => void;
  onMessage: (m: WireIn) => void;
  onDown?: () => void;
}

export class Signaling {
  private ws?: WebSocketLike;
  private attempt = 0;
  private opened = false;
  private stopped = false;
  private retry?: unknown;

  constructor(private o: SignalingOpts) {}

  get isOpen() { return this.ws?.readyState === 1; }

  connect() {
    this.stopped = false;
    const Ctor = this.o.WebSocket ?? ((globalThis as any).WebSocket as WebSocketCtor);
    const ws = new Ctor(this.o.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnect = this.opened;
      this.opened = true;
      this.attempt = 0;
      this.o.onOpen(reconnect);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let m: WireIn;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m && typeof m === 'object' && typeof (m as any).t === 'string') this.o.onMessage(m);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.o.onDown?.();
      if (this.stopped) return;
      const delay = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
      this.retry = this.o.clock.setTimeout(() => { this.retry = undefined; if (!this.stopped) this.connect(); }, delay);
    };
  }

  /** Send if open; returns false (and drops) while down. Join/resume are re-sent from onOpen. */
  send(m: WireOut) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  close() {
    this.stopped = true;
    if (this.retry !== undefined) this.o.clock.clearTimeout(this.retry);
    const ws = this.ws; this.ws = undefined;
    ws?.close();
  }
}
