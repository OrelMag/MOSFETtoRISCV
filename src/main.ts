import './styles/theme.css';
import './styles/palettes.css';
import './styles/app.css';
import './styles/vivid.css';
import './styles/codeedit.css';
import './styles/mosfet.css';
import './styles/m6502.css';
import './styles/prologue.css';
import './styles/cards.css';
import './styles/doom.css';
import { startApp } from './ui/app';

startApp(document.getElementById('app')!);

// Offline / installable: the service worker (scripts/sw-template.js, written into dist/ by vite.config.ts). Production builds on
// http(s) only: not the dev server, and not the desktop program's app:// origin or a file: page, which are offline already.
if (import.meta.env.PROD && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* private mode, blocked: the site works without */ }); });
}
