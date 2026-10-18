// A punched card drawn to scale (7⅜ × 3¼ in, the 1928 IBM card): the corner cut, the digit rows printed 0–9, the
// zone rows 12 and 11 blank above them, column numbers, the keypunch's print along the top edge, and the holes.
// Shared by prologue P3's widgets, the sandbox's card reader and the program editors' deck views.

import type { Card } from '../cards/card';
import { COLUMNS } from '../cards/card';
import { ROWS } from '../cards/hollerith';
import { s } from '../ui/dom';

/** SVG units per millimetre. */
const MM = 4;
export const CARD_W = 187.325 * MM, CARD_H = 82.55 * MM;
/** Hole centres: columns 0.087 in apart from 0.251 in, rows 0.25 in apart from 0.25 in. */
export const colX = (c: number): number => (6.38 + c * 2.2098) * MM;
export const rowY = (r: number): number => (6.35 + r * 6.35) * MM;
const HOLE_W = 1.4 * MM, HOLE_H = 3.2 * MM;

export interface CardViewOptions {
  /** Click a position to punch or clear it (column 0–79, row 0–11 from the top). */
  onToggle?: (col: number, row: number) => void;
  /** No printed digits or column numbers (a thumbnail). */
  plain?: boolean;
  /** An accessible name. */
  label?: string;
}

export interface CardView {
  el: SVGSVGElement;
  /** Draw another card (or the same one changed). */
  show(card: Card): void;
  /** Highlight columns (the ones under the read brushes, or a word's 32), or none. */
  mark(cols: readonly number[] | null, cls?: string): void;
}

export function cardView(card: Card, opts: CardViewOptions = {}): CardView {
  const svg = s('svg', {
    viewBox: `0 0 ${CARD_W} ${CARD_H}`, class: `pcard${opts.plain ? ' plain' : ''}${opts.onToggle ? ' editable' : ''}`,
    role: 'img', 'aria-label': opts.label ?? 'An 80-column punched card',
  });
  svg.append(s('path', { d: `M ${6 * MM} 0 H ${CARD_W} V ${CARD_H} H 0 V ${6 * MM} Z`, class: 'pcard-body' }));
  const marks = svg.appendChild(s('g', { class: 'pcard-marks' }));
  const digits = svg.appendChild(s('g', { class: 'pcard-digits' }));
  if (!opts.plain) {
    for (const c of [0, 9, 19, 29, 39, 49, 59, 69, 79]) {
      svg.append(s('text', { x: colX(c), y: rowY(2) + 14.5, class: 'pcard-colno' }, String(c + 1)));
      svg.append(s('text', { x: colX(c), y: rowY(11) + 14.5, class: 'pcard-colno' }, String(c + 1)));
    }
  }
  const print = svg.appendChild(s('text', { x: colX(0), y: 12.5, class: 'pcard-print' }));
  const holes = svg.appendChild(s('g', { class: 'pcard-holes' }));
  const hit = opts.onToggle ? svg.appendChild(s('g', { class: 'pcard-hit' })) : null;

  // one digit text per position (hidden where punched), one rect per possible hole
  const digitEls: (SVGTextElement | null)[] = [];
  const holeEls: SVGRectElement[] = [];
  for (let c = 0; c < COLUMNS; c++) {
    for (let r = 0; r < 12; r++) {
      const d = r >= 2 && !opts.plain ? digits.appendChild(s('text', { x: colX(c), y: rowY(r) + 3.4 }, ROWS[r])) : null;
      digitEls.push(d);
      holeEls.push(holes.appendChild(s('rect', { x: colX(c) - HOLE_W / 2, y: rowY(r) - HOLE_H / 2, width: HOLE_W, height: HOLE_H, rx: 1.2 })));
    }
  }
  if (hit && opts.onToggle) {
    const toggle = opts.onToggle;
    for (let c = 0; c < COLUMNS; c++) {
      for (let r = 0; r < 12; r++) {
        const t = hit.appendChild(s('rect', { x: colX(c) - 1.1 * MM, y: rowY(r) - 3.1 * MM, width: 2.2 * MM, height: 6.2 * MM, 'data-c': c, 'data-r': r }));
        t.appendChild(s('title', null, `column ${c + 1}, row ${ROWS[r]}`));
      }
    }
    hit.addEventListener('click', (e) => {
      const t = (e.target as Element).closest('rect[data-c]');
      if (t) toggle(Number(t.getAttribute('data-c')), Number(t.getAttribute('data-r')));
    });
  }

  const show = (cd: Card) => {
    for (let c = 0; c < COLUMNS; c++) {
      const m = cd.cols[c] ?? 0;
      for (let r = 0; r < 12; r++) {
        const on = (m >> r) & 1;
        holeEls[c * 12 + r].classList.toggle('on', !!on);
        const d = digitEls[c * 12 + r];
        if (d) d.style.visibility = on ? 'hidden' : '';
      }
    }
    // the keypunch prints each character over its own column
    print.textContent = cd.print.slice(0, COLUMNS);
    print.setAttribute('textLength', String(Math.max(1, cd.print.slice(0, COLUMNS).length) * 2.2098 * MM));
    print.setAttribute('x', String(colX(0) - 1.1 * MM));
  };

  const mark = (cols: readonly number[] | null, cls = 'read') => {
    marks.replaceChildren();
    if (!cols) return;
    for (const c of cols) marks.append(s('rect', { x: colX(c) - 1.1 * MM, y: rowY(0) - 3.4 * MM, width: 2.2 * MM, height: rowY(11) - rowY(0) + 6.8 * MM, class: cls }));
  };

  show(card);
  return { el: svg, show, mark };
}
