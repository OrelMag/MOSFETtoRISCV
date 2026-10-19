// The search box's model (DOM-free): ranking items of every kind, the source registry and its groups,
// the > prefix, recent picks, the lazy campaign sources (locked levels listed with their brief only).

import { describe, expect, it } from 'vitest';
import { markRuns, rankItems, type NavItem } from '../src/ui/chapternav';
import { ALL, here, parseQuery, pushRecent, recentItems, registerActions, registerSearchSource, RECENT_KEY, searchGroups, searchSources, type KV, type SearchSource } from '../src/ui/searchsources';
import '../src/ui/searchbuiltin';

const item = (kind: NavItem['kind'], title: string, extra: Partial<NavItem> = {}): NavItem => ({ kind, id: title, title, sub: '', href: `#/x/${title}`, ...extra });

describe('ranking', () => {
  const items = [
    item('component', 'Full adder', { alt: 'full_adder Arithmetic' }),
    item('component', 'Ripple-carry adder', { alt: 'rca4 Arithmetic' }),
    item('component', 'Adder / subtractor', { alt: 'addsub8 Arithmetic' }),
    item('codex', 'Majority', { text: 'The carry out of a full adder is the majority of its inputs.' }),
    item('level', 'Mux', { locked: true }),
  ];

  it('puts a title that starts with the word first, then word starts, then the text', () => {
    expect(rankItems(items, 'adder').map((r) => r.item.title)).toEqual(['Adder / subtractor', 'Full adder', 'Ripple-carry adder', 'Majority']);
  });

  it('finds an item by its id or alias', () => {
    expect(rankItems(items, 'rca4')[0].item.title).toBe('Ripple-carry adder');
    expect(rankItems(items, 'ripple adder').map((r) => r.item.title)).toEqual(['Ripple-carry adder']);
  });

  it('needs every word, and keeps everything for an empty query', () => {
    expect(rankItems(items, 'adder zebra')).toEqual([]);
    expect(rankItems(items, '').length).toBe(items.length);
  });

  it('marks the matched part of a title, at a word start where it can', () => {
    expect(markRuns('Full adder', 'add')).toEqual([['Full ', false], ['add', true], ['er', false]]);
    expect(markRuns('Ripple-carry adder', 'carry add')).toEqual([['Ripple-', false], ['carry', true], [' ', false], ['add', true], ['er', false]]);
    expect(markRuns('Adder', '')).toEqual([['Adder', false]]);
  });
});

describe('sources and groups', () => {
  const fake = (id: string, order: number, items: NavItem[] | null, extra: Partial<SearchSource> = {}): SearchSource =>
    ({ id, title: id.toUpperCase(), scope: id, order: () => order, items: () => items, ...extra });
  const ctx = { hash: '#/' };

  it('groups matches per source in order, a few in All and all of them in a scope', () => {
    const many = Array.from({ length: 7 }, (_, i) => item('component', `adder ${i}`));
    const srcs = [fake('b', 2, [item('codex', 'adder law')]), fake('a', 1, many)].sort((x, y) => x.order(ctx) - y.order(ctx));
    const all = searchGroups(srcs, 'adder', ALL, ctx);
    expect(all.groups.map((g) => [g.id, g.items.length, g.more])).toEqual([['a', 4, 3], ['b', 1, 0]]);
    expect(all.counts.get('a')).toBe(7);
    const scoped = searchGroups(srcs, 'adder', 'a', ctx);
    expect(scoped.groups.map((g) => [g.id, g.items.length])).toEqual([['a', 7]]);
    // the other chips still get their counts
    expect(scoped.counts.get('b')).toBe(1);
  });

  it('reports a lazy source as loading until its items arrive', () => {
    let items: NavItem[] | null = null;
    const lazy = fake('lazy', 1, null, { items: () => items, load: async () => { items = [item('level', 'Adder level')]; } });
    const r1 = searchGroups([lazy], 'adder', ALL, ctx);
    expect(r1.loading).toEqual([lazy]);
    return lazy.load!().then(() => {
      const r2 = searchGroups([lazy], 'adder', ALL, ctx);
      expect(r2.loading).toEqual([]);
      expect(r2.groups[0].items[0].title).toBe('Adder level');
    });
  });

  it('lists Recent, On this page and the browse lists for an empty query', () => {
    const acts = [here(item('action', 'Run')), item('action', 'Theme')];
    const srcs = [fake('chapters', 0, [], { browse: () => [item('chapter', 'Adders')] }), fake('actions', 5, acts, { prefix: '>' })];
    const r = searchGroups(srcs, '', ALL, ctx, [item('step', 'Recent step')]);
    expect(r.groups.map((g) => [g.id, g.items.map((i) => i.title)])).toEqual([['recent', ['Recent step']], ['here', ['Run']], ['chapters', ['Adders']]]);
  });

  it('turns to the actions with >', () => {
    expect(parseQuery('> theme')).toEqual({ text: 'theme', prefix: '>' });
    expect(parseQuery('adder')).toEqual({ text: 'adder', prefix: null });
    const srcs = [fake('chapters', 0, [item('chapter', 'Theme park')]), fake('actions', 5, [item('action', 'Toggle theme')], { prefix: '>' })];
    const r = searchGroups(srcs, '>theme', ALL, ctx);
    expect(r.scope).toBe('actions');
    expect(r.groups.map((g) => g.id)).toEqual(['actions']);
  });

  it('replaces a source by id and removes it', () => {
    const off = registerSearchSource(fake('zz-test', 99, []));
    expect(searchSources(ctx).some((s) => s.id === 'zz-test')).toBe(true);
    off();
    expect(searchSources(ctx).some((s) => s.id === 'zz-test')).toBe(false);
  });
});

describe('recent picks', () => {
  const kv = (): KV & { m: Map<string, string> } => {
    const m = new Map<string, string>();
    return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };

  it('keeps places, newest first, without duplicates or actions, at most six', () => {
    const s = kv();
    for (let i = 0; i < 8; i++) pushRecent(item('component', `c${i}`), s);
    pushRecent(item('component', 'c3'), s);
    pushRecent({ kind: 'action', id: 'theme', title: 'Theme', sub: '', run: () => {} }, s);
    expect(recentItems(s).map((r) => r.id)).toEqual(['c3', 'c7', 'c6', 'c5', 'c4', 'c2']);
  });

  it('survives junk in storage', () => {
    const s = kv();
    s.m.set(RECENT_KEY, '{"not":"a list"}');
    expect(recentItems(s)).toEqual([]);
    s.m.set(RECENT_KEY, '[{"id":1},{"kind":"step","id":"a","title":"A","href":"javascript:x"},{"kind":"step","id":"b","title":"B","href":"#/c/b/0"}]');
    expect(recentItems(s).map((r) => r.id)).toEqual(['b']);
  });
});

describe('the built-in sources', () => {
  it('finds a workbench component for "adder", first on the workbench page', () => {
    const ctx = { hash: '#/workbench/rca4' };
    const srcs = searchSources(ctx);
    expect(srcs[0].id).toBe('workbench');
    const r = searchGroups(srcs, 'adder', ALL, ctx);
    expect(r.groups[0].id).toBe('workbench');
    expect(r.groups[0].items[0]).toMatchObject({ kind: 'component', href: '#/workbench/addsub8' });
    expect(r.groups.find((g) => g.id === 'chapters')?.items[0].title).toBe('Adders');
    // the campaign's chunk is not loaded until asked for
    expect(r.loading.map((s) => s.id).sort()).toEqual(['campaign', 'codex']);
  });

  it('puts chapters first on a chapter page, actions first in the sandbox, with the page\'s own actions', () => {
    expect(searchSources({ hash: '#/c/adders/2' })[0].id).toBe('chapters');
    expect(searchSources({ hash: '#/sandbox' })[0].id).toBe('actions');
    const off = registerActions(() => [item('action', 'Zap the chip')]);
    const acts = searchSources({ hash: '#/sandbox' })[0].items({ hash: '#/sandbox' })!;
    expect(acts[0].title).toBe('Zap the chip');
    off();
  });

  it('lists every campaign level and codex entry once loaded, locked ones pointing at their brief', async () => {
    const ctx = { hash: '#/' };
    const camp = searchSources(ctx).find((s) => s.id === 'campaign')!;
    await camp.load!();
    const levels = camp.items(ctx)!;
    expect(levels.length).toBeGreaterThan(50);
    const locked = levels.filter((l) => l.locked);
    expect(locked.length).toBeGreaterThan(0);
    // a locked level opens its brief on the map, never the level screen
    for (const l of locked) expect(l.href).toMatch(/^#\/campaign\/n\//);
    const codex = searchSources(ctx).find((s) => s.id === 'codex')!.items(ctx)!;
    expect(codex.length).toBeGreaterThan(50);
    expect(codex.every((c) => c.href === `#/campaign/codex/${c.id}`)).toBe(true);
    const r = searchGroups(searchSources(ctx), 'adder', ALL, ctx);
    expect(r.loading).toEqual([]);
    expect(r.groups.map((g) => g.id)).toEqual(expect.arrayContaining(['campaign', 'codex']));
  });
});
