import './styles/theme.css';
import './styles/palettes.css';
import './styles/app.css';
import './styles/vivid.css';
import './styles/codeedit.css';
import './styles/mosfet.css';
import './styles/m6502.css';
import './styles/prologue.css';
import './styles/comm.css';
import './styles/cards.css';
import './styles/doom.css';
import './styles/notes.css';
import { startApp } from './ui/app';

startApp(document.getElementById('app')!);

// A deploy replaces the hashed chunks under a tab that is already open: a lazy chunk then fails to load (vite:preloadError). One reload
// fetches the new index.html and its chunks; a second failure within a minute is left to the route's "could not load" panel. (No
// preventDefault: Vite would then resolve the import with undefined, and the route's own handler would trip over it as the page leaves.)
window.addEventListener('vite:preloadError', () => {
  try {
    const last = Number(sessionStorage.getItem('mosfet:chunk-reload') ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('mosfet:chunk-reload', String(Date.now()));
    location.reload();
  } catch { /* no sessionStorage: the panel */ }
});

// Offline / installable: the service worker (scripts/sw-template.js, written into dist/ by vite.config.ts). Production builds on
// http(s) only: not the dev server, and not the desktop program's app:// origin or a file: page, which are offline already.
// Registered a few seconds after load: installing it downloads every chunk, and that must not compete with the first page's own.
if (import.meta.env.PROD && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    setTimeout(() => { navigator.serviceWorker.register('sw.js').catch(() => { /* private mode, blocked: the site works without */ }); }, 5000);
  });
}
