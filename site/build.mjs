// Builds the static site into site/dist. No framework: one landing page, docs pages rendered
// from the repo's Markdown (docs/, packages/engine/src/EVENTS.md) and site/content, a game-kit
// page generated from site/data/kit.json, and a search index.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocs } from './docs-build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const out = join(here, 'dist');
const read = (p) => readFileSync(p, 'utf8');
const GH = 'https://github.com/MaanavKrishna/cadabra';

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'docs'), { recursive: true });
cpSync(join(here, 'public'), out, { recursive: true });
cpSync(join(here, 'src/site.css'), join(out, 'site.css'));
cpSync(join(here, 'src/docs.css'), join(out, 'docs.css'));
cpSync(join(here, 'src/site.js'), join(out, 'site.js'));
cpSync(join(here, 'src/docs.js'), join(out, 'docs.js'));
cpSync(join(here, 'src/motion.css'), join(out, 'motion.css'));
cpSync(join(here, 'src/motion.js'), join(out, 'motion.js'));
writeFileSync(join(out, '.nojekyll'), '');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[`'"().,:;!?/\\]+/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const ICON = {
  SPARK: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 0c.7 6.4 5.6 11.3 12 12-6.4.7-11.3 5.6-12 12C11.3 17.6 6.4 12.7 0 12 6.4 11.3 11.3 6.4 12 0z"/></svg>',
  GH: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
  DL: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg>',
};
writeFileSync(join(out, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#05060c"/><path fill="#fff" d="M12 3c.5 4.6 4 8.1 9 9-5 .9-8.5 4.4-9 9-.5-4.6-4-8.1-9-9 5-.9 8.5-4.4 9-9z"/></svg>');
const icons = (s) => s.replace(/\{\{(SPARK|GH|DL)\}\}/g, (_, k) => ICON[k]);
const ARCH = read(join(here, 'src/arch.svg'));

// ---------------------------------------------------------------- landing
const STEPS = [
  ['Join', 'Scan the QR code on the TV. Phones join in the browser and pick an orb or a selfie avatar. Bots fill empty seats.', '', 'media/phone-join-play.webp', 'Phone controller screens: join, avatar, play, results', 'The phone is the controller', 'contain'],
  ['Idea Storm', 'Everyone types ideas like "laser sharks" or "zero gravity", and they float onto the TV.', '30 s', 'media/tv-storm.webp', 'Ideas from phones floating onto the TV', 'Idea Storm on the TV'],
  ['Three pitches', 'The AI pitches three games, each with a title, a hook and a look. The room votes on their phones.', '~6 s', 'media/tv-vote.webp', 'Three pitch cards with live vote bars', 'Voting on three AI pitches'],
  ['Forge', 'The AI designer builds the winner with tool calls, then bots play a full round to prove it works.', '4–7 s', 'media/tv-forge.webp', 'The Forge screen while bots playtest the game', 'Bots playtest before you do'],
  ['Play', 'A real physics game at about 59 fps, and each phone becomes the controller that game needs.', '45 s', 'media/tv-crate-crash-stick.webp', 'Crate Crash running on a Fire TV Stick', 'Crate Crash, captured on the stick'],
  ['Tweak', 'Tap "Low gravity" or "More chaos", or type your own rule. The AI patches the game and it replays.', '~5 s', 'media/tv-tweak-changed.webp', 'What changed card: gravity, bounce and chaos changes', 'The "What changed" card'],
  ['Arcade', 'Every game the room makes is saved for the household, ready to replay or remix.', '', 'media/games/arcade.webp', 'The Arcade row of saved games', 'Saved games in the Arcade'],
];
const stepsHtml = STEPS.map(([t, d, time, img, alt, cap, fit], i) =>
  `<li><button type="button" role="tab" id="step-${i}" data-img="${img}" data-alt="${esc(alt)}" data-cap="${esc(cap)}" data-fit="${fit || 'cover'}"><span class="t">${t}</span><span class="time">${time}</span><span class="d">${esc(d)}</span></button></li>`).join('\n        ');

const GAMES = [
  ['ring-out', 'Ring Out', 'toybox', 'Bumper sumo on a floating ring. Dash rivals off the edge.'],
  ['overload', 'Overload', 'cosmos', 'Pass the unstable core before it blows. Every blast throws everyone.'],
  ['paint-wars', 'Paint Wars', 'retro', 'Paint the floor in your team colour. Most floor wins.'],
  ['core-rush', 'Core Rush', 'cosmos', 'Carry cores home. Dash into carriers to knock them loose.'],
  ['neon-dash', 'Neon Dash', 'neon', 'A four-lane light race through laser gates.'],
  ['rocket-ball', 'Rocket Ball', 'neon', '2v2 football with a big bouncy ball, power shots, a comeback goal and multiball.'],
  ['crate-crash', 'Crate Crash', 'toybox', "Knock rivals' crates out of their zones. Barrels explode."],
];
const tilesHtml = GAMES.map(([id, name, look, desc], i) =>
  `<button class="tile" type="button" role="tab" aria-controls="home" data-name="${esc(name)}" data-look="${look}" data-desc="${esc(desc)}"><img src="media/games/${id}-800.webp" alt="" width="800" height="450" loading="lazy" decoding="async"><span>${name}</span></button>`).join('');
const bgHtml = GAMES.map(([id], i) => i === 0
  ? `<img class="on" src="media/games/${id}.webp" srcset="media/games/${id}-800.webp 800w, media/games/${id}.webp 1600w" sizes="(max-width: 1400px) 100vw, 1320px" alt="" width="1600" height="900" loading="lazy" decoding="async">`
  : `<img data-src="media/games/${id}.webp" data-srcset="media/games/${id}-800.webp 800w, media/games/${id}.webp 1600w" sizes="(max-width: 1400px) 100vw, 1320px" alt="" width="1600" height="900" decoding="async">`).join('');

let index = read(join(here, 'src/index.html'))
  .replace('{{STEPS}}', stepsHtml).replace('{{TILES}}', tilesHtml).replace('{{HOME_BG}}', bgHtml).replace('{{ARCH}}', ARCH);
writeFileSync(join(out, 'index.html'), icons(index));

// ---------------------------------------------------------------- docs
const res = buildDocs({ here, repo, out, GH, ARCH, icons, esc, slug });
writeFileSync(join(out, '404.html'), icons(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found | Cadabra</title><link rel="icon" href="/cadabra/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/cadabra/site.css"></head><body><main class="sec" style="min-height:100vh;display:grid;place-items:center"><div><h2>This page isn't here.</h2><p class="intro">The link may be old. Start from the <a href="/cadabra/">home page</a> or the <a href="/cadabra/docs/getting-started.html">docs</a>.</p></div></main></body></html>`));
console.log(`built ${res.pages} docs pages, ${res.sections} search sections -> ${out}`);
