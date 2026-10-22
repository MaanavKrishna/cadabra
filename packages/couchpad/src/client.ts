// Phone side: joins a room, offers WebRTC to the TV, relays through the WS when direct is down.
import type { InputFrame, PeerMsg } from '@cadabra/spec';
import { Peer, type Mode, type RTCCtor, type SignalData } from './peer';
import {
  Signaling, defaultClock, defaultStorage, type Clock, type StorageLike, type WebSocketCtor, type WireIn,
} from './signaling';
import { Emitter, MAX_DRAW_BYTES, parsePeerMsg, type Listener } from './util';

export interface Transport {
  sendInput(frame: InputFrame): void;
  send(msg: PeerMsg): void;
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
  /** Rejoin tokens, keyed by room code. Defaults to sessionStorage. */
  storage?: StorageLike;
  iceServers?: { urls: string | string[] }[];
  /** 'relay-only' skips WebRTC entirely (e.g. TRANSPORT=relay-only). */
  transport?: TransportPolicy;
  inputHz?: number;
  pingIntervalMs?: number;
  openTimeoutMs?: number;
}

export const INPUT_HZ = 30;
export const PING_INTERVAL_MS = 2000;

type ClientEvent = 'msg' | 'mode' | 'tv.left' | 'tv.back' | 'error';

export class CouchClient implements Transport {
  playerId?: string;
  private code?: string;
  private name = '';
  private sig: Signaling;
  private peer?: Peer;
  private ev = new Emitter();
  private clock: Clock;
  private storage: StorageLike;
  private _mode: Mode = 'relay';
  private joinWait?: { resolve: (v: { playerId: string }) => void; reject: (e: Error) => void };
  // input throttle
  private lastSentAt = -Infinity;
  private lastButtons: Record<string, boolean> = {};
  private pending?: InputFrame;
  private pendingTimer?: unknown;
  // rtt
  private pingTimer?: unknown;
  private pingSeq = 0;
  private pings = new Map<number, number>();
  private rtt = 0;

  constructor(private o: CouchClientOpts) {
    this.clock = o.clock ?? defaultClock;
    this.storage = o.storage ?? defaultStorage();
    this.sig = new Signaling({
      url: o.wsUrl, WebSocket: o.WebSocket, clock: this.clock,
      onOpen: () => this.sendJoin(),
      onMessage: (m) => this.onWire(m),
    });
  }

  get mode(): Mode { return this._mode; }
  rttMs() { return this.rtt; }
  on(ev: ClientEvent, cb: Listener) { this.ev.on(ev, cb); }
  onMessage(cb: (m: PeerMsg) => void) { this.ev.on('msg', cb); }

  join(code: string, name: string): Promise<{ playerId: string }> {
    this.code = code.toUpperCase();
    this.name = name;
    return new Promise((resolve, reject) => {
      this.joinWait = { resolve, reject };
      this.sig.connect();
    });
  }

  close() {
    this.sig.close();
    this.peer?.close();
    this.peer = undefined;
    if (this.pingTimer !== undefined) this.clock.clearInterval(this.pingTimer);
    if (this.pendingTimer !== undefined) this.clock.clearTimeout(this.pendingTimer);
    this.setMode('relay');
  }

  private sendJoin() {
    if (!this.code) return;
    const rejoinToken = this.storage.getItem(this.code) ?? undefined;
    this.sig.send({ t: 'room.join', code: this.code, name: this.name, rejoinToken });
  }

  private onWire(m: WireIn) {
    switch (m.t) {
      case 'room.joined': {
        this.playerId = m.playerId;
        try { this.storage.setItem(this.code!, m.token); } catch { /* storage full/blocked */ }
        const w = this.joinWait; this.joinWait = undefined;
        w?.resolve({ playerId: m.playerId });
        if (this.pingTimer === undefined) {
          this.pingTimer = this.clock.setInterval(() => this.ping(), this.o.pingIntervalMs ?? PING_INTERVAL_MS);
        }
        this.startPeer(); // fresh link after every (re)join; the TV dropped the old one
        return;
      }
      case 'signal':
        if (m.from === 'tv') void this.peer?.handleSignal(m.data as SignalData);
        return;
      case 'relay':
        if (m.from === 'tv') this.handle(m.data);
        return;
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
          const w = this.joinWait; this.joinWait = undefined;
          // A stale rejoin token for this room is useless; forget it.
          if (this.code && m.code !== 'room.full') this.storage.removeItem(this.code);
          this.sig.close();
          w.reject(new Error(m.code));
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
    this.ev.emit('mode', m);
  }

  private handle(raw: unknown) {
    const msg = parsePeerMsg(raw);
    if (!msg) return;
    if (msg.t === 'ping') return this.send({ t: 'pong', id: msg.id });
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
    this.send({ t: 'ping', id });
  }

  /** Reliable send: state channel when direct, else relay. */
  send(msg: PeerMsg) {
    if (this.peer?.sendReliable(JSON.stringify(msg))) return;
    this.sig.send({ t: 'relay', to: 'tv', data: msg });
  }

  private sendLossy(msg: PeerMsg) {
    if (this.peer?.sendLossy(JSON.stringify(msg))) return;
    this.sig.send({ t: 'relay', to: 'tv', data: msg });
  }

  /**
   * Continuous fields (axes/buttons/tilt) go on the lossy channel, throttled to 30 Hz,
   * immediately on a button edge. One-shot fields (swipe/vote/text/draw) go reliably.
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
    if (this.isEdge(buttons) || now - this.lastSentAt >= interval) return this.flushInput(cont);
    this.pending = cont;
    if (this.pendingTimer === undefined) {
      this.pendingTimer = this.clock.setTimeout(() => {
        this.pendingTimer = undefined;
        const p = this.pending;
        if (p) this.flushInput(p);
      }, Math.max(0, this.lastSentAt + interval - now));
    }
  }

  private isEdge(buttons?: Record<string, boolean>) {
    if (!buttons) return false;
    const keys = new Set([...Object.keys(buttons), ...Object.keys(this.lastButtons)]);
    for (const k of keys) if (!!buttons[k] !== !!this.lastButtons[k]) return true;
    return false;
  }

  private flushInput(f: InputFrame) {
    this.pending = undefined;
    if (this.pendingTimer !== undefined) { this.clock.clearTimeout(this.pendingTimer); this.pendingTimer = undefined; }
    this.lastSentAt = this.clock.now();
    if (f.buttons) this.lastButtons = { ...f.buttons };
    this.sendLossy({ t: 'input', frame: f });
  }
}
