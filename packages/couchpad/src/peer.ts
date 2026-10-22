// One WebRTC link (phone <-> TV) with two data channels and relay-fallback rules.
import type { Clock } from './signaling';

export type Mode = 'direct' | 'relay';

export const STUN_URL = 'stun:stun.l.google.com:19302';
export const DEFAULT_ICE: { urls: string }[] = [{ urls: STUN_URL }];
export const OPEN_TIMEOUT_MS = 4000;
export const DISCONNECTED_GRACE_MS = 2000;

export interface ChannelLike {
  label: string;
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  send(data: string): void;
  close(): void;
}
export interface RTCLike {
  connectionState: string;
  localDescription: { type: string; sdp?: string } | null;
  remoteDescription: unknown;
  onicecandidate: ((ev: { candidate: any }) => void) | null;
  ondatachannel: ((ev: { channel: ChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(label: string, init?: { ordered?: boolean; maxRetransmits?: number }): ChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(d: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(d: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(c: any): Promise<void>;
  close(): void;
}
export type RTCCtor = new (config: { iceServers: { urls: string | string[] }[] }) => RTCLike;

/** Signal payload carried inside the backend's `signal` message. */
export type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: unknown };

export interface PeerOpts {
  role: 'offerer' | 'answerer';
  RTC: RTCCtor;
  clock: Clock;
  iceServers?: { urls: string | string[] }[];
  openTimeoutMs?: number;
  signal: (d: SignalData) => void;
  onMessage: (raw: string) => void;
  onMode: (m: Mode) => void;
}

/**
 * Starts in 'relay' (callers relay until the link opens, so input never blocks).
 * Becomes 'direct' once both channels open; falls back to 'relay' for good if it
 * doesn't open within 4 s, on 'failed', or on 'disconnected' lasting > 2 s.
 */
export class Peer {
  mode: Mode = 'relay';
  dead = false;
  private pc: RTCLike;
  private input?: ChannelLike;
  private state?: ChannelLike;
  private openTimer?: unknown;
  private discTimer?: unknown;
  private pendingCandidates: unknown[] = [];

  constructor(private o: PeerOpts) {
    this.pc = new o.RTC({ iceServers: o.iceServers ?? DEFAULT_ICE });
    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate || this.dead) return;
      const c = typeof ev.candidate.toJSON === 'function' ? ev.candidate.toJSON() : ev.candidate;
      o.signal({ kind: 'candidate', candidate: c });
    };
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
    this.pc.ondatachannel = (ev) => this.adopt(ev.channel);
    this.openTimer = o.clock.setTimeout(() => { if (this.mode !== 'direct') this.fail(); }, o.openTimeoutMs ?? OPEN_TIMEOUT_MS);
  }

  /** Offerer only: create channels and send the offer. */
  async start() {
    this.adopt(this.pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 }));
    this.adopt(this.pc.createDataChannel('state', { ordered: true }));
    try {
      const offer = await this.pc.createOffer();
      if (this.dead) return;
      await this.pc.setLocalDescription(offer);
      if (this.dead) return;
      this.o.signal({ kind: 'offer', sdp: offer.sdp ?? '' });
    } catch { this.fail(); }
  }

  async handleSignal(d: SignalData) {
    if (this.dead || !d || typeof d !== 'object') return;
    try {
      if (d.kind === 'offer' && this.o.role === 'answerer') {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        await this.flushCandidates();
        const answer = await this.pc.createAnswer();
        if (this.dead) return;
        await this.pc.setLocalDescription(answer);
        if (this.dead) return;
        this.o.signal({ kind: 'answer', sdp: answer.sdp ?? '' });
      } else if (d.kind === 'answer' && this.o.role === 'offerer') {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        await this.flushCandidates();
      } else if (d.kind === 'candidate') {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(d.candidate);
        else this.pendingCandidates.push(d.candidate);
      }
    } catch { /* a bad signal never takes the link down; the open timeout handles it */ }
  }

  private async flushCandidates() {
    const cs = this.pendingCandidates; this.pendingCandidates = [];
    for (const c of cs) { try { await this.pc.addIceCandidate(c); } catch { /* ignore */ } }
  }

  private adopt(ch: ChannelLike) {
    if (ch.label === 'input') this.input = ch;
    else if (ch.label === 'state') this.state = ch;
    else return;
    ch.onopen = () => this.checkOpen();
    ch.onclose = () => { if (this.mode === 'direct') this.fail(); };
    ch.onmessage = (ev) => { if (!this.dead && typeof ev.data === 'string') this.o.onMessage(ev.data); };
    if (ch.readyState === 'open') this.checkOpen();
  }

  private checkOpen() {
    if (this.dead || this.mode === 'direct') return;
    if (this.input?.readyState === 'open' && this.state?.readyState === 'open') {
      this.o.clock.clearTimeout(this.openTimer);
      this.setMode('direct');
    }
  }

  private onState(s: string) {
    if (this.dead) return;
    if (s === 'failed' || s === 'closed') return this.fail();
    if (s === 'disconnected') {
      if (this.discTimer === undefined) {
        this.discTimer = this.o.clock.setTimeout(() => {
          this.discTimer = undefined;
          if (this.pc.connectionState !== 'connected') this.fail();
        }, DISCONNECTED_GRACE_MS);
      }
    } else if (this.discTimer !== undefined) {
      this.o.clock.clearTimeout(this.discTimer);
      this.discTimer = undefined;
    }
  }

  private setMode(m: Mode) {
    if (this.mode === m) return;
    this.mode = m;
    this.o.onMode(m);
  }

  /** Give up on direct for this peer: close it and stay on relay. */
  fail() {
    if (this.dead) return;
    this.close();
    this.setMode('relay');
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    this.o.clock.clearTimeout(this.openTimer);
    if (this.discTimer !== undefined) this.o.clock.clearTimeout(this.discTimer);
    try { this.pc.close(); } catch { /* ignore */ }
  }

  /** Lossy channel. Returns false if it could not send (caller relays). */
  sendLossy(data: string) { return this.trySend(this.input, data); }
  /** Reliable channel. Returns false if it could not send (caller relays). */
  sendReliable(data: string) { return this.trySend(this.state, data); }

  private trySend(ch: ChannelLike | undefined, data: string) {
    if (this.dead || this.mode !== 'direct' || ch?.readyState !== 'open') return false;
    try { ch.send(data); return true; } catch { return false; }
  }
}
