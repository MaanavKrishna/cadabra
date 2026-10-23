# Submission draft (Devpost)

Deadline: 2026-10-24 00:30 IST. Everything below is a draft for the owner to review before pasting into Devpost. Items marked TODO need a human decision or a fact that will only be known at submission time.

## Project name and tagline

**Cadabra: Say it. Play it.**

Short description (under 200 characters): *A Fire TV party game where the room shouts ideas, an AI designs the game, and everyone's phone becomes the controller. Say it. Play it.*

## Track and challenges

- **Track:** Fire TV.
- **Mini challenge: AWS Builder.** Services: Amazon Bedrock (Converse API, tool use, Guardrails), Amazon Polly (generative voices), AWS Lambda (x3), Amazon API Gateway (WebSocket), Amazon DynamoDB, Amazon S3, Amazon CloudFront (x2), AWS Secrets Manager, AWS CDK. Details in the README and in `docs/FEEDBACK.md`.
- **Mini challenge: Open Source.**
  - Contribution URL: https://github.com/MaanavKrishna/couchpad
  - Repo URL: https://github.com/MaanavKrishna/cadabra
  - GitHub username: MaanavKrishna
  - Short description: *couchpad turns phones into game controllers for TV and web games. Players scan a QR code and get joystick, button, tilt, swipe, draw, vote and text widgets; inputs travel over a direct WebRTC DataChannel with an automatic WebSocket relay fallback (chunking, reliable queue, keepalive, rejoin). It was extracted from Cadabra and ships with a reference signaling server and a minimal host and phone example. MIT licensed.*
- **Friction log bonus:** `docs/FRICTION_LOG.md` (25 dated, structured entries: task, steps, expected vs actual, severity, workaround, suggestion).
- **Product feedback:** `docs/FEEDBACK.md`.

## Inspiration

"Cadabra" was Amazon's first name. Abracadabra: I create as I speak. Family game night is stuck choosing between the same five games. What if the game did not exist until you said what you wanted, and was playable 30 seconds later, in your living room, on the TV you already own?

## What it does

1. The TV shows a QR code and a four-letter room code. Phones join in a browser with no install, choose a name and a cartoon avatar (a selfie is cartoonised on the phone and never uploaded).
2. **Idea Storm.** Everyone types ingredients: a hero, a place, a twist.
3. **Three AI pitches.** An AI game designer proposes three games, each with a title and a hook. The room votes.
4. **The Forge.** The winning game is built, validated and bot-playtested and appears within seconds. Every phone becomes the right controller for that game (stick and jump, tap spam, tilt, swipe, draw, vote).
5. **Play.** A real engine on a Fire TV Stick HD at 1080p/60 fps, with a mid-round surprise and a double-points final ten seconds.
6. **Host and roast.** A voiced host reacts to the round and roasts the players using the actual event log ("you got caught by the bear four times").
7. **Arcade.** Games the room did not pick are saved per household for next time.

The TV is the authority; phones send inputs over a direct peer-to-peer link at 13 to 16 ms.

## How we built it

- **Fire TV app:** Kotlin shell (leanback, key mapping, volume pass-through) around a WebView that runs a TypeScript web app: a deterministic game engine of composable blocks, PixiJS rendering, and a party state machine.
- **Phones:** a React controller served from S3/CloudFront over HTTPS (needed for tilt and haptics); `couchpad` handles join, WebRTC and relay.
- **Backend (AWS CDK):** API Gateway WebSocket + three Lambdas + DynamoDB + S3/CloudFront. Bedrock Converse with tool use drives a designer agent; Guardrails screen every input and output; Polly voices the host.
- **Safety net:** specs go through a validator and headless bot playtests; if the AI is slow or unavailable, a hand-tuned fallback game is reskinned with the room's ingredients, so the game never waits.
- **Honest note on Bedrock:** this hackathon account's Bedrock Claude quotas were 0 and not obtainable in time, so the code calls Claude through an automatic Anthropic API fallback (key in Secrets Manager) and switches back to Bedrock as soon as Bedrock works. Guardrails, Polly and all hosting stay on AWS.

## Challenges we ran into

- Bedrock access on a brand-new account: use-case form, zero quotas, image models not adjustable. We built an ordered model chain with provider fallback and fallback art.
- Performance on a Fire TV Stick HD: the first game view ran at 40 to 53 fps because each full-screen alpha layer costs about 2.5 ms on the PowerVR GPU. A baked background brought it to a steady ~60 fps, even at 1080p.
- Real-time networking: WebRTC in the Fire OS WebView, relay fallback under API Gateway's 32 KB frames, and flaky phone behaviour (blur, reconnect, sticky buttons).
- Making AI games fun, not just valid: we added a playtest gate and tuned game feel (momentum, shoves, heist chase, comeback mechanics) until bot matches produced 6 to 8 lead changes per round.

## Accomplishments we are proud of

- A full loop on real hardware: join, storm, pitch, vote, forge, play, roast.
- Measured, documented Fire TV limits (`docs/DEVICE_LIMITS.md`) and a runtime that holds ~59 fps at 1080p.
- A clean extraction: `couchpad`, a standalone MIT library other TV and web party games can use.
- A thorough friction log and product feedback.

## What we learned

Fill rate, not CPU, is the budget on the Stick HD. Never make a game wait for an AI call. And the best demo of AI is a game that stands up without it.

## What's next

Remix-by-voice tweak panel, an Arcade shelf on the TV, more blocks, and a public block SDK.

## Product feedback summary

Full text in `docs/FEEDBACK.md`. Highlights:

- **Bedrock / Service Quotas (critical):** a new account had every Claude quota at 0, with no clear signal, hidden prerequisites (use-case form) and quota requests that closed or stayed pending. Show effective quota and invocability per model.
- **Bedrock Guardrails, Polly, DynamoDB, CDK (positive):** easy onboarding, reliable, and they fit a family game.
- **Fire TV (important):** a performance budget doc for web content on the Stick HD, ADB address stability, and a note on WebView `devicePixelRatio = 2`.

## Feature requests (with urgency)

- Critical: per-account Bedrock quota and invocability shown in `list-foundation-models`, the console and the error; non-zero default quotas on new accounts.
- Important: adjustable Stability image quota; Nova Canvas in ap-south-1; quota name in throttling errors; Fire TV web performance doc; stable ADB address.
- Nice-to-have: inference profile lookup, Lambda concurrency visibility in CDK errors, WebSocket limits documented in the quickstart, faster `input` injection, Polly generative voices in Mumbai.

## Demo video outline (target 2:45, hard limit under 3:00)

Rules: best material first, real device footage, no copyrighted music (use royalty-free or silence plus the game's own procedural music), English voiceover by the owner, AI video tools only for the intro, b-roll and transitions.

| Time | Beat |
|---|---|
| 0:00 to 0:10 | **Hook.** Voiceover: "Cadabra was Amazon's first name. Abracadabra: I create as I speak." Quick b-roll of the word, cut to the TV lobby. Title card: "Say it. Play it." |
| 0:10 to 0:30 | Join: real hands holding phones in front of the real TV scanning the QR; avatars pop onto the TV; the host greets them by name. |
| 0:30 to 0:55 | **Money shot 1 and 2:** ingredients flying onto the TV from phones; three AI pitches appear; phones vote. |
| 0:55 to 1:15 | **Money shot 3:** the Forge assembling the game with host commentary, then the tutorial and each phone showing its controller. |
| 1:15 to 1:55 | **Money shot 4:** live gameplay on the real stick (real capture), including the surprise event and the double-points final ten seconds; show the "direct" 13 ms indicator. |
| 1:55 to 2:15 | **Money shot 5:** results podium and the host roast built from the actual events. |
| 2:15 to 2:30 | Arcade shelf with the unplayed pitches (if the TV shelf screen is finished; otherwise skip) and a bot-filled solo round. |
| 2:30 to 2:50 | Architecture in one slide (AWS services, couchpad open source, the hardware), the stats (59 fps at 1080p, 13 ms), links. End card: repo URLs and "Say it. Play it." |

Capture notes:
- Real stick capture: `scripts/tv-record.sh <ip>` (adb `screenrecord`, clips can end early, so record several short clips) and HDMI capture as backup; also phone-shot footage of the real TV.
- The demo can run solo: one phone, laptop browser tabs as extra controllers, and bots.
- Remix and wild-mode shots are in the original plan; only include them if they shipped (they are not in this build).

## Pre-submission checklist

- [ ] Backend deployed and healthy: `bash apps/backend/deploy.sh`; smoke: `npx tsx apps/backend/scripts/smoke-forge.ts`
- [ ] Controller published: `bash apps/controller/deploy.sh`; open https://d3g2ct6wjlkyzv.cloudfront.net on a phone
- [ ] Anthropic fallback secret `cadabra/anthropic-api-key` exists (or Bedrock quotas arrived), live Forge produces AI games, not just fallbacks
- [ ] Latest TV build installed on the stick: `scripts/tv-install.sh <ip>`; full party loop rehearsed with a real phone
- [ ] `npm test` and `npm run typecheck` pass
- [ ] Repos created and pushed (owner approval was given): `MaanavKrishna/cadabra` and `MaanavKrishna/couchpad`, both public with MIT LICENSE
- [ ] couchpad: replace the main repo's workspace copy or keep both and note it in the README
- [ ] README placeholders: add `docs/media/demo.gif`, confirm screenshots render on GitHub
- [ ] Remove personal LAN IPs from docs and scripts if any remain; no secrets in git history
- [ ] Demo video under 3:00, uploaded (YouTube or Vimeo, public or unlisted), link added to Devpost and README
- [ ] Devpost: track Fire TV; mini challenges AWS Builder and Open Source with the URLs above
- [ ] Devpost: friction log and FEEDBACK linked (and pasted if the form asks)
- [ ] Final check of "built during the hackathon window" statement and licenses
- [ ] Submit before 2026-10-24 00:30 IST
