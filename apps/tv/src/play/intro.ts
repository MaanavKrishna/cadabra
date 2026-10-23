// The intro card's content: the goal as icon steps ("[ladoo] Grab ladoos -> [basket] bank them ->
// [bear] tiptoe past the bear") and the controls as phone-button glyphs. Hand-tuned lines for the
// built-in games, derived from the blocks for generated ones.
import { rootId } from '../fallback/lineage';
import type { GameSpec } from '@cadabra/spec';

export interface IntroStep {
  /** Default-pack art stem for the icon. */
  icon?: string;
  text: string;
}

export interface IntroControl {
  kind: 'stick' | 'button' | 'hold' | 'tilt' | 'swipe' | 'other';
  label: string;
  /** What it does, short ("quiet", "bump"). */
  hint?: string;
}

export interface Intro {
  /** One punchy line under the title (built-in games). */
  line?: string;
  steps: IntroStep[];
  controls: IntroControl[];
}

/** Neon glyph icons (drawn as inline SVG by the intro card): `neon:<name>`. */
export const NEON_GLYPHS = ['eye', 'ring', 'shove', 'skull', 'core', 'bomb', 'paint', 'splash', 'base', 'bolt', 'gate', 'flag', 'star'] as const;
export type NeonGlyph = (typeof NEON_GLYPHS)[number];
const g = (n: NeonGlyph) => `neon:${n}`;

const BUILT_IN: Record<string, IntroStep[]> = {
  'fallback-ring-out': [
    { icon: g('shove'), text: 'DASH to shove' },
    { icon: g('ring'), text: 'Knock rivals off the ring' },
    { icon: g('skull'), text: 'Don’t fall off!' },
  ],
  'fallback-overload': [
    { icon: g('bomb'), text: 'Got the core? Touch a rival' },
    { icon: g('bolt'), text: 'Pass it before it blows' },
    { icon: g('star'), text: 'Stay clean to score' },
  ],
  'fallback-paint-wars': [
    { icon: g('paint'), text: 'Move to paint the floor' },
    { icon: g('splash'), text: 'DASH to splash rivals' },
    { icon: g('star'), text: 'Most floor wins' },
  ],
  'fallback-core-rush': [
    { icon: g('core'), text: 'Grab cores' },
    { icon: g('base'), text: 'Carry them to your base' },
    { icon: g('shove'), text: 'DASH to knock them loose' },
  ],
  'fallback-neon-dash': [
    { icon: g('bolt'), text: 'Mash RUN to sprint' },
    { icon: g('gate'), text: 'JUMP the laser gates' },
    { icon: g('flag'), text: 'First to the finish' },
  ],
  'fallback-rocket-ball': [
    { icon: g('bolt'), text: 'BOOST into the ball' },
    { icon: g('shove'), text: 'Bank it off the walls' },
    { icon: g('base'), text: 'Score in their goal' },
  ],
  'fallback-crate-crash': [
    { icon: g('base'), text: 'Guard your crate stack' },
    { icon: g('shove'), text: 'DASH to smash rival crates' },
    { icon: g('bomb'), text: 'Barrels go boom' },
  ],
  // legacy cartoon games (old share codes)
  'fallback-ladoo-heist': [
    { icon: 'ladoo', text: 'Grab ladoos' },
    { icon: 'goal-basket', text: 'Bank them in your basket' },
    { icon: 'bear-sleep', text: 'Tiptoe past the bear!' },
  ],
};

const LINES: Record<string, string> = {
  'fallback-ring-out': 'Dash to shove rivals off the edge. The ring shrinks!',
  'fallback-overload': 'Pass the unstable core before it blows!',
  'fallback-paint-wars': 'Paint the floor your team’s colour. Most tiles wins!',
  'fallback-core-rush': 'Carry cores to your base. Dash carriers to steal!',
  'fallback-neon-dash': 'Race to the finish. Time the laser gates!',
  'fallback-rocket-ball': 'Two on two. Boost the giant ball into their goal!',
  'fallback-crate-crash': 'Keep your crates standing. Knock everyone else’s off!',
};

const word = (s: unknown, d: string) => (typeof s === 'string' && s.trim() ? s.trim() : d);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Goal steps from the blocks (generated games). */
function stepsFromBlocks(spec: GameSpec): IntroStep[] {
  const out: IntroStep[] = [];
  for (const b of spec.blocks) {
    const p = b.params as Record<string, unknown>;
    switch (b.block) {
      case 'arena-move':
        if (p.ringOut) out.push({ icon: g('ring'), text: 'Shove rivals off the ring' });
        else if (p.overload) out.push({ icon: g('bomb'), text: 'Pass the core before it blows' });
        else if (p.paint) out.push({ icon: g('paint'), text: 'Paint the most floor' });
        else if (p.dashButton) out.push({ icon: g('shove'), text: 'DASH to shove' });
        break;
      case 'ball-sport':
        out.push({ icon: g('bolt'), text: 'Hit the ball' }, { icon: g('base'), text: 'Score in their goal' });
        break;
      case 'collect': {
        const it = word(p.itemSprite, 'item');
        out.push({ icon: g('core'), text: `Grab ${it}s` });
        if (p.carryToGoal) out.push({ icon: g('base'), text: 'Bank them at your base' });
        break;
      }
      case 'sneak':
        out.push({ icon: g('eye'), text: `Sneak past the ${word(p.guardSprite, 'guard')}` });
        break;
      case 'dodge':
        out.push({ icon: g('gate'), text: `Dodge the ${word(p.hazardSprite, 'hazards')}` });
        break;
      case 'race':
        out.push({ icon: g('flag'), text: 'Race to the finish' });
        break;
      case 'tug':
        out.push({ icon: g('bolt'), text: 'Pull together' });
        break;
      case 'trivia':
        out.push({ icon: g('star'), text: 'Answer fastest' });
        break;
      case 'draw-judge':
        out.push({ icon: g('star'), text: 'Draw the prompt' });
        break;
      default:
        break;
    }
  }
  // keep the order, drop duplicates, max 3
  return out.filter((x, i) => out.findIndex((y) => y.text === x.text) === i).slice(0, 3);
}

const HINTS: Record<string, string> = { tiptoe: 'quiet', dash: 'bump', slide: 'bump', pull: 'on the beat', grab: '', jump: '' };

export function introFor(spec: GameSpec): Intro {
  const root = rootId(spec);
  const steps = BUILT_IN[root] ?? stepsFromBlocks(spec);
  const controls: IntroControl[] = spec.controller.slice(0, 3).map((w) => {
    const label = 'label' in w && typeof w.label === 'string' && w.label ? w.label : w.kind === 'joystick' ? 'Move' : cap(w.kind);
    const kind: IntroControl['kind'] = w.kind === 'joystick' ? 'stick' : w.kind === 'button' ? 'button' : w.kind === 'hold' ? 'hold' : w.kind === 'tilt' ? 'tilt' : w.kind === 'swipe' ? 'swipe' : 'other';
    const hint = HINTS[(('id' in w && typeof w.id === 'string' ? w.id : '') || label).toLowerCase()];
    return hint && !label.toLowerCase().includes(hint) ? { kind, label, hint } : { kind, label };
  });
  const line = LINES[root];
  return { ...(line ? { line } : {}), steps: steps.length ? steps : [{ text: spec.host.tutorial }], controls };
}
