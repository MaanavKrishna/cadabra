#!/usr/bin/env node
/**
 * Host driver for the Fire TV benchmark (apps/tv/src/bench.ts).
 *
 *   VITE_ENTRY=bench scripts/tv-install.sh <ip>        # install the bench build first
 *   node apps/tv/bench/tv-bench.mjs run <ip> <group> [out.jsonl] [startIndex]
 *        group = stress | matrix | finale | thermal | input | all
 *   node apps/tv/bench/tv-bench.mjs cold <ip> [runs]    # am start -W + time to first frame
 *
 * It starts the app, drives the page over WebView remote debugging (Page.navigate only), tails
 * logcat (tag CadabraWeb) for `BENCH ...` lines, samples `dumpsys meminfo` of the app and the WebView
 * renderer at each `BENCH_MEM` hold, and appends merged rows to the JSONL file.
 * Restore the normal app afterwards with scripts/tv-install.sh (no VITE_ENTRY).
 */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const ADB = process.env.ADB ?? '/opt/homebrew/bin/adb';
const PKG = 'com.maanavkrishna.cadabra';
const BASE = `https://appassets.androidplatform.net/assets/www/index.html${process.env.BENCH_QS ?? ""}`;
const [, , mode = 'run', ip = '192.168.68.107', arg3, arg4, arg5] = process.argv;
const DEV = `${ip}:5555`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adbSync = (...a) => {
  for (let i = 0; ; i++) {
    try {
      return execFileSync(ADB, ['-s', DEV, ...a], { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      if (i >= 20) throw e;
      if (i === 3) { try { execFileSync(ADB, ['kill-server']); } catch { /* ignore */ } } // 'No route to host' after a Wi-Fi blip
      try { execFileSync(ADB, ['connect', DEV], { timeout: 15000 }); } catch { /* retry */ }
      execFileSync('sleep', ['3']);
    }
  }
};
const sh = (cmd) => adbSync('shell', cmd).replace(/\r/g, '');
const shSafe = (cmd) => { try { return sh(cmd); } catch { return ''; } };

try { execFileSync(ADB, ['connect', DEV]); } catch { /* already */ }

function pid() { return shSafe(`pidof ${PKG}`).trim().split(/\s+/)[0] || ''; }

async function launch() {
  shSafe(`am force-stop ${PKG}`);
  await sleep(1500);
  const t = Date.now();
  sh(`am start -n ${PKG}/.MainActivity`);
  for (let i = 0; i < 60; i++) {
    const p = pid();
    if (p && shSafe('cat /proc/net/unix').includes(`webview_devtools_remote_${p}`)) return p;
    await sleep(500);
  }
  throw new Error(`app/devtools did not come up (${Date.now() - t} ms)`);
}

async function navigate(url) {
  const p = pid();
  adbSync('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${p}`);
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch('http://localhost:9222/json')).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* retry */ }
    if (!target) await sleep(500);
  }
  if (!target) throw new Error('no devtools page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
  await sleep(500);
  ws.close();
}

function startLogcat(onLine) {
  shSafe('logcat -c'); // never replay an earlier run's BENCH_DONE / rows
  const lc = spawn(ADB, ['-s', DEV, 'logcat', '-v', 'epoch', '-s', 'CadabraWeb:I']);
  let buf = '';
  lc.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      const m = /CadabraWeb: (\w+) (.*?)(?: \(https?:[^)]*\))?$/.exec(line);
      if (m) onLine(m[1], m[2]);
    }
  });
  return lc;
}

function parseMem(txt) {
  const g = (re) => { const m = re.exec(txt); return m ? Number(m[1]) : undefined; };
  return {
    totalPssKB: g(/TOTAL:\s+(\d+)\s+TOTAL SWAP/),
    javaKB: g(/Java Heap:\s+(\d+)/),
    nativeKB: g(/Native Heap:\s+(\d+)/),
    codeKB: g(/^\s*Code:\s+(\d+)/m),
    graphicsKB: g(/Graphics:\s+(\d+)/),
    glMtrackKB: g(/GL mtrack\s+(\d+)/),
    otherKB: g(/Private Other:\s+(\d+)/),
    systemKB: g(/System:\s+(\d+)/),
  };
}

function sampleHost() {
  const main = parseMem(shSafe(`dumpsys meminfo ${PKG}`));
  const ps = shSafe('ps -A');
  const rend = /(\d+)\s+\d+\s+\d+\s+\d+\s+\S*\s*\S*\s+\S\s+\S*sandboxed_process\S*/.exec(ps.split('\n').find((l) => l.includes('sandboxed_process')) ?? '');
  const rp = ps.split('\n').find((l) => l.includes('sandboxed_process'))?.trim().split(/\s+/)[1];
  void rend;
  const renderer = rp ? parseMem(shSafe(`dumpsys meminfo ${rp}`)) : undefined;
  const mi = shSafe('cat /proc/meminfo');
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(mi)?.[1] ?? NaN);
  const freqs = shSafe('cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq').trim().split(/\s+/).map(Number);
  return {
    appMem: main, rendererMem: renderer,
    sysAvailKB: kb('MemAvailable'), sysFreeKB: kb('MemFree'),
    cpuKHz: freqs,
  };
}

async function runCold(runs) {
  const rows = [];
  for (let r = 0; r < runs; r++) {
    shSafe(`am force-stop ${PKG}`);
    await sleep(3000);
    let first;
    const lc = startLogcat((tag, rest) => {
      if (tag === 'BENCH_FIRSTFRAME' && !first) first = JSON.parse(rest);
    });
    const out = sh(`date +%s%3N; am start -W -n ${PKG}/.MainActivity`);
    const t0 = Number(out.split('\n')[0]);
    const tot = /TotalTime:\s+(\d+)/.exec(out)?.[1];
    const wait = /WaitTime:\s+(\d+)/.exec(out)?.[1];
    for (let i = 0; i < 60 && !first; i++) await sleep(500);
    lc.kill();
    rows.push({ run: r, amStartTotalMs: Number(tot), amStartWaitMs: Number(wait), toFirstFrameMs: first ? first.wall - t0 : null, jsSinceNavMs: first?.sinceNavMs, jsSetupMs: first?.setupMs });
    console.log(JSON.stringify(rows.at(-1)));
  }
  shSafe(`am force-stop ${PKG}`);
}

async function runInput(out) {
  const N = 30;
  const keys = [];
  const frames = [];
  let first = false;
  const lc = startLogcat((tag, rest) => {
    if (tag === 'BENCHKEY') keys.push(JSON.parse(rest));
    if (tag === 'BENCHKEYFRAME') frames.push(JSON.parse(rest));
    if (tag === 'BENCH_FIRSTFRAME') first = true;
  });
  await launch();
  await navigate(`${BASE}${process.env.BENCH_QS ? "&" : "?"}grp=input&i=0`);
  for (let i = 0; i < 60 && !first; i++) await sleep(500);
  await sleep(6000);
  const inj = [];
  keys.length = 0;
  frames.length = 0;
  for (let i = 0; i < N; i++) {
    const o = sh('date +%s%3N; input keyevent 22').split('\n');
    inj.push(Number(o[0]));
    await sleep(700);
  }
  await sleep(1000);
  // also: a no-op `input` invocation costs process start; measure it (keyevent for an unmapped key = swallowed by the app)
  const spawnCost = [];
  for (let i = 0; i < 8; i++) {
    const o = sh('a=$(date +%s%3N); input keyevent 0; b=$(date +%s%3N); echo $((b-a))').trim();
    spawnCost.push(Number(o));
  }
  lc.kill();
  const lat = keys.slice(0, N).map((k, i) => k.wall - inj[i]);
  const ff = frames.slice(0, N).map((f) => f.framesMs);
  const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, min: s[0], p50: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s.at(-1), avg: Math.round(s.reduce((x, y) => x + y, 0) / s.length) }; };
  const res = { type: 'input', injectToPageMs: stat(lat), pageHandlerToNextFrameMs: stat(ff), inputToolRoundTripMs: stat(spawnCost.filter(Number.isFinite)), raw: lat };
  console.log(JSON.stringify(res));
  if (out) appendFileSync(out, JSON.stringify(res) + '\n');
}

async function runGroup(group, out, start) {
  const rows = new Map();
  let pending = null;
  let lastProgress = Date.now();
  let lastIdx = start;
  let done = false;
  let expectedBusy = Promise.resolve();
  const write = (o) => { if (out) appendFileSync(out, JSON.stringify(o) + '\n'); };
  const lc = startLogcat((tag, rest) => {
    lastProgress = Date.now();
    let j;
    try { j = JSON.parse(rest); } catch { j = rest; }
    if (tag === 'BENCH_START') { lastIdx = j.i; console.log(`start ${j.i + 1}/${j.of} ${j.id}`); }
    else if (tag === 'BENCH') {
      if (j.grp !== group && !(group === 'all' && ['stress', 'matrix', 'finale'].includes(j.grp))) return;
      pending = j;
      console.log(`  ${j.id}: ${j.fps} fps  p95 ${j.ftP95} ms  long ${j.long33}`);
    } else if (tag === 'BENCH_MEM') {
      const row = pending;
      pending = null;
      expectedBusy = expectedBusy.then(() => {
        try {
          const host = sampleHost();
          write({ ...(row ?? { id: rest }), host });
        } catch (e) { write({ ...(row ?? { id: rest }), hostError: String(e) }); }
      });
    } else if (tag === 'BENCH_T') { write({ type: 'thermal', ...j, hostAt: Date.now(), cpuKHz: shSafe('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq').trim() }); console.log(`  t=${j.t}s fps ${j.fps} p95 ${j.p95} long ${j.long33} cpu ${shSafe('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq').trim()}`); }
    else if (tag === 'BENCH_ERROR') { console.log('ERROR', rest); write({ type: 'error', ...j }); }
    else if (tag === 'BENCH_DONE') done = true;
  });
  await launch();
  await navigate(`${BASE}${process.env.BENCH_QS ? "&" : "?"}grp=${group}&i=${start}`);
  while (!done) {
    await sleep(2000);
    if (Date.now() - lastProgress > (group === 'thermal' ? 120000 : 90000)) {
      console.log(`stalled at ${lastIdx}; restarting at ${lastIdx + 1}`);
      write({ type: 'stall', at: lastIdx });
      await launch();
      await navigate(`${BASE}${process.env.BENCH_QS ? "&" : "?"}grp=${group}&i=${lastIdx + 1}`);
      lastProgress = Date.now();
    }
  }
  await expectedBusy;
  await sleep(1000);
  lc.kill();
}

if (mode === 'cold') await runCold(Number(arg3 ?? 5));
else if (mode === 'input') await runInput(arg3);
else {
  const out = arg4 ?? arg3 ?? null;
  const group = arg3 && !arg3.endsWith('.jsonl') ? arg3 : 'all';
  if (out) writeFileSync(out, '', { flag: 'a' });
  await runGroup(group, arg4 ?? null, Number(arg5 ?? 0));
}
process.exit(0);
