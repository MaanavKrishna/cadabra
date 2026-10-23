// Motion layer for the landing page. Vanilla, scroll-linked through one rAF loop.
(() => {
  const d = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const motion = d.classList.contains('m');
  const fine = matchMedia('(pointer: fine)').matches;
  const wide = () => innerWidth >= 768;

  // ---------- split titles into masked words ----------
  function split(el) {
    let i = 0;
    const walk = (node) => {
      for (const n of [...node.childNodes]) {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of n.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.append(' '); continue; }
            const w = document.createElement('span'); w.className = 'w';
            const s = document.createElement('span'); s.textContent = part; s.style.setProperty('--i', i++);
            w.append(s); frag.append(w);
          }
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && !n.classList.contains('w')) walk(n);
      }
    };
    walk(el);
  }
  if (motion) $$('.split').forEach(split);

  // ---------- reveal on scroll ----------
  const revealIO = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); onReveal(e.target); }
  }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
  function onReveal(el) {
    if (el.matches('.numbers')) countUp(el);
  }
  if (motion) {
    $$('.sec .intro, .rules > div, .num, .oss ul li, .looks-head, .closing .ctas, .tweak-media, .loop li, .hint').forEach((el, i) => { el.setAttribute('data-reveal', ''); });
    $$('.rules > div').forEach((el, i) => el.style.setProperty('--d', i * 110));
    $$('.loop li').forEach((el, i) => el.style.setProperty('--d', i * 120));
    $$('.oss ul li').forEach((el, i) => el.style.setProperty('--d', i * 90));
    $$('.num').forEach((el, i) => el.style.setProperty('--d', i * 90));
    $$('.split:not(#hero-title), [data-reveal], .bars, .arch, .numbers').forEach((el) => revealIO.observe(el));
    $$('.bars li').forEach((li, k) => li.style.setProperty('--k', k));
    requestAnimationFrame(() => requestAnimationFrame(() => { $('#hero-title').classList.add('in'); $('.hero').classList.add('go'); }));
  }

  // ---------- count-up ----------
  function countUp(root) {
    for (const el of $$('[data-count]', root)) {
      const to = +el.dataset.count, t0 = performance.now(), dur = 1400 + Math.min(800, to);
      const tick = (t) => {
        const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4);
        el.textContent = Math.round(to * e);
        if (p < 1) requestAnimationFrame(tick);
      };
      el.textContent = '0';
      requestAnimationFrame(tick);
    }
  }

  // ---------- architecture: draw lines, then packets ----------
  const arch = $('.arch');
  if (arch && motion) {
    const paths = $$('.a-edges path:not(.a-dash), .a-rtc', arch);
    paths.forEach((p, k) => {
      const L = Math.ceil(p.getTotalLength());
      p.style.setProperty('--k', k);
      if (!p.classList.contains('a-rtc')) p.style.strokeDasharray = `${L} ${L}`;
      p.style.strokeDashoffset = L;
    });
    $$('.a-node', arch).forEach((n, k) => n.style.setProperty('--k', k));
    const archIO = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      archIO.disconnect();
      arch.classList.add('in');
      paths.forEach((p) => { p.style.strokeDashoffset = 0; });
      setTimeout(() => {
        const NS = 'http://www.w3.org/2000/svg';
        const lanes = $$('.a-edges path', arch);
        lanes.forEach((p, k) => {
          if (!p.id) p.id = `ae${k}`;
          const c = document.createElementNS(NS, 'circle');
          c.setAttribute('r', '3.2');
          c.setAttribute('class', 'pk' + (k % 3 === 1 ? ' p' : ''));
          const am = document.createElementNS(NS, 'animateMotion');
          am.setAttribute('dur', `${1.6 + (k % 4) * 0.35}s`);
          am.setAttribute('repeatCount', 'indefinite');
          am.setAttribute('begin', `${(k * 0.27) % 1.8}s`);
          const mp = document.createElementNS(NS, 'mpath');
          mp.setAttribute('href', `#${p.id}`);
          am.append(mp); c.append(am); arch.append(c);
        });
        const rtc = $('.a-rtc', arch);
        if (rtc) {
          rtc.id = 'artc';
          for (let j = 0; j < 3; j++) {
            const c = document.createElementNS(NS, 'circle');
            c.setAttribute('r', '4'); c.setAttribute('class', 'pk c');
            c.innerHTML = `<animateMotion dur="0.9s" repeatCount="indefinite" begin="${j * 0.3}s" keyPoints="${j % 2 ? '1;0' : '0;1'}" keyTimes="0;1" calcMode="linear"><mpath href="#artc"/></animateMotion>`;
            arch.append(c);
          }
        }
        arch.setCurrentTime?.(0);
      }, 1700);
    }, { threshold: 0.3 });
    archIO.observe(arch);
  }

  // ---------- magnetic buttons + cursor glow ----------
  if (motion && fine) {
    for (const b of $$('.btn')) {
      b.addEventListener('pointermove', (e) => {
        const r = b.getBoundingClientRect();
        b.classList.add('mag');
        b.style.setProperty('--mx', `${(e.clientX - r.left - r.width / 2) * 0.22}px`);
        b.style.setProperty('--my', `${(e.clientY - r.top - r.height / 2) * 0.32}px`);
      });
      b.addEventListener('pointerleave', () => { b.classList.remove('mag'); b.style.setProperty('--mx', '0px'); b.style.setProperty('--my', '0px'); });
    }
    const glow = $('#glow');
    let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy, glowOn = false;
    addEventListener('pointermove', (e) => { tx = e.clientX; ty = e.clientY; if (!glowOn && innerWidth >= 1024) { glowOn = true; glow.classList.add('on'); } }, { passive: true });
    document.addEventListener('pointerleave', () => { glowOn = false; glow.classList.remove('on'); });
    let gRun = false;
    const g = () => {
      gx += (tx - gx) * 0.12; gy += (ty - gy) * 0.12;
      glow.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
      if (Math.abs(tx - gx) + Math.abs(ty - gy) > 0.6) requestAnimationFrame(g); else gRun = false;
    };
    addEventListener('pointermove', () => { if (!gRun) { gRun = true; requestAnimationFrame(g); } }, { passive: true });

    // 3D tilt on game tiles
    for (const t of $$('.tile')) {
      t.addEventListener('pointermove', (e) => {
        const r = t.getBoundingClientRect(), px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        t.style.setProperty('--ry', `${(px - 0.5) * 22}deg`); t.style.setProperty('--rx', `${(0.5 - py) * 22}deg`);
        t.style.setProperty('--gx', `${px * 100}%`); t.style.setProperty('--gy', `${py * 100}%`);
      });
      t.addEventListener('pointerleave', () => { t.style.setProperty('--rx', '0deg'); t.style.setProperty('--ry', '0deg'); });
    }
  }

  // ---------- game info swap animation ----------
  const info = $('#home .info');
  if (info && motion) {
    $('#tiles').addEventListener('click', () => { info.classList.add('swap'); requestAnimationFrame(() => requestAnimationFrame(() => info.classList.remove('swap'))); });
  }

  // ---------- looks morph ----------
  const looks = $('.looks');
  if (looks && motion && innerWidth > 860) {
    const figs = $$('figure', looks);
    let on = 0, timer = null, hover = false;
    const set = (i) => { on = i; looks.dataset.on = i; figs.forEach((f, j) => f.classList.toggle('on', j === i)); };
    figs.forEach((f, i) => { f.addEventListener('mouseenter', () => { hover = true; set(i); }); f.addEventListener('click', () => set(i)); });
    looks.addEventListener('mouseleave', () => { hover = false; });
    new IntersectionObserver((es) => {
      if (es[0].isIntersecting) { set(on); timer ??= setInterval(() => { if (!hover) set((on + 1) % figs.length); }, 2600); }
      else { clearInterval(timer); timer = null; }
    }, { threshold: 0.3 }).observe(looks);
  }

  // ---------- step overlays (storm / pitches / forge) ----------
  const screen = $('.screen');
  const names = ['join', 'storm', 'pitches', 'forge', 'play', 'tweak', 'arcade'];
  const stepBtns = $$('.steps button');
  let forgeRun = 0;
  function runForge() {
    const id = ++forgeRun;
    const stages = ['Reading the ingredients', 'Picking blocks', 'Bots are playtesting', 'Game ready'];
    const at = [0, 1.3, 2.6, 5.2];
    const st = $('#forge-stage'), line = $('#forge-line'), tm = $('#forge-timer'), ticks = $$('#forge-ticks span');
    let shown = -1; const t0 = performance.now();
    tm.classList.remove('done'); ticks.forEach((t) => t.classList.remove('ok'));
    const f = (t) => {
      if (id !== forgeRun) return;
      const s = Math.min(5.2, (t - t0) / 1000 * (motion ? 1 : 100));
      tm.textContent = `${s.toFixed(1)} s`;
      line.style.setProperty('--fp', s / 5.2);
      let k = 0; for (let j = 0; j < at.length; j++) if (s >= at[j]) k = j;
      if (k !== shown) { shown = k; st.innerHTML = `<span>${stages[k]}</span>`; ticks.forEach((tk, j) => tk.classList.toggle('ok', j < k || s >= 5.2)); }
      if (s < 5.2) requestAnimationFrame(f); else { tm.classList.add('done'); ticks.forEach((tk) => tk.classList.add('ok')); }
    };
    requestAnimationFrame(f);
  }
  const obs = new MutationObserver(() => {
    const i = stepBtns.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const n = names[i] || 'join';
    if (screen.dataset.step !== n) {
      screen.dataset.step = n;
      if (n === 'forge') runForge(); else forgeRun++;
    }
    const rail = $('.step-rail i'); if (rail) rail.style.setProperty('--sp', (i + 1) / stepBtns.length);
  });
  stepBtns.forEach((b) => obs.observe(b, { attributes: true, attributeFilter: ['aria-selected'] }));

  // ---------- scroll loop: progress bar, hero parallax, pinned steps ----------
  const bar = $('#progress');
  const hero = $('.hero'), hv = $('.hero video'), hs = $('.hero .hero-still'), hi = $('.hero-inner'), orbs = $('.hero .orbs');
  const how = $('#how');
  let lastStep = -1, ticking = false;
  function frame() {
    ticking = false;
    const y = scrollY, H = d.scrollHeight - innerHeight;
    bar.style.setProperty('--p', H > 0 ? y / H : 0);
    if (motion && wide() && y < innerHeight * 1.2) {
      const p = y / innerHeight;
      const tf = `translate3d(0, ${p * 18}vh, 0) scale(${1.04 + p * 0.08})`;
      hv.style.transform = tf; hs.style.transform = tf;
      hi.style.transform = `translate3d(0, ${-p * 12}vh, 0)`;
      hi.style.opacity = String(Math.max(0, 1 - p * 1.3));
      if (orbs) orbs.style.transform = `translate3d(0, ${p * 30}vh, 0)`;
    }
    if (d.classList.contains('pin')) {
      const r = how.getBoundingClientRect();
      const total = how.offsetHeight - innerHeight;
      const p = Math.min(0.9999, Math.max(0, -r.top / total));
      const i = Math.floor(p * stepBtns.length);
      if (i !== lastStep && r.top <= 0 && r.bottom >= innerHeight) { lastStep = i; stepBtns[i].click(); }
      else if (r.top > 0 && lastStep !== 0) { lastStep = 0; stepBtns[0].click(); }
    }
  }
  const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(frame); } };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => {
    const want = motion && innerWidth >= 1024 && innerHeight >= 820;
    d.classList.toggle('pin', want);
    onScroll();
  });
  frame();
  // clicking a step while pinned scrolls to its slot, so scroll and selection agree
  if (motion) stepBtns.forEach((b, i) => b.addEventListener('click', (e) => {
    if (!d.classList.contains('pin') || !e.isTrusted) return;
    const total = how.offsetHeight - innerHeight;
    const top = how.getBoundingClientRect().top + scrollY + total * ((i + 0.5) / stepBtns.length);
    lastStep = i;
    scrollTo({ top, behavior: 'smooth' });
  }));

  // ---------- tweak lab: a tiny physics sim ----------
  const cv = $('#lab');
  if (cv) {
    const ctx = cv.getContext('2d');
    const BASE = { g: 900, rest: 0.72, speed: 1, n: 7, r: 22, kick: 0 };
    let P = { ...BASE };
    const COLORS = ['#6fd6ff', '#ff6bd5', '#9be7b4', '#f0cd78', '#b9a6ff', '#ff8a7a', '#7fefff'];
    let W = 0, Hh = 0, dpr = 1, balls = [], running = false, visible = false, last = 0, userKicked = motion;
    const resize = () => {
      dpr = Math.min(2, devicePixelRatio || 1);
      const r = cv.getBoundingClientRect(); W = r.width; Hh = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const spawn = (n) => { for (let k = 0; k < n; k++) balls.push({ x: 60 + Math.random() * (W - 120), y: 40 + Math.random() * Hh * 0.4, vx: (Math.random() - 0.5) * 520, vy: (Math.random() - 0.5) * 200, c: COLORS[balls.length % COLORS.length], trail: [] }); };
    const radius = () => P.r * Math.max(0.6, Math.min(1.2, W / 900));
    const step = (dt) => {
      const r = radius();
      for (const b of balls) {
        b.vy += P.g * dt;
        if (P.kick && Math.random() < P.kick * dt) { b.vx += (Math.random() - 0.5) * 900; b.vy -= 300 + Math.random() * 500; }
        b.x += b.vx * dt * P.speed; b.y += b.vy * dt * P.speed;
        if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx) * P.rest; }
        if (b.x > W - r) { b.x = W - r; b.vx = -Math.abs(b.vx) * P.rest; }
        if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy) * P.rest; }
        if (b.y > Hh - r) { b.y = Hh - r; b.vy = -Math.abs(b.vy) * P.rest; b.vx *= 0.995; if (Math.abs(b.vy) < 60) b.vy = -(380 + Math.random() * 380) * (P.g < 500 ? 0.6 : 1); }
      }
      for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i], b = balls[j], dx = b.x - a.x, dy = b.y - a.y, dd = Math.hypot(dx, dy), m = r * 2;
        if (dd > 0 && dd < m) {
          const nx = dx / dd, ny = dy / dd, o = (m - dd) / 2;
          a.x -= nx * o; a.y -= ny * o; b.x += nx * o; b.y += ny * o;
          const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rv < 0) { const imp = -(1 + P.rest) * rv / 2; a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny; }
        }
      }
    };
    const draw = () => {
      const r = radius();
      ctx.fillStyle = '#070a16'; ctx.fillRect(0, 0, W, Hh);
      ctx.strokeStyle = 'rgba(111,214,255,0.08)'; ctx.lineWidth = 1;
      const gs = 40; ctx.beginPath();
      for (let x = gs; x < W; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, Hh); }
      for (let y = gs; y < Hh; y += gs) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,107,213,0.55)'; ctx.lineWidth = 3; ctx.strokeRect(1.5, 1.5, W - 3, Hh - 3);
      for (const b of balls) {
        b.trail.push(b.x, b.y); if (b.trail.length > 24) b.trail.splice(0, 2);
        ctx.beginPath();
        for (let k = 0; k < b.trail.length; k += 2) (k ? ctx.lineTo : ctx.moveTo).call(ctx, b.trail[k], b.trail[k + 1]);
        ctx.strokeStyle = b.c + '55'; ctx.lineWidth = r * 0.7; ctx.lineCap = 'round'; ctx.stroke();
        ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
        ctx.fillStyle = b.c + '33'; ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = b.c; ctx.shadowColor = b.c; ctx.shadowBlur = 14; ctx.stroke(); ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(b.x - r * 0.32, b.y - r * 0.12, r * 0.17, 0, 7); ctx.arc(b.x + r * 0.32, b.y - r * 0.12, r * 0.17, 0, 7); ctx.fill();
      }
    };
    const loop = (t) => {
      if (!running) return;
      const dt = Math.min(0.033, (t - last) / 1000 || 0.016); last = t;
      step(dt / 2); step(dt / 2); draw();
      requestAnimationFrame(loop);
    };
    const start = () => { if (running || !visible || !userKicked) return; running = true; last = performance.now(); requestAnimationFrame(loop); };
    const stop = () => { running = false; };
    resize(); spawn(P.n); draw();
    addEventListener('resize', () => { resize(); draw(); });
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; visible ? start() : stop(); }, { threshold: 0.1 }).observe(cv);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

    const hud = $('#lab-hud');
    const showHud = () => { hud.textContent = `gravity ${Math.round(P.g)}  bounce ${P.rest.toFixed(2)}  speed x${P.speed.toFixed(1)}  balls ${balls.length}`; };
    showHud();
    const card = $('#changed'), ct = $('#changed-title'), tags = $('#changed-tags');
    let hideT;
    const TW = {
      low: ['Low gravity', () => { P.g = BASE.g * 0.4; P.rest = Math.max(P.rest, 0.85); }, ['Gravity x0.4', 'Floatier']],
      bounce: ['Way more bounce', () => { P.rest = 0.98; }, ['Bounce up', 'Restitution 0.98']],
      fast: ['Faster', () => { P.speed = 1.5; }, ['Speed x1.5']],
      chaos: ['More chaos', () => { P.kick = 1.2; spawn(4); }, ['Chaos up', '+4 balls', 'Random kicks']],
      big: ['Bigger arena', () => { P.r = 14; }, ['Arena x1.5', 'Smaller players']],
      reset: ['Back to the original', () => { P = { ...BASE }; balls = []; spawn(BASE.n); }, ['Original rules']],
    };
    for (const btn of $$('[data-tweak]')) {
      btn.addEventListener('click', () => {
        const [title, apply, tg] = TW[btn.dataset.tweak];
        const go = () => {
          apply();
          if (btn.dataset.tweak === 'reset') $$('[data-tweak]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
          else btn.setAttribute('aria-pressed', 'true');
          for (const b of balls) b.vy -= 200;
          ct.textContent = title; tags.innerHTML = tg.map((x) => `<span>${x}</span>`).join('');
          card.classList.remove('show'); void card.offsetWidth; card.classList.add('show');
          clearTimeout(hideT); hideT = setTimeout(() => card.classList.remove('show'), 3200);
          showHud();
          userKicked = true; start();
          if (!running) { step(0.016); draw(); }
        };
        if (!motion) return go();
        // fly a chip from the button to the arena
        const from = btn.getBoundingClientRect(), to = $('#lab-stage').getBoundingClientRect();
        const chip = document.createElement('div'); chip.className = 'flychip'; chip.textContent = btn.textContent;
        chip.style.left = `${from.left}px`; chip.style.top = `${from.top}px`;
        document.body.append(chip);
        const dx = to.left + to.width * 0.5 - from.left - from.width / 2, dy = to.top + to.height * 0.35 - from.top;
        chip.animate([
          { transform: 'translate(0,0) scale(1)', opacity: 1 },
          { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 80}px) scale(1.1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy}px) scale(.4)`, opacity: 0 },
        ], { duration: 650, easing: 'cubic-bezier(.5,0,.3,1)' }).onfinish = () => { chip.remove(); go(); };
      });
    }
  }
})();
