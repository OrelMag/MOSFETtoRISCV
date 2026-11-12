import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// scripts/sw-template.js run against a fake worker scope: the precache must not fetch hundreds of files at once.
const src = readFileSync(new URL('../scripts/sw-template.js', import.meta.url), 'utf8');

function install(precache: string[], failing: (u: string) => boolean = () => false) {
  const listeners: Record<string, (e: any) => void> = {};
  let active = 0, peak = 0;
  const added: string[] = [];
  const cache = {
    async add(r: string | { url: string }) {
      const u = typeof r === 'string' ? r : r.url;
      active++; peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 1));
      active--;
      if (failing(u)) throw new Error('offline');
      added.push(u);
    },
  };
  const scope: any = {
    addEventListener: (t: string, f: (e: any) => void) => { listeners[t] = f; },
    caches: { open: async () => cache },
    skipWaiting: async () => { added.push('<skipWaiting>'); },
    location: { origin: 'http://x' },
    Request: class { constructor(public url: string) {} },
    URL, Response, Promise, Set, Array,
  };
  scope.self = scope;
  vm.runInNewContext(src.replace('__VERSION__', 't').replace('__PRECACHE__', JSON.stringify(precache)), scope);
  let done: Promise<unknown> = Promise.resolve();
  listeners.install({ waitUntil: (p: Promise<unknown>) => { done = p; } });
  return { done: () => done, peak: () => peak, added };
}

describe('service worker install', () => {
  const files = Array.from({ length: 300 }, (_, i) => `assets/c${i}.js`);

  it('fetches a few files at a time, all of them, the page first, then skips waiting', async () => {
    const w = install(files);
    await w.done();
    expect(w.peak()).toBeGreaterThan(1);
    expect(w.peak()).toBeLessThanOrEqual(4);
    expect(w.added.length).toBe(files.length + 2);
    expect(w.added.at(-1)).toBe('<skipWaiting>');
    expect(new Set(w.added).size).toBe(w.added.length);
  });

  it('a failed asset does not abort the install', async () => {
    const w = install(files, (u) => u.endsWith('c7.js') || u.endsWith('c200.js'));
    await w.done();
    expect(w.added.length).toBe(files.length + 2 - 2);
    expect(w.added.at(-1)).toBe('<skipWaiting>');
  });
});

// The fetch handler with a fake network: what it asks the network for (release review R5: a page load must revalidate).
function fetchScope(source = src) {
  const listeners: Record<string, (e: any) => void> = {};
  const calls: { url: string; init?: RequestInit; viaRequest: boolean }[] = [];
  let redirected = false;
  const scope: any = {
    addEventListener: (t: string, f: (e: any) => void) => { listeners[t] = f; },
    caches: { open: async () => ({ put: async () => {} }), match: async () => undefined },
    location: { origin: 'http://x' },
    fetch: async (r: string | { url: string }, init?: RequestInit) => {
      calls.push({ url: typeof r === 'string' ? r : r.url, init, viaRequest: typeof r !== 'string' });
      return { ok: true, redirected: typeof r === 'string' && redirected, clone() { return this; } };
    },
    URL, Response, Promise, Set, Array,
  };
  scope.self = scope;
  vm.runInNewContext(source.replace('__VERSION__', 't').replace('__PRECACHE__', '[]'), scope);
  const get = async (url: string, mode = 'navigate') => {
    let out: Promise<unknown> = Promise.resolve();
    listeners.fetch({ request: { url, mode, method: 'GET', headers: new Headers() }, respondWith: (p: Promise<unknown>) => { out = p; } });
    return out;
  };
  return { get, calls, redirect: (on: boolean) => { redirected = on; } };
}

describe('service worker fetch', () => {
  it('a page load revalidates the page (no stale index.html from the HTTP cache after a deploy)', async () => {
    const w = fetchScope();
    await w.get('http://x/');
    expect(w.calls).toEqual([{ url: 'http://x/', init: { cache: 'no-cache' }, viaRequest: false }]);
  });

  it('a redirected page load is fetched again the plain way (a navigation cannot take a redirected response)', async () => {
    const w = fetchScope();
    w.redirect(true);
    await w.get('http://x/');
    expect(w.calls.map((c) => c.viaRequest)).toEqual([false, true]);
  });

  it('other same-origin files go through as they are', async () => {
    const w = fetchScope();
    await w.get('http://x/hwstats.json', 'cors');
    expect(w.calls).toEqual([{ url: 'http://x/hwstats.json', init: undefined, viaRequest: true }]);
  });
});
