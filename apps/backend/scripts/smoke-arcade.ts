// Live Arcade smoke: npx tsx apps/backend/scripts/smoke-arcade.ts
// room.create (household) -> arcade.save -> list -> play -> played -> list -> delete -> list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BackendToClientSchema, FALLBACK_SPECS } from '@cadabra/spec';

const out = JSON.parse(readFileSync(fileURLToPath(new URL('../outputs.json', import.meta.url)), 'utf8'));
const url = (Object.values(out)[0] as Record<string, string>).WsUrl!;
const household = `smoke-${Date.now()}`;
const spec = { ...FALLBACK_SPECS[0]!, id: `smoke-${Date.now()}` };
const ws = new WebSocket(url);
const queue: any[] = [];
let wake: (() => void) | undefined;
ws.addEventListener('message', (e) => { queue.push(JSON.parse(String(e.data))); wake?.(); });
const next = async (t: string) => {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const i = queue.findIndex((m) => m.t === t || m.t === 'error');
    if (i >= 0) {
      const m = queue.splice(i, 1)[0];
      const p = BackendToClientSchema.safeParse(m);
      if (!p.success) console.log('  !! schema mismatch', m.t, p.error.issues[0]?.message);
      if (m.t !== t) throw new Error(`expected ${t}, got ${JSON.stringify(m)}`);
      return m;
    }
    await new Promise<void>((r) => { wake = r; setTimeout(r, 500); });
  }
  throw new Error(`timeout waiting for ${t}`);
};
const send = (m: unknown) => ws.send(JSON.stringify(m));
const check = (ok: boolean, what: string) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) process.exitCode = 1; };

await new Promise((r) => ws.addEventListener('open', r, { once: true }));
send({ t: 'room.create', household });
await next('room.created');
send({ t: 'arcade.save', household, spec });
send({ t: 'arcade.list', household });
let items = await next('arcade.items');
check(items.games.length === 1 && items.games[0].unplayed, 'saved as unplayed');
send({ t: 'arcade.play', household, specId: spec.id });
check((await next('arcade.game')).spec.id === spec.id, 'play returns spec');
send({ t: 'arcade.played', household, specId: spec.id });
send({ t: 'arcade.list', household });
items = await next('arcade.items');
check(items.games[0].playedCount === 1 && !items.games[0].unplayed, 'played bumped');
send({ t: 'arcade.list', household: 'someone-else' });
await next('error').then(() => check(true, 'household mismatch rejected'));
send({ t: 'arcade.delete', household, specId: spec.id });
send({ t: 'arcade.list', household });
check((await next('arcade.items')).games.length === 0, 'deleted');
ws.close();
