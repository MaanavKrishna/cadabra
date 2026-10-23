# Devpost form answers (copy each block into its field)

## Upload a File
`Downloads/cadabra-v1.0.apk` (15 MB, the Fire TV app)

## Submitter Type
Individual

## Organization Name
N/A

## Country of Residence
India

## Canada province
N/A

## Primary Track
Fire TV

## GitHub repository URL
https://github.com/MaanavKrishna/cadabra

## New or existing?
New

## AWS Builder Mini Challenge?
Yes

## Which AWS services did you incorporate and how?
Cadabra's whole backend runs on AWS in one AWS CDK (TypeScript) stack in ap-south-1:

- **Amazon Bedrock (Converse API with tool use):** the AI game designer and the Tweak agent call tools against our game kit (list_blocks, get_block_schema, patch_spec, playtest_spec). Pitches and host captions use it too. Bedrock is the preferred provider, with ordered model chains. This new account's Bedrock Claude and Nova quotas were still 0 on submission day (documented in the friction log), so the same Converse-shaped requests fall back to the Anthropic API automatically and return to Bedrock once it answers.
- **Amazon Bedrock Guardrails (ApplyGuardrail):** one family-safe guardrail screens every player idea, every typed tweak, and every AI pitch, caption and summary. It runs live in production.
- **AWS Lambda (3 functions):** WsFn handles rooms, WebRTC signaling and the relay. ForgeFn (arm64, 3008 MB) runs the AI designer, tweaks and bot playtests, executing our deterministic game engine inside Lambda. HostFn writes the host captions.
- **Amazon API Gateway WebSocket:** realtime rooms, signaling, a relay fallback when WebRTC is blocked, and server push of build progress.
- **Amazon DynamoDB:** one on-demand table with TTL for rooms, connections, forge locks, rate limits and the family Arcade of saved games. Conditional writes keep joins and votes atomic.
- **Amazon S3 + Amazon CloudFront:** hosts the phone controller site and an assets CDN (private buckets, OAC, a CloudFront Function path guard).
- **AWS Secrets Manager:** stores the fallback provider key.
- **AWS CDK:** infrastructure as code for all of the above.

Architecture: https://maanavkrishna.github.io/cadabra/docs/architecture.html

## Open Source Mini Challenge?
Yes

## Contribution URL
https://github.com/MaanavKrishna/couchpad

## Project Repository URL
https://github.com/MaanavKrishna/cadabra

## GitHub Username
MaanavKrishna

## What you did, how it works, why it matters
I extracted Cadabra's phone-controller networking into **couchpad**, a new MIT-licensed TypeScript library. It turns any phone into a game controller for a TV or web game, with no app install.

How it works:
- The TV shows a QR code and a 4-letter room code, and phones join in the browser.
- couchpad first opens a direct WebRTC DataChannel: unordered for input, reliable for state. If that fails (for example on hotel Wi-Fi), it falls back automatically to a WebSocket relay, with 28 KB chunking, a reliable queue, a 100 ms keepalive, rejoin tokens and TV resume.
- It ships controller widgets (joystick, buttons, tilt, swipe, draw, vote), a reference signaling server and examples.
- It has 39 tests and runs in CI.

Why it matters: party games on TVs usually need extra controllers or an app install. couchpad makes "everyone's phone is the controller" a few lines of code for any developer. It measured 13–16 ms input latency to a real Fire TV Stick.

Docs: https://maanavkrishna.github.io/couchpad/

## [Optional] Feature Requests
1. **Critical:** Bedrock shows the effective per-account quota and invocability for each model in the console, the list API and errors, with a link to the missing step. On my new account every Claude and Nova quota was 0 and requests stayed pending, which forced a provider fallback.
2. **Critical:** non-zero default Bedrock quotas for new or hackathon accounts.
3. **Important:** a Fire TV web performance guide covering viewport and DPR (960×540 CSS at DPR 2), GPU fill-rate budget, scene-graph rebuild cost, recommended internal resolution, and key events.
4. **Important:** ThrottlingException names the quota and value that was hit.
5. **Important:** a stable ADB address on Fire TV (shown in Developer Options, kept alive across sleep, mDNS discovery).
6. **Nice-to-have:** the Polly generative engine in Asia Pacific (Mumbai), including en-IN voices.
7. **Nice-to-have:** Lambda's account concurrency floor shown in the CloudFormation error.

## [Optional] Friction Log
Full log, 30 dated entries: https://github.com/MaanavKrishna/cadabra/blob/main/docs/FRICTION_LOG.md

Highlights:

1. **Bedrock Claude access on a new account**
   - Task: call Claude through the Bedrock Converse API.
   - Steps: requested model access, submitted the use-case form, invoked Converse.
   - Expected: model works after access is granted.
   - Actual: AccessDenied, then ThrottlingException "Too many tokens per day"; applied quota 0; increase requests stayed pending.
   - Severity: Critical.
   - Workaround: same Converse-shaped requests fall back to the Anthropic API, with automatic return to Bedrock.
   - Suggestion: show effective quota and invocability for each model; non-zero defaults.
2. **Stability image models**
   - Task: generate game art.
   - Steps: requested a quota increase.
   - Expected: an adjustable quota.
   - Actual: quota is 0 and not adjustable.
   - Severity: High.
   - Workaround: four procedural art looks drawn in code.
   - Suggestion: make it adjustable, or document the Support path.
3. **Fire TV WebView performance**
   - Task: 60 fps physics game on a Fire TV Stick HD.
   - Steps: profiled over CDP.
   - Expected: about 60 fps.
   - Actual: 45 fps; Pixi scene-graph rebuilds plus 1080p fill rate took about 40% of the frame.
   - Severity: High.
   - Workaround: stable z-order, render groups, render at 1280×720 → 58.6–60 fps.
   - Suggestion: publish a Fire TV web performance budget.
4. **Lambda reserved concurrency**
   - Task: CDK deploy with reserved concurrency.
   - Expected: deploy succeeds.
   - Actual: fails because the account's unreserved floor is 10.
   - Severity: Medium.
   - Workaround: retry without it.
   - Suggestion: show the account limit in the error.
5. **Polly generative engine**
   - Task: natural host voice in ap-south-1.
   - Expected: generative voices available.
   - Actual: not offered in ap-south-1.
   - Severity: Low.
   - Workaround: call Polly cross-region (us-east-1).
   - Suggestion: add it to Mumbai.
6. **Fire TV ADB address**
   - Task: iterate over Wi-Fi adb.
   - Expected: a stable address.
   - Actual: the IP changed on reboot and connections were refused after sleep.
   - Severity: Medium.
   - Workaround: reconnect script.
   - Suggestion: show the address and keep it alive.
7. **Android build**
   - Task: assemble the Fire TV shell.
   - Expected: builds with the installed JDK.
   - Actual: JDK 25 breaks the Gradle build.
   - Severity: Low.
   - Workaround: JDK 17.
   - Suggestion: name the supported JDK in Fire TV getting-started.

## [Optional] Project Testing Link
https://github.com/MaanavKrishna/cadabra/releases/tag/v1.0

## Testing instructions
1. On a Fire TV: Settings > My Fire TV > Developer Options > enable ADB debugging and apps from unknown sources.
2. From a computer on the same Wi-Fi:
   - `adb connect <fire-tv-ip>:5555`
   - `adb install -r cadabra-v1.0.apk`
3. Open Cadabra from Your Apps.
4. Scan the QR code with up to 4 phones (no app needed), or press "Fill with bots" to play alone.
5. Try **Create**: type ideas for 30 s, vote on a pitch, and play the built game. Then press **Tweak it** after the round.

No credentials are needed; the hosted AWS backend is live. Without a Fire TV, the TV app also runs in a desktop browser (see Getting started on the website): https://maanavkrishna.github.io/cadabra/docs/getting-started.html

## Feedback Q1: tools, APIs, SDKs and what for
- **Fire TV Stick HD / Fire OS:** target device. A Kotlin leanback shell hosts a full-screen WebView.
- **Fire OS WebView (Chromium):** TV UI and game (WebGL via PixiJS, WebAudio, WebRTC).
- **ADB:** install, logs, screenshots, key injection, profiling.
- **Amazon Bedrock Converse + tool use:** the AI game designer and Tweak agent.
- **Bedrock Guardrails:** family-safe screening.
- **AWS Lambda, API Gateway WebSocket, DynamoDB, S3, CloudFront, Secrets Manager, AWS CDK:** backend.
- **Amazon Polly:** host voice (built, then turned off).
- **Anthropic API (Claude Sonnet 5.5 / Haiku 5.5):** model fallback.
- **planck.js, PixiJS, Preact, Zod, Vite, Vitest:** engine, rendering, UI and tests.

## Feedback Q2: what worked well
- **Fire TV:** adb install is easy; the leanback app appears on home; sustained runs showed no thermal throttling; WebRTC DataChannel gave 13–16 ms latency to a real phone.
- **WebView:** modern Chromium with WebGL 2 and WebRTC; `chrome://inspect` remote debugging.
- **Bedrock Converse:** one clean request shape for tools made a multi-step design agent practical, and portable to a fallback provider in a single file.
- **Guardrails:** the best onboarding. It deployed via CDK first time and is reliable, independent of the model.
- **Lambda arm64 + esbuild:** fast, and async invoke fits "start the build, stream progress".
- **API Gateway WebSocket:** a realtime backend with almost no operations.
- **DynamoDB:** conditional writes made join and vote races correct; TTL cleanup.
- **CloudFront:** effortless HTTPS for phone sensors; OAC is clean.
- **CDK:** one `cdk deploy` stands up everything.

## Feedback Q3: what needs work
- **Bedrock account readiness:** every Claude and Nova quota was 0 on a new account. The use-case form only surfaced as a runtime error, listing APIs say models are available when they aren't invocable, quota requests stayed pending, and ThrottlingException doesn't name the quota.
- **Stability models:** quota 0 and not adjustable.
- **Fire TV WebView:** DPR 2 with a 960×540 viewport surprised canvas code; scene-graph rebuilds and 1080p fill rate are the real budget, with no official guidance; `backdrop-filter` runs at 10 fps.
- **ADB:** the address changes on reboot; `input keyevent` takes about 1 s per call; `screenrecord` gives 5–15 fps during WebGL play.
- **Lambda:** the reserved-concurrency floor breaks deploys with an unclear error.
- **API Gateway:** 32 KB frame limits forced chunking.
- **Polly:** no generative voices in ap-south-1.
- **`aws login`:** sessions expire mid-deploy.

## Feedback Q4: onboarding (zero to hello world)
- **Fire TV:** minutes to enable ADB and sideload a hello-world WebView app.
- **Guardrails, DynamoDB, Lambda, CDK:** excellent. Working the same day.
- **API Gateway WebSocket:** adequate; the limits should come first in the quickstart.
- **Bedrock:** poor on a fresh account. Hello world worked technically, but access, the form, quotas and inference-profile ids are spread across pages, and the account never got usable Claude quotas during the hackathon.
- **Polly:** trivial.

## Feedback Q5: build with these again?
Yes. A Fire TV in the living room, with every family member's phone as a controller, is the right shape for AI party games. The Stick sustained about 60 fps once I respected its fill-rate budget, and AWS gave me a realtime, serverless, family-safe backend in one CDK stack. I'd come back to Bedrock as the main model provider as soon as new accounts get working quotas on day one.

## Eligibility checkboxes
Tick all three if they are true for you.

## Which AI tools have you leveraged?
- Claude Code (Anthropic) as an AI coding assistant for design, implementation, testing and review.
- Claude Sonnet 5.5 and Claude Haiku 5.5 inside the product, as the game designer, tweak agent and pitch/caption writer (via Amazon Bedrock with Anthropic API fallback).
- Amazon Bedrock Guardrails for safety.
- Google Gemini for early concept art exploration (replaced by procedural art in the final build).

## Level of learning
Significant

## Gained AI value for career?
Yes
