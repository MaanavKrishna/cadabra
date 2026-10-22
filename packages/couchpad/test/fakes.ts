// Test doubles: an in-memory backend that mirrors apps/backend/src/rooms.ts semantics,
// a fake WebSocket bound to it, and a fake RTCPeerConnection pair.
import type { BackendToClient, ClientToBackend } from '@cadabra/spec';

/** API Gateway WebSocket frame limit. */
export const WS_FRAME_MAX = 32 * 1024;

let seq = 0;
const id = (p: string) => `${p}${++seq}`;

interface PlayerRec { playerId: string; name: string; token: string; conn?: FakeWebSocket }
interface Room { tv?: FakeWebSocket; tvToken: string; players: Map<string, PlayerRec> }

export class FakeBackend {
  rooms = new Map<string, Room>();
  conns = new Map<FakeWebSocket, { code: string; role: 'tv' | 'player'; playerId?: string }>();
  sockets: FakeWebSocket[] = [];
  /** every message the backend received (for asserting relay use). */
  log: ClientToBackend[] = [];
  maxFrame = 0;

  private out(ws: FakeWebSocket | undefined, msg: BackendToClient) {
    if (!ws || ws.readyState !== 1) return false;
    ws.deliver(msg);
    return true;
  }

  /** when true the backend swallows everything (unresponsive server). */
  mute = false;

  handle(ws: FakeWebSocket, m: ClientToBackend) {
    this.log.push(m);
    if (this.mute) return;
    switch (m.t) {
      case 'room.create': {
        const code = `R${String(++seq).padStart(3, 'B')}`.slice(0, 4).toUpperCase();
        this.rooms.set(code, { tv: ws, tvToken: `tvtok-${code}`, players: new Map() });
        this.conns.set(ws, { code, role: 'tv' });
        return void this.out(ws, { t: 'room.created', code, tvToken: `tvtok-${code}` });
      }
      case 'room.join': {
        const room = this.rooms.get(m.code.toUpperCase());
        if (!room) return void this.out(ws, { t: 'error', code: 'room.notFound' });
        let p = m.rejoinToken ? [...room.players.values()].find((x) => x.token === m.rejoinToken) : undefined;
        if (p) {
          if (p.conn && p.conn !== ws) this.conns.delete(p.conn);
          p.conn = ws;
        } else {
          if (room.players.size >= 4) return void this.out(ws, { t: 'error', code: 'room.full' });
          p = { playerId: id('p'), name: m.name, token: id('tok'), conn: ws };
          room.players.set(p.playerId, p);
        }
        this.conns.set(ws, { code: m.code.toUpperCase(), role: 'player', playerId: p.playerId });
        this.out(ws, { t: 'room.joined', playerId: p.playerId, token: p.token, name: p.name });
        this.out(room.tv, { t: 'player.joined', player: { id: p.playerId, name: p.name } });
        if (!room.tv) this.out(ws, { t: 'tv.left' });
        return;
      }
      case 'room.resume': {
        const room = this.rooms.get(m.code);
        if (!room) return void this.out(ws, { t: 'error', code: 'room.notFound' });
        if (room.tvToken !== m.tvToken) return void this.out(ws, { t: 'error', code: 'room.badToken' });
        if (room.tv && room.tv !== ws) this.conns.delete(room.tv);
        room.tv = ws;
        this.conns.set(ws, { code: m.code, role: 'tv' });
        const live = [...room.players.values()].filter((p) => p.conn);
        this.out(ws, { t: 'room.resumed', players: live.map((p) => ({ id: p.playerId, name: p.name })) });
        for (const p of room.players.values()) this.out(p.conn, { t: 'tv.back' });
        return;
      }
      case 'signal':
      case 'relay': {
        const me = this.conns.get(ws);
        if (!me) return void this.out(ws, { t: 'error', code: 'room.notInRoom' });
        const room = this.rooms.get(me.code)!;
        const from = me.role === 'tv' ? 'tv' : me.playerId!;
        const to = m.to ?? 'tv';
        if (me.role === 'tv' && to === 'tv') return void this.out(ws, { t: 'error', code: 'room.badRequest' });
        if (me.role === 'player' && to !== 'tv') return void this.out(ws, { t: 'error', code: 'room.badRequest' });
        const target = to === 'tv' ? room.tv : room.players.get(to)?.conn;
        if (!this.out(target, { t: m.t, from, data: m.data } as BackendToClient)) {
          this.out(ws, { t: 'error', code: 'room.targetGone' });
        }
        return;
      }
      case 'ping':
        return void this.out(ws, { t: 'pong' });
    }
  }

  disconnect(ws: FakeWebSocket) {
    const me = this.conns.get(ws);
    if (!me) return;
    this.conns.delete(ws);
    const room = this.rooms.get(me.code)!;
    if (me.role === 'tv') {
      if (room.tv !== ws) return;
      room.tv = undefined;
      for (const p of room.players.values()) this.out(p.conn, { t: 'tv.left' });
      return;
    }
    const p = room.players.get(me.playerId!);
    if (p && p.conn === ws) p.conn = undefined;
    this.out(room.tv, { t: 'player.left', playerId: me.playerId! });
  }

  /** A WebSocket constructor bound to this backend. */
  get WebSocket() {
    const backend = this;
    return class extends FakeWebSocket { constructor(url: string) { super(url, backend); } };
  }
}

export class FakeWebSocket {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string, readonly backend: FakeBackend) {
    backend.sockets.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error('ws not open');
    if (data.length > WS_FRAME_MAX) throw new Error(`ws frame too large: ${data.length}`);
    this.backend.maxFrame = Math.max(this.backend.maxFrame, data.length);
    const m = JSON.parse(data) as ClientToBackend;
    queueMicrotask(() => this.backend.handle(this, m));
  }
  deliver(msg: BackendToClient) {
    const data = JSON.stringify(msg);
    if (data.length > WS_FRAME_MAX) throw new Error(`ws frame too large: ${data.length}`);
    queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data }); });
  }
  close() { this.drop(); }
  /** Simulate the network dropping the socket. */
  drop() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.backend.disconnect(this);
    queueMicrotask(() => this.onclose?.({}));
  }
}

// ---------------- RTC ----------------

export class FakeChannel {
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  peer?: FakeChannel;
  sent: string[] = [];
  /** return true to silently lose this message (lossy-link simulation). */
  drop?: (data: string) => boolean;
  constructor(public label: string, public init: { ordered?: boolean; maxRetransmits?: number } = {}) {}
  send(data: string) {
    if (this.readyState !== 'open') throw new Error('channel not open');
    this.sent.push(data);
    if (this.drop?.(data)) return;
    const p = this.peer;
    queueMicrotask(() => { if (p?.readyState === 'open') p.onmessage?.({ data }); });
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    if (this.peer && this.peer.readyState !== 'closed') this.peer.close();
  }
  open() { this.readyState = 'open'; this.onopen?.(); }
}

const pcs = new Map<string, FakeRTC>();

export class FakeRTC {
  static all: FakeRTC[] = [];
  /** when true, instances never connect (simulates blocked UDP / no TURN). */
  static blocked = false;
  readonly pcId = id('pc');
  connectionState: string = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channels: FakeChannel[] = [];
  candidates: unknown[] = [];
  closed = false;
  blocked = FakeRTC.blocked;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((ev: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(public config?: unknown) {
    pcs.set(this.pcId, this);
    FakeRTC.all.push(this);
  }
  createDataChannel(label: string, init?: { ordered?: boolean; maxRetransmits?: number }) {
    const ch = new FakeChannel(label, init);
    this.channels.push(ch);
    return ch;
  }
  async createOffer() { return { type: 'offer', sdp: `fake:${this.pcId}` }; }
  async createAnswer() { return { type: 'answer', sdp: `fake:${this.pcId}` }; }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    queueMicrotask(() => this.onicecandidate?.({ candidate: { candidate: `cand-${this.pcId}` } }));
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === 'answer') {
      const other = pcs.get(d.sdp.slice(5))!;
      if (this.blocked || other.blocked) return;
      setTimeout(() => this.link(other), 50);
    }
  }
  async addIceCandidate(c: unknown) { this.candidates.push(c); }
  private link(other: FakeRTC) {
    if (this.closed || other.closed) return;
    const pairs = this.channels.map((ch) => {
      const twin = new FakeChannel(ch.label, ch.init);
      ch.peer = twin; twin.peer = ch;
      other.channels.push(twin);
      other.ondatachannel?.({ channel: twin });
      return [ch, twin] as const;
    });
    this.setState('connected'); other.setState('connected');
    for (const [a, b] of pairs) { a.open(); b.open(); }
  }
  setState(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    for (const c of this.channels) c.close();
  }
}

export function resetFakes() {
  FakeRTC.all = [];
  FakeRTC.blocked = false;
  pcs.clear();
}

export class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

/** A FakeRTC constructor whose instances never connect. */
export class BlockedRTC extends FakeRTC { override blocked = true; }
