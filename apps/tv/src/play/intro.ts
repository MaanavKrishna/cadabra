// The intro card's content: the goal as icon steps ("[ladoo] Grab ladoos -> [basket] bank them ->
// [bear] tiptoe past the bear") and the controls as phone-button glyphs. Hand-tuned lines for the
// built-in games, derived from the blocks for generated ones.
import { DEFAULT_SPRITES } from '@cadabra/render';
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
  steps: IntroStep[];
  controls: IntroControl[];
}

const BUILT_IN: Record<string, IntroStep[]> = {
  'fallback-ladoo-heist': [
    { icon: 'ladoo', text: 'Grab ladoos' },
    { icon: 'goal-basket', text: 'Bank them in your basket' },
    { icon: 'bear-sleep', text: 'Tiptoe past the bear!' },
  ],
  'fallback-lava-penguins': [
    { icon: 'golden-fish', text: 'Catch fish' },
    { icon: 'lava', text: 'Dodge the lava' },
    { icon: 'boost-pad', text: 'Dash to bump rivals off!' },
  ],
  'fallback-bear-tug': [
    { icon: 'rope-segment', text: 'Pull on the beat' },
    { icon: 'banner-red', text: 'Drag them to your side' },
    { icon: 'bear-awake', text: 'Losers hit the mud!' },
  ],
};

const word = (s: unknown, d: string) => (typeof s === 'string' && s.trim() ? s.trim() : d);
const art = (key: unknown): string | undefined => (typeof key === 'string' ? DEFAULT_SPRITES[key] ?? key : undefined);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Goal steps from the blocks (generated games). */
function stepsFromBlocks(spec: GameSpec): IntroStep[] {
  const out: IntroStep[] = [];
  for (const b of spec.blocks) {
    const p = b.params as Record<string, unknown>;
    switch (b.block) {
      case 'collect': {
        const it = word(p.itemSprite, 'item');
        out.push({ icon: art(it), text: `Grab ${it}s` });
        if (p.carryToGoal) out.push({ icon: 'goal-basket', text: 'Bank them at your base' });
        break;
      }
      case 'sneak':
        out.push({ icon: art(word(p.guardSprite, 'guard')), text: `Sneak past the ${word(p.guardSprite, 'guard')}` });
        break;
      case 'dodge':
        out.push({ icon: art(word(p.hazardSprite, 'hazard')), text: `Dodge the ${word(p.hazardSprite, 'hazards')}` });
        break;
      case 'race':
        out.push({ icon: 'finish-flag', text: 'Race to the finish' });
        break;
      case 'tug':
        out.push({ icon: 'rope-segment', text: 'Pull together' });
        break;
      case 'trivia':
        out.push({ icon: 'star', text: 'Answer fastest' });
        break;
      case 'draw-judge':
        out.push({ icon: 'star', text: 'Draw the prompt' });
        break;
      default:
        break;
    }
  }
  return out.slice(0, 3);
}

const HINTS: Record<string, string> = { tiptoe: 'quiet', dash: 'bump', slide: 'bump', pull: 'on the beat', grab: '', jump: '' };

export function introFor(spec: GameSpec): Intro {
  const steps = BUILT_IN[spec.id] ?? stepsFromBlocks(spec);
  const controls: IntroControl[] = spec.controller.slice(0, 3).map((w) => {
    const label = 'label' in w && typeof w.label === 'string' && w.label ? w.label : w.kind === 'joystick' ? 'Move' : cap(w.kind);
    const kind: IntroControl['kind'] = w.kind === 'joystick' ? 'stick' : w.kind === 'button' ? 'button' : w.kind === 'hold' ? 'hold' : w.kind === 'tilt' ? 'tilt' : w.kind === 'swipe' ? 'swipe' : 'other';
    const hint = HINTS[(('id' in w && typeof w.id === 'string' ? w.id : '') || label).toLowerCase()];
    return hint ? { kind, label, hint } : { kind, label };
  });
  return { steps: steps.length ? steps : [{ text: spec.host.tutorial }], controls };
}
