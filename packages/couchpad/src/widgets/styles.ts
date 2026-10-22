// Widget stylesheet, injected once. Theme with CSS variables on any ancestor:
// --cp-primary, --cp-accent, --cp-glow, --cp-text, --cp-surface, --cp-font, --cp-display-font.
export const WIDGET_CSS = /* css */ `
.cp-controller{
  --_p:var(--cp-primary,#7c5cff);--_a:var(--cp-accent,#ffb547);--_g:var(--cp-glow,#8f6bff);
  --_t:var(--cp-text,#f5f3ff);--_s:var(--cp-surface,rgba(255,255,255,.06));
  --_spring:cubic-bezier(.34,1.56,.64,1);
  position:relative;box-sizing:border-box;width:100%;height:100%;min-height:0;
  display:grid;gap:clamp(12px,3vmin,24px);grid-template-columns:1fr;grid-auto-rows:minmax(0,auto);
  align-content:stretch;color:var(--_t);font-family:var(--cp-font,system-ui,sans-serif);
  user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;
  -webkit-tap-highlight-color:transparent;
}
.cp-controller *{box-sizing:border-box}
.cp-controller[data-layout=pad]{grid-template-rows:1fr 1fr;grid-template-areas:"actions" "stick"}
.cp-controller[data-layout=pad] .cp-zone-actions{grid-area:actions}
.cp-controller[data-layout=pad] .cp-zone-stick{grid-area:stick}
.cp-controller[data-layout=pad] .cp-zone-panel{display:none}
@media (orientation:landscape){
  .cp-controller[data-layout=pad]{grid-template-rows:1fr;grid-template-columns:1fr 1fr;grid-template-areas:"stick actions"}
}
.cp-zone{position:relative;display:flex;align-items:center;justify-content:center;min-height:0;min-width:0}
.cp-zone-panel{flex-direction:column;align-items:stretch;gap:16px}
.cp-zone-stick{flex-direction:column;gap:14px}

/* ---------- glossy buttons ---------- */
.cp-btn{
  position:relative;overflow:hidden;isolation:isolate;min-height:72px;min-width:72px;padding:0 28px;
  border:0;border-radius:999px;color:#fff;font:800 20px/1 var(--cp-display-font,var(--cp-font,system-ui));
  letter-spacing:.01em;cursor:pointer;touch-action:none;
  background:
    radial-gradient(120% 90% at 50% 0%,rgba(255,255,255,.45),rgba(255,255,255,0) 55%),
    linear-gradient(180deg,color-mix(in oklab,var(--_p) 82%,#fff),var(--_p) 55%,color-mix(in oklab,var(--_p) 70%,#000));
  box-shadow:
    inset 0 1.5px 0 rgba(255,255,255,.55),inset 0 -8px 16px rgba(0,0,0,.28),
    0 0 0 1px color-mix(in oklab,var(--_p) 60%,#000),
    0 14px 34px -10px color-mix(in oklab,var(--_g) 85%,transparent),0 4px 10px rgba(0,0,0,.35);
  transition:transform 260ms var(--_spring),filter 160ms ease,box-shadow 200ms ease;
  -webkit-user-select:none;user-select:none;
}
.cp-btn .cp-btn-label{position:relative;z-index:2;text-shadow:0 1px 2px rgba(0,0,0,.35)}
.cp-btn.is-down,.cp-btn:active{
  transform:scale(.93);filter:brightness(1.12) saturate(1.1);transition:transform 70ms ease-out,filter 70ms;
  box-shadow:
    inset 0 1.5px 0 rgba(255,255,255,.4),inset 0 6px 18px rgba(0,0,0,.25),
    0 0 0 1px color-mix(in oklab,var(--_p) 60%,#000),
    0 0 44px 2px color-mix(in oklab,var(--_g) 75%,transparent);
}
.cp-ripple{position:absolute;z-index:1;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle,rgba(255,255,255,.55) 0%,rgba(255,255,255,0) 60%);
  transform:scale(0);animation:cp-ripple 560ms cubic-bezier(.2,.7,.2,1) forwards}
@keyframes cp-ripple{to{transform:scale(1);opacity:0}}

.cp-zone-actions{flex-wrap:wrap;align-content:center;gap:clamp(14px,3.5vmin,26px);padding:8px}
.cp-zone-actions>.cp-btn{text-transform:uppercase;letter-spacing:.03em;width:clamp(104px,30vmin,148px);height:clamp(104px,30vmin,148px);padding:0;border-radius:50%;font-size:clamp(16px,4.4vmin,22px)}
.cp-zone-actions[data-count="1"]>.cp-btn{width:clamp(140px,42vmin,200px);height:clamp(140px,42vmin,200px);font-size:clamp(20px,5.4vmin,28px)}
.cp-zone-actions>.cp-btn:nth-child(2){--_p:var(--cp-accent,#ffb547);--_g:var(--cp-accent,#ffb547);color:#1a1206}
.cp-zone-actions>.cp-btn:nth-child(2) .cp-btn-label{text-shadow:0 1px 0 rgba(255,255,255,.35)}
.cp-zone-actions>.cp-btn:nth-child(3){--_p:color-mix(in oklab,var(--cp-primary,#7c5cff) 40%,#2ec5ff)}
.cp-zone-actions>.cp-btn:nth-child(4){--_p:color-mix(in oklab,var(--cp-accent,#ffb547) 45%,#ff4d8d)}

/* hold: charge ring fills while pressed */
.cp-hold .cp-hold-fill{position:absolute;inset:0;z-index:1;border-radius:inherit;pointer-events:none;
  background:conic-gradient(from -90deg,rgba(255,255,255,.55) var(--fill,0turn),transparent 0);
  -webkit-mask:radial-gradient(circle,transparent 62%,#000 63%);mask:radial-gradient(circle,transparent 62%,#000 63%)}
.cp-hold.is-down .cp-hold-fill{animation:cp-charge 1.1s linear forwards}
@property --fill{syntax:'<angle>';inherits:false;initial-value:0turn}
@keyframes cp-charge{from{--fill:0turn}to{--fill:1turn}}
.cp-hold .cp-btn-hint{position:absolute;z-index:2;left:0;right:0;bottom:22%;font:700 11px/1 var(--cp-font,system-ui);letter-spacing:.18em;opacity:.75}
.cp-hold .cp-btn-label{transform:translateY(-6px)}

/* ---------- joystick ---------- */
.cp-joystick{position:relative;width:clamp(196px,58vmin,280px);aspect-ratio:1;border-radius:50%;touch-action:none;
  background:
    radial-gradient(circle at 50% 50%,rgba(0,0,0,.0) 0 40%,rgba(0,0,0,.35) 72%),
    radial-gradient(circle at 50% 30%,rgba(255,255,255,.10),rgba(255,255,255,.02) 70%);
  box-shadow:inset 0 2px 1px rgba(255,255,255,.08),inset 0 -14px 30px rgba(0,0,0,.45),
    0 0 0 1px rgba(255,255,255,.08),0 22px 50px -18px rgba(0,0,0,.8);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.cp-joystick-ring{position:absolute;inset:9%;border-radius:50%;border:1px dashed rgba(255,255,255,.12)}
.cp-joystick-tick{position:absolute;left:50%;top:50%;width:0;height:0;border:7px solid transparent;opacity:.35;transition:opacity .2s}
.cp-tick-0{border-bottom-color:var(--_t);transform:translate(-50%,-50%) translateY(calc(-1 * (50% + 0px))) ;top:2%}
.cp-tick-1{border-left-color:var(--_t);left:auto;right:-1%;transform:translateY(-50%)}
.cp-tick-2{border-top-color:var(--_t);top:auto;bottom:-1%;transform:translateX(-50%)}
.cp-tick-3{border-right-color:var(--_t);left:-1%;transform:translateY(-50%)}
.cp-tick-0{transform:translateX(-50%);top:-1%}
.cp-joystick-glow{position:absolute;inset:-6%;border-radius:50%;opacity:0;pointer-events:none;transition:opacity .25s;
  background:conic-gradient(from -40deg,transparent 0deg,color-mix(in oklab,var(--_g) 90%,#fff) 40deg,transparent 80deg,transparent 360deg);
  -webkit-mask:radial-gradient(circle,transparent 58%,#000 66%,transparent 71%);mask:radial-gradient(circle,transparent 58%,#000 66%,transparent 71%);
  filter:blur(3px)}
.cp-joystick-knob{position:absolute;left:50%;top:50%;width:44%;aspect-ratio:1;border-radius:50%;pointer-events:none;
  transform:translate(-50%,-50%);transition:transform 420ms var(--_spring);will-change:transform;
  background:
    radial-gradient(70% 55% at 50% 22%,rgba(255,255,255,.65),rgba(255,255,255,0) 60%),
    radial-gradient(circle at 50% 60%,color-mix(in oklab,var(--_p) 85%,#fff),var(--_p) 55%,color-mix(in oklab,var(--_p) 60%,#000));
  box-shadow:inset 0 -6px 12px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.25),0 12px 26px -6px rgba(0,0,0,.6),0 0 36px -6px var(--_g)}
.cp-joystick.is-active .cp-joystick-knob{transition:transform 40ms linear;box-shadow:inset 0 -6px 12px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.25),0 12px 26px -6px rgba(0,0,0,.6),0 0 60px 4px var(--_g)}
.cp-joystick.is-active .cp-joystick-tick{opacity:.6}

/* ---------- tilt ---------- */
.cp-tilt{display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center}
.cp-tilt-note{font:600 15px/1.3 var(--cp-font,system-ui);opacity:.7;letter-spacing:.01em}
.cp-tilt-level{position:relative;width:clamp(170px,46vmin,240px);aspect-ratio:1;border-radius:50%;
  background:radial-gradient(circle,rgba(255,255,255,.07),rgba(255,255,255,.02) 70%);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),inset 0 -14px 30px rgba(0,0,0,.4)}
.cp-tilt-level::before,.cp-tilt-level::after{content:"";position:absolute;background:rgba(255,255,255,.12)}
.cp-tilt-level::before{left:50%;top:12%;bottom:12%;width:1px}
.cp-tilt-level::after{top:50%;left:12%;right:12%;height:1px}
.cp-tilt-bubble{position:absolute;left:50%;top:50%;width:30%;aspect-ratio:1;border-radius:50%;transform:translate(-50%,-50%);
  transition:transform 90ms linear;background:radial-gradient(circle at 40% 30%,#fff,var(--_p) 60%);box-shadow:0 0 34px var(--_g)}
.cp-tilt-enable{min-width:220px}

/* ---------- chips ---------- */
.cp-chip{min-height:72px;min-width:72px;padding:0 22px;border-radius:22px;border:1px solid rgba(255,255,255,.12);
  background:var(--_s);color:var(--_t);font:700 17px/1 var(--cp-font,system-ui);letter-spacing:.02em;
  transition:transform 220ms var(--_spring),background .15s;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.cp-chip:active{transform:scale(.94);background:rgba(255,255,255,.14)}

/* ---------- swipe ---------- */
.cp-swipe{position:relative;width:min(100%,360px);aspect-ratio:1;border-radius:36px;touch-action:none;
  background:radial-gradient(circle at 50% 40%,rgba(255,255,255,.08),rgba(255,255,255,.015) 70%);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.09),inset 0 -20px 40px rgba(0,0,0,.35)}
.cp-swipe.is-active{box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--_g) 60%,transparent),inset 0 -20px 40px rgba(0,0,0,.35),0 0 40px -10px var(--_g)}
.cp-swipe-hint{position:absolute;inset:0;display:grid;place-items:center;font:800 15px/1 var(--cp-font,system-ui);letter-spacing:.3em;text-transform:uppercase;opacity:.45}
.cp-swipe-arrow{position:absolute;width:22px;height:22px;border:solid var(--_t);border-width:4px 4px 0 0;border-radius:3px;opacity:.35}
.cp-swipe-arrow.is-up{left:50%;top:12%;transform:translateX(-50%) rotate(-45deg)}
.cp-swipe-arrow.is-down{left:50%;bottom:12%;transform:translateX(-50%) rotate(135deg)}
.cp-swipe-arrow.is-left{top:50%;left:12%;transform:translateY(-50%) rotate(-135deg)}
.cp-swipe-arrow.is-right{top:50%;right:12%;transform:translateY(-50%) rotate(45deg)}
.cp-swipe-arrow.is-flash{animation:cp-flash 420ms ease-out}
@keyframes cp-flash{0%{opacity:1;border-color:#fff;filter:drop-shadow(0 0 12px var(--_g))}100%{opacity:.35}}

/* ---------- draw ---------- */
.cp-draw{display:flex;flex-direction:column;gap:14px;width:100%;max-width:520px;margin:0 auto}
.cp-draw-prompt{font:800 22px/1.15 var(--cp-display-font,var(--cp-font,system-ui));text-align:center;letter-spacing:-.01em}
.cp-draw-pad{position:relative;width:100%;aspect-ratio:1;border-radius:28px;overflow:hidden;touch-action:none;
  background:
    radial-gradient(circle,rgba(255,255,255,.09) 1px,transparent 1.5px) 0 0/22px 22px,
    linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02));
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),0 20px 50px -24px rgba(0,0,0,.9)}
.cp-draw-canvas{position:absolute;inset:0;width:100%;height:100%}
.cp-draw-tools{display:grid;grid-template-columns:1fr;gap:12px}
.cp-draw-swatches{display:flex;gap:10px;justify-content:center}
.cp-swatch{width:72px;height:72px;border-radius:50%;border:0;background:transparent;position:relative;padding:0}
.cp-swatch::after{content:"";position:absolute;inset:16px;border-radius:50%;background:var(--sw);
  box-shadow:0 0 0 2px rgba(255,255,255,.18),0 6px 16px -4px rgba(0,0,0,.6);transition:transform 220ms var(--_spring),box-shadow .2s}
.cp-swatch.is-on::after{transform:scale(1.22);box-shadow:0 0 0 3px #fff,0 0 22px var(--sw)}
.cp-draw-row{display:flex;gap:10px}
.cp-draw-row>.cp-chip{flex:1}
.cp-draw-done{width:100%}
.cp-draw.is-sent .cp-draw-done{filter:saturate(.6) brightness(.9)}

/* ---------- vote ---------- */
.cp-vote{display:flex;flex-direction:column;gap:12px;width:100%}
.cp-vote-option{position:relative;display:flex;align-items:center;gap:16px;min-height:80px;padding:12px 18px;border-radius:24px;
  border:1px solid rgba(255,255,255,.1);background:var(--_s);color:var(--_t);text-align:left;
  font:700 19px/1.2 var(--cp-font,system-ui);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
  transition:transform 240ms var(--_spring),border-color .2s,background .2s,box-shadow .25s}
.cp-vote-option:active{transform:scale(.97)}
.cp-vote-badge{flex:none;display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:rgba(255,255,255,.08);
  font:800 18px/1 var(--cp-display-font,var(--cp-font,system-ui))}
.cp-vote-label{flex:1}
.cp-vote-check{flex:none;width:26px;height:26px;border-radius:50%;border:2px solid rgba(255,255,255,.2);transition:all .2s}
.cp-vote-option.is-on{border-color:color-mix(in oklab,var(--_p) 80%,#fff);background:color-mix(in oklab,var(--_p) 22%,transparent);
  box-shadow:0 0 0 1px color-mix(in oklab,var(--_p) 60%,transparent),0 16px 40px -16px var(--_g)}
.cp-vote-option.is-on .cp-vote-badge{background:var(--_p);color:#fff}
.cp-vote-option.is-on .cp-vote-check{border-color:#fff;background:#fff;box-shadow:inset 0 0 0 5px var(--_p)}

/* ---------- text ---------- */
.cp-text{display:flex;gap:10px;width:100%;align-items:stretch}
.cp-text-field{position:relative;flex:1;min-width:0}
.cp-text-input{width:100%;height:72px;padding:0 64px 0 22px;border-radius:24px;border:1px solid rgba(255,255,255,.14);
  background:rgba(255,255,255,.07);color:var(--_t);font:600 19px/1 var(--cp-font,system-ui);outline:none;
  user-select:text;-webkit-user-select:text;touch-action:manipulation;transition:border-color .2s,box-shadow .2s}
.cp-text-input::placeholder{color:color-mix(in oklab,var(--_t) 45%,transparent)}
.cp-text-input:focus{border-color:color-mix(in oklab,var(--_p) 80%,#fff);box-shadow:0 0 0 4px color-mix(in oklab,var(--_p) 30%,transparent)}
.cp-text-count{position:absolute;right:18px;top:50%;transform:translateY(-50%);font:600 13px/1 var(--cp-font,system-ui);opacity:.5}
.cp-text-send{flex:none;border-radius:24px;padding:0 22px;font-size:17px}
.cp-text.is-empty .cp-text-send{filter:saturate(.4) brightness(.75)}
.cp-text.is-sent .cp-text-input{animation:cp-sent 600ms ease-out}
@keyframes cp-sent{0%{box-shadow:0 0 0 0 color-mix(in oklab,var(--_a) 70%,transparent)}100%{box-shadow:0 0 0 18px transparent}}

@media (prefers-reduced-motion:reduce){.cp-controller *{animation-duration:1ms!important;transition-duration:1ms!important}}
`;

export function ensureStyles(doc: Document = document) {
  if (doc.getElementById('cp-widgets-style')) return;
  const s = doc.createElement('style');
  s.id = 'cp-widgets-style';
  s.textContent = WIDGET_CSS;
  doc.head.appendChild(s);
}
