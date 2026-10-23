// Strict-playtest failure rate over many seeds: npx tsx packages/engine/scripts/seeds.ts <id> <seats> <seeds> [worldJSON|none]
import { FALLBACK_SPECS } from '@cadabra/spec';
import { BlockRegistry, playtest, registerBuiltins } from '../src/index';
const reg = new BlockRegistry(); registerBuiltins(reg);
const [id, seats, seeds, w] = process.argv.slice(2);
const s = structuredClone(FALLBACK_SPECS.find((x) => x.id.includes(id!))!);
if (w === 'none') delete (s as any).world; else if (w) (s as any).world = JSON.parse(w);
let fail = 0;
for (let seed = 1; seed <= Number(seeds); seed++) { const r = playtest(s, reg, { players: Number(seats), seed }); if (!r.ok) fail++; }
console.log(id, seats, 'fail', fail, '/', seeds);
