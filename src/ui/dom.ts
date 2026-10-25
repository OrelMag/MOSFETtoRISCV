// Tiny DOM helpers: no framework, just typed element construction.

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;
type Child = Node | string | number | null | undefined | false | Child[];

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

function setAttrs(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') (el as HTMLElement).innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVGNS, tag) as SVGElementTagNameMap[K];
  setAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

/** A touch screen is the main pointer (a phone or tablet): gestures, not a mouse and keys. */
export const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * The canvas's gesture hint (.hint-badge): the mouse wording, or on a touch screen the touch wording
 * on one line (it sits over the circuit: wrapped on a phone it hid the lower pins). The first touch on
 * the canvas hides it for this visit; a tap on it hides it for good (remembered under `key`).
 */
export function hintBadge(mouse: string, touch: string, key: string, cls = ''): HTMLElement {
  const store = `mosfet2riscv:hint:${key}`;
  if (!coarsePointer()) return h('div', { class: `hint-badge${cls}` }, mouse);
  let off = false;
  try { off = localStorage.getItem(store) === 'off'; } catch { /* storage blocked: shown */ }
  const el = h('button', { class: `hint-badge touch${cls}`, hidden: off, title: 'Tap to hide this hint', 'aria-label': `${touch} (tap to hide)` },
    h('span', null, touch), h('span', { class: 'x', 'aria-hidden': 'true' }, '×'));
  // data-off: dismissed, so a layout that places the hint (Stage.placeHint) keeps it hidden.
  if (off) el.dataset.off = '1';
  el.addEventListener('click', () => {
    el.hidden = true;
    el.dataset.off = '1';
    try { localStorage.setItem(store, 'off'); } catch { /* not remembered */ }
  });
  // Seen once the canvas is touched: out of the circuit's way until the next visit.
  const touched = (e: Event) => {
    if (el.contains(e.target as Node)) return;
    el.hidden = true;
    el.dataset.off = '1';
    el.parentElement?.removeEventListener('pointerdown', touched, true);
  };
  queueMicrotask(() => el.parentElement?.addEventListener('pointerdown', touched, true));
  return el;
}

/**
 * A fixed drop-down menu placed below `r` at `left`, its height bounded by the viewport so a long
 * one scrolls instead of running off the bottom (the page under it does not scroll).
 */
export function placeMenu(menu: HTMLElement, r: { bottom: number }, left: number): void {
  const top = r.bottom + 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${Math.max(160, innerHeight - top - 8)}px`;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

/** Inline icon set (stroke icons, 24×24, currentColor). */
const ICONS: Record<string, string> = {
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4M7 8h2v2H7zM11 8h2v2h-2zM7 12h2"/>',
  io: '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="16" cy="12" r="2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  open: '<path d="M15 3h6v6M21 3l-8 8M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  // a snail: Slow motion, not Play
  slow: '<path d="M2 20h16a3 3 0 0 0 3-3V10"/><path d="M19 6l2 4 2-4"/><path d="M4 20a7 7 0 1 1 13-3.5"/><path d="M10.5 17a3 3 0 1 1 3-3"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  pause: '<path d="M7 4h4v16H7zM14 4h4v16h-4z"/>',
  step: '<path d="M6 4l10 8-10 8zM18 4v16"/>',
  stepBack: '<path d="M18 4L8 12l10 8zM6 4v16"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevL: '<path d="M15 18l-6-6 6-6"/>',
  chevR: '<path d="M9 18l6-6-6-6"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5V21h16"/>',
  bench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  probe: '<path d="M14 3l7 7-4 1-7 7-3-3 7-7z"/><path d="M7 17l-4 4"/>',
  wave: '<path d="M2 12h4V6h6v12h6v-6h4"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/>',
  code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>',
  layers: '<path d="M12 2l10 6-10 6L2 8z"/><path d="M2 16l10 6 10-6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  puzzle: '<path d="M4 7h4V5.5a2 2 0 1 1 4 0V7h4v4h1.5a2 2 0 1 1 0 4H16v4h-4v-1.5a2 2 0 1 0-4 0V19H4z"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>',
  project: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
};

export function icon(name: string, size = 18): SVGSVGElement {
  const el = s('svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon',
  });
  el.innerHTML = ICONS[name] ?? '';
  return el;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
