// Live check of the TWEAK loop (AI patch + playtest, preset fallback):
//   ANTHROPIC_SECRET_ID=cadabra/anthropic-api-key npx tsx apps/backend/scripts/try-tweak.ts
// Options via env: GAMES="fallback-ring-out,fallback-core-rush" TWEAKS="chip:low-gravity|text:make it pure chaos"
//   SEATS=4 AI=0 (presets only)
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outputs = fileURLToPath(new URL('../outputs.json', import.meta.url));
if (existsSync(outputs)) {
  const o = Object.values(JSON.parse(readFileSync(outputs, 'utf8')))[0] as Record<string, string>;
  process.env.GUARDRAIL_ID ||= o.GuardrailId;
  process.env.GUARDRAIL_VERSION ||= o.GuardrailVersion;
}
process.env.AWS_REGION ||= 'ap-south-1';
const { FALLBACK_SPECS } = await import('@cadabra/spec');
const { tweak } = await import('../src/ai/tweak');
type Req = Parameters<typeof tweak>[1][number];

const games = (process.env.GAMES ?? 'fallback-ring-out,fallback-core-rush,fallback-neon-dash').split(',').map((s) => s.trim());
const sets: Req[][] = (process.env.TWEAKS ?? 'chip:low-gravity,chip:bouncier|text:make it way more chaotic and faster|chip:harder-for-leader,text:giant arena').split('|')
  .map((set) => set.split(',').map((r): Req => {
    const [k, ...v] = r.split(':');
    return k === 'chip' ? { chip: v.join(':') as never } : { text: v.join(':') };
  }));
const seats = Number(process.env.SEATS ?? 4);
const ai = process.env.AI !== '0';

const times: number[] = [];
let failed = 0;
for (const g of games) {
  const spec = FALLBACK_SPECS.find((s) => s.id === g) ?? JSON.parse(readFileSync(g, 'utf8'));
  for (const reqs of sets) {
    const t0 = Date.now();
    const r = await tweak(spec, reqs, { familySafe: true, seats, ai, onProgress: (s) => console.log(`  … ${s} (${Date.now() - t0} ms)`) });
    const ms = Date.now() - t0;
    times.push(ms);
    const diff = JSON.stringify(r.spec.blocks.map((b) => b.params)) !== JSON.stringify(spec.blocks.map((b: { params: unknown }) => b.params))
      || JSON.stringify((r.spec as { world?: unknown }).world) !== JSON.stringify((spec as { world?: unknown }).world);
    console.log(`${g} ${JSON.stringify(reqs)} -> ${r.source} in ${ms} ms (tools=${r.toolCalls ?? 0}) "${r.summary}" [${r.changes.join(' · ')}] parent=${r.spec.origin.parentId} changed=${diff} playtest=${r.report?.ok}`);
    if (r.source === 'none' || ms > 15000) failed++;
  }
}
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
console.log(`\n${times.length} tweaks: p50=${pct(0.5)} ms p90=${pct(0.9)} ms max=${times.at(-1)} ms; ${failed} without a change or over 15 s`);
process.exit(failed ? 1 : 0);
