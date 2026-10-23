/**
 * Self-explaining score popups: an engine score reason ("collect.banked", or a ready-made
 * "+3 Banked!") plus its delta -> the short line shown over the player's head.
 * Pure (no Pixi), so it is unit-tested and shared by every block.
 */

/** Pretty noun for an item sprite key ('ladoo' -> 'Ladoo', 'golden-fish' -> 'Fish'). */
export function itemNoun(sprite: string | undefined): string {
  if (!sprite) return '';
  const base = sprite.replace(/^golden-/, '').replace(/[-_]+/g, ' ').trim();
  if (!base || base === 'item' || base === 'coin' || /^https?:/.test(base)) return base === 'coin' ? 'Coin' : '';
  const w = base.split(' ').pop()!;
  return w.length > 12 ? '' : w[0]!.toUpperCase() + w.slice(1);
}

const sign = (d: number) => (d > 0 ? `+${d}` : `−${Math.abs(d)}`);

/** Reason code -> label (after the number). `{n}` = item noun. */
const LABELS: Record<string, string> = {
  'collect.item': '{n}',
  'collect.golden': 'Golden {n}!',
  'collect.banked': 'Banked!',
  'collect.steal': 'Stolen!',
  'collect.stolen': 'Robbed!',
  'dodge.hit': 'Ouch!',
  'dodge.nearMiss': 'Close call!',
  'dodge.survive': 'Survived',
  'sneak.woke': 'Woke it up!',
  'sneak.caught': 'Caught!',
  'sneak.daring': 'Daring!',
  'tug.win': 'Tug win!',
  'tug.lead': 'Winning pull',
  'trivia.fast': 'Fast answer!',
  'trivia.correct': 'Correct',
  'race.checkpoint': 'Checkpoint',
  'race.lap': 'Lap!',
  'race.finish': 'Finished!',
  'draw.judged': 'Judged',
  'draw.timeout': 'Time',
};

/**
 * The popup line. Human reasons from the engine ("+1 Ladoo", "Woke the bear!") are used as
 * they are (a missing number is prefixed); known codes are translated; anything else is just
 * the signed number. `mult` > 1 (final-10 double points) appends "×2".
 */
export function popupText(delta: number, reason: string | undefined, noun = '', mult = 1): string {
  const num = sign(delta);
  const x = mult > 1 ? ` ×${mult}` : '';
  const r = (reason ?? '').trim();
  if (!r) return num + x;
  // already human: has a space, an uppercase letter or punctuation, and no dotted code shape
  if (!/^[a-z0-9]+(\.[a-zA-Z0-9]+)+$/.test(r)) {
    if (/^[+−-]\d/.test(r)) return r + x;
    return `${num} ${r}${x}`;
  }
  const lab = LABELS[r];
  if (lab === undefined) return num + x;
  const text = lab.replace('{n}', noun).replace(/\s+/g, ' ').trim();
  return text ? `${num} ${text}${x}` : num + x;
}

/** Popup colour family: gains gold, losses red, steals (zero-sum) accent. */
export function popupTone(delta: number, reason: string | undefined): 'gain' | 'loss' | 'big' {
  if (delta < 0) return 'loss';
  const r = reason ?? '';
  if (delta >= 3 || /bank|golden|win|finish|lap/i.test(r)) return 'big';
  return 'gain';
}
