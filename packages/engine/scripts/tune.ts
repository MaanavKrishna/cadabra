import { FALLBACK_SPECS } from '@cadabra/spec';
import { balance } from './balance';
const spec = structuredClone(FALLBACK_SPECS.find((s) => s.id.includes(process.argv[2]!))!);
const patch = JSON.parse(process.argv[3] ?? '{}');
const bi = Number(process.argv[5] ?? 0);
Object.assign(spec.blocks[bi]!.params, patch);
if (process.argv[6]) spec.durationSec = Number(process.argv[6]);
console.log(balance(spec, Number(process.argv[4] ?? 20)));
