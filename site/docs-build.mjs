// Docs half of the site build: renders the docs pages, the docs home, and the search index.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('yaml', yaml);

export function buildDocs({ here, repo, out, GH, ARCH, icons, esc, slug }) {
  const read = (p) => readFileSync(p, 'utf8');

  const PAGES = [
    { slug: 'index', title: 'Overview', gen: 'home', blurb: 'What Cadabra is, where to start, and what each section covers.' },
    { slug: 'getting-started', title: 'Getting started', src: 'site/content/getting-started.md', icon: 'rocket', blurb: 'Sideload the APK, run it locally, or deploy your own backend.' },
    { slug: 'architecture', title: 'Architecture', src: 'docs/ARCHITECTURE.md', icon: 'layers', blurb: 'The TV app, the phone controller and the serverless backend on AWS.' },
    { slug: 'game-kit', title: 'Game kit', gen: 'kit', src: 'packages/engine/src/catalog.ts', icon: 'blocks', blurb: 'The 9 blocks, every param, and the physics world the AI designs with.' },
    { slug: 'ai-designer', title: 'AI designer and Tweak loop', src: 'site/content/ai-designer.md', icon: 'spark', blurb: 'Tool calls, the bot playtest gate, tweaks, fallbacks and Guardrails.' },
    { slug: 'engine-events', title: 'Engine events', src: 'packages/engine/src/EVENTS.md', icon: 'pulse', blurb: 'GameEvents and entity props: the contract between engine, renderer and TV.' },
    { slug: 'friction-log', title: 'Friction log', src: 'docs/FRICTION_LOG.md', icon: 'flag', blurb: '30 dated entries from building on Bedrock, Lambda and Fire TV.' },
    { slug: 'faq', title: 'FAQ', src: 'site/content/faq.md', icon: 'help', blurb: 'Players, devices, safety, models and licences.' },
  ];
  const href = (p) => `${p.slug}.html`;

  const DOC_ICON = {
    rocket: '<path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2m2.5-1.5L7.5 14.5m3-9c3-3 7.5-3.5 9.5-3.5 0 2-.5 6.5-3.5 9.5l-5 5-6-6 5-5z"/><circle cx="15" cy="9" r="1.6"/>',
    layers: '<path d="M12 3 2.5 8 12 13l9.5-5L12 3z"/><path d="m2.5 12.5 9.5 5 9.5-5"/><path d="m2.5 17 9.5 5 9.5-5"/>',
    blocks: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    spark: '<path d="M12 2.5c.6 5 4.5 8.9 9.5 9.5-5 .6-8.9 4.5-9.5 9.5-.6-5-4.5-8.9-9.5-9.5 5-.6 8.9-4.5 9.5-9.5z"/>',
    pulse: '<path d="M2.5 12h4l2.5-6 4 12 3-8 1.5 2h4"/>',
    flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
    help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 2-2.7 2.4-2.7 4.3"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/>',
  };
  const svgIcon = (k, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DOC_ICON[k] || DOC_ICON.spark}</svg>`;

  // last-updated dates: from git when history is available, else the committed cache (CI is shallow)
  const cacheFile = join(here, 'data/updated.json');
  let cache = existsSync(cacheFile) ? JSON.parse(read(cacheFile)) : {};
  let shallow = true;
  try { shallow = execFileSync('git', ['-C', repo, 'rev-parse', '--is-shallow-repository']).toString().trim() === 'true'; } catch { /* no git */ }
  const srcs = PAGES.map((p) => p.src).filter(Boolean);
  if (!shallow) {
    for (const s of srcs) {
      try {
        const d = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%cs', '--', s]).toString().trim();
        if (d) cache[s] = d;
      } catch { /* untracked */ }
    }
    writeFileSync(cacheFile, JSON.stringify(cache, null, 1) + '\n');
  }
  const fmtDate = (d) => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';

  const LINKMAP = {
    'ARCHITECTURE.md': 'architecture.html', 'FRICTION_LOG.md': 'friction-log.html', 'EVENTS.md': 'engine-events.html',
    'docs/ARCHITECTURE.md': 'architecture.html', 'docs/FRICTION_LOG.md': 'friction-log.html',
  };

  // ---------- sequence diagrams as timelines
  function seqDiagram(src) {
    const alias = {}, order = [];
    const rows = [];
    const actor = (x) => { if (!order.includes(x)) order.push(x); return order.indexOf(x) % 6; };
    for (const raw of src.split('\n').slice(1)) {
      const l = raw.trim();
      if (!l) continue;
      let m;
      if ((m = l.match(/^participant (\S+)(?: as (.+))?$/))) { alias[m[1]] = m[2] || m[1]; actor(m[1]); continue; }
      if ((m = l.match(/^Note over ([^:]+):\s*(.+)$/))) { rows.push(`<li class="note"><span class="note-t">Note</span>${inlineCode(m[2])}</li>`); continue; }
      if ((m = l.match(/^par (.+)$/))) { rows.push(`<li class="group"><span>In parallel</span>${esc(m[1])}</li>`); continue; }
      if (l === 'end') { rows.push('<li class="group-end" aria-hidden="true"></li>'); continue; }
      if ((m = l.match(/^(\w+)\s*(<<->>|-->>|->>|-\)|-->|->)\s*(\w+):\s*(.+)$/))) {
        const [, a, arrow, b, msg] = m;
        const kind = arrow === '<<->>' ? 'both' : arrow.startsWith('--') ? 'reply' : arrow === '-)' ? 'async' : 'call';
        const label = { both: 'both ways', reply: 'reply', async: 'async', call: '' }[kind];
        const chip = (x) => `<span class="who a${actor(x)}">${esc(alias[x] || x)}</span>`;
        const mid = a === b ? '<span class="arr" aria-label="itself">↺</span>' : `<span class="arr" aria-label="${kind === 'both' ? 'to and from' : 'to'}">${kind === 'both' ? '⇄' : '→'}</span>${chip(b)}`;
        rows.push(`<li class="msg ${kind}"><div class="ends">${chip(a)}${mid}${label ? `<em>${label}</em>` : ''}</div><div class="what">${inlineCode(msg)}</div></li>`);
      }
    }
    const legend = order.map((x) => `<span class="who a${order.indexOf(x) % 6}">${esc(alias[x] || x)}</span>`).join('');
    return `<figure class="seq"><div class="seq-head"><span>Sequence</span><div class="legend">${legend}</div></div><ol>${rows.join('')}</ol></figure>\n`;
  }
  function inlineCode(s) { return esc(s).replace(/([a-z]+\.[a-zA-Z.]+|\{[^}]*\})/g, '<code>$1</code>'); }

  // ---------- markdown
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
        const info = (lang || '').trim();
        const lg = (info.match(/^\S*/) || [''])[0].toLowerCase();
        const title = (info.match(/title="([^"]+)"/) || [])[1];
        if (lg === 'mermaid') {
          if (/^\s*flowchart/.test(text)) return `<div class="arch-scroll" tabindex="0" aria-label="Architecture diagram">${ARCH}</div>\n`;
          if (/^\s*sequenceDiagram/.test(text)) return seqDiagram(text);
        }
        const body = lg && hljs.getLanguage(lg) ? hljs.highlight(text, { language: lg }).value : esc(text);
        const badge = lg ? { bash: 'Shell', sh: 'Shell', ts: 'TypeScript', typescript: 'TypeScript', json: 'JSON', yaml: 'YAML' }[lg] || lg : 'Text';
        return `<figure class="code"><figcaption><span class="file">${esc(title || (lg === 'bash' ? 'Terminal' : ''))}</span><span class="lang">${esc(badge)}</span><button class="copy" type="button" aria-label="Copy code">Copy</button></figcaption><pre><code class="hljs${lg ? ` language-${esc(lg)}` : ''}">${body}</code></pre></figure>\n`;
      },
      blockquote({ tokens }) {
        let inner = this.parser.parse(tokens);
        const m = inner.match(/^<p>\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*/);
        if (!m) return `<blockquote>${inner}</blockquote>\n`;
        const kind = { NOTE: 'note', TIP: 'tip', WARNING: 'warning', IMPORTANT: 'note', CAUTION: 'warning' }[m[1]];
        inner = '<p>' + inner.slice(m[0].length);
        const label = { note: 'Note', tip: 'Tip', warning: 'Warning' }[kind];
        const ic = { note: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5v.01"/>', tip: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>', warning: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5M12 17.5v.01"/>' }[kind];
        return `<aside class="callout ${kind}" role="note"><p class="callout-t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ic}</svg>${label}</p>${inner}</aside>\n`;
      },
      link({ href: h0, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        let h = h0;
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
        return `<div class="table" tabindex="0" role="region" aria-label="Table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>\n`;
      },
    },
  });

  // tabs: <!--tabs--> <!--tab:Title--> ... <!--/tabs-->
  let tabSeq = 0;
  function renderMd(src) {
    const holes = [];
    src = src.replace(/<!--tabs-->([\s\S]*?)<!--\/tabs-->/g, (_, body) => {
      const parts = body.split(/<!--tab:([^>]+?)-->/).slice(1);
      const tabs = [];
      for (let i = 0; i < parts.length; i += 2) tabs.push([parts[i].trim(), parts[i + 1]]);
      const g = ++tabSeq;
      const list = tabs.map(([t], i) => `<button type="button" role="tab" id="tab-${g}-${i}" aria-controls="panel-${g}-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${esc(t)}</button>`).join('');
      const panels = tabs.map(([, b], i) => `<div class="tab-panel" role="tabpanel" id="panel-${g}-${i}" aria-labelledby="tab-${g}-${i}"${i ? ' hidden' : ''}>${md.parse(b)}</div>`).join('');
      holes.push(`<div class="tabs" data-tabs><div class="tab-list" role="tablist" aria-label="Ways to get started">${list}</div>${panels}</div>`);
      return `\n\nTABSHOLE${holes.length - 1}\n\n`;
    });
    let html = md.parse(src);
    html = html.replace(/<p>TABSHOLE(\d+)<\/p>/g, (_, i) => holes[+i]);
    html = html.replace(/<ol start="(\d+)">/g, (_, n) => `<ol start="${n}" style="counter-reset: st ${+n - 1}">`);
    return html;
  }

  // ---------- game kit
  function typeOf(p) {
    if (p.enum) return 'enum';
    if (p.anyOf) return p.anyOf.map(typeOf).join(' | ');
    if (p.type === 'array') return `array${p.items && !Array.isArray(p.items) && p.items.type ? ` of ${p.items.type}` : ''}`;
    if (p.type === 'object') return 'object';
    return Array.isArray(p.type) ? p.type.join(' | ') : p.type || 'any';
  }
  function rangeOf(p) {
    if (p.enum) return p.enum.map((v) => `<code>${esc(JSON.stringify(v))}</code>`).join(' ');
    if (p.type === 'integer' || p.type === 'number') {
      if (p.minimum !== undefined && p.maximum !== undefined) return `${p.minimum} – ${p.maximum}`;
      if (p.minimum !== undefined) return `≥ ${p.minimum}`;
      if (p.maximum !== undefined) return `≤ ${p.maximum}`;
    }
    if (p.type === 'string' && p.maxLength) return `≤ ${p.maxLength} chars`;
    if (p.type === 'array' && (p.minItems !== undefined || p.maxItems !== undefined)) return `${p.minItems ?? 0} – ${p.maxItems ?? '∞'} items`;
    if (p.type === 'object' && p.properties) return Object.keys(p.properties).map((k) => `<code>${esc(k)}</code>`).join(' ');
    return '<span class="none">any</span>';
  }
  const fmtDefault = (v) => {
    if (v === undefined) return '<span class="none">none</span>';
    const s = JSON.stringify(v);
    return `<code>${esc(s.length > 32 ? s.slice(0, 30) + '…' : s)}</code>`;
  };
  function paramTable(props) {
    const rows = Object.entries(props || {}).map(([k, p]) =>
      `<tr data-q="${esc((k + ' ' + (p.description || '')).toLowerCase())}"><td class="pn"><code>${esc(k)}</code></td><td class="pt"><span class="t t-${esc(typeOf(p).split(' ')[0])}">${esc(typeOf(p))}</span></td><td class="pr">${rangeOf(p)}</td><td class="pd">${fmtDefault(p.default)}</td><td class="px">${esc(p.description || '')}</td></tr>`).join('');
    return `<div class="table params-wrap" tabindex="0" role="region" aria-label="Params"><table class="params"><thead><tr><th>Param</th><th>Type</th><th>Range</th><th>Default</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function kitPage() {
    const k = JSON.parse(read(join(here, 'data/kit.json')));
    const total = k.kit.reduce((n, b) => n + Object.keys(b.params.properties || {}).length, 0);
    let h = '<h1>Game kit</h1>';
    h += `<p class="lede">Every game in Cadabra, built-in or AI-made, is a <code>GameSpec</code> that composes these <strong>${k.kit.length} blocks</strong>. This page is generated from <code>kitCatalog()</code>, the same catalogue the AI designer reads through <code>list_blocks</code> and <code>get_block_schema</code>.</p>`;
    h += `<div class="kit-filter"><label for="kit-q" class="vh">Filter blocks and params</label><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><input id="kit-q" type="search" placeholder="Filter params, like gravity, dash or score" autocomplete="off"><span id="kit-count" aria-live="polite"></span></div>`;
    h += '<div class="kit-grid">' + k.kit.map((b) => `<a class="kit-chip" href="#${b.id}"><b>${esc(b.name)}</b><span>${Object.keys(b.params.properties || {}).length} params</span></a>`).join('') + '</div>';
    for (const b of k.kit) {
      const n = Object.keys(b.params.properties || {}).length;
      h += `<section class="block-card" id="${b.id}" data-name="${esc((b.name + ' ' + b.id + ' ' + b.summary).toLowerCase())}">`;
      h += `<header><h2 id="h-${b.id}"><a class="anchor" href="#${b.id}" aria-hidden="true" tabindex="-1">#</a>${esc(b.name)}</h2><code class="bid">${b.id}</code></header>`;
      h += `<p>${esc(b.summary)}</p>`;
      h += `<div class="meta"><span><small>Controls</small>${b.controls.map((c) => `<code>${esc(c)}</code>`).join(' ') || 'none'}</span><span><small>Arena</small>${b.arenaKinds.map((c) => `<code>${esc(c)}</code>`).join(' ')}</span><span><small>Params</small>${n}</span></div>`;
      h += paramTable(b.params.properties);
      h += '</section>';
    }
    const w = k.world;
    h += `<section class="block-card world" id="world" data-name="physics world planck gravity props looks"><header><h2 id="h-world"><a class="anchor" href="#world" aria-hidden="true" tabindex="-1">#</a>Physics world</h2><code class="bid">spec.world</code></header>`;
    h += '<p><code>spec.world</code> turns on rigid-body physics (planck.js) and adds physics props.</p><ul>' + w.notes.map((s) => `<li>${esc(s)}</li>`).join('') + '</ul>';
    h += '<h3 id="world-physics"><code>world.physics</code></h3>' + paramTable(w.schema.properties.physics.properties);
    const props = w.schema.properties.props;
    if (props) {
      const item = props.items || props;
      h += `<h3 id="world-props"><code>world.props</code></h3><p>${esc(props.description || 'Physics props: balls, crates, bumpers and barrels.')}</p>`;
      if (item.properties) h += paramTable(item.properties);
      else for (const v of item.anyOf || item.oneOf || []) if (v.properties) h += paramTable(v.properties);
    }
    h += '</section>';
    h += `<h2 id="looks"><a class="anchor" href="#looks" aria-hidden="true" tabindex="-1">#</a>Looks</h2><p><code>theme.look</code> is one of ${w.looks.map((l) => `<code>${esc(l)}</code>`).join(', ')}. Set <code>theme.sfxSet</code> to the same id for matching music and sound.</p>`;
    h += '<p id="kit-empty" class="kit-empty" hidden>No block or param matches that filter.</p>';
    return h;
  }

  // ---------- docs home
  function homePage() {
    const cards = PAGES.filter((p) => p.slug !== 'index').map((p) => `<a class="doc-card" href="${href(p)}">${svgIcon(p.icon)}<b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>`).join('');
    return `<h1>Cadabra docs</h1>
<p class="lede">Cadabra is a Fire TV party game where the room invents the game. Phones send ideas, an AI designer builds a physics game from 9 tested blocks, bots playtest it, and the TV runs it at about 59 fps. These docs cover playing it, running it, and how it works inside.</p>
<h2 id="start-here"><a class="anchor" href="#start-here" aria-hidden="true" tabindex="-1">#</a>Start here</h2>
<ol class="path">
  <li><a href="getting-started.html"><b>Install it</b><span>Sideload the v1.0 APK on a Fire TV, or run the TV app in a desktop browser.</span></a></li>
  <li><a href="architecture.html"><b>See how it fits together</b><span>The authoritative TV, the phone controller, and one CDK stack on AWS.</span></a></li>
  <li><a href="game-kit.html"><b>Learn the kit</b><span>The blocks and params every game is made of, built-in or AI-made.</span></a></li>
  <li><a href="ai-designer.html"><b>Watch the AI build</b><span>Tool calls, the playtest gate, and the 5-second tweak loop.</span></a></li>
</ol>
<h2 id="all-sections"><a class="anchor" href="#all-sections" aria-hidden="true" tabindex="-1">#</a>All sections</h2>
<div class="doc-cards">${cards}</div>
<aside class="callout tip" role="note"><p class="callout-t"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>Tip</p><p>Press <kbd>/</kbd> on any docs page to search every section.</p></aside>`;
  }

  // ---------- search index + layout
  const index = [];
  const toText = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<button[\s\S]*?<\/button>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  function addToIndex(page, html) {
    for (const part of html.split(/(?=<h[23] id=")/)) {
      const m = part.match(/^<h[23] id="([^"]+)">([\s\S]*?)<\/h[23]>/);
      const section = m ? toText(m[2].replace(/<a class="anchor"[^>]*>#<\/a>/, '')) : page.title;
      const text = toText(m ? part.slice(m[0].length) : part.replace(/<h1>[\s\S]*?<\/h1>/, ''));
      const anchor = m ? m[1].replace(/^h-/, '') : '';
      index.push({ p: page.slug, t: page.title, s: section, a: anchor, x: text.slice(0, 1600) });
    }
  }

  function layout(page, body, toc, i) {
    const list = PAGES;
    const prev = list[i - 1], next = list[i + 1];
    const nav = list.map((p) => `<li><a href="${href(p)}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${p.icon ? svgIcon(p.icon, 'ico-s') : svgIcon('spark', 'ico-s')}${esc(p.title)}</a></li>`).join('');
    const tocHtml = toc.length > 1 ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${toc.map(([id, t]) => `<li><a href="#${id}">${t}</a></li>`).join('')}</ul></nav>` : '<div class="toc" aria-hidden="true"></div>';
    const date = page.src ? fmtDate(cache[page.src]) : '';
    const foot = page.src ? `<div class="doc-foot"><a href="${GH}/${page.gen === 'kit' ? 'blob' : 'edit'}/main/${page.src}">${page.gen === 'kit' ? 'View the source on GitHub' : 'Edit this page on GitHub'}</a>${date ? `<span>Last updated ${date}</span>` : ''}</div>` : '';
    const card = (p, cls, label) => p ? `<a class="${cls}" href="${href(p)}"><small>${label}</small><b>${esc(p.title)}</b><span>${esc(p.blurb)}</span></a>` : '<span></span>';
    const canon = page.slug === 'index' ? 'docs/' : `docs/${page.slug}.html`;
    return icons(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.slug === 'index' ? 'Cadabra docs' : `${esc(page.title)} | Cadabra docs`}</title>
<meta name="description" content="${esc(page.blurb)}">
<meta name="theme-color" content="#05060c">
<link rel="canonical" href="https://maanavkrishna.github.io/cadabra/${canon}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Cadabra">
<meta property="og:title" content="${esc(page.title)} | Cadabra docs">
<meta property="og:description" content="${esc(page.blurb)}">
<meta property="og:image" content="https://maanavkrishna.github.io/cadabra/media/og.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../site.css">
<link rel="stylesheet" href="../docs.css">
<style>@view-transition { navigation: auto; }</style>
</head>
<body class="docs">
<a class="skip" href="#content">Skip to content</a>
<header class="bar solid">
  <button class="menu-btn" type="button" aria-expanded="false" aria-controls="side" aria-label="Open docs navigation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
  <a class="mark" href="../" aria-label="Cadabra home">{{SPARK}}cadabra</a>
  <a class="crumb" href="./">Docs</a>
  <nav aria-label="Main">
    <a class="opt" href="../#how">How it works</a>
    <a class="opt" href="../#games">Games</a>
    <a class="opt" href="https://github.com/MaanavKrishna/cadabra/releases/tag/v1.0">Download</a>
    <a class="gh" href="${GH}" aria-label="Cadabra on GitHub">{{GH}}</a>
  </nav>
</header>
<div class="scrim" hidden></div>
<div class="docs-grid">
  <aside class="side" id="side" aria-label="Docs navigation">
    <div class="search" role="search">
      <label class="vh" for="q">Search the docs</label>
      <svg class="search-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <input id="q" type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="results" aria-autocomplete="list" aria-describedby="q-hint">
      <kbd id="q-hint" aria-hidden="true">/</kbd>
      <div id="results" class="results" role="listbox" aria-label="Search results" hidden></div>
    </div>
    <nav aria-label="Docs"><ul class="side-nav">${nav}</ul></nav>
    <p class="side-foot"><a href="https://github.com/MaanavKrishna/cadabra/releases/tag/v1.0">Download the v1.0 APK</a></p>
  </aside>
  <main id="content" class="prose${page.slug === 'index' ? ' home-doc' : ''}${page.gen === 'kit' ? ' kit' : ''}">
${body}
    ${foot}
    <nav class="pager" aria-label="Previous and next page">${card(prev, 'prev', 'Previous')}${card(next, 'next', 'Next')}</nav>
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
    else if (page.gen === 'home') html = homePage();
    else html = renderMd(read(join(repo, page.src)));
    const toc = [...html.matchAll(/<h2 id="([^"]+)">(?:<a class="anchor"[^>]*>#<\/a>)?([\s\S]*?)<\/h2>/g)].map((m) => [m[1], m[2]]);
    if (page.gen !== 'home') addToIndex(page, html);
    writeFileSync(join(out, 'docs', `${page.slug}.html`), layout(page, html, toc, i));
  });
  writeFileSync(join(out, 'search-index.json'), JSON.stringify(index));
  return { pages: PAGES.length, sections: index.length };
}
