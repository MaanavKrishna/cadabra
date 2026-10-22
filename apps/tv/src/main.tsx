import { render } from 'preact';
import '@fontsource/bricolage-grotesque/latin-700.css';
import '@fontsource/bricolage-grotesque/latin-800.css';
import '@fontsource/figtree/latin-500.css';
import '@fontsource/figtree/latin-600.css';
import '@fontsource/figtree/latin-700.css';
import '@fontsource/figtree/latin-800.css';
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
