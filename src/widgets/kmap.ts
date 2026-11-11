// The logic chapter's Karnaugh map: a four-input function as its map, the loops of a minimal cover (lib/sop.ts, exact or greedy) and
// of the other prime implicants (dashed), the sum, and the circuit it makes, with its NAND count against the sum of minterms.
// The geometry is lib/kmap.ts, the same the sandbox's truth-table chips draw; the circuits and counts are lib/tablelogic.ts's.

import { grayLabel, kLayout, loopRects } from '../lib/kmap';
import { coverLogic, costOf, mintermLogic, onesDc, primesOfRows, type SopCost } from '../lib/logiclab';
import { covers, type Term } from '../lib/sop';
import { termText, type TableSpec } from '../lib/tablelogic';
import { h, s } from '../ui/dom';
import type { Stage, Widget } from '../view/stage';
import '../styles/logic.css';

export interface KmapOpts {
  ins: string[];
  out: string;
  /** The 2^n cells, row 0 first: 0 / 1 / - . */
  rows: string;
  /** What a click on a cell does: nothing, cycle 0 → 1, or 0 → 1 → don't care. */
  edit?: 'none' | '01' | '01-';
  /** Rows a click leaves alone. */
  locked?: (row: number) => boolean;
  /** The Exact | Greedy and Map | Circuit switches. */
  greedyToggle?: boolean;
  circuitToggle?: boolean;
  /** A Sum | Product switch: loop the 1s (a sum of products) or the 0s (a product of sums, built as the sum of products of the 0s and a NOT). */
  posToggle?: boolean;
  pos?: boolean;
  /** Start on the greedy cover / the circuit. */
  greedy?: boolean;
  view?: 'map' | 'circuit';
  /** Say, under the map, what the minimal sum costs against: the sum of the table's minterms (default) or nothing. */
  againstMinterms?: boolean;
  /** Names of the rows for the cell tooltips (a BCD digit). */
  rowName?: (row: number) => string;
  /** Called after every change (the chapter's check wants the state). */
  onChange?: (st: KmapState) => void;
  /** Refreshed after every change, so the page re-checks its challenge. */
  stage?: Stage;
  title?: string;
}

export interface KmapState {
  /** The table as given. */
  rows: string;
  /** The table that was looped: the same, or with 0 and 1 swapped for a product of sums. */
  looped: string;
  ones: number[];
  dc: number[];
  greedy: boolean;
  pos: boolean;
  terms: Term[];
  texts: string[];
  /** Prime implicants of the function (don't cares joined). */
  primes: number;
  exact: boolean;
  cost: SopCost;
  /** The sum of minterms of the same ones (no don't cares), in NANDs. */
  mintermNands: number;
}

/** A product term as the sum it is the complement of: ¬a·¬b·c looped on the 0s is the factor (a + b + ¬c). */
function sumText(t: TableSpec, p: Term): string {
  const n = t.ins.length;
  const lits = t.ins.flatMap((v, i) => { const bit = 1 << (n - 1 - i); return p.mask & bit ? [] : [p.val & bit ? `¬${v}` : v]; });
  return `(${lits.join(' + ') || '0'})`;
}

/** The state of a table: the cover, its text and its cost. Pure: the widget and the tests call it. */
export function kmapState(ins: string[], out: string, rows: string, greedy: boolean, pos = false): KmapState {
  // a product of sums is the sum of products of the 0s, inverted: loop the 0s of the table
  const looped = pos ? rows.replace(/[01]/g, (c) => (c === '0' ? '1' : '0')) : rows;
  const t: TableSpec = { ins, outs: [out], rows: [looped], form: 'nand' };
  const logic = coverLogic(t, greedy);
  const cost0 = costOf(t, logic);
  const o = logic.outs[0];
  const terms = o.kind === 'terms' ? o.uses.map((k) => logic.terms[k]) : [];
  const { ones, dc } = onesDc(looped);
  const mt: TableSpec = { ins, outs: [out], rows: [looped.replace(/-/g, '0')], form: 'nand' };
  return {
    rows, looped, ones, dc, greedy, pos, terms, texts: terms.map((p) => (pos ? sumText(t, p) : termText(t, p))),
    primes: primesOfRows(looped).length, exact: logic.exact, cost: pos ? { ...cost0, nands: cost0.nands + 1, depth: cost0.depth === null ? null : cost0.depth + 1 } : cost0,
    mintermNands: ones.length ? costOf(mt, mintermLogic(ones), 'logic_minterm_cost').nands : 0,
  };
}

const LOOPS = 6;
const CW = 46, CH = 38, HW = 58, HH = 28;

export interface KmapWidget extends Widget {
  state(): KmapState;
  set(rows: string): void;
  setGreedy(on: boolean): void;
}

export function kmapWidget(o: KmapOpts): KmapWidget {
  const n = o.ins.length;
  const lay = kLayout(n);
  let rows = o.rows, greedy = !!o.greedy, view = o.view ?? 'map', pos = !!o.pos;
  let st = kmapState(o.ins, o.out, rows, greedy, pos);
  const edit = o.edit ?? 'none';

  const mapHost = h('div', { class: 'km-mapwrap' });
  const side = h('div', { class: 'km-side' });
  const totals = h('div', { class: 'km-tot', 'aria-live': 'polite' });
  const tog = h('div', { class: 'km-togs' });
  let hot = -1;

  const next = (c: string): string => (c === '0' ? '1' : c === '1' ? (edit === '01-' ? '-' : '0') : '0');
  const cellClick = (r: number) => {
    if (edit === 'none' || o.locked?.(r)) return;
    rows = rows.slice(0, r) + next(rows[r]) + rows.slice(r + 1);
    update(true);
  };

  function drawMap(): HTMLElement {
    const { rb, cb, rowsG, colsG, rowOf } = lay;
    const kids: HTMLElement[] = [];
    kids.push(h('div', { class: 'km-h corner', style: `left:0;top:0;width:${HW}px;height:${HH}px` },
      h('span', null, o.ins.slice(0, rb).join('')), h('span', null, o.ins.slice(rb).join(''))));
    colsG.forEach((c, ci) => kids.push(h('div', { class: 'km-h', style: `left:${HW + ci * CW}px;top:0;width:${CW}px;height:${HH}px` }, grayLabel(c, cb))));
    rowsG.forEach((rg, ri) => {
      kids.push(h('div', { class: 'km-h', style: `left:0;top:${HH + ri * CH}px;width:${HW}px;height:${CH}px` }, grayLabel(rg, rb)));
      colsG.forEach((_, ci) => {
        const r = rowOf(ri, ci), c = rows[r];
        const free = edit !== 'none' && !o.locked?.(r);
        kids.push(h('button', {
          type: 'button', class: `km-c c${c === '-' ? 'd' : c}${free ? '' : ' fixed'}`, style: `left:${HW + ci * CW}px;top:${HH + ri * CH}px;width:${CW}px;height:${CH}px`,
          'aria-label': `${o.rowName ? o.rowName(r) : `row ${r}`}: ${o.ins.map((x, i) => `${x}=${(r >> (n - 1 - i)) & 1}`).join(' ')}, ${o.out} ${c === '-' ? 'don’t care' : c}${free ? '. Click to change' : ''}`,
          ...(free ? {} : { 'aria-disabled': 'true' }),
          onclick: () => cellClick(r),
        }, h('span', { class: 'm' }, String(r)), c === '-' ? '–' : c));
      });
    });
    // every prime implicant, dashed, then the chosen loops over them
    const chosen = new Set(st.terms.map((p) => `${p.val}/${p.mask}`));
    primesOfRows(st.looped).forEach((p) => {
      if (chosen.has(`${p.val}/${p.mask}`)) return;
      for (const { r0, r1, c0, c1 } of loopRects(lay, p))
        kids.push(h('span', { class: 'km-loop spare', 'aria-hidden': 'true', style: loopStyle(r0, r1, c0, c1, 1) }));
    });
    st.terms.forEach((p, li) => {
      for (const { r0, r1, c0, c1 } of loopRects(lay, p))
        kids.push(h('span', { class: `km-loop km-l${li % LOOPS}${hot === li ? ' hot' : ''}`, 'aria-hidden': 'true', style: loopStyle(r0, r1, c0, c1, 3 + (li % 3) * 3) }));
    });
    return h('div', { class: 'km-map', style: `width:${HW + colsG.length * CW}px;height:${HH + rowsG.length * CH}px`, role: 'group', 'aria-label': `Karnaugh map of ${o.out}: ${st.cost.text}` }, kids);
  }
  const loopStyle = (r0: number, r1: number, c0: number, c1: number, inset: number) =>
    `left:${HW + c0 * CW + inset}px;top:${HH + r0 * CH + inset}px;width:${(c1 - c0 + 1) * CW - 2 * inset}px;height:${(r1 - r0 + 1) * CH - 2 * inset}px`;

  /** The circuit of the sum: rails (a and ¬a …) on the left, a NAND per term, the output NAND. */
  function drawCircuit(): SVGElement {
    const ts = st.terms;
    const lits = (p: Term) => o.ins.flatMap((_, i) => (p.mask & (1 << (n - 1 - i)) ? [] : [{ i, pos: !!(p.val & (1 << (n - 1 - i))) }]));
    const need = new Set<string>();
    ts.forEach((p) => lits(p).forEach((l) => need.add(`${l.i}${l.pos ? '' : 'n'}`)));
    const rails = o.ins.flatMap((x, i) => [{ key: `${i}`, label: x }, { key: `${i}n`, label: `¬${x}` }]).filter((r) => need.has(r.key));
    const RX = 40, GX = 170, YS = 22, top = 16;
    const termH = 44;
    const H = Math.max(rails.length * YS, ts.length * termH) + top * 2;
    const W = 420;
    const svg = s('svg', { class: 'km-circuit', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The circuit of ${st.cost.text}: ${st.cost.nands} NANDs` });
    const railY = new Map(rails.map((r, k) => [r.key, top + k * YS + 8]));
    rails.forEach((r) => {
      const y = railY.get(r.key)!;
      svg.append(s('text', { x: 4, y: y + 4, class: 'km-rl' }, r.label));
      svg.append(s('line', { x1: RX, y1: y, x2: GX - 40, y2: y, class: 'km-rail' }));
    });
    const ty = ts.map((_, k) => top + k * termH + termH / 2);
    const OX = 330, oy = ts.length ? (ty[0] + ty[ty.length - 1]) / 2 : H / 2;
    ts.forEach((p, k) => {
      const y = ty[k], ls = lits(p);
      ls.forEach((l, j) => {
        const ry = railY.get(`${l.i}${l.pos ? '' : 'n'}`)!;
        const jx = GX - 36 + (k % 4) * 8;
        const iy = y - 8 + (ls.length === 1 ? 8 : (j / Math.max(1, ls.length - 1)) * 16);
        svg.append(s('path', { d: `M${jx} ${ry} V${iy} H${GX}`, class: `km-wire km-s${k % LOOPS}` }));
        svg.append(s('circle', { cx: jx, cy: ry, r: 2.4, class: `km-dot km-s${k % LOOPS}` }));
      });
      svg.append(s('rect', { x: GX, y: y - 14, width: 66, height: 28, rx: 8, class: `km-gate km-s${k % LOOPS}` }));
      svg.append(s('text', { x: GX + 33, y: y + 4, class: 'km-gl' }, `NAND ${ls.length}`));
      svg.append(s('path', { d: `M${GX + 66} ${y} H${OX - 14} V${oy - 8 + (ts.length === 1 ? 8 : (k / Math.max(1, ts.length - 1)) * 16)} H${OX}`, class: `km-wire km-s${k % LOOPS}` }));
    });
    if (ts.length) {
      svg.append(s('rect', { x: OX, y: oy - 18, width: 56, height: 36, rx: 10, class: 'km-gate out' }));
      svg.append(s('text', { x: OX + 28, y: oy + 4, class: 'km-gl' }, `NAND ${ts.length}`));
      svg.append(s('line', { x1: OX + 56, y1: oy, x2: W - 6, y2: oy, class: 'km-rail' }));
      svg.append(s('text', { x: W - 8, y: oy - 8, class: 'km-rl end' }, pos ? `¬${o.out}, then a NOT` : o.out));
    } else svg.append(s('text', { x: 20, y: H / 2, class: 'km-rl' }, st.cost.text === '0' ? `${o.out} = 0: no gates` : `${o.out} = 1: no gates`));
    return svg;
  }

  function sideList(): HTMLElement {
    const items: HTMLElement[] = st.terms.map((p, li) => {
      const cells = [...Array(1 << n).keys()].filter((r) => covers(p, r) && st.ones.includes(r));
      const wraps = loopRects(lay, p).length > 1;
      return h('div', {
        class: `km-t km-l${li % LOOPS}`, tabindex: '0',
        onmouseenter: () => { hot = li; paint(); }, onmouseleave: () => { hot = -1; paint(); },
        onfocus: () => { hot = li; paint(); }, onblur: () => { hot = -1; paint(); },
      }, h('i'), h('code', null, st.texts[li]), h('span', { class: 'cells' }, `${cells.join(', ')}${wraps ? ' (wraps)' : ''}`));
    });
    return h('div', { class: 'km-terms' }, h('div', { class: 'km-k' }, st.cost.terms ? (pos ? 'Product of sums' : 'Sum of products') : 'No loops'), items.length ? items : h('p', { class: 'km-none' }, st.cost.text === '1' ? 'Every cell is 1 or a don’t care: the output is 1.' : 'No cell is 1: the output is 0.'));
  }

  function paint(): void {
    mapHost.replaceChildren(view === 'map' ? drawMap() : drawCircuit());
    side.replaceChildren(sideList());
    const parts: (string | HTMLElement)[] = [];
    parts.push(`${st.primes} prime implicant${st.primes === 1 ? '' : 's'} · ${st.terms.length} chosen · `);
    parts.push(h('b', { class: st.exact ? 'ok' : 'warn' }, st.exact ? 'exact' : 'greedy: not proven minimal'));
    totals.replaceChildren(...parts, h('br'),
      'circuit: ', h('b', null, `${st.cost.nands} NANDs`), st.cost.depth !== null ? `, depth ${st.cost.depth}` : '',
      ...(pos ? [' (the 0s as a sum of products, then a NOT) against ', h('b', null, `${kmapState(o.ins, o.out, rows, greedy, false).cost.nands}`), ' for the sum of products of the 1s']
        : o.againstMinterms !== false && st.ones.length > 1 ? [' against ', h('b', null, `${st.mintermNands}`), ` for the ${st.ones.length} minterms`] : []));
  }

  function update(user: boolean): void {
    st = kmapState(o.ins, o.out, rows, greedy, pos);
    paint();
    paintTogs();
    if (user) { o.onChange?.(st); o.stage?.refresh(); }
  }

  const seg = (labels: [string, string], on: () => number, set: (k: number) => void, aria: string) => {
    const bs = labels.map((l, k) => h('button', { type: 'button', class: 'km-seg', 'aria-pressed': 'false', onclick: () => { set(k); update(false); o.onChange?.(st); o.stage?.refresh(); } }, l));
    const r = h('div', { class: 'km-segs', role: 'group', 'aria-label': aria }, bs);
    (r as unknown as { sync: () => void }).sync = () => bs.forEach((b, k) => b.setAttribute('aria-pressed', String(on() === k)));
    return r as unknown as HTMLElement & { sync: () => void };
  };
  const segs: (HTMLElement & { sync: () => void })[] = [];
  if (o.greedyToggle) segs.push(seg(['Exact', 'Greedy'], () => (greedy ? 1 : 0), (k) => { greedy = k === 1; }, 'Cover search'));
  if (o.posToggle) segs.push(seg(['Sum of products', 'Product of sums'], () => (pos ? 1 : 0), (k) => { pos = k === 1; }, 'Form'));
  if (o.circuitToggle) segs.push(seg(['Map', 'Circuit'], () => (view === 'map' ? 0 : 1), (k) => { view = k === 0 ? 'map' : 'circuit'; }, 'View'));
  tog.append(...segs);
  const paintTogs = () => segs.forEach((x) => x.sync());

  update(false);
  const el = h('div', { class: 'widget km' },
    h('div', { class: 'km-title' }, o.title ?? `Karnaugh map of ${o.out}`),
    h('div', { class: 'km-body' }, mapHost, h('div', { class: 'km-right' }, side, totals, tog)));
  return {
    el,
    state: () => st,
    set: (r) => { rows = r; update(true); },
    setGreedy: (g) => { greedy = g; update(true); },
  };
}
