# Engine GameEvents and entity props (renderer / TV contract)

`GameRuntime.events` is an append-only log of `{ t, type, player?, data? }` (`t` = sim seconds).
The TV reads new events each frame. Events marked **headline** are big moments worth a callout
(banner, sfx, camera). Everything else is bookkeeping (the host roast and results also read it).

## Headline events: namespaces and `data.moment`

Blocks emit headline moments as `<ns>.<moment>`. `ns` is the block's `callout` param:
- the neon fallbacks use `ring` (RING OUT), `overload` (OVERLOAD), `paint` (PAINT WARS) and `rush` (CORE RUSH); NEON DASH (race) emits plain `race.*` events;
- AI-made games default to `play`;
- `callout: ''` turns them off.

Every headline event also carries `data.moment`. **Match on `data.moment`, not on the full type**,
so the callouts work for any game.

Popups: score `reason`s are short neon caps strings ("RING OUT!", "OVERLOAD!", "BANKED", …); the
renderer shows them as "+3 RING OUT!".

## Runtime (all games)

| type | player | data | when |
|---|---|---|---|
| `start` | – | – | first step |
| `score` | scorer | `{ delta, reason, base?, mult? }` | Every score change. `reason` is a short popup label ("Banked!", "Fish", "Woke the bear!"). In the final 10 s, positive deltas are multiplied: `delta` is the applied value, and `base`/`mult` are present. |
| `finale` | – | – | `remaining <= 10` (legacy) |
| **`final.start`** | – | `{ multiplier: 2, remainingSec: 10 }` | Same step as `finale`: show "FINAL 10 — DOUBLE POINTS!". |
| **`lead.change`** | new leader (team games: first member of that team) | `{ prev: playerId \| team \| null, score, team? }` | A new unique leader (ties don't count). Throttled to at most 1 per 6 s (`LEAD_THROTTLE_SEC`). The first leader of the round is announced too (`prev: null`). |
| `comeback` | – | `{ players, boost }` | every 5 s |
| `timeline` | – | `{ kind, atSec }` | A scripted spec event fired (its hostLine is in the banner). |
| `over` | – | – | the round ended |

`GameRuntime.leadChanges` is the unthrottled count (balance metric).
`GameRuntime.scoreMultiplier` is the current multiplier (2 in the finale).

## RING OUT: block `arena-move` (`ringOut`), ns `ring`

| type | player | data | meaning |
|---|---|---|---|
| **`ring.ringout`** | pusher | `{ victim, moment:'ringout' }` | A rival fell off within `ringCreditSec` (2 s) of your last push: +3 "RING OUT!". |
| **`ring.crumble`** | – | `{ ring, phase:'warn'\|'fall', warnSec?, moment:'crumble' }` | The outer ring of tiles shakes for 1.5 s (`warn`), then drops (`fall`). Ring 0 is the edge. Rings drop evenly from 30% of the round to 6 s before the end. Everyone still standing gets +1 "SURVIVED" (`ringSurvivePoints`). |
| `arena.fall` | faller | `{ by: playerId \| null }` | Fell off: −1 "FELL!" (never below 0). `props.out` = true until respawn. |
| `arena.respawn` | player | – | Back in the centre after 1.5 s, invulnerable (no fall, no bumps) for 1 s: blink on `invulnUntil`. |
| `arena.shove` | shover | `{ victim }` | A dash bump. |

## OVERLOAD: block `arena-move` (`overload`), ns `overload`

| type | player | data | meaning |
|---|---|---|---|
| `overload.core.spawn` | holder | `{ moment:'core.spawn' }` | A new core lands on a random player. Fuse is hidden (7–13 s). |
| **`overload.core.pass`** | passer | `{ to, clutch, moment:'core.pass' }` | Touch passed it. The passer can't get it back for 0.8 s. `clutch`: passed while critical (+1 "CLUTCH PASS!"). |
| **`overload.core.critical`** | holder | `{ fuseLeft, moment:'core.critical' }` | 3 s left: pulse hard. |
| **`overload.overload`** | holder (victim) | `{ penalty, reward, passer, moment:'overload' }` | Detonation: holder −3 "OVERLOAD!" (never below 0) and stunned 1 s; everyone else +1 "SURVIVED", whoever handed it over +1 more "HANDOFF!"; bystanders within 160 px are blasted back. A new core follows after 1.5 s. |
| `arena.core` / `arena.pass` / `arena.detonate` | … | … | bookkeeping twins |

Score reasons also: "CLEAN" (+1 every 5 s to everyone not holding a core, `overloadSafePoints`).
With 4 players the fallback runs 2 cores at once (one per two players).

## PAINT WARS: block `arena-move` (`paint`), ns `paint`

| type | player | data | meaning |
|---|---|---|---|
| **`paint.tally`** | – | `{ shares: { [paintKey]: 0..1 }, final:false, moment:'tally' }` | Every 5 s: each player scores `paintPoints` × (tiles they painted / all tiles) "TERRITORY". `paintKey` = team (team games) or join slot (FFA). |
| **`paint.tally.final`** | – | `{ shares, final:true, moment:'tally.final' }` | At the buzzer: the final tally pays ×2 "FINAL TALLY" (and the final-10 multiplier on top). |
| `arena.dash` | dasher | – | A dash paints a 3×3 burst (5×5 for the side behind on score: `paintUnderdog`). |
| `arena.shove` | shover | `{ victim }` | Dash into an enemy: stunned 0.6 s (can't paint). Teammates are never stunned. |

Odd team sizes (2v1) auto-balance: the smaller team's tiles score `big/small` times more.

## CORE RUSH: blocks `arena-move` + `collect` (`teamBases`, `stealNeedsDash`, `knockLoose`), ns `rush`

| type | player | data | meaning |
|---|---|---|---|
| **`rush.bank`** | banker | `{ count, points, golden, moment:'bank' }` | Cores banked at your team's base: +1 each "BANKED". |
| **`rush.steal`** | dasher | `{ from, item, golden, loose:true, moment:'steal' }` | A DASH into an enemy carrier knocks one core loose (it skids 50–110 px away; anyone can grab it). Plain bumps and teammates do nothing. |
| **`rush.golden`** | grabber/banker (spawn: none) | `{ phase:'spawn'\|'grab'\|'bank', moment:'golden' }` | 30 s: the MEGA CORE (worth 3) drops in the middle. |
| `collect.*` | … | … | bookkeeping |

Carry max 2; each carried core costs 15% speed (`loadMul`). 50 s "core-storm" fills the field.

## NEON DASH: block `race` (`gateCycleSec`), no ns

| type | player | data | meaning |
|---|---|---|---|
| `race.stumble` | runner | `{ gate: true }` | Ran into a LIVE laser gate (not jumping): stopped for `stumbleSec`. Gates that are off can be run through. |
| `race.lapLead` / `race.finish` / `race.heat` / `race.batonPass` | … | … | as before; heats repeat until time runs out |

Score reasons are the `race.*` codes (the renderer translates them).

## Legacy blocks (AI games can still use them)

The `sneak` (guards, `heist`-style chase), `dodge` (hazards, near misses, `penguin`-style
crumble/knockout) and `tug` (rhythm tug of war) blocks are unchanged; their events are:
`<ns>.chase.start`, `<ns>.caught`, `<ns>.knockout`, `<ns>.crumble`, `<ns>.surge`, `<ns>.splash`,
`<ns>.swing`, plus `sneak.*`, `dodge.*`, `tug.*` bookkeeping (see git history for the full tables).

## Timeline hooks (opt-in params, exact kind match)

- arena-move: `ringCrumbleEventKind` (RING OUT 'quake': drop the next ring now), `overloadEventKind` (OVERLOAD 'surge': every fuse burns down to ~3.5 s).
- collect: `goldenEventKind` (CORE RUSH 'mega-core') and `frenzyEventKind` ('core-storm').
- tug: `swingEventKind`. dodge: the `surprise` and `twist` kinds.

## Tug timing

- Taps are judged on the beat as it was when they were *sent*: tug learns each phone's fastest arrival lag (a floor-biased EWMA of arrival sim ms − frame `t`) and moves a late tap back by up to 150 ms.
- This only happens once the phone's `t` has advanced at about real-time rate over 0.5 s; bots and tests that send step counts get no compensation.
- The runtime latches presses: a down+up that both arrive between two steps still reaches blocks as one step of "down", stamped with the press time.

## Entity props for renderers

| entity (kind) | prop | meaning |
|---|---|---|
| `player` | `carry` | items carried (collect carry mode) |
| `player` | `loud` | 0..1 how loud right now (sneak): draw noise rings |
| `player` | `tiptoe` | tiptoe held |
| `player` | `loadMul` / `noiseMul` | speed / noise factors from the load |
| `player` | `stunUntil` | sim s; tumbling (caught, robbed, shoved) |
| `player` | `invulnUntil` | sim s; blink (after a hazard hit, or after a ring-out respawn) |
| `player` | `out` / `outAt` | RING OUT: fell off (draw falling / hidden) until respawn |
| `player` | `touchedBy` / `touchedAt` | last player who pushed this one (ring-out credit) |
| `player` | `dashing` / `dashReady` | arena-move dash state |
| `player` | `shovedBy` / `shovedAt` | last dash shove |
| `base` (owner = player) | `home: true`, `slot` | the player's base; colour it with the owner's colour; `r` = bank radius |
| `base` (team base) | `teamBase: true`, `slot` = team; entity `team` | CORE RUSH: tint by team colour |
| `item` (sprite `core`) | `golden`, `carriedBy` | CORE RUSH cores; golden = MEGA CORE |
| `core` (sprite `core-unstable`) | `holder`, `fuse` 0..1, `fuseLeft` s, `pulseHz`, `critical` | OVERLOAD core; it follows its holder |
| `tile` (PAINT) | `col`, `row`, `hw`, `hh`, `paint` (-1 blank, else team / FFA slot), `paintedBy`, `paintTeam`; entity `team` | painted tint = team colour (FFA: `paintedBy`'s colour) |
| `tile` (RING OUT) | `ring`, `col`, `row`, `hw`, `hh`, `crumbling`, `fallAt` | square tiles forming a disc; ring 0 = edge |
| `obstacle` (sprite `laser`) | `gate`, `armed`, `phase`, `lane`, `at` | NEON DASH laser gate: draw the beam only while `armed` |
| `boost-pad` (sprite `boost`) | `lane`, `at` | |
| `finish` | `hw`, `hh` | NEON DASH finish line spanning all lanes |
| `item` | `golden`, `carriedBy` | loot; carried items trail their carrier |
| `guard` | `phase` | `'calm' \| 'waking' \| 'awake' \| 'return'` |
| `guard` | `noise` | 0..1 wake meter |
| `guard` | `stirring` | the meter is above 70% (telegraph) |
| `guard` | `chaseTarget` | player id being chased (during waking/awake), else '' |
| `guard` | `chasing` / `returning` | running at the target / plodding home |
| `guard` | `facing`, `visionOn`, `visionConeDeg`, `visionRange`, `hearingRadius` | |
| `tile` | `hw`, `hh` | half width/height (tiles are rectangles; `r` is only for the spatial grid) |
| `tile` | `ring`, `col`, `row` | ring 0 = the outer edge |
| `tile` | `crumbling`, `fallAt` | shaking; drops at sim time `fallAt` (then removed) |
| `hazard` | `armed`, `warnMs`, `armAt`, `ax`/`ay`, `pattern`, `group` | telegraph, then live (a sweep wall = one `group`) |
| `rope` | `pos` | knot −1..1 (team 0's line .. team 1's line) |
| `rope` | `beat` | 0..1 phase within the current beat (0 = on the beat) |
| `rope` | `beatIndex`, `bpm`, `onBeat` | beat count, current tempo, inside the hit window now |
| `rope` | `combo0` / `combo1` | each team's on-beat streak (a surge at `surgeCombo`) |
| `rope` | `surgeAt` / `surgeTeam` | last surge (sim s, team) |
| `rope` | `splashAt` / `splashTeam` | last splash (sim s, losing team) |
| `rope` | `suddenDeath`, `paused`, `bouts`, `lineLeft`, `lineRight`, `ropeLength` | |
