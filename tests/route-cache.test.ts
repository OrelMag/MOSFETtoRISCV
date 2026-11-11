// The route cache (src/view/routecache.ts, scripts/lens-routes.ts): a level restored from its entry, as the page gets
// it from JSON, is drawn exactly as a live route draws it (the same wires-first decisions, the same paths, dots and
// labels); an entry for another drawing of the level, or made with other routing rules, is never used.
import { describe, expect, it } from 'vitest';
import { registry } from '../src/lib/define';
import { reachableDefs } from '../src/lib/resolve';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { cacheEntry, cachedLevel, enableRouteCache, fromEntry, putRouteEntry, routeFile, type RouteEntry } from '../src/view/routecache';
import { drawnNetlist } from '../src/view/wirefirst';
import { tick } from './yieldtick';

const tagged = (d: ComponentDef) => netlistOf(d)!.nets.some((n) => n.tags === true || (n.tags?.length ?? 0) > 0);
/** Levels wires-first changes (the interesting case) and plain ones, small enough to route in a unit test. */
const sample = (): ComponentDef[] => {
  const all = [...new Set([...reachableDefs(), ...registry.values()])].filter((d) => !d.prim && netlistOf(d) && netlistOf(d)!.nets.length <= 60);
  const changed = all.filter((d) => tagged(d) && drawnNetlist(d, netlistOf(d)!) !== netlistOf(d));
  const plain = all.filter((d) => !tagged(d));
  return [...changed.filter((_, i) => i % Math.max(1, Math.floor(changed.length / 24)) === 0), ...plain.slice(0, 6)];
};
const viaJson = (e: RouteEntry): RouteEntry => JSON.parse(JSON.stringify(e)) as RouteEntry;

describe('route cache', () => {
  it('a restored level equals a live route: the drawing wires-first made, and every net as routed', async () => {
    const defs = sample();
    expect(defs.length).toBeGreaterThan(20);
    for (const d of defs) {
      const nl = netlistOf(d)!;
      const got = fromEntry(viaJson(cacheEntry(d, nl, 'r')), nl, 'r');
      expect(got, d.id).not.toBeNull();
      const drawn = drawnNetlist(d, nl);
      expect(got!.drawn.nets, d.id).toEqual(drawn.nets);
      expect(got!.drawn.instances, d.id).toBe(nl.instances);
      expect(got!.nets, d.id).toEqual(JSON.parse(JSON.stringify(routeNetlist(d, drawn).nets)));
      await tick();
    }
  }, 120_000);

  it('an entry for another drawing of the level, or other rules, is not used', () => {
    const d = sample()[0], nl = netlistOf(d)!;
    const e = viaJson(cacheEntry(d, nl, 'r'));
    // the author moved a part: the drawing's key changes
    const moved = { ...nl, instances: nl.instances.map((i, k) => (k === 0 ? { ...i, at: [(i.at?.[0] ?? 0) + 2, i.at?.[1] ?? 0] as [number, number] } : i)) };
    expect(fromEntry(e, moved, 'r')).toBeNull();
    expect(fromEntry(e, nl, 'other rules')).toBeNull();
    expect(fromEntry({ ...e, nets: e.nets.slice(1) }, nl, 'r')).toBeNull();
  });

  it('the page takes an entry only for that exact drawing, and drops a wrong one', () => {
    enableRouteCache(true);
    try {
      const d = sample()[1], nl = netlistOf(d)!;
      putRouteEntry(d.id, viaJson(cacheEntry(d, nl)));
      expect(cachedLevel(d, nl)?.drawn.nets).toEqual(drawnNetlist(d, nl).nets);
      putRouteEntry(d.id, { ...viaJson(cacheEntry(d, nl)), key: 'stale' });
      expect(cachedLevel(d, nl)).toBeNull();
      // dropped: the next show routes live without trying it again
      expect(cachedLevel(d, nl)).toBeNull();
    } finally {
      enableRouteCache(false);
    }
  });

  it('file names are safe and apart', () => {
    const ids = ['alu32', 'rom_3479e5f1', 'pipe_IDEX_192', 'a/b', 'a?b', 'x'.repeat(200)];
    const names = ids.map(routeFile);
    expect(new Set(names).size).toBe(ids.length);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_.-]+\.json$/);
  });
});
