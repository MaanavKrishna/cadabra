# Friction Log

Entry format: task, steps, expected vs actual, severity, workaround, suggestion.

## Task 1 setup warnings

### Vitest 3.2.7 workspace-file deprecation
- Task: 1. Steps: `npm test` with `vitest.workspace.ts`.
- Expected: clean run. Actual: deprecation warning that workspace files are replaced by `test.projects` in config.
- Severity: low. Workaround: ignore. Suggestion: migrate to `test.projects` in a root `vitest.config.ts`.

### esbuild postinstall npm warning
- Task: 1. Steps: `npm install`.
- Expected: no warnings. Actual: npm warns that install scripts (esbuild postinstall, fsevents) are not covered by `allowScripts`.
- Severity: low. Workaround: ignore; esbuild and Vite work. Suggestion: approve via `npm install-scripts approve` if the warning becomes an error in a future npm.

## Task 2: Android toolchain and Fire TV shell

### Homebrew Gradle is 9.x, AGP 8.x needs Gradle 8.x
- Task: 2. Steps: `brew install gradle`, then generating the wrapper.
- Expected: brew Gradle usable directly. Actual: brew installs Gradle 9.8.2, which AGP 8.x does not support.
- Severity: low. Workaround: use brew Gradle only to run `gradle wrapper --gradle-version 8.10.2`; the committed wrapper builds with AGP 8.7.3 on JDK 17.
- Suggestion: always build through `./gradlew`.

### android-commandlinetools SDK root and Java
- Task: 2. Steps: `brew install --cask android-commandlinetools`, `sdkmanager`.
- Expected: SDK at a conventional location. Actual: cask defaults the SDK root to /opt/homebrew/share/android-commandlinetools and does not install Java.
- Severity: low. Workaround: `openjdk@17` via brew; `sdkmanager --sdk_root=$HOME/Library/Android/sdk`; `apps/android/local.properties` (gitignored) holds `sdk.dir`.
- Suggestion: none.

### Gradle first build is slow
- Task: 2. Steps: first `testDebugUnitTest`.
- Expected: seconds. Actual: ~75 s cold (dependency download); later builds ~15 s.
- Severity: low. Workaround: none needed. Suggestion: avoid `--no-daemon` when iterating.

### PixiJS 8 FillGradient positional constructor
- Task: 2. Steps: spike scene.
- Expected: `new FillGradient(x0,y0,x1,y1)`. Actual: deprecated since v8.5.2, and typings reject it; use the options object.
- Severity: low. Workaround: options object with `colorStops`.

### screenrecord output shorter than time limit
- Task: 2. Steps: `scripts/tv-record.sh`.
- Expected: 10 s clip. Actual: playable mp4 of ~7.4 s (screenrecord on this stick drops idle frames/ends early).
- Severity: low. Workaround: none needed; clip is playable. Suggestion: for demo footage prefer HDMI capture as backup.

## Device spike

- Device: Fire TV Stick AFTSS, Fire OS 7.7.1.7, Android 9 / SDK 28, 1920x1080, Amazon WebView Chromium 138 (UA: Chrome/138.0.7204.244, Android 9; AFTSS). Matches spec expectations.
- Page served from `https://appassets.androidplatform.net/assets/www/index.html` (`isSecureContext` = true) via WebViewAssetLoader.
- PixiJS 8 spike (1280x720 internal, upscaled; 8 sprites, 300 particles, full-screen gradient), 15 s measurement, two runs: avg 59.3 / min 50.0 fps and avg 59.0 / min 50.2 fps.
- WebRTC loopback DataChannel (two RTCPeerConnections in page): "open" in under 1 s.
- Screenshot via `adb exec-out screencap -p`: works. `screenrecord --time-limit 10` + pull: works, playable mp4 (see friction above).
- D-pad keys reach JS: `adb shell input keyevent` UP/DOWN/LEFT/RIGHT/CENTER/ENTER/PLAY_PAUSE/MENU logged as `SPIKE {"key": ...}`; VOLUME_UP is swallowed without a JS call (unmapped).
- Decision gate: fps >= 40, so keep the 1280x720 internal resolution (no 960x540 change for Task 8). DataChannel works, so no `TRANSPORT=relay-only` for Task 10.

### Bedrock Claude models unusable on this account (ap-south-1)
- Task: 14. Steps: `aws bedrock-runtime converse` with `anthropic.claude-sonnet-5-5`, `anthropic.claude-haiku-5-5`, `in.`/`global.` sonnet-5, sonnet-5-5, opus-5(-5), opus-4-7, fable-5, haiku-5-5, and `global.`/`in.` sonnet-4-5/4-6/haiku-4-5.
- Expected: the models listed by `list-foundation-models`/`list-inference-profiles` can be invoked. Actual: the 5.x/opus/fable family returns `AccessDeniedException: ... is not available for this account`; the 4.x family returns `ResourceNotFoundException: Model use case details have not been submitted for this account` (Anthropic use-case form not filled). `apac.anthropic.claude-sonnet-5` and `in.anthropic.claude-haiku-5-5` do not exist (invalid identifier). Base ids do not support on-demand (`amazon.nova-lite-v1:0` -> ValidationException, needs a profile).
- Severity: high (blocks live Forge). Workaround: code keeps ordered fallback chains (designer: base -> `in.` -> `global.` 5-5 -> `global.` 5; fast: base -> `global.` haiku-5-5 -> `global.` haiku-4-5) and retries on ValidationException/AccessDenied/ResourceNotFound; the owner must submit the Anthropic use-case form in the Bedrock console and request access, then rerun `npx tsx apps/backend/scripts/smoke-bedrock.ts`.
- Suggestion: list-* APIs should reflect per-account invocability; the error should link the form.

### Bedrock Nova daily token quota is zero-ish on a new account
- Task: 14. Steps: converse on `apac.amazon.nova-{micro,lite,pro}-v1:0`, `global.amazon.nova-2-lite-v1:0`.
- Expected: small calls succeed. Actual: `ThrottlingException: Too many tokens per day`. Severity: medium. Workaround: none (request quota increase). Suggestion: surface new-account on-demand quotas up front.

### Guardrails work in ap-south-1
- Task: 14. CfnGuardrail + CfnGuardrailVersion deploy cleanly; ApplyGuardrail blocks profanity/violence and allows clean text. One guardrail serves both modes: family-safe off is a client-side filter on the assessment (only HATE/SEXUAL at HIGH block).

### Lambda reserved concurrency (20) rejected again on redeploy
- Task: 14. Actual: UPDATE_FAILED "decreases account's UnreservedConcurrentExecution below its minimum value of [10]"; deploy.sh's retry with `-c reservedConcurrency=0` succeeded. Severity: low. Suggestion: default reservedConcurrency to 0 on this account.
