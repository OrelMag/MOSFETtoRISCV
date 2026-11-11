// The logic chapter's other widgets: the algebra laws with their gate counts (step 2), what a minimal sum does not share (step 6), and the
// seven-segment decoder whose unused rows are yours to choose (step 8). Their models are lib/logiclab.ts; each number is computed.

import { evalBool, parseBool } from '../lib/boolexpr';
import { PRIME4 } from '../lib/rv16/logic';
import { XOR } from '../lib/gates';
import {
  costOf, coverLogic, exprCost, fontIntact, LAWS, lawRow, SEG_INS, SEGMENTS, segmentTable, sevenSegCost, sevenSegRows, sameFunction, tableOf, FONT,
} from '../lib/logiclab';
import { h, s } from '../ui/dom';
import { stats } from '../sim/stats';
import type { Stage, Widget } from '../view/stage';
import { kmapWidget } from './kmap';
import '../styles/logic.css';

// ---- step 2: laws ----------------------------------------------------------------------------------------

export function algebraWidget(): Widget {
  const rows = LAWS.map(lawRow);
  let open = 'consensus';
  const body = h('div', { class: 'lg-laws' });
  const mine = h('div', { class: 'lg-mine' });

  function truth(l: (typeof LAWS)[number]): HTMLElement {
    const n = l.vars.length;
    const t = h('table', { class: 'lg-tt' }, h('tr', null, ...l.vars.map((v) => h('th', null, v)), h('th', { class: 'sep' }, 'before'), h('th', null, 'after')));
    for (let x = 0; x < 1 << n; x++) {
      const val = (src: string) => evalAt(src, l.vars, x);
      t.append(h('tr', null, ...l.vars.map((_, i) => h('td', null, String((x >> (n - 1 - i)) & 1))), h('td', { class: 'sep one' }, String(val(l.before))), h('td', { class: 'one' }, String(val(l.after)))));
    }
    return t;
  }

  function draw(): void {
    body.replaceChildren(h('table', { class: 'lg-t' },
      h('tr', null, h('th', null, 'Rule'), h('th', null, 'Before'), h('th', null, 'After'), h('th', { class: 'num' }, 'NANDs'), h('th', null, '')),
      ...rows.flatMap((r) => {
        const isOpen = open === r.law.id;
        const save = r.before - r.after;
        return [
          h('tr', { class: `lg-law${isOpen ? ' open' : ''}`, tabindex: '0', role: 'button', 'aria-expanded': String(isOpen), 'aria-label': `${r.law.name}: ${r.law.before} becomes ${r.law.after}`,
            onclick: () => { open = isOpen ? '' : r.law.id; draw(); },
            onkeydown: (e: Event) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); open = isOpen ? '' : r.law.id; draw(); } } },
          h('td', null, r.law.name), h('td', null, h('code', null, r.law.before)), h('td', null, h('code', null, r.law.after)),
          h('td', { class: 'num' }, `${r.before} → ${r.after}`), h('td', { class: `chk ${r.same ? 'ok' : 'no'}`, title: r.same ? 'equal on every row' : 'differs' }, r.same ? '✓' : '✗')),
          ...(isOpen ? [h('tr', { class: 'lg-det' }, h('td', { colspan: '5' }, h('p', null, r.law.note, save > 0 ? ` Saves ${save} NAND${save === 1 ? '' : 's'}.` : ''), truth(r.law)))] : []),
        ];
      })));
  }

  // your own pair of expressions
  const vars = ['a', 'b', 'c'];
  const f1 = h('input', { class: 'lg-in', value: 'a·b + a·¬b·c', 'aria-label': 'First expression', spellcheck: 'false' }) as HTMLInputElement;
  const f2 = h('input', { class: 'lg-in', value: 'a·b + a·c', 'aria-label': 'Second expression', spellcheck: 'false' }) as HTMLInputElement;
  const verdict = h('p', { class: 'lg-verdict', 'aria-live': 'polite' });
  function judge(): void {
    const c1 = exprCost(f1.value, vars), c2 = exprCost(f2.value, vars);
    if (typeof c1 === 'string' || typeof c2 === 'string') { verdict.textContent = typeof c1 === 'string' ? `First: ${c1}` : `Second: ${c2 as string}`; verdict.className = 'lg-verdict warn'; return; }
    const same = sameFunction(f1.value, f2.value, vars);
    verdict.className = `lg-verdict ${same === true ? 'ok' : 'no'}`;
    verdict.textContent = `${same === true ? 'Equal on all 8 rows.' : 'Not equal: they differ on some row.'} ${c1} NANDs against ${c2}.`;
  }
  f1.addEventListener('input', judge);
  f2.addEventListener('input', judge);
  mine.append(h('div', { class: 'km-k' }, 'Try your own (variables a, b, c)'), h('div', { class: 'lg-pair' }, f1, h('span', null, '=?'), f2), verdict);
  draw();
  judge();
  return { el: h('div', { class: 'widget lg' }, h('div', { class: 'km-title' }, 'Rules that remove gates'), body, mine) };
}

function evalAt(src: string, vars: string[], x: number): number {
  const p = parseBool(src, vars);
  return 'error' in p ? 0 : evalBool(p.ex, x, vars.length);
}

// ---- step 6: what a minimal sum does not share ---------------------------------------------------------------

/** The numbers of the step's table: [name, minimal two-level NANDs, the cheaper circuit's NANDs]. */
export function sharingRows(): { name: string; two: number; better: number; how: string }[] {
  const xor = tableOf(['a', 'b'], [1, 2]);
  const prime = tableOf(['a', 'b', 'c', 'd'], [2, 3, 5, 7, 11, 13]);
  const dc = ['------', '------', '------', '------', '------', '------', '------'];
  const alone = SEGMENTS.reduce((n, _, si) => n + costOf(segmentTable(si, '------'), coverLogic(segmentTable(si, '------')), `logic_seg_alone`).nands, 0);
  return [
    { name: 'XOR', two: costOf(xor, coverLogic(xor)).nands, better: stats(XOR).nands, how: 'one NAND shared by both halves' },
    { name: 'Prime detector', two: costOf(prime, coverLogic(prime)).nands, better: stats(PRIME4).nands, how: 'factored: a multiplexer times a mask' },
    { name: 'Seven segments, one at a time', two: alone, better: sevenSegCost(sevenSegRows(dc)).nands, how: 'terms shared between segments' },
  ];
}

/** The step's greedy table: ones of a four-input function where the greedy cover takes a term more than the minimum. */
export const GREEDY_ONES = [3, 6, 7, 8, 10, 11, 12, 14];

export function sharingWidget(stage?: Stage): Widget {
  const rows = sharingRows();
  const t = h('table', { class: 'lg-t' }, h('tr', null, h('th', null, 'Function'), h('th', { class: 'num' }, 'Minimal sum of products'), h('th', { class: 'num' }, 'Cheaper circuit'), h('th', null, 'What it shares')),
    ...rows.map((r) => h('tr', null, h('td', null, r.name), h('td', { class: 'num' }, `${r.two} NANDs`), h('td', { class: 'num' }, h('b', null, `${r.better}`)), h('td', null, r.how))));
  const gt = tableOf(['a', 'b', 'c', 'd'], GREEDY_ONES);
  const km = kmapWidget({ ins: gt.ins, out: 'y', rows: gt.rows[0], edit: '01', greedyToggle: true, circuitToggle: true, greedy: true, title: 'Exact against greedy on one table', stage });
  return { el: h('div', { class: 'widget lg' }, h('div', { class: 'km-title' }, 'A minimal sum is not the cheapest circuit'), h('div', { class: 'lg-scroll' }, t), h('p', { class: 'lg-sub' }, 'Two-level means one layer of ANDs and one OR. Sharing a gate between outputs, or factoring, goes outside that family. Inside it, the cover is still a search:'), km.el), destroy: () => km.destroy?.() };
}

// ---- step 8: the seven-segment digit -------------------------------------------------------------------

const BARS: Record<string, [number, number, number, number]> = {
  a: [4, 1, 12, 3], b: [16, 4, 3, 11], c: [16, 17, 3, 11], d: [4, 28, 12, 3], e: [1, 17, 3, 11], f: [1, 4, 3, 11], g: [4, 14.5, 12, 3],
};

function glyph(lit: (seg: string) => string): SVGElement {
  return s('svg', { class: 'lg-glyph', viewBox: '0 0 20 32', 'aria-hidden': 'true' },
    ...SEGMENTS.map((sg) => { const [x, y, w, hh] = BARS[sg]; return s('rect', { x, y, width: w, height: hh, rx: 1, class: `bar v${lit(sg) === '-' ? 'd' : lit(sg)}` }); }));
}

export interface SegState { fill: string[]; nands: number; budget: number; ok: boolean; intact: boolean; terms: number; text: string[] }

export const SEG_BUDGET = (): number => sevenSegCost(sevenSegRows(Array(7).fill('------'))).nands;

/**
 * A horizontal scroller in a frame that shows which way more of it lies: a fade and a chevron on an edge with columns past it
 * (a phone shows the seven-segment table's last columns only after a swipe). Returns the frame and a cleanup.
 */
export function scrollEdges(scroller: HTMLElement): { el: HTMLElement; update(): void; destroy(): void } {
  const el = h('div', { class: 'lg-edges' }, scroller);
  const update = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    el.classList.toggle('more-l', max > 1 && scroller.scrollLeft > 1);
    el.classList.toggle('more-r', max > 1 && scroller.scrollLeft < max - 1);
  };
  scroller.addEventListener('scroll', update, { passive: true });
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  ro?.observe(scroller);
  return { el, update, destroy: () => ro?.disconnect() };
}

export function segmentLab(stage?: Stage): Widget & { state(): SegState; set(fill: string[]): void } {
  let fill: string[] = Array(7).fill('000000');
  const budget = SEG_BUDGET();
  const grid = h('div', { class: 'lg-seg-scroll' });
  const edges = scrollEdges(grid);
  const sum = h('div', { class: 'lg-segsum', 'aria-live': 'polite' });
  const eqs = h('details', { class: 'lg-eqs' });

  const state = (): SegState => {
    const rows = sevenSegRows(fill);
    const c = sevenSegCost(rows);
    const intact = fontIntact(rows);
    return { fill: [...fill], nands: c.nands, budget, ok: intact && c.nands <= budget, intact, terms: c.terms, text: c.text };
  };
  const nextCell = (c: string) => (c === '0' ? '1' : c === '1' ? '-' : '0');

  function draw(): void {
    const st = state();
    const head = h('tr', null, h('th', null, 'digit'), ...SEG_INS.map((x) => h('th', { class: 'in' }, x)), h('th', null, ''), ...SEGMENTS.map((sg) => h('th', null, sg)));
    const trs = Array.from({ length: 16 }, (_, r) => {
      const free = r >= 10;
      const cell = (si: number): string => (free ? fill[si][r - 10] : FONT[r].includes(SEGMENTS[si]) ? '1' : '0');
      return h('tr', { class: free ? 'free' : '' },
        h('td', { class: 'dg' }, free ? `${r}` : `${r}`), ...SEG_INS.map((_, i) => h('td', { class: 'in' }, String((r >> (3 - i)) & 1))),
        h('td', null, glyph((sg) => cell(SEGMENTS.indexOf(sg as (typeof SEGMENTS)[number])))),
        ...SEGMENTS.map((_, si) => {
          const c = cell(si);
          return free
            ? h('td', null, h('button', { type: 'button', class: `km-c lg-cell c${c === '-' ? 'd' : c}`, 'aria-label': `Row ${r}, segment ${SEGMENTS[si]}: ${c === '-' ? 'don’t care' : c}. Click to change`,
              onclick: () => { fill[si] = fill[si].slice(0, r - 10) + nextCell(c) + fill[si].slice(r - 9); draw(); stage?.refresh(); } }, c === '-' ? '–' : c))
            : h('td', { class: `lg-fixed c${c}` }, c);
        }));
    });
    grid.replaceChildren(h('table', { class: 'lg-t lg-seg' }, head, ...trs));
    edges.update();
    sum.replaceChildren('NANDs for all seven segments: ', h('b', { class: st.ok ? 'ok' : st.nands > budget ? 'warn' : '' }, String(st.nands)), `. Budget: ${budget}. `, st.terms ? `${st.terms} shared terms.` : '');
    eqs.replaceChildren(h('summary', null, 'The minimal equations'), h('div', { class: 'lg-eqlist' }, ...st.text.map((t) => h('code', null, t))));
  }
  draw();
  return {
    el: h('div', { class: 'widget lg' }, h('div', { class: 'km-title' }, 'A BCD digit to seven segments'),
      h('p', { class: 'lg-sub' }, 'Rows 0 to 9 are the font. Rows 10 to 15 never reach the decoder: click their cells to choose 0, 1 or a don’t care.'), edges.el, sum, eqs),
    destroy: () => edges.destroy(),
    state,
    set: (f) => { fill = f; draw(); stage?.refresh(); },
  };
}

