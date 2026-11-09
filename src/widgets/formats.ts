// Chapter float: the formats side by side. formatsWidget: range, precision and bit budget of six formats, and one number
// rounded into each; formatCostWidget: the pinned cost of an adder, multiplier and fma per format (lib/fpformatcosts.ts,
// re-measured by tests/fpformats.test.ts). float64 never goes through a JS integer: its bits come from a DataView.

import { FORMAT_COSTS, FORMAT_LIST, formatRange } from '../lib/fpformatcosts';
import { fpValue, type FpFormat } from '../sim/fpref';
import { groupDigits } from '../sim/numfmt';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { encodeNumber } from './float';

const SUP: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const superscript = (s: string) => [...s].map((c) => SUP[c] ?? c).join('');

/** 3.4 × 10³⁸ as plain text; moderate magnitudes plain. */
export function sciText(x: number, digits = 3): string {
  if (x === 0) return '0';
  if (Math.abs(x) >= 0.01 && Math.abs(x) < 10000) return String(Number(x.toPrecision(digits)));
  const [m, e] = x.toExponential(digits - 1).split('e');
  return `${m} × 10${superscript(String(Number(e)))}`;
}

/** Decimal digits of precision: (M + 1) log10 2. */
export const decimalDigits = (f: FpFormat) => (f.M + 1) * Math.log10(2);

/** The format's bits for a double, as hex text, and the value they hold. float64 is the double itself. */
export function roundInto(x: number, f: FpFormat): { hex: string; value: number } {
  if (f.E === 11 && f.M === 52) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    return { hex: `0x${dv.getBigUint64(0).toString(16).toUpperCase().padStart(16, '0')}`, value: dv.getFloat64(0) };
  }
  const bits = encodeNumber(x, f), n = 1 + f.E + f.M;
  return { hex: `0x${bits.toString(16).toUpperCase().padStart(Math.ceil(n / 4), '0')}`, value: fpValue(bits, f) };
}

const wrap = (...c: Node[]) => h('div', { class: 'ff-scroll', tabindex: '0', role: 'region', 'aria-label': 'table: scrolls sideways on a narrow screen' }, ...c);
const val = (v: number) => (Number.isNaN(v) ? 'NaN' : !Number.isFinite(v) ? (v > 0 ? '+∞' : '−∞') : sciText(v, 9));
const th = (t: string) => h('th', { scope: 'col' }, t);

export function formatsWidget(): Widget {
  const input = h('input', { type: 'text', value: '0.1', class: 'fx-in', 'aria-label': 'a decimal number to round into every format' }) as HTMLInputElement;
  const note = h('div', { class: 'sub', role: 'status' });
  const roundBody = h('tbody');
  const render = () => {
    const t = input.value.trim().replace(/^\+?inf(inity)?$/i, 'Infinity').replace(/^-inf(inity)?$/i, '-Infinity');
    const x = Number(t);
    note.textContent = '';
    if (!t || Number.isNaN(x)) { note.textContent = 'Type a decimal number such as 0.1, 3e-5, 70000 or 1e39.'; return; }
    roundBody.replaceChildren(...FORMAT_LIST.map(({ short, f }) => {
      const r = roundInto(x, f);
      const err = Number.isFinite(r.value) && x !== 0 ? Math.abs((r.value - x) / x) : NaN;
      return h('tr', null, h('th', { scope: 'row' }, short), h('td', null, h('code', null, r.hex)), h('td', null, val(r.value)),
        h('td', null, Number.isNaN(err) ? (x === 0 ? 'exact' : 'overflow') : err === 0 ? 'exact' : sciText(err, 2)));
    }));
  };
  input.addEventListener('input', render);
  render();
  const body = h('tbody', null, ...FORMAT_LIST.map(({ short, name, f }) => {
    const r = formatRange(f);
    return h('tr', null, h('th', { scope: 'row', title: name }, short), h('td', null, `1 + ${f.E} + ${f.M}`), h('td', null, sciText(r.max)), h('td', null, sciText(r.minNormal)),
      h('td', null, sciText(r.minSub)), h('td', null, `2${superscript(String(-f.M))}`), h('td', null, decimalDigits(f).toFixed(1)));
  }));
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Six formats, one definition'),
      h('p', { class: 'sub' }, 'Every row is the same three fields at a different split. The exponent bits set the range, the fraction bits the precision: the spacing at 1.0 is 2⁻ᴹ, about (M + 1) · 0.301 decimal digits.'),
      wrap(h('table', { class: 'ff-table' }, h('thead', null, h('tr', null, ...['format', 's + e + m', 'largest', 'smallest normal', 'smallest subnormal', 'ulp at 1', 'digits'].map(th))), body)),
      h('p', { class: 'sub' }, 'Round a number into each format (nearest even; float64 is the host\'s own double):'),
      h('div', { class: 'param-row' }, input),
      wrap(h('table', { class: 'ff-table' }, h('thead', null, h('tr', null, ...['format', 'bits', 'value held', 'relative error'].map(th))), roundBody)),
      note)),
  };
}

const num = (n: number) => groupDigits(n);

export function formatCostWidget(): Widget {
  const max = Math.max(...Object.values(FORMAT_COSTS).map((c) => c.fma.nands));
  const seg = (n: number, cls: string, label: string) => h('span', { class: `ff-seg ${cls}`, style: `width:${(100 * n) / max}%`, title: label });
  const rows = FORMAT_LIST.flatMap(({ id, short, f }) => {
    const c = FORMAT_COSTS[id], rest = c.mul.nands - c.mul.tree - c.mul.round;
    return [
      h('tr', null, h('th', { scope: 'row', rowspan: '3' }, short, h('div', { class: 'sub' }, `${f.M + 1} × ${f.M + 1}`)), h('td', null, 'add'),
        h('td', { class: 'ff-bar' }, seg(c.add.nands, 'add', 'adder')), h('td', null, num(c.add.nands)), h('td', null, String(c.add.depth))),
      h('tr', null, h('td', null, 'mul'),
        h('td', { class: 'ff-bar' }, seg(c.mul.tree, 'tree', `significand tree ${num(c.mul.tree)}`), seg(c.mul.round, 'round', `normalize & round ${num(c.mul.round)}`), seg(rest, 'rest', `unpack, exponent, special cases ${num(rest)}`)),
        h('td', null, num(c.mul.nands)), h('td', null, String(c.mul.depth))),
      h('tr', { class: 'ff-last' }, h('td', null, 'fma'), h('td', { class: 'ff-bar' }, seg(c.fma.nands, 'fma', 'fused multiply-add')), h('td', null, num(c.fma.nands)), h('td', null, String(c.fma.depth))),
    ];
  });
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'What each unit costs, measured'),
      h('p', { class: 'sub' }, 'NANDs and logic depth of the lib/fpu.ts generators at each format (all five rounding modes, full subnormals), counted from the netlists; one bar scale for every row. Under each format, its significand product.'),
      h('p', { class: 'ff-key' }, ...([['add', 'adder'], ['tree', 'multiplier: significand tree'], ['round', 'normalize & round'], ['rest', 'the rest'], ['fma', 'fma']] as const).map(([c, t]) => h('span', null, h('span', { class: `ff-seg ${c}`, 'aria-hidden': 'true' }), t))),
      wrap(h('table', { class: 'ff-table ff-costs' }, h('thead', null, h('tr', null, ...['format', 'unit', 'cost', 'NANDs', 'depth'].map(th))), h('tbody', null, ...rows))),
      h('p', { class: 'sub' }, 'Depth is in NAND delays (every NAND counts 1).'))),
  };
}
