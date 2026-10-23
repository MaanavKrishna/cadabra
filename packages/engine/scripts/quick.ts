// Quick-fire check: every fallback at 30/45 s (timeline rescaled like the TV does) + strict playtest at 2..4 seats.
import { FALLBACK_SPECS, type GameSpec } from '@cadabra/spec';
import { BlockRegistry, playtest, registerBuiltins } from '../src/index';
import { balance } from './balance';
const reg = new BlockRegistry(); registerBuiltins(reg);
export function shorten(spec: GameSpec, d: number): GameSpec {
  const k = d / spec.durationSec;
  const timeline = spec.timeline.map((ev) => ({ ...ev, atSec: ev.atSec >= spec.durationSec - 10 ? Math.max(0, d - (spec.durationSec - ev.atSec)) : Math.round(ev.atSec * k) }));
  return { ...spec, durationSec: d, timeline };
}
for (const base of FALLBACK_SPECS) {
  for (const d of [base.durationSec, 45, 30]) {
    const spec = shorten(base, d);
    const seats = spec.teams === 2 ? [4] : [2, 3, 4];
    const bad = seats.map((n) => [n, playtest(spec, reg, { players: n }).reasons] as const).filter(([, r]) => r.length);
    if (bad.length) console.log('PLAYTEST FAIL', spec.id, d, JSON.stringify(bad));
    if (d !== base.durationSec) console.log(balance(spec, Number(process.argv[2] ?? 20)).split('\n').slice(0, 3).join('\n'));
  }
}
