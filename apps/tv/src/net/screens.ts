// What each phone should show for the current party state (TV -> phone `screen` messages).
import { themeVars } from '@cadabra/render';
import type { ScreenData, ScreenName, Standing } from '@cadabra/spec';
import { AVATAR_KEYS, type PartyState } from '../state/machine';

export type PhoneScreen = { [K in ScreenName]: { name: K; data: Partial<ScreenData[K]> } }[ScreenName];

/** Avatars other players already wear (the picker greys them out). */
export function takenAvatars(s: PartyState, id: string): string[] {
  return s.players
    .filter((p) => p.id !== id && !p.isBot && (AVATAR_KEYS as readonly string[]).includes(p.avatar))
    .map((p) => p.avatar);
}

export function standings(s: PartyState, you?: string): Standing[] {
  const byId = new Map(s.players.map((p) => [p.id, p]));
  return s.ranking.slice(0, 8).map((r) => {
    const p = byId.get(r.id);
    // never send a selfie data URL back to phones (128 KB WS cap; Standing.avatar <= 20 chars)
    const key = p && !p.isBot ? (p.avatar.startsWith('data:') ? `selfie:${p.id}` : p.avatar) : '';
    const avatar = key && key.length <= 20 && /^(selfie:[A-Za-z0-9_-]+|[a-z]{1,20})$/.test(key) ? key : undefined;
    return { name: (p?.name ?? 'Player').slice(0, 40), score: r.score, ...(avatar ? { avatar } : {}), ...(r.id === you ? { you: true } : {}) };
  });
}

/** The screen for phone `id`, or undefined to leave it as is. `picked`: has chosen an avatar. */
export function phoneScreen(s: PartyState, id: string, picked: boolean): PhoneScreen | undefined {
  const tv = s.spec ? themeVars(s.spec.theme) : undefined;
  const seated = s.players.some((p) => p.id === id);
  const watching = s.spectators.includes(id);
  if (!seated && !watching) return undefined;
  const base = tv ? { themeVars: tv } : {};

  if (watching && (s.phase === 'play' || s.phase === 'forge' || s.phase === 'tutorial')) {
    return { name: 'wait', data: { ...base, message: "You're in the next round!", sub: 'This round is already running. Cheer them on from the couch.' } };
  }
  switch (s.phase) {
    case 'play':
      if (!s.spec) break;
      return { name: 'play', data: { ...base, title: s.spec.title.slice(0, 60), widgets: s.spec.controller } };
    case 'results': {
      const rank = s.ranking.findIndex((r) => r.id === id);
      return {
        name: 'results',
        data: {
          ...base,
          ...(s.spec ? { title: s.spec.title.slice(0, 60) } : {}),
          ...(rank >= 0 ? { rank: Math.min(8, rank + 1) } : {}),
          standings: standings(s, id),
        },
      };
    }
    default:
      break;
  }
  if (!picked) return { name: 'avatar', data: { taken: takenAvatars(s, id) } };
  if (watching) return { name: 'wait', data: { message: 'The room is full', sub: "You'll get a seat as soon as one frees up." } };
  return { name: 'wait', data: { message: "You're in!", sub: 'Look at the TV. The host is picking a game.' } };
}
