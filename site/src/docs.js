(() => {
  const $ = (s) => document.querySelector(s);
  const q = $('#q');
  const box = $('#results');
  let data = null;
  let sel = -1;

  // mobile menu
  const menu = $('.menu-btn');
  const side = $('#side');
  menu?.addEventListener('click', () => {
    const open = side.classList.toggle('open');
    menu.setAttribute('aria-expanded', String(open));
  });

  const load = () => data || (data = fetch('../search-index.json').then((r) => r.json()).catch(() => []));
  const escH = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escR = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function snippet(text, terms) {
    const lower = text.toLowerCase();
    let at = -1;
    for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (at < 0 || i < at)) at = i; }
    const start = Math.max(0, at - 50);
    let s = (start > 0 ? '…' : '') + text.slice(start, start + 170) + (text.length > start + 170 ? '…' : '');
    s = escH(s);
    const re = new RegExp(`(${terms.map(escR).join('|')})`, 'gi');
    return s.replace(re, '<mark>$1</mark>');
  }

  async function search() {
    const raw = q.value.trim().toLowerCase();
    if (raw.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
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
    box.innerHTML = hits.length
      ? hits.slice(0, 12).map(([, e], i) => `<a role="option" id="r${i}" href="${e.p}.html${e.a ? '#' + e.a : ''}"><b>${escH(e.s)}</b><small>${escH(e.t)}</small><p>${snippet(e.x, terms)}</p></a>`).join('')
      : `<div class="none">No matches for "${escH(q.value.trim())}". Try a block name, an AWS service or an error code.</div>`;
    box.hidden = false;
  }

  q.addEventListener('input', search);
  q.addEventListener('focus', () => { load(); if (q.value.trim().length > 1) box.hidden = false; });
  q.addEventListener('keydown', (e) => {
    const items = [...box.querySelectorAll('a')];
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
      box.hidden = true; q.blur();
    }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== q && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
  });

  // highlight the current section in the on-page contents
  const links = [...document.querySelectorAll('.toc a')];
  if (links.length) {
    const map = new Map(links.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { links.forEach((a) => a.classList.remove('on')); map.get(e.target.id)?.classList.add('on'); }
    }, { rootMargin: '-80px 0px -70% 0px' });
    document.querySelectorAll('.prose h2[id]').forEach((h) => io.observe(h));
  }
})();
