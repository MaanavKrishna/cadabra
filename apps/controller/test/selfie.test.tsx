import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

const toon = vi.hoisted(() => ({ selfieToToon: vi.fn() }));
vi.mock('../src/toon', () => toon);
const { AvatarScreen } = await import('../src/screens/lobby');

const SELFIE = 'data:image/webp;base64,AAAA';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
let root: HTMLElement;
const reply = vi.fn();
beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); reply.mockReset(); toon.selfieToToon.mockReset(); });
afterEach(() => { render(null, root); root.remove(); });
const mount = () => act(() => render(<AvatarScreen data={{}} reply={reply} setAvatar={() => {}} />, root));
const choose = async (file?: File) => {
  const input = root.querySelector('[data-testid="selfie-input"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: file ? [file] : [], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
};
const lock = () => act(() => { ([...root.querySelectorAll('button')].find((b) => /Lock in/.test(b.textContent ?? '')) as HTMLButtonElement).click(); });

describe('avatar screen: selfie', () => {
  it('uses a front-camera image input', () => {
    mount();
    const input = root.querySelector('[data-testid="selfie-input"]') as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.getAttribute('capture')).toBe('user');
  });

  it('shows the toon result as a selected tile and sends only the stylized data url', async () => {
    toon.selfieToToon.mockResolvedValue({ ok: true, dataUrl: SELFIE, bytes: 3, mime: 'image/webp' });
    mount();
    await choose(new File(['x'], 'me.jpg', { type: 'image/jpeg' }));
    const tile = root.querySelector('.avatar-tile.is-selfie') as HTMLElement;
    expect(tile.getAttribute('aria-checked')).toBe('true');
    expect((tile.querySelector('img') as HTMLImageElement).src).toBe(SELFIE);
    lock();
    expect(reply).toHaveBeenCalledWith({ reply: 'avatar.pick', avatar: SELFIE });
  });

  it('camera denied/cancelled (no file): premade picker still works', async () => {
    mount();
    await choose(undefined);
    expect(toon.selfieToToon).not.toHaveBeenCalled();
    expect(root.querySelector('.is-selfie')).toBeNull();
    (root.querySelector('.avatar-tile') as HTMLButtonElement).click();
    await flush();
    lock();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]![0].avatar).toMatch(/^[a-z]+$/);
  });

  it('unreadable photo: friendly toast, no selfie tile, nothing sent', async () => {
    toon.selfieToToon.mockResolvedValue({ ok: false, reason: 'unreadable' });
    mount();
    await choose(new File(['x'], 'bad.heic'));
    expect(root.querySelector('.toast')?.textContent).toMatch(/Pick a character/);
    expect(root.querySelector('.is-selfie')).toBeNull();
    expect(reply).not.toHaveBeenCalled();
  });
});
