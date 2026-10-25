// The search box's sources (DOM-free, tested in Node): a registry of things to search (chapters and steps,
// workbench components, campaign levels, the codex, actions), recent picks, and the grouping the box
// draws. A source may be lazy: items() is null until load() has fetched its chunk (the campaign's).

import { rankItems, type NavItem } from './chapternav';

export interface SearchCtx {
  /** The route (location.hash) the search was opened on. */
  hash: string;
}

export interface SearchSource {
  id: string;
  /** The group's heading. */
  title: string;
  /** The scope chip's label. */
  scope: string;
  /** Groups are listed lowest first (a page's own kind first). */
  order(ctx: SearchCtx): number;
  /** The items now, or null until load() has finished. */
  items(ctx: SearchCtx): readonly NavItem[] | null;
  load?(): Promise<unknown>;
  /** Its own ranking of a query over its items (the codex: aliases and spellings, campaign/codexsearch.ts); else rankItems. */
  rank?(items: readonly NavItem[], text: string): NavItem[];
  /** With an empty query in All: listed after Recent and On this page (the chapters). */
  browse?(ctx: SearchCtx): readonly NavItem[];
  /** Reached only through its chip or a prefix (with an empty query in All it is not listed). */
  prefix?: string;
}

const sources = new Map<string, SearchSource>();

/** Add a source (or replace the one with its id); returns its removal. */
export function registerSearchSource(s: SearchSource): () => void {
  sources.set(s.id, s);
  return () => {
    if (sources.get(s.id) === s) sources.delete(s.id);
  };
}

/** The registered sources, in this context's order. */
export function searchSources(ctx: SearchCtx): SearchSource[] {
  return [...sources.values()].sort((a, b) => a.order(ctx) - b.order(ctx));
}

// ---- actions: one source, many providers (the app, the page, the stage, the sandbox) -----------

export type ActionProvider = (ctx: SearchCtx) => NavItem[];
const providers: ActionProvider[] = [];

/** Contribute actions while registered (a page or an editor registers its own); returns the removal. */
export function registerActions(p: ActionProvider): () => void {
  providers.push(p);
  return () => {
    const i = providers.indexOf(p);
    if (i >= 0) providers.splice(i, 1);
  };
}

/** Every action now, the latest provider's first (the page's before the app's). */
export function allActions(ctx: SearchCtx): NavItem[] {
  return [...providers].reverse().flatMap((p) => p(ctx));
}

/** Actions listed under "On this page" with an empty query. */
export const HERE = new WeakSet<NavItem>();
export const here = <T extends NavItem>(it: T): T => (HERE.add(it), it);

// ---- recent picks --------------------------------------------------------------------------------

export const RECENT_KEY = 'mosfet2riscv:search:recent';
const RECENT_MAX = 6;

/** Storage as the recent list sees it (tests pass a Map-backed one). */
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }
const defaultKV = (): KV | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

type Stored = Pick<NavItem, 'kind' | 'id' | 'title' | 'sub' | 'href' | 'no' | 'locked'>;

export function recentItems(kv: KV | null = defaultKV()): NavItem[] {
  try {
    const raw = JSON.parse(kv?.getItem(RECENT_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is Stored => !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.title === 'string'
      && typeof r.href === 'string' && r.href.startsWith('#/')).slice(0, RECENT_MAX)
      .map((r) => ({ kind: r.kind, id: r.id, title: r.title, sub: String(r.sub ?? ''), href: r.href, no: r.no, locked: r.locked }));
  } catch {
    return [];
  }
}

/** Remember a place opened from the search (most recent first, no duplicates); actions are not kept. */
export function pushRecent(it: NavItem, kv: KV | null = defaultKV()): void {
  if (!it.href || it.kind === 'action') return;
  const keep: Stored = { kind: it.kind, id: it.id, title: it.title, sub: it.sub, href: it.href, no: it.no, locked: it.locked };
  const list = [keep, ...recentItems(kv).filter((r) => !(r.kind === it.kind && r.id === it.id))].slice(0, RECENT_MAX);
  try { kv?.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* not remembered */ }
}

// ---- grouping -------------------------------------------------------------------------------------

/** `>` lists actions only. */
export function parseQuery(raw: string): { text: string; prefix: string | null } {
  const t = raw.trimStart();
  return t.startsWith('>') ? { text: t.slice(1).trim(), prefix: '>' } : { text: raw.trim(), prefix: null };
}

export interface Group {
  id: string;
  title: string;
  items: NavItem[];
  /** Matches not shown (All shows a few per group). */
  more: number;
  /** The scope "+n more" switches to. */
  scope?: string;
}

export interface SearchResult {
  groups: Group[];
  /** Matches per source (scope chips), for a query. */
  counts: Map<string, number>;
  /** Sources still loading (their chunk was asked for). */
  loading: SearchSource[];
  /** The scope in effect (a prefix picks one). */
  scope: string;
}

export const ALL = 'all';

/**
 * What the box shows for a query in a scope ('all' or a source id). Empty query in All: Recent, On this page,
 * then each source's browse list; in a scope: everything it has. A query: each source's matches in the
 * context's order, a few per group in All.
 */
export function searchGroups(srcs: readonly SearchSource[], raw: string, scope: string, ctx: SearchCtx, recent: readonly NavItem[] = [], per = 4): SearchResult {
  const { text, prefix } = parseQuery(raw);
  if (prefix) {
    const p = srcs.find((s) => s.prefix === prefix);
    if (p) scope = p.id;
  }
  const counts = new Map<string, number>();
  const loading: SearchSource[] = [];
  const groups: Group[] = [];
  const inScope = scope === ALL ? srcs : srcs.filter((s) => s.id === scope);
  if (!text && scope === ALL) {
    if (recent.length) groups.push({ id: 'recent', title: 'Recent', items: [...recent], more: 0 });
    const act = srcs.find((s) => s.prefix === '>');
    const hereItems = (act?.items(ctx) ?? []).filter((a) => HERE.has(a));
    if (hereItems.length) groups.push({ id: 'here', title: 'On this page', items: hereItems.slice(0, 6), more: Math.max(0, hereItems.length - 6), scope: act?.id });
    for (const s of srcs) {
      const b = s.browse?.(ctx);
      if (b?.length) groups.push({ id: s.id, title: s.title, items: [...b], more: 0 });
    }
    return { groups, counts, loading, scope };
  }
  for (const s of inScope) {
    const items = s.items(ctx);
    if (!items) {
      loading.push(s);
      continue;
    }
    const ranked = !text && s.browse ? [...s.browse(ctx)] : s.rank ? s.rank(items, text) : rankItems(items, text).map((r) => r.item);
    counts.set(s.id, ranked.length);
    if (!ranked.length) continue;
    const n = scope === ALL ? per : 80;
    groups.push({ id: s.id, title: s.title, items: ranked.slice(0, n), more: Math.max(0, ranked.length - n), scope: s.id });
  }
  // the other scopes' counts, for their chips
  if (text && scope !== ALL) {
    for (const s of srcs) {
      if (counts.has(s.id)) continue;
      const items = s.items(ctx);
      if (items) counts.set(s.id, s.rank ? s.rank(items, text).length : rankItems(items, text).length);
    }
  }
  return { groups, counts, loading, scope };
}
