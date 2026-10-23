// Contextual control hints for the phone during play (task F §6): what each control does in this
// game, from the play screen's own data (title + widgets). Pure, so it is unit-tested.
import type { ControlWidget } from '@cadabra/spec';

export type HintIcon = 'stick' | 'quiet' | 'dash' | 'pull' | 'grab' | 'tap' | 'tilt' | 'swipe';

export interface Hint {
  id: string;
  icon: HintIcon;
  /** Big label on the control ("TIPTOE"). */
  label: string;
  /** What it does here ("quiet: the bear sleeps"). */
  sub: string;
}

interface Rule { test: RegExp; icon: HintIcon; label?: string; sub: string }

const RULES: Rule[] = [
  { test: /tiptoe|sneak|quiet|creep/i, icon: 'quiet', label: 'TIPTOE', sub: 'hold: quiet, guard sleeps' },
  { test: /dash|slide|shove|boost/i, icon: 'dash', label: 'DASH', sub: 'tap to shove rivals' },
  { test: /pull|tug|heave/i, icon: 'pull', label: 'PULL', sub: 'tap on the beat!' },
  { test: /grab|bank|steal|take/i, icon: 'grab', label: 'GRAB / BANK', sub: 'grab loot, bank at your basket' },
  { test: /jump|hop/i, icon: 'tap', label: 'JUMP', sub: 'tap to hop' },
];

const MOVE_SUB = (title: string) =>
  /heist|sneak|steal/i.test(title) ? 'grab loot, run home'
    : /lava|penguin|dodge|floor/i.test(title) ? 'slide, grab fish, dodge lava'
      : /race|run/i.test(title) ? 'run!'
        : 'move around';

export function hintsFor(widgets: readonly ControlWidget[], title = ''): Hint[] {
  const out: Hint[] = [];
  for (const w of widgets) {
    if (w.kind === 'joystick') out.push({ id: w.id, icon: 'stick', label: 'MOVE', sub: MOVE_SUB(title) });
    else if (w.kind === 'tilt') out.push({ id: w.id, icon: 'tilt', label: 'TILT', sub: 'lean to steer' });
    else if (w.kind === 'swipe') out.push({ id: w.id, icon: 'swipe', label: 'SWIPE', sub: 'flick to act' });
    else if (w.kind === 'button' || w.kind === 'hold') {
      const key = `${w.id} ${w.label}`;
      const r = RULES.find((x) => x.test.test(key));
      out.push({
        id: w.id,
        icon: r?.icon ?? 'tap',
        label: (r?.label ?? w.label).toUpperCase().slice(0, 14),
        sub: r?.sub ?? (w.kind === 'hold' ? 'hold it down' : 'tap it'),
      });
    }
  }
  return out;
}

/** The same widgets with the contextual labels painted on the buttons themselves. */
export function relabel(widgets: readonly ControlWidget[], hints: readonly Hint[]): ControlWidget[] {
  return widgets.map((w) => {
    if (w.kind !== 'button' && w.kind !== 'hold') return w;
    const h = hints.find((x) => x.id === w.id);
    return h ? { ...w, label: h.label } : w;
  });
}
