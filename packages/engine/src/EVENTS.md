# Engine GameEvents and entity props (renderer / TV contract)

`GameRuntime.events` is an append-only log of `{ t, type, player?, data? }` (`t` = sim seconds).
The TV reads new events each frame. Events marked **headline** are big moments worth a callout
(banner, sfx, camera). Everything else is bookkeeping (the host roast and results also read it).

## Headline events: namespaces and `data.moment`

Blocks emit headline moments as `<ns>.<moment>`. `ns` is the block's `callout` param:
- the fallbacks use `heist` (Ladoo Heist), `penguin` (Lava Floor Penguins) and `tug` (Bear Tug);
- AI-made games default to `play` (collect / sneak / dodge) or `tug`;
- `callout: ''` turns them off.

Every headline event also carries `data.moment`. **Match on `data.moment`, not on the full type**,
so the callouts work for any game.

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

## Ladoo Heist: blocks `sneak` + `collect`, ns `heist`

| type | player | data | meaning |
|---|---|---|---|
| **`heist.bank`** | banker | `{ count, points, golden, moment:'bank' }` | Loot dropped in your own basket. Combo: 1/3/6 points for 1/2/3 ladoos. |
| **`heist.steal`** | thief | `{ from, item, golden, moment:'steal' }` | A bump stole one ladoo. The victim tumbles (`stunUntil`). |
| **`heist.chase.start`** | target (loudest) | `{ guard, sec, moment:'chase.start' }` | The bear is up and running at the target for `sec` s. |
| **`heist.caught`** | caught player | `{ guard, dropped, moment:'caught' }` | The bear caught them: they drop all their loot and tumble for 1.2 s. |
| **`heist.golden`** | grabber / banker (spawn: none) | `{ phase:'spawn'\|'grab'\|'bank', item?, x?, y?, moment:'golden' }` | The golden ladoo (worth 5) appears at 45 s, then is grabbed and banked. |
| `sneak.stir` | – | `{ guard }` | The noise meter passed 70%: the bear stirs. |
| `sneak.waking` | culprit | `{ guard, guardKind, windupSec }` | 0.75 s wind-up telegraph before the chase. |
| `sneak.woke` | culprit | `{ guard, guardKind, count, penalty }` | Wake penalty: −2 "Woke the bear!". |
| `sneak.caught` | caught player | `{ guard, penalty, carry? }` | legacy twin of `heist.caught` |
| `sneak.sleep` | – | `{ guard }` | back home and asleep |
| `collect.picked` / `collect.banked` / `collect.stolen` / `collect.golden` / `collect.dropped` | … | … | legacy bookkeeping (host roast) |

Score reasons: "Banked!", "Woke the bear!" (`Woke the <guardSprite>!`), "Caught!" (stare guards only), "Stole!" / "Robbed!" (points mode), "Golden!", "Daring!".

## Lava Floor Penguins: blocks `arena-move` + `collect` + `dodge`, ns `penguin`

| type | player | data | meaning |
|---|---|---|---|
| **`penguin.knockout`** | shover | `{ victim, moment:'knockout' }` | Someone dash-shoved the victim into lava (or into a hole) within 1.5 s: +3 "Knockout!". |
| **`penguin.crumble`** | – | `{ ring, phase:'warn'\|'fall', warnSec?, moment:'crumble' }` | Final 10 s: an outer ring of ice tiles shakes (`warn`), then drops (`fall`). Ring 0 is the edge. |
| **`penguin.golden`** | grabber (spawn: none) | `{ phase:'spawn'\|'grab', moment:'golden' }` | The golden fish at 50 s (worth 3). |
| `arena.shove` | shover | `{ victim }` | A dash bump (victim flies and can't steer for 0.3 s) |
| `arena.dash` | dasher | – | |
| `dodge.hit` | victim | `{ hazard, pattern, onHit }` | Lava hit: −2 "Lava!", knockback, 1.5 s invulnerable. `hazard: -1` = fell in a hole. |
| `dodge.nearMiss` | player | `{ hazard }` | +1 "Close call!" |
| `dodge.knockout` | shover | `{ victim }` | legacy twin of `penguin.knockout` |

Score reasons: "Fish", "Golden!", "Lava!" (`<HazardSprite>!`), "Close call!", "Knockout!".

## Bear Tug: block `tug`, ns `tug`

| type | player | data | meaning |
|---|---|---|---|
| **`tug.surge`** | first member of the team | `{ team, moment:'surge' }` | Everyone on that team hit the beat 8 times in a row: a big yank. |
| **`tug.splash`** | first member of the losing team | `{ team: losers, winners, bout, moment:'splash' }` | The knot crossed a line: the losers fall in the mud pit. +3 "Splashed them!" to the winners. |
| **`tug.swing`** | first member of the team | `{ team, moment:'swing' }` | Timeline "bear-sneeze" (35 s): the knot lurches toward the team that is behind. |
| `tug.suddenDeath` | – | – | 55 s: the beat goes 1.4× faster and pulls count double |
| `tug.won` | – | `{ team, bout }` | legacy twin of `tug.splash` |
| `tug.lead` | – | `{ team, pos }` | +1 "Pull!" every 5 s for the team holding the knot on its side |

## Entity props for renderers

| entity (kind) | prop | meaning |
|---|---|---|
| `player` | `carry` | items carried (collect carry mode) |
| `player` | `loud` | 0..1 how loud right now (sneak): draw noise rings |
| `player` | `tiptoe` | tiptoe held |
| `player` | `loadMul` / `noiseMul` | speed / noise factors from the load |
| `player` | `stunUntil` | sim s; tumbling (caught, robbed, shoved) |
| `player` | `invulnUntil` | sim s; blink (after a lava hit) |
| `player` | `dashing` / `dashReady` | arena-move dash state |
| `player` | `shovedBy` / `shovedAt` | last dash shove |
| `base` (owner = player) | `home: true`, `slot` | the player's basket; colour it with the owner's colour; `r` = bank radius |
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
