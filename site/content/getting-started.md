# Getting started

There are three ways in: play the release build on a Fire TV, run everything locally in a browser, or deploy your own backend on AWS.

## Play it on a Fire TV

You need a Fire TV device on the same Wi-Fi as your phones, and `adb` on your computer (it ships with the Android platform tools).

1. On the Fire TV, open **Settings > My Fire TV > Developer Options** and turn on **ADB debugging** and **Apps from Unknown Sources**.
2. Find the device IP in **Settings > My Fire TV > About > Network**.
3. Download [`cadabra-v1.0.apk`](https://github.com/MaanavKrishna/cadabra/releases/download/v1.0/cadabra-v1.0.apk) from the [v1.0 release](https://github.com/MaanavKrishna/cadabra/releases/tag/v1.0).
4. Sideload and launch it:

```bash
adb connect <fire-tv-ip>:5555
adb install -r cadabra-v1.0.apk
adb shell monkey -p com.maanavkrishna.cadabra -c android.intent.category.LEANBACK_LAUNCHER 1
```

The first `adb connect` shows an authorization prompt on the TV. Accept it, then run the command again. After the first launch, Cadabra is in the Fire TV apps row like any other app.

5. Scan the QR code on the TV with a phone, or open the controller URL on screen and type the 4-letter code. One phone is enough: bots fill the empty seats.

The very first launch after an install takes about 10 seconds to reach the home screen while the WebView warms up. Later launches are quick.

## Run it locally

No Fire TV and no AWS account needed. You need Node.js 20 or newer.

```bash
git clone https://github.com/MaanavKrishna/cadabra.git
cd cadabra
npm install
npm test                               # 633 tests, no AWS needed
npm --prefix apps/tv run dev           # the TV app in a desktop browser
npm --prefix apps/controller run dev   # the phone controller
```

In the TV app, the arrow keys are the remote's D-pad, Enter is Select, and Escape or Backspace is Back.

To look at one scene on its own, open `/render-demo.html?game=physics&look=toybox` on the TV dev server. `look=neon|toybox|cosmos|retro` restyles any scene.

Without a backend, the seven built-in games, Party mode and the bots still work, and tweak chips fall back to the TV's own tested presets. Create needs the backend, because the AI designer runs there.

## Deploy your own backend

The backend is one AWS CDK stack in `ap-south-1`: API Gateway WebSocket, three Lambdas, DynamoDB, S3 and CloudFront, Secrets Manager and a Bedrock guardrail.

**You need:** Node.js 20+, an AWS account with credentials (`aws login`), and for the TV app JDK 17 and the Android SDK 34. JDK 25 breaks the Android Gradle build, so pin 17.

1. Change the account id in `apps/backend/deploy.sh` to your own.
2. If your account's Bedrock Claude quotas are 0 (common on new accounts), store an Anthropic API key for the fallback path:

```bash
aws secretsmanager create-secret --region ap-south-1 \
  --name cadabra/anthropic-api-key --secret-string "sk-ant-..."
```

3. Deploy the stack, the phone site and the TV app:

```bash
bash apps/backend/deploy.sh          # CDK bootstrap if needed, then cdk deploy
bash apps/controller/deploy.sh       # vite build, S3 sync, CloudFront invalidation
scripts/tv-install.sh <fire-tv-ip>   # bundles the TV web app into the Android shell, adb install
```

4. Smoke-test the live AI paths:

```bash
npx tsx apps/backend/scripts/smoke-forge.ts
npx tsx apps/backend/scripts/smoke-tweak.ts
```

Calls go to Bedrock first. If Bedrock answers with access denied, not found or throttling, the same request goes to the Anthropic API, and Bedrock is tried again after a few minutes. Guardrails always run on AWS. See [AI designer and Tweak loop](ai-designer.html) for the details.

## Repository layout

| Path | What is in it |
|---|---|
| `apps/android` | Kotlin Fire TV shell: leanback launcher, full-screen WebView, key mapping |
| `apps/tv` | TV web app: PS5-style UI, party flow, tweak and remix, Arcade, trophies |
| `apps/controller` | Phone web app: join, avatars, Idea Storm, vote, tweak, per-game controls |
| `apps/backend` | CDK stack and Lambdas: rooms, the Forge AI designer, tweak, host captions, Arcade |
| `packages/spec` | Zod contracts: `GameSpec`, world physics, wire protocol, the 7 built-in games |
| `packages/engine` | Deterministic runtime, 9 blocks, planck physics layer, bots, playtest gate |
| `packages/render` | PixiJS game view, 4 looks, physics views, procedural music and sfx |
| `packages/couchpad` | Phone-as-controller transport and widgets, also [its own repo](https://github.com/MaanavKrishna/couchpad) |
