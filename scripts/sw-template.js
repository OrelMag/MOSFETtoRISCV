// Service worker (vite.config.ts fills in VERSION and PRECACHE and writes it to dist/sw.js): the site works offline once visited.
//  - index.html and other same-origin files: network first, the cached copy when offline (a deploy shows at once).
//  - assets/ (hashed names, immutable): cache first. Everything under assets/ is precached at install.
//  - never touched (no respondWith: the browser fetches them as it always did): other origins, non-GET, ranges, and the large
//    optional downloads doom/ (the WAD), layout/ (sky130 layouts), yosys/ (WebAssembly synthesis).
// Caches are per version; the previous version's stays one more generation, because a tab opened before a deploy still loads its own lazy chunks.
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `mosfet-assets-${VERSION}`;
const META = 'mosfet-meta';
const SKIP = /\/(doom|layout|yosys)\//;
// Precache fetches in flight at once. Several hundred together queue the page's own chunk requests behind them (HTTP/1.1: six
// connections a host; Cache Storage writes in one line) and, on a slow link, share its bandwidth with the chunks the learner is waiting for.
const POOL = 4;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // a failed asset must not abort the install (it is fetched and cached when first used)
    // (hashed assets may come from the HTTP cache, where the page just fetched them; only the page itself is fetched fresh)
    const todo = ['./', ...PRECACHE];
    let next = 0;
    const lane = async () => {
      while (next < todo.length) {
        const u = todo[next++];
        await cache.add(u === './' ? new Request(u, { cache: 'reload' }) : u).catch(() => {});
      }
    };
    await Promise.all(Array.from({ length: POOL }, lane));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const meta = await caches.open(META);
    const old = await meta.match('current').then((r) => (r ? r.text() : ''));
    const keep = new Set([CACHE, `mosfet-assets-${old}`, META]);
    if (old !== VERSION) await meta.put('current', new Response(VERSION));
    for (const k of await caches.keys()) if (k.startsWith('mosfet-assets-') && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SKIP.test(url.pathname)) return;
  const inAssets = url.pathname.includes('/assets/');
  e.respondWith((async () => {
    if (inAssets) {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    }
    try {
      // A page load revalidates (an ETag: a 304 when nothing changed): through the HTTP cache, Firefox showed a deploy one reload late,
      // index.html being max-age=600 on GitHub Pages. A navigation cannot take a redirected response, so a redirect goes the plain way.
      const res = req.mode === 'navigate'
        ? await fetch(req.url, { cache: 'no-cache' }).then((r) => (r.redirected ? fetch(req) : r))
        : await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      // offline: a page navigation gets the cached page (the app routes by hash, so one page serves every route)
      const hit = await caches.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await caches.match('./') || await caches.match('index.html') : undefined);
      if (hit) return hit;
      throw err;
    }
  })());
});
