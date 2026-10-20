# Cadabra: design

*Say it. Play it.*

A Fire TV party game in which the people in the room describe a game out loud and AI builds a real, playable multiplayer 2D game in seconds. Every player's phone is the controller.

- Author: Maanav Krishna (solo)
- Date: 2026-10-20
- Target: Amazon "Build, Ship, Shape" hackathon, Fire TV track (primary), plus the AWS Builder and Open Source mini challenges, plus the friction-log bonus.
- Deadline: **2026-10-24 00:30 IST** (2026-10-23 19:00 UTC). Submission includes the repo, a demo video under 3 minutes, a description, product feedback and a friction log.

Marking used in this document:
- **[user]**: Maanav decided it.
- **[call]**: the design author decided it. The user delegated these explicitly ("you choose everything").
- **[builder]**: left to the implementer.

---

## 1. Intent and why

**The problem.** Groups of friends and families already gather around the TV to play party games: Jackbox is on Fire TV and sells well. But that content is fixed, paid per pack, and gets old. Nothing makes a game about *this* group, their jokes or their language, on the spot.

**The idea.**
- Everyone throws ideas in from their phone ("penguins", "lava floor", "steal grandma's ladoo").
- AI pitches three games and the room votes.
- Within about 30 seconds a polished, playable game appears on the TV, with a phone controller generated just for it.
- After a round, players remix the game by voice or text ("make the bear sleepwalk") and it rebuilds in seconds.
- Good games and newly invented building blocks are saved to the family's Arcade.

**The name.** Cadabra was Amazon's original company name (Bezos chose it after "abracadabra" and switched to Amazon in 1995). One popular origin story for "abracadabra" is "I create as I speak", which is exactly the product. The video uses this as a 5-second hook. **[user]** chose the name.

**What success looks like [user].** Judges watching the video think "I'd play that tonight". Games never look broken, laggy or boring.

**Judging criteria this targets.**

| Criterion | How Cadabra addresses it |
|---|---|
| Tech | Real Fire TV app on a real stick, Bedrock-driven generation, a game engine, phone controllers |
| Design | A cinematic 10-foot UI driven by the remote's D-pad |
| Impact | Proven party-game demand; personalized content about the people in the room |
| Idea | Generating real games, not just quizzes |

## 2. Goals, non-goals, anti-goals

**Goals**
1. **The full loop works on the user's real Fire TV Stick:** join, Idea Storm, pitch and vote, Forge, play, results, remix, save.
2. **Every generated game is playable and fun** within the kit's expressive range.
3. **Fast input**: phone-to-TV input delay is low enough that action games feel responsive. Target under 50 ms on the same Wi-Fi.
4. **A cinematic, console-grade UI** (direction A, inspired by PS5) that a judge would mistake for a shipped product.
5. **One person can record the whole demo alone**, using bots and extra browser-tab controllers.
6. **Eligibility for the AWS Builder and Open Source mini challenges**, with documented integrations, plus a friction log kept during the build.

**Non-goals**
- **3D games [user]**: 2D only.
- **Vega OS**: the stick runs Fire OS. **[user]** confirmed this; the builder verifies it on the device.
- **Online play between different households**: everyone is in the same room. Share codes only share saved games.
- **Accounts or logins**: a household is identified by its TV device.
- **Monetization and app-store publishing**: nice to mention, not built.

**Anti-goals [user]**: the project fails, even if it technically works, if:
- **Games look broken**: errors, unwinnable rounds, overlapping garbage art.
- **Games feel laggy**: input delay, frame drops on the stick.
- **Games are boring**: flat, samey, no tension, no humor.

These three override feature count. Ship **8 blocks [user], each feeling great**: polish beats adding a 9th.

## 2a. Decisions added after review [user]

- **English only.** Players type or dictate ingredients and remixes in English; all generated games, UI text and host voice are English. No other-language support is built or advertised.
- **Highly customizable everything.**
  - Every block exposes a rich parameter schema covering rules, speeds, sizes, timings, spawn rates, scoring, teams, events, art style, palette and sound set.
  - Two ways to customize:
    - by voice or text remix through the AI;
    - by hand, in a **Tweak panel** on the host's phone. The panel shows sliders, toggles and pickers generated automatically from the block schemas, and the game updates live on the TV.
  - Room settings are customizable too: round length, number of rounds, bots, host personality, host voice on or off, and family-safe mode.
- **AI uses tool calling.**
  - The game designer is a Bedrock agent (Claude with tool use, through the Converse API) rather than a single prompt. It calls tools such as `list_blocks`, `get_block_schema`, `draft_spec`, `validate_spec`, `playtest_spec`, `patch_spec`, `generate_art`, `write_block` (wild mode) and `save_to_arcade`. It repairs its own mistakes from tool results.
  - The builder may use the Strands Agents SDK or Bedrock AgentCore if they fit the time budget, which also strengthens the AWS Builder entry.
  - Speed rule: tool loops must still meet the timing targets in §8. Run independent calls in parallel and cap the number of turns.
- **Never cut, updated.** Join, Idea Storm, pitches, Forge, play, results with the host, all 8 blocks, **selfie avatars**, **the Arcade and saving**.
- **Cut order if time runs short** (cut first at the top):
  1. share codes;
  2. wild mode;
  3. remix (the Tweak panel stays, since it is code only and needs no AI).

## 3. Constraints

- **Time**: about 3.3 days, solo plus an AI pair programmer. Must always have a demo-ready build by the end of each phase (§12).
- **Hardware**: Fire TV Stick HD (late-2025 model), Fire OS, an entry-level chip. Treat its GPU and CPU as weak.
- **Phones**: any modern iOS or Android browser. No app install.
- **AWS**:
  - The user's account; the CLI is set to `ap-south-1` (Mumbai), but the session expired, so `aws login` is needed.
  - The user has Bedrock access.
  - Model availability in ap-south-1 must be checked. Use cross-region inference profiles (for example `apac.*`) where needed.
- **Video rules**:
  - Under 3 minutes, public on YouTube or Vimeo, in English.
  - Must show it running on the Fire TV.
  - No third-party trademarks or copyrighted music or footage.
  - No people needed on camera **[user]**.
  - AI video tools (such as Higgsfield) may be used for the intro, b-roll and transitions, but **gameplay footage must be real capture from the stick** **[call]**, so it isn't misleading.
- **Git and authorship [user]**:
  - All commits use author `Maanav Krishna <67054795+MaanavKrishna@users.noreply.github.com>`.
  - **No Claude or AI co-author lines, no "generated with" footers, and no AI mentions in contributor metadata.**
  - Set this in the repo-local git config before the first commit.
- **Open source**:
  - The main repo is public under the MIT license.
  - The Open Source mini challenge needs an *additional* open-source project or a contribution to a public repo. See §10.
- **Developer machine**: macOS with Node 26 and JDK 25. No Android SDK or adb yet; install the Android command-line tools and JDK 17 (needed by the Android Gradle Plugin) **[builder]**.

## 4. Experience (the game-night loop)

Approved storyboard: `.superpowers/brainstorm/*/content/game-flow.html`.

1. **Join + avatar.**
   - The TV shows a QR code and a 4-letter room code. A phone scans it and opens the controller web page, with no install.
   - Enter a name, then either snap a selfie (AI turns it into a cartoon avatar) or pick a premade character.
   - Avatars appear on the TV and the host reacts by voice.
   - Selfies are deleted once the avatar is made **[call]**.
2. **Idea Storm (20 s).** Each phone adds ingredients (hero, place, twist) by text or voice, in English. Phone keyboard dictation counts as voice. The ingredients fly onto the TV.
3. **Pitch + vote.** The AI returns **3 game pitches**, each with a title, a one-line hook and key art. Phones vote. The losing pitches are saved to the Arcade as "unplayed".
4. **The Forge (target ≤ 30 s [user]).**
   - The TV shows the game being assembled: blocks "snapping in", art appearing, host commentary.
   - Phones play a tap warm-up whose result gives a small starting bonus.
   - Generation, validation and bot playtesting run during this time (§7).
5. **Tutorial (~8 s).** The host explains the rules in one or two sentences, and each phone shows that game's custom controller.
6. **Play (60–120 s).** Includes a mid-round surprise event and a dramatic final 10 seconds.
7. **Results + roast.** A podium of avatars. The host jokes about real events from the round, from the round's event log, such as "Dad woke the bear 4 times".
8. **Remix.**
   - Phones submit tweaks by text or voice and the room votes on the top request.
   - Parameter tweaks rebuild in about 5 seconds or less.
   - Requests the kit can't express trigger **wild mode** (§7.4).
9. **Arcade.**
   - A per-household shelf of saved games, browsed with the D-pad, plus kit blocks invented by this household.
   - Share codes (such as `HEIST-42`) let any Cadabra TV load a game.

**Host controls on the remote [call]:**
- D-pad and Select to navigate.
- Play/Pause pauses the game.
- Back steps back a screen.
- Settings: family-safe mode (on by default), bots on or off, host voice on or off.
- "Fill with bots" button: adds AI players up to 4, for small groups and solo demos.

**Players**: 2–8, plus bots. Rounds last 60–120 seconds.

## 5. Visual design

Direction **A, Cinematic (inspired by PS5)**, chosen by **[user]**. Mockup: `.superpowers/brainstorm/*/content/visual-style.html`.

- **Layout**:
  - The selected game's AI key art fills the screen.
  - A large display title sits at the left.
  - One row of game tiles runs along the bottom; the focused tile is bigger and outlined.
  - A slim top bar shows the room, the players' avatars and the clock.
- **Per-game theming [call]**: each game's generated palette re-tints the UI (accent, glow, gradients). A lava game warms the whole UI; an ocean game cools it. This keeps the energy up while staying cinematic.
- **Type [call]**: Bricolage Grotesque for display, Figtree for UI text, both bundled locally (no CDN on the TV).
- **10-foot rules**:
  - Minimum body text about 28 px at 1080p.
  - Focus is always obvious: scale, outline and glow.
  - Every screen is fully usable with the D-pad.
  - Title-safe margins of 5%.
- **Motion**:
  - One orchestrated moment per screen: the Forge assembly, podium reveal and key-art crossfade.
  - Everything else is quiet.
  - Respect performance limits (§8).
- **Logo [call]**: an original Cadabra wordmark with a "beam of light" mark. Must not resemble PlayStation's button symbols or any third-party mark.
- **Phone controller**: same palette, very large touch targets, one-thumb layouts, haptics (`navigator.vibrate` where supported).

## 6. Architecture [call]

```
 Phones (browser)          AWS (ap-south-1 + cross-region AI)          Fire TV Stick
 ───────────────           ──────────────────────────────────          ─────────────
 Controller web app ─HTTPS─ CloudFront + S3 (controller, assets)
        │                                                              Android app (Kotlin)
        ├──WSS signaling──► API Gateway WebSocket ◄──WSS signaling──── └─ WebView: TV web app
        │                    └ Lambda (rooms, relay, signaling)            (engine + UI, PixiJS)
        │                    └ DynamoDB (rooms, games, kits, arcade)
        │                    └ Lambda "forge" (Bedrock, Nova Canvas,
        │                       Polly, validator, headless playtest)
        └══════ WebRTC DataChannel, direct over home Wi-Fi ═══════════► (inputs + state)
                (fallback: relay through API Gateway WebSocket)
```

### 6.1 Fire TV app
- A thin native Android app in Kotlin:
  - Uses the leanback launcher with a proper banner.
  - Keeps the screen awake.
  - Maps remote keys (D-pad, Select, Back, Play/Pause, the menu key) into the web layer.
  - Hosts a full-screen WebView.
- The TV web app (TypeScript) is **bundled inside the app assets** so it loads instantly and works offline for the UI. It contains:
  - the game engine,
  - the cinematic UI,
  - audio playback,
  - the host side of networking.
- The TV is the **authority** for game state: it runs the simulation; phones only send inputs and render their controller.
- Rendering: PixiJS (WebGL) **[call]**. The builder may swap it for another 2D WebGL renderer if the on-device spike (§12, phase 0) shows a better result.

### 6.2 Phone ↔ TV transport
Why WebRTC, decided **[call]**:
- Phone browsers block tilt sensors, the camera and the microphone on plain-HTTP pages, so the controller must be served over HTTPS.
- An HTTPS page can't open plain connections to the stick's local IP.
- So: the controller is served from CloudFront over HTTPS; phone and TV exchange connection details through the API Gateway WebSocket; then they open a **direct WebRTC DataChannel over the home Wi-Fi**.
- Inputs use an unordered, unreliable channel; state and events use a reliable channel.
- If the direct connection fails (for example on strict networks), traffic falls back to relaying through the API Gateway WebSocket.
- The UI shows a small "direct" or "relay" indicator in settings.
- Builder must verify early that WebRTC works in the Fire OS WebView (§12, phase 0).

### 6.3 Backend
- **API Gateway WebSocket + Lambda (TypeScript)**: room create/join, signaling, relay fallback, broadcasting Forge progress.
- **DynamoDB**: rooms and connections (TTL), game specs, households and Arcade, share codes, invented blocks.
- **S3 + CloudFront**: the controller site, generated art, cached host audio.
- **"Forge" Lambda**:
  - Invoked asynchronously, with a timeout of about 2 minutes.
  - Runs the generation pipeline (§7).
  - Streams progress events to the room so the Forge animation reflects real progress.
- **Infrastructure as code**: AWS CDK (TypeScript). One `cdk deploy` stands everything up.
- **Secrets**: no AWS credentials on the TV or phones. Rooms are authorized with short-lived room tokens issued by the backend.

### 6.4 AI services
- **Bedrock, Claude** (the latest capable Claude model available in Bedrock for the region or inference profile; the builder checks the Bedrock console):
  - pitches,
  - game specs,
  - remix diffs,
  - wild-mode block code,
  - the host script.
- A faster, smaller Claude model writes live host one-liners where latency matters **[builder]** picks.
- **Amazon Nova Canvas**:
  - game key art, sprites and backgrounds,
  - selfie-to-cartoon avatars (via image variation or conditioning).
  - If it isn't available in ap-south-1, call it cross-region.
  - Sprites need transparent backgrounds: generate on a plain background and remove it, or use Nova Canvas background removal **[builder]**.
- **Amazon Polly (neural)**: the host voice. Default voice: an Indian-English neural voice if available, otherwise a neutral English voice **[call]**. Cache audio in S3 by text hash.
- **Bedrock Guardrails**: family-safe filtering on player inputs and on all generated text and image prompts. On by default.
- **Fallbacks**:
  - If art generation fails or is slow, use pre-generated themed art packs plus palette tinting.
  - If Polly fails, use on-screen captions.
  - The game never waits on art to start.

## 7. Game generation

### 7.1 Game spec
- A game is a **JSON game spec**, validated against a strict schema (for example with zod) shared by the TV engine and the Forge Lambda. It includes:
  - Title, hook and a theme (palette, key-art prompt, sprite prompts).
  - Arena type and size.
  - Teams or free-for-all, and player roles.
  - **The blocks used, with their parameters.**
  - Win condition and duration.
  - An event timeline: a mid-round surprise and the final-10-second twist.
  - A comeback rule.
  - Controller layout: which widgets appear on the phone.
  - Host lines for the intro, the event, the finale and the results.
- The spec carries a schema version. Remixes are expressed as JSON patches to the spec.

### 7.2 The kit (building blocks)
- **A block** is a self-contained module behind one standard interface:
  - a parameter schema,
  - the controller widgets it needs,
  - setup, update(dt) and input handlers,
  - the events it emits for host commentary and results,
  - scoring hooks,
  - a **bot policy** for playtests and demo bots,
  - its own "juice": particles, screen shake, sound effects.
- Built-in blocks and AI-invented blocks implement the same interface.
- **Initial kit: 8 blocks [user]** (list **[call]**; the builder may swap a block for an equally strong one):
  1. **Arena movement**: joystick- or tilt-driven avatars in a top-down arena. The foundation for most games.
  2. **Collect / steal**: items spawn, get grabbed, carried or stolen.
  3. **Dodge**: hazards with telegraphed attacks (lava, falling objects, sweeping beams).
  4. **Race / relay**: lanes or a track, with checkpoints and baton passing.
  5. **Sneak**: a guard or sleeping creature with a noise or vision meter. Holding "tiptoe" moves slowly and quietly.
  6. **Mash / tug-of-war**: team tap battles with a rope or meter.
  7. **Draw & judge**: players draw on their phones; Bedrock vision scores and roasts the drawings. The social, non-action block.
  8. **Quick-vote / trivia**: personalized questions about the room.
- **Modifiers that apply across blocks**: teams, power-ups, shrinking arena, speed changes, role swaps, and the comeback mechanic (trailing players get small boosts).
- **Phone controller widgets**: joystick, 1–3 big buttons, hold button, tilt steering, swipe, drawing canvas, vote list, text/voice input.

### 7.3 Forge pipeline (inside the Forge Lambda)
1. Moderate the ingredients with Guardrails.
2. **Two-stage generation [call]** (keeps the pre-vote wait short):
   - **Stage A, light pitches (target ≤ 8 s after Idea Storm ends)**: Bedrock writes 3 pitches (title, hook, blocks sketch, key-art prompt). The TV fills the wait with the ingredients swirling into three "cards" while the host banters.
   - **Stage B, speculative build**: as soon as the pitches appear, all 3 full specs are built, validated and playtested in parallel while the room votes (~10–15 s). The winner is usually ready at vote close; the Forge's ≤ 30 s budget covers any remainder plus art. Losing specs are saved to the Arcade fully built.
   - Full specs follow these **design rules** in the system prompt:
   - short rounds,
   - a comeback mechanic,
   - one mid-round surprise,
   - a dramatic final 10 seconds,
   - readable art at TV distance,
   - only blocks and parameters the schema allows.
3. Validate each spec against the schema. If invalid, repair it by sending the error back to Bedrock (at most 2 retries); otherwise drop that pitch.
4. **Headless bot playtest**:
   - Run each spec in a Node build of the engine (no rendering) with bot players for **a full round of simulated time, sped up to finish in about 2–3 seconds of real time [call]**.
   - Reject the spec if it has runtime errors, if nobody can score, if the win condition is unreachable, or if the game ends early.
   - Rejected specs are regenerated.
5. Generate key art per pitch while players vote. Generate the winner's sprites and background after the vote, starting with the most important first.
6. Write host lines; Polly synthesizes them with caching.
7. Stream progress events throughout so the Forge animation tracks real progress.
- **Engine separation**: the engine must keep simulation separate from rendering so the same code runs on the TV (with rendering) and in Lambda (headless). This is a hard requirement.

### 7.4 Wild mode and invented blocks
- **Triggered** when a remix or idea needs behavior no block or parameter can express (Bedrock flags this while writing the spec), or when the player explicitly asks for "something wild".
- **What happens**:
  - Bedrock writes a **new block module** in JavaScript against the block API, plus its parameter schema and bot policy.
  - It is labeled experimental on screen ("Wild mode").
- **Sandboxing**:
  - On the TV, the code runs isolated: a sandboxed iframe or Web Worker with no network, no DOM access to the host page, a message-passing API only, and per-frame time limits. The builder picks the mechanism.
  - In Lambda, it runs in a JavaScript sandbox. A WebAssembly JavaScript engine such as QuickJS is suggested **[builder]**.
- **Gate**: the block must pass the same bot playtest before anyone sees it. If it fails after retries, fall back to the closest kit game and have the host make a joke about it. The room never sees an error screen.
- **What a wild block can show [call]**: wild blocks add new *rules and behavior*, and draw using the kit's existing visual primitives through data messages: entities with sprites (including newly generated Nova art), preset particle effects, screen shake, preset sound effects, meters and labels. They cannot draw arbitrary graphics. Built-in blocks may use PixiJS directly for their own juice. So the engine needs a generic "data-driven entity + effects" renderer path (used by wild blocks) alongside direct rendering for built-in blocks.
- **Saving**: a block that passes and gets played can be **saved to the household's kit** and reused in future generations.
- Developers add blocks through the documented block format in the open-source repo (§10).

### 7.5 Bots
- Bot players use each block's bot policy, with a skill level and randomness, and a "personality" name and avatar.
- They are used for: playtests, "Fill with bots", solo demo recording.
- Bots must look plausible on camera: they make mistakes, fight over items, and come close to winning.

## 8. Performance and quality budgets [call]

- **Frame rate**: aim for 60 fps on the stick; never below 30 fps during play. If needed, render internally at 1280×720 and upscale.
- **Draw budget**: texture atlases, capped particle counts, no full-screen heavy filters during gameplay. Cinematic blur and glow effects only on menu screens, and only if the spike shows they hold up.
- **Input delay**: under 50 ms phone-to-TV over direct WebRTC on the same Wi-Fi. The TV shows a debug overlay with measured round-trip time **[builder]**.
- **Forge time**: about 30 seconds or less to a playable game [user] (headroom for richer tool calling); about 10 seconds or less for an AI remix; Tweak-panel changes apply instantly. The game starts with fallback art if art generation is still running.
- **Sound**:
  - Sound effects are generated in code (jsfxr-style) or are original or CC0 assets.
  - Music is procedural, CC0, or none.
  - **No copyrighted audio.**
- **Reliability**:
  - Recovery if a phone disconnects and reconnects.
  - The TV app survives being backgrounded or resumed by Fire OS.
  - Every network or AI failure has a graceful in-game fallback.

## 9. Privacy and safety [call]

- Selfies are processed only to make the avatar and are not stored afterward. Only the avatar is kept, under the household.
- Family-safe mode is on by default; Guardrails apply to inputs and to generated content.
- No personal data in URLs. Room codes and short-lived tokens only.
- Share codes expose only the game spec and art, never player names or avatars.

## 10. Open source and mini challenges

- **Main repo**: public, MIT license, with:
  - a README covering setup and deploy,
  - architecture diagrams,
  - a "what was built during the hackathon" section (everything; the project is new),
  - a `FEEDBACK.md` with product feedback,
  - a `FRICTION_LOG.md`.
- **Open Source mini challenge [call]**: an **additional** MIT-licensed project extracted from Cadabra, for example `couchpad` or `cadabra-kit`.
  - It contains the phone-as-controller library (QR join, WebRTC DataChannel with relay fallback, controller widgets) and the block SDK with docs and one example block.
  - It is useful to any TV or web party-game developer.
  - Cadabra consumes it as a dependency.
  - The submission needs: the contribution URL, the repo URL, the GitHub username (`MaanavKrishna`) and a short description.
- **AWS Builder**: the README and feedback list every AWS service and how it's used: Bedrock (Claude, Nova Canvas, Guardrails), Polly, Lambda, API Gateway WebSocket, DynamoDB, S3, CloudFront, CDK.
- **Friction log**: kept *as we go* (each entry records the task, the steps, expected vs actual, severity, workaround and a suggestion), especially for Fire TV setup, Bedrock model access and Nova availability. This can earn up to a 10% judging bonus.

## 11. Demo video plan [user + call]

- **Total under 3 minutes**, best material first.
- **0:00–0:10**: hook. "Cadabra was Amazon's first name. Abracadabra: I create as I speak." Then cut to the TV.
- Real capture from the stick: screen recording over adb if Fire OS allows it (the builder verifies), plus phone-shot footage of hands holding phones in front of the real TV to prove it's a real device.
- The demo runs entirely solo: the user's phone, laptop browser tabs as extra controllers, and bots.
- **Money shots to capture**:
  1. Ingredients flying in.
  2. 3 AI pitches.
  3. The Forge assembling the game.
  4. Live gameplay.
  5. The host roast.
  6. A remix rebuilding in seconds.
  7. Wild mode inventing a block.
  8. The Arcade shelf.
- AI video tools only for the intro, b-roll and transitions. Gameplay is real.
- English voiceover by the user. No copyrighted music.

## 12. Build phases (each ends demo-ready)

Deadline 2026-10-24 00:30 IST. Each phase must leave a recordable build.

- **Phase 0, on-device spike**: install the Android SDK, adb and JDK 17; enable ADB on the stick; confirm Fire OS; sideload a WebView shell. Measure:
  - PixiJS frame rate with a representative scene,
  - WebRTC DataChannel phone ↔ stick latency,
  - Fire OS screen recording.
  If any of these fail, revise §6 before continuing.
- **Phase 1, core loop, no AI**: room join by QR, controller page, 2 hand-built games from blocks (Arena movement + Collect, Dodge), results screen, bots.
- **Phase 2, AI Forge**: spec schema, Bedrock pitches, validation, headless playtest, Forge progress, Nova art with fallbacks, Polly host.
- **Phase 3, cinematic UI**: direction A everywhere, per-game theming, D-pad polish, avatars from selfies.
- **Phase 4, remix + Arcade + wild mode**: JSON-patch remixes, saving, share codes, wild-mode blocks in the sandbox, saving invented blocks; the remaining kit blocks.
- **Phase 5, ship**: open-source extraction repo, README, FEEDBACK, FRICTION_LOG, video capture and edit, submission. Add reviewers only if the repo is private (it's public, so not needed).

## 13. Left to the builder

- Exact Bedrock model IDs and regions or inference profiles, after checking console availability.
- The sandbox mechanism for wild mode (iframe vs Worker, QuickJS vs alternative).
- The WebRTC library and STUN setup (public STUN is fine; TURN is not needed because the relay fallback exists).
- The engine's internal structure, the physics approach and the exact block parameter schemas.
- The Polly voice choice within the guidance above.
- Test strategy details. At minimum: schema validation tests, headless simulation tests per block, and the playtest gate.
- Repo layout (monorepo with TV web app, controller, engine, backend/CDK, Android shell).

## 14. Open risks

- **The WebView or WebRTC may not work on the Fire OS stick.** Mitigation: phase 0 spike; fall back to relay-only.
- **The stick's GPU may be weaker than expected.** Mitigation: lower internal resolution, fewer effects.
- **Bedrock model or Nova Canvas availability in the region.** Mitigation: cross-region inference profiles; pre-generated art packs.
- **Forge latency over 30 seconds.** Mitigation: parallel generation, art after the vote, fallback art, the warm-up mini-game.
- **iOS tilt sensors need a permission tap.** Mitigation: a "Enable tilt" button in the controller; joystick fallback.
- **Wild-mode quality.** Mitigation: the playtest gate plus fallback; it's labeled experimental.
