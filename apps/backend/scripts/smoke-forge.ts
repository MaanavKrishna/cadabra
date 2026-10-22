// Live Forge smoke: npx tsx apps/backend/scripts/smoke-forge.ts [voteDelayMs]
// Creates a room over the deployed WebSocket API, sends forge.pitch with 3 ingredients, votes for
// the first pitch after `voteDelayMs` (default 5000), and prints the message timeline.
// Pass: 3 pitches ≤ 8 s, and the winner's forge.ready ≤ 30 s after the vote (AI spec or fallback).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BackendToClientSchema, DEFAULT_SETTINGS, type BackendToClient } from '@cadabra/spec';

const out = JSON.parse(readFileSync(fileURLToPath(new URL('../outputs.json', import.meta.url)), 'utf8'));
const url = (Object.values(out)[0] as Record<string, string>).WsUrl!;
const voteDelay = Number(process.argv[2] ?? 5000);

const ws = new WebSocket(url);
const t0 = Date.now();
let pitchAt = 0;
let voteAt = 0;
let winner = '';
const ready = new Set<string>();
const at = () => `${((Date.now() - (pitchAt || t0)) / 1000).toFixed(2).padStart(6)}s`;
const send = (m: unknown) => ws.send(JSON.stringify(m));
const finish = (code: number, why: string) => { console.log(`\n${code ? 'FAIL' : 'PASS'}: ${why}`); ws.close(); process.exit(code); };
setTimeout(() => finish(1, 'timed out after 120 s'), 120_000);

ws.addEventListener('open', () => send({ t: 'room.create', household: 'smoke' }));
ws.addEventListener('message', (e) => {
  const raw = JSON.parse(String(e.data));
  const parsed = BackendToClientSchema.safeParse(raw);
  if (!parsed.success) console.log(`${at()}  !! schema mismatch for ${raw.t}: ${parsed.error.issues[0]?.message}`);
  const m = raw as BackendToClient;
  switch (m.t) {
    case 'room.created':
      console.log(`room ${m.code}; forge.pitch at t=0`);
      pitchAt = Date.now();
      send({
        t: 'forge.pitch', code: m.code, players: ['Asha', 'Ravi'], settings: DEFAULT_SETTINGS,
        ingredients: ['ladoo', { text: 'sleeping bear', playerId: 'nobody' }, 'lava floor'],
      });
      (globalThis as any).code = m.code;
      break;
    case 'forge.pitches': {
      const ms = Date.now() - pitchAt;
      console.log(`${at()}  forge.pitches (${ms} ms ${ms <= 8000 ? '≤' : '>'} 8 s): ${m.pitches.map((p) => `${p.id} "${p.title}" [${p.blocksSketch.join(',')}]`).join(' | ')}`);
      winner = m.pitches[0]!.id;
      setTimeout(() => {
        voteAt = Date.now();
        console.log(`${at()}  -> forge.vote ${winner}`);
        send({ t: 'forge.vote', code: (globalThis as any).code, pitchId: winner });
        send({ t: 'forge.vote', code: (globalThis as any).code, pitchId: winner }); // duplicate: must be a no-op
        if (ready.has(winner)) setTimeout(() => finish(0, 'winner was already ready before the vote'), 1500);
      }, voteDelay);
      break;
    }
    case 'forge.progress':
      console.log(`${at()}  progress ${m.pitchId} ${String(m.pct).padStart(3)}% ${m.step}`);
      break;
    case 'forge.ready': {
      ready.add(m.pitchId);
      const sinceVote = voteAt ? Date.now() - voteAt : undefined;
      console.log(`${at()}  forge.ready ${m.pitchId} ${m.fallback ? 'FALLBACK' : 'AI'} "${m.spec.title}" blocks=[${m.spec.blocks.map((b) => b.block).join(',')}]${sinceVote !== undefined ? ` (${sinceVote} ms after vote)` : ''}`);
      if (m.pitchId === winner && voteAt) {
        finish(sinceVote! <= 30_000 ? 0 : 1, `winner ready ${sinceVote} ms after vote (${m.fallback ? 'fallback' : 'AI'})`);
      }
      break;
    }
    default:
      console.log(`${at()}  ${JSON.stringify(m).slice(0, 200)}`);
  }
});
