# Friction Log

Kept as we built (Oct 20 to 24, 2026). Every entry: task, steps, expected vs actual, severity, workaround, suggestion. Severity: **blocker** (stopped a feature), **high**, **medium**, **low**. Device: Fire TV Stick HD (AFTSS), Fire OS 7.7.1.7 (Android 9), Amazon WebView Chromium 138. AWS region ap-south-1, brand-new account.

## Summary

| # | Area | Severity | One line |
|---|---|---|---|
| 1 | Bedrock | blocker | Every Anthropic model: applied quota 0 or "not available for this account" on a new account |
| 2 | Bedrock | high | Use-case-form requirement only surfaces as a runtime error |
| 3 | Bedrock | high | Stability image models: 0 requests per minute and the quota is not adjustable |
| 4 | Bedrock | medium | Nova Canvas not offered in ap-south-1, us-east-1 or us-west-2 for this account |
| 5 | Bedrock | medium | Nova daily token quota exhausted on the first call |
| 6 | Bedrock | medium | Inference profile ids differ per region and model family; guessing required |
| 7 | Service Quotas | high | Increase requests for default-0 quotas close without effect or stay PENDING |
| 8 | Guardrails | positive | Works in ap-south-1, usable as a standalone screen |
| 9 | Lambda | medium | Reserved concurrency impossible: unreserved floor of 10 on a new account |
| 10 | CDK / Lambda | low | The same failure repeats on every redeploy |
| 11 | API Gateway WS | medium | 32 KB frame cap and 128 KB message cap force chunking and small payloads |
| 12 | ADB | medium | adb over Wi-Fi: authorization prompts and DHCP address changes |
| 13 | WebView | medium | devicePixelRatio 2 with a 960x540 CSS viewport |
| 14 | Fire TV GPU | medium | Fill-rate bound; full-screen alpha layers cost 2.5 ms each at 720p |
| 15 | ADB | low | `input keyevent` takes about 1 s, so it cannot measure input latency |
| 16 | Fire OS | low | `screenrecord` clips end early |
| 17 | Fire TV | low | Volume keys must be passed through deliberately |
| 18 | Fire TV | low | First launch after install takes about 10 s to reach JS |
| 19 | WebView | positive | WebRTC and secure context work via WebViewAssetLoader |
| 20 | Fire TV | low | Back key needs an explicit native/JS contract |
| 21 | Tooling | low | Homebrew Gradle 9 vs AGP 8, SDK root, Java |
| 22 | Tooling | low | PixiJS 8 FillGradient constructor |
| 23 | Tooling | low | Vitest workspace deprecation, npm install-script warning |
| 24 | CDK / IAM | low | Cross-region model calls need extra IAM ARNs |
| 25 | Tooling | low | Image-tool download returned wrong images (not AWS) |
| 26 | Polly | medium | Generative voices are not offered in ap-south-1 |
| 27 | Anthropic API | medium | Sonnet 5.5 rejects `thinking: disabled`; needs `between_tools` |
| 28 | AWS CLI | medium | `aws login` sessions expire after about 12 h, mid-deploy |
| 29 | Tooling | medium | JDK 25 breaks the Android Gradle build; JDK 17 needed |
| 30 | Fire TV WebView | high | Pixi stage rebuilds plus 1080p fill cost about 40% of the frame |

## Bedrock and AWS account

### 1. Bedrock Claude models unusable on this account (ap-south-1)
- Task: 14 (Bedrock Converse client and designer agent).
- Steps: `aws bedrock-runtime converse` with `anthropic.claude-sonnet-5-5`, `anthropic.claude-haiku-5-5`, `in.`/`global.` variants of sonnet-5, sonnet-5-5, opus-5(-5), opus-4-7, fable-5, haiku-5-5, and `global.`/`in.` sonnet-4-5, sonnet-4-6, haiku-4-5.
- Expected: models returned by `list-foundation-models` / `list-inference-profiles` can be invoked. Actual: the 5.x / opus / fable family returned `AccessDeniedException: ... is not available for this account`; the 4.x family returned `ResourceNotFoundException: Model use case details have not been submitted for this account`. `apac.anthropic.claude-sonnet-5` and `in.anthropic.claude-haiku-5-5` do not exist. Base ids do not support on-demand throughput for Nova (`ValidationException`, needs a profile).
- Later check with Service Quotas: **all Claude TPM/RPM applied quotas were 0** on this account (default values are 5M TPM / 10k RPM), so even after the use-case form was submitted and propagated, invocation could not work.
- Severity: **blocker** (live Forge, host lines, roast and vision judging).
- Workaround: ordered fallback chains per role (retry on ValidationException / AccessDenied / ResourceNotFound), plus an automatic Anthropic API fallback provider (key in Secrets Manager, translated Converse request, remembered for a few minutes, Bedrock retried afterwards). A bot-playtested fallback game covers the case where no model is reachable.
- **Update, Oct 23 (submission day):** still 0. The game runs on the Anthropic API fallback (Claude Sonnet 5.5 and Haiku 5.5); Bedrock is still tried first on every new window.
- Suggestion: (a) make `list-*` APIs and the console show per-account invocability; (b) return one error that names the exact missing step (form, quota, regional availability) with a link; (c) give new accounts non-zero default quotas for the model family a hackathon is built around, or show "your quota is 0" in the model-access page.

### 2. Anthropic use-case form: invisible dependency
- Task: 14. Steps: first `converse` call on a 4.x model.
- Expected: the model access page tells me what I must do before a first call. Actual: the first discoverable signal was a runtime `ResourceNotFoundException` mentioning "use case details". Nothing in `list-foundation-models` hinted that the account was not eligible. The form itself then takes time to propagate with no status indicator.
- Severity: high. Workaround: submit in console, retry. Suggestion: a `GetFoundationModelAvailability`-style status that says `NOT_SUBMITTED | PROPAGATING | READY`.

### 3. Stability AI image models: RPM 0, not adjustable
- Task: 17 (art pipeline). Steps: Service Quotas for Bedrock Stability models in us-west-2; `InvokeModel` for `stability.stable-image-core-v1:1`.
- Expected: small default quota or an increase request. Actual: requests per minute = 0 and the quota shows as **not adjustable**; the only route is an AWS Support case.
- Severity: high (no generated art or toon selfies from AWS). Workaround: art pipeline with a fast circuit breaker (skip image generation for 10 minutes after a throttle), a default sprite art pack plus palette tinting, and an on-device toon filter (posterize, outline, circle mask) for selfie avatars. Suggestion: allow adjustment, or document that image models need Support on a new account.
- **Update, Oct 23:** still 0 at submission. We stopped depending on generated art: all four game looks are now drawn procedurally in code, and the hero stills are baked from the real renderer.

### 4. Amazon Nova Canvas not available
- Task: planning Tasks 14/17/21 (the design called for Nova Canvas).
- Steps: `list-foundation-models --by-output-modality IMAGE` in ap-south-1, us-east-1, us-west-2.
- Expected: Nova Canvas (the Amazon-first image model) listed somewhere. Actual: not listed in any of the three regions for this account; only Stability models (us-west-2). Severity: medium. Workaround: Stability, then the fallbacks above. Suggestion: document per-region image model availability in one table, and make Nova Canvas available in the Asia Pacific (Mumbai) region.

### 5. Nova on-demand daily token quota exhausted immediately
- Task: 14. Steps: converse on `apac.amazon.nova-{micro,lite,pro}-v1:0` and `global.amazon.nova-2-lite-v1:0`.
- Expected: small calls succeed. Actual: `ThrottlingException: Too many tokens per day` on the first call.
- Severity: medium. Workaround: none, requires a quota increase. Suggestion: surface new-account on-demand quotas up front, and make the throttle message state the quota name and current value.

### 6. Inference profile ids are a guessing game
- Task: 14. Steps: finding a valid id for a model in ap-south-1.
- Expected: one documented id per model. Actual: base id (works only for some), `in.` (India) profile, `apac.` profile, `global.` profile; some exist only for some models, and a wrong guess returns `ValidationException` that does not list valid options.
- Severity: medium. Workaround: a candidate chain per role, with the last-known-good id cached per container. Suggestion: an `ListInferenceProfiles --model-id X` pivot, or a "valid ids for this region" hint in the ValidationException.

### 7. Quota increase requests: slow, opaque outcomes
- Task: 14/16. Steps: Service Quotas > request increase for Sonnet 4.5 then Sonnet 5.5 / Haiku 5.5 global TPM.
- Expected: approval or a clear rejection in minutes. Actual: the first batch closed as `CASE_CLOSED` with no change; later requests stayed `PENDING` for the rest of the build window.
- Severity: high. Workaround: Anthropic API fallback. Suggestion: show an expected turnaround and the reason when a case is closed without an increase.

### 8. Guardrails work well in ap-south-1 (positive)
- Task: 14. `CfnGuardrail` + `CfnGuardrailVersion` deploy cleanly in CDK; `ApplyGuardrail` blocks profanity/violence and allows clean text; usable as a standalone screen independent of the model provider, which is what made the fallback provider possible. One guardrail serves both family-safe on and off (off is a client-side filter on the assessment).

### 9. Lambda reserved concurrency (20) rejected: unreserved floor of 10
- Task: 9 (stage throttling + reserved concurrency), 14 (redeploy).
- Steps: `cdk deploy` with `reservedConcurrentExecutions: 20`.
- Expected: deploy. Actual: `UPDATE_FAILED ... decreases account's UnreservedConcurrentExecution below its minimum value of [10]`. A new account's concurrency limit is low enough that nothing can be reserved.
- Severity: medium. Workaround: `deploy.sh` retries with `-c reservedConcurrency=0`. Suggestion: show the account concurrency limit in the deploy error, or have CDK/CloudFormation validate against the limit.
- **Update, Oct 23:** it kept breaking deploys all week, because every fresh `cdk deploy` without the context flag tries 20 again and rolls back the whole stack update (several minutes each time).

### 10. The failure repeats on every redeploy
- Task: 14. Same deploy, second time. The first deploy with 0 stuck, then the next default-valued deploy tried to set 20 again and rolled back. Severity: low. Workaround: default to 0 in this account. Suggestion: remember the account-specific override in `cdk.context.json` automatically.

### 11. API Gateway WebSocket frame size
- Task: 9/10/18 (relay, draw, judge). API Gateway WebSocket frames cap near 32 KB for the sender and messages pushed to clients are capped at 128 KB.
- Expected: relay of drawings and art in one message. Actual: had to implement chunking (28 KB envelopes with reassembly and a 10 s timeout), downscale phone drawings to 256 px JPEG, and send art as https URLs rather than data URLs.
- Severity: medium. Workaround: the above (`couchpad` relay chunking). Suggestion: lift to a documented streamable limit or document the 32 KB behaviour clearly in the WebSocket quickstart.

## Fire TV, Fire OS, ADB, WebView

### 12. adb over Wi-Fi: authorization prompt and moving IP
- Task: 2, 13, bench. Steps: `adb connect <ip>:5555`.
- Expected: stable session. Actual: the IP changed several times (DHCP: .109, .106, .107, ...), `connection refused` after the stick slept, re-authorization prompts on TV after each change.
- Severity: medium. Workaround: scripts take the IP as an argument (`tv-install.sh <ip>`, `TV_IP` for `tv-record.sh`); DHCP reservation recommended. - **Update, Oct 23:** the address changed again after a reboot, and once the Mac itself moved to another network (172.18.x) in the middle of an on-device benchmark, which left a bench build on the stick.
- Suggestion: show the ADB IP and port on the Developer Options page; keep ADB-over-network enabled across sleep; mDNS discovery.

### 13. WebView `devicePixelRatio = 2` with a 960x540 CSS viewport
- Task: 2/12. Steps: size a canvas from `window.innerWidth`.
- Expected: 1920x1080 CSS pixels (the display). Actual: Chromium reports a 960x540 CSS viewport at DPR 2. Naive sizing renders a quarter of the pixels or blurs.
- Severity: medium. Workaround: set the renderer resolution explicitly and size the canvas to the CSS viewport; the app first rendered at an internal 1920x1080, and now renders at 1280x720 for fill rate (entry 30). Suggestion: document the viewport and DPR for Fire TV WebView, and the recommended approach for 1080p.

### 14. The GPU is fill-rate bound: full-screen layers are the bottleneck
- Task: 8c bench. Steps: PixiJS scene on a PowerVR GE8300 (Stick HD).
- Expected: 60 fps at 1280x720 for a 2D game. Actual: first build 40 to 53 fps; each full-screen alpha layer cost ~2.5 ms at 720p and ~5 ms at 1080p; any full-stage filter (blur, colour matrix) halves the frame rate; `backdrop-filter` is about 10 fps.
- Severity: medium. Workaround: baked a single background texture, additive glows instead of alpha, no filters; result ~59.7 fps at 720p and ~59 fps at 1080p. Suggestion: publish a performance budget for Fire TV Stick HD WebView (fill rate, number of layers, texture memory), since the Stick HD is the volume device.

### 15. `adb shell input keyevent` is a poor latency probe
- Task: bench. Steps: measuring remote key to page latency.
- Expected: tens of ms. Actual: a no-op `input keyevent 0` already costs ~1.0 s (JVM start). What can be measured in-page (call to next rendered frame) is 8 to 28 ms.
- Severity: low. Workaround: measure inside the page only; use a physical remote for feel. Suggestion: a fast native injector, or a documented `sendevent` recipe.

### 16. `screenrecord` outputs shorter than requested
- Task: 2. Steps: `scripts/tv-record.sh` with a 10 s limit. Expected 10 s, got ~7.4 s (idle frames dropped, early end). Severity: low. Workaround: playable output; use HDMI capture for hero footage. Suggestion: constant frame rate option.

### 17. Volume keys do not reach the page, and swallowing them breaks the TV
- Task: 2. Steps: `dispatchKeyEvent` returning true for every key except HOME (as in the first plan).
- Expected: volume still works. Actual: VOLUME_UP/DOWN were swallowed and users could not change volume inside the app. Fix: pass VOLUME_* and MUTE through to the system. Severity: low (high impact if missed). Suggestion: make the leanback/WebView sample demonstrate the correct pass-through.

### 18. First launch after install: ~10 s to reach JS
- Task: bench. Cold start afterwards is 1.3 to 1.8 s (activity) and 2.6 to 3.3 s to first frame; the first launch after `install -r` took about 10 s (WebView first-run). Severity: low. Workaround: loading screen; warm launch once before a demo. Suggestion: document.

### 19. Amazon WebView supports WebRTC and secure contexts via WebViewAssetLoader (positive)
- Task: 2. WebRTC loopback DataChannel opens in under 1 s; with `WebViewAssetLoader` the page is a secure context (`isSecureContext = true`); phones connect direct at 13 to 16 ms. The sample docs could say this up front.

### 20. D-pad / key mapping
- Task: 2. `adb shell input keyevent` for UP/DOWN/LEFT/RIGHT/CENTER/ENTER/PLAY_PAUSE/MENU all reach JS; BACK needs an explicit contract between the native shell and JS (`exit` | `handled` | `missing` | `error`) because `evaluateJavascript` cannot tell a `null` return from a throw. Severity: low.

## Tooling

### 21. Android toolchain on macOS
- Task: 2. Homebrew Gradle is 9.x and AGP 8.x needs 8.x (use brew Gradle only to generate a wrapper, then `./gradlew`). The `android-commandlinetools` cask defaults the SDK root to `/opt/homebrew/share/android-commandlinetools` and does not install Java (`openjdk@17` separately); `sdkmanager --sdk_root=$HOME/Library/Android/sdk`. First Gradle build ~75 s cold, ~15 s later. Severity: low. Suggestion: official one-line setup for Fire TV web apps.

### 22. PixiJS 8 `FillGradient` positional constructor
- Task: 2. Deprecated since v8.5.2 and the typings reject it; use the options object with `colorStops`. Severity: low.

### 23. Vitest workspace file deprecation, npm install-script warning
- Task: 1. `vitest.workspace.ts` is deprecated in favour of `test.projects` in a root config; npm warns that `esbuild`/`fsevents` install scripts are not allow-listed. Severity: low. Workaround: migrated to `test.projects`; ignore the npm warning.

### 24. CDK cross-region AI calls from a Mumbai stack
- Task: 14/17. Bedrock Converse runs in ap-south-1, image models were only in us-west-2, so the stack calls two regions and the IAM policy needs both foundation-model ARNs and the inference-profile ARN. Severity: low. Suggestion: examples of IAM for cross-region inference profiles in the CDK docs.

### 25. Image generation for the default art pack
- Task: art pipeline. A chat-based image tool produced the sprite sheets (sliced with scripts), but full-size downloads from the tool sometimes returned the wrong images, so clipboard capture was used. Not AWS-related; recorded for completeness.

## Late-build entries (Oct 23)

### 26. Polly generative voices are not offered in ap-south-1
- Task: host voice upgrade.
- Steps: `aws polly describe-voices --engine generative --region ap-south-1`, then `SynthesizeSpeech` with `Engine=generative`.
- Expected: the newest engine in the region where the rest of the stack runs. Actual: no generative voices in Mumbai. We called Polly in us-east-1 and kept the mp3 cache in ap-south-1, with a fallback chain (generative, long-form, neural, standard).
- Severity: medium. Later the voice was turned off for product reasons (captions only), so Polly is built but unused.
- Suggestion: generative voices, including en-IN, in Asia Pacific (Mumbai), and a per-region engine table on the voices page.

### 27. Claude Sonnet 5.5 rejects `thinking: {type: 'disabled'}`
- Task: the Anthropic API fallback provider.
- Steps: the designer request with thinking disabled to save latency, the same shape that worked on Haiku 5.5.
- Expected: thinking off. Actual: a 400 on Sonnet 5.5. It takes `{type: 'between_tools'}` instead (valid at effort high or below, its default). Haiku 5.5 still accepts `disabled`.
- Severity: medium (every live design failed until the fix). Workaround: choose the thinking type per model id.
- Suggestion: list the valid thinking modes per model in the error message.

### 28. `aws login` sessions expire after about 12 h, mid-deploy
- Task: backend redeploys during the build.
- Steps: `bash apps/backend/deploy.sh` late in a long session.
- Expected: either a warning before expiry or a refresh. Actual: the deploy failed partway with an expired-credentials error, and someone had to run `aws login` again in a browser before we could continue. `deploy.sh` now checks `aws sts get-caller-identity` first and stops with a clear message.
- Severity: medium. Suggestion: show the session expiry time in `aws login` output, and let `cdk deploy` warn when the remaining session is shorter than a typical deploy.

### 29. JDK 25 breaks the Android Gradle build
- Task: building the Fire TV APK.
- Steps: `./gradlew assembleDebug` with the machine's default JDK (Temurin 25).
- Expected: build. Actual: Gradle 8.10 and AGP 8.7 fail on JDK 25. Pinning `JAVA_HOME=/opt/homebrew/opt/openjdk@17` fixed it, and `scripts/tv-install.sh` now sets it.
- Severity: medium. Suggestion: the Fire TV getting-started page should name the supported JDK, and Gradle should fail with "unsupported Java version" up front.

### 30. Fire TV WebView: Pixi stage rebuilds and 1080p fill rate cost about 40% of the frame
- Task: R3, performance on the stick for the physics games.
- Steps: CPU profiles over CDP and `dumpsys gfxinfo` on the real app, with 4 bots, in every game and look.
- Expected: about 60 fps (the older games already held 59 at 1080p). Actual: Crate Crash ran at 45 fps (gfxinfo p50 25 ms, 93% janky frames). About 25% of the frame was Pixi rebuilding its instruction list, because the y-sort wrote `zIndex` on every moving body and a sweep flipped `visible` twice a frame; most of the rest of the gap was fill at native 1080p (42 fps at 1920 vs 58.7 at 1280 with the same code). First-time text rasterisation and shader compiles added one-off hitches of 50 to 390 ms.
- Severity: high. Workaround: re-sort only when bodies are out of order by more than 6 px, a render group per dynamic layer, render internally at 1280x720 stretched to 1080p, and prewarm shaders and banners behind the intro. Crate Crash now runs at 59.3 fps (p50 9 ms), and every game is at 58.6 to 60.0.
- Suggestion: a Fire TV web performance guide that names fill rate and per-frame scene-graph rebuilds as the two budgets, with recommended internal resolutions per device.

