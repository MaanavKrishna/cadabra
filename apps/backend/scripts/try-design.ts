// Live check of the designer agent (needs AWS creds with Bedrock Claude access):
//   npx tsx apps/backend/scripts/try-design.ts "penguins" "lava floor" "steal fish"
// Options via env: PLAYERS="Asha,Ravi" RUNS=3 DEADLINE_MS=25000 REMIX="make the lava faster"
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outputs = fileURLToPath(new URL('../outputs.json', import.meta.url));
if (existsSync(outputs)) {
  const o = Object.values(JSON.parse(readFileSync(outputs, 'utf8')))[0] as Record<string, string>;
  process.env.GUARDRAIL_ID ||= o.GuardrailId;
  process.env.GUARDRAIL_VERSION ||= o.GuardrailVersion;
}
process.env.AWS_REGION ||= 'ap-south-1';
const { pitch, design, remix } = await import('../src/ai/designer');

const ingredients = process.argv.slice(2).length ? process.argv.slice(2) : ['penguins', 'lava floor', 'steal fish'];
const players = (process.env.PLAYERS ?? 'Asha,Ravi,Mia').split(',').map((s) => s.trim()).filter(Boolean);
const runs = Number(process.env.RUNS ?? 1);
const deadlineMs = Number(process.env.DEADLINE_MS ?? 25000);
const s = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

let failed = 0;
for (let run = 1; run <= runs; run++) {
  console.log(`\n=== run ${run}/${runs}: ${ingredients.join(' + ')} ===`);
  let t0 = Date.now();
  const ps = await pitch(ingredients, players, { familySafe: true, deadlineMs: 8000 });
  console.log(`pitches (${s(t0)}):`);
  for (const p of ps) console.log(`  - ${p.title}: ${p.hook} [${p.blocksSketch.join(', ')}]`);

  t0 = Date.now();
  try {
    const r = await design(ps[0]!, {
      ingredients, players, householdBlocks: [], deadlineMs,
      onProgress: (step) => console.log(`  … ${step} (${s(t0)})`),
    });
    const wall = Date.now() - t0;
    console.log(JSON.stringify(r.spec, null, 2));
    console.log(`playtest: ok=${r.report.ok} stats=${JSON.stringify(r.report.stats)}`);
    console.log(`toolCalls=${r.toolCalls} wall=${(wall / 1000).toFixed(1)} s ${wall < 25000 ? 'PASS (<25 s)' : 'SLOW (>=25 s)'}`);
    if (wall >= 25000 || !r.report.ok) failed++;

    if (process.env.REMIX) {
      t0 = Date.now();
      const m = await remix(r.spec, process.env.REMIX, { deadlineMs: 10000, onProgress: (st) => console.log(`  … ${st} (${s(t0)})`) });
      console.log(`remix (${s(t0)}): parent=${m.spec.origin.parentId} wildNeeded=${m.wildNeeded}`);
    }
  } catch (e) {
    failed++;
    console.log(`FAIL design after ${s(t0)}: ${(e as Error).name}: ${(e as Error).message}`);
  }
}
console.log(failed ? `\n${failed}/${runs} run(s) failed` : `\nall ${runs} run(s) passed`);
process.exit(failed ? 1 : 0);
