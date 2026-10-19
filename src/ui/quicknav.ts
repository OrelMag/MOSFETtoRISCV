// Quick navigation UI: the chapter menu (top bar, chapter title) and the search box (Ctrl/⌘ K, `/`).

import { chapters } from '../chapters';
import { chapterNo } from '../chapters/types';
import { itemSnippet, markRuns, type NavItem, type NavKind } from './chapternav';
import { h, icon } from './dom';
import { showPageKeys } from './keyhelp';
import { bindKeys, installKeys, MAC } from './keys';
import { resetSearchCaches } from './searchbuiltin';
import { ALL, parseQuery, pushRecent, recentItems, searchGroups, searchSources } from './searchsources';
import { settings } from './settings';

export const QUICK_KEY = MAC ? '⌘K' : 'Ctrl K';

/** The chapter (and step) the current route shows, if any. */
function here(): { chapter: string; step: number } | null {
  const m = /^#\/c\/([^/]+)(?:\/(\d+))?/.exec(location.hash);
  return m ? { chapter: m[1], step: Number(m[2] ?? 0) } : null;
}

const seen = (id: string, n: number) => Math.min(1, settings.visited(id).filter((k) => k < n).length / n);

function progressBar(p: number): HTMLElement {
  return p >= 1 ? h('span', { class: 'qn-done', title: 'All steps visited' }, icon('check', 14))
    : h('span', { class: 'qn-bar', title: p > 0 ? `${Math.round(p * 100)}% seen` : 'Not started' }, h('i', { style: `width:${Math.round(p * 100)}%` }));
}

/** Arrow keys move focus through `items`, wrapping. */
function arrowFocus(e: KeyboardEvent, items: HTMLElement[]): boolean {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n = items.length;
  items[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus();
  return true;
}

// ---- chapter menu ----------------------------------------------------------------------------

let menu: { el: HTMLElement; anchor: HTMLElement; off: () => void } | null = null;

export function closeChapterMenu(focusAnchor = false): void {
  if (!menu) return;
  const m = menu;
  menu = null;
  m.off();
  m.el.remove();
  m.anchor.setAttribute('aria-expanded', 'false');
  if (focusAnchor) m.anchor.focus();
}

/** Opens the list of chapters under `anchor` (a second call on the same anchor closes it). */
export function toggleChapterMenu(anchor: HTMLElement): void {
  if (menu) {
    const same = menu.anchor === anchor;
    closeChapterMenu();
    if (same) return;
  }
  const cur = here();
  const rows = chapters.map((c) => {
    const isCur = c.id === cur?.chapter;
    return h('a', { class: `qn-row${c.appendix ? ' appendix' : c.prologue ? ' prologue' : ''}`, href: `#/c/${c.id}/0`, role: 'menuitem', 'aria-current': isCur ? 'page' : null },
      h('span', { class: 'qn-num' }, chapterNo(c)),
      h('span', { class: 'qn-main' }, h('b', null, c.title), h('small', null, `${c.level} · ${c.steps.length} steps`)),
      progressBar(seen(c.id, c.steps.length)));
  });
  const search = h('button', { class: 'qn-search', role: 'menuitem' }, icon('search', 15), h('span', null, 'Search chapters, components, levels…'), h('kbd', null, QUICK_KEY));
  search.addEventListener('click', () => {
    closeChapterMenu();
    openQuickNav();
  });
  // the prologue and the appendix under their own headings
  const group = (cls: string, text: string) => h('div', { class: `qn-group${cls}`, role: 'presentation' }, text);
  const listed = rows.flatMap((r, i) => {
    const c = chapters[i], prev = chapters[i - 1];
    return c.appendix && !prev?.appendix ? [group('', 'Appendix'), r]
      : c.prologue && !prev?.prologue ? [group(' prologue', 'Prologue'), r]
      : !c.prologue && !c.appendix && prev?.prologue ? [group(' journey', 'The journey'), r] : [r];
  });
  const el = h('div', { class: 'ch-menu', role: 'menu', 'aria-label': 'Chapters' }, search, h('div', { class: 'qn-list' }, listed));
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.round(r.bottom + 6)}px`;
  el.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - 400)))}px`;
  document.body.append(el);

  const items = [search, ...rows];
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) closeChapterMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeChapterMenu(true);
    } else if (el.contains(document.activeElement)) arrowFocus(e, items);
  };
  const onHash = () => closeChapterMenu();
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('keydown', onKey, true);
  addEventListener('hashchange', onHash);
  addEventListener('resize', onHash);
  menu = { el, anchor, off: () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('hashchange', onHash);
    removeEventListener('resize', onHash);
  } };
  anchor.setAttribute('aria-expanded', 'true');
  const curRow = rows.find((a) => a.hasAttribute('aria-current'));
  (curRow ?? search).focus({ preventScroll: true });
  curRow?.scrollIntoView({ block: 'center' });
}

// ---- the search box ---------------------------------------------------------------------------------
// Sources (searchsources.ts, searchbuiltin.ts) give the rows; the box groups them, Tab / Shift Tab cycle the
// scope chips, `>` lists actions, and the footer says what ↵ and Shift ↵ do for the selected row.

let palette: HTMLElement | null = null;

const KIND_ICON: Partial<Record<NavKind, string>> = { component: 'bench', level: 'flag', codex: 'book', action: 'code' };

/** What ↵ does for a row, and Shift ↵ (null: nothing). */
export function verbs(it: NavItem): [string, string | null] {
  const tab = it.href ? 'Open in a new tab' : null;
  switch (it.kind) {
    case 'chapter': return ['Go to the chapter', tab];
    case 'step': return ['Go to the step', tab];
    case 'component': return ['Open in the workbench', tab];
    case 'level': return [it.locked ? 'Read the brief (locked)' : it.href?.includes('/play/') ? 'Play the level' : 'Open the level', tab];
    case 'codex': return [it.locked ? 'Read the summary (locked)' : 'Open the entry', tab];
    default: return ['Run it', null];
  }
}

const marked = (title: string, q: string): (Node | string)[] => markRuns(title, q).map(([t, on]) => (on ? h('mark', null, t) : t));

export function openQuickNav(initial = ''): void {
  if (palette) return;
  closeChapterMenu();
  resetSearchCaches();
  const back = document.activeElement as HTMLElement | null;
  const ctx = { hash: location.hash };
  const srcs = searchSources(ctx);
  const recent = recentItems();
  const cur = here();
  const input = h('input', {
    class: 'qn-input', type: 'text', placeholder: 'Search chapters, components, levels, codex, actions…', 'aria-label': 'Search',
    autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'qn-results', 'aria-autocomplete': 'list',
  });
  input.value = initial;
  const scopesEl = h('div', { class: 'qn-scopes', role: 'tablist', 'aria-label': 'Search in' });
  const list = h('div', { class: 'qn-list', id: 'qn-results', role: 'listbox', 'aria-label': 'Results' });
  const foot = h('div', { class: 'qn-foot', 'aria-hidden': 'true' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const box = h('div', { class: 'qnav', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Search' },
    h('div', { class: 'qn-field' }, icon('search', 18), input, h('kbd', null, 'Esc')), scopesEl, list, foot, live);
  const ov = h('div', { class: 'qnav-back' }, box);
  let shown: { el: HTMLElement; it: NavItem }[] = [];
  let sel = 0;
  let scope = ALL;
  const scopeIds = [ALL, ...srcs.map((s) => s.id)];

  const close = () => {
    if (!palette) return;
    palette = null;
    ov.remove();
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  const open = (it: NavItem, newTab = false) => {
    if (it.href) {
      pushRecent(it);
      close();
      if (newTab) window.open(new URL(it.href, location.href).href, '_blank', 'noopener');
      else location.hash = it.href;
    } else if (it.run) {
      close();
      it.run();
    }
  };
  const footer = () => {
    const it = shown[sel]?.it;
    const [enter, shift] = it ? verbs(it) : ['', null];
    foot.replaceChildren(...[
      h('span', { class: 'mv' }, h('kbd', null, '↑'), h('kbd', null, '↓'), 'move'),
      it ? h('span', { class: 'act' }, h('kbd', null, '↵'), enter) : null,
      shift ? h('span', { class: 'shift' }, h('kbd', null, 'Shift ↵'), shift) : null,
      h('span', { class: 'pre' }, '> actions')].filter((x): x is HTMLSpanElement => !!x));
  };
  const select = (i: number) => {
    const old = shown[sel];
    if (old) {
      old.el.classList.remove('sel');
      old.el.setAttribute('aria-selected', 'false');
    }
    sel = Math.max(0, Math.min(shown.length - 1, i));
    const r = shown[sel];
    footer();
    if (!r) return input.removeAttribute('aria-activedescendant');
    r.el.classList.add('sel');
    r.el.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', r.el.id);
    r.el.scrollIntoView({ block: 'nearest' });
  };
  const end = (it: NavItem): HTMLElement => {
    const e = h('span', { class: 'qn-end' });
    if (it.kind === 'chapter' && it.entry) {
      const n = chapters.find((c) => c.id === it.entry!.chapter)?.steps.length ?? 1;
      e.append(progressBar(seen(it.entry.chapter, n)));
    } else if (it.kind === 'step' && it.entry && settings.visited(it.entry.chapter).includes(it.entry.step)) {
      e.append(h('span', { class: 'ok', title: 'Visited' }, icon('check', 13)));
    }
    if (it.locked) e.append(h('span', { class: 'lock' }, 'locked'));
    else if (it.badge) e.append(h('span', { class: it.badge === 'solved' ? 'ok' : 'note' }, it.badge === 'solved' ? icon('check', 13) : null, it.badge));
    if (it.keys?.length) e.append(h('span', { class: 'keys' }, it.keys.map((k) => h('kbd', null, k))));
    e.append(h('span', { class: 'enter', 'aria-hidden': 'true' }, '↵'));
    return e;
  };
  const row = (it: NavItem, q: string, i: number): HTMLElement => {
    const lead = it.no ? h('span', { class: 'qn-num' }, it.no) : h('span', { class: 'qn-num k' }, icon(KIND_ICON[it.kind] ?? 'search', 14));
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const lt = `${it.title} ${it.entry?.chTitle ?? ''} ${it.alt ?? ''}`.toLowerCase();
    const inTitle = !words.length || words.every((w) => lt.includes(w) || /^\d+$/.test(w));
    const isCur = !!it.entry && cur?.chapter === it.entry.chapter && (it.kind === 'chapter' || cur.step === it.entry.step);
    const attrs = { class: `qn-row ${it.kind}${it.locked ? ' locked' : ''}`, id: `qn-r${i}`, role: 'option', 'aria-selected': 'false', 'aria-current': isCur ? 'page' : null };
    const el = it.href ? h('a', { ...attrs, href: it.href }) : h('div', attrs);
    el.append(lead, h('span', { class: 'qn-main' },
      h('b', null, marked(it.title, q)),
      h('small', null, it.sub),
      q && !inTitle && it.text ? h('span', { class: 'qn-snip' }, itemSnippet(it, q)) : null), end(it));
    el.addEventListener('click', (ev) => {
      const e = ev as MouseEvent;
      // Ctrl / ⌘ / Shift-click on a place: the browser's own new tab or window
      if (it.href && (e.ctrlKey || e.metaKey || e.shiftKey || e.button)) return;
      e.preventDefault();
      open(it);
    });
    el.addEventListener('pointermove', () => {
      const k = shown.findIndex((r) => r.el === el);
      if (k !== sel) select(k);
    });
    return el;
  };
  const pending = new Set<string>();
  const update = (keep = false) => {
    const raw = input.value;
    const res = searchGroups(srcs, raw, scope, ctx, recent);
    const q = parseQuery(raw).text;
    // the scope chips, with their counts for a query
    scopesEl.replaceChildren(...scopeIds.map((id) => {
      const s = srcs.find((x) => x.id === id);
      const n = id === ALL ? undefined : res.counts.get(id);
      const b = h('button', { class: `qn-scope${id === res.scope ? ' on' : ''}`, role: 'tab', 'aria-selected': String(id === res.scope), tabindex: '-1' },
        s ? s.scope : 'All', q && n !== undefined ? h('small', null, String(n)) : null);
      b.addEventListener('click', () => { setScope(id); input.focus(); });
      return b;
    }), h('span', { class: 'hint' }, h('kbd', null, 'Tab'), 'scope'));
    shown = [];
    const out: HTMLElement[] = [];
    for (const g of res.groups) {
      const head = h('div', { class: 'qn-group', role: 'presentation' }, h('span', null, g.title));
      if (g.more && g.scope) {
        const more = h('button', { class: 'more', tabindex: '-1', title: `Show all in ${g.title}` }, `+${g.more} more`);
        more.addEventListener('click', () => { setScope(g.scope!); input.focus(); });
        head.append(more);
      }
      out.push(head);
      for (const it of g.items) {
        const el = row(it, q, shown.length);
        shown.push({ el, it });
        out.push(el);
      }
    }
    // lazy sources: their chunk is fetched now, the list redrawn when it arrives
    for (const s of res.loading) {
      out.push(h('div', { class: 'qn-loading' }, `Loading ${s.title.toLowerCase()}…`));
      if (pending.has(s.id) || !s.load) continue;
      pending.add(s.id);
      s.load().then(() => {
        pending.delete(s.id);
        if (palette === ov) update(true);
      }, () => {
        pending.delete(s.id);
        if (palette === ov) list.append(h('div', { class: 'qn-empty' }, `Could not load ${s.title.toLowerCase()}.`));
      });
    }
    if (!shown.length && !res.loading.length) out.push(h('div', { class: 'qn-empty' }, 'Nothing matches.'));
    list.replaceChildren(...out);
    live.textContent = q ? `${shown.length} results` : '';
    const was = keep ? sel : 0;
    sel = 0;
    select(Math.max(0, Math.min(was, shown.length - 1)));
  };
  const setScope = (id: string) => {
    // a chip other than Actions drops the > prefix
    const p = parseQuery(input.value);
    if (p.prefix && id !== 'actions') input.value = p.text;
    scope = id;
    update();
  };
  input.addEventListener('input', () => update());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(sel + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      select(sel + (e.key === 'PageDown' ? 8 : -8));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = shown[sel];
      if (r) open(r.it, e.shiftKey && !!r.it.href);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const at = scopeIds.indexOf(searchGroups(srcs, input.value, scope, ctx).scope);
      setScope(scopeIds[(at + (e.shiftKey ? scopeIds.length - 1 : 1)) % scopeIds.length]);
    }
  });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // Esc first clears the query (and the scope), then closes
      if (input.value || scope !== ALL) {
        input.value = '';
        scope = ALL;
        update();
        input.focus();
      } else close();
    } else if (e.key === 'Tab' && e.target !== input) {
      e.preventDefault();
      input.focus();
    }
  });
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  palette = ov;
  document.body.append(ov);
  update();
  input.focus();
}

/** Focus the circuit (the stage of a chapter or the workbench); false where there is none. */
export function focusStage(): boolean {
  const st = document.querySelector<HTMLElement>('#view section.stage');
  if (!st) return false;
  st.focus({ preventScroll: true });
  st.scrollIntoView({ block: 'nearest' });
  return true;
}

/**
 * The global keys (keys.ts): Ctrl/⌘ K anywhere, even inside a sandbox drawer (capture phase); `/`, `?` and S
 * outside fields, and only if no page listener took them first (the sandbox flips a wire with `/`).
 */
export function installQuickNav(): void {
  installKeys();
  bindKeys({
    search: () => {
      if (palette) palette.querySelector('input')?.focus();
      else openQuickNav();
    },
    'search.slash': () => (palette ? false : openQuickNav()),
    help: () => showPageKeys(),
    'stage.focus': () => focusStage(),
  });
}
