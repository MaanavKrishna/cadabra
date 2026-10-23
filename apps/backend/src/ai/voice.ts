import { createHash } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PollyClient, SynthesizeSpeechCommand, type VoiceId } from '@aws-sdk/client-polly';

/**
 * Polly TTS with an S3 cache (AssetsBucket, `voice/<sha256(engine|voice|region|text)>.mp3`). The bucket is private;
 * audio is served through the CloudFront distribution in front of it (ASSETS_URL, CORS GET from any origin).
 *
 * Voices are chosen per host personality from the GENERATIVE engine (most natural), which is not offered in
 * ap-south-1, so Polly runs in POLLY_REGION (default us-east-1) while the S3 cache stays in ap-south-1.
 * Choices (picked from `aws polly describe-voices --engine generative --region us-east-1`; not listen-tested):
 *   hype   -> Matthew (en-US male, upbeat/energetic), then long-form Patrick
 *   cheeky -> Ruth    (en-US female, conversational/playful), then long-form Ruth
 *   calm   -> Amy     (en-GB female, warm/measured), then long-form Danielle
 * Every chain ends in neural Joanna then standard Joanna. Generative supports only limited SSML, so plain text is sent.
 */
const S3_REGION = 'ap-south-1';
export const pollyRegion = (): string => process.env.POLLY_REGION || 'us-east-1';
const POLLY_REGION = pollyRegion();
const polly = new PollyClient({ region: POLLY_REGION });
const s3 = new S3Client({ region: S3_REGION });
const log = (...a: unknown[]) => console.warn('[voice]', ...a);

export type PollyEngine = 'generative' | 'long-form' | 'neural' | 'standard';
export type VoiceChoice = { engine: PollyEngine; voice: string };
export type Personality = 'hype' | 'cheeky' | 'calm';

const TAIL: VoiceChoice[] = [{ engine: 'neural', voice: 'Joanna' }, { engine: 'standard', voice: 'Joanna' }];
export const VOICE_CHAINS: Record<Personality, VoiceChoice[]> = {
  hype: [{ engine: 'generative', voice: 'Matthew' }, { engine: 'long-form', voice: 'Patrick' }, ...TAIL],
  cheeky: [{ engine: 'generative', voice: 'Ruth' }, { engine: 'long-form', voice: 'Ruth' }, ...TAIL],
  calm: [{ engine: 'generative', voice: 'Amy' }, { engine: 'long-form', voice: 'Danielle' }, ...TAIL],
};
const MAX_CHARS = 600;
const SYNTH_TIMEOUT_MS = 6000;

/** Cache key covers engine, voice, region and the exact text sent to Polly. */
export const voiceKey = (engine: string, voice: string, region: string, text: string): string =>
  `voice/${createHash('sha256').update([engine, voice, region, text].join('|')).digest('hex')}.mp3`;

/** Short punchy delivery: collapse whitespace, always end on punctuation (hype gets a full stop upgraded to a shout). */
export function prepText(text: string, personality: Personality): string {
  let t = text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!t) return t;
  if (!/[.!?…]["')\]]?$/.test(t)) t += personality === 'hype' ? '!' : '.';
  else if (personality === 'hype' && t.endsWith('.') && !t.endsWith('..')) t = t.slice(0, -1) + '!';
  return t;
}

const urlFor = (key: string): string => {
  const base = (process.env.ASSETS_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('ASSETS_URL not set');
  return `${base}/${key}`;
};

/** Engine+voice combos that failed in this container: skip them until the container recycles. */
const badVoices = new Set<string>();
const id = (c: VoiceChoice): string => `${c.engine}:${c.voice}`;
/** Test hook. */
export const _resetVoice = (): void => badVoices.clear();

/** A miss is only NotFound/404; any other S3 error (throttle, access) propagates instead of re-synthesizing blindly. */
async function exists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(3000) });
    return true;
  } catch (e) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

async function synth(c: VoiceChoice, text: string): Promise<Uint8Array> {
  const res = await polly.send(new SynthesizeSpeechCommand({
    Engine: c.engine, VoiceId: c.voice as VoiceId, OutputFormat: 'mp3', Text: text, TextType: 'text',
  }), { abortSignal: AbortSignal.timeout(SYNTH_TIMEOUT_MS) });
  const bytes = await res.AudioStream?.transformToByteArray();
  if (!bytes?.length) throw new Error('polly: empty audio');
  return bytes;
}

/** Synthesize (or fetch from cache) one line of host speech; resolves to a playable mp3 URL. Throws on failure. */
export async function speak(text: string, personality: Personality = 'cheeky'): Promise<string> {
  const bucket = process.env.ASSETS_BUCKET;
  if (!bucket) throw new Error('ASSETS_BUCKET not set');
  const p: Personality = VOICE_CHAINS[personality] ? personality : 'cheeky';
  const clean = prepText(text, p);
  if (!clean) throw new Error('speak: empty text');
  const chain = VOICE_CHAINS[p];
  const last = chain[chain.length - 1]!;
  const choices = chain.filter((c) => !badVoices.has(id(c)));
  if (!choices.length) choices.push(last); // everything marked bad: still try once
  let lastErr: unknown;
  for (const c of choices) {
    const key = voiceKey(c.engine, c.voice, POLLY_REGION, clean);
    if (await exists(bucket, key)) return urlFor(key);
    let bytes: Uint8Array;
    try {
      bytes = await synth(c, clean);
    } catch (e) {
      lastErr = e;
      if (c !== last) badVoices.add(id(c)); // synth failure only (not an S3 problem)
      log(`voice ${id(c)} failed:`, (e as Error)?.name);
      continue;
    }
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes, ContentType: 'audio/mpeg', CacheControl: 'public, max-age=31536000, immutable',
      }));
      return urlFor(key);
    } catch (e) {
      lastErr = e;
      log('voice cache write failed:', (e as Error)?.name);
    }
  }
  throw lastErr;
}
