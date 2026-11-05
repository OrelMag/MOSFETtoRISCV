// Chapter "Pictures"' 8-point DCT in gates: sums and differences, constant products as shift-and-add on their signed digits, every bit kept, and each output rounded once.
// dsp/pictures.ts dct8Fixed is the golden model (tests/dsp-pictures.test.ts compares every vector). No multiplier anywhere: a constant's digits are the wiring.

import { DCT_C, DCT_F, DCT_K, DCT_WI, DCT_WO } from '../dsp/pictures';
import { wrapTo } from '../dsp/fixed';
import type { ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { rca } from './combinational';
import { define } from './define';
import { csdDigits, cut, placed, roundUp } from './fft';
import { TIE0, TIE1 } from './transistors';
import { notBus } from './viterbi';

const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const uns = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;
const sgn = (v: number, w: number) => wrapTo(v, w);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
function built(b: Builder, ports: PortDef[]) {
  const R = b.right;
  let li = 0, ri = 0;
  const pins: Record<string, [number, number]> = {};
  for (const p of ports) pins[p.name] = p.dir === 'in' ? [0, 2 + 3 * li++] : [R, 2 + 3 * ri++];
  return { pins, instances: b.instances, nets: b.nets() };
}

/** Bits a word needs as it moves through the stage: the input, after one add (a, b), two (c, d), three (c0 ± c1), and the products and their sums. */
export const DCT_P = DCT_WI + 3 + DCT_C + 1;

/** y = k × x, for a constant k > 0: one term per signed digit of k, each x moved up by wiring, added or subtracted. w bits in, P out, nothing dropped. */
export function constMul(k: number, w: number, P = DCT_P): ComponentDef {
  return memo(`cmul${k}_${w}_${P}`, () => {
    const digits = csdDigits(k).reverse(), b = new Builder(6, 10, 4);
    b.pins('x');
    const z = b.op1(TIE0, [], undefined, 'z');
    b.next();
    const term = (s: number) => b.op1(placed(w, s, P), s ? ['x', z] : ['x']);
    let acc = term(digits[0].pos);
    for (const d of digits.slice(1)) {
      const t = term(d.pos), o = d.neg ? b.op1(notBus(P), [t]) : t, cin = b.op1(d.neg ? TIE1 : TIE0, []);
      b.next();
      acc = `${b.op(rca(P), [acc, o, cin], `${d.neg ? '−' : '+'} x ≪ ${d.pos}`)}.s`;
      b.next();
    }
    b.wire(acc, 'y');
    const ports = [bus('x', w, 'in'), bus('y', P, 'out')];
    return define({
      id: `cmul${k}_${w}_${P}`, name: `× ${k}`, category: 'arithmetic',
      summary: `Multiplies by the constant ${k} with ${digits.length - 1} adder${digits.length === 2 ? '' : 's'}, one for each signed digit after the first (${digits.map((d) => `${d.neg ? '−' : '+'}2^${d.pos}`).join(' ')}). No multiplier: the constant is in the wiring.`,
      ports, symbol: { kind: 'box', label: `×${k}`, w: 6 },
      spec: ([x]) => [uns(sgn(x, w) * k, P)],
      netlist: () => built(b, ports),
    });
  });
}

/** a + b or a − b, both sign-extended from w to `to` bits: one adder, the subtraction its inverted operand and a carry-in of 1. */
function addOrSub(sub: boolean, w: number, to: number): ComponentDef {
  return memo(`dct_${sub ? 'sub' : 'add'}${w}_${to}`, () => {
    const b = new Builder(6, 8, 3);
    b.pins('a', 'b');
    const pa = b.op1(placed(w, 0, to), ['a']), pb0 = b.op1(placed(w, 0, to), ['b']);
    const pb = sub ? b.op1(notBus(to), [pb0]) : pb0, cin = b.op1(sub ? TIE1 : TIE0, []);
    b.next();
    b.wire(`${b.op(rca(to), [pa, pb, cin], sub ? 'a − b' : 'a + b')}.s`, 'y');
    const ports = [bus('a', w, 'in'), bus('b', w, 'in'), bus('y', to, 'out')];
    return define({
      id: `dct_${sub ? 'sub' : 'add'}${w}_${to}`, name: `${to}-bit ${sub ? 'subtractor' : 'adder'}`, category: 'arithmetic',
      summary: sub ? 'a − b: b inverted and a carry-in of 1, which is its two\'s complement, then an adder.' : 'a + b, both sign-extended first, so the sum cannot overflow.',
      ports, symbol: { kind: 'box', label: sub ? 'a−b' : 'a+b', w: 4 },
      spec: ([x, y]) => [uns(sub ? sgn(x, w) - sgn(y, w) : sgn(x, w) + sgn(y, w), to)],
      netlist: () => built(b, ports),
    });
  });
}

/** Rows of the stage: per output, the signed terms of its sum, as [constant index, operand]. Operands: s0 = c0 + c1, s4 = c0 − c1, d0, d1, b0 … b3. */
const ROWS: [number, string, boolean][][] = [
  [[4, 's0', false]],
  [[1, 'b0', false], [3, 'b1', false], [5, 'b2', false], [7, 'b3', false]],
  [[2, 'd0', false], [6, 'd1', false]],
  [[3, 'b0', false], [7, 'b1', true], [1, 'b2', true], [5, 'b3', true]],
  [[4, 's4', false]],
  [[5, 'b0', false], [1, 'b1', true], [7, 'b2', false], [3, 'b3', false]],
  [[6, 'd0', false], [2, 'd1', true]],
  [[7, 'b0', false], [5, 'b1', true], [3, 'b2', false], [1, 'b3', true]],
];

/** One output: its products summed (subtracted where the row says), then rounded once, half up, to Wo bits. */
function dctRow(u: number): ComponentDef {
  return memo(`dct_row${u}`, () => {
    const terms = ROWS[u], P = DCT_P, sh = DCT_C - DCT_F, b = new Builder(6, 10, 4);
    b.pins(...terms.map((_, i) => `p${i}`));
    // a lone product goes through a wiring box, so the pin has one sink and the two cuts hang off its output
    let acc = terms.length === 1 ? b.op1(placed(P, 0, P), ['p0']) : 'p0';
    if (terms.length === 1) b.next();
    for (let i = 1; i < terms.length; i++) {
      const neg = terms[i][2], o = neg ? b.op1(notBus(P), [`p${i}`]) : `p${i}`, cin = b.op1(neg ? TIE1 : TIE0, []);
      b.next();
      acc = `${b.op(rca(P), [acc, o, cin], neg ? '−' : '+')}.s`;
      b.next();
    }
    const hi = b.op1(cut(P, sh, DCT_WO), [acc], `≫ ${sh}`), lo = b.op1(cut(P, sh - 1, 1), [acc], 'round bit');
    b.next();
    b.wire(b.op1(roundUp(DCT_WO), [hi, lo], 'round half up'), 'y');
    const ports = [...terms.map((_, i) => bus(`p${i}`, P, 'in')), bus('y', DCT_WO, 'out')];
    const label = terms.map(([k, op, neg], i) => `${i ? (neg ? ' − ' : ' + ') : ''}k${k}·${op}`).join('');
    return define({
      id: `dct_row${u}`, name: `X${u} = ${label}`, category: 'arithmetic',
      summary: `Output ${u}: its ${terms.length} product${terms.length > 1 ? 's' : ''} summed with every bit, then one rounding: ${sh} bits dropped, the first of them added back.`,
      ports, symbol: { kind: 'box', label: `X${u}`, w: 4 },
      spec: (ins) => { let s = 0; terms.forEach(([, , neg], i) => { s += (neg ? -1 : 1) * sgn(ins[i], P); }); return [uns(Math.floor((s + 2 ** (sh - 1)) / 2 ** sh), DCT_WO)]; },
      netlist: () => built(b, ports),
    });
  });
}

/** The whole 8-point stage: eight samples in, eight coefficients out, 2^F times their true values. */
export function dctStage(): ComponentDef {
  return memo('dct8', () => {
    const Wi = DCT_WI, b = new Builder(8, 12, 3);
    const xs = Array.from({ length: 8 }, (_, i) => `x${i}`);
    b.pins(...xs);
    const ad = (i: number) => b.op1(addOrSub(false, Wi, Wi + 1), [`x${i}`, `x${7 - i}`], `x${i} + x${7 - i}`, `a${i}`);
    const df = (i: number) => b.op1(addOrSub(true, Wi, Wi + 1), [`x${i}`, `x${7 - i}`], `x${i} − x${7 - i}`, `b${i}`);
    const a = [0, 1, 2, 3].map(ad), bb = [0, 1, 2, 3].map(df);
    b.next();
    const c0 = b.op1(addOrSub(false, Wi + 1, Wi + 2), [a[0], a[3]], 'a0 + a3', 'c0'), c1 = b.op1(addOrSub(false, Wi + 1, Wi + 2), [a[1], a[2]], 'a1 + a2', 'c1');
    const d0 = b.op1(addOrSub(true, Wi + 1, Wi + 2), [a[0], a[3]], 'a0 − a3', 'd0'), d1 = b.op1(addOrSub(true, Wi + 1, Wi + 2), [a[1], a[2]], 'a1 − a2', 'd1');
    b.next();
    const s0 = b.op1(addOrSub(false, Wi + 2, Wi + 3), [c0, c1], 'c0 + c1', 's0'), s4 = b.op1(addOrSub(true, Wi + 2, Wi + 3), [c0, c1], 'c0 − c1', 's4');
    b.next();
    const ops: Record<string, [string, number]> = { s0: [s0, Wi + 3], s4: [s4, Wi + 3], d0: [d0, Wi + 2], d1: [d1, Wi + 2], b0: [bb[0], Wi + 1], b1: [bb[1], Wi + 1], b2: [bb[2], Wi + 1], b3: [bb[3], Wi + 1] };
    const products = ROWS.map((row, u) => row.map(([k, op], i) => b.op1(constMul(DCT_K[k], ops[op][1]), [ops[op][0]], `k${k} = ${DCT_K[k]}`, `m${u}_${i}`)));
    b.next();
    products.forEach((ps, u) => b.wire(b.op1(dctRow(u), ps, undefined, `X${u}`), `y${u}`));
    const ports = [...xs.map((x) => bus(x, Wi, 'in')), ...Array.from({ length: 8 }, (_, u) => bus(`y${u}`, DCT_WO, 'out'))];
    return define({
      id: 'dct8', name: '8-point DCT', category: 'arithmetic',
      summary: `Eight samples to eight cosine coefficients: sums and differences of mirrored pairs split it into an even half and an odd half, then ${ROWS.flat().length} products by constants, each only shifts and adds, every bit kept, and each output rounded once. Its outputs are 2^${DCT_F} times the true ones.`,
      ports, symbol: { kind: 'box', label: 'DCT', w: 8 },
      netlist: () => built(b, ports),
    });
  });
}
