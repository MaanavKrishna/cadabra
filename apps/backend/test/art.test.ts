import { beforeEach, describe, expect, test } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ApplyGuardrailCommand, BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

process.env.GUARDRAIL_ID = 'gr-1';
process.env.ASSETS_BUCKET = 'assets-b';
process.env.ASSETS_URL = 'https://cdn.test';
const { MODELS } = await import('../src/ai/bedrock');
const { artForSpec, sprite, keyArt, artKey, imageAvailable, _resetArt } = await import('../src/ai/art');
const br = mockClient(BedrockRuntimeClient);
const s3 = mockClient(S3Client);

const PNG = Buffer.from('fakepng').toString('base64');
const body = (o: unknown) => ({ body: new TextEncoder().encode(JSON.stringify(o)) }) as never;
const ok = () => body({ images: [PNG], seeds: [1], finish_reasons: [null] });
const err = (name: string) => Object.assign(new Error(name), { name });
const palette = { bg: '#000000', primary: '#111111', accent: '#222222', glow: '#333333', text: '#ffffff' } as const;
const spec = (sprites: Record<string, string>) => ({
  id: 'spec1', theme: { palette, artStyle: 'flat vector', keyArtPrompt: 'a lava arena', sprites },
});
const calls = (model: string) => br.commandCalls(InvokeModelCommand).filter((c) => c.args[0].input.modelId === model);

beforeEach(() => {
  br.reset(); s3.reset(); _resetArt();
  s3.on(PutObjectCommand).resolves({});
  br.on(ApplyGuardrailCommand).resolves({ action: 'NONE' } as never);
  br.on(InvokeModelCommand).callsFake(() => ok());
});

describe('art', () => {
  test('keyArt sends Stability request shape and stores png on the CDN', async () => {
    const url = await keyArt('a lava arena', palette, { specId: 'spec1' });
    expect(url).toBe('https://cdn.test/art/spec1/keyArt.png');
    const c = calls(MODELS.image)[0]!.args[0].input;
    const sent = JSON.parse(c.body as string);
    expect(sent).toMatchObject({ aspect_ratio: '16:9', output_format: 'png' });
    expect(sent.prompt).toContain('no text');
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Bucket: 'assets-b', Key: 'art/spec1/keyArt.png', ContentType: 'image/png' });
  });

  test('sprite runs background removal', async () => {
    const url = await sprite('a fire imp', 'flat vector', { specId: 'spec1', key: 'imp' });
    expect(url).toBe('https://cdn.test/art/spec1/imp.png');
    expect(calls(MODELS.image)).toHaveLength(1);
    const rm = calls(MODELS.removeBg);
    expect(rm).toHaveLength(1);
    expect(JSON.parse(rm[0]!.args[0].input.body as string)).toMatchObject({ image: PNG, output_format: 'png' });
  });

  test('artForSpec reports each image, key art first, parallel <= 4', async () => {
    let inflight = 0, peak = 0;
    br.on(InvokeModelCommand).callsFake(async () => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight--; return ok();
    });
    const got: string[] = [];
    await artForSpec(spec({ a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' }), (k) => got.push(k), Date.now() + 5000);
    expect(got[0]).toBe('keyArt');
    expect(got.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'keyArt']);
    expect(peak).toBeLessThanOrEqual(4);
  });

  test('artForSpec respects deadline and reports partial', async () => {
    br.on(InvokeModelCommand).callsFake(async (i: { modelId: string; body: string }) => {
      const slow = i.body.includes('slow');
      await new Promise((r) => setTimeout(r, slow ? 400 : 5));
      return ok();
    });
    const got: string[] = [];
    const t0 = Date.now();
    await artForSpec(spec({ fast: 'quick', slow: 'slow one' }), (k) => got.push(k), Date.now() + 150);
    expect(Date.now() - t0).toBeLessThan(350);
    expect(got).toContain('keyArt');
    expect(got).toContain('fast');
    expect(got).not.toContain('slow');
  });

  test('blocked prompt is skipped', async () => {
    br.on(ApplyGuardrailCommand).callsFake((i: { content: { text: { text: string } }[] }) =>
      ({ action: i.content[0]!.text.text.includes('gore') ? 'GUARDRAIL_INTERVENED' : 'NONE' }) as never);
    const got: string[] = [];
    await artForSpec(spec({ bad: 'gore everywhere', good: 'a happy cat' }), (k) => got.push(k), Date.now() + 5000);
    expect(got.sort()).toEqual(['good', 'keyArt']);
    expect(br.commandCalls(InvokeModelCommand).every((c) => !String(c.args[0].input.body).includes('gore'))).toBe(true);
  });

  test('family-safe off skips screening', async () => {
    await artForSpec(spec({}), () => {}, Date.now() + 5000, false);
    expect(br.commandCalls(ApplyGuardrailCommand)).toHaveLength(0);
  });

  test('circuit breaker: throttling trips it, later calls return immediately without any request', async () => {
    br.on(InvokeModelCommand).rejects(err('ThrottlingException'));
    const got: string[] = [];
    await artForSpec(spec({ a: 'a', b: 'b' }), (k) => got.push(k), Date.now() + 5000);
    expect(got).toEqual([]);
    expect(imageAvailable()).toBe(false);
    const n = br.commandCalls(InvokeModelCommand).length;
    expect(n).toBeLessThanOrEqual(4); // in-flight workers at most, no retries
    const t0 = Date.now();
    await artForSpec(spec({ a: 'a' }), (k) => got.push(k), Date.now() + 5000);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(br.commandCalls(InvokeModelCommand)).toHaveLength(n);
    expect(br.commandCalls(ApplyGuardrailCommand).length).toBeLessThanOrEqual(n);
    await expect(sprite('x', 'y', { specId: 's' })).rejects.toMatchObject({ name: 'ArtSkipped' });
  });

  test('AccessDenied also trips the breaker; breaker expires after 10 minutes', async () => {
    br.on(InvokeModelCommand).rejects(err('AccessDeniedException'));
    await artForSpec(spec({}), () => {}, Date.now() + 5000);
    expect(imageAvailable()).toBe(false);
    expect(imageAvailable(Date.now() + 10 * 60_000 + 1000)).toBe(true);
  });

  test('a filtered image (finish_reasons) is skipped', async () => {
    br.on(InvokeModelCommand).callsFake(() => body({ images: [PNG], finish_reasons: ['Filter reason: prompt'] }));
    const got: string[] = [];
    await artForSpec(spec({ a: 'a' }), (k) => got.push(k), Date.now() + 5000);
    expect(got).toEqual([]);
    expect(imageAvailable()).toBe(true);
  });

  test('art keys are sanitized', () => {
    expect(artKey('../x', 'a/b')).toBe('art/___x/a_b.png');
  });
});
