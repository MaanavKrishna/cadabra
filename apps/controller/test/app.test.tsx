import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { InputFrame, PeerMsg } from '@cadabra/spec';
import { App } from '../src/app';
import { ScreenBoundary } from '../src/ui/boundary';
import { normalizeCode, codeFromUrl } from '../src/code';
import type { ControllerClient } from '../src/client';

class FakeClient implements ControllerClient {
  mode: 'direct' | 'relay' = 'relay';
  joins: [string, string][] = [];
  sent: PeerMsg[] = [];
  inputs: InputFrame[] = [];
  private ls = new Map<string, ((...a: any[]) => void)[]>();
  join = vi.fn(async (code: string, name: string) => { this.joins.push([code, name]); return { playerId: 'p1' }; });
  send(m: PeerMsg) { this.sent.push(m); return true; }
  sendInput(f: InputFrame) { this.inputs.push(f); }
  on(ev: string, cb: (...a: any[]) => void) { this.ls.set(ev, [...(this.ls.get(ev) ?? []), cb]); }
  emit(ev: string, ...a: unknown[]) { for (const cb of this.ls.get(ev) ?? []) cb(...a); }
  close() {}
}

const type = (el: HTMLInputElement, v: string) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let root: HTMLElement;
let client: FakeClient;
beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  client = new FakeClient();
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
afterEach(() => { render(null, root); root.remove(); });

describe('join code', () => {
  it('normalizes to uppercase letters, 4 max', () => {
    expect(normalizeCode('bc df-9x')).toBe('BCDF');
    expect(codeFromUrl('https://x.test/?r=wxyz')).toBe('WXYZ');
    expect(codeFromUrl('https://x.test/')).toBe('');
  });

  it('join screen uppercases the typed code and joins with it', async () => {
    act(() => render(<App client={client} initialCode="" />, root));
    const code = root.querySelector('input[name="code"]') as HTMLInputElement;
    const name = root.querySelector('input[name="name"]') as HTMLInputElement;
    act(() => type(code, 'bcdf'));
    expect(code.value).toBe('BCDF');
    act(() => type(name, 'Maya'));
    act(() => { (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true })); });
    await flush();
    expect(client.joins).toEqual([['BCDF', 'Maya']]);
    expect(root.querySelector('[data-screen="wait"]')).toBeTruthy();
  });

  it('prefills the code from ?r=', () => {
    act(() => render(<App client={client} initialCode="QWER" />, root));
    expect((root.querySelector('input[name="code"]') as HTMLInputElement).value).toBe('QWER');
  });
});

describe('screen routing', () => {
  it('routes TV screen messages to screens and applies themeVars', async () => {
    act(() => render(<App client={client} initialCode="BCDF" />, root));
    act(() => type(root.querySelector('input[name="name"]') as HTMLInputElement, 'Maya'));
    act(() => { (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true })); });
    await flush();

    act(() => client.emit('msg', { t: 'screen', name: 'vote', data: { options: [{ title: 'Lava Run' }, { title: 'Ocean Dash' }], themeVars: { '--c-primary': '#ff5500' } } }));
    expect(root.querySelector('[data-screen="vote"]')).toBeTruthy();
    expect(root.textContent).toContain('Ocean Dash');
    expect(document.documentElement.style.getPropertyValue('--c-primary')).toBe('#ff5500');

    act(() => client.emit('msg', { t: 'screen', name: 'play', data: { widgets: [{ kind: 'joystick', id: 'move' }, { kind: 'button', id: 'jump', label: 'Jump' }] } }));
    expect(root.querySelector('[data-screen="play"]')).toBeTruthy();
    expect(root.querySelector('.cp-joystick')).toBeTruthy();

    for (const name of ['avatar', 'storm', 'warmup', 'results', 'remix', 'tweak', 'wait', 'blocked'] as const) {
      act(() => client.emit('msg', { t: 'screen', name, data: {} }));
      expect(root.querySelector(`[data-screen="${name}"]`)).toBeTruthy();
    }
    // Non-screen messages are ignored.
    act(() => client.emit('msg', { t: 'pong', id: 1 }));
    expect(root.querySelector('[data-screen="blocked"]')).toBeTruthy();
  });

  it('shows a reconnect banner while the TV is away', async () => {
    act(() => render(<App client={client} initialCode="BCDF" />, root));
    act(() => client.emit('tv.left'));
    expect(root.querySelector('[data-banner="tv-left"]')).toBeTruthy();
    act(() => client.emit('tv.back'));
    expect(root.querySelector('[data-banner="tv-left"]')).toBeNull();
  });
});

async function joinedApp() {
  act(() => render(<App client={client} initialCode="BCDF" />, root));
  act(() => type(root.querySelector('input[name="name"]') as HTMLInputElement, 'Maya'));
  act(() => { (root.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true })); });
  await flush();
}

describe('validated screen data', () => {
  it('a null vote option shows the waiting state instead of crashing', async () => {
    await joinedApp();
    act(() => client.emit('msg', { t: 'screen', name: 'vote', data: { options: [null, 'B'] } }));
    expect(root.querySelector('[data-screen="vote"]')).toBeNull();
    expect(root.querySelector('[data-screen="wait"]')!.textContent).toContain('Waiting for the TV');
  });

  it('a null standings entry shows the waiting state instead of crashing', async () => {
    await joinedApp();
    act(() => client.emit('msg', { t: 'screen', name: 'results', data: { rank: 1, standings: [null] } }));
    expect(root.querySelector('[data-screen="results"]')).toBeNull();
    expect(root.querySelector('[data-screen="wait"]')).toBeTruthy();
    // the next valid screen recovers
    act(() => client.emit('msg', { t: 'screen', name: 'results', data: { rank: 2, standings: [{ name: 'Ana', score: 3 }] } }));
    expect(root.querySelector('[data-screen="results"]')!.textContent).toContain('Ana');
  });

  it('unsafe art urls are rejected', async () => {
    await joinedApp();
    act(() => client.emit('msg', { t: 'screen', name: 'vote', data: { options: [{ title: 'x', art: 'javascript:alert(1)' }] } }));
    expect(root.querySelector('[data-screen="vote"]')).toBeNull();
  });

  it('replies carry a distinct kind and echoed replies are ignored', async () => {
    await joinedApp();
    act(() => client.emit('msg', { t: 'screen', name: 'vote', data: { options: ['Lava', 'Ocean'] } }));
    act(() => (root.querySelectorAll('.pitch')[1] as HTMLButtonElement).click());
    expect(client.sent.at(-1)).toEqual({ t: 'screen', name: 'vote', data: { reply: 'vote.cast', vote: 1 } });
    act(() => client.emit('msg', { t: 'screen', name: 'storm', data: { reply: 'storm.add', idea: 'x' } }));
    expect(root.querySelector('[data-screen="vote"]')).toBeTruthy();
  });

  it('the error boundary catches a crashing screen', () => {
    const Boom = () => { throw new Error('boom'); };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    act(() => render(<ScreenBoundary fallback={<p data-fallback>waiting</p>}><Boom /></ScreenBoundary>, root));
    expect(root.querySelector('[data-fallback]')).toBeTruthy();
    spy.mockRestore();
  });
});

describe('connection banners', () => {
  it('shows a banner on client errors and while the phone reconnects', async () => {
    await joinedApp();
    act(() => client.emit('error', 'room.targetGone'));
    expect(root.querySelector('[data-banner="error"]')).toBeTruthy();
    act(() => client.emit('link', 'down'));
    expect(root.querySelector('[data-banner="reconnecting"]')).toBeTruthy();
    act(() => client.emit('link', 'up'));
    expect(root.querySelector('[data-banner="reconnecting"]')).toBeNull();
  });
});

