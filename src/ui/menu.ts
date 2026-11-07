// The right-click menu's shell, for every surface: one menu on the page at a time, rows with a shortcut, a hint, a tick
// or the reason they are off, groups that open beside it (or in place in a bottom sheet on a touch screen), every key
// while it is open, and the focus given back. What the rows are is up to the caller (editor/ctxmenu.ts, view/schematic.ts,
// editor/fsmchipui.ts). The part that decides things is DOM-free (tests/menu.test.ts); smoke drives the rest.

import { h } from './dom';
import { itemsOf, menuStep } from './menukeys';

export interface MenuItem {
  label: string;
  /** Its shortcut, at the row's end (hidden on a touch screen). */
  key?: string;
  /** A line under the label. */
  hint?: string;
  run?(): void;
  /** Off, and skipped by the arrows: for a row that needs no explaining (nothing to paste). */
  disabled?: boolean;
  /** Off for this reason, shown in the row. The arrows stop on it, so a screen reader reads it. */
  why?: string;
  /** A tick (absent: not a tickable row). */
  checked?: boolean;
  /** A group: opens beside the row, or in place in the sheet. A function runs when it opens: its code may load then. */
  sub?: MenuEntry[] | (() => MenuEntry[] | Promise<MenuEntry[]>);
}
/** null: a separator. */
export type MenuEntry = MenuItem | null;

export interface MenuOptions {
  /** An element already holding a header (a hue row, a note); the rows go after it. */
  into?: HTMLElement;
  /** What gets the focus back, when nothing had it (a press on a canvas leaves it on the page). */
  back?: HTMLElement | SVGElement;
  /** The button that opened it: a press on it does not count as outside, so its click can close the menu. */
  toggle?: Element;
  /** Who opened it, for closeMenu(owner) and menuOpenFor. */
  owner?: object;
  label?: string;
}

/** The context-menu key, or Shift+F10 where a keyboard has none. */
export const isMenuKey = (e: { key: string; shiftKey?: boolean }): boolean => e.key === 'ContextMenu' || (e.key === 'F10' && !!e.shiftKey);

const EDGE = 8;

/** Where a menu of this size opens for a point: up or left of it when it would overflow, always on screen. */
export function menuSpot(x: number, y: number, w: number, hh: number, vw: number, vh: number): { left: number; top: number } {
  return {
    left: Math.max(EDGE, x + w > vw - EDGE ? x - w : x),
    top: Math.max(EDGE, y + hh > vh - EDGE ? y - hh : y),
  };
}

/** Where a group opens beside its row: right of the menu, else left of it; level with the row, kept on screen. */
export function flySpot(menu: { left: number; right: number }, rowTop: number, w: number, hh: number, vw: number, vh: number): { left: number; top: number } {
  const right = menu.right - 3, left = menu.left - w + 3;
  const fitsRight = right + w <= vw - EDGE, fitsLeft = left >= EDGE;
  // neither fits: the side with more room, kept on screen
  const x = fitsRight ? right : fitsLeft ? left : vw - EDGE - menu.right > menu.left - EDGE ? vw - EDGE - w : EDGE;
  return { left: Math.max(EDGE, x), top: Math.max(EDGE, Math.min(rowTop - 6, vh - hh - EDGE)) };
}

/** A point for a menu opened by key: on the target (`box`), within what is on screen of its view. */
export function anchorPoint(box: { left: number; top: number; width: number; height: number } | null, view: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  const margin = 16;
  if (!box) return { x: view.left + margin, y: view.top + margin };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  return {
    x: clamp(box.left + Math.min(box.width, 70), view.left + margin, view.left + view.width - margin),
    y: clamp(box.top + Math.min(box.height, 24), view.top + margin, view.top + view.height - margin),
  };
}

/** The next row starting with this letter after `at`, wrapping (-1: none). */
export function typeAhead(labels: readonly string[], at: number, ch: string): number {
  const c = ch.toLowerCase();
  for (let n = 1; n <= labels.length; n++) {
    const i = (at + n + labels.length) % labels.length;
    // a tick is not the row's first letter
    if (labels[i].replace(/^[✓\s]+/, '').toLowerCase().startsWith(c)) return i;
  }
  return -1;
}

// ---- the open menu -----------------------------------------------------------------------------------------------

interface Open {
  el: HTMLElement;
  fly: { el: HTMLElement; row: HTMLElement } | null;
  /** What Esc gives the focus back to. */
  opener: HTMLElement | SVGElement | null;
  toggle?: Element;
  owner?: object;
  timer: ReturnType<typeof setTimeout> | null;
}
let cur: Open | null = null;
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const onOutside = (e: PointerEvent) => {
  if (!cur) return;
  const t = e.target as Node;
  if (!cur.el.contains(t) && !cur.fly?.el.contains(t) && !cur.toggle?.contains(t)) closeMenu();
};
// A keyboard's contextmenu event comes after the key (on its release, on Windows), to whatever has the focus by then.
const onContext = (e: Event) => {
  if (!cur) return;
  const t = e.target as Node;
  if (cur.el.contains(t) || cur.fly?.el.contains(t)) e.preventDefault();
};
/** The menu key closed the menu: the event still coming for that key must not open one again where the focus went back to. */
function swallowNextContext(): void {
  const eat = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    off();
  };
  const off = () => {
    document.removeEventListener('contextmenu', eat, true);
    clearTimeout(t);
  };
  const t = setTimeout(off, 1000);
  document.addEventListener('contextmenu', eat, true);
}
const onRoute = () => {
  closeMenu();
  closePicker();
};

function closeFly(): void {
  if (!cur?.fly) return;
  cur.fly.row.setAttribute('aria-expanded', 'false');
  cur.fly.el.remove();
  cur.fly = null;
}

/** Close the open menu (`owner`: only if it opened it). */
export function closeMenu(owner?: object): void {
  if (!cur || (owner && cur.owner !== owner)) return;
  if (cur.timer) clearTimeout(cur.timer);
  closeFly();
  cur.el.remove();
  cur = null;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('contextmenu', onContext, true);
  removeEventListener('hashchange', onRoute);
}

export const menuOpenFor = (owner: object): boolean => cur?.owner === owner;

function closeBack(): void {
  const back = cur?.opener;
  closeMenu();
  if (back?.isConnected) back.focus({ preventScroll: true });
}

/** Keys the menu answers beyond a printable character. The rest (F5, F12, a volume key) stay the browser's. */
const MENU_KEYS = new Set(['Escape', 'Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

function onKey(e: KeyboardEvent): void {
  if (!cur || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
  // A command (Ctrl+Z) changes what the menu was opened on: it goes through, and the menu goes.
  if (e.ctrlKey || e.metaKey || e.altKey) return closeMenu();
  const k = e.key;
  if (!isMenuKey(e) && k.length !== 1 && !MENU_KEYS.has(k)) return;
  // A letter must not reach a page's single-key shortcuts behind the menu.
  e.preventDefault();
  e.stopPropagation();
  if (isMenuKey(e)) swallowNextContext();
  if (isMenuKey(e) || k === 'Tab') return closeBack();
  const active = document.activeElement as HTMLElement | null;
  const panel = cur.fly?.el.contains(active) ? cur.fly.el : cur.el;
  const inFly = panel !== cur.el;
  if (k === 'Escape' || (k === 'ArrowLeft' && inFly)) {
    if (inFly) {
      const row = cur.fly!.row;
      closeFly();
      row.focus({ preventScroll: true });
      return;
    }
    if (k === 'Escape') closeBack();
    return;
  }
  const rows = itemsOf(panel);
  const at = rows.indexOf(active as HTMLElement);
  if (k === 'Enter' || k === ' ') return void active?.click();
  if (k === 'ArrowRight') {
    if (!active?.getAttribute('aria-haspopup')) return;
    // open already (the pointer rested on it, or the sheet): go in
    const nested = active.nextElementSibling?.classList.contains('ctx-nest') ? active.nextElementSibling as HTMLElement : null;
    if (nested) itemsOf(nested)[0]?.focus({ preventScroll: true });
    else active.click();
    return;
  }
  const to = k.length === 1 ? typeAhead(rows.map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()), at, k) : menuStep(k, at, rows.length);
  if (to >= 0) rows[to].focus({ preventScroll: true });
}

function rowOf(it: MenuItem): HTMLElement {
  const check = it.checked !== undefined;
  const hasSub = !!it.sub;
  const b: HTMLElement = h('button', {
    role: check ? 'menuitemcheckbox' : 'menuitem',
    'aria-checked': check ? String(it.checked) : null,
    disabled: it.disabled ? true : null,
    'aria-disabled': it.why ? 'true' : null,
    'aria-haspopup': hasSub ? 'menu' : null,
    'aria-expanded': hasSub ? 'false' : null,
    onclick: () => {
      if (it.why || !cur) return;
      if (hasSub) return void (coarse() ? nest(b, it) : openFly(b, it, true));
      closeMenu();
      it.run?.();
    },
    onpointerover: (e: Event) => { if ((e as PointerEvent).pointerType === 'mouse' && !coarse()) hovered(b, it); },
  },
    h('span', { class: 'ctx-l' }, check ? `${it.checked ? '✓' : ' '} ${it.label}` : it.label,
      it.hint ? h('small', null, it.hint) : null, it.why ? h('small', null, it.why) : null),
    it.key ? h('kbd', null, it.key) : null,
    hasSub ? h('span', { class: 'ctx-ar', 'aria-hidden': 'true' }, coarse() ? '▾' : '▸') : null);
  return b;
}

/** The rows of a list into an element: separators never lead, trail or double. */
function fill(el: HTMLElement, list: readonly MenuEntry[]): void {
  for (const it of list) {
    if (it) el.append(rowOf(it));
    else if (el.lastElementChild && el.lastElementChild.tagName !== 'HR') el.append(h('hr'));
  }
  if (el.lastElementChild?.tagName === 'HR') el.lastElementChild.remove();
}

/** A group's rows, once its code has loaded. */
function fillSub(el: HTMLElement, it: MenuItem, done: () => void): void {
  const got = typeof it.sub === 'function' ? it.sub() : it.sub!;
  if (!(got instanceof Promise)) {
    fill(el, got);
    return done();
  }
  const wait = h('p', { class: 'ctx-note' }, 'Loading…');
  el.append(wait);
  done();
  got.then((list) => {
    if (!el.isConnected) return;
    wait.remove();
    fill(el, list);
    done();
  }, () => { wait.textContent = 'Could not load: reload the page'; });
}

function openFly(row: HTMLElement, it: MenuItem, focus: boolean): void {
  if (!cur) return;
  if (cur.fly?.row === row) {
    if (focus) itemsOf(cur.fly.el)[0]?.focus({ preventScroll: true });
    return;
  }
  closeFly();
  const f = h('div', { class: 'ctx-menu fly', role: 'menu', 'aria-label': it.label });
  document.body.append(f);
  cur.fly = { el: f, row };
  row.setAttribute('aria-expanded', 'true');
  const place = () => {
    const m = cur?.fly?.el === f ? cur.el.getBoundingClientRect() : null;
    if (!m) return;
    const r = row.getBoundingClientRect();
    const s = flySpot(m, r.top, f.offsetWidth, f.offsetHeight, innerWidth, innerHeight);
    f.style.left = `${s.left}px`;
    f.style.top = `${s.top}px`;
  };
  // placed again whenever it changes size: a group that loads its rows grows after "Loading…" was placed
  if (typeof ResizeObserver === 'function') new ResizeObserver(place).observe(f);
  fillSub(f, it, () => {
    place();
    if (focus && cur?.fly?.el === f && !f.contains(document.activeElement)) itemsOf(f)[0]?.focus({ preventScroll: true });
  });
}

/** The pointer rests on a row: a group opens after a moment, any other row of the menu closes the one open. */
function hovered(row: HTMLElement, it: MenuItem): void {
  if (!cur) return;
  if (cur.timer) clearTimeout(cur.timer);
  cur.timer = null;
  if (cur.fly?.el.contains(row) || cur.fly?.row === row) return;
  if (!it.sub && !cur.fly) return;
  cur.timer = setTimeout(() => {
    if (!cur) return;
    if (it.sub && !it.why) openFly(row, it, false);
    else closeFly();
  }, 140);
}

/** In the sheet a group opens in place, under its row. */
function nest(row: HTMLElement, it: MenuItem): void {
  const on = row.getAttribute('aria-expanded') === 'true';
  row.setAttribute('aria-expanded', String(!on));
  if (on) {
    if (row.nextElementSibling?.classList.contains('ctx-nest')) row.nextElementSibling.remove();
    return;
  }
  const n = h('div', { class: 'ctx-nest', role: 'group', 'aria-label': it.label });
  row.after(n);
  fillSub(n, it, () => itemsOf(n)[0]?.focus({ preventScroll: true }));
}

/** A menu of these entries at a screen point. */
export function showMenu(x: number, y: number, list: readonly MenuEntry[], o: MenuOptions = {}): void {
  // the opener is what has the focus before the last menu (and its rows) let go of it
  const was = document.activeElement;
  const prev = cur?.opener ?? null;
  closeMenu();
  closePicker();
  const m = o.into ?? h('div', {});
  m.classList.add('ctx-menu');
  m.setAttribute('role', 'menu');
  m.setAttribute('aria-label', o.label ?? 'Actions');
  m.tabIndex = -1;
  fill(m, list);
  document.body.append(m);
  const sheet = coarse();
  m.classList.toggle('sheet', sheet);
  if (!sheet) {
    const s = menuSpot(x, y, m.offsetWidth, m.offsetHeight, innerWidth, innerHeight);
    m.style.left = `${s.left}px`;
    m.style.top = `${s.top}px`;
  }
  const opener = prev ?? (was instanceof HTMLElement && was !== document.body ? was : o.back ?? null);
  cur = { el: m, fly: null, opener, ...(o.toggle ? { toggle: o.toggle } : {}), ...(o.owner ? { owner: o.owner } : {}), timer: null };
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('contextmenu', onContext, true);
  addEventListener('hashchange', onRoute);
  const rows = itemsOf(m);
  // the first action, past the header's value rows and colour swatches: Enter straight after opening must not recolour a net
  (rows.find((b) => !b.classList.contains('ctx-val') && !b.classList.contains('sb-hue-sw')) ?? rows[0] ?? m).focus({ preventScroll: true });
}

// ---- the picker (ui/menupick.ts, loaded on demand) closes with the menu and on a route change ----------------------

let pickerClose: ((owner?: object) => void) | null = null;

/** The picker registers how it closes; the menu calls it. */
export function setPickerClose(f: (owner?: object) => void): void {
  pickerClose = f;
}

/** Close the picker if one is open (`owner`: only if it opened it). */
export function closePicker(owner?: object): void {
  pickerClose?.(owner);
}
