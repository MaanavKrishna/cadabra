import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InputFrame, PeerMsg } from '@cadabra/spec';
import { CouchClient, CouchHost, MAX_DRAW_BYTES } from '../src/index';
import { BlockedRTC, FakeBackend, FakeRTC, MemStorage, resetFakes } from './fakes';

let backend: FakeBackend;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function mkHost(storage = new MemStorage()) {
  return new CouchHost({
    wsUrl: 'wss://x', household: 'h', WebSocket: backend.WebSocket as any,
    RTCPeerConnection: FakeRTC as any, storage,
  });
}
function mkClient(opts: { rtc?: typeof FakeRTC; storage?: MemStorage } = {}) {
  return new CouchClient({
    wsUrl: 'wss://x', WebSocket: backend.WebSocket as any,
    RTCPeerConnection: (opts.rtc ?? FakeRTC) as any, storage: opts.storage ?? new MemStorage(),
  });
}
async function setup(rtc?: typeof FakeRTC) {
  const host = mkHost();
  const p = host.create();
  await tick(0);
  const { code } = await p;
  const client = mkClient({ rtc });
  const j = client.join(code, 'Ana');
  await tick(0);
  const { playerId } = await j;
  return { host, client, code, playerId };
}
const relayed = () => backend.log.filter((m) => m.t === 'relay');

beforeEach(() => { vi.useFakeTimers(); resetFakes(); backend = new FakeBackend(); });
afterEach(() => { vi.useRealTimers(); });

describe('couchpad', () => {
  test('connects direct when the data channel opens', async () => {
    const { host, client, playerId } = await setup();
    const modes: string[] = [];
    client.on('mode', (m: string) => modes.push(m));
    await tick(100);
    expect(client.mode).toBe('direct');
    expect(modes).toEqual(['direct']);
    expect(host.players().get(playerId)?.transport).toBe('direct');
    const pc = FakeRTC.all[0]!; // phone is the offerer: first pc created, owns the channels
    const input = pc.channels.find((c) => c.label === 'input')!;
    expect(input.init).toEqual({ ordered: false, maxRetransmits: 0 });
    expect(pc.channels.find((c) => c.label === 'state')!.init.maxRetransmits).toBeUndefined();
    expect((pc.config as any).iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  test('falls back to relay after 4 s without open', async () => {
    const { host, client, playerId } = await setup(BlockedRTC);
    const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => got.push(f));
    // never blocks input while trying: before the timeout it already goes via relay
    client.sendInput({ t: 1, axes: { x: 1, y: 0 } });
    await tick(0);
    expect(got).toHaveLength(1);
    await tick(3900);
    const phonePc = FakeRTC.all[0]!;
    expect(phonePc.closed).toBe(false);
    await tick(200);
    expect(phonePc.closed).toBe(true);
    expect(client.mode).toBe('relay');
    client.sendInput({ t: 2, axes: { x: 0, y: 1 } });
    await tick(50);
    expect(got.at(-1)).toEqual({ t: 2, axes: { x: 0, y: 1 } });
    expect(host.players().get(playerId)?.transport).toBe('relay');
  });

  test('switches to relay on failed, and on disconnected > 2 s', async () => {
    const { client } = await setup();
    await tick(100);
    expect(client.mode).toBe('direct');
    const pc = FakeRTC.all[0]!;
    pc.setState('disconnected');
    await tick(1900);
    expect(client.mode).toBe('direct');
    pc.setState('connected');
    await tick(500);
    expect(client.mode).toBe('direct');
    pc.setState('disconnected');
    await tick(2100);
    expect(client.mode).toBe('relay');

    const s2 = await setup();
    await tick(100);
    const pc2 = FakeRTC.all.at(-2)!; // second phone's offerer
    expect(s2.client.mode).toBe('direct');
    pc2.setState('failed');
    expect(s2.client.mode).toBe('relay');
  });

  test('input sent on button edge immediately even when throttled', async () => {
    const { host, client } = await setup();
    await tick(100);
    const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => got.push(f));
    client.sendInput({ t: 1, axes: { x: 0.1, y: 0 } });
    await tick(0);
    expect(got).toHaveLength(1);
    client.sendInput({ t: 2, axes: { x: 0.2, y: 0 } }); // within 33 ms: throttled
    await tick(5);
    expect(got).toHaveLength(1);
    client.sendInput({ t: 3, axes: { x: 0.3, y: 0 }, buttons: { a: true } }); // edge
    await tick(0);
    expect(got).toHaveLength(2);
    expect(got[1]).toEqual({ t: 3, axes: { x: 0.3, y: 0 }, buttons: { a: true } });
    client.sendInput({ t: 4, axes: { x: 0.4, y: 0 }, buttons: { a: true } }); // held, not an edge
    await tick(0);
    expect(got).toHaveLength(2);
    await tick(40); // trailing frame flushes at 30 Hz with the latest sample
    expect(got).toHaveLength(3);
    expect(got[2]!.t).toBe(4);
    // all of it went over the direct input channel, none over relay
    expect(relayed().filter((m) => (m.data as PeerMsg).t === 'input')).toHaveLength(0);
  });

  test('one-shot fields are sent reliably, never on the lossy input channel', async () => {
    const { host, client } = await setup();
    await tick(100);
    const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => got.push(f));
    client.sendInput({ t: 1, axes: { x: 1, y: 0 }, swipe: 'up', vote: 2, text: 'hi', draw: 'data:image/png;base64,AAA' });
    await tick(50);
    const pc = FakeRTC.all[0]!;
    const sentOn = (label: string) => pc.channels.find((c) => c.label === label)!.sent.map((s) => JSON.parse(s) as PeerMsg);
    const lossy = sentOn('input').filter((m) => m.t === 'input');
    for (const m of lossy) {
      if (m.t !== 'input') continue;
      expect(m.frame.swipe ?? m.frame.vote ?? m.frame.text ?? m.frame.draw).toBeUndefined();
    }
    const reliable = sentOn('state').filter((m) => m.t === 'input');
    expect(reliable).toHaveLength(1);
    expect(got).toContainEqual({ t: 1, swipe: 'up', vote: 2, text: 'hi', draw: 'data:image/png;base64,AAA' });
    expect(got).toContainEqual({ t: 1, axes: { x: 1, y: 0 } });

    // oversized draw payloads are dropped before send
    got.length = 0;
    client.sendInput({ t: 2, draw: 'x'.repeat(MAX_DRAW_BYTES + 1), vote: 1 });
    await tick(50);
    expect(got).toEqual([{ t: 2, vote: 1 }]);
  });

  test('broadcast reaches direct and relay players', async () => {
    const host = mkHost();
    const p = host.create(); await tick(0);
    const { code } = await p;
    const direct = mkClient();
    const relay = mkClient({ rtc: BlockedRTC });
    const j1 = direct.join(code, 'D'); const j2 = relay.join(code, 'R');
    await tick(0);
    const [{ playerId: d }, { playerId: r }] = await Promise.all([j1, j2]);
    await tick(4100);
    expect(host.players().get(d)?.transport).toBe('direct');
    expect(host.players().get(r)?.transport).toBe('relay');
    const gotD: PeerMsg[] = []; const gotR: PeerMsg[] = [];
    direct.on('msg', (m: PeerMsg) => gotD.push(m));
    relay.on('msg', (m: PeerMsg) => gotR.push(m));
    const before = relayed().length;
    host.broadcast({ t: 'screen', name: 'vote' });
    await tick(10);
    expect(gotD).toEqual([{ t: 'screen', name: 'vote' }]);
    expect(gotR).toEqual([{ t: 'screen', name: 'vote' }]);
    const newRelays = relayed().slice(before);
    expect(newRelays).toHaveLength(1);
    expect(newRelays[0]!.to).toBe(r);
  });

  test('rejoin keeps playerId', async () => {
    const host = mkHost();
    const p = host.create(); await tick(0);
    const { code } = await p;
    const storage = new MemStorage();
    const c1 = mkClient({ storage });
    const j = c1.join(code, 'Ana'); await tick(0);
    const { playerId } = await j;
    expect(storage.getItem(code)).toBeTruthy();
    // page reload: a fresh client with the same sessionStorage
    const c2 = mkClient({ storage });
    const j2 = c2.join(code, 'Ana'); await tick(0);
    expect((await j2).playerId).toBe(playerId);
    expect(host.players().size).toBe(1);
    expect(host.players().get(playerId)?.connected).toBe(true);
  });

  test('client auto-reconnects the WS with backoff and rejoins', async () => {
    const { host, client, playerId } = await setup();
    await tick(100);
    const left: string[] = []; const joined: string[] = [];
    host.on('left', (id: string) => left.push(id));
    host.on('player', (id: string) => joined.push(id));
    const sockets = backend.sockets.length;
    backend.sockets.at(-1)!.drop(); // the phone's socket
    await tick(0);
    expect(left).toEqual([playerId]);
    expect(host.players().get(playerId)?.connected).toBe(false);
    await tick(3000);
    expect(backend.sockets.length).toBeGreaterThan(sockets);
    expect(joined).toContain(playerId);
    expect(host.players().get(playerId)?.connected).toBe(true);
    expect(host.players().size).toBe(1);
    await tick(200);
    expect(client.mode).toBe('direct');
    expect(host.players().get(playerId)?.transport).toBe('direct');
  });

  test('host resumes the room after its WS drops; phones see tv.left/tv.back and go direct again', async () => {
    const { host, client, code, playerId } = await setup();
    await tick(100);
    const events: string[] = [];
    client.on('tv.left', () => events.push('left'));
    client.on('tv.back', () => events.push('back'));
    backend.sockets[0]!.drop(); // the TV's socket
    await tick(0);
    expect(events).toEqual(['left']);
    expect(client.mode).toBe('relay');
    await tick(3000);
    expect(events).toEqual(['left', 'back']);
    expect(backend.log.some((m) => m.t === 'room.resume' && m.code === code)).toBe(true);
    await tick(200);
    expect(client.mode).toBe('direct');
    expect(host.players().get(playerId)?.transport).toBe('direct');
  });

  test('RTT is measured with a ping every 2 s', async () => {
    const { host, client, playerId } = await setup();
    await tick(100);
    expect(host.players().get(playerId)?.rttMs).toBe(0);
    await tick(2100);
    expect(host.players().get(playerId)?.rttMs).toBeGreaterThanOrEqual(0);
    expect(backend.log.length).toBeGreaterThan(0);
    // pings went over the direct state channel
    const statePc = FakeRTC.all[0]!.channels.find((c) => c.label === 'state')!;
    expect(statePc.sent.some((s) => JSON.parse(s).t === 'pong')).toBe(true);
    expect(client.rttMs()).toBeGreaterThanOrEqual(0);
  });
});
