// Quick navigation UI: the chapter menu (top bar, chapter title) and the Ctrl/⌘ K search palette.

import { chapters } from '../chapters';
import { navEntries, searchNav, snippet, type NavEntry } from './chapternav';
import { h, icon } from './dom';
import { settings } from './settings';

const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
export const QUICK_KEY = MAC ? '⌘K' : 'Ctrl K';

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/** The chapter (and step) the current route shows, if any. */
function here(): { chapter: string; step: number } | null {
  const m = /^#\/c\/([^/]+)(?:\/(\d+))?/.exec(location.hash);
  return m ? { chapter: m[1], step: Number(m[2] ?? 0) } : null;
}

const seen = (id: string, n: number) => Math.min(1, settings.visited(id).length / n);

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
    return h('a', { class: 'qn-row', href: `#/c/${c.id}/0`, role: 'menuitem', 'aria-current': isCur ? 'page' : null },
      h('span', { class: 'qn-num' }, String(c.num).padStart(2, '0')),
      h('span', { class: 'qn-main' }, h('b', null, c.title), h('small', null, `${c.level} · ${c.steps.length} steps`)),
      progressBar(seen(c.id, c.steps.length)));
  });
  const search = h('button', { class: 'qn-search', role: 'menuitem' }, icon('search', 15), h('span', null, 'Search chapters and steps…'), h('kbd', null, QUICK_KEY));
  search.addEventListener('click', () => {
    closeChapterMenu();
    openQuickNav();
  });
  const el = h('div', { class: 'ch-menu', role: 'menu', 'aria-label': 'Chapters' }, search, h('div', { class: 'qn-list' }, rows));
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

// ---- search palette --------------------------------------------------------------------------

let palette: HTMLElement | null = null;

export function openQuickNav(): void {
  if (palette) return;
  closeChapterMenu();
  const back = document.activeElement as HTMLElement | null;
  const entries = navEntries(chapters);
  const stepsOf = new Map(chapters.map((c) => [c.id, c.steps.length]));
  const cur = here();
  const input = h('input', {
    class: 'qn-input', type: 'text', placeholder: 'Jump to a chapter or step…', 'aria-label': 'Search chapters and steps',
    autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'qn-results',
  });
  const list = h('div', { class: 'qn-list', id: 'qn-results', role: 'listbox' });
  const box = h('div', { class: 'qnav', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick navigation' },
    h('div', { class: 'qn-field' }, icon('search', 18), input, h('kbd', null, 'Esc')), list);
  const ov = h('div', { class: 'qnav-back' }, box);
  let shown: HTMLAnchorElement[] = [];
  let sel = 0;

  const close = () => {
    if (!palette) return;
    palette = null;
    ov.remove();
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  const select = (i: number) => {
    shown[sel]?.classList.remove('sel');
    sel = Math.max(0, Math.min(shown.length - 1, i));
    const a = shown[sel];
    if (!a) return;
    a.classList.add('sel');
    input.setAttribute('aria-activedescendant', a.id);
    a.scrollIntoView({ block: 'nearest' });
  };
  const row = (e: NavEntry, q: string, i: number): HTMLAnchorElement => {
    const n = stepsOf.get(e.chapter) ?? 1;
    const ch = e.step < 0;
    const titleHit = !q || q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => e.lt.includes(w) || e.chTitle.toLowerCase().includes(w) || /^\d+$/.test(w));
    const a = h('a', { class: `qn-row${ch ? '' : ' step'}`, href: e.href, id: `qn-r${i}`, role: 'option',
      'aria-current': cur?.chapter === e.chapter && (ch || cur.step === e.step) ? 'page' : null },
      h('span', { class: 'qn-num' }, String(e.num).padStart(2, '0')),
      h('span', { class: 'qn-main' },
        h('b', null, e.title),
        h('small', null, ch ? `${e.level} · ${n} steps` : `${e.chTitle} · step ${e.step + 1} of ${n}`),
        q && !titleHit ? h('span', { class: 'qn-snip' }, snippet(e, q)) : null),
      ch ? progressBar(seen(e.chapter, n)) : settings.visited(e.chapter).includes(e.step) ? h('span', { class: 'qn-done', title: 'Visited' }, icon('check', 14)) : h('span'));
    a.addEventListener('click', close);
    a.addEventListener('pointermove', () => { if (shown[sel] !== a) select(shown.indexOf(a)); });
    return a;
  };
  const update = () => {
    const q = input.value.trim();
    const res = searchNav(entries, q);
    shown = res.map((e, i) => row(e, q, i));
    list.replaceChildren(...(shown.length ? shown : [h('div', { class: 'qn-empty' }, 'Nothing matches.')]));
    sel = 0;
    const at = q ? 0 : Math.max(0, res.findIndex((e) => e.chapter === cur?.chapter));
    select(at);
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(sel + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      select(sel + (e.key === 'PageDown' ? 8 : -8));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const a = shown[sel];
      if (!a) return;
      close();
      location.hash = a.getAttribute('href')!;
    }
  });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
    if (e.key === 'Tab') {
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

/** Ctrl/⌘ K anywhere, `/` outside text fields (and outside the sandbox, which uses it for wires). */
export function installQuickNav(): void {
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'k' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      if (palette) palette.querySelector('input')?.focus();
      else openQuickNav();
    } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !typing(e.target) && !palette && !location.hash.startsWith('#/sandbox')) {
      e.preventDefault();
      openQuickNav();
    }
  });
}
