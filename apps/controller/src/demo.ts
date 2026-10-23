// Dev-only: `?demo=<screen>` drives the app with a mocked TV for visual checks.
import type { InputFrame, PeerMsg, ScreenName } from '@cadabra/spec';
import type { ControllerClient } from './client';

const LAVA = { '--c-bg': '#120607', '--c-primary': '#ff5a36', '--c-accent': '#ffc94a', '--c-glow': '#ff3d2e', '--c-text': '#fff4ec' };
const OCEAN = { '--c-bg': '#03101a', '--c-primary': '#1fb6ff', '--c-accent': '#5ef2c4', '--c-glow': '#1aa0ff', '--c-text': '#eefaff' };

export const DEMO_SCREENS: Record<string, { name: ScreenName; data: Record<string, unknown> }> = {
  avatar: { name: 'avatar', data: { taken: ['dragon', 'robot'] } },
  wait: { name: 'wait', data: {} },
  storm: { name: 'storm', data: { seconds: 20 } },
  vote: {
    name: 'vote',
    data: {
      seconds: 15,
      options: [
        { title: 'Lava Leap', tagline: 'The floor is lava. Literally.' },
        { title: 'Cat-stronauts', tagline: 'Herd space cats into the rocket' },
        { title: 'Ninja Kitchen', tagline: 'Chop, dodge, serve. Fast.' },
      ],
    },
  },
  warmup: { name: 'warmup', data: { title: 'Lava Leap', howTo: 'Stick to move, JUMP over the gaps.', seconds: 10, widgets: [{ kind: 'joystick', id: 'move' }, { kind: 'button', id: 'jump', label: 'Jump' }], themeVars: LAVA } },
  play: { name: 'play', data: { title: 'Lava Leap', widgets: [{ kind: 'joystick', id: 'move' }, { kind: 'button', id: 'jump', label: 'Jump' }, { kind: 'hold', id: 'dash', label: 'Dash' }], themeVars: LAVA } },
  'play-heist': { name: 'play', data: { title: 'Ladoo Heist', widgets: [{ kind: 'joystick', id: 'move' }, { kind: 'hold', id: 'tiptoe', label: 'Tiptoe' }] } },
  'play-tug': { name: 'play', data: { title: 'Bear Tug', widgets: [{ kind: 'button', id: 'pull', label: 'PULL' }] } },
  'play-ocean': { name: 'play', data: { title: 'Reef Rush', widgets: [{ kind: 'tilt', id: 'steer' }, { kind: 'button', id: 'boost', label: 'Boost' }], themeVars: OCEAN } },
  'play-swipe': { name: 'play', data: { title: 'Cat Sort', widgets: [{ kind: 'swipe', id: 'sort' }] } },
  'play-draw': { name: 'play', data: { title: 'Doodle Duel', widgets: [{ kind: 'draw', id: 'd', prompt: 'Draw a hat for the dragon' }] } },
  'play-vote': { name: 'play', data: { title: 'Quiz', widgets: [{ kind: 'vote', id: 'q', options: ['Mars', 'Venus', 'Jupiter'] }, { kind: 'text', id: 't', placeholder: 'Or type a guess' }] } },
  results: {
    name: 'results',
    data: { rank: 1, standings: [
      { name: 'Maya', score: 2400, avatar: 'fox', you: true }, { name: 'Arjun', score: 1980, avatar: 'robot' },
      { name: 'Zoe', score: 1500, avatar: 'panda' }, { name: 'Bot Bo', score: 900, avatar: 'penguin' },
    ], themeVars: LAVA },
  },
  remix: { name: 'remix', data: {} },
  tweak: { name: 'tweak', data: {} },
  blocked: { name: 'blocked', data: {} },
};

export function createDemoClient(which: string): ControllerClient {
  const ls = new Map<string, ((...a: any[]) => void)[]>();
  const emit = (ev: string, ...a: unknown[]) => (ls.get(ev) ?? []).forEach((cb) => cb(...a));
  return {
    mode: 'direct',
    async join() {
      const s = DEMO_SCREENS[which];
      if (s) setTimeout(() => emit('msg', { t: 'screen', ...s } satisfies PeerMsg), 50);
      if (which === 'tv-left') setTimeout(() => emit('tv.left'), 50);
      return { playerId: 'demo' };
    },
    send(m) { console.debug('[demo] send', m); return true; },
    sendInput(f: InputFrame) { console.debug('[demo] input', f); },
    on(ev, cb) { ls.set(ev, [...(ls.get(ev) ?? []), cb]); },
    close() {},
  };
}
