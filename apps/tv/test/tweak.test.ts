import { describe, expect, test } from 'vitest';
import { BlockRegistry, playtest, registerBuiltins } from '@cadabra/engine';
import { FALLBACK_SPECS, replyMsg, type GameSpec } from '@cadabra/spec';
import { initialState, reduce, type PartyState } from '../src/state/machine';
import { phoneScreen } from '../src/net/screens';
import { phoneAction } from '../src/net/replies';
import { addAsk, chipOf, presetTweak, remixTitle, toRequests } from '../src/tweak/tweak';
import { rootId, tweakId } from '../src/fallback/lineage';
import { keyArtFor } from '../src/fallback';
import { introFor } from '../src/play/intro';

const reg = new BlockRegistry();
registerBuiltins(reg);
const byId = (id: string) => FALLBACK_SPECS.find((s) => s.id === id)!;
const ring = byId('fallback-ring-out');

function seated(): PartyState {
  let s = initialState('ABCD');
  s = reduce(s, { type: 'join', id: 'a', name: 'Asha' });
  s = reduce(s, { type: 'join', id: 'b', name: 'Ravi' });
  return s;
}

describe('tweak requests', () => {
  test('chips from typed text', () => {
    expect(chipOf('Low gravity')).toBe('low-gravity');
    expect(chipOf('make it floaty!')).toBe('low-gravity');
    expect(chipOf('turbo speed')).toBe('faster');
    expect(chipOf('pinball walls')).toBe('bouncier');
    expect(chipOf('total mayhem')).toBe('more-chaos');
    expect(chipOf('nerf the leader')).toBe('harder-for-leader');
    expect(chipOf('purple hats')).toBeUndefined();
  });

  test('dedupes and keeps the first three', () => {
    let l = addAsk([], { by: 'a', chip: 'faster' });
    l = addAsk(l, { by: 'b', chip: 'faster' });
    l = addAsk(l, { by: 'b', text: 'Ice floor' });
    l = addAsk(l, { by: 'a', text: '  ice floor ' });
    l = addAsk(l, { by: 'a', text: '' });
    l = addAsk(l, { by: 'a', chip: 'bouncier' });
    l = addAsk(l, { by: 'b', chip: 'more-chaos' });
    expect(l.map((x) => x.chip ?? x.text)).toEqual(['faster', 'Ice floor', 'bouncier']);
    expect(toRequests(l)).toEqual([{ chip: 'faster', playerId: 'a' }, { text: 'Ice floor', playerId: 'b' }, { chip: 'bouncier', playerId: 'a' }]);
  });

  test('phone tweak.ask replies become tweakAsk actions', () => {
    expect(phoneAction('a', replyMsg({ reply: 'tweak.ask', chip: 'bouncier' }))).toEqual({ type: 'tweakAsk', ask: { by: 'a', chip: 'bouncier' } });
    expect(phoneAction('a', replyMsg({ reply: 'tweak.ask', text: 'Faster' }))).toEqual({ type: 'tweakAsk', ask: { by: 'a', chip: 'faster' } });
    expect(phoneAction('a', replyMsg({ reply: 'tweak.ask', text: 'giant players' }))).toEqual({ type: 'tweakAsk', ask: { by: 'a', text: 'giant players' } });
    expect(phoneAction('a', replyMsg({ reply: 'tweak.ask' }))).toBeUndefined();
  });
});

describe('local preset tweaks', () => {
  test('every chip changes Ring Out and the result still passes the playtest', () => {
    for (const chip of ['low-gravity', 'faster', 'bigger-arena', 'bouncier', 'more-chaos', 'harder-for-leader'] as const) {
      const r = presetTweak(ring, [{ by: 'a', chip }], reg, 1_700_000_000_000);
      expect(r.source, chip).toBe('preset');
      expect(r.changes.length, chip).toBe(1);
      expect(r.spec.id).not.toBe(ring.id);
      expect(r.spec.origin.parentId).toBe(ring.id);
      expect(r.spec.title).toBe('RING OUT REMIX');
      const report = playtest(r.spec, reg, { players: 4 });
      expect(report.reasons, chip).toEqual([]);
    }
  });

  test('params are clamped to the block schema and the base spec is untouched', () => {
    const before = JSON.stringify(ring);
    let spec: GameSpec = ring;
    for (let i = 0; i < 8; i++) spec = presetTweak(spec, [{ by: 'a', chip: 'faster' }], reg).spec;
    const p = spec.blocks[0]!.params as Record<string, number>;
    expect(p.speed).toBeLessThanOrEqual(600);
    expect(p.accel).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(ring)).toBe(before);
  });

  test('summary joins the change tags; nothing applicable means the same spec', () => {
    const r = presetTweak(ring, [{ by: 'a', chip: 'low-gravity' }, { by: 'b', text: 'way more bounce' }], reg);
    expect(r.summary).toBe('Gravity ×0.4 · Bounce ↑');
    const none = presetTweak(ring, [{ by: 'a', text: 'purple hats' }], reg);
    expect(none).toMatchObject({ source: 'none', spec: ring, changes: [] });
  });

  test('every built-in game takes every chip and still plays', () => {
    for (const base of FALLBACK_SPECS) {
      const r = presetTweak(base, [{ by: 'a', chip: 'more-chaos' }, { by: 'b', chip: 'faster' }, { by: 'a', chip: 'harder-for-leader' }], reg);
      expect(playtest(r.spec, reg, { players: 4 }).reasons, base.id).toEqual([]);
    }
  });

  test('remix titles fit the 40-char cap', () => {
    expect(remixTitle('Neon Dash')).toBe('Neon Dash Remix');
    expect(remixTitle('RING OUT REMIX')).toBe('RING OUT REMIX');
    expect(remixTitle('x'.repeat(38))).toBe('x'.repeat(38));
  });
});

describe('lineage', () => {
  test('tweaks of a built-in keep its still and intro', () => {
    const id = tweakId(ring, 123);
    const child = { ...ring, id, origin: { ...ring.origin, parentId: ring.id } };
    expect(rootId(child)).toBe(ring.id);
    const grandchild = { ...ring, id: 'backend-xyz', origin: { ...ring.origin, parentId: id } };
    expect(rootId(grandchild)).toBe(ring.id);
    expect(keyArtFor(grandchild).backdrop).toBe(keyArtFor(ring).backdrop);
    expect(introFor(grandchild).steps).toEqual(introFor(ring).steps);
  });
});

describe('tweak flow in the reducer', () => {
  test('ask -> rebuilding -> done, with phone screens per stage', () => {
    let s = reduce(seated(), { type: 'start', spec: ring });
    s = reduce(s, { type: 'results', ranking: [{ id: 'a', score: 3 }, { id: 'b', score: 1 }] });
    s = reduce(s, { type: 'tweakOpen', id: 'T1', base: ring, mode: 'tweak' });
    expect(s.phase).toBe('tweak');
    const ask = phoneScreen(s, 'a', true);
    expect(ask).toMatchObject({ name: 'tweak', data: { phase: 'ask', seconds: 10 } });
    expect(ask?.name === 'tweak' && ask.data.chips?.length).toBe(6);

    s = reduce(s, { type: 'tweakAsk', ask: { by: 'a', chip: 'low-gravity' } });
    s = reduce(s, { type: 'tweakAsk', ask: { by: 'stranger', chip: 'faster' } }); // not in the room
    s = reduce(s, { type: 'tweakAsk', ask: { by: 'tv', chip: 'bouncier' } });
    expect(s.tweak?.asks.map((a) => a.chip)).toEqual(['low-gravity', 'bouncier']);

    s = reduce(s, { type: 'tweakRebuild' });
    s = reduce(s, { type: 'tweakAsk', ask: { by: 'b', chip: 'faster' } }); // too late
    expect(s.tweak?.asks).toHaveLength(2);
    s = reduce(s, { type: 'tweakProgress', id: 'T1', step: 'Playtesting' });
    expect(phoneScreen(s, 'b', true)).toMatchObject({ name: 'tweak', data: { phase: 'rebuilding', message: 'Playtesting' } });

    const result = presetTweak(ring, s.tweak!.asks, reg);
    expect(reduce(s, { type: 'tweakDone', id: 'OLD', result })).toBe(s); // a stale answer
    s = reduce(s, { type: 'tweakDone', id: 'T1', result });
    expect(s.tweak?.stage).toBe('done');
    expect(phoneScreen(s, 'a', true)).toMatchObject({ name: 'tweak', data: { phase: 'done', summary: 'Gravity ×0.4 · Bounce ↑' } });
    // a second answer (local fallback racing the backend) is ignored
    expect(reduce(s, { type: 'tweakDone', id: 'T1', result: { ...result, summary: 'x' } }).tweak?.result?.summary).toBe(result.summary);

    s = reduce(s, { type: 'lobby' });
    expect(s.tweak).toBeUndefined();
  });

  test('a solo phone gets bots even with bots off', () => {
    let s = initialState('ABCD');
    s = reduce(s, { type: 'settings', patch: { bots: false } });
    s = reduce(s, { type: 'join', id: 'a', name: 'Asha' });
    expect(reduce(s, { type: 'fillBots' }).players).toHaveLength(1);
    expect(reduce(s, { type: 'fillBots', force: true }).players).toHaveLength(4);
  });
});
