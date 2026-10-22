import { CouchClient } from '@cadabra/couchpad';
import type { InputFrame, PeerMsg } from '@cadabra/spec';

/** The slice of CouchClient the app uses (a fake implements it in tests). */
export interface ControllerClient {
  readonly mode: 'direct' | 'relay';
  join(code: string, name: string): Promise<{ playerId: string }>;
  send(msg: PeerMsg): boolean;
  sendInput(frame: InputFrame): void;
  on(ev: 'msg' | 'mode' | 'tv.left' | 'tv.back' | 'error', cb: (...a: any[]) => void): void;
  close(): void;
}

export const WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? 'wss://tbwr8dnm1d.execute-api.ap-south-1.amazonaws.com/prod';

export function createClient(): ControllerClient {
  const relayOnly = new URLSearchParams(location.search).get('transport') === 'relay-only';
  return new CouchClient({ wsUrl: WS_URL, transport: relayOnly ? 'relay-only' : 'auto' });
}
