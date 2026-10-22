// Live smoke: npx tsx apps/backend/scripts/smoke-bedrock.ts (needs AWS creds + deployed stack outputs.json)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = JSON.parse(readFileSync(fileURLToPath(new URL('../outputs.json', import.meta.url)), 'utf8'));
const o = Object.values(out)[0] as Record<string, string>;
process.env.GUARDRAIL_ID ||= o.GuardrailId;
process.env.GUARDRAIL_VERSION ||= o.GuardrailVersion;
process.env.AWS_REGION ||= 'ap-south-1';
const { converse, screen } = await import('../src/ai/bedrock');

let failed = 0;
const step = async (label: string, fn: () => Promise<boolean>) => {
  try { const ok = await fn(); console.log(ok ? label : `FAIL ${label}`); if (!ok) failed++; }
  catch (e) { console.log(`FAIL ${label}: ${(e as Error).name}: ${(e as Error).message.slice(0, 160)}`); failed++; }
};
const ask = (model: 'designer' | 'fast') => async () => {
  const r = await converse({ model, system: 'Reply with one word.', messages: [{ role: 'user', content: [{ text: 'say ok' }] }], maxTokens: 20, timeoutMs: 20000 });
  console.log(`  (${model} via ${r.modelId}: ${JSON.stringify(r.text)})`);
  return /ok/i.test(r.text);
};
await step('designer ok', ask('designer'));
await step('fast ok', ask('fast'));
await step('clean allowed', async () => (await screen('a friendly space cat who loves pizza', 'INPUT')).allowed);
await step('profane blocked', async () => !(await screen('you stupid fucking idiot, I will kill you', 'INPUT')).allowed);
process.exit(failed ? 1 : 0);
