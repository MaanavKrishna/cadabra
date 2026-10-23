(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // top bar turns solid after the hero starts scrolling
  const bar = $('#bar');
  const onScroll = () => bar.classList.toggle('solid', scrollY > 40);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // mobile menu
  const navBtn = $('#nav-btn');
  if (navBtn) {
    const setNav = (open) => { bar.classList.toggle('open', open); navBtn.setAttribute('aria-expanded', String(open)); navBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); };
    navBtn.addEventListener('click', () => setNav(!bar.classList.contains('open')));
    $$('#bar nav a').forEach((a) => a.addEventListener('click', () => setNav(false)));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bar.classList.contains('open')) { setNav(false); navBtn.focus(); } });
  }

  // hero video: off for reduced motion, paused off-screen, user toggle
  const hv = $('#hero-video');
  const toggle = $('#motion');
  let userPaused = reduce;
  const setPaused = (p) => {
    userPaused = p;
    toggle.setAttribute('aria-pressed', String(p));
    toggle.textContent = p ? 'Play video' : 'Pause video';
    if (p) hv.pause(); else hv.play().catch(() => {});
  };
  if (reduce) { hv.removeAttribute('autoplay'); hv.pause(); setPaused(true); }
  toggle.addEventListener('click', () => setPaused(!userPaused));

  const tv = $('#tweak-video');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target;
      if (e.isIntersecting && !(v === hv ? userPaused : reduce)) v.play().catch(() => {});
      else v.pause();
    }
  }, { threshold: 0.25 });
  io.observe(hv);
  if (tv) io.observe(tv);

  // tab-like lists with arrow keys (steps and game tiles)
  function tabs(list, items, onSelect, orientation) {
    const select = (i, focus) => {
      items.forEach((b, j) => { b.setAttribute('aria-selected', String(i === j)); b.tabIndex = i === j ? 0 : -1; });
      if (focus) items[i].focus();
      onSelect(i);
    };
    list.addEventListener('keydown', (e) => {
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      const next = orientation === 'v' ? ['ArrowDown', 'ArrowRight'] : ['ArrowRight', 'ArrowDown'];
      const prev = orientation === 'v' ? ['ArrowUp', 'ArrowLeft'] : ['ArrowLeft', 'ArrowUp'];
      let n = -1;
      if (next.includes(e.key)) n = (i + 1) % items.length;
      else if (prev.includes(e.key)) n = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = items.length - 1;
      if (n >= 0) { e.preventDefault(); select(n, true); }
    });
    items.forEach((b, i) => b.addEventListener('click', () => select(i, false)));
    select(0, false);
  }

  // how it works
  const stepImg = $('#step-img');
  const stepCap = $('#step-cap');
  const stepBtns = $$('.steps button');
  tabs($('.steps'), stepBtns, (i) => {
    const b = stepBtns[i];
    if (stepImg.getAttribute('src') === b.dataset.img) return;
    stepImg.style.opacity = '0';
    const img = new Image();
    img.onload = img.onerror = () => {
      stepImg.removeAttribute('srcset');
      stepImg.src = b.dataset.img;
      stepImg.alt = b.dataset.alt;
      stepImg.classList.toggle('contain', b.dataset.fit === 'contain');
      stepCap.textContent = b.dataset.cap;
      stepImg.style.opacity = '1';
    };
    img.src = b.dataset.img;
  }, 'v');

  // game home row
  const tiles = $$('#tiles .tile');
  const bgs = $$('#home .bg img');
  const title = $('#g-title'), desc = $('#g-desc'), look = $('#g-look');
  const lookColor = { neon: '#6fd6ff', toybox: '#ff8fe6', cosmos: '#b9a6ff', retro: '#f0cd78' };
  tabs($('#tiles'), tiles, (i) => {
    const t = tiles[i];
    title.textContent = t.dataset.name;
    desc.textContent = t.dataset.desc;
    look.innerHTML = `<i style="--c:${lookColor[t.dataset.look]}"></i>${t.dataset.look} look`;
    bgs.forEach((im, j) => {
      if (j === i && !im.getAttribute('src')) { if (im.dataset.srcset) im.srcset = im.dataset.srcset; im.src = im.dataset.src; }
      im.classList.toggle('on', j === i);
    });
    const row = t.parentElement;
    const left = t.offsetLeft - row.offsetLeft - row.clientWidth / 2 + t.clientWidth / 2;
    row.scrollTo({ left: Math.max(0, left), behavior: reduce ? 'auto' : 'smooth' });
  }, 'h');
  // warm the other stills once the gallery is near
  new IntersectionObserver((es, o) => {
    if (es.some((e) => e.isIntersecting)) { bgs.forEach((im) => { if (!im.getAttribute('src')) { if (im.dataset.srcset) im.srcset = im.dataset.srcset; im.src = im.dataset.src; } }); o.disconnect(); }
  }, { rootMargin: '400px' }).observe($('#home'));
})();
