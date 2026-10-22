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
