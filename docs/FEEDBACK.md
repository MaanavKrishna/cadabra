# Product feedback

Honest notes from building Cadabra (a Fire TV party game with an AI game designer) in five days on a brand-new AWS account and a Fire TV Stick HD. Each tool: what it was used for, what worked, what needs work, onboarding, and whether I would build with it again. Supporting detail: [FRICTION_LOG.md](FRICTION_LOG.md) (entry numbers in brackets) and [DEVICE_LIMITS.md](DEVICE_LIMITS.md).

## Fire TV Stick / Fire OS

- **Used for:** the target device. A Kotlin shell app hosts a full-screen WebView running a PixiJS game with planck physics, rendered at 1280x720 and stretched to 1080p.
- **Worked:** installing over adb is easy; a leanback app with a banner shows up on the home screen; the stick is a real, cheap, fast iteration target; sustained 3-minute runs showed no thermal throttling at all; cold start is about 1.5 s. Everything I measured (fps, memory, DataChannel latency) is reproducible with a script.
- **Needs work:** the Stick HD is a modest device (PowerVR GE8300, 922 MB RAM, about 250 MB free). Fill rate is the wall, not CPU [14]. The physics games also showed that Pixi scene-graph rebuilds (any `zIndex` write or `visible` flip) cost about 25% of the frame on this CPU, and together with 1080p fill that was about 40% [30]. After the fixes every game holds 58.6 to 60 fps. First launch after install takes about 10 s [18]. There is no official performance budget for web content on this class of device.
- **Onboarding:** enabling Developer Options and ADB debugging took minutes; the real friction is keeping an address stable [12]. A DHCP reservation, or showing the ADB address on the Developer Options screen, would remove most of it.
- **Would I build again:** yes. A living-room screen with every family member's phone as a controller is the right shape for this device, and about 60 fps is achievable if you respect the fill-rate budget and keep the scene graph stable. ADB addresses that change on reboot are still the most common interruption [12].

## Amazon WebView on Fire OS (Chromium 138)

- **Used for:** the entire TV UI and game: WebGL via PixiJS, WebAudio, WebRTC, `fetch`.
- **Worked:** modern Chromium: WebGL 2, WebRTC DataChannel (open in under 1 s, 13 to 16 ms to a real phone), secure context via `WebViewAssetLoader` [19]. Remote debugging via `chrome://inspect` works when the shell enables it.
- **Needs work:** `devicePixelRatio = 2` with a 960x540 CSS viewport is surprising for canvas code [13]. `BitmapText` with dynamic fonts ballooned memory and hung the page in my test; `backdrop-filter` runs at 10 fps. The Back key contract between native and JS needs custom plumbing [20].
- **Onboarding:** I found the viewport/DPR behaviour by measurement. A one-page "WebView on Fire TV: viewport, DPR, GPU budget, key events" doc would save every web developer a day.
- **Would I build again:** yes. A web stack is the fastest path to a cinematic UI and lets the same code run in a desktop browser for tests.

## ADB (and screenrecord)

- **Used for:** install, logs, screenshots (`exec-out screencap`), key injection, `dumpsys meminfo`, and `screenrecord` for demo footage.
- **Worked:** `screencap` and `screenrecord` both just work and gave me real device evidence for the demo. `dumpsys meminfo` made GPU and renderer memory visible.
- **Needs work:** Wi-Fi adb address changes and refused connections after sleep [12]; `adb shell input keyevent` costs ~1 s per call so it is useless for latency work [15]; `screenrecord` clips came out shorter than the limit [16].
- **Onboarding:** good once connected.
- **Would I build again:** yes, with a script wrapper around `adb connect`.

## Amazon Bedrock (Converse API, tool use)

- **Used for:** the heart of the game: a designer agent that uses tool calling to produce pitches and a validated game spec; a fast model for host lines, roasts, trivia and vision judging of drawings.
- **Worked:** the Converse API's unified message and tool format is excellent: one request shape for tools, and I could translate it to another provider in a single file when I needed a fallback [1]. Inference profiles and model chains are a sensible idea. Tool use made a multi-step design agent practical.
- **Needs work:** **account readiness is the biggest problem I hit.** On a new account every Anthropic model had an applied quota of 0, the use-case form was a hidden prerequisite that only showed up as a runtime error, listing APIs said models were available when they were not invocable, and quota requests stayed pending or were closed without effect [1][2][7]. Identifier rules (`in.`, `apac.`, `global.`, base) are guesswork [6]. Throttling errors do not name the quota that was hit [5]. On submission day the Claude quotas were still 0, so the live game runs on the Anthropic API fallback with the same Converse-shaped requests (Claude Sonnet 5.5 for design and tweaks, Haiku 5.5 for pitches and captions). One model-specific detail cost a debugging round: Sonnet 5.5 rejects `thinking: disabled` and needs `between_tools` [27].
- **Onboarding:** the console model-access page does not show effective quota. I would put "RPM / TPM for your account" next to every model with a "request access" status.
- **Would I build again:** yes, and I kept it as the preferred provider: the code tries Bedrock first, falls back to the Anthropic API when access or throttling errors occur, and returns to Bedrock automatically. For a hackathon on a fresh account, though, I would want working quotas on day one.

## Amazon Bedrock Guardrails

- **Used for:** family-safe mode: screening every player ingredient, every typed tweak request, every generated pitch, caption and tweak summary, and the host roast, with a single guardrail (`ApplyGuardrail`).
- **Worked:** the best onboarding in the set. It deployed through CDK in one go, blocks profanity and violence reliably, allows normal content, and returns assessments I could interpret (family-safe off is a client-side filter on those assessments). Because `ApplyGuardrail` is independent of the model, it kept working when the model provider changed [8].
- **Needs work:** prompt-attack detection has no output strength setting, which is correct but easy to misconfigure; more worked examples of low-latency usage (screening 20 short strings in parallel) would help. Latency per call matters when a game waits on it.
- **Onboarding:** excellent.
- **Would I build again:** yes, it is why this can be a family game.

## Amazon Polly (generative, neural)

- **Used for:** a host voice: one voice per host personality from the generative engine (Matthew, Ruth, Amy), with long-form, neural and standard fallbacks; mp3 cached in S3 by text hash and played by the TV from CloudFront. **Status:** built and deployed, then turned off for product reasons (we preferred on-screen captions to a synthetic host voice), so the shipped game does not call Polly.
- **Worked:** the generative voices sound natural and the fallback chain (generative, long-form, neural, standard) made the host robust. `describe-voices --engine` made picking easy. Costs are tiny at party scale.
- **Needs work:** the generative engine is not offered in ap-south-1 [26], so Polly runs cross-region (us-east-1) with the cache in Mumbai; generative voices support only limited SSML, so expressiveness comes from word choice rather than markup. Availability of generative voices in Asia Pacific (Mumbai), including en-IN, would be welcome.
- **Onboarding:** trivial.
- **Would I build again:** yes.

## AWS Lambda

- **Used for:** three functions: WsFn (rooms, signaling, relay), ForgeFn (arm64, 3008 MB, 120 s: pitches, the tool-calling designer, the tweak agent and the bot playtests, which run the game engine inside Lambda), HostFn (host captions, roast).
- **Worked:** arm64 plus esbuild bundling is quick; asynchronous invoke is a natural fit for "start the Forge and stream results back through the WebSocket"; cold start was fine for rooms.
- **Needs work:** new-account concurrency makes reserved concurrency impossible (unreserved floor of 10) and the failure repeats on every redeploy [9][10]. Long build sessions also hit `aws login` expiry in the middle of a deploy [28]. Asynchronous invokes with retries disabled and `maxEventAge` need care to avoid duplicate forges, so I added a conditional lock in DynamoDB.
- **Onboarding:** good. The concurrency limit should be visible in the deploy error.
- **Would I build again:** yes.

## Amazon API Gateway (WebSocket)

- **Used for:** signaling for WebRTC, relay fallback, and server push of Forge progress and host audio.
- **Worked:** managed connections, `PostToConnection`, and stage throttling made a realtime backend with almost no operations. It is the reason a TV and phones that cannot connect directly still play.
- **Needs work:** the 32 KB frame / 128 KB message limits forced chunking and downscaled drawings [11]; there is no built-in connection-to-room mapping or presence, so I built it in DynamoDB with conditional writes.
- **Onboarding:** adequate; the quickstart should lead with limits.
- **Would I build again:** yes, with chunking built in from day one (it is now in `couchpad`).

## Amazon DynamoDB

- **Used for:** rooms, connections, per-room counters (rate limits), forge state and the Family Arcade, in one on-demand table with TTL.
- **Worked:** conditional writes made join, vote, token and player-cap races correct without locks; TTL cleans up rooms; single-table design with `pk/sk` was easy; zero capacity planning.
- **Needs work:** consistent reads must be requested explicitly in polling loops (a bug I hit and fixed with `ConsistentRead` on the forge poll); list-then-read patterns need care to stay consistent.
- **Onboarding:** excellent.
- **Would I build again:** yes.

## Amazon S3 and CloudFront

- **Used for:** hosting the phone controller (hashed assets, immutable caching, `index.html` no-cache with invalidation on deploy) and serving generated art and Polly audio from a private bucket through Origin Access Control, with a CloudFront Function that allows only `/voice/*` and `/art/*`.
- **Worked:** HTTPS for the controller is mandatory for tilt and vibration on phones, and CloudFront made that effortless; OAC with CDK is clean; viewer-request functions are a cheap way to guard prefixes; CORS response-headers policies solved the TV WebView's cross-origin audio.
- **Needs work:** invalidation latency makes "deploy then test on the phone" slow; CDK's `S3BucketOrigin` + function associations deserve one end-to-end example.
- **Onboarding:** good.
- **Would I build again:** yes.

## AWS CDK (TypeScript)

- **Used for:** the whole backend as one stack, including the Guardrail, three Lambdas, WebSocket API, tables, buckets, and distributions.
- **Worked:** `cdk deploy` really does stand everything up; `NodejsFunction` bundling, `CfnGuardrail` and `CfnGuardrailVersion`, and `WebSocketApi` L2 constructs saved days; outputs file made wiring the TV and controller trivial.
- **Needs work:** account-specific failures (concurrency floor) force script-level retries [9]; IAM for cross-region inference profiles and foundation-model ARNs is the hardest part and under-documented [24]; deployments of Lambda + CloudFront are slow for a tight loop.
- **Onboarding:** very good with a bootstrap.
- **Would I build again:** yes.

## Service Quotas / account setup

- **Used for:** inspecting and requesting limits for Bedrock and Lambda.
- **Worked:** the quota list is searchable and shows the applied value.
- **Needs work:** new accounts start at zero for the exact models a hackathon wants, some quotas (Stability image models) are not adjustable at all, requests can close without increase and without explanation [3][7]. This single area cost the most time and changed the architecture (fallback provider, fallback art, on-device toon avatars).
- **Onboarding:** poor for generative AI, because the sequence (form, model access, quota, region/profile) is not shown in one place.
- **Would I build again:** n/a. It is the first thing I would want fixed.

## Feature requests

| Request | Urgency |
|---|---|
| Bedrock: show effective per-account quota and invocability (`NOT_SUBMITTED / PROPAGATING / READY`) in `list-foundation-models`, the console model page and the error message, with a link to the missing step | critical |
| Non-zero default Bedrock quotas for new accounts (or an instant "try it" quota for hackathon accounts) | critical |
| Allow quota adjustment for Stability image models, or document the Support path | important |
| Make Nova Canvas available in Asia Pacific (Mumbai) and list per-region image model availability in one table | important |
| Surface the quota name and value in `ThrottlingException` ("Too many tokens per day") | important |
| A Fire TV web performance budget doc: viewport, DPR, GPU fill-rate guidance, texture memory, key events | important |
| Show ADB address and keep ADB-over-network alive across sleep; mDNS discovery on the LAN | important |
| `ListInferenceProfiles` pivot by model and region, plus valid ids in `ValidationException` | nice-to-have |
| Lambda: show the account concurrency limit in the CloudFormation error; CDK remembers the override | nice-to-have |
| API Gateway WebSocket: document frame vs message limits in the quickstart; optional built-in room/presence | nice-to-have |
| Faster Fire OS `input` injection and constant-frame-rate `screenrecord` | nice-to-have |
| Polly generative engine (and en-IN voices) in Asia Pacific (Mumbai) | nice-to-have |
| Fire TV web performance guide covering scene-graph rebuild cost and recommended internal resolution per device | important |
| `aws login`: show the session expiry and warn before long operations | nice-to-have |
| Fire TV getting-started: name the supported JDK (17) for the Android build | nice-to-have |
| Anthropic API: list valid thinking modes per model in the 400 error | nice-to-have |
