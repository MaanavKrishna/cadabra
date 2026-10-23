// Live Tweak smoke: npx tsx apps/backend/scripts/smoke-tweak.ts
// Creates a room over the deployed WebSocket API, sends forge.tweak for the Ring Out fallback with a chip and a
// free-text request, and prints the timeline. Pass: forge.tweaked arrives ≤ 15 s with a changed spec.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BackendToClientSchema, FALLBACK_SPECS, type BackendToClient } from '@cadabra/spec';

const out = JSON.parse(readFileSync(fileURLToPath(new URL('../outputs.json', import.meta.url)), 'utf8'));
const url = (Object.values(out)[0] as Record<string, string>).WsUrl!;
const spec = FALLBACK_SPECS[0]!;
const ws = new WebSocket(url);
let sentAt = 0;
const at = () => `${((Date.now() - sentAt) / 1000).toFixed(2).padStart(6)}s`;
const send = (m: unknown) => ws.send(JSON.stringify(m));
const finish = (code: number, why: string) => { console.log(`\n${code ? 'FAIL' : 'PASS'}: ${why}`); ws.close(); process.exit(code); };
setTimeout(() => finish(1, 'timed out after 40 s'), 40_000);

ws.addEventListener('open', () => send({ t: 'room.create', household: 'smoke' }));
ws.addEventListener('message', (e) => {
  const raw = JSON.parse(String(e.data));
  const parsed = BackendToClientSchema.safeParse(raw);
  if (!parsed.success) console.log(`!! schema mismatch for ${raw.t}: ${parsed.error.issues[0]?.message}`);
  const m = raw as BackendToClient;
  if (m.t === 'room.created') {
    sentAt = Date.now();
    console.log(`room ${m.code}; forge.tweak "${spec.title}"`);
    send({
      t: 'forge.tweak', code: m.code, id: 'smoke-tweak-1', spec, seats: 2, mode: 'tweak',
      requests: [{ chip: 'low-gravity' }, { text: 'make the ring way bouncier' }],
    });
  } else if (m.t === 'forge.tweakProgress') {
    console.log(`${at()}  progress ${m.step}`);
  } else if (m.t === 'forge.tweaked') {
    const ms = Date.now() - sentAt;
    console.log(`${at()}  tweaked source=${m.source} "${m.spec.title}" summary="${m.summary}" changes=${JSON.stringify(m.changes)}`);
    finish(ms <= 15_000 && m.source !== 'none' ? 0 : 1, `tweaked in ${ms} ms via ${m.source}`);
  } else {
    console.log(`${at()}  ${JSON.stringify(m).slice(0, 160)}`);
  }
});
