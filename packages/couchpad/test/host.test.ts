import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { InputFrame, PeerMsg } from '@cadabra/spec';
import { CouchClient, CouchHost, MAX_DRAW_BYTES, RELAY_CHUNK_BYTES } from '../src/index';
import { BlockedRTC, FakeBackend, FakeRTC, MemStorage, WS_FRAME_MAX, resetFakes } from './fakes';

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
    wsUrl: 'wss://x', WebSocket: backend.WebSocket as any, random: () => 0.5,
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
    expect(got.at(-1)!.axes).toEqual({ x: 0, y: 1 });
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
    expect(got.filter((f) => !f.axes)).toEqual([{ t: 2, vote: 1 }]);
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

  test('a TV page reload resumes the room: fresh host with same storage gets re-offers and input', async () => {
    const storage = new MemStorage();
    const host1 = mkHost(storage);
    const p = host1.create(); await tick(0);
    const { code } = await p;
    const client = mkClient();
    const j = client.join(code, 'Ana'); await tick(0);
    const { playerId } = await j;
    await tick(100);
    expect(client.mode).toBe('direct');

    host1.close(); // page unload
    await tick(0);
    expect(client.mode).toBe('relay');
    const host2 = mkHost(storage);
    const joined: string[] = [];
    host2.on('player', (id: string) => joined.push(id));
    const got: InputFrame[] = [];
    host2.on('input', (_id: string, f: InputFrame) => got.push(f));
    const r = host2.resume(); await tick(0);
    expect(await r).toEqual({ code });
    expect(joined).toEqual([playerId]);
    expect(host2.players().get(playerId)).toMatchObject({ name: 'Ana', connected: true });
    // input flows even before the new direct link is up (relay) ...
    client.sendInput({ t: Date.now(), buttons: { a: true } });
    await tick(0);
    expect(got.at(-1)?.buttons).toEqual({ a: true });
    // ... and the phone's re-offer is accepted by the fresh host
    await tick(200);
    expect(client.mode).toBe('direct');
    expect(host2.players().get(playerId)?.transport).toBe('direct');
    client.sendInput({ t: Date.now(), buttons: { a: false } });
    await tick(0);
    expect(got.at(-1)?.buttons).toEqual({ a: false });
  });

  test('resume reconciles players: missing ones leave', async () => {
    const storage = new MemStorage();
    const host = mkHost(storage);
    const p = host.create(); await tick(0);
    const { code } = await p;
    const a = mkClient(); const b = mkClient();
    const ja = a.join(code, 'A'); const jb = b.join(code, 'B'); await tick(0);
    const [{ playerId: ia }, { playerId: ib }] = await Promise.all([ja, jb]);
    await tick(100);
    const left: string[] = [];
    host.on('left', (id: string) => left.push(id));
    // TV socket drops; while it is away B's phone goes too (its player.left is lost)
    backend.sockets[0]!.drop();
    await tick(0);
    b.close();
    await tick(3000);
    expect(left).toEqual([ib]);
    expect(host.players().get(ia)?.connected).toBe(true);
    expect(host.players().get(ib)?.connected).toBe(false);
  });

  test('a dropped button release still reaches the TV within 50 ms', async () => {
    const { host, client } = await setup();
    await tick(100);
    const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => got.push(f));
    client.sendInput({ t: Date.now(), buttons: { a: true } });
    await tick(0);
    expect(got.at(-1)?.buttons).toEqual({ a: true });
    const input = FakeRTC.all[0]!.channels.find((c) => c.label === 'input')!;
    let releases = 0;
    input.drop = (d) => JSON.parse(d).frame?.buttons?.a === false && ++releases === 1; // lose the first release
    await tick(10);
    client.sendInput({ t: Date.now(), buttons: { a: false } });
    await tick(0);
    expect(got.at(-1)?.buttons).toEqual({ a: true }); // release lost
    await tick(50);
    expect(releases).toBe(2); // original (lost) + repeat ~30 ms later
    expect(got.at(-1)?.buttons).toEqual({ a: false });
  });

  test('a button held still for 2 s stays held (keepalive well under 500 ms staleness)', async () => {
    const { host, client } = await setup();
    await tick(100);
    const at: number[] = []; const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => { at.push(Date.now()); got.push(f); });
    client.sendInput({ t: Date.now(), buttons: { a: true } });
    await tick(2000);
    expect(got.length).toBeGreaterThanOrEqual(15);
    expect(got.every((f) => f.buttons?.a === true)).toBe(true);
    const gaps = at.slice(1).map((x, i) => x - at[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(150);
    expect(Date.now() - at.at(-1)!).toBeLessThanOrEqual(150);
    for (let i = 1; i < got.length; i++) expect(got[i]!.t).toBeGreaterThan(got[i - 1]!.t);
    // released + idle -> keepalive stops
    client.sendInput({ t: Date.now(), buttons: { a: false } });
    await tick(100);
    const n = got.length;
    await tick(1000);
    expect(got.length).toBe(n);
  });

  test('host drops continuous input frames that are not newer', async () => {
    const { host, client } = await setup(BlockedRTC);
    const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => got.push(f));
    client.sendInput({ t: 1000, axes: { x: 1, y: 0 } });
    await tick(0);
    const phoneWs = backend.sockets.at(-1)!;
    phoneWs.send(JSON.stringify({ t: 'relay', to: 'tv', data: { t: 'input', frame: { t: 999, axes: { x: -1, y: 0 } } } }));
    phoneWs.send(JSON.stringify({ t: 'relay', to: 'tv', data: { t: 'input', frame: { t: 1000, axes: { x: -1, y: 0 } } } }));
    await tick(0);
    expect(got.map((f) => f.axes?.x)).toEqual([1]);
    // one-shots share the continuous frame's t and are never dropped as stale
    client.sendInput({ t: 1000, swipe: 'left' });
    await tick(0);
    expect(got.at(-1)).toEqual({ t: 1000, swipe: 'left' });
  });

  test('large relay messages are chunked under the WS frame limit and reassembled', async () => {
    const { host, client, playerId } = await setup(BlockedRTC);
    await tick(4100);
    const big = 'x'.repeat(100 * 1024);
    const gotPhone: PeerMsg[] = [];
    client.on('msg', (m: PeerMsg) => gotPhone.push(m));
    expect(host.sendTo(playerId, { t: 'screen', name: 'results', data: { big } })).toBe(true);
    await tick(0);
    expect(gotPhone).toEqual([{ t: 'screen', name: 'results', data: { big } }]);
    const draw = 'data:image/png;base64,' + 'A"\\é'.repeat(30 * 1024); // escaping + multibyte
    expect(draw.length).toBeLessThanOrEqual(MAX_DRAW_BYTES);
    const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => got.push(f));
    client.sendInput({ t: 5, draw });
    await tick(0);
    expect(got).toEqual([{ t: 5, draw }]);
    expect(backend.maxFrame).toBeLessThanOrEqual(WS_FRAME_MAX);
    expect(backend.maxFrame).toBeGreaterThan(RELAY_CHUNK_BYTES / 2);
  });

  test('partial chunk sets expire after 10 s', async () => {
    const { host, client } = await setup(BlockedRTC);
    await tick(4100);
    const got: InputFrame[] = [];
    host.on('input', (_id: string, f: InputFrame) => got.push(f));
    const phoneWs = backend.sockets.at(-1)!;
    const send = (seq: number) => phoneWs.send(JSON.stringify({ t: 'relay', to: 'tv', data: { t: '~chunk', id: 777, seq, total: 2, part: seq === 0 ? '{"t":"input","frame":{"t":1,' : '"vote":1}}' } }));
    send(0);
    await tick(10_001);
    send(1);
    await tick(0);
    expect(got).toEqual([]);
    send(0);
    await tick(0);
    expect(got).toEqual([{ t: 1, vote: 1 }]);
    void client;
  });

  test('reliable messages queue while the WS is down and flush on rejoin', async () => {
    const { host, client, playerId } = await setup(BlockedRTC);
    await tick(4100);
    const msgs: PeerMsg[] = [];
    host.on('msg', (_id: string, m: PeerMsg) => msgs.push(m));
    backend.sockets.at(-1)!.drop();
    await tick(0);
    expect(client.send({ t: 'screen', name: 'wait' })).toBe(true);
    expect(msgs).toEqual([]);
    await tick(1000);
    expect(msgs).toEqual([{ t: 'screen', name: 'wait' }]);
    for (let i = 0; i < 70; i++) client.send({ t: 'screen', name: 'vote' }); // fine while up
    void playerId;
  });

  test('reliable queue is bounded at 64', async () => {
    const { client } = await setup(BlockedRTC);
    await tick(4100);
    backend.sockets.at(-1)!.drop();
    await tick(0);
    const results = Array.from({ length: 65 }, () => client.send({ t: 'screen', name: 'wait' }));
    expect(results.filter(Boolean)).toHaveLength(64);
    expect(results[64]).toBe(false);
  });

  test('backoff resets only after a stable 3 s open', async () => {
    const { client } = await setup(BlockedRTC);
    void client;
    await tick(4100); // stable for > 3 s
    const n0 = backend.sockets.length;
    backend.sockets.at(-1)!.drop();
    await tick(240);
    expect(backend.sockets.length).toBe(n0);
    await tick(20); // 250 ms (jitter pinned to 0)
    expect(backend.sockets.length).toBe(n0 + 1);
    await tick(10);
    backend.sockets.at(-1)!.drop(); // flapping: dropped right after open
    await tick(490);
    expect(backend.sockets.length).toBe(n0 + 1);
    await tick(20); // next step 500 ms, not reset to 250
    expect(backend.sockets.length).toBe(n0 + 2);
  });

  test('join times out after 8 s; a second join supersedes the first', async () => {
    const host = mkHost();
    const p = host.create(); await tick(0);
    const { code } = await p;
    backend.mute = true;
    const c = mkClient();
    const j1 = c.join(code, 'A');
    const r1 = expect(j1).rejects.toThrow('join.timeout');
    await tick(8001);
    await r1;
    const j2 = c.join(code, 'A');
    const r2 = expect(j2).rejects.toThrow('join.superseded');
    backend.mute = false;
    const j3 = c.join(code, 'B');
    await r2;
    await tick(0);
    expect((await j3).playerId).toBeTruthy();
    expect(host.players().size).toBe(1);
    c.close();
    const before = backend.log.length;
    await tick(10_000); // close() stops pings and reconnects
    expect(backend.log.length).toBe(before);
  });
});
