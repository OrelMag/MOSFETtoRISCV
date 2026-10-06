// Chapter 23 widgets: an IEEE 754 bit explorer for several formats, and the number line of every
// value of a tiny format (where the spacing of floats becomes visible).

import { F16, F32, fpValue, parts, roundTo, type FpFormat } from '../sim/fpref';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const FORMATS: [string, FpFormat][] = [['float32', F32], ['binary16 (half)', F16], ['8-bit E4M3', { E: 4, M: 3 }]];

/** Nearest encoding of a JS number in format f (round to nearest even). */
export function encodeNumber(x: number, f: FpFormat): number {
  const N = 1 + f.E + f.M, top = 2 ** f.E - 1;
  const sign = x < 0 || Object.is(x, -0) ? 1 : 0;
  if (Number.isNaN(x)) return top * 2 ** f.M + 2 ** (f.M - 1);
  if (!Number.isFinite(x)) return (sign * 2 ** f.E + top) * 2 ** f.M;
  if (x === 0) return sign * 2 ** (N - 1);
  // the double's exact binary value: mant × 2^exp
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const e = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e) mant |= 1n << 52n;
  return roundTo(sign, mant, (e || 1) - 1075, f);
}

const fmtVal = (v: number) => (Number.isNaN(v) ? 'NaN' : !Number.isFinite(v) ? (v > 0 ? '+∞' : '−∞') : Object.is(v, -0) ? '−0' : Math.abs(v) >= 1e-4 && Math.abs(v) < 1e7 ? String(+v.toPrecision(9)) : v.toExponential(7));

/** Click bits, type a number, step by one ulp: what a float really is. */
export function floatExplorer(): Widget {
  let f = F32, bits = 0x3dcccccd;
  const grid = h('div', { class: 'fx-bits' });
  const info = h('div', { class: 'fx-info' });
  const input = h('input', { type: 'text', value: '0.1', class: 'fx-in', 'aria-label': 'decimal value' }) as HTMLInputElement;
  const N = () => 1 + f.E + f.M;
  const render = () => {
    const n = N(), p = parts(bits, f), v = fpValue(bits, f);
    grid.replaceChildren(...Array.from({ length: n }, (_, k) => {
      const i = n - 1 - k, on = Math.floor(bits / 2 ** i) % 2;
      const cls = i === n - 1 ? 's' : i >= f.M ? 'e' : 'm';
      return h('button', { class: `fx-bit ${cls}${on ? ' on' : ''}`, title: `bit ${i}`, onclick: () => { bits = on ? bits - 2 ** i : bits + 2 ** i; render(); } }, String(on));
    }));
    const b = 2 ** (f.E - 1) - 1;
    const formula = p.kind === 'normal' ? `(−1)^${p.sign} × 1.${p.frac.toString(2).padStart(f.M, '0')}₂ × 2^(${p.field} − ${b}) = ${p.sign ? '−' : ''}1.${p.frac.toString(2).padStart(f.M, '0')}₂ × 2^${p.field - b}`
      : p.kind === 'subnormal' ? `(−1)^${p.sign} × 0.${p.frac.toString(2).padStart(f.M, '0')}₂ × 2^${1 - b}   (subnormal: no hidden 1, exponent fixed at 1 − bias)`
        : p.kind === 'zero' ? `${p.sign ? '−' : '+'}0 (exponent and fraction all zero)`
          : p.kind === 'inf' ? `${p.sign ? '−' : '+'}∞ (exponent all ones, fraction zero)` : 'NaN (exponent all ones, fraction non-zero)';
    const next = bits + 1 < 2 ** n ? fpValue(bits + 1, f) : NaN;
    const ulp = p.kind === 'normal' || p.kind === 'subnormal' ? Math.abs(next - v) : NaN;
    info.replaceChildren(
      h('div', null, h('span', { class: 'fx-k' }, 'value'), h('strong', null, fmtVal(v)), h('span', { class: 'sub' }, `  ${p.kind}`)),
      h('div', null, h('span', { class: 'fx-k' }, 'bits'), h('code', null, `0x${bits.toString(16).toUpperCase().padStart(Math.ceil(n / 4), '0')}`)),
      h('div', null, h('span', { class: 'fx-k' }, 'meaning'), h('code', null, formula)),
      h('div', null, h('span', { class: 'fx-k' }, 'spacing'), h('span', null, Number.isFinite(ulp) ? `the next float is ${fmtVal(next)}, ${fmtVal(ulp)} away (1 ulp)` : '–')),
      h('div', { class: 'sub' }, `sign 1 bit · exponent ${f.E} bits (bias ${b}) · fraction ${f.M} bits · ${n} bits in all · largest ${fmtVal(fpValue((2 ** f.E - 2) * 2 ** f.M + 2 ** f.M - 1, f))}, smallest normal ${fmtVal(2 ** (1 - b))}, smallest subnormal ${fmtVal(2 ** (1 - b - f.M))}`));
  };
  input.addEventListener('change', () => {
    const x = Number(input.value.trim().replace(/^inf(inity)?$/i, 'Infinity').replace(/^-inf(inity)?$/i, '-Infinity'));
    bits = encodeNumber(x, f);
    render();
  });
  const sel = h('select', { 'aria-label': 'format' }) as HTMLSelectElement;
  FORMATS.forEach(([n], i) => sel.append(h('option', { value: String(i) }, n)));
  sel.addEventListener('change', () => { f = FORMATS[Number(sel.value)][1]; bits = encodeNumber(Number(input.value) || 0, f); render(); });
  const step = (d: number) => { bits = Math.min(2 ** N() - 1, Math.max(0, bits + d)); render(); };
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'IEEE 754, bit by bit'),
      h('p', { class: 'sub' }, 'Click any bit, or type a number (it is rounded to the nearest float). Red: sign. Blue: exponent. Green: fraction.'),
      h('div', { class: 'param-row' }, sel, input,
        h('button', { class: 'btn sm', onclick: () => step(-1) }, '− 1 ulp'), h('button', { class: 'btn sm', onclick: () => step(1) }, '+ 1 ulp')),
      grid, info)),
  };
}

/** Every positive value of a tiny format on one axis: equal spacing inside a binade, doubling between binades. */
export function floatLine(): Widget {
  const f: FpFormat = { E: 3, M: 2 };
  const vals: { v: number; bits: number; kind: string }[] = [];
  for (let bits = 0; bits < 2 ** (f.E + f.M); bits++) {
    const p = parts(bits, f);
    if (p.kind === 'inf' || p.kind === 'nan') continue;
    vals.push({ v: fpValue(bits, f), bits, kind: p.kind });
  }
  const max = vals[vals.length - 1].v;
  const W = 640, H = 150;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'fx-line');
  let s = '';
  // two rows: the whole range, and [0, 1] magnified 14×
  const row = (y: number, lim: number, ticks: number[], title: string) => {
    const x = (v: number) => 20 + (v / lim) * (W - 40);
    s += `<text x="20" y="${y - 14}" class="lbl">${title}</text><line x1="20" x2="${W - 20}" y1="${y}" y2="${y}" class="ax"/>`;
    for (const t of ticks) s += `<text x="${x(t)}" y="${y + 20}" text-anchor="middle" class="lbl">${t}</text><line x1="${x(t)}" x2="${x(t)}" y1="${y}" y2="${y + 7}" class="ax"/>`;
    for (const p of vals) if (p.v <= lim) s += `<circle cx="${x(p.v)}" cy="${y}" r="4" class="${p.kind}"><title>${p.v} = 0b${p.bits.toString(2).padStart(5, '0')}</title></circle>`;
  };
  row(36, max, [0, 1, 2, 4, 8, max], `0 … ${max}`);
  row(108, 1, [0, 0.25, 0.5, 0.75, 1], '0 … 1, magnified');
  svg.innerHTML = s;
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Every value of a 6-bit float (E3M2)'),
      h('p', { class: 'sub' }, `${vals.length} non-negative values, from 0 to ${max}. Each binade [2ᵏ, 2ᵏ⁺¹) holds the same 4 values, so the gaps double from one binade to the next: the relative precision is constant, the absolute one is not. The subnormals (orange) fill the gap between 0 and the smallest normal number evenly instead of leaving a hole.`),
      svg,
      h('p', { class: 'sub' }, 'float32 is the same picture with 2²³ values per binade and 254 binades.'))),
  };
}
