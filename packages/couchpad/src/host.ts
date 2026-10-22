// TV side: owns the room, answers each phone's WebRTC offer, relays when direct is down.
import type { PeerMsg } from '@cadabra/spec';
import { PING_INTERVAL_MS, type TransportPolicy } from './client';
import { Peer, type Mode, type RTCCtor, type SignalData } from './peer';
import {
  Signaling, defaultClock, defaultStorage, type Clock, type StorageLike, type WebSocketCtor, type WireIn,
} from './signaling';
import { Emitter, parsePeerMsg, type Listener } from './util';

export interface CouchHostOpts {
  wsUrl: string;
  household: string;
  WebSocket?: WebSocketCtor;
  RTCPeerConnection?: RTCCtor;
  clock?: Clock;
  /** Holds the TV token so the room can be resumed. Defaults to sessionStorage. */
  storage?: StorageLike;
  iceServers?: { urls: string | string[] }[];
  transport?: TransportPolicy;
  pingIntervalMs?: number;
  openTimeoutMs?: number;
}

export interface PlayerView {
  name: string;
  avatar: string;
  connected: boolean;
  transport: Mode;
  rttMs: number;
}

interface PlayerState extends PlayerView {
  peer?: Peer;
  pings: Map<number, number>;
}

type HostEvent = 'player' | 'left' | 'input' | 'msg' | 'resumed' | 'error';

export const TV_TOKEN_KEY = (code: string) => `couchpad.tv.${code}`;
export const LAST_ROOM_KEY = 'couchpad.tv.last';

export class CouchHost {
  code?: string;
  private tvToken?: string;
  private sig: Signaling;
  private ev = new Emitter();
  private clock: Clock;
  private storage: StorageLike;
  private ps = new Map<string, PlayerState>();
  private wait?: { resolve: (v: { code: string }) => void; reject: (e: Error) => void };
  private pingTimer?: unknown;
  private pingSeq = 0;

  constructor(private o: CouchHostOpts) {
    this.clock = o.clock ?? defaultClock;
    this.storage = o.storage ?? defaultStorage();
    this.sig = new Signaling({
      url: o.wsUrl, WebSocket: o.WebSocket, clock: this.clock,
      onOpen: () => this.hello(),
      onMessage: (m) => this.onWire(m),
    });
  }

  on(ev: HostEvent, cb: Listener) { this.ev.on(ev, cb); }

  /** Create a new room. */
  create(): Promise<{ code: string }> {
    this.code = undefined; this.tvToken = undefined;
    return this.open();
  }

  /** Reclaim a room after a reload, using the stored TV token. */
  resume(code?: string): Promise<{ code: string }> {
    const c = (code ?? this.storage.getItem(LAST_ROOM_KEY) ?? '').toUpperCase();
    const tok = c ? this.storage.getItem(TV_TOKEN_KEY(c)) : null;
    if (!c || !tok) return Promise.reject(new Error('room.badToken'));
    this.code = c; this.tvToken = tok;
    return this.open();
  }

  private open() {
    return new Promise<{ code: string }>((resolve, reject) => {
      this.wait = { resolve, reject };
      this.sig.connect();
      if (this.pingTimer === undefined) {
        this.pingTimer = this.clock.setInterval(() => this.pingAll(), this.o.pingIntervalMs ?? PING_INTERVAL_MS);
      }
    });
  }

  /** On every (re)open: create the room the first time, resume it afterwards. */
  private hello() {
    if (this.code && this.tvToken) this.sig.send({ t: 'room.resume', code: this.code, tvToken: this.tvToken });
    else this.sig.send({ t: 'room.create', household: this.o.household });
  }

  close() {
    this.sig.close();
    if (this.pingTimer !== undefined) this.clock.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    for (const p of this.ps.values()) { p.peer?.close(); p.peer = undefined; }
  }

  players(): Map<string, PlayerView> {
    const out = new Map<string, PlayerView>();
    for (const [id, p] of this.ps) {
      out.set(id, { name: p.name, avatar: p.avatar, connected: p.connected, transport: p.transport, rttMs: p.rttMs });
    }
    return out;
  }

  broadcast(msg: PeerMsg) {
    for (const [id, p] of this.ps) if (p.connected) this.sendTo(id, msg);
  }

  /** Reliable send to one player: state channel when direct, else relay. */
  sendTo(playerId: string, msg: PeerMsg) {
    const p = this.ps.get(playerId);
    if (!p || !p.connected) return;
    if (p.peer?.sendReliable(JSON.stringify(msg))) return;
    this.sig.send({ t: 'relay', to: playerId, data: msg });
  }

  private settle(err?: Error) {
    const w = this.wait; this.wait = undefined;
    if (!w) return;
    if (err) w.reject(err); else w.resolve({ code: this.code! });
  }

  private onWire(m: WireIn) {
    switch (m.t) {
      case 'room.created':
        this.code = m.code; this.tvToken = m.tvToken;
        try {
          this.storage.setItem(TV_TOKEN_KEY(m.code), m.tvToken);
          this.storage.setItem(LAST_ROOM_KEY, m.code);
        } catch { /* storage blocked */ }
        return this.settle();
      case 'room.resumed':
        this.ev.emit('resumed', this.code);
        return this.settle();
      case 'player.joined': {
        const { id, name, avatar } = m.player;
        const prev = this.ps.get(id);
        prev?.peer?.close(); // a rejoining phone always re-offers
        this.ps.set(id, {
          name, avatar: avatar ?? prev?.avatar ?? '', connected: true, transport: 'relay',
          rttMs: prev?.rttMs ?? 0, pings: new Map(),
        });
        return this.ev.emit('player', id, { name, avatar: avatar ?? '' });
      }
      case 'player.left': {
        const p = this.ps.get(m.playerId);
        if (!p) return;
        p.peer?.close(); p.peer = undefined;
        p.connected = false; p.transport = 'relay';
        return this.ev.emit('left', m.playerId);
      }
      case 'signal':
        return this.onSignal(m.from, m.data as SignalData);
      case 'relay':
        return this.handle(m.from, m.data);
      case 'error':
        if (this.wait) {
          // Resume refused (room gone / bad token): forget the token so the app can create anew.
          if (this.code) this.storage.removeItem(TV_TOKEN_KEY(this.code));
          this.code = undefined; this.tvToken = undefined;
          this.sig.close();
          return this.settle(new Error(m.code));
        }
        return this.ev.emit('error', m.code);
    }
  }

  private onSignal(from: string, data: SignalData) {
    const p = this.ps.get(from);
    if (!p || !data || typeof data !== 'object') return;
    if (data.kind === 'offer') {
      p.peer?.close();
      p.peer = undefined;
      p.transport = 'relay';
      const RTC = this.o.RTCPeerConnection ?? ((globalThis as any).RTCPeerConnection as RTCCtor | undefined);
      if (this.o.transport === 'relay-only' || !RTC) return; // phone times out and relays
      const peer = new Peer({
        role: 'answerer', RTC, clock: this.clock, iceServers: this.o.iceServers, openTimeoutMs: this.o.openTimeoutMs,
        signal: (d) => this.sig.send({ t: 'signal', to: from, data: d }),
        onMessage: (raw) => this.handle(from, raw),
        onMode: (mode) => { if (p.peer === peer) p.transport = mode; },
      });
      p.peer = peer;
    }
    void p.peer?.handleSignal(data);
  }

  private handle(from: string, raw: unknown) {
    const p = this.ps.get(from);
    if (!p) return;
    const msg = parsePeerMsg(raw);
    if (!msg) return;
    switch (msg.t) {
      case 'input': return this.ev.emit('input', from, msg.frame);
      case 'ping': return this.sendTo(from, { t: 'pong', id: msg.id });
      case 'pong': {
        const at = p.pings.get(msg.id);
        if (at !== undefined) { p.pings.delete(msg.id); p.rttMs = this.clock.now() - at; }
        return;
      }
      default: return this.ev.emit('msg', from, msg);
    }
  }

  private pingAll() {
    for (const [id, p] of this.ps) {
      if (!p.connected) continue;
      const pid = ++this.pingSeq;
      p.pings.set(pid, this.clock.now());
      if (p.pings.size > 8) p.pings.delete(p.pings.keys().next().value!);
      this.sendTo(id, { t: 'ping', id: pid });
    }
  }
}
