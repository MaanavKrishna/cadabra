import { describe, expect, it } from 'vitest';
import { isSafeArtUrl, parseReply, parseScreenData, replyMsg } from '../src/index';

describe('screen payloads and replies', () => {
  it('validates TV screen payloads per screen', () => {
    expect(parseScreenData('vote', { options: ['A', { title: 'B' }] }).ok).toBe(true);
    expect(parseScreenData('vote', { options: [null, 'B'] }).ok).toBe(false);
    expect(parseScreenData('results', { standings: [null] }).ok).toBe(false);
    const play = parseScreenData('play', {});
    expect(play.ok && play.screen.name === 'play' && play.screen.data.widgets).toEqual([]);
    expect(parseScreenData('play', { widgets: [{ kind: 'nope' }] }).ok).toBe(false);
    expect(parseScreenData('wait', undefined).ok).toBe(true);
  });

  it('art urls are https or data:image only', () => {
    expect(isSafeArtUrl('https://cdn.example/a.png')).toBe(true);
    expect(isSafeArtUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isSafeArtUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeArtUrl('http://x/a.png')).toBe(false);
    expect(isSafeArtUrl('data:text/html;base64,AAAA')).toBe(false);
    expect(parseScreenData('vote', { options: [{ title: 'x', art: 'http://x")' }] }).ok).toBe(false);
  });

  it('replies are unambiguous in both directions', () => {
    const m = replyMsg({ reply: 'vote.cast', vote: 1 });
    expect(m).toEqual({ t: 'screen', name: 'vote', data: { reply: 'vote.cast', vote: 1 } });
    expect(parseReply(m)).toEqual({ reply: 'vote.cast', vote: 1 });
    // a reply is never taken as a screen payload, and a payload is never a reply
    expect(parseScreenData('vote', m.data)).toMatchObject({ ok: false, reason: 'reply' });
    expect(parseReply({ t: 'screen', name: 'vote', data: { options: ['a'] } })).toBeUndefined();
    expect(parseReply({ t: 'screen', name: 'storm', data: { reply: 'vote.cast', vote: 1 } })).toBeUndefined();
    expect(() => replyMsg({ reply: 'storm.add', idea: 'x'.repeat(41) })).toThrow();
  });
});
