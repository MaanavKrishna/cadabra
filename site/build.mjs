// Builds the static site into site/dist. No framework: one landing page, docs pages rendered
// from the repo's Markdown (docs/, packages/engine/src/EVENTS.md) and site/content, a game-kit
// page generated from site/data/kit.json, and a search index.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

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
  ['Join', 'Scan the QR code on the TV. Phones join in the browser and pick an orb or a selfie avatar. Bots fill empty seats.', '', 'media/phone-join-play.jpg', 'Phone controller screens: join, avatar, play, results', 'The phone is the controller', 'contain'],
  ['Idea Storm', 'Everyone types ideas like "laser sharks" or "zero gravity", and they float onto the TV.', '30 s', 'media/tv-storm.jpg', 'Ideas from phones floating onto the TV', 'Idea Storm on the TV'],
  ['Three pitches', 'The AI pitches three games, each with a title, a hook and a look. The room votes on their phones.', '~6 s', 'media/tv-vote.jpg', 'Three pitch cards with live vote bars', 'Voting on three AI pitches'],
  ['Forge', 'The AI designer builds the winner with tool calls, then bots play a full round to prove it works.', '4–7 s', 'media/tv-forge.jpg', 'The Forge screen while bots playtest the game', 'Bots playtest before you do'],
  ['Play', 'A real physics game at about 59 fps, and each phone becomes the controller that game needs.', '45 s', 'media/tv-crate-crash-stick.jpg', 'Crate Crash running on a Fire TV Stick', 'Crate Crash, captured on the stick'],
  ['Tweak', 'Tap "Low gravity" or "More chaos", or type your own rule. The AI patches the game and it replays.', '~5 s', 'media/tv-tweak-changed.jpg', 'What changed card: gravity, bounce and chaos changes', 'The "What changed" card'],
  ['Arcade', 'Every game the room makes is saved for the household, ready to replay or remix.', '', 'media/games/arcade.jpg', 'The Arcade row of saved games', 'Saved games in the Arcade'],
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
  `<button class="tile" type="button" role="tab" aria-controls="home" data-name="${esc(name)}" data-look="${look}" data-desc="${esc(desc)}"><img src="media/games/${id}.jpg" alt="" width="1600" height="900" loading="lazy" decoding="async"><span>${name}</span></button>`).join('');
const bgHtml = GAMES.map(([id], i) => i === 0
  ? `<img class="on" src="media/games/${id}.jpg" alt="" width="1600" height="900" loading="lazy" decoding="async">`
  : `<img data-src="media/games/${id}.jpg" alt="" width="1600" height="900" decoding="async">`).join('');

let index = read(join(here, 'src/index.html'))
  .replace('{{STEPS}}', stepsHtml).replace('{{TILES}}', tilesHtml).replace('{{HOME_BG}}', bgHtml).replace('{{ARCH}}', ARCH);
writeFileSync(join(out, 'index.html'), icons(index));

// ---------------------------------------------------------------- docs
const PAGES = [
  { slug: 'getting-started', title: 'Getting started', src: 'site/content/getting-started.md', blurb: 'Sideload the APK, run it locally, or deploy your own backend.' },
  { slug: 'architecture', title: 'Architecture', src: 'docs/ARCHITECTURE.md', blurb: 'The TV app, the phone controller and the serverless backend.' },
  { slug: 'game-kit', title: 'Game kit', gen: 'kit', blurb: 'The 9 blocks, their params, and the physics world the AI designs with.' },
  { slug: 'ai-designer', title: 'AI designer and Tweak loop', src: 'site/content/ai-designer.md', blurb: 'Tool calls, the bot playtest gate, tweaks and fallbacks.' },
  { slug: 'engine-events', title: 'Engine events', src: 'packages/engine/src/EVENTS.md', blurb: 'GameEvents and entity props: the renderer and TV contract.' },
  { slug: 'friction-log', title: 'Friction log', src: 'docs/FRICTION_LOG.md', blurb: '30 dated entries from building on Bedrock, Lambda and Fire TV.' },
  { slug: 'faq', title: 'FAQ', src: 'site/content/faq.md', blurb: 'Players, devices, safety, models and licences.' },
];
const LINKMAP = {
  'ARCHITECTURE.md': 'architecture.html', 'FRICTION_LOG.md': 'friction-log.html', 'EVENTS.md': 'engine-events.html',
  'docs/ARCHITECTURE.md': 'architecture.html', 'docs/FRICTION_LOG.md': 'friction-log.html',
};

function seqDiagram(src) {
  const alias = {};
  const rows = [];
  for (const raw of src.split('\n').slice(1)) {
    const l = raw.trim();
    if (!l) continue;
    let m;
    if ((m = l.match(/^participant (\S+)(?: as (.+))?$/))) { alias[m[1]] = m[2] || m[1]; continue; }
    if ((m = l.match(/^Note over ([^:]+):\s*(.+)$/))) { rows.push(`<li class="note">${esc(m[2])}</li>`); continue; }
    if ((m = l.match(/^par (.+)$/))) { rows.push(`<li class="group">In parallel: ${esc(m[1])}</li>`); continue; }
    if (l === 'end') { rows.push('<li class="group end" aria-hidden="true"></li>'); continue; }
    if ((m = l.match(/^(\w+)\s*(<<->>|-->>|->>|-\)|-->|->)\s*(\w+):\s*(.+)$/))) {
      const [, a, arrow, b, msg] = m;
      const name = (x) => esc(alias[x] || x);
      const kind = arrow === '<<->>' ? 'both' : arrow.startsWith('--') ? 'reply' : arrow === '-)' ? 'async' : 'call';
      const sym = kind === 'both' ? '⇄' : '→';
      const self = a === b ? ' self' : '';
      rows.push(`<li class="msg ${kind}${self}"><span class="who">${name(a)}</span><span class="arr" aria-label="${kind === 'both' ? 'to and from' : 'to'}">${sym}</span><span class="who">${name(b)}</span><span class="what">${inlineCode(msg)}</span></li>`);
    }
  }
  return `<figure class="seq"><ol>${rows.join('')}</ol><figcaption>Sequence, top to bottom. Dimmed rows are replies, italic rows are async.</figcaption></figure>`;
}
function inlineCode(s) {
  // mermaid labels: wrap {...} payloads and dotted message names as code
  return esc(s).replace(/([a-z]+\.[a-zA-Z.]+|\{[^}]*\})/g, '<code>$1</code>');
}

function makeMarked() {
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        if (depth === 1) return `<h1>${html}</h1>\n`;
        const id = slug(html);
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${html}</h${depth}>\n`;
      },
      code({ text, lang }) {
        if (lang === 'mermaid') {
          if (/^\s*flowchart/.test(text)) return `<div class="arch-scroll" tabindex="0" aria-label="Architecture diagram">${ARCH}</div>\n`;
          if (/^\s*sequenceDiagram/.test(text)) return seqDiagram(text);
        }
        return `<pre><code${lang ? ` class="lang-${esc(lang)}"` : ''}>${esc(text)}</code></pre>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        let h = href;
        if (LINKMAP[h]) h = LINKMAP[h];
        else if (/^(?!https?:|#|mailto:)[^/][^:]*\.(md|ts|txt)$/.test(h) || /^(docs|apps|packages|scripts)\//.test(h)) {
          const path = h.includes('/') ? h.replace(/^\.\.\//, '') : `docs/${h}`;
          h = `${GH}/blob/main/${path}`;
        } else if (h === 'LICENSE' || h === '../LICENSE') h = `${GH}/blob/main/LICENSE`;
        const ext = /^https?:/.test(h);
        return `<a href="${esc(h)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener"' : ''}>${text}</a>`;
      },
      table(token) {
        const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</th>`).join('');
        const body = token.rows.map((r) => `<tr>${r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
        return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`;
      },
    },
  });
  return md;
}
const marked = makeMarked();

// game kit page from the engine's own catalog
function typeOf(p) {
  if (p.enum) return p.enum.map((v) => `<code>${esc(JSON.stringify(v))}</code>`).join(' ');
  if (p.anyOf) return p.anyOf.map(typeOf).join(' or ');
  if (p.type === 'array') return `array of ${p.items && !Array.isArray(p.items) ? typeOf(p.items) : 'tuples'}`;
  if (p.type === 'object') return p.properties ? `object { ${Object.keys(p.properties).map((k) => `<code>${esc(k)}</code>`).join(', ')} }` : 'object';
  let t = Array.isArray(p.type) ? p.type.join(' | ') : p.type || 'any';
  if (p.type === 'integer' || p.type === 'number') {
    if (p.minimum !== undefined && p.maximum !== undefined) t += ` ${p.minimum} to ${p.maximum}`;
    else if (p.minimum !== undefined) t += ` ≥ ${p.minimum}`;
    else if (p.maximum !== undefined) t += ` ≤ ${p.maximum}`;
  }
  if (p.type === 'string' && p.maxLength) t += `, ≤ ${p.maxLength} chars`;
  return esc(t);
}
const fmtDefault = (v) => v === undefined ? '' : `<code>${esc(JSON.stringify(v).length > 40 ? JSON.stringify(v).slice(0, 38) + '…' : JSON.stringify(v))}</code>`;
function paramTable(props) {
  const rows = Object.entries(props || {}).map(([k, p]) =>
    `<tr><td><code>${esc(k)}</code></td><td>${typeOf(p)}</td><td>${fmtDefault(p.default)}</td><td>${esc(p.description || '')}</td></tr>`).join('');
  return `<div class="table"><table class="params"><thead><tr><th>Param</th><th>Type</th><th>Default</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function kitPage() {
  const k = JSON.parse(read(join(here, 'data/kit.json')));
  let h = '<h1>Game kit</h1>';
  h += `<p class="lede">Every game in Cadabra, built-in or AI-made, is a <code>GameSpec</code> that composes these <strong>${k.kit.length} blocks</strong>. This page is generated from <code>kitCatalog()</code> in <code>packages/engine/src/catalog.ts</code>, the same catalogue the AI designer reads through <code>list_blocks</code> and <code>get_block_schema</code>.</p>`;
  h += '<div class="table"><table><thead><tr><th>Block</th><th>Id</th><th>Controls</th><th>Params</th></tr></thead><tbody>';
  h += k.kit.map((b) => `<tr><td><a href="#${b.id}">${esc(b.name)}</a></td><td><code>${b.id}</code></td><td>${b.controls.map(esc).join(', ') || 'none'}</td><td>${Object.keys(b.params.properties || {}).length}</td></tr>`).join('');
  h += '</tbody></table></div>';
  for (const b of k.kit) {
    const n = Object.keys(b.params.properties || {}).length;
    h += `<h2 id="${b.id}"><a class="anchor" href="#${b.id}" aria-hidden="true" tabindex="-1">#</a>${esc(b.name)}</h2>`;
    h += `<p>${esc(b.summary)}</p>`;
    h += `<p class="meta"><span>Id <code>${b.id}</code></span><span>Controls: ${b.controls.map((c) => `<code>${esc(c)}</code>`).join(' ') || 'none'}</span><span>Arena: ${b.arenaKinds.map((c) => `<code>${esc(c)}</code>`).join(' ')}</span></p>`;
    h += n > 14 ? `<details><summary>All ${n} params</summary>${paramTable(b.params.properties)}</details>` : paramTable(b.params.properties);
  }
  const w = k.world;
  h += `<h2 id="world"><a class="anchor" href="#world" aria-hidden="true" tabindex="-1">#</a>Physics world</h2>`;
  h += '<p><code>spec.world</code> turns on rigid-body physics (planck.js) and adds physics props. From <code>worldCatalog()</code>:</p><ul>' + w.notes.map((s) => `<li>${esc(s)}</li>`).join('') + '</ul>';
  h += `<h3 id="world-physics"><a class="anchor" href="#world-physics" aria-hidden="true" tabindex="-1">#</a><code>world.physics</code></h3>`;
  h += paramTable(w.schema.properties.physics.properties);
  const props = w.schema.properties.props;
  if (props) {
    h += `<h3 id="world-props"><a class="anchor" href="#world-props" aria-hidden="true" tabindex="-1">#</a><code>world.props</code></h3>`;
    const item = props.items || props;
    h += `<p>${esc(props.description || 'Physics props: balls, crates, bumpers and barrels.')}</p>`;
    if (item.properties) h += paramTable(item.properties);
    else if (item.anyOf || item.oneOf) for (const v of item.anyOf || item.oneOf) if (v.properties) h += paramTable(v.properties);
  }
  h += `<h2 id="looks"><a class="anchor" href="#looks" aria-hidden="true" tabindex="-1">#</a>Looks</h2><p><code>theme.look</code> is one of ${w.looks.map((l) => `<code>${esc(l)}</code>`).join(', ')}. Set <code>theme.sfxSet</code> to the same id for matching music and sound.</p>`;
  return h;
}

const index_ = [];
function toText(html) { return html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(); }
function addToIndex(page, html) {
  const parts = html.split(/(?=<h[23] id=")/);
  for (const part of parts) {
    const m = part.match(/^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/);
    const section = m ? toText(m[2].replace(/<a class="anchor"[^>]*>#<\/a>/, '')) : page.title;
    const text = toText(m ? part.slice(m[0].length) : part.replace(/<h1>[\s\S]*?<\/h1>/, ''));
    index_.push({ p: page.slug, t: page.title, s: section, a: m ? m[1] : '', x: text.slice(0, 1600) });
  }
}

function layout(page, body, toc, i) {
  const prev = PAGES[i - 1], next = PAGES[i + 1];
  const nav = PAGES.map((p) => `<li><a href="${p.slug}.html"${p.slug === page.slug ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('');
  const tocHtml = toc.length > 1 ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${toc.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join('')}</ul></nav>` : '<div class="toc"></div>';
  return icons(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} | Cadabra docs</title>
<meta name="description" content="${esc(page.blurb)}">
<meta name="theme-color" content="#05060c">
<link rel="canonical" href="https://maanavkrishna.github.io/cadabra/docs/${page.slug}.html">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Cadabra">
<meta property="og:title" content="${esc(page.title)} | Cadabra docs">
<meta property="og:description" content="${esc(page.blurb)}">
<meta property="og:image" content="https://maanavkrishna.github.io/cadabra/media/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../site.css">
<link rel="stylesheet" href="../docs.css">
</head>
<body class="docs">
<a class="skip" href="#content">Skip to content</a>
<header class="bar solid">
  <a class="mark" href="../" aria-label="Cadabra home">{{SPARK}}cadabra</a>
  <span class="crumb">Docs</span>
  <button class="menu-btn" type="button" aria-expanded="false" aria-controls="side">Menu</button>
  <nav aria-label="Main">
    <a class="opt" href="../#how">How it works</a>
    <a class="opt" href="../#games">Games</a>
    <a href="getting-started.html" aria-current="page">Docs</a>
    <a class="gh" href="${GH}" aria-label="Cadabra on GitHub">{{GH}}</a>
  </nav>
</header>
<div class="docs-grid">
  <aside class="side" id="side">
    <div class="search" role="search">
      <label class="vh" for="q">Search the docs</label>
      <input id="q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" aria-controls="results" aria-describedby="q-hint">
      <kbd id="q-hint" aria-hidden="true">/</kbd>
      <div id="results" class="results" role="listbox" aria-label="Search results" hidden></div>
    </div>
    <nav aria-label="Docs"><ul class="side-nav">${nav}</ul></nav>
    <p class="side-foot"><a href="https://github.com/MaanavKrishna/cadabra/releases/tag/v1.0">Download v1.0 APK</a></p>
  </aside>
  <main id="content" class="prose">
${body}
    <nav class="pager" aria-label="Previous and next page">
      ${prev ? `<a class="prev" href="${prev.slug}.html"><small>Previous</small>${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="${next.slug}.html"><small>Next</small>${esc(next.title)}</a>` : '<span></span>'}
    </nav>
    <p class="edit">${page.src ? `Source: <a href="${GH}/blob/main/${page.src}">${esc(page.src)}</a>` : `Generated from <a href="${GH}/blob/main/packages/engine/src/catalog.ts">packages/engine/src/catalog.ts</a>`}</p>
  </main>
  ${tocHtml}
</div>
<script src="../docs.js" defer></script>
</body>
</html>
`);
}

PAGES.forEach((page, i) => {
  let html;
  if (page.gen === 'kit') html = kitPage();
  else {
    let src = read(join(repo, page.src));
    html = marked.parse(src);
  }
  const toc = [...html.matchAll(/<h2 id="([^"]+)">(?:<a class="anchor"[^>]*>#<\/a>)?([\s\S]*?)<\/h2>/g)].map((m) => [m[1], m[2]]);
  addToIndex(page, html);
  writeFileSync(join(out, 'docs', `${page.slug}.html`), layout(page, html, toc, i));
});
writeFileSync(join(out, 'docs', 'index.html'), '<!doctype html><meta charset="utf-8"><title>Cadabra docs</title><meta http-equiv="refresh" content="0; url=getting-started.html"><link rel="canonical" href="getting-started.html"><a href="getting-started.html">Getting started</a>');
writeFileSync(join(out, 'search-index.json'), JSON.stringify(index_));
writeFileSync(join(out, '404.html'), icons(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found | Cadabra</title><link rel="icon" href="/cadabra/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/cadabra/site.css"></head><body><main class="sec" style="min-height:100vh;display:grid;place-items:center"><div><h2>This page isn't here.</h2><p class="intro">The link may be old. Start from the <a href="/cadabra/">home page</a> or the <a href="/cadabra/docs/getting-started.html">docs</a>.</p></div></main></body></html>`));
console.log(`built ${PAGES.length} docs pages, ${index_.length} search sections -> ${out}`);
