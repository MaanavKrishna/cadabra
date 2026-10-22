// Phone side: joins a room, offers WebRTC to the TV, relays through the WS when direct is down.
import type { BackendToClient, InputFrame, PeerMsg } from '@cadabra/spec';
import { Peer, type Mode, type RTCCtor, type SignalData } from './peer';
import {
  Signaling, defaultClock, defaultStorage, type Clock, type StorageLike, type WebSocketCtor,
} from './signaling';
import {
  BoundedQueue, Emitter, MAX_DRAW_BYTES, Reassembler, parsePeerMsg, relayPayloads, type Listener,
} from './util';

export interface Transport {
  sendInput(frame: InputFrame): void;
  /** Reliable send. false = dropped (queue full). */
  send(msg: PeerMsg): boolean;
  onMessage(cb: (m: PeerMsg) => void): void;
  readonly mode: Mode;
  rttMs(): number;
}

export type TransportPolicy = 'auto' | 'relay-only';

export interface CouchClientOpts {
  wsUrl: string;
  WebSocket?: WebSocketCtor;
  RTCPeerConnection?: RTCCtor;
  clock?: Clock;
  random?: () => number;
  /** Rejoin tokens, keyed by room code. Defaults to sessionStorage. */
  storage?: StorageLike;
  iceServers?: { urls: string | string[] }[];
  /** 'relay-only' skips WebRTC entirely (e.g. TRANSPORT=relay-only). */
  transport?: TransportPolicy;
  inputHz?: number;
  pingIntervalMs?: number;
  openTimeoutMs?: number;
  joinTimeoutMs?: number;
}

export const INPUT_HZ = 30;
export const PING_INTERVAL_MS = 2000;
export const JOIN_TIMEOUT_MS = 8000;
/** While anything is held/deflected, the latest continuous frame is resent this often. */
export const KEEPALIVE_MS = 100;
/** A button release is sent twice; the copy follows after this delay. */
export const RELEASE_REPEAT_MS = 30;
export const RELIABLE_QUEUE_MAX = 64;

type ClientEvent = 'msg' | 'mode' | 'tv.left' | 'tv.back' | 'error';

const isActive = (f: InputFrame) =>
  Object.values(f.buttons ?? {}).some(Boolean)
  || !!(f.axes && (f.axes.x !== 0 || f.axes.y !== 0))
  || !!(f.tilt && (f.tilt.x !== 0 || f.tilt.y !== 0));

export class CouchClient implements Transport {
  playerId?: string;
  private code?: string;
  private name = '';
  private joined = false;
  private sig: Signaling;
  private peer?: Peer;
  private ev = new Emitter();
  private clock: Clock;
  private storage: StorageLike;
  private _mode: Mode = 'relay';
  private joinWait?: { resolve: (v: { playerId: string }) => void; reject: (e: Error) => void; timer: unknown };
  private queue = new BoundedQueue<PeerMsg>(RELIABLE_QUEUE_MAX);
  private chunks: Reassembler;
  // input throttle + keepalive
  private lastSentAt = -Infinity;
  private lastOut?: InputFrame;
  private lastButtons: Record<string, boolean> = {};
  private pending?: InputFrame;
  private pendingTimer?: unknown;
  private keepTimer?: unknown;
  private repeatTimer?: unknown;
  // rtt
  private pingTimer?: unknown;
  private pingSeq = 0;
  private pings = new Map<number, number>();
  private rtt = 0;

  constructor(private o: CouchClientOpts) {
    this.clock = o.clock ?? defaultClock;
    this.storage = o.storage ?? defaultStorage();
    this.chunks = new Reassembler(this.clock);
    this.sig = new Signaling({
      url: o.wsUrl, WebSocket: o.WebSocket, clock: this.clock, random: o.random,
      onOpen: () => this.sendJoin(),
      onMessage: (m) => this.onWire(m),
      onDown: () => { this.joined = false; },
    });
  }

  get mode(): Mode { return this._mode; }
  rttMs() { return this.rtt; }
  on(ev: ClientEvent, cb: Listener) { this.ev.on(ev, cb); }
  onMessage(cb: (m: PeerMsg) => void) { this.ev.on('msg', cb); }

  /** Join (or switch to) a room. A second call supersedes a pending one, which rejects. */
  join(code: string, name: string): Promise<{ playerId: string }> {
    this.failJoin(new Error('join.superseded'));
    this.teardown();
    this.code = code.toUpperCase();
    this.name = name;
    this.playerId = undefined;
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.failJoin(new Error('join.timeout'));
        this.teardown();
      }, this.o.joinTimeoutMs ?? JOIN_TIMEOUT_MS);
      this.joinWait = { resolve, reject, timer };
      this.sig.connect();
    });
  }

  close() {
    this.failJoin(new Error('join.closed'));
    this.teardown();
  }

  private failJoin(e: Error) {
    const w = this.joinWait;
    if (!w) return;
    this.joinWait = undefined;
    this.clock.clearTimeout(w.timer);
    w.reject(e);
  }

  private teardown() {
    this.sig.close();
    this.joined = false;
    this.peer?.close();
    this.peer = undefined;
    for (const k of ['pendingTimer', 'keepTimer', 'repeatTimer'] as const) {
      if (this[k] !== undefined) { this.clock.clearTimeout(this[k]); this[k] = undefined; }
    }
    if (this.pingTimer !== undefined) { this.clock.clearInterval(this.pingTimer); this.pingTimer = undefined; }
    this.pending = undefined;
    this.lastOut = undefined;
    this.lastButtons = {};
    this.lastSentAt = -Infinity;
    this.queue.drain();
    this.chunks.clear();
    this.setMode('relay');
  }

  private sendJoin() {
    if (!this.code) return;
    const rejoinToken = this.storage.getItem(this.code) ?? undefined;
    this.sig.send({ t: 'room.join', code: this.code, name: this.name, rejoinToken });
  }

  private onWire(m: BackendToClient) {
    switch (m.t) {
      case 'room.joined': {
        this.playerId = m.playerId;
        this.joined = true;
        try { this.storage.setItem(this.code!, m.token); } catch { /* storage full/blocked */ }
        const w = this.joinWait; this.joinWait = undefined;
        if (w) { this.clock.clearTimeout(w.timer); w.resolve({ playerId: m.playerId }); }
        if (this.pingTimer === undefined) {
          this.pingTimer = this.clock.setInterval(() => this.ping(), this.o.pingIntervalMs ?? PING_INTERVAL_MS);
        }
        this.flushQueue();
        this.startPeer(); // fresh link after every (re)join; the TV dropped the old one
        return;
      }
      case 'signal':
        if (m.from === 'tv') void this.peer?.handleSignal(m.data as SignalData);
        return;
      case 'relay': {
        if (m.from !== 'tv') return;
        const data = this.chunks.accept('tv', m.data);
        if (data !== undefined) this.handle(data);
        return;
      }
      case 'tv.left':
        this.peer?.close();
        this.peer = undefined;
        this.setMode('relay');
        this.ev.emit('tv.left');
        return;
      case 'tv.back':
        this.ev.emit('tv.back');
        this.startPeer();
        return;
      case 'error': {
        if (this.joinWait) {
          // A stale rejoin token for this room is useless; forget it.
          if (this.code && m.code !== 'room.full') this.storage.removeItem(this.code);
          this.failJoin(new Error(m.code));
          this.teardown();
          return;
        }
        this.ev.emit('error', m.code);
        return;
      }
    }
  }

  private startPeer() {
    this.peer?.close();
    this.peer = undefined;
    this.setMode('relay');
    const RTC = this.o.RTCPeerConnection ?? ((globalThis as any).RTCPeerConnection as RTCCtor | undefined);
    if (this.o.transport === 'relay-only' || !RTC) return;
    const peer = new Peer({
      role: 'offerer', RTC, clock: this.clock, iceServers: this.o.iceServers, openTimeoutMs: this.o.openTimeoutMs,
      signal: (data) => this.sig.send({ t: 'signal', to: 'tv', data }),
      onMessage: (raw) => this.handle(raw),
      onMode: (mode) => { if (this.peer === peer) this.setMode(mode); },
    });
    this.peer = peer;
    void peer.start();
  }

  private setMode(m: Mode) {
    if (this._mode === m) return;
    this._mode = m;
    if (m === 'direct') this.flushQueue();
    this.ev.emit('mode', m);
  }

  private handle(raw: unknown) {
    const msg = parsePeerMsg(raw);
    if (!msg) return;
    if (msg.t === 'ping') return void this.send({ t: 'pong', id: msg.id });
    if (msg.t === 'pong') {
      const at = this.pings.get(msg.id);
      if (at !== undefined) { this.pings.delete(msg.id); this.rtt = this.clock.now() - at; }
      return;
    }
    this.ev.emit('msg', msg);
  }

  private ping() {
    const id = ++this.pingSeq;
    this.pings.set(id, this.clock.now());
    if (this.pings.size > 8) this.pings.delete(this.pings.keys().next().value!);
    if (this.peer?.sendReliable(JSON.stringify({ t: 'ping', id }))) return;
    if (this.joined) this.relay({ t: 'ping', id }); // pings are never queued
  }

  private relay(msg: PeerMsg) {
    for (const d of relayPayloads(msg)) if (!this.sig.send({ t: 'relay', to: 'tv', data: d })) return false;
    return true;
  }

  /** Reliable send: state channel when direct, else relay; queued (max 64) while both are down. */
  send(msg: PeerMsg): boolean {
    if (this.queue.size === 0 && this.trySendReliable(msg)) return true;
    return this.queue.push(msg);
  }

  private trySendReliable(msg: PeerMsg) {
    if (this.peer?.sendReliable(JSON.stringify(msg))) return true;
    return this.joined && this.relay(msg);
  }

  private flushQueue() {
    const items = this.queue.drain();
    for (let i = 0; i < items.length; i++) {
      if (!this.trySendReliable(items[i]!)) { for (const m of items.slice(i)) this.queue.push(m); return; }
    }
  }

  private sendLossy(msg: PeerMsg) {
    if (this.peer?.sendLossy(JSON.stringify(msg))) return;
    if (this.joined) this.relay(msg);
  }

  /**
   * Continuous fields (axes/buttons/tilt) go on the lossy channel, throttled to 30 Hz,
   * immediately on a button edge, with a 100 ms keepalive while anything is held.
   * One-shot fields (swipe/vote/text/draw) go reliably.
   */
  sendInput(frame: InputFrame) {
    const { t, axes, buttons, tilt, swipe, vote, text, draw } = frame;
    if (swipe !== undefined || vote !== undefined || text !== undefined || draw !== undefined) {
      const one: InputFrame = { t };
      if (swipe !== undefined) one.swipe = swipe;
      if (vote !== undefined) one.vote = vote;
      if (text !== undefined) one.text = text;
      if (draw !== undefined && draw.length <= MAX_DRAW_BYTES) one.draw = draw;
      if (Object.keys(one).length > 1) this.send({ t: 'input', frame: one });
    }
    if (axes === undefined && buttons === undefined && tilt === undefined) return;
    const cont: InputFrame = { t };
    if (axes !== undefined) cont.axes = axes;
    if (buttons !== undefined) cont.buttons = buttons;
    if (tilt !== undefined) cont.tilt = tilt;

    const interval = 1000 / (this.o.inputHz ?? INPUT_HZ);
    const now = this.clock.now();
    const edge = this.edge(buttons);
    if (edge || now - this.lastSentAt >= interval) return this.flushInput(cont, edge === 'release');
    this.pending = cont;
    if (this.pendingTimer === undefined) {
      this.pendingTimer = this.clock.setTimeout(() => {
        this.pendingTimer = undefined;
        const p = this.pending;
        if (p) this.flushInput(p, false);
      }, Math.max(0, this.lastSentAt + interval - now));
    }
  }

  /** 'press' if any button went down, 'release' if only releases, else undefined. */
  private edge(buttons?: Record<string, boolean>): 'press' | 'release' | undefined {
    if (!buttons) return undefined;
    let out: 'press' | 'release' | undefined;
    const keys = new Set([...Object.keys(buttons), ...Object.keys(this.lastButtons)]);
    for (const k of keys) {
      const now = !!buttons[k], was = !!this.lastButtons[k];
      if (now && !was) return 'press';
      if (!now && was) out = 'release';
    }
    return out;
  }

  private flushInput(f: InputFrame, release: boolean) {
    this.pending = undefined;
    if (this.pendingTimer !== undefined) { this.clock.clearTimeout(this.pendingTimer); this.pendingTimer = undefined; }
    if (this.repeatTimer !== undefined) { this.clock.clearTimeout(this.repeatTimer); this.repeatTimer = undefined; }
    // Keep `t` strictly increasing: the host drops continuous frames that are not newer.
    const out: InputFrame = this.lastOut && f.t <= this.lastOut.t ? { ...f, t: this.lastOut.t + 0.01 } : f;
    this.emitInput(out);
    if (out.buttons) this.lastButtons = { ...out.buttons };
    if (release) {
      this.repeatTimer = this.clock.setTimeout(() => {
        this.repeatTimer = undefined;
        if (this.lastOut === out) this.resendLatest();
      }, RELEASE_REPEAT_MS);
    }
    this.armKeepalive();
  }

  private emitInput(f: InputFrame) {
    this.lastOut = f;
    this.lastSentAt = this.clock.now();
    this.sendLossy({ t: 'input', frame: f });
  }

  /** Resend the latest continuous frame with an advanced timestamp. */
  private resendLatest() {
    const last = this.lastOut;
    if (!last) return;
    const now = this.clock.now();
    this.emitInput({ ...last, t: last.t + Math.max(0.01, now - this.lastSentAt) });
  }

  private armKeepalive() {
    if (this.keepTimer !== undefined) { this.clock.clearTimeout(this.keepTimer); this.keepTimer = undefined; }
    if (!this.lastOut || !isActive(this.lastOut)) return;
    this.keepTimer = this.clock.setTimeout(() => {
      this.keepTimer = undefined;
      if (this.pending) return; // a throttled real frame is about to go out
      this.resendLatest();
      this.armKeepalive();
    }, KEEPALIVE_MS);
  }
}
