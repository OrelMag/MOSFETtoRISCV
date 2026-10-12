// A scrolling list that builds only the rows in view, between two spacers, so a 64K-word memory
// or ROM listing costs a screenful of DOM rows, not 65 536. Works for a table body (rows are
// <tr>) or plain <div> rows. Row heights are taken from the first row on the page.

import { h } from '../ui/dom';

export interface VirtualRows {
  /** The scroll container. */
  readonly el: HTMLElement;
  /** Rebuild the rows in view (the data behind them changed). */
  refresh(): void;
  /** Scroll row i into view (nothing when it is visible already). */
  reveal(i: number): void;
  /** The rows built now, by index. */
  readonly built: ReadonlyMap<number, HTMLElement>;
}

export interface VirtualOptions {
  count: number;
  /** The scroll container (sized and scrolled by CSS) and the element the rows go in. */
  el: HTMLElement;
  body: HTMLElement;
  /** A fresh element for row i. */
  row: (i: number) => HTMLElement;
  /** Estimated row height in px until one is measured. */
  rowH?: number;
}

/** Rows above and below the visible ones, so a short scroll shows built rows. */
const MARGIN = 8;

export function virtualRows(o: VirtualOptions): VirtualRows {
  const { el, body, count } = o;
  const table = body.tagName === 'TBODY';
  const spacer = () => (table ? h('tr', { class: 'vspace', 'aria-hidden': 'true' }, h('td', { colspan: '3' })) : h('div', { class: 'vspace', 'aria-hidden': 'true' }));
  const top = spacer(), bottom = spacer();
  let rowH = o.rowH ?? 20, measured = false;
  const built = new Map<number, HTMLElement>();
  let from = -1, to = -1;

  const setH = (s: HTMLElement, px: number) => { s.style.height = `${px}px`; s.hidden = px <= 0; };
  const render = (force: boolean) => {
    const view = el.clientHeight || 300;
    const first = Math.max(0, Math.floor(el.scrollTop / rowH) - MARGIN);
    const last = Math.min(count, first + Math.ceil(view / rowH) + 2 * MARGIN);
    if (!force && first === from && last === to) return;
    from = first;
    to = last;
    built.clear();
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) {
      const r = o.row(i);
      built.set(i, r);
      rows.push(r);
    }
    setH(top, first * rowH);
    setH(bottom, (count - last) * rowH);
    body.replaceChildren(top, ...rows, bottom);
    // The real row height, once the list is on the page: re-place the window with it.
    if (!measured && rows.length && rows[0].offsetHeight > 0) {
      measured = true;
      if (Math.abs(rows[0].offsetHeight - rowH) > 0.5) {
        rowH = rows[0].offsetHeight;
        render(true);
      }
    }
  };
  let queued = false;
  el.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(false); });
  });
  render(true);
  return {
    el, built,
    refresh: () => render(true),
    reveal(i) {
      if (i < 0 || i >= count) return;
      const y = i * rowH, view = el.clientHeight || 300;
      if (y < el.scrollTop || y + rowH > el.scrollTop + view) {
        el.scrollTop = Math.max(0, y - view / 3);
        render(false);
      }
    },
  };
}
