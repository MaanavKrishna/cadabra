// Live art smoke: npx tsx apps/backend/scripts/smoke-art.ts (needs AWS creds + outputs.json). Reports "unavailable (quota 0)" gracefully.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = JSON.parse(readFileSync(fileURLToPath(new URL('../outputs.json', import.meta.url)), 'utf8'));
const o = Object.values(out)[0] as Record<string, string>;
process.env.GUARDRAIL_ID ||= o.GuardrailId;
process.env.GUARDRAIL_VERSION ||= o.GuardrailVersion;
process.env.ASSETS_BUCKET ||= o.AssetsBucket;
process.env.ASSETS_URL ||= o.AssetsUrl;
const { artForSpec, imageAvailable } = await import('../src/ai/art');
const palette = { bg: '#101020', primary: '#ff5533', accent: '#ffcc00', glow: '#ff8844', text: '#ffffff' } as const;
const got: Record<string, string> = {};
await artForSpec(
  { id: `smoke-${Date.now()}`, theme: { palette, artStyle: 'flat vector cartoon', keyArtPrompt: 'a volcano arena with party lights', sprites: { imp: 'a friendly fire imp' } } },
  (k, u) => { got[k] = u; console.log(`  ${k}: ${u}`); }, Date.now() + 40_000, true,
);
if (!imageAvailable()) { console.log('image provider unavailable (quota 0 / no access): art skipped, TV uses default pack'); process.exit(0); }
console.log(Object.keys(got).length ? 'art ok' : 'FAIL: no art produced');
process.exit(Object.keys(got).length ? 0 : 1);
