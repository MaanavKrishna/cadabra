import { Application, Graphics, Sprite, Texture, Container, FillGradient } from 'pixi.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const log = (tag: string, data: unknown) => console.log(tag, JSON.stringify(data));

$('ua').textContent = navigator.userAgent;
log('SPIKE', { ua: navigator.userAgent, secure: window.isSecureContext, dpr: window.devicePixelRatio });

// Key bridge: native side calls window.cadabraKey(name).
(window as unknown as { cadabraKey: (n: string) => string }).cadabraKey = (name) => {
  $('key').textContent = `key: ${name}`;
  log('SPIKE', { key: name });
  return name === 'back' ? 'exit' : '';
};

async function rtcLoopback(): Promise<string> {
  try {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const ch = a.createDataChannel('spike');
    const opened = new Promise<string>((resolve) => {
      ch.onopen = () => resolve('open');
      setTimeout(() => resolve('timeout'), 8000);
    });
    const offer = await a.createOffer();
    await a.setLocalDescription(offer);
    await b.setRemoteDescription(offer);
    const answer = await b.createAnswer();
    await b.setLocalDescription(answer);
    await a.setRemoteDescription(answer);
    return await opened;
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

async function main() {
  const app = new Application();
  await app.init({ width: 1280, height: 720, background: '#101030', antialias: false, resolution: 1 });
  const canvas = app.canvas;
  canvas.style.width = '100vw';
  canvas.style.height = '100vh';
  document.body.prepend(canvas);

  const grad = new FillGradient({
    type: 'linear',
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
    colorStops: [
      { offset: 0, color: 0x3b1d8f },
      { offset: 1, color: 0x0b0b25 },
    ],
  });
  app.stage.addChild(new Graphics().rect(0, 0, 1280, 720).fill(grad));

  const dot = new Graphics().circle(0, 0, 32).fill(0xffffff);
  const sprTex = app.renderer.generateTexture(dot);
  const sprites: { s: Sprite; vx: number; vy: number }[] = [];
  const sc = new Container();
  app.stage.addChild(sc);
  for (let i = 0; i < 8; i++) {
    const s = new Sprite(sprTex);
    s.anchor.set(0.5);
    s.tint = [0xff5577, 0x55ddff, 0xffcc33, 0x88ff88][i % 4]!;
    s.scale.set(1.2 + (i % 3) * 0.4);
    s.position.set(Math.random() * 1280, Math.random() * 720);
    sc.addChild(s);
    sprites.push({ s, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8 });
  }
  const pdot = new Graphics().circle(0, 0, 4).fill(0xffffff);
  const pTex = app.renderer.generateTexture(pdot);
  const parts: { s: Sprite; vx: number; vy: number }[] = [];
  const pc = new Container();
  app.stage.addChild(pc);
  for (let i = 0; i < 300; i++) {
    const s = new Sprite(pTex);
    s.anchor.set(0.5);
    s.alpha = 0.7;
    s.position.set(Math.random() * 1280, Math.random() * 720);
    pc.addChild(s);
    parts.push({ s, vx: (Math.random() - 0.5) * 4, vy: -1 - Math.random() * 3 });
  }
  void Texture;

  app.ticker.add((t) => {
    const k = t.deltaTime;
    for (const o of sprites) {
      o.s.x += o.vx * k;
      o.s.y += o.vy * k;
      o.s.rotation += 0.02 * k;
      if (o.s.x < 0 || o.s.x > 1280) o.vx *= -1;
      if (o.s.y < 0 || o.s.y > 720) o.vy *= -1;
    }
    for (const p of parts) {
      p.s.x += p.vx * k;
      p.s.y += p.vy * k;
      if (p.s.y < 0) { p.s.y = 720; p.s.x = Math.random() * 1280; }
    }
  });

  // FPS measurement via rAF over ~15 s.
  const samples: number[] = [];
  let frames = 0;
  let last = performance.now();
  const start = last;
  const tick = (now: number) => {
    frames++;
    if (now - last >= 1000) {
      const fps = (frames * 1000) / (now - last);
      samples.push(fps);
      $('fps').textContent = `${fps.toFixed(0)} fps`;
      frames = 0;
      last = now;
    }
    if (now - start < 15000) requestAnimationFrame(tick);
    else {
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      log('SPIKE', { fps: { avg: +avg.toFixed(1), min: +Math.min(...samples).toFixed(1), max: +Math.max(...samples).toFixed(1), n: samples.length } });
    }
  };
  requestAnimationFrame(tick);
}

rtcLoopback().then((r) => {
  $('rtc').textContent = `WebRTC DataChannel: ${r}`;
  log('SPIKE', { datachannel: r });
});
main().catch((e) => log('SPIKE', { error: String(e) }));
