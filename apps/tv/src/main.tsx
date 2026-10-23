import { render } from 'preact';
// the game canvas (packages/render) draws its neon HUD and name plates with these
import '@fontsource/bricolage-grotesque/latin-800.css';
import '@fontsource/figtree/latin-700.css';
import '@fontsource/figtree/latin-800.css';
// the app chrome: self-hosted Figtree 300/400/600 subset
import './fonts/fonts.css';
import './styles.css';
import { App } from './app';

// The UI is laid out on a 1920x1080 stage and zoomed to the viewport (the Fire TV WebView is
// 960x540 CSS px at DPR 2), so every size in styles.css is in 1080p pixels.
function fit(): void {
  const k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.documentElement.style.setProperty('--k', String(k));
}
fit();
window.addEventListener('resize', fit);

render(<App />, document.getElementById('root')!);
