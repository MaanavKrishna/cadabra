(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const q = $('#q');
  const box = $('#results');
  let data = null;
  let sel = -1;

  // ---------- mobile drawer
  const menu = $('.menu-btn');
  const side = $('#side');
  const scrim = $('.scrim');
  const setDrawer = (open) => {
    side.classList.toggle('open', open);
    menu.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-label', open ? 'Close docs navigation' : 'Open docs navigation');
    scrim.hidden = !open;
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) setTimeout(() => (side.querySelector('[aria-current="page"]') || q).focus(), 50);
  };
  menu?.addEventListener('click', () => setDrawer(!side.classList.contains('open')));
  scrim?.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && side.classList.contains('open')) { setDrawer(false); menu.focus(); } });
  matchMedia('(min-width: 861px)').addEventListener('change', (m) => { if (m.matches) setDrawer(false); });

  // ---------- search
  const load = () => data || (data = fetch('../search-index.json').then((r) => r.json()).catch(() => []));
  const escH = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escR = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mark = (s, terms) => escH(s).replace(new RegExp(`(${terms.map((t) => escR(escH(t))).join('|')})`, 'gi'), '<mark>$1</mark>');
  function snippet(text, terms) {
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    const start = Math.max(0, at - 50);
    const s = (start > 0 ? '…' : '') + text.slice(start, start + 170) + (text.length > start + 170 ? '…' : '');
    return mark(s, terms);
  }
  async function search() {
    const raw = q.value.trim().toLowerCase();
    if (raw.length < 2) { box.hidden = true; box.innerHTML = ''; q.setAttribute('aria-expanded', 'false'); return; }
    const terms = raw.split(/\s+/).filter(Boolean);
    const all = await load();
    const hits = [];
    for (const e of all) {
      const s = e.s.toLowerCase(), x = e.x.toLowerCase(), t = e.t.toLowerCase();
      let score = 0, ok = true;
      for (const term of terms) {
        const inS = s.includes(term), inX = x.includes(term), inT = t.includes(term);
        if (!inS && !inX && !inT) { ok = false; break; }
        score += (inS ? 6 : 0) + (inT ? 2 : 0) + (inX ? 1 + Math.min(3, x.split(term).length - 1) * 0.3 : 0);
      }
      if (ok) hits.push([score, e]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    sel = -1;
    q.removeAttribute('aria-activedescendant');
    box.innerHTML = hits.length
      ? hits.slice(0, 12).map(([, e], i) => `<a role="option" id="r${i}" href="${e.p}.html${e.a ? '#' + e.a : ''}"><b>${mark(e.s, terms)}</b><small>${escH(e.t)}</small><p>${snippet(e.x, terms)}</p></a>`).join('') + '<div class="rhint" aria-hidden="true"><span><kbd>↑</kbd> <kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span></div>'
      : `<div class="none">No matches for "${escH(q.value.trim())}". Try a block name, an AWS service or an error code.</div>`;
    box.hidden = false;
    q.setAttribute('aria-expanded', 'true');
  }
  q.addEventListener('input', search);
  q.addEventListener('focus', () => { load(); if (q.value.trim().length > 1) { box.hidden = false; q.setAttribute('aria-expanded', 'true'); } });
  q.addEventListener('keydown', (e) => {
    const items = $$('a', box);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((a, i) => a.setAttribute('aria-selected', String(i === sel)));
      q.setAttribute('aria-activedescendant', items[sel].id);
      items[sel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items.length) {
      e.preventDefault();
      location.href = (items[sel] || items[0]).href;
    } else if (e.key === 'Escape') {
      box.hidden = true; q.setAttribute('aria-expanded', 'false'); q.blur();
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) { box.hidden = true; q.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      if (matchMedia('(max-width: 860px)').matches) setDrawer(true);
      q.focus();
    }
  });

  // ---------- copy buttons
  for (const btn of $$('figure.code .copy')) {
    btn.addEventListener('click', async () => {
      const code = btn.closest('figure').querySelector('code').innerText;
      try { await navigator.clipboard.writeText(code); btn.textContent = 'Copied'; btn.classList.add('done'); }
      catch { btn.textContent = 'Select and copy'; }
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1600);
    });
  }

  // ---------- tabs
  for (const t of $$('[data-tabs]')) {
    const tabs = $$('[role="tab"]', t);
    const panels = $$('[role="tabpanel"]', t);
    const pick = (i, focus) => {
      tabs.forEach((b, j) => { b.setAttribute('aria-selected', String(i === j)); b.tabIndex = i === j ? 0 : -1; });
      panels.forEach((p, j) => { p.hidden = i !== j; });
      if (focus) tabs[i].focus();
      try { localStorage.setItem('cadabra-tab', tabs[i].textContent); } catch { /* storage off */ }
    };
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => pick(i));
      b.addEventListener('keydown', (e) => {
        const n = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (n >= 0) { e.preventDefault(); pick(n, true); }
      });
    });
    // open the tab holding a linked anchor, else the remembered one
    const hashEl = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const inPanel = hashEl ? panels.findIndex((p) => p.contains(hashEl)) : -1;
    if (inPanel >= 0) pick(inPanel);
    else { try { const saved = localStorage.getItem('cadabra-tab'); const i = tabs.findIndex((b) => b.textContent === saved); if (i > 0) pick(i); } catch { /* storage off */ } }
  }

  // ---------- game kit filter
  const kq = $('#kit-q');
  if (kq) {
    const cards = $$('.block-card');
    const count = $('#kit-count');
    const empty = $('#kit-empty');
    const total = $$('.block-card tbody tr').length;
    const run = () => {
      const v = kq.value.trim().toLowerCase();
      let shown = 0, anyCard = false;
      for (const c of cards) {
        const nameHit = v && c.dataset.name.includes(v);
        let rowsShown = 0;
        for (const tr of $$('tbody tr', c)) {
          const hit = !v || nameHit || tr.dataset.q.includes(v);
          tr.classList.toggle('hide', !hit);
          if (hit) rowsShown++;
        }
        const show = !v || nameHit || rowsShown > 0;
        c.classList.toggle('hide', !show);
        if (show) { anyCard = true; shown += rowsShown; }
      }
      count.textContent = v ? `${shown} of ${total} params` : `${total} params`;
      empty.hidden = anyCard;
      document.querySelector('.kit-grid')?.classList.toggle('hide', !!v);
    };
    kq.addEventListener('input', run);
    run();
  }

  // ---------- on-page contents highlight
  const links = $$('.toc a');
  if (links.length) {
    const map = new Map(links.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { links.forEach((a) => a.classList.remove('on')); map.get(e.target.id)?.classList.add('on'); }
    }, { rootMargin: '-80px 0px -70% 0px' });
    $$('.prose h2[id]').forEach((h) => io.observe(h));
  }
})();
