import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { GameSpec, Theme } from '@cadabra/spec';
import { IMAGE_REGION, MODELS, screen } from './bedrock';

/**
 * Art pipeline (Stability AI on Bedrock, us-west-2): key art 16:9 and transparent sprites, written to the
 * AssetsBucket under `art/<specId>/<key>.png` and served from the AssetsCdn (/art/* is public).
 *
 * Circuit breaker: when the account has no image quota/access (ThrottlingException, AccessDenied, ...), the
 * image provider is marked unavailable for 10 minutes and every call returns immediately, so the forge is never
 * slowed. The TV keeps its default art pack whenever no `forge.art` message arrives.
 */
const log = (...a: unknown[]) => console.warn('[art]', ...a);
const bedrock = new BedrockRuntimeClient({ region: IMAGE_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });

export const IMAGE_DOWN_MS = 10 * 60_000;
const MAX_PARALLEL = 4;
const CALL_TIMEOUT_MS = 20_000;
/** Errors that mean "no usable image model on this account right now". */
const UNAVAILABLE = new Set([
  'ThrottlingException', 'AccessDeniedException', 'ResourceNotFoundException', 'ServiceQuotaExceededException',
  'ModelNotReadyException',
]);

let downUntil = 0;
/** Test hook. */
export const _resetArt = (): void => { downUntil = 0; };
export const imageAvailable = (now = Date.now()): boolean => now >= downUntil;
const trip = (name: string): void => {
  if (imageAvailable()) log(`image provider unavailable (${name}); skipping art for ${IMAGE_DOWN_MS / 60000} min`);
  downUntil = Date.now() + IMAGE_DOWN_MS;
};

export class ArtSkipped extends Error {
  constructor(public reason: 'unavailable' | 'blocked' | 'filtered' | 'deadline') { super(`art skipped: ${reason}`); this.name = 'ArtSkipped'; }
}

async function invoke(modelId: string, body: Record<string, unknown>, timeoutMs: number): Promise<Uint8Array> {
  if (!imageAvailable()) throw new ArtSkipped('unavailable');
  if (timeoutMs <= 0) throw new ArtSkipped('deadline');
  try {
    const res = await bedrock.send(new InvokeModelCommand({
      modelId, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(body),
    }), { abortSignal: AbortSignal.timeout(Math.min(timeoutMs, CALL_TIMEOUT_MS)) });
    const json = JSON.parse(new TextDecoder().decode(res.body)) as { images?: string[]; finish_reasons?: (string | null)[] };
    if (json.finish_reasons?.some((r) => r)) throw new ArtSkipped('filtered');
    const b64 = json.images?.[0];
    if (!b64) throw new Error('image model returned no image');
    return Buffer.from(b64, 'base64');
  } catch (e) {
    const name = (e as { name?: string })?.name ?? 'Error';
    if (UNAVAILABLE.has(name)) {
      // Only the generation model decides provider health; a remove-background failure must not disable art.
      if (modelId === MODELS.image) trip(name);
      else log(`${modelId} failed (${name})`);
      throw new ArtSkipped('unavailable');
    }
    throw e;
  }
}

const safeSeg = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'x';
export const artKey = (specId: string, key: string): string => `art/${safeSeg(specId)}/${safeSeg(key)}.png`;

async function store(specId: string, key: string, png: Uint8Array): Promise<string> {
  const bucket = process.env.ASSETS_BUCKET;
  const base = (process.env.ASSETS_URL ?? '').replace(/\/+$/, '');
  if (!bucket || !base) throw new Error('ASSETS_BUCKET/ASSETS_URL not set');
  const k = artKey(specId, key);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: k, Body: png, ContentType: 'image/png', CacheControl: 'public,max-age=31536000,immutable',
  }), { abortSignal: AbortSignal.timeout(5000) });
  return `${base}/${k}`;
}

async function allowed(prompt: string, familySafe: boolean): Promise<void> {
  if (!familySafe) return;
  if (!(await screen(prompt, 'INPUT', true)).allowed) throw new ArtSkipped('blocked');
}

const KEY_STYLE = 'cinematic game key art, dramatic lighting, no text';
const hexList = (p: Theme['palette']) => `color palette ${p.bg}, ${p.primary}, ${p.accent}, ${p.glow}`;

interface GenOpts { specId: string; key?: string; familySafe?: boolean; deadlineMs?: number }
const remaining = (o: GenOpts) => (o.deadlineMs ?? Date.now() + CALL_TIMEOUT_MS) - Date.now();

/** 16:9 key art. Resolves to the CDN url; throws ArtSkipped when blocked/unavailable/late. */
export async function keyArt(prompt: string, palette: Theme['palette'], o: GenOpts): Promise<string> {
  if (!imageAvailable()) throw new ArtSkipped('unavailable');
  const full = `${prompt}, ${hexList(palette)}, ${KEY_STYLE}`;
  await allowed(full, o.familySafe ?? true);
  const png = await invoke(MODELS.image, { prompt: full, aspect_ratio: '16:9', output_format: 'png' }, remaining(o));
  return store(o.specId, o.key ?? 'keyArt', png);
}

/** Square sprite with the background removed (transparent PNG). */
export async function sprite(prompt: string, style: string, o: GenOpts): Promise<string> {
  if (!imageAvailable()) throw new ArtSkipped('unavailable');
  const full = `${prompt}, ${style}, single centered game sprite, plain background, no text`;
  await allowed(full, o.familySafe ?? true);
  const raw = await invoke(MODELS.image, { prompt: full, aspect_ratio: '1:1', output_format: 'png' }, remaining(o));
  let out = raw;
  try {
    out = await invoke(MODELS.removeBg, { image: Buffer.from(raw).toString('base64'), output_format: 'png' }, remaining(o));
  } catch (e) {
    // Background removal is an enhancement: keep the raw image, say which model failed.
    log(`remove-background (${MODELS.removeBg}) failed, using raw sprite:`, (e as Error)?.name);
  }
  return store(o.specId, o.key ?? 'sprite', out);
}

type ArtSpec = Pick<GameSpec, 'id'> & { theme: Pick<Theme, 'palette' | 'artStyle' | 'keyArtPrompt' | 'sprites'> };

/**
 * Key art first, then sprites, at most 4 in flight. `onEach(key, url)` fires per finished image; anything blocked,
 * failed, unavailable or past `deadlineMs` is simply never reported (the TV keeps its default art).
 */
export async function artForSpec(
  spec: ArtSpec, onEach: (key: string, url: string) => void, deadlineMs: number, familySafe = true,
  only: { keyArt?: boolean; sprites?: boolean } = {},
): Promise<void> {
  if (!imageAvailable()) return;
  const jobs: { key: string; run: () => Promise<string> }[] = [];
  const o = (key: string): GenOpts => ({ specId: spec.id, key, familySafe, deadlineMs });
  if (only.keyArt !== false) jobs.push({ key: 'keyArt', run: () => keyArt(spec.theme.keyArtPrompt, spec.theme.palette, o('keyArt')) });
  if (only.sprites !== false) {
    for (const [key, prompt] of Object.entries(spec.theme.sprites)) {
      jobs.push({ key, run: () => sprite(prompt, spec.theme.artStyle, o(key)) });
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      if (!imageAvailable() || Date.now() >= deadlineMs) return;
      try {
        const budget = deadlineMs - Date.now();
        const url = await Promise.race([
          job.run(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new ArtSkipped('deadline')), Math.max(0, budget))),
        ]);
        if (Date.now() <= deadlineMs + 50) onEach(job.key, url);
      } catch (e) {
        if (!(e instanceof ArtSkipped)) log(`art ${job.key} failed:`, (e as Error)?.name, (e as Error)?.message?.slice(0, 120));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, jobs.length) }, worker));
}
