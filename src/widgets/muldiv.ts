// Chapter 20 widgets: multiplier cost/speed comparison and a radix-4 Booth recoding explorer.

import { arrayDiv, arrayMul, seqDivider, treeMul } from '../lib';
import { logicDepth, stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

/** Array versus tree multipliers (and array versus iterative division), measured from the netlists. */
export function mulComparison(): Widget {
  const widths = [4, 8, 16, 32];
  const data = widths.map((n) => {
    const a = arrayMul(n), t = treeMul(n);
    return { n, aN: stats(a).nands, aD: logicDepth(a) ?? 0, tN: stats(t).nands, tD: logicDepth(t) ?? 0 };
  });
  const maxD = Math.max(...data.map((d) => d.aD));
  const bar = (v: number, cls: string) => h('span', { class: `cbar ${cls}`, style: `width:${(v / maxD) * 100}%` });
  const rows = data.map((d) => h('tr', null,
    h('td', null, `${d.n}×${d.n}`),
    h('td', { class: 'num' }, String(d.aN)), h('td', { class: 'num' }, String(d.aD)), h('td', { class: 'barcell' }, bar(d.aD, 'r')),
    h('td', { class: 'num' }, String(d.tN)), h('td', { class: 'num' }, String(d.tD)), h('td', { class: 'barcell' }, bar(d.tD, 'k'))));
  const ad = arrayDiv(32), sd = seqDivider(32);
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Multipliers: cost versus speed, measured'),
      h('p', { class: 'sub' }, 'NAND count and worst-case depth (NAND delays) of each circuit, computed from its netlist. The tree multiplier uses a Kogge–Stone final adder.'),
      h('table', { class: 'cmp' },
        h('thead', null,
          h('tr', null, h('th', null, ''), h('th', { colspan: 3 }, 'array (rows of ripple adders)'), h('th', { colspan: 3 }, 'Wallace tree + fast adder')),
          h('tr', null, h('th', null, 'size'), h('th', null, 'NANDs'), h('th', null, 'depth'), h('th', null, ''), h('th', null, 'NANDs'), h('th', null, 'depth'), h('th', null, ''))),
        h('tbody', null, rows)),
      h('p', { class: 'sub', style: 'margin-top:12px' },
        `The array's depth grows linearly (about 10 NAND delays per bit); the tree's grows with the logarithm of the number of partial products plus one fast addition. Both need about n² cells: the tree spends a few more gates on its final adder. Division has no such shortcut, because each quotient bit depends on the remainder left by the previous one. A 32-bit array divider costs ${stats(ad).nands} NANDs and is ${logicDepth(ad)} NAND delays deep. The iterative divider reuses one step: ${stats(sd).nands} NANDs and 34 clock cycles.`))),
  };
}

/** Radix-4 Booth: recode an 8-bit multiplier into four digits from {−2, −1, 0, 1, 2}. */
export function boothWidget(): Widget {
  let b = -7 & 0xff;
  const input = h('input', { type: 'range', min: '-128', max: '127', value: String(-7), style: 'width:260px' }) as HTMLInputElement;
  const out = h('div', null);
  const render = () => {
    const bits = Array.from({ length: 8 }, (_, i) => (b >> i) & 1);
    const digits: { d: number; tri: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const bm = i === 0 ? 0 : bits[2 * i - 1], b0 = bits[2 * i], b1 = bits[2 * i + 1];
      digits.push({ d: -2 * b1 + b0 + bm, tri: `${b1}${b0}${bm}` });
    }
    const signed = b >= 128 ? b - 256 : b;
    const sum = digits.reduce((s, x, i) => s + x.d * 4 ** i, 0);
    const pp = (d: number) => (d === 0 ? '0' : `${d < 0 ? '−' : '+'}${Math.abs(d) === 2 ? '2a' : 'a'}`);
    out.replaceChildren(
      h('p', { style: 'font:14px var(--font-mono)' }, `b = ${signed}  =  ${bits.slice().reverse().join('')}₂  (+ an implicit 0 on the right)`),
      h('table', { class: 'cmp', style: 'max-width:560px' },
        h('thead', null, h('tr', null, h('th', null, 'digit'), h('th', null, 'bits b₂ᵢ₊₁ b₂ᵢ b₂ᵢ₋₁'), h('th', null, 'value'), h('th', null, 'weight'), h('th', null, 'partial product'))),
        h('tbody', null, digits.map((x, i) => h('tr', null,
          h('td', null, String(i)), h('td', null, x.tri), h('td', { class: 'num' }, String(x.d)), h('td', { class: 'num' }, `4^${i}`), h('td', null, `${pp(x.d)} · 4^${i}`))))),
      h('p', { class: 'sub', style: 'margin-top:8px' },
        `Σ digit · 4ⁱ = ${digits.map((x, i) => `${x.d}·${4 ** i}`).join(' + ')} = ${sum} ${sum === signed ? '✓' : '✗'}. Four partial products instead of eight, each just a shifted (and possibly inverted) copy of a: no multiplication by 3 is ever needed. Booth recoding handles the sign for free, which is why it replaced Baugh–Wooley in most fast multipliers.`));
  };
  input.addEventListener('input', () => { b = Number(input.value) & 0xff; render(); });
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Radix-4 Booth recoding'),
      h('p', { class: 'sub' }, 'Drag to choose the multiplier b (8-bit, signed). Each overlapping group of three bits becomes one digit.'),
      h('div', { class: 'param-row' }, h('span', null, 'b'), input),
      out)),
  };
}
