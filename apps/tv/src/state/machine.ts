// The party state machine: one pure reducer for the whole evening (lobby -> play -> results -> ...).
// The TV is the authority; screens render from PartyState and side effects (network, voice,
// the game loop) live outside the reducer.
import { makeBots, Rng, type Player } from '@cadabra/engine';
import { DEFAULT_SETTINGS, MAX_PLAYERS, type BackendToClient, type GameSpec, type Pitch, type RoomSettings } from '@cadabra/spec';
import { addProgress, belongs, emptyForge, type ForgeInfo } from '../forge/forge';

export type Phase = 'lobby' | 'storm' | 'pitching' | 'voting' | 'forge' | 'tutorial' | 'play' | 'results' | 'remix' | 'arcade';
export type Settings = RoomSettings;
export type { Player };

/** Phases where a game is being built or played: newcomers watch until results. */
export const LATE_PHASES: readonly Phase[] = ['forge', 'tutorial', 'play'];

/** The 12 premade characters (avatar keys shared with the controller and the render pack). */
export const AVATAR_KEYS = [
  'penguin', 'cat', 'robot', 'astronaut', 'dragon', 'fox', 'panda', 'bunny', 'monkey', 'chef', 'ninja', 'unicorn',
] as const;

export interface RankEntry { id: string; score: number; team?: number }

export interface PartyState {
  phase: Phase;
  code: string;
  players: Player[];
  spectators: string[];
  ingredients: { by: string; text: string }[];
  pitches: Pitch[];
  votes: Record<string, number>;
  spec?: GameSpec;
  art: Record<string, string>;
  round: number;
  settings: Settings;
  /** Names/avatars of everyone seen this evening (spectators have no Player yet). */
  roster: Record<string, { name: string; avatar: string }>;
  /** Last round's ranking, winner first (runtime order). */
  ranking: RankEntry[];
  /** The AI forge in progress (storm -> pitches -> vote -> forge). */
  forge: ForgeInfo;
}

export type Action =
  | { type: 'room'; code: string }
  | { type: 'join'; id: string; name: string; avatar?: string }
  | { type: 'left'; id: string }
  | { type: 'avatar'; id: string; avatar: string }
  | { type: 'fillBots' }
  | { type: 'clearBots' }
  | { type: 'settings'; patch: Partial<Settings> }
  | { type: 'phase'; phase: Phase }
  | { type: 'ingredient'; by: string; text: string }
  | { type: 'pitches'; pitches: Pitch[] }
  | { type: 'vote'; by: string; vote: number }
  | { type: 'start'; spec: GameSpec; art?: Record<string, string> }
  | { type: 'results'; ranking: RankEntry[] }
  | { type: 'lobby' }
  /** Generated art arriving after the vote (forge.art): sprite key or 'keyArt' -> https URL. */
  | { type: 'art'; key: string; url: string }
  /** Start an Idea Storm (Create): clears the last forge. */
  | { type: 'storm' }
  /** A forge.* message from the backend; dropped unless it belongs to the current forge. */
  | { type: 'forge'; msg: Extract<BackendToClient, { t: 'forge.pitches' | 'forge.progress' | 'forge.ready' | 'forge.art' }> }
  /** The TV's own vote (D-pad Select), used to break ties. */
  | { type: 'tvVote'; vote: number }
  /** The vote closed: this pitch is being built. */
  | { type: 'winner'; pitchId: string };

export function initialState(code = '', settings: Settings = DEFAULT_SETTINGS): PartyState {
  return {
    phase: 'lobby', code, players: [], spectators: [], ingredients: [], pitches: [], votes: {},
    art: {}, round: 0, settings: { ...settings }, roster: {}, ranking: [], forge: emptyForge(),
  };
}

export const humans = (s: PartyState): Player[] => s.players.filter((p) => !p.isBot);
export const bots = (s: PartyState): Player[] => s.players.filter((p) => p.isBot);

/** First premade avatar nobody in the room wears yet (deterministic). */
export function freeAvatar(s: PartyState, exceptId?: string): string {
  const taken = new Set(s.players.filter((p) => p.id !== exceptId).map((p) => p.avatar));
  for (const id of s.spectators) if (id !== exceptId && s.roster[id]) taken.add(s.roster[id]!.avatar);
  return AVATAR_KEYS.find((k) => !taken.has(k)) ?? AVATAR_KEYS[s.players.length % AVATAR_KEYS.length]!;
}

/** Seat a human, bumping the newest bot if the room is full. false = no seat (4 humans already). */
function seat(players: Player[], p: Player): Player[] | undefined {
  const out = [...players];
  if (out.filter((q) => !q.isBot).length >= MAX_PLAYERS) return undefined;
  if (out.length >= MAX_PLAYERS) {
    const botIdx = out.map((q) => q.isBot).lastIndexOf(true);
    if (botIdx < 0) return undefined;
    out.splice(botIdx, 1);
  }
  out.push(p);
  return out;
}

/** Move spectators into free (or bot) seats, in arrival order. */
function promote(s: PartyState): PartyState {
  let players = s.players;
  const left: string[] = [];
  for (const id of s.spectators) {
    const info = s.roster[id] ?? { name: 'Player', avatar: '' };
    const next = seat(players, { id, name: info.name, avatar: info.avatar, isBot: false, connected: true, score: 0 });
    if (next) players = next;
    else left.push(id);
  }
  return { ...s, players, spectators: left };
}

function fillBots(s: PartyState): PartyState {
  if (!s.settings.bots) return s;
  const need = MAX_PLAYERS - s.players.length;
  if (need <= 0) return s;
  const usedIds = new Set(s.players.map((p) => p.id));
  const usedNames = new Set(s.players.map((p) => p.name));
  const pool = makeBots(MAX_PLAYERS * 2, new Rng(0xcada + s.round));
  // bots wear bot:<k> = AVATAR_KEYS[k]; skip faces a phone player already wears
  const worn = new Set(s.players.filter((p) => !p.isBot).map((p) => p.avatar));
  const face = (b: Player) => AVATAR_KEYS[Number(b.avatar.slice(4)) % AVATAR_KEYS.length];
  const fresh = pool.filter((b) => !usedIds.has(b.id) && !usedNames.has(b.name));
  const add = [...fresh.filter((b) => !worn.has(face(b)!)), ...fresh.filter((b) => worn.has(face(b)!))].slice(0, need);
  return { ...s, players: [...s.players, ...add] };
}

export function reduce(s: PartyState, a: Action): PartyState {
  switch (a.type) {
    case 'room':
      return { ...s, code: a.code };

    case 'join': {
      const name = a.name.trim().slice(0, 40) || 'Player';
      const known = s.players.find((p) => p.id === a.id);
      if (known) {
        // reconnect: same seat, same score
        return {
          ...s,
          players: s.players.map((p) => (p.id === a.id ? { ...p, name, avatar: a.avatar || p.avatar, connected: true } : p)),
        };
      }
      const avatar = a.avatar || s.roster[a.id]?.avatar || freeAvatar(s, a.id);
      const roster = { ...s.roster, [a.id]: { name, avatar } };
      const watch = (): PartyState => ({
        ...s, roster, spectators: s.spectators.includes(a.id) ? s.spectators : [...s.spectators, a.id],
      });
      if (LATE_PHASES.includes(s.phase)) return watch();
      const players = seat(s.players, { id: a.id, name, avatar, isBot: false, connected: true, score: 0 });
      return players ? { ...s, roster, players, spectators: s.spectators.filter((x) => x !== a.id) } : watch();
    }

    case 'left': {
      const spectators = s.spectators.filter((x) => x !== a.id);
      if (s.phase === 'lobby') {
        // free the seat so the next phone (or a waiting spectator) can take it
        return promote({ ...s, players: s.players.filter((p) => p.id !== a.id), spectators });
      }
      return { ...s, spectators, players: s.players.map((p) => (p.id === a.id ? { ...p, connected: false } : p)) };
    }

    case 'avatar': {
      const roster = s.roster[a.id] ? { ...s.roster, [a.id]: { ...s.roster[a.id]!, avatar: a.avatar } } : s.roster;
      return { ...s, roster, players: s.players.map((p) => (p.id === a.id && !p.isBot ? { ...p, avatar: a.avatar } : p)) };
    }

    case 'fillBots':
      return fillBots(s);

    case 'clearBots':
      return { ...s, players: s.players.filter((p) => !p.isBot) };

    case 'settings': {
      const settings = { ...s.settings, ...a.patch };
      const next = { ...s, settings };
      return settings.bots ? next : reduce(next, { type: 'clearBots' });
    }

    case 'phase':
      return { ...s, phase: a.phase };

    case 'ingredient':
      if (s.phase !== 'storm') return s;
      return { ...s, ingredients: [...s.ingredients, { by: a.by, text: a.text.slice(0, 40) }].slice(-12) };

    case 'pitches':
      return { ...s, pitches: a.pitches, votes: {} };

    case 'vote':
      if (s.phase !== 'voting' || !s.players.some((p) => p.id === a.by)) return s;
      return { ...s, votes: { ...s.votes, [a.by]: a.vote } };

    case 'start':
      return { ...s, phase: 'play', spec: a.spec, art: a.art ?? {}, round: s.round + 1, ranking: [] };

    case 'results': {
      // the runtime's order (last-standing games rank survivors first, not by score)
      const ranking = [...a.ranking];
      const got = new Map(ranking.map((r) => [r.id, r.score]));
      const players = s.players.map((p) => ({ ...p, score: p.score + (got.get(p.id) ?? 0) }));
      return promote({ ...s, phase: 'results', ranking, players });
    }

    case 'art':
      return { ...s, art: { ...s.art, [a.key]: a.url } };

    case 'storm':
      return { ...s, phase: 'storm', ingredients: [], pitches: [], votes: {}, forge: emptyForge() };

    case 'tvVote':
      if (s.phase !== 'voting' || a.vote < 0 || a.vote >= s.pitches.length) return s;
      return { ...s, forge: { ...s.forge, tvVote: a.vote } };

    case 'winner':
      if (s.phase !== 'voting' || !s.pitches.some((p) => p.id === a.pitchId)) return s;
      return { ...s, phase: 'forge', forge: { ...s.forge, winner: a.pitchId } };

    case 'forge': {
      const m = a.msg;
      const f = s.forge;
      if (!belongs(f, s.pitches, m, s.phase === 'pitching')) return s;
      switch (m.t) {
        case 'forge.pitches':
          return { ...s, phase: 'voting', pitches: m.pitches, votes: {}, forge: { ...emptyForge(), ...(m.forgeId ? { id: m.forgeId } : {}) } };
        case 'forge.progress':
          return { ...s, forge: { ...f, progress: { ...f.progress, [m.pitchId]: addProgress(f.progress[m.pitchId], m.step, m.pct) } } };
        case 'forge.ready':
          return { ...s, forge: { ...f, ready: { ...f.ready, [m.pitchId]: { spec: m.spec, fallback: !!m.fallback } } } };
        case 'forge.art': {
          const forge = { ...f, art: { ...f.art, [m.pitchId]: { ...f.art[m.pitchId], [m.key]: m.url } } };
          // art for the forged game that is already on screen
          const live = m.pitchId === f.winner && !!s.spec && f.ready[m.pitchId]?.spec.id === s.spec.id && (s.phase === 'play' || s.phase === 'results');
          return { ...s, forge, ...(live ? { art: { ...s.art, [m.key]: m.url } } : {}) };
        }
      }
      return s;
    }

    case 'lobby':
      return promote({ ...s, phase: 'lobby', ingredients: [], pitches: [], votes: {} });
  }
}
