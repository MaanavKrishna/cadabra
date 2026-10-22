import { describe, expect, test } from 'vitest';
import { replyMsg, type PeerMsg } from '@cadabra/spec';
import { phoneAction } from '../src/net/replies';

describe('phone replies (parseReply)', () => {
  test('valid replies map to party actions', () => {
    expect(phoneAction('p1', replyMsg({ reply: 'avatar.pick', avatar: 'cat' }))).toEqual({ type: 'avatar', id: 'p1', avatar: 'cat' });
    expect(phoneAction('p1', replyMsg({ reply: 'storm.add', idea: 'lava' }))).toEqual({ type: 'ingredient', by: 'p1', text: 'lava' });
    expect(phoneAction('p2', replyMsg({ reply: 'vote.cast', vote: 2 }))).toEqual({ type: 'vote', by: 'p2', vote: 2 });
    expect(phoneAction('p2', replyMsg({ reply: 'results.pick', action: 'again' }))).toEqual({ type: 'pick', by: 'p2', action: 'again' });
  });

  test('invalid, misrouted or non-reply messages are ignored', () => {
    const bad: PeerMsg[] = [
      { t: 'screen', name: 'vote', data: { reply: 'vote.cast', vote: 99 } },
      { t: 'screen', name: 'storm', data: { reply: 'vote.cast', vote: 1 } }, // wrong screen
      { t: 'screen', name: 'avatar', data: { reply: 'avatar.pick', avatar: '../../x' } },
      { t: 'screen', name: 'vote', data: { options: ['a'] } }, // a TV payload echoed back
      { t: 'ping', id: 1 },
      { t: 'input', frame: { t: 1 } },
    ];
    for (const m of bad) expect(phoneAction('p1', m)).toBeUndefined();
  });
});

import { initialState, reduce } from '../src/state/machine';
import { phoneScreen, standings } from '../src/net/screens';
import { FALLBACK_SPECS } from '@cadabra/spec';

test('selfie avatars are accepted but never echoed to phones', () => {
  const selfie = `data:image/webp;base64,${'A'.repeat(4000)}`;
  const a = phoneAction('p1', replyMsg({ reply: 'avatar.pick', avatar: selfie }));
  expect(a).toEqual({ type: 'avatar', id: 'p1', avatar: selfie });
  let s = reduce(initialState('ABCD'), { type: 'join', id: 'p1', name: 'Maya' });
  s = reduce(s, a as never);
  expect(s.players[0]!.avatar).toBe(selfie);
  s = reduce(s, { type: 'start', spec: FALLBACK_SPECS[0]! });
  s = reduce(s, { type: 'results', ranking: [{ id: 'p1', score: 5 }] });
  expect(standings(s, 'p1')[0]!.avatar).toBe('selfie:p1');
  const scr = phoneScreen(s, 'p1', true)!;
  expect(JSON.stringify(scr)).not.toContain('data:image');
  expect(scr.name).toBe('results');
});
