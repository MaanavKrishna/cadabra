// The TV's room: couchpad host (phones, inputs, screens) plus the backend messages couchpad does
// not surface (host voice, judgements). Never throws into the UI; offline just means no phones.
import { CouchHost, type PlayerView } from '@cadabra/couchpad';
import type { BackendToClient, ClientToBackend, InputFrame, PeerMsg, ScreenData, ScreenName } from '@cadabra/spec';

export const WS_URL = 'wss://tbwr8dnm1d.execute-api.ap-south-1.amazonaws.com/prod';
export const CONTROLLER_URL = 'https://d3g2ct6wjlkyzv.cloudfront.net/';
export const joinUrl = (code: string) => `${CONTROLLER_URL}?r=${encodeURIComponent(code)}`;

export interface RoomEvents {
  code(code: string): void;
  join(id: string, name: string, avatar: string): void;
  left(id: string): void;
  input(id: string, frame: InputFrame): void;
  msg(id: string, msg: PeerMsg): void;
  backend(m: BackendToClient): void;
  status(s: 'connecting' | 'online' | 'offline'): void;
}

type Wire = { sig: { send(m: ClientToBackend): boolean }; onWire(m: BackendToClient): void };

export class Room {
  host?: CouchHost;
  code = '';
  status: 'connecting' | 'online' | 'offline' = 'connecting';
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;

  constructor(private ev: RoomEvents, private household = 'tv') {}

  start(): void {
    this.setStatus('connecting');
    const host = new CouchHost({ wsUrl: WS_URL, household: this.household });
    this.host = host;
    this.tap(host);
    host.on('player', (id: string, info: { name: string; avatar: string }) => this.ev.join(id, info.name, info.avatar));
    host.on('left', (id: string) => this.ev.left(id));
    host.on('input', (id: string, f: InputFrame) => this.ev.input(id, f));
    host.on('msg', (id: string, m: PeerMsg) => this.ev.msg(id, m));
    host.on('resumed', () => this.setStatus('online'));
    // Resume this TV's room after a reload (phones keep their code); otherwise create one.
    const open = () => host.resume().catch(() => host.create());
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 12_000));
    Promise.race([open(), timeout])
      .then(({ code }) => {
        this.attempt = 0;
        this.code = code;
        this.ev.code(code);
        this.setStatus('online');
      })
      .catch((e) => {
        console.warn('[tv] room open failed', e);
        this.setStatus('offline');
        host.close();
        if (this.host === host) this.host = undefined;
        const wait = Math.min(30_000, 3000 * 2 ** this.attempt++);
        this.retry = setTimeout(() => this.start(), wait);
      });
  }

  close(): void {
    clearTimeout(this.retry);
    this.host?.close();
  }

  players(): Map<string, PlayerView> {
    return this.host?.players() ?? new Map();
  }

  screen<K extends ScreenName>(to: string, name: K, data: Partial<ScreenData[K]>): void {
    this.host?.sendTo(to, { t: 'screen', name, data });
  }

  /** TV-only backend request (host.say, host.roast, judge.request). false = not sent. */
  send(m: ClientToBackend): boolean {
    if (!this.host || this.status !== 'online') return false;
    try {
      return (this.host as unknown as Wire).sig.send(m);
    } catch {
      return false;
    }
  }

  /**
   * couchpad's CouchHost keeps backend replies it does not know (host.audio, judge.result,
   * forge.*) to itself and has no public send for them. Until it grows one, tap its wire.
   */
  private tap(host: CouchHost): void {
    const w = host as unknown as Wire;
    const orig = w.onWire.bind(host);
    w.onWire = (m: BackendToClient) => {
      orig(m);
      try {
        this.ev.backend(m);
      } catch (e) {
        console.error('[tv] backend handler failed', e);
      }
    };
  }

  private setStatus(s: Room['status']): void {
    this.status = s;
    this.ev.status(s);
  }
}
