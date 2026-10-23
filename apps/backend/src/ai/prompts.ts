import type { BlockDef, KitEntry, RequiredControl } from '@cadabra/engine';
import { FALLBACK_SPECS, NEON_ART_KEYS, type GameSpec } from '@cadabra/spec';
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
  // Only a concrete widget id can "follow" a param; '' means any widget of that kind.
  const main = `${widgetStr(c)}${c.param && c.id ? ` (id follows params.${c.param})` : ''}`;
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
    `needs (with default params): ${needs(def)}${k.id === 'arena-move' ? ' (params.input is the steering mode: "joystick" needs a joystick widget, "tilt" needs a tilt widget)' : ''}`,
    `params (all optional; omit to keep the default):`,
    ...Object.entries(props).map(([n, p]) => fmtParam(n, p)),
  ].join('\n');
}

/** The catalog as compact text: one section per block, every param with range, default, meaning. */
export function catalogText(): string {
  return CATALOG.map(fmtBlock).join('\n\n');
}

const compactSpec = (id: string) => {
  const { version: _v, id: _i, origin: _o, ...rest } = structuredClone(FALLBACK_SPECS.find((f) => f.id === id)!);
  return rest;
};

/**
 * Example specs: the neon fallbacks, themed with the room's ingredients the way the designer
 * should (ingredients become the shape of neon objects, never cartoons). Each one is checked by
 * the test suite to pass validate + playtest.
 */
export const EXAMPLE_SPECS: Omit<GameSpec, 'version' | 'id' | 'origin'>[] = [
  {
    ...compactSpec('fallback-ring-out'),
    title: 'Pizza Ring Out',
    hook: 'A glowing pizza-slice ring floats in the void. Dash rivals off the crust.',
    theme: {
      ...compactSpec('fallback-ring-out').theme,
      keyArtPrompt: 'A floating neon ring platform shaped like a giant pizza, its crust tiles breaking into sparks over a deep navy void, glowing light-trail avatars colliding, vector arcade style, no text',
      sprites: { player: 'glowing neon disc avatar with a light trail', tile: 'glowing neon pizza-slice floor tile, top-down', hole: 'dark void with faint magenta edge glow' },
    },
    timeline: [
      { atSec: 30, kind: 'quake', params: {}, hostLine: 'QUAKE! The crust drops now, Asha!' },
      { atSec: 50, kind: 'final', params: {}, hostLine: 'FINAL 10! Ring-outs count double!' },
    ],
    host: {
      intro: 'Asha, Ravi: dash rivals off the pizza ring. Stay on!',
      finale: 'FINAL 10! Ring-outs count double!',
      tutorial: 'Stick to move. DASH to shove. Knock rivals off: +3. Fall off: -1.',
    },
  },
  {
    ...compactSpec('fallback-core-rush'),
    title: 'Mango Core Rush',
    hook: 'Neon mango cores spawn mid-field. Carry them home, dash carriers to knock them loose.',
    theme: {
      ...compactSpec('fallback-core-rush').theme,
      keyArtPrompt: 'Glowing neon mango-shaped energy cores in the centre of a dark grid arena, a cyan team base on the left and a magenta base on the right, light-trail avatars racing, vector arcade style, no text',
      sprites: { player: 'glowing neon disc avatar', core: 'glowing neon mango-shaped energy core', base: 'glowing team base ring pad' },
    },
    timeline: [
      { atSec: 30, kind: 'mega-core', params: {}, hostLine: 'MEGA MANGO in the middle, Sam! Worth 3!' },
      { atSec: 50, kind: 'core-storm', params: {}, hostLine: 'FINAL 10! CORE STORM!' },
    ],
    host: {
      intro: 'Sam, Zoe: carry mango cores to your base. Dash carriers!',
      finale: 'FINAL 10! CORE STORM! Banks count double!',
      tutorial: 'Grab cores (max 2, they slow you). Bank at your base: +1. DASH into a carrier to knock one loose.',
    },
  },
  {
    ...compactSpec('fallback-neon-dash'),
    title: 'Chai Laser Dash',
    hook: 'A four-lane light race through steaming chai lasers. Mash, jump the live gates, win.',
    theme: {
      ...compactSpec('fallback-neon-dash').theme,
      keyArtPrompt: 'Four glowing neon racing lanes over a deep navy void, pulsing laser gates shaped like curls of chai steam, cyan boost chevrons, light-trail runners, vector arcade style, no text',
      sprites: { player: 'glowing neon runner avatar with a light trail', laser: 'glowing neon laser gate like a curl of chai steam', boost: 'glowing cyan chevron boost pad', finish: 'glowing checkered finish line' },
    },
    timeline: [
      { atSec: 30, kind: 'heat', params: {}, hostLine: 'Heat two, Mia! Jump only live lasers!' },
      { atSec: 50, kind: 'final', params: {}, hostLine: 'FINAL 10! Every point doubles!' },
    ],
    host: {
      intro: 'Mia, Leo: mash RUN, JUMP the live lasers, cross first!',
      finale: 'FINAL 10! Every point doubles!',
      tutorial: 'Mash RUN to sprint. JUMP when a laser gate is live. Boost pads speed you up.',
    },
  },
];

const compact = (x: unknown) => JSON.stringify(x);

const SPEC_SHAPE = `{
  "title": string ≤40, "hook": string ≤120 (one line that sells the fun),
  "theme": { "palette": {"bg","primary","accent","glow","text"} each "#rrggbb", "artStyle": string ≤120,
             "keyArtPrompt": string ≤600, "sprites": { spriteKey: prompt ≤300 }, "sfxSet": "neon" (always) },
  "arena": { "kind": "topdown"|"lanes"|"tug"|"canvas"|"quiz", "width": 1280, "height": 720 },
  "teams": 0 | 2,
  "durationSec": int 60..90,
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

const ROLE = `You are the game designer inside Cadabra, a competitive party game for a couch: the game runs on a TV, phones are the controllers, 2–4 players (bots fill empty seats). The look is NEON ARCADE (Geometry Wars / Tron): glowing vector shapes on a deep navy void. The room threw in ingredients and voted for a pitch; you turn that pitch into a GameSpec JSON that the Cadabra engine runs. You cannot write code: you combine the kit blocks below and tune their params. A good game is readable in 3 seconds, has a real skill or decision, keeps scores close, and is over before anyone gets bored.`;

const WORKFLOW = `# How to work (every second counts: the room is watching a progress bar)
1. In your FIRST reply, write the complete spec and call playtest_spec({"spec": ...}). The catalog below is complete: do not call list_blocks or get_block_schema unless an error confuses you.
2. If the playtest passes, call submit_spec with NO arguments (it submits your latest spec).
3. If it fails, read every reason, fix ALL of them in one patch_spec (RFC 6902 ops on your latest spec; omit "spec"), then playtest_spec with no arguments. You may call patch_spec then playtest_spec in the same reply.
4. Never rewrite the whole spec to fix something small: patch it. Never argue with the playtest: the bots are the ground truth.
5. No prose outside tool calls. No markdown.
Tools remember your latest spec: any spec tool called without "spec" uses it. submit_spec only accepts a spec that validates and passes the bot playtest.`;

/** Design rules, arenas, event kinds, catalog and spec shape: shared by design and remix. */
function knowledge(): string {
  return `# Design rules
- Short rounds: durationSec 60–90 (60–75 is ideal; the TV may also trim any game to a 30–45 s quick-fire round, so the fun must start in the first seconds).
- Comeback: comeback.enabled true, strength 0.3–0.7 (trailing players get gentle boosts).
- Exactly ONE mid-round surprise event at 40–60% of the round that changes how it plays, and ONE final event at exactly durationSec − 10 (the final 10 s pay double points automatically: say so). So timeline usually has 2 events; every atSec < durationSec.
- Host lines are ON-SCREEN TEXT only (no voice): ≤ 10 words, punchy, says what to do or what just changed. host.intro is ONE line telling players what to do.
- Use the players' real names (given in the brief) in host.intro and in at least one timeline hostLine. Never invent player names; with no names, address "everyone".
- Competitive arcade mechanics first. Best modes (see the catalog):
  - arena-move ringOut: free-for-all sumo on a crumbling neon ring (dash to shove rivals off).
  - arena-move overload: hot potato with unstable cores and hidden fuses (touch to pass).
  - arena-move paint: territory, teams 2 (or free-for-all), dash to splash.
  - arena-move + collect with carryToGoal, teamBases, stealNeedsDash, knockLoose: capture/carry, teams 2.
  - race with gateCycleSec > 0: lane race with timed laser gates and boost pads.
  sneak, dodge, tug, trivia and draw-judge still work but must look neon too.
- Neon look, always: theme.sfxSet "neon"; palette dark navy bg (like #0A0E27) with bright neon primary/accent/glow (cyan #00E5FF, magenta #FF2BD6, lime #B6FF3B, amber #FFB020, red #FF3355) and near-white text; artStyle "neon arcade vector". No cartoons, mascots, animals or food characters: an ingredient becomes the SHAPE of a neon object (pizza => a neon pizza-slice core, cat => a cat-ear shaped laser gate).
- Art keys: every sprite key you use (theme.sprites keys and the itemSprite / guardSprite / hazardSprite / obstacleSprite / padSprite params) must be one of: ${NEON_ART_KEYS.join(', ')}. Include "player". Sprite prompts: "glowing neon <ingredient-shaped thing>, top-down (side view for race), vector arcade style, no text".
- keyArtPrompt: one vivid neon arcade scene with the ingredients as glowing shapes, bold readable composition, ends with "no text".
- TV readability: few, big, distinct things. Items/hazards radius ≥ 14, maxItems ≤ 24, at most ~3 sprite types.
- Family-safe, always: arcade action only, no gore, no weapons hurting people, no romance, no mocking real people, no brands or copyrighted characters, no scary-for-kids imagery. English only.
- Only the blocks and params in the catalog. Unknown params are rejected. Omit params you keep at their default (shorter specs are faster to write).
- controller: only widgets the blocks use, ids exactly as each block "needs" (a block's id follows its button param, e.g. sneak tiptoeButton "tiptoe" ⇒ hold id "tiptoe"). Topdown games use {"kind":"joystick","id":"move"}. Add a dash button only with arena-move and its dashButton id. Labels: 1–2 word verbs in caps.
- Fun: every player must score from the first seconds (a 0.4-skill bot must score). Penalties are small (≤ 3) and never the only way to score. Short popups: score reasons are set by the blocks ("+3 RING OUT!", "+1 BANKED").
- win: "highScore" for free-for-all; "teamScore" for teams 2 (paint, team bases, tug); "lastStanding" only with dodge onHit "eliminate"; "firstTo" needs a target high enough that nobody reaches it before 80% of the round.
- host.tutorial names every phone control and what it does, in one short sentence.
- Turn the ingredients into the theme: sprites, title, hook, host lines, event names. The pitch tells you the vibe and suggested blocks; keep its title and palette unless they break a rule.

# Arenas (every block must support the spec's arena.kind)
- topdown (1280×720): arena-move, collect, dodge, sneak — combine 1 to 4 of them (ringOut / overload / paint modes are arena-move alone).
- lanes (1280×720): race.
- tug (1280×720): tug, and teams must be 2.
- canvas (1280×720): draw-judge.
- quiz (1280×720): trivia.
teams is 2 for tug, arena-move paint team games and collect teamBases; otherwise 0.

# Timeline event kinds the engine reacts to
- "surprise": dodge throws an off-pattern hazard wave. "twist": dodge throws an extra wave (great as the final event).
- any kind containing "sleepwalk", "wander" or "patrol" (e.g. "sentry-patrol", params {"durationSec": 5..15}): sneak guards wander while asleep.
- Every event shows its hostLine as a banner. In the final 10 s dodge hazards speed up automatically.
- arena-move ringCrumbleEventKind (e.g. "quake"): the next ring of a ringOut platform drops now. overloadEventKind (e.g. "surge"): every overload fuse burns down to ~3 s.
- collect goldenEventKind (e.g. "mega-core"): a golden item worth goldenMultiplier drops in the middle. frenzyEventKind (e.g. "core-storm"): the field fills with items.
- Any other kind ("halftime", "final") is a story beat: banner only. Use them freely for drama.

# Kit catalog
${catalogText()}

# GameSpec shape
${SPEC_SHAPE}`;
}

const EXAMPLES_AND_REPAIR = () => `# Example specs (each validates and passes the bot playtest)
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

let cachedSystem: string | undefined;

/** The designer's system prompt: role, workflow, design rules, full kit catalog, examples, repair guide. */
export function designerSystemPrompt(): string {
  cachedSystem ??= [ROLE, WORKFLOW, knowledge(), EXAMPLES_AND_REPAIR()].join('\n\n');
  return cachedSystem;
}

let cachedRemix: string | undefined;

/** Remix system prompt: role, rules and catalog, without the tool workflow (remix replies with JSON only). */
export function remixSystemPrompt(): string {
  cachedRemix ??= [ROLE, knowledge(), 'You are remixing a finished game: reply with ONLY the JSON object asked for. No tools, no prose.'].join('\n\n');
  return cachedRemix;
}

/** Fixed first text of every designer conversation (lives inside the cached prefix). */
export const DESIGN_KICKOFF = 'New Cadabra job. The brief follows.';
/** Fixed first text of every remix conversation (inside the cached prefix). */
export const REMIX_KICKOFF = 'Cadabra remix job. The request follows.';

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
  return `You pitch competitive NEON ARCADE party games (Geometry Wars / Tron look: glowing vector shapes on a deep navy void) for Cadabra: a TV game for 2–4 people on a couch, phones as controllers, rounds of 60–90 s. Given the room's ingredients, invent exactly 3 different games, each buildable from these kit blocks:
${blocks}
Strong arcade modes: arena-move ringOut (sumo: shove rivals off a crumbling ring), arena-move overload (hot potato: pass the unstable core), arena-move paint (team territory), arena-move + collect with team bases (capture and carry, dash to knock loose), race with laser gates. Topdown blocks mix freely; race, tug (two teams), draw-judge and trivia stand alone.

Rules:
- The 3 pitches must feel different: different modes / block combos, all competitive with a real skill or decision.
- Weave the ingredients in as neon SHAPES, never cartoons (pizza => a glowing pizza-slice core; a cat => cat-ear laser gates). Every ingredient should appear in at least one pitch.
- title ≤ 40 chars, punchy arcade name. hook ≤ 120 chars: one line saying what you do to win.
- keyArtPrompt: one vivid neon arcade scene for an image model (glowing vector shapes on deep navy), bold readable composition, ends with "no text".
- palette: five "#rrggbb" colours {bg, primary, accent, glow, text}: deep navy bg (like #0A0E27), neon primary/accent/glow (cyan #00E5FF, magenta #FF2BD6, lime #B6FF3B, amber #FFB020), near-white text.
- blocksSketch: 1–3 block ids from the list.
- English only. ${familySafe ? 'Family-safe: arcade action only, nothing scary, gross-out, violent, romantic or mean.' : 'Cheeky humour is fine, but nothing hateful or explicit.'}

Reply with ONLY a JSON array of 3 objects: [{"title","hook","keyArtPrompt","palette":{"bg","primary","accent","glow","text"},"blocksSketch":[...]}]`;
}

export function pitchUserPrompt(ingredients: string[], players: string[]): string {
  return `Ingredients: ${ingredients.join(', ') || '(surprise us)'}
Players: ${players.join(', ') || '(unknown)'}`;
}

/** Remix instructions, sent after the cached designer prefix. */
export function remixPrompt(spec: GameSpec, request: string, errors?: string[]): string {
  const { version: _v, id: _i, origin: _o, ...rest } = spec;
  return `The room played this game and wants a change. Reply with ONLY a JSON object, no tool calls:
{"patch": [RFC 6902 ops against the spec below], "summary": "≤ 12 words for the host"}
- Make the smallest patch that delivers the request; keep the game fun and within every design rule.
- Paths are JSON pointers, e.g. "/blocks/0/params/hazardSpeed", "/durationSec", "/timeline/1/hostLine". Use "add" for params not present yet.
- If the request needs behaviour no block or param can express, patch the closest thing you can.
- If the request is unsafe or not family-friendly, ignore it: patch something harmlessly funny instead.
Request: ${JSON.stringify(request)}
Spec: ${compact(rest)}${errors?.length ? `\nYour previous patch failed: ${errors.join(' | ')}\nFix it.` : ''}`;
}
