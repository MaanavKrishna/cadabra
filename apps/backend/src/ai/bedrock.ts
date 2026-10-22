import {
  ApplyGuardrailCommand, BedrockRuntimeClient, ConverseCommand,
  type Message, type Tool, type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';

export type { Message };
export type ToolSpec = Tool;

const env = (k: string, d: string): string => process.env[k] || d;

/** Text models run in ap-south-1; image models are Stability AI in us-west-2 (Task 17). */
export const REGION = env('AWS_REGION', 'ap-south-1');
export const IMAGE_REGION = 'us-west-2' as const;

export const MODELS = {
  designer: env('MODEL_DESIGNER', 'anthropic.claude-sonnet-5-5'),
  fast: env('MODEL_FAST', 'anthropic.claude-haiku-5-5'),
  fallbackDesigner: 'in.anthropic.claude-sonnet-5',
  image: 'stability.stable-image-core-v1:1', // fast default, us-west-2
  imageQuality: 'stability.stable-image-ultra-v1:1', // us-west-2
  removeBg: 'stability.stable-image-remove-background-v1:0', // us-west-2
} as const;

/** Ordered candidates per text role. First entry is the configured model. */
export const CHAINS = {
  designer: [MODELS.designer, MODELS.fallbackDesigner, 'global.anthropic.claude-sonnet-5-5', 'global.anthropic.claude-sonnet-5'],
  fast: [MODELS.fast, 'global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-haiku-4-5-20251001-v1:0'],
  fallbackDesigner: [MODELS.fallbackDesigner, 'global.anthropic.claude-sonnet-5-5'],
} as const;

// Errors that mean "this model id is unusable here" (not throttling/timeouts): try the next one.
const MODEL_UNAVAILABLE = new Set(['ValidationException', 'AccessDeniedException', 'ResourceNotFoundException']);

let client = new BedrockRuntimeClient({ region: REGION });
const log = (...a: unknown[]) => console.warn('[bedrock]', ...a);

export interface ConverseRequest {
  model: 'designer' | 'fast' | 'fallbackDesigner';
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens?: number;
  timeoutMs: number;
}
export interface ConverseOutput {
  text: string;
  toolUses: ToolUseBlock[];
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  modelId: string;
}

const lastGood = new Map<ConverseRequest['model'], string>();
/** Test hook: forget cached working model ids. */
export function _resetModelCache(): void { lastGood.clear(); }

export async function converse(req: ConverseRequest): Promise<ConverseOutput> {
  const cached = lastGood.get(req.model);
  const chain: string[] = cached
    ? [cached, ...CHAINS[req.model].filter((m) => m !== cached)]
    : [...CHAINS[req.model]];
  const deadline = Date.now() + req.timeoutMs;
  const attempts: string[] = [];
  let firstErr: unknown;
  for (const modelId of chain) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { attempts.push(`${modelId}: skipped (deadline)`); break; }
    try {
      const res = await client.send(new ConverseCommand({
        modelId,
        system: [{ text: req.system }],
        messages: req.messages,
        toolConfig: req.tools?.length ? { tools: req.tools } : undefined,
        inferenceConfig: { maxTokens: req.maxTokens ?? 2048 },
      }), { abortSignal: AbortSignal.timeout(remaining) });
      const content = res.output?.message?.content ?? [];
      lastGood.set(req.model, modelId);
      return {
        text: content.map((c) => c.text ?? '').join(''),
        toolUses: content.flatMap((c) => (c.toolUse ? [c.toolUse] : [])),
        stopReason: res.stopReason,
        usage: res.usage,
        modelId,
      };
    } catch (e) {
      const name = (e as { name?: string })?.name ?? 'Error';
      attempts.push(`${modelId}: ${name}`);
      if (!MODEL_UNAVAILABLE.has(name)) throw e; // throttling, timeout, etc: do not mask by hopping models
      if (cached === modelId) lastGood.delete(req.model);
      firstErr ??= e;
      log(`model ${modelId} unavailable (${name}); trying next`);
    }
  }
  const err = (firstErr ?? new Error('bedrock: no model attempted (timeout)')) as Error;
  try { err.message = `${err.message} [chain: ${attempts.join('; ')}]`; } catch { /* readonly */ }
  throw err;
}

type Assessment = { contentPolicy?: { filters?: { type?: string; confidence?: string; action?: string }[] } };

export type ScreenResult = { allowed: boolean; reason?: 'policy' | 'outage' };
const OUTAGE_RETRY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ApplyGuardrail. familySafe=true (default): any intervention blocks.
 * familySafe=false: same guardrail, but only HATE/SEXUAL filters at HIGH confidence block
 * (client-side filter on the assessment; one guardrail serves both modes).
 * Fails closed: a missing guardrail id or an unreachable/throttled guardrail (one retry after ~300 ms)
 * returns {allowed:false, reason:'outage'}; a real content block returns reason 'policy'.
 */
export async function screen(
  text: string, source: 'INPUT' | 'OUTPUT', familySafe = true,
): Promise<ScreenResult> {
  const id = process.env.GUARDRAIL_ID;
  if (!id) { log('GUARDRAIL_ID missing; failing closed'); return { allowed: false, reason: 'outage' }; }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.send(new ApplyGuardrailCommand({
        guardrailIdentifier: id,
        guardrailVersion: env('GUARDRAIL_VERSION', 'DRAFT'),
        source,
        content: [{ text: { text } }],
      }), { abortSignal: AbortSignal.timeout(4000) });
      if (res.action !== 'GUARDRAIL_INTERVENED') return { allowed: true };
      if (familySafe) return { allowed: false, reason: 'policy' };
      const filters = ((res.assessments ?? []) as Assessment[]).flatMap((a) => a.contentPolicy?.filters ?? []);
      const hard = filters.some((f) =>
        (f.type === 'HATE' || f.type === 'SEXUAL') && f.confidence === 'HIGH' && f.action === 'BLOCKED');
      return hard ? { allowed: false, reason: 'policy' } : { allowed: true };
    } catch (e) {
      log('guardrail error', (e as Error)?.name);
      if (attempt === 0) await sleep(OUTAGE_RETRY_MS);
    }
  }
  return { allowed: false, reason: 'outage' };
}

/** Screen generated text before any player sees it. Fails closed. */
export const screenOutput = (text: string, familySafe: boolean): Promise<ScreenResult> =>
  screen(text, 'OUTPUT', familySafe);

/**
 * Screen player ingredients; policy-blocked ones are dropped and a `blocked` screen message is emitted.
 * Ingredients that could not be screened (guardrail outage) are also dropped (fail closed) but listed in
 * `unscreened` with no client message. Generated text is screened too; if it fails, `output` is withheld
 * and `outputBlocked` carries the reason.
 */
export async function designFromIngredients(
  ingredients: string[],
  opts: { system: string; timeoutMs: number; familySafe?: boolean; model?: ConverseRequest['model']; prompt?: string },
): Promise<{
  output?: ConverseOutput; outputBlocked?: 'policy' | 'outage';
  blocked: string[]; unscreened: string[]; allowed: string[];
  clientMsgs: { t: 'screen'; name: 'blocked' }[];
}> {
  const familySafe = opts.familySafe ?? true;
  const verdicts = await Promise.all(ingredients.map((i) => screen(i, 'INPUT', familySafe)));
  const allowed = ingredients.filter((_, i) => verdicts[i]!.allowed);
  const blocked = ingredients.filter((_, i) => verdicts[i]!.reason === 'policy');
  const unscreened = ingredients.filter((_, i) => verdicts[i]!.reason === 'outage');
  const clientMsgs = blocked.length ? [{ t: 'screen' as const, name: 'blocked' as const }] : [];
  if (!allowed.length) return { blocked, unscreened, allowed, clientMsgs };
  const output = await converse({
    model: opts.model ?? 'designer',
    system: opts.system,
    messages: [{ role: 'user', content: [{ text: `${opts.prompt ?? 'Ingredients'}: ${allowed.join(', ')}` }] }],
    timeoutMs: opts.timeoutMs,
  });
  const out = await screenOutput(output.text, familySafe);
  if (!out.allowed) return { outputBlocked: out.reason, blocked, unscreened, allowed, clientMsgs };
  return { output, blocked, unscreened, allowed, clientMsgs };
}
