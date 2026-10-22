import { createHash } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PollyClient, SynthesizeSpeechCommand, type LanguageCode, type VoiceId } from '@aws-sdk/client-polly';

/**
 * Polly neural TTS with an S3 cache (AssetsBucket, `voice/<sha256(voice+text)>.mp3`). The bucket is private;
 * audio is served through the CloudFront distribution in front of it (ASSETS_URL, CORS GET from any origin).
 */
const REGION = 'ap-south-1';
const polly = new PollyClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const log = (...a: unknown[]) => console.warn('[voice]', ...a);

const DEFAULT_VOICE = 'Kajal'; // en-IN neural (verified with `aws polly describe-voices --language-code en-IN`)
const FALLBACK_VOICE = 'Joanna'; // en-US neural
const LANG: Record<string, LanguageCode> = { Kajal: 'en-IN', Joanna: 'en-US' };
const MAX_CHARS = 600;
const SYNTH_TIMEOUT_MS = 6000;

export const voiceKey = (voice: string, text: string): string =>
  `voice/${createHash('sha256').update(voice + text).digest('hex')}.mp3`;

const urlFor = (key: string): string => {
  const base = (process.env.ASSETS_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('ASSETS_URL not set');
  return `${base}/${key}`;
};

async function exists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(3000) });
    return true;
  } catch { return false; }
}

async function synth(voice: string, text: string): Promise<Uint8Array> {
  const res = await polly.send(new SynthesizeSpeechCommand({
    Engine: 'neural', VoiceId: voice as VoiceId, OutputFormat: 'mp3', Text: text,
    LanguageCode: LANG[voice], TextType: 'text',
  }), { abortSignal: AbortSignal.timeout(SYNTH_TIMEOUT_MS) });
  const bytes = await res.AudioStream?.transformToByteArray();
  if (!bytes?.length) throw new Error('polly: empty audio');
  return bytes;
}

/** Synthesize (or fetch from cache) one line of host speech; resolves to a playable mp3 URL. Throws on failure. */
export async function speak(text: string): Promise<string> {
  const bucket = process.env.ASSETS_BUCKET;
  if (!bucket) throw new Error('ASSETS_BUCKET not set');
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!clean) throw new Error('speak: empty text');
  const preferred = process.env.HOST_VOICE || DEFAULT_VOICE;
  const voices = preferred === FALLBACK_VOICE ? [preferred] : [preferred, FALLBACK_VOICE];
  let lastErr: unknown;
  for (const voice of voices) {
    const key = voiceKey(voice, clean);
    if (await exists(bucket, key)) return urlFor(key);
    try {
      const bytes = await synth(voice, clean);
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes, ContentType: 'audio/mpeg', CacheControl: 'public, max-age=31536000, immutable',
      }));
      return urlFor(key);
    } catch (e) {
      lastErr = e;
      log(`voice ${voice} failed:`, (e as Error)?.name);
    }
  }
  throw lastErr;
}
