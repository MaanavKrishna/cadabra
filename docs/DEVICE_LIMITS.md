# Fire TV Stick HD: measured limits (Cadabra renderer)

Device: Fire TV Stick HD (AFTSS), Fire OS 7.7 / Android 9, 4 cores at 1.69 GHz (no frequency change seen), PowerVR Rogue GE8300 (WebGL 2, max texture 4096), 922 MB RAM (about 250-300 MB available at idle), Amazon WebView Chromium 138. The WebView reports `devicePixelRatio = 2`, CSS viewport 960x540, i.e. the display is 1920x1080 device pixels. Display is 60 Hz, vsync-quantised: frame times come in 16.7 / 33.4 / 50 ms steps, so every "fps" below is a mix of those.

Raw rows: `docs/device-limits-raw.jsonl`. Re-run: `VITE_ENTRY=bench scripts/tv-install.sh <ip>` then `node apps/tv/bench/tv-bench.mjs run <ip> <stress|matrix|finale|diag|three|thermal> out.jsonl` (also `input`, `cold`). Restore the normal app with `scripts/tv-install.sh <ip>`.

## Method

- `apps/tv/src/bench.ts` runs one cell per page load (fresh GL context), 2 s warm-up then 8 s measured; frame times are rAF deltas. Reported: fps avg, worst 1-second bucket ("min/s"), 1% low (1000 / mean of the slowest 1% of frames), p95 frame time, frames over 33 ms. "JS ms" = main-thread time per frame (sim + Pixi update/render submission); GPU time is not directly measurable, so JS ms far below the frame time means GPU/fill bound.
- After each cell the scene keeps drawing for 3 s while the host runs `dumpsys meminfo` for the app and the WebView renderer process. "GL" = app process `GL mtrack` (GPU memory attributed to the app, includes the 1280x720 or 1920x1080 surfaces). `performance.memory` is coarse (reads 9.5 to 12 MB everywhere) and is not useful.
- Games are the real `GameRuntime` + bots + `GameView` (same code as render-demo), default 60 s spec, so the 8 s window is the opening (no surprise/finale) unless noted. "full" fx = FxBudget frozen at 250, "low" = frozen at 30 (ambient motes halved, trails off). Both freeze the adaptive loop so a cell measures one level; `auto` is the real adaptive FxBudget. No change to `packages/render`: levels are forced from the bench through casts.
- Internal resolution 1280 = 1280x720 canvas stretched to 1920x1080; 1920 = native.
- Single run per cell; run-to-run noise is about +/- 2 fps on the borderline (45 vs 50) cells and larger in the 1% low.

## Key findings

1. **The shipped game view does not hold 60 fps at 1280x720 today.** 2 players: 43-53 fps, 8 players: 40-45 fps (see matrix). At 1920x1080 it is 22-32 fps.
2. **Effects level is not the bottleneck.** full vs low differ by 1 fps or less in every matrix cell. Particles and trails are cheap; full-screen overdraw is what costs.
3. **The background layers eat the budget (diag cells, heist 4p).** Hiding the vignette sprite (plus the finale-glow sprite, alpha 0 outside the finale) takes 1280 from 44.6 to 59.8 fps and 1920 from 24.9 to 42.4 fps. Hiding blobs / floor / light-pool+motes each gains 3-5 fps. Hiding all background layers gives a locked 60 at both resolutions (the entities and HUD are cheap). Each full-screen alpha-blended layer costs about 2.5 ms at 1280 and about 5 ms at 1920 on this GPU.
4. Fill-rate is the wall: 8 full-screen alpha layers at 1280 = 54.6 fps, 16 = 34 fps; at 1920: 2 layers = 60, 8 = 31, 16 = 17. Additive quads are cheaper than alpha quads (8 additive at 1280 = 60 fps).
5. 3D is viable only in a restricted form (see 3D verdict).

## Full results

Columns: fps / worst second / 1% low / p95 ms / frames over 33 ms / JS ms per frame / app PSS MB / GL MB / renderer PSS MB.

### Game matrix: 6 modes x 2/4/8 players x 2 resolutions x full/low fx

Average fps (full / low). 1% low is mostly 15-30 at 1280 and 7-16 at 1920 (every cell has some 33-66 ms frames).

| mode | 1280 2p | 1280 4p | 1280 8p | 1920 2p | 1920 4p | 1920 8p |
|---|---|---|---|---|---|---|
| heist | 45.1 / 46.9 | 45.2 / 44.7 | 40.7 / 40.8 | 26.9 / 26.9 | 25.0 / 24.8 | 21.8 / 21.8 |
| dodge | 53.1 / 53.1 | 50.1 / 49.8 | 45.5 / 44.9 | 31.8 / 32.2 | 29.5 / 29.4 | 25.4 / 25.2 |
| sweep | 51.3 / 51.6 | 48.9 / 48.7 | 43.5 / 43.6 | 30.9 / 31.0 | 28.3 / 28.4 | 24.1 / 24.4 |
| race | 49.2 / 49.1 | 46.6 / 46.8 | 41.7 / 42.5 | 28.9 / 28.9 | 26.6 / 26.6 | 23.1 / 23.1 |
| tug | 51.2 / 51.1 | 48.0 / 47.9 | 43.2 / 43.5 | 30.1 / 30.3 | 27.7 / 27.9 | 24.1 / 24.0 |
| quiz | 43.2 / 43.9 | 43.6 / 43.7 | 43.4 / 43.3 | 24.4 / 24.5 | 24.5 / 24.6 | 24.4 / 24.1 |

Quiz has 1 entity (a panel), so its 43 fps / 24 fps shows the pure scene-layer cost independent of players. Entity counts seen: heist 15-21 (avg 12-16), dodge 5-11, sweep 20-27, race 22-28, tug 3-9, quiz 1; particles in flight avg 1-100 (sweep 8p ~85-100 peak average).

Finale (last 10 s, 8 players, real adaptive FxBudget): heist 39.1 (1280) / 21.7 (1920); dodge 43.2 / 25.0; sweep 41.5 / 23.8. At 1920 the adaptive budget fired and halved the particle cap (31 and 125), which did not recover fps.

Memory in the matrix: app PSS 108-125 MB (1280) or 142-160 MB (1920), GL 72-76 MB (1280) / 104-115 MB (1920), renderer process 47-66 MB; system MemAvailable 155-205 MB while running.

### Diagnostic: which GameView layer costs what (heist 4p, full fx)

| hidden | 1280 fps | 1920 fps |
|---|---|---|
| none | 44.6 | 24.9 |
| blobs (3 big additive glows) | 48.0 | 26.2 |
| vignette + finale glow | 59.8 | 42.4 |
| floor tile | 49.1 | 28.9 |
| ambient light pool + motes | 49.3 | 28.7 |
| HUD | 45.0 | 25.2 |
| all background layers | 59.9 | 59.8 |
| all background layers + HUD | 59.8 | 59.9 |

### Stress: particles (ParticleContainer, game scene underneath at 2 players)

| live particles | 1280 fps | 1% low | p95 ms | JS ms | 1920 fps |
|---|---|---|---|---|---|
| 0 (idle, blank) | 59.9 | 59.5 | 16.8 | 0.7 | 59.9 |
| 100 | 59.7 | 42.7 | 16.8 | 3.3 | 36.5 |
| 250 (current cap) | 58.1 | 29.9 | 16.8 | 3.8 | 36.3 |
| 500 | 54.7 | 24.9 | 33.3 | 4.8 | 36.0 |
| 1000 | 51.8 | 29.9 | 33.4 | 6.5 | 35.3 |
| 2000 | 44.6 | 20.0 | 33.4 | 8.4 | n/a |

(The 1920 numbers are dominated by the scene's background layers, not the particles: 100 and 1000 particles differ by about 1 fps.)

### Stress: sprites and entities

| cell | fps | 1% low | JS ms |
|---|---|---|---|
| raw Pixi sprites 100 / 300 (1280) | 59.9 / 59.9 | 59.5 | 2.1 / 4.1 |
| 600 | 44.0 | 23.9 | 6.3 |
| 1000 | 30.8 | 16.3 | 9.5 |
| 2000 | 17.1 | 14.9 | 15.3 |
| 4000 | 8.7 | 2.5 | 27.8 |
| raw sprites 300 / 1000 / 2000 at 1920 | 52.2 / 30.5 / 16.9 | | |
| GameView entities 50 / 150 (1280) | 54.6 / 53.1 | 29.9 | 9.2 / 14.6 |
| 300 | 38.1 | 29.9 | 24.6 |
| 400 | 30.8 | 20.0 | 30.9 |
| 600 | 22.2 | 19.9 | 43.4 |
| GameView entities 150 / 400 at 1920 | 33.8 / 29.5 | | 15 / 32 |

Raw sprites are fill/vertex bound (JS only 6 ms at 600); GameView entities are JS bound (about 0.07 ms per entity per frame: 300 entities = 25 ms). Note the entity-ramp cells include the whole background, so subtract about 15 fps worth of base cost.

### Stress: text

| cell | fps | JS ms |
|---|---|---|
| Pixi `Text` static 20 / 100 / 200 | 59.9 / 59.9 / 48.0 | 1.1 / 1.4 / 1.9 |
| `Text` re-set every frame x5 | 59.9 | 9.6 |
| x20 | 33.7 | 27.7 |
| x60 | 13.6 | 71.4 |
| `BitmapText` dynamic x60 | 31.4 (worst second 7 fps) | 27.3 (and GL +200 MB) |
| `BitmapText` static x200 | hung the page (never finished, harness restarted it) | |

Changing a `Text` string costs roughly 1.4 ms of main thread each (canvas raster + texture upload). Static text is nearly free up to about 100 objects.

### Stress: fill rate and post effects

| cell | 1280 fps | 1920 fps |
|---|---|---|
| 2 full-screen alpha layers | 59.9 | 59.9 |
| 8 alpha layers | 54.6 | 30.9 |
| 16 alpha layers | 34.2 | 17.2 |
| 4 additive layers | 59.9 | 54.0 |
| 8 additive layers | 59.9 | 34.3 |
| game scene, no filter (heist 4p) | 45.1 | 25.1 |
| + full-stage BlurFilter strength 4, quality 2 | 22.9 | 11.6 |
| + BlurFilter strength 12, quality 4 | 16.3 | 8.0 |
| + ColorMatrixFilter | 33.6 | 17.7 |
| + quarter-res bloom (extra scene pass + blur + additive) | 22.8 | 11.5 |
| + 24 DOM cards with CSS transform animation over the canvas | 41.2 (vs 45.1) | |
| + the same cards with `backdrop-filter: blur(8px)` | 9.8 | |

Every full-stage filter roughly halves fps. Even a colour matrix costs 11 fps from the 45 baseline.

### Stress: texture memory (all 51 default art PNGs, app process GL mtrack)

| | GL MB | renderer PSS | texture data |
|---|---|---|---|
| no textures | 63 | 63 | 0 |
| 51 PNGs at 192 px (what TextureStore does) | 73 | 71 | 6.2 MB |
| 51 PNGs at native (~512 px) | 102 | 102 | 34.3 MB |

Both run at 60 fps. Native-size art costs about 30 MB more than 192 px, and decode of all 51 takes 0.7-1.4 s.

### Load and start

- Cold start (force-stop, `am start -W`): TotalTime 1.3-1.8 s, activity displayed (WaitTime) 1.5-2.0 s; first rendered frame of the page 2.6-3.3 s after `am start` (5 runs, first slowest). The very first launch after install took about 10 s to reach JS (WebView first-run).
- `GameView.loadTheme` with the default pack: median 1.5 s, max 2.4 s on the device (setup to first frame 0.4-0.7 s extra). Plan on a loading screen of 2-3 s.

### Input latency

Not accurately measurable over adb. `adb shell input keyevent` itself takes about 1.0 s of wall time (a no-op `input keyevent 0` round trip: median 1005 ms), so inject-to-page was 860-1060 ms (median 926), which is almost entirely the `input` tool's JVM start. What the page can measure: from the `window.cadabraKey` call to the next rendered frame is 8-28 ms (median 11, p95 27) while the 8-player heist runs at about 40 fps, i.e. one or two frames. The Android dispatch plus `evaluateJavascript` hop is not separable; expect it to be small compared with a 33-50 ms frame, but that is an estimate. Real controller latency (phone over WebRTC) is untested here.

### Thermal / sustained (3 min, heist, 8 players, 1280x720, adaptive fx, 60 s round restarting)

fps per 10 s window: 40.6, 40.8, 39.7, 39.8, 39.5, 40.6, 39.9, 40.0, 40.0, 40.0, 40.8, 40.8, 39.9, 39.9, 41.0, 40.3, 40.0 (run average 40.2 fps, p95 33.5 ms, 1% low 14.5). **No throttling trend**: first and last minute are identical, CPU frequency stayed at 1.69 GHz, heap 12.8 MB, app PSS 119 MB + renderer 60 MB. Temperature sensors are not readable from adb shell on this device, so absolute temperature was not recorded. The stick was in open air on a desk; inside a hot TV cabinet may differ.

## 3D verdict (three.js 0.170.0, WebGLRenderer, pixelRatio 1)

Scene: floor plane, 4 capsule characters (6x16 segments), box/sphere props, 1 directional + 1 ambient light, spinning props.

| cell | fps | verdict |
|---|---|---|
| 0 props, Lambert, no shadow | 59.9 | 60 |
| 20 / 50 / 100 props, Lambert, no shadow | 59.9 / 59.2 / 59.9 | 60 |
| 50 props + shadow map 512 | 29.8 | 30 |
| 50 props + shadow map 1024 | 28.9 | 30 (marginal) |
| 50 props, MeshStandardMaterial (PBR) | 45.3 | neither, 30-45 |
| 50 props, MeshToonMaterial | 59.9 | 60 |
| 50 props, MeshBasicMaterial | 59.8 | 60 |
| 50 props, Standard + shadow 1024 | 23.1 | neither |
| Lambert, 960x540, AA off / on | 59.9 / 59.8 | 60 |
| Lambert, 1280x720, AA off / on | 59.9 / 59.9 | 60 |
| Lambert, 1920x1080, AA off / on | 49.5 / 48.0 | 30-50, not 60 |
| InstancedMesh 500 / 2000, Lambert | 59.7 / 59.8 | 60 |
| InstancedMesh 2000, Standard | 40.5 | neither |
| 2.5D: Pixi perspective floor (PerspectiveMesh) + 30 / 120 depth-scaled sprites | 59.9 / 59.9 | 60 |

JS time is 3-7 ms in all 3D cells, so cost is GPU. Memory: app PSS 87-117 MB at 1280 (157 MB at 1920 AA on), renderer 37-58 MB; three-js scenes use less than the Pixi game view.

Takeaway: a **3D lobby or podium scene is viable at 60 fps** if it is Lambert/Toon/Basic shaded, 1280x720 or lower, no shadow maps, baked or blob shadows (a dark transparent decal quad), a few hundred triangles per character and up to about 100 meshes or 2000 instanced meshes. AA is free at 1280 and below (use it). PBR (`MeshStandardMaterial`) and real-time shadow maps are not affordable (30-45 fps and 23-30 fps). 3D **games** in the same budget are possible for simple low-poly arenas at 1280x720 with Lambert/Toon, but combining the 3D scene with the current 2D GameView background layers and HUD has not been measured and would exceed the budget as the game view stands. The cheap 2.5D option (perspective-tilted floor mesh plus scaled sprites) holds 60 fps and is the safest way to get depth.

## BUDGET (what later UI/game work should assume)

All at 60 fps on the Fire TV Stick HD unless stated; the display is 60 Hz and any miss lands on 30 fps.

- **Internal resolution:** 1280x720 (or lower). 1920x1080 only for scenes with at most 2 full-screen blended layers; the current GameView at 1080p is 22-32 fps.
- **Full-screen blended layers:** at most 2 alpha layers at 1920 or 4-6 at 1280 (8 alpha layers at 1280 = 54 fps). Prefer additive over alpha for glows (about half the cost), and avoid large scaled glow sprites. Counting a gradient bg, a floor, a vignette, a light pool and 3 blobs as 7 layers is exactly why the game view lands at 45 fps. Target for a 60 fps GameView at 1280: drop or merge the vignette (bake it into the background gradient), the blobs and the light pool, keep the floor.
- **Sprites:** about 300 textured, rotating, 60-100 px sprites at 1280 (raw Pixi), 600 = 44 fps. Through EntityLayer: 50 entities cost about 9 ms JS and 150 about 15 ms; keep gameplay entities at or below about 60 including trails and views, because each costs about 0.07 ms/frame of JS on top of a base cost. Current game counts (max 28) are fine.
- **Particles:** the current cap of 250 is safe (58-60 fps, the cost is small); 500 costs 5 fps; 1000 costs 8 fps; the GPU, not JS, is the limit. 250 can stay the default; do not raise it.
- **Filters / post effects: no.** Any full-stage filter (blur 4, colour matrix, bloom) halves fps even at 1280. Use baked textures, additive glow sprites and tint instead. DOM `backdrop-filter` is ruinous (10 fps). Plain DOM overlays with transform animations are OK (-4 fps for 24 animated cards; keep it to a few).
- **Text:** at most about 100 static `Text` objects; re-set at most about 5 strings per frame (1.4 ms each); update score text only when the value changes. Do not use `BitmapText` with a dynamic font without further testing (memory blow-up and a hang were seen).
- **Players:** with the current view, 2 players is 43-53 fps and 8 players 40-45 fps at 1280, so no player count reaches 60 until the background layers are trimmed. With the background layers removed (diag), 4 players hold 60 fps; the 8-player gap (entities + particles + HUD chips, JS 9-15 ms) is the next cost, so expect about 50 fps at 8 players after the layer fix.
- **Memory headroom:** the device has 922 MB total and 250-300 MB available at idle, 155-205 MB while a game is running at 1920. The app uses about 120 MB (1280) to 155 MB (1920) PSS plus 50-65 MB for the WebView renderer. Keep art at 192 px (about 10 MB GPU for all 51; native size would add about 30 MB). Safe to add roughly 50 MB of textures; stay below about 100 MB of extra GPU memory total.
- **Load time:** budget a 2-3 s loading screen for the default art pack, and 2.6-3.3 s from launch to first frame (first launch after install about 10 s).
- **Sustained:** no thermal throttling in 3 minutes. Longer sessions and a closed cabinet were not tested.

### Recommendations

1. Fix the GameView background cost first (it is the only thing between the current build and 60 fps at 4 players): bake vignette and light pool into one background texture or the gradient, stop drawing the finale-glow sprite when its alpha is 0 (`visible = false`), shrink or drop the three big blobs, keep the floor. Re-run `diag` and `matrix` after.
2. Ship 1280x720 as the internal resolution; add a 960x540 fallback for low-end only if a 4 or 8 player scene still misses.
3. Do not rely on `FxBudget` for rescue: effects are not what is slow (full vs low is identical), so its halving at 1920 only removes eye candy without recovering fps. Consider tying degradation to the layer count instead.
4. UI screens (lobby, podium, quiz) can be 60 fps if they are one background, a few hundred sprites and static text. A 3D podium with Lambert/Toon materials, no shadow maps and 1280x720 is within budget.
5. No blur/bloom/colour-matrix filters anywhere on the full stage; no `backdrop-filter`.

### Not measured / caveats

- GPU time per frame (no timer query), actual controller-to-screen latency, ambient temperature, the 4th-wall effect of a real phone controller network, long sessions beyond 3 min, 5+ min memory growth, and audio load (sfx is procedural WebAudio, not included in the bench).
- Matrix cells measure the opening 8 s of a round, not the surprise/twist events (the finale was measured separately for 3 games).
- One run per cell; cells within about 3 fps of each other are not distinguishable.

## After Task 8c (background bake)

Change (`packages/render/src/background.ts`, `stage.ts`): the static background (gradient, floor tile, palette light pool, vignette, the three palette glows) is rendered once into one RenderTexture (1360x800 at 1280, covering the shake pad) and drawn as a single sprite with blending off (`blendMode 'none'`). It is re-rendered only on `loadTheme` / palette / floor / arena change (`BackgroundBake.invalidate`), never per frame. The vignette now sits under the entities instead of over them, the floor no longer scrolls slowly, and the three glows are frozen at their rest positions. The motes stay as 20 small additive sprites. The finale glow and the hit flash are now four thin additive edge strips (`EdgeGlow`, 110 px / 200 px) that are invisible (not drawn) whenever their alpha is ~0, instead of full-screen quads. Nothing else was implicated: the camera zoom is a transform on the shaker container (no re-render), there are no masks or filters, and `sortableChildren` is only on the bodies container (at most ~30 children).

Same harness, group `8c` (`node apps/tv/bench/tv-bench.mjs run <ip> 8c out.jsonl`), full fx frozen, 2 s warm-up + 8 s measured, one run per cell. Columns: fps avg / worst second / 1% low / JS ms per frame.

| cell | before | after |
|---|---|---|
| heist 4p 1280 | 44.7 / 44 / 20.0 / 8.9 | **59.7** / 57.9 / 42.7 / 8.5 |
| dodge 4p 1280 | 50.0 / 49 / 27.2 / 7.8 | **59.7** / 58.9 / 42.7 / 7.5 |
| sweep 4p 1280 | 48.9 / 47 / 23.9 / 9.5 | **59.8** / 58.9 / 49.7 / 9.0 |
| race 4p 1280 | 46.9 / 46 / 20.0 / 8.8 | **59.8** / 58.9 / 49.7 / 8.1 |
| tug 4p 1280 | 48.2 / 48 / 29.9 / 6.8 | **59.7** / 57.9 / 42.6 / 6.0 |
| quiz 4p 1280 | 43.6 / 41 / 17.1 / 5.3 | **59.1** / 56.9 / 24.9 / 4.5 |
| heist 8p 1280 | 40.5 / 40 / 15.0 / 10.9 | **59.9** / 59.9 / 59.5 / 10.0 |
| heist 4p 1920 | 25.0 / 25 / 9.0 / 11.3 | **59.4** / 57.9 / 33.2 / 8.4 |
| finale heist 4p 1280 (edge glow on) | 43.6 / 40 / 16.0 / 9.2 | **59.2** / 55.9 / 27.2 / 8.5 |
| finale dodge 4p 1280 | 48.8 / 46.9 / 21.8 / 8.2 | **59.6** / 58.9 / 37.4 / 7.6 |

GL mtrack is unchanged at 1280 (73-78 MB before, 75-78 MB after; the bake texture is ~4 MB) and 107 -> 118 MB at 1920. Visual parity checked with `adb exec-out screencap` on heist and dodge (group `shot`): same look, the HUD chips are slightly crisper at the edges because the vignette no longer darkens them.

Budget update: the GameView now holds 60 fps at 1280x720 with 2-8 players and full effects, and at 1920x1080 with 4 players in heist (59.4). The background costs one opaque layer; new full-screen effects must stay edge-only or baked (each full-screen alpha layer is still about 2.5 ms at 1280).

## R3: the four looks, all seven built-in games (2026-10-23)

Re-run: `VITE_ENTRY=bench` install, then `node apps/tv/bench/tv-bench.mjs run <ip> r3 out.jsonl` (28 cells: 7 games x 4 looks, 4 bots, real adaptive fx, real `EventFeed` so score popups fire). The internal resolution comes from `BENCH_QS="?res=720"` (default 1920). `r3own` is the 7 games in their own look only, and `prof` holds 60 s cells to attach a CPU profiler to. The first cell after an app launch always runs slow (JIT and shader warm-up), so each group starts with a throwaway `warmup` cell. Single runs: neighbouring cells differ by +/- 3 fps, and one 0.5-1 s hitch moves a cell's average by 2-4 fps.

**What cost the frame (CPU profiles over CDP, crate crash, toybox, 1080p):**
- **Pixi instruction rebuilds, about 25% of the frame.** Every `zIndex` write, and every `visible` flip anywhere on the stage, sets `structureDidChange` on the whole stage render group. The renderer then re-collects every renderable on the next draw. The y-sort wrote `zIndex` on every moving body every frame, and the neon scanline sweep flipped `visible` twice a frame, so the stage was rebuilt on every frame.
- **Fill at native 1080p.** The R2 looks (toybox shadows and zones, cosmos stars and glass, physics props) are fill-bound at 1920x1080. With the same code, crate crash ran at 42 fps at 1920 and 58.7 fps at 1280.
- **Hitches** of 50-390 ms:
  - first-time Text rasterise plus `texImage2D` (GOAL! banner, first popups);
  - shader compiles (the first `ParticleContainer` draw);
  - an occasional planck TOI solve of about 70 ms.
- **Steady JS** is now 8-12 ms per frame:
  - sim about 1.5-3 ms;
  - `EntityLayer.sync` about 2-3.5 ms, with `avatar` the largest part, spread over many small calls with no single hot spot;
  - Pixi update and submit about 3-5 ms.

**Fixes:**
- Depth keys are recorded per view. `zIndex` is written only when the visible bodies are out of order by more than 6 px.
- `floor`, `glows`, `trails`, `bodies`, `overlay` and `popLayer` are each their own render group, so a visibility flip rebuilds only that layer.
- The neon sweep's visibility is written once per frame.
- Play now renders at 1280x720 (`INTERNAL` in `apps/tv/src/screens/Play.tsx`), stretched to 1080p.
- On the first snapshot of a game (behind the intro card), particle shaders and the GOAL! banners are compiled and uploaded.

**Bench (fps avg, 4 bots; before = shipped R2 at 1920, after = R3 at 1280; (n) = 1% low; ★ = the game's own look):**

| game | neon | toybox | cosmos | retro |
|---|---|---|---|---|
| crate crash | 31.5 → 44.2 (3.1) | 48.8 → 58.8 (29.9) ★ | 49.5 → 54.0 (6.4) | 56.4 → 51.5 (7.5) |
| rocket ball | 51.8 → 56.2 (8.1) ★ | 57.9 → 59.6 (37.4) | 58.6 → 59.7 (42.7) | 59.4 → 58.5 (17.6) |
| overload | 52.1 → 59.8 (49.7) | 57.1 → 59.8 (49.8) | 55.5 → 59.8 (49.7) ★ | 59.4 → 59.8 (49.8) |
| paint wars | 48.1 → 59.2 (27.2) | 53.7 → 59.4 (33.2) | 52.1 → 59.3 (29.9) | 55.2 → 59.7 (42.6) ★ |
| ring out | 44.5 → 54.8 (6.5) | 48.0 → 59.4 (33.3) ★ | 47.5 → 56.0 (8.6) | 55.2 → 57.7 (13.0) |
| core rush | 54.3 → 56.6 (9.1) | 54.9 → 59.1 (29.9) | 55.8 → 59.7 (42.7) ★ | 57.5 → 58.4 (16.6) |
| neon dash | 51.7 → 58.6 (23.1) ★ | 54.8 → 59.2 (27.2) | 55.3 → 59.6 (37.4) | 54.2 → 59.2 (27.2) |

Notes on the table:
- The final run lost the stick (Wi-Fi) at core rush. The core rush and neon dash "after" cells come from the run before it, which had the same code minus the hitch prewarm and the sweep fix.
- The crate crash neon cell is the first real cell after launch in every run (31.5 before). The crate crash retro run had a single 1 s hitch (worst second 41). In the earlier run, retro scored 57.4 and neon 48.5.

**Real app on the stick (Play screen, 4 bots, 8 s of rAF timing plus `dumpsys gfxinfo` over 10 s, own look):**

| game | before (R2, 1080p) | after (R3) |
|---|---|---|
| crate crash (toybox) | rAF 45 fps; gfxinfo p50 25 ms, p90 32 ms, 93% janky | rAF 59.3 fps (p99 33 ms); gfxinfo p50 9 ms, p90 20 ms, 14% janky |
| ring out (toybox) | (not measured) | 58.6 fps; gfxinfo p50 9 ms, 4% janky |
| overload (cosmos) | | 59.0 fps; p50 9 ms, 33% janky (p90 26 ms) |
| paint wars (retro) | | 59.3 fps; p50 9 ms, 20% janky |
| core rush (cosmos) | | 59.6 fps; p50 9 ms, 11% janky |
| neon dash (neon) | | 59.8 fps; p50 10 ms, 27% janky |
| rocket ball (neon) | | 60.0 fps; p50 9 ms, 0.7% janky |

gfxinfo "janky" counts Android frames whose draw (including the WebView GL functor) ran past the deadline. It does not match dropped page frames one to one: rAF timing shows 59-60 fps where gfxinfo reports 11-33%.

**Budget update:**
- Game play renders at 1280x720.
- Never write `zIndex`, `visible`, `renderable` or `blendMode` per frame on a large render group. Write them only on change, or move the changing objects into their own `isRenderGroup` container.
- First-use Text and shaders cost 50-150 ms each on this device. Warm them during a loading or intro screen.
