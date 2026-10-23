import { render } from 'preact';
import '@fontsource/bricolage-grotesque/latin-800.css';
import '@fontsource/figtree/latin-300.css';
import '@fontsource/figtree/latin-400.css';
import '@fontsource/figtree/latin-500.css';
import '@fontsource/figtree/latin-600.css';
import '@fontsource/figtree/latin-700.css';
import '@fontsource/figtree/latin-800.css';
import './styles.css';
import { App } from './app';
import { createClient, type ControllerClient } from './client';
import { ensureStyles } from '@cadabra/couchpad';
import { codeFromUrl } from './code';

ensureStyles();

// No pinch zoom on iOS (user-scalable=no is ignored there).
document.addEventListener('gesturestart', (e) => e.preventDefault());

const params = new URLSearchParams(location.search);
const initialCode = codeFromUrl(location.href);
const mount = (client: ControllerClient, autoJoinName?: string) =>
  render(<App client={client} initialCode={initialCode} autoJoinName={autoJoinName} />, document.getElementById('root')!);

if (import.meta.env.DEV && params.has('demo')) {
  const which = params.get('demo') ?? 'join';
  void import('./demo').then(({ createDemoClient }) => mount(createDemoClient(which), which === 'join' ? undefined : 'Maya'));
} else {
  mount(createClient());
}
