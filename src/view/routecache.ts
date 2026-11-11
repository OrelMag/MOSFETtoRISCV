// The route cache: a level's wires-first drawing and its routed wires, made once at build time (scripts/lens-routes.ts →
// public/routes/) for every library level whose first route is slow, so opening it costs a fetch instead of a route
// (up to 5.5 s for the slowest today). A view rule's output, never part of the netlist: the simulation knows nothing of it.
//
// An entry is keyed twice: by the level's drawing (layout.ts drawingKey of the author's netlist, so a redrawn level
// misses) and by the router's rules (ROUTE_RULES: a hash of the routing sources made by vite.config.ts and the build
// script alike, so files left from another build miss). A miss routes live, as before. Only the author's drawing is
// cached: a learner's arrangement (layout.ts applyLayout) is always routed live.
//
// DOM-free: the build script makes entries with cacheEntry, SchematicView.show takes them with fromEntry, and
// tests/route-cache.test.ts holds a restored entry equal to a live route.
import type { ComponentDef, NetDef, Netlist } from '../sim/types';
import { drawingKey } from './layout';
import { routeNetlist, type RoutedNet } from './route';
import { drawnNetlist } from './wirefirst';

declare const __ROUTE_RULES__: string;
/** The routing rules this build was made with (vite.config.ts defines it; outside Vite, e.g. a bare script, 'dev'). */
export const ROUTE_RULES: string = typeof __ROUTE_RULES__ === 'string' ? __ROUTE_RULES__ : 'dev';

export interface RouteEntry {
  key: string;
  rules: string;
  /** Nets whose tags wires-first changed: [index, the drawn net's tags (null: a wire, no tags)]. */
  drawn: [number, string[] | true | null][];
  nets: RoutedNet[];
}

/** The entry for a level drawn from `authored` (its author's netlist): what wires-first made of it, and its routing. */
export function cacheEntry(def: ComponentDef, authored: Netlist, rules = ROUTE_RULES): RouteEntry {
  const drawn = drawnNetlist(def, authored);
  const diff: RouteEntry['drawn'] = [];
  if (drawn !== authored) drawn.nets.forEach((n, i) => {
    const a = authored.nets[i];
    if (n !== a) diff.push([i, n.tags ?? null]);
  });
  return { key: drawingKey(authored), rules, drawn: diff, nets: routeNetlist(def, drawn).nets };
}

/** The drawn netlist and routed nets an entry stands for, or null when it is for another drawing or other rules. */
export function fromEntry(e: RouteEntry, authored: Netlist, rules = ROUTE_RULES): { drawn: Netlist; nets: RoutedNet[] } | null {
  if (e.rules !== rules || e.key !== drawingKey(authored)) return null;
  if (e.drawn.some(([i]) => i >= authored.nets.length) || e.nets.length !== authored.nets.length) return null;
  let drawn = authored;
  if (e.drawn.length) {
    const changed = new Map(e.drawn);
    drawn = { ...authored, nets: authored.nets.map((n, i) => {
      if (!changed.has(i)) return n;
      const out: NetDef = { ...n };
      delete out.tags;
      delete out.tagAt;
      const t = changed.get(i);
      if (t) out.tags = Array.isArray(t) ? [...t] : t;
      return out;
    }) };
  }
  return { drawn, nets: e.nets };
}

/** File name of a level's entry under routes/ (ids are generated: keep them to safe characters, a hash keeps them apart). */
export function routeFile(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return `${id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60)}-${h.toString(36)}.json`;
}

export interface RouteIndex {
  rules: string;
  /** Level id → its entry's drawing key. */
  levels: Record<string, string>;
}

// ---- the page's store: the index once, entries as levels come into reach ----

const entries = new Map<string, RouteEntry>();
const pending = new Map<string, Promise<void>>();
let index: Promise<RouteIndex | null> | null = null;
/** Off outside a production build (the dev server has no fresh routes/), and wherever fetch is missing. */
let enabled = typeof fetch === 'function' && typeof location !== 'undefined' && import.meta.env?.PROD === true;

/** Tests and scripts: use the store without a build (entries put by hand). */
export function enableRouteCache(on: boolean): void {
  enabled = on;
}

function loadIndex(): Promise<RouteIndex | null> {
  return (index ??= fetch('routes/index.json')
    .then((r) => (r.ok ? (r.json() as Promise<RouteIndex>) : null))
    .then((x) => (x && x.rules === ROUTE_RULES ? x : null))
    .catch(() => null));
}

/** Fetch the entries of these levels that the index has, in the background; resolves when they are in (or missing). */
export function prefetchRoutes(defs: Iterable<ComponentDef>): Promise<void> {
  if (!enabled) return Promise.resolve();
  const ids = new Set<string>();
  for (const d of defs) if (!entries.has(d.id) && !pending.has(d.id)) ids.add(d.id);
  if (!ids.size) return Promise.all(pending.values()).then(() => {});
  return loadIndex().then((ix) => {
    if (!ix) return;
    const wait: Promise<void>[] = [];
    for (const id of ids) {
      if (!(id in ix.levels) || entries.has(id)) continue;
      let p = pending.get(id);
      if (!p) {
        p = fetch(`routes/${routeFile(id)}`)
          .then((r) => (r.ok ? (r.json() as Promise<RouteEntry>) : null))
          .then((e) => { if (e) entries.set(id, e); })
          .catch(() => {})
          .finally(() => pending.delete(id));
        pending.set(id, p);
      }
      wait.push(p);
    }
    return Promise.all(wait).then(() => {});
  });
}

/** Put an entry by hand (tests). */
export function putRouteEntry(id: string, e: RouteEntry): void {
  entries.set(id, e);
}

/** The cached drawing of this level, if an entry for exactly this drawing is in memory; else null (route live). */
export function cachedLevel(def: ComponentDef, authored: Netlist): { drawn: Netlist; nets: RoutedNet[] } | null {
  const e = entries.get(def.id);
  if (!e) return null;
  const r = fromEntry(e, authored);
  // a wrong entry is dropped, so the next show does not try it again
  if (!r) entries.delete(def.id);
  return r;
}

/** The levels one and two below a level: what a learner may open next. */
export function levelsBelow(node: { children?: Map<string, { def: ComponentDef; children?: Map<string, { def: ComponentDef }> }> }): ComponentDef[] {
  const out: ComponentDef[] = [];
  for (const c of node.children?.values() ?? []) {
    out.push(c.def);
    for (const g of c.children?.values() ?? []) out.push(g.def);
  }
  return out;
}
