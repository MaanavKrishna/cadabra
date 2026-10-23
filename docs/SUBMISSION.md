# Devpost submission

Ready-to-paste copy for each Devpost field. Deadline: 2026-10-24 00:30 IST.

## Name and tagline

**Cadabra: Say it. Play it.**

Short description: *AI party games for Fire TV. The room throws in ideas from their phones, the AI designs and bot-tests a physics game in seconds, and every phone is the controller.*

## Links (paste into Devpost "Try it out")

- Website and docs: https://maanavkrishna.github.io/cadabra/
- Code: https://github.com/MaanavKrishna/cadabra
- Fire TV APK: https://github.com/MaanavKrishna/cadabra/releases/tag/v1.0
- Open-source library: https://github.com/MaanavKrishna/couchpad (docs: https://maanavkrishna.github.io/couchpad/)
- Phone controller (opens from the TV's QR code): https://d3g2ct6wjlkyzv.cloudfront.net

## Track and challenges

- **Track:** Fire TV.
- **AWS Builder.** Services and what each one does:
  - **Amazon Bedrock (Converse API, tool use):** the AI game designer and tweak agent call tools against our game kit; also pitches, host captions and the roast. Preferred provider, with ordered model chains.
  - **Amazon Bedrock Guardrails:** one `cadabra-family-safe` guardrail screens every idea, typed tweak, pitch, caption and roast.
  - **AWS Lambda (x3):** `WsFn` for rooms, WebRTC signaling and relay; `ForgeFn` (arm64, 3008 MB) for the designer, tweaks and the bot playtests, which run our game engine inside Lambda; `HostFn` for captions and the roast.
  - **Amazon API Gateway (WebSocket):** real-time rooms, signaling, the relay fallback, and server push of forge progress.
  - **Amazon DynamoDB:** one on-demand table with TTL for rooms, connections, forge locks, rate counters and the household Arcade. Conditional writes make joins and votes atomic.
  - **Amazon S3 + Amazon CloudFront:** the phone controller site and the assets CDN (private buckets, OAC, a CloudFront Function prefix guard).
  - **AWS Secrets Manager:** the key for the Anthropic API fallback.
  - **AWS CDK (TypeScript):** the whole backend is one stack.
  - **Amazon Polly:** built for a host voice, then turned off; the shipped game uses captions.
- **Open Source:** [github.com/MaanavKrishna/couchpad](https://github.com/MaanavKrishna/couchpad). couchpad turns phones into game controllers for TV and web games: QR join, joystick, button, tilt, swipe, draw and vote widgets, and a direct WebRTC DataChannel with an automatic WebSocket relay fallback (chunking, reliable queue, keepalive, rejoin). It ships a reference signaling server and an example. MIT. Main repo: [github.com/MaanavKrishna/cadabra](https://github.com/MaanavKrishna/cadabra). GitHub username: MaanavKrishna.
- **Friction log bonus:** [docs/FRICTION_LOG.md](FRICTION_LOG.md), 30 dated entries with task, steps, expected vs actual, severity, workaround and suggestion. Product feedback: [docs/FEEDBACK.md](FEEDBACK.md).

## Inspiration

"Cadabra" was Amazon's first name. Abracadabra means "I create as I speak", and that became the product: a living room that invents its own game by talking.

Family game night usually means choosing between the same five games, and one person always has to read the rules. We wanted a game that doesn't exist until the room says what it wants, and is playable seconds later on the TV you already own. There are no controllers to buy and no app to install: everyone already has a phone.

## What it does

Cadabra is a party game console for Fire TV where the AI is the game designer.

1. **Join.** The TV shows a QR code and a 4-letter code. Phones join in the browser, with no install, and pick an orb or a selfie avatar. 1 to 4 players, and bots fill the empty seats.
2. **Idea Storm (30 s).** Everyone types ideas on their phone ("laser sharks", "disco floor", "zero gravity"), and they float onto the TV.
3. **Three AI pitches.** In about 6 seconds the AI pitches three games, each with a title, a hook, game blocks and a visual look. The room votes on their phones.
4. **The Forge.** The AI designer builds the winner by calling tools: it reads block schemas, writes a game spec, and runs a **bot playtest**. A game only reaches the TV after bots finish a full round with it. It is ready about 4 to 7 seconds after the vote.
5. **Play.** A real game on a Fire TV Stick HD at about 59 fps, with real physics (bumpers, bouncing balls, crates, exploding barrels), one of four looks (neon, toybox, cosmos, retro), procedural music, and PS5-style trophies. Each phone becomes the controller that game needs.
6. **Tweak it.** After the round, phones tap "Low gravity", "Bouncier" or "More chaos", or type their own idea. In about 5 seconds the AI patches the game, a "What changed" card shows the changes, and the new version replays.
7. **Keep it.** Every forged and remixed game is saved to the family **Arcade**, where you can replay or remix it.

Cadabra also ships **seven built-in games** (Ring Out, Overload, Paint Wars, Core Rush, Neon Dash, Rocket Ball, Crate Crash) and a **Party mode** of four 45-second rounds with standings. Everything is family-safe by default: every idea and every AI output goes through Amazon Bedrock Guardrails.

## How we built it

- **Fire TV app.** A Kotlin leanback shell hosts a full-screen WebView running a TypeScript app: a PS5-style React UI, a deterministic game engine, planck physics, and a PixiJS renderer. Phones talk to it over couchpad.
- **The engine.** Games are not code. They are a `GameSpec` that composes **9 tested blocks** (sneak, collect, dodge, race, tug, arena-move, trivia, draw-judge, ball-sport) with physics props and a world config: gravity, bounce, knockback and so on. The engine is seeded and deterministic, so a full 4-bot round simulates in milliseconds, which makes it a cheap gate for AI output.
- **The AI designer.** A tool-calling agent (`list_blocks`, `get_block_schema`, `patch_spec`, `playtest_spec`) runs in Lambda. The playtest returns reasons such as "only 1 of 4 bots scored; the hazard penalised them", and the model fixes the spec in its next call. A passing playtest is the submission, so a typical design is one model reply.
- **Tweak.** The same agent and tools, with a patch brief. If the AI misses its deadline, deterministic chip presets run instead, still playtest-checked, so the room never waits.
- **Looks.** All the art is procedural: four looks drawn in code, each with its own arena, sprites, particles, music and sfx. The AI picks a look for each pitch.
- **Backend.** API Gateway WebSocket, three Lambdas, DynamoDB and S3/CloudFront, all in one CDK stack in ap-south-1.
- **Models.** Claude Sonnet 5.5 designs and tweaks, and Claude Haiku 5.5 writes pitches and captions. Calls go through Amazon Bedrock first. This brand-new account's Bedrock Claude quotas are 0 and our increase requests stayed pending, so the same Converse-shaped request falls back to the Anthropic API automatically and switches back to Bedrock once Bedrock answers. Guardrails always run on AWS.
- **Tests.** 633 tests across the engine, spec, render, backend (mocked AWS), TV, controller and couchpad.

## Challenges we ran into

- **Zero AI quotas.** On a new AWS account every Bedrock Claude quota was 0, and Stability image models were at 0 and not adjustable. We built an ordered model chain with a provider fallback, and replaced generated art with four procedural looks.
- **60 fps on a Fire TV Stick HD.** The first physics game, Crate Crash, ran at 45 fps on the stick. Profiling over CDP showed Pixi rebuilding its render instructions every frame (about 25% of the frame) and 1080p fill rate. We fixed the depth sort, split the render groups, rendered at 1280x720 and prewarmed shaders. Every game now runs at 58.6 to 60 fps.
- **Making AI games fun, not just valid.** The first games were valid but not fun. We added fun rules to the prompt (a clear goal, risk and reward, a comeback, physical comedy), real physics, and a balance harness: the built-in games average 2.6 to 6.8 lead changes per round.
- **Latency budgets.** Every AI step has a deadline and a deterministic fallback: pitches 8 s, the winner 25 s after the vote, tweaks 15 s. We cut model turns until designs took one reply, and turned off SDK retries on throttled Bedrock probes, which saved about 1.3 s.
- **Real-time networking.** WebRTC in the Fire OS WebView, a relay under API Gateway's 32 KB frames, and phones that sleep, blur and rejoin.

## Accomplishments that we're proud of

- The whole loop runs on real hardware: ideas, pitches, vote, AI build, bot playtest, play, tweak, replay.
- The AI can't ship a broken game, because bots play every spec before a human does.
- Seven physics games in four looks, all at about 59 fps on the cheapest Fire TV Stick.
- A tweak loop that changes a game's rules in about 5 seconds.
- couchpad, extracted as a standalone MIT library for any TV or web party game.
- A detailed friction log and device performance report (`docs/DEVICE_LIMITS.md`).

## What we learned

- **Let the AI compose, don't let it code.** A small kit of tested blocks plus a fast deterministic simulator gives the model something it can check its own work against.
- **Never make the room wait for a model.** Every AI call has a deadline and a fallback that is already good.
- **On a Fire TV Stick, fill rate and scene-graph churn are the budget**, not JavaScript or physics.
- **Fun is measurable enough to tune:** lead changes, comeback points and score gaps from bot rounds.

## What's next

- Tweak by voice using the Fire TV remote's microphone.
- Share codes, so families can trade Arcade games.
- More blocks and a public block SDK.
- Moving fully onto Bedrock as soon as the account's quotas arrive. The code already prefers it.

## Built with

TypeScript, React, PixiJS, planck.js, Zod, Vite, Vitest, Kotlin, Android WebView (Fire OS), WebRTC, WebAudio, Amazon Bedrock (Converse, tool use), Amazon Bedrock Guardrails, AWS Lambda, Amazon API Gateway WebSocket, Amazon DynamoDB, Amazon S3, Amazon CloudFront, AWS Secrets Manager, AWS CDK, Claude Sonnet 5.5, Claude Haiku 5.5, couchpad.

## Pre-submission checklist

- [ ] Final APK installed on the stick; full loop rehearsed with a real phone (Create, Tweak, Party, Arcade)
- [ ] Backend and controller deployed; `npx tsx apps/backend/scripts/smoke-forge.ts` and `smoke-tweak.ts` pass
- [ ] `npm test` (633) and `npm run typecheck` pass
- [ ] Both repos public with MIT LICENSE; `feat/cadabra` pushed to `main`
- [ ] Demo video under 3:00 uploaded; link added here, to Devpost and to the README
- [ ] Devpost: Fire TV track; AWS Builder and Open Source challenges with the URLs above; friction log and feedback linked
- [ ] Submit before 2026-10-24 00:30 IST
