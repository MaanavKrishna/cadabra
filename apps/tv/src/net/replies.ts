// Phone -> TV screen replies, validated with parseReply and turned into party actions.
import { parseReply, type PeerMsg } from '@cadabra/spec';
import type { Action } from '../state/machine';
import { TWEAK_CHIP_LABELS, chipOf } from '../tweak/tweak';

/** Replies the reducer does not own (handled by the app: rematch votes, warm-up, remix, tweaks). */
export type PhoneEvent =
  | { type: 'pick'; by: string; action: 'again' | 'remix' }
  | { type: 'ready'; by: string }
  | { type: 'remix'; by: string; text: string }
  | { type: 'tweak'; by: string; key: string; value: number | boolean | string };

export function phoneAction(from: string, msg: PeerMsg): Action | PhoneEvent | undefined {
  const r = parseReply(msg);
  if (!r) return undefined;
  switch (r.reply) {
    case 'avatar.pick': return { type: 'avatar', id: from, avatar: r.avatar };
    case 'storm.add': return { type: 'ingredient', by: from, text: r.idea };
    case 'vote.cast': return { type: 'vote', by: from, vote: r.vote };
    case 'results.pick': return { type: 'pick', by: from, action: r.action };
    case 'warmup.ready': return { type: 'ready', by: from };
    case 'remix.add': return { type: 'remix', by: from, text: r.remix };
    case 'tweak.set': return { type: 'tweak', by: from, key: r.key, value: r.value };
    case 'tweak.ask': {
      // a chip wins over text; a typed label that names a chip counts as that chip
      const text = r.text?.trim();
      const chip = r.chip ?? (text ? chipOf(text) : undefined);
      const exact = !r.chip && text && chip && TWEAK_CHIP_LABELS[chip].toLowerCase() === text.toLowerCase().replace(/[!.?]+$/, '');
      if (r.chip || exact) return { type: 'tweakAsk', ask: { by: from, chip: chip! } };
      return text ? { type: 'tweakAsk', ask: { by: from, text } } : undefined;
    }
  }
}
