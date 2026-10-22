import type { BlockDef, KitEntry, RequiredControl } from '@cadabra/engine';
import type { GameSpec } from '@cadabra/spec';
import { CATALOG, REGISTRY } from './tools';

/**
 * Prompts for the Cadabra designer agent. Everything here is static per deploy, so the big
 * system prompt is byte-identical across calls and sits behind a Bedrock cache point.
 */

type Prop = {
  type?: string; enum?: unknown[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
  maxItems?: number; default?: unknown; description?: string;
};

const fmtDefault = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

function fmtParam(name: string, p: Prop): string {
  let type = p.type ?? 'any';
  if (p.enum) type = p.enum.map((e) => `"${String(e)}"`).join('|');
  else if (type === 'number' || type === 'integer') {
    const range = `${p.minimum ?? ''}..${p.maximum ?? ''}`;
    type = `${type === 'integer' ? 'int' : 'num'} ${range}`;
  } else if (type === 'string' && p.maxLength) type = `string≤${p.maxLength}`;
  else if (type === 'array' && name === 'questions') type = `array≤${p.maxItems ?? 30} of {q, options:[4 strings], answer:0-3}`;
  const def = 'default' in p ? ` =${fmtDefault(p.default)}` : '';
  return `  - ${name}: ${type}${def} — ${p.description ?? ''}`.trimEnd();
}

const widgetStr = (c: { kind: string; id: string }) => (c.id ? `${c.kind} id="${c.id}"` : `any ${c.kind}`);

function fmtNeed(c: RequiredControl): string {
  const main = `${widgetStr(c)}${c.param ? ` (id follows params.${c.param})` : ''}`;
  return [main, ...(c.alt ?? []).map(widgetStr)].join(' OR ');
}

function needs(def: BlockDef): string {
  if (def.requiredControls) {
    const req = def.requiredControls(def.defaults);
    return req.length ? req.map(fmtNeed).join('  AND  ') : 'nothing';
  }
  return def.controls.length ? `any one of: ${def.controls.join(', ')}` : 'nothing';
}

function fmtBlock(k: KitEntry): string {
  const def = REGISTRY.get(k.id)!;
  const props = (k.params as { properties?: Record<string, Prop> }).properties ?? {};
  return [
    `### ${k.id} — ${k.name} [arena: ${k.arenaKinds.join('/')}]`,
    k.summary,
    `needs (with default params): ${needs(def)}`,
    `params (all optional; omit to keep the default):`,
    ...Object.entries(props).map(([n, p]) => fmtParam(n, p)),
  ].join('\n');
}

/** The catalog as compact text: one section per block, every param with range, default, meaning. */
export function catalogText(): string {
  return CATALOG.map(fmtBlock).join('\n\n');
}

/** Example specs. Each one is checked by the test suite to pass validate + playtest. */
export const EXAMPLE_SPECS: Omit<GameSpec, 'version' | 'id' | 'origin'>[] = [
  {
    title: 'Ladoo Heist',
    hook: "Tiptoe past a sleeping bear and sneak every ladoo out of Grandma's kitchen.",
    theme: {
      palette: { bg: '#2b1a12', primary: '#ff9f1c', accent: '#e63946', glow: '#ffd166', text: '#fff6e5' },
      artStyle: 'warm storybook cartoon',
      keyArtPrompt: "A huge sleeping brown bear snoring in a cozy grandma's kitchen, plates of golden ladoos on every counter, warm lamplight, no text",
      sprites: {
        player: 'tiny sneaky kid in socks, top-down cartoon',
        ladoo: 'golden round ladoo sweet, top-down cartoon',
        bear: 'sleeping brown bear in an apron, top-down cartoon',
      },
      sfxSet: 'cartoon',
    },
    arena: { kind: 'topdown', width: 1280, height: 720 },
    teams: 0,
    durationSec: 90,
    blocks: [
      { block: 'sneak', params: { guardSprite: 'bear', hearingRadius: 320, wakeDurationSec: 5 } },
      { block: 'collect', params: { itemSprite: 'ladoo', maxItems: 24, spawnEverySec: 1.5 } },
    ],
    modifiers: [],
    win: { type: 'highScore' },
    timeline: [
      { atSec: 45, kind: 'bear-sleepwalk', params: { durationSec: 10 }, hostLine: 'The bear is sleepwalking! Asha, freeze!' },
      { atSec: 80, kind: 'double-ladoo', params: { multiplier: 2 }, hostLine: 'Final ten seconds: grab everything, Ravi!' },
    ],
    comeback: { enabled: true, strength: 0.5 },
    controller: [
      { kind: 'joystick', id: 'move' },
      { kind: 'hold', id: 'tiptoe', label: 'Tiptoe' },
    ],
    host: {
      intro: "Asha, Ravi: Grandma's ladoos are out and the bear is snoring. Steal them all.",
      finale: 'The bear wakes up to an empty kitchen. Who is the ladoo legend?',
      tutorial: 'Move with the stick. Hold Tiptoe near the bear to stay silent. Touch a ladoo to grab it.',
    },
  },
  {
    title: 'Lava Floor Penguins',
    hook: 'The floor is lava, the fish are falling, and penguins cannot fly. Waddle fast.',
    theme: {
      palette: { bg: '#14213d', primary: '#4cc9f0', accent: '#ff5400', glow: '#ffbe0b', text: '#f1faee' },
      artStyle: 'chunky bright vector cartoon',
      keyArtPrompt: 'Cheerful penguins hopping across glowing orange lava cracks on an ice floe, fish raining from the sky, bold shapes, no text',
      sprites: {
        player: 'round penguin with a scarf, top-down cartoon',
        fish: 'shiny blue fish, top-down cartoon',
        lava: 'bubbling orange lava blob with a warning glow, top-down cartoon',
      },
      sfxSet: 'arcade',
    },
    arena: { kind: 'topdown', width: 1280, height: 720 },
    teams: 0,
    durationSec: 90,
    blocks: [
      { block: 'arena-move', params: { speed: 300, friction: 3, dashButton: 'dash' } },
      { block: 'collect', params: { itemSprite: 'fish', spawnEverySec: 0.9, maxItems: 12 } },
      { block: 'dodge', params: { hazardSprite: 'lava', pattern: 'rain', onHit: 'stun', startRate: 0.6, maxRate: 2.5 } },
    ],
    modifiers: [],
    win: { type: 'highScore' },
    timeline: [
      { atSec: 40, kind: 'surprise', params: {}, hostLine: 'The volcano burps! Watch the sky, Mia!' },
      { atSec: 80, kind: 'twist', params: {}, hostLine: 'Ten seconds left and the lava is ANGRY!' },
    ],
    comeback: { enabled: true, strength: 0.6 },
    controller: [
      { kind: 'joystick', id: 'move' },
      { kind: 'button', id: 'dash', label: 'Slide' },
    ],
    host: {
      intro: 'Mia, Leo: grab fish, dodge the lava drops, and slide like you mean it.',
      finale: 'The ice cools down. One penguin waddles home a fish millionaire.',
      tutorial: 'Stick to waddle, tap Slide to dash. Grab fish, dodge the glowing drops.',
    },
  },
  {
    title: 'Noodle Tug',
    hook: 'Two teams, one enormous noodle. Slurp it over your line.',
    theme: {
      palette: { bg: '#1b1b3a', primary: '#f4d35e', accent: '#ee964b', glow: '#f95738', text: '#faf0ca' },
      artStyle: 'bouncy rubber-hose cartoon',
      keyArtPrompt: 'Two teams of cartoon chefs pulling a giant noodle across a steaming kitchen, dramatic and silly, no text',
      sprites: { player: 'cartoon chef pulling hard, side view', noodle: 'giant wobbly noodle rope' },
      sfxSet: 'cartoon',
    },
    arena: { kind: 'tug', width: 1280, height: 720 },
    teams: 2,
    durationSec: 75,
    blocks: [{ block: 'tug', params: { mode: 'mash', suddenDeathAtSec: 65 } }],
    modifiers: [],
    win: { type: 'teamScore' },
    timeline: [
      { atSec: 35, kind: 'slippery-sauce', params: {}, hostLine: 'Someone spilled the sauce! Grip it, Sam!' },
      { atSec: 65, kind: 'sudden-death', params: {}, hostLine: 'Sudden death! Every tap counts double!' },
    ],
    comeback: { enabled: true, strength: 0.4 },
    controller: [{ kind: 'button', id: 'pull', label: 'PULL' }],
    host: {
      intro: 'Team Sam versus Team Zoe. One noodle. No mercy.',
      finale: 'The noodle has chosen its champions. Slurp responsibly.',
      tutorial: 'Mash PULL as fast as you can. Your team pulls together.',
    },
  },
];

const compact = (x: unknown) => JSON.stringify(x);

const SPEC_SHAPE = `{
  "title": string ≤40, "hook": string ≤120 (one line that sells the fun),
  "theme": { "palette": {"bg","primary","accent","glow","text"} each "#rrggbb", "artStyle": string ≤120,
             "keyArtPrompt": string ≤600, "sprites": { spriteKey: prompt ≤300 }, "sfxSet": "arcade"|"cartoon"|"spooky"|"scifi"|"nature" },
  "arena": { "kind": "topdown"|"lanes"|"tug"|"canvas"|"quiz", "width": 1280, "height": 720 },
  "teams": 0 | 2,
  "durationSec": int 60..120,
  "blocks": [ { "block": blockId, "params": {...} } ] (1..4),
  "modifiers": [] (same shape, max 4; usually empty),
  "win": { "type": "highScore"|"lastStanding"|"firstTo"|"teamScore", "target"?: number },
  "timeline": [ { "atSec": number < durationSec, "kind": string, "params": {...}, "hostLine": string ≤160 } ] (1..4),
  "comeback": { "enabled": boolean, "strength": 0..1 },
  "controller": [ widget ] (1..6) where widget is one of
     {"kind":"joystick","id"} {"kind":"button","id","label"≤20} {"kind":"hold","id","label"≤20} {"kind":"tilt","id"}
     {"kind":"swipe","id"} {"kind":"draw","id","prompt"≤80} {"kind":"vote","id","options":[2..6 strings]} {"kind":"text","id","placeholder"}
     (widget ids ≤32 chars, unique),
  "host": { "intro": ≤240, "finale": ≤240, "tutorial": ≤240 }
}
"version", "id" and "origin" are filled in by the server: omit them.`;

let cachedSystem: string | undefined;

/** The designer's system prompt: role, workflow, design rules, full kit catalog, examples, repair guide. */
export function designerSystemPrompt(): string {
  if (cachedSystem) return cachedSystem;
  cachedSystem = `You are the game designer inside Cadabra, a party game for a family on a couch: the game runs on a TV, phones are the controllers, 2–4 players (bots fill empty seats). The room threw in silly ingredients and voted for a pitch; you turn that pitch into a GameSpec JSON that the Cadabra engine runs. You cannot write code: you combine the kit blocks below and tune their params. A good game is instantly readable, chaotic, fair, and over before anyone gets bored.

# How to work (every second counts: the room is watching a progress bar)
1. In your FIRST reply, write the complete spec and call playtest_spec({"spec": ...}). The catalog below is complete: do not call list_blocks or get_block_schema unless an error confuses you.
2. If the playtest passes, call submit_spec with NO arguments (it submits your latest spec).
3. If it fails, read every reason, fix ALL of them in one patch_spec (RFC 6902 ops on your latest spec; omit "spec"), then playtest_spec with no arguments. You may call patch_spec then playtest_spec in the same reply.
4. Never rewrite the whole spec to fix something small: patch it. Never argue with the playtest: the bots are the ground truth.
5. No prose outside tool calls. No markdown.
Tools remember your latest spec: any spec tool called without "spec" uses it. submit_spec only accepts a spec that validates and passes the bot playtest.

# Design rules
- Short rounds: durationSec 60–120 (75–90 is ideal).
- Comeback: comeback.enabled true, strength 0.3–0.7 (trailing players get gentle boosts).
- Exactly ONE mid-round surprise event at 40–60% of the round that changes how it plays, and ONE final event at exactly durationSec − 10 that makes the last 10 seconds dramatic. So timeline usually has 2 events; every atSec < durationSec.
- Host lines are read aloud and shown as banners: ≤ 12 words, punchy, present tense, readable from the couch.
- Use the players' real names (given in the brief) in host.intro and in at least one timeline hostLine. Never invent player names; with no names, address "everyone".
- TV readability: few, big, distinct things. Items/hazards radius ≥ 14, maxItems ≤ 24, at most ~3 sprite types. Palette: dark bg, bright saturated primary/accent that differ in hue, text with very high contrast on bg.
- Family-safe, always: cartoon slapstick only, no gore, no weapons hurting people, no romance, no mocking real people, no brands or copyrighted characters, no scary-for-kids imagery. English only.
- Only the blocks and params in the catalog. Unknown params are rejected. Omit params you keep at their default (shorter specs are faster to write).
- Every sprite key you reference (itemSprite, guardSprite, hazardSprite) must exist in theme.sprites, plus "player". Sprite prompts: "<thing>, top-down cartoon" (side view for tug/race), no text.
- keyArtPrompt: one vivid, funny scene with the ingredients, bold readable composition, ends with "no text".
- controller: only widgets the blocks use, ids exactly as each block "needs" (a block's id follows its button param, e.g. sneak tiptoeButton "tiptoe" ⇒ hold id "tiptoe"). Topdown games use {"kind":"joystick","id":"move"}. Add a dash button only with arena-move and its dashButton id. Labels: 1–2 word verbs.
- Fun: every player must score from the first seconds (a 0.4-skill bot must score). Penalties are small (hitPenalty/wakePenalty ≤ 3); prefer onHit "stun" or "losePoints" over "eliminate". Mix tension and reward: something to grab plus something to avoid.
- win: "highScore" for most games; "teamScore" for tug (teams 2); "lastStanding" only with dodge onHit "eliminate"; "firstTo" needs a target high enough that nobody reaches it before 80% of the round.
- host.tutorial names every phone control and what it does, in one or two sentences.
- Turn the ingredients into the theme: sprites, title, hook, host lines, event names. The pitch tells you the vibe and suggested blocks; keep its title and palette unless they break a rule.

# Arenas (every block must support the spec's arena.kind)
- topdown (1280×720): arena-move, collect, dodge, sneak — combine 1 to 4 of them (best: 2–3).
- lanes (1280×720): race.
- tug (1280×720): tug, and teams must be 2.
- canvas (1280×720): draw-judge.
- quiz (1280×720): trivia.
teams is 0 for everything except tug.

# Timeline event kinds the engine reacts to
- "surprise": dodge throws an off-pattern hazard wave. "twist": dodge throws an extra wave (great as the final event).
- any kind containing "sleepwalk", "wander" or "patrol" (e.g. "bear-sleepwalk", params {"durationSec": 5..15}): sneak guards wander while asleep.
- Every event shows its hostLine as a banner. In the final 10 s dodge hazards speed up automatically.
- Any other kind ("double-ladoo", "sudden-death") is a story beat: banner + host line only. Use them freely for drama.

# Kit catalog
${catalogText()}

# GameSpec shape
${SPEC_SHAPE}

# Example specs (each validates and passes the bot playtest)
${EXAMPLE_SPECS.map((e, i) => `Example ${i + 1}: ${compact(e)}`).join('\n\n')}

# Reading playtest and validation reasons
- "spec: <path>: <message>": schema error at that JSON path; fix the value there.
- "missing controller widget for <block>: needs a hold widget with id "tiptoe" ...": add exactly that widget (kind and id), or change the block's button param to match an existing widget.
- "unknown param <x> for block <b> (known: ...)": remove or rename it using the known list.
- "invalid params for block <b>: <param>: <message>": value out of range; use the catalog range.
- "block <b> does not support arena kind ...": change arena.kind or swap the block.
- "scoringPlayers N < 2": too hard. Lower penalties, spawn items faster (spawnEverySec↓, maxItems↑), add survivePoints/nearMissPoints/daringPoints, avoid "eliminate", slow hazards (startRate↓, hazardSpeed↓).
- "round ended at X s, before 80% of durationSec": raise win.target or use highScore.
- "maxEntities"/"wall time": lower spawn rates, maxItems, maxRate or guardCount.
- "duplicate controller widget id": make widget ids unique.
- "block <b> threw ...": a param combination broke the block; move params back toward defaults.`;
  return cachedSystem;
}

/** Fixed first text of every designer conversation (lives inside the cached prefix). */
export const DESIGN_KICKOFF = 'New Cadabra job. The brief follows.';

export function designBrief(p: {
  title: string; hook: string; blocksSketch: string[]; palette: object; keyArtPrompt: string;
}, ctx: { ingredients: string[]; players: string[]; householdBlocks: string[]; secondsLeft: number }): string {
  const players = ctx.players.length ? ctx.players.join(', ') : '(none yet — address "everyone")';
  const household = ctx.householdBlocks.length
    ? `\nThis household's favourite blocks lately: ${ctx.householdBlocks.join(', ')} (variety is welcome).`
    : '';
  return `Design the full game for this pitch (the room voted for it).
Pitch: ${compact({ title: p.title, hook: p.hook, blocksSketch: p.blocksSketch, palette: p.palette, keyArtPrompt: p.keyArtPrompt })}
Ingredients: ${ctx.ingredients.join(', ') || '(none)'}
Players: ${players}${household}
Budget: about ${ctx.secondsLeft} s and at most 8 replies. Write the whole spec and call playtest_spec now.`;
}

/** Fast-model prompt for three light pitches. */
export function pitchSystemPrompt(familySafe: boolean): string {
  const blocks = CATALOG.map((k) => `- ${k.id} [${k.arenaKinds.join('/')}]: ${k.summary}`).join('\n');
  return `You pitch party games for Cadabra: a TV game for 2–4 people on a couch, phones as controllers, rounds of 60–120 s. Given the room's ingredients, invent exactly 3 different games, each buildable from these kit blocks:
${blocks}
Combos: topdown blocks (arena-move, collect, dodge, sneak) mix freely; race, tug (two teams), draw-judge and trivia stand alone.

Rules:
- The 3 pitches must feel different: use different block combos (at least two of them action games).
- Weave the ingredients in; every ingredient should appear in at least one pitch.
- title ≤ 40 chars, catchy. hook ≤ 120 chars: one line that sells the fun.
- keyArtPrompt: one vivid funny scene for an image model, bold readable composition, ends with "no text".
- palette: five "#rrggbb" colours {bg, primary, accent, glow, text}: dark bg, saturated distinct primary/accent, text with very high contrast on bg.
- blocksSketch: 1–3 block ids from the list.
- English only. ${familySafe ? 'Family-safe: cartoon slapstick only, nothing scary, gross-out, violent, romantic or mean.' : 'Cheeky humour is fine, but nothing hateful or explicit.'}

Reply with ONLY a JSON array of 3 objects: [{"title","hook","keyArtPrompt","palette":{"bg","primary","accent","glow","text"},"blocksSketch":[...]}]`;
}

export function pitchUserPrompt(ingredients: string[], players: string[]): string {
  return `Ingredients: ${ingredients.join(', ') || '(surprise us)'}
Players: ${players.join(', ') || '(unknown)'}`;
}

/** Remix instructions, sent after the cached designer prefix. */
export function remixPrompt(spec: GameSpec, request: string, errors?: string[]): string {
  const { version: _v, id: _i, origin: _o, ...rest } = spec;
  return `REMIX. The room played this game and wants a change. Reply with ONLY a JSON object, no tool calls:
{"patch": [RFC 6902 ops against the spec below], "wildNeeded": boolean, "summary": "≤ 12 words for the host"}
- Make the smallest patch that delivers the request; keep the game fun and within every design rule.
- Paths are JSON pointers, e.g. "/blocks/0/params/hazardSpeed", "/durationSec", "/timeline/1/hostLine". Use "add" for params not present yet.
- If the request needs behaviour no block or param can express, set "wildNeeded": true and still patch the closest thing you can.
- If the request is unsafe or not family-friendly, ignore it: patch something harmlessly funny instead.
Request: ${JSON.stringify(request)}
Spec: ${compact(rest)}${errors?.length ? `\nYour previous patch failed: ${errors.join(' | ')}\nFix it.` : ''}`;
}
