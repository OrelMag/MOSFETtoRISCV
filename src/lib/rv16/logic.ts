// The campaign's blocks for acts 1–3 (docs/CAMPAIGN.md): each one is built only from NAND, wiring
// and the parts unlocked by the levels below it, so its sandbox drawing is the level's reference
// solution (campaign/levels.ts: docFromDef). Drawn with the Builder; long or shared nets are labels.

import type { ComponentDef, PortDef } from '../../sim/types';
import { Builder } from '../builder';
import { constWord } from '../alu';
import { addSub, andN, busMux2, incrementer, muxTree, rca } from '../combinational';
import { define, merger, splitter } from '../define';
import { AND, NOT, OR, XOR } from '../gates';
import { DFF, register } from '../sequential';
import { NAND, TIE1 } from '../transistors';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

/** Is a 4-bit number prime? The g_sop level's function: a sum of products from a K-map. */
export const PRIMES4 = [2, 3, 5, 7, 11, 13];

export const PRIME4: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('a');
  const s = b.op(splitter([1, 1, 1, 1], 4), ['a']);
  const [a0, a1, a2, a3] = [0, 1, 2, 3].map((i) => b.name(`${s}.o${i}`, `a${i}`, true));
  b.next();
  const n3 = b.name(b.op1(NOT, [a3], '¬a3'), 'na3', true);
  const n2 = b.name(b.op1(NOT, [a2], '¬a2'), 'na2', true);
  const n1 = b.name(b.op1(NOT, [a1], '¬a1'), 'na1', true);
  b.next();
  // m2, m3: ¬a3¬a2a1 · m5, m7: ¬a3a2a0 · m3, m11: ¬a2a1a0 · m5, m13: a2¬a1a0
  const p1 = b.op1(AND, [n3, n2]), p2 = b.op1(AND, [n3, a2]), p3 = b.op1(AND, [n2, a1]), p4 = b.op1(AND, [a2, n1]);
  b.next();
  const t1 = b.op1(NAND, [p1, a1], '¬(¬a3¬a2a1)'), t2 = b.op1(NAND, [p2, a0], '¬(¬a3a2a0)');
  const t3 = b.op1(NAND, [p3, a0], '¬(¬a2a1a0)'), t4 = b.op1(NAND, [p4, a0], '¬(a2¬a1a0)');
  b.next();
  const u = b.op1(AND, [t1, t2]), v = b.op1(AND, [t3, t4]);
  b.next();
  b.wire(b.op1(NAND, [u, v], 'OR of the terms'), 'y');
  const R = b.right;
  return define({
    id: 'rv16_prime4', name: 'Prime detector (4-bit)', category: 'gate',
    summary: 'y = 1 when a is prime (2, 3, 5, 7, 11, 13): four product terms read off a K-map, NAND–NAND.',
    ports: [bus('a', 4, 'in'), bit('y', 'out')],
    symbol: { kind: 'box', label: 'PRIME?' },
    spec: ([a]) => [PRIMES4.includes(a) ? 1 : 0],
    netlist: () => ({ pins: { a: [0, 6], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** 16-input OR as a balanced tree, and its complement: "is the word zero?". */
export const WIDE16: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a');
  const s = b.op(splitter(Array(16).fill(1), 2), ['a']);
  let level = Array.from({ length: 16 }, (_, i) => `${s}.o${i}`);
  while (level.length > 1) {
    b.next();
    const nxt: string[] = [];
    for (let i = 0; i < level.length; i += 2) nxt.push(b.op1(OR, [level[i], level[i + 1]]));
    level = nxt;
  }
  const any = b.name(level[0], 'any', true);
  b.next();
  b.wire(any, 'any');
  b.wire(b.op1(NOT, [any], 'zero'), 'zero');
  const R = b.right;
  return define({
    id: 'rv16_wide16', name: 'Wide OR / zero detect (16-bit)', category: 'gate',
    summary: 'any = OR of 16 bits through a balanced tree of 2-input ORs (4 levels, not 15); zero = ¬any.',
    ports: [bus('a', 16, 'in'), bit('any', 'out'), bit('zero', 'out')],
    symbol: { kind: 'box', label: 'ZERO?' },
    spec: ([a]) => [a ? 1 : 0, a ? 0 : 1],
    netlist: () => ({ pins: { a: [0, 16], any: [R, 14], zero: [R, 18] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** 3→8 decoder with enable, one-hot output bus. */
export const DEC3: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a', 'en');
  const s = b.op(splitter([1, 1, 1], 4), ['a']);
  const a = [0, 1, 2].map((i) => b.name(`${s}.o${i}`, `a${i}`, true));
  b.next();
  const na = a.map((x, i) => b.name(b.op1(NOT, [x], `¬a${i}`), `na${i}`, true));
  b.next();
  const and4 = andN(4);
  const ys = Array.from({ length: 8 }, (_, k) => b.op1(and4, [(k & 1 ? a : na)[0], (k & 2 ? a : na)[1], (k & 4 ? a : na)[2], 'en'], `y${k}`));
  b.next();
  b.wire(b.op1(merger(Array(8).fill(1), 2), ys), 'y');
  const R = b.right;
  return define({
    id: 'rv16_dec3', name: '3→8 decoder (bus)', category: 'routing',
    summary: 'y = en ? 1 << a : 0: output k is the AND of en and the address bits (or their complements) that spell k.',
    ports: [bus('a', 3, 'in'), bit('en', 'in'), bus('y', 8, 'out')],
    symbol: { kind: 'box', label: 'DEC 3→8' },
    spec: ([a, en]) => [en ? 1 << a : 0],
    netlist: () => ({ pins: { a: [0, 4], en: [0, 8], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** 16-bit equality: XOR per bit, then a zero detect. */
export const EQ16: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a', 'b');
  const sa = b.op(splitter(Array(16).fill(1), 2), ['a']);
  const sb = b.op(splitter(Array(16).fill(1), 2), ['b']);
  b.next();
  const xs = Array.from({ length: 16 }, (_, i) => b.op1(XOR, [`${sa}.o${i}`, `${sb}.o${i}`]));
  b.next();
  const m = b.op1(merger(Array(16).fill(1), 2), xs, 'a ⊕ b');
  b.next();
  b.wire(`${b.op(WIDE16, [m], 'all equal?')}.zero`, 'eq');
  const R = b.right;
  return define({
    id: 'rv16_eq16', name: 'Equality (16-bit)', category: 'routing',
    summary: 'eq = (a = b): 16 XORs (a bit differs) and a zero detect over their outputs.',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bit('eq', 'out')],
    symbol: { kind: 'box', label: 'A = B' },
    spec: ([a, b]) => [a === b ? 1 : 0],
    netlist: () => ({ pins: { a: [0, 16], b: [0, 50], eq: [R, 30] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** 16-bit ripple adder as four 4-bit ripple adders. */
export const ADD16: ComponentDef = (() => {
  const b = new Builder(8, 12, 4);
  b.pins('a', 'b', 'cin');
  const sa = b.op(splitter([4, 4, 4, 4], 6), ['a']);
  const sb = b.op(splitter([4, 4, 4, 4], 6), ['b']);
  b.next();
  let c = 'cin';
  const sums: string[] = [];
  for (let i = 0; i < 4; i++) {
    const u = b.op(rca(4), [`${sa}.o${i}`, `${sb}.o${i}`, c], `bits ${4 * i + 3}…${4 * i}`);
    sums.push(`${u}.s`);
    c = b.name(`${u}.cout`, `c${4 * (i + 1)}`, true);
  }
  b.next();
  b.wire(b.op1(merger([4, 4, 4, 4], 6), sums), 's');
  b.wire(c, 'cout');
  const R = b.right;
  return define({
    id: 'rv16_add16', name: '16-bit adder (4 × 4-bit ripple)', category: 'arithmetic',
    summary: '{cout, s} = a + b + cin: four 4-bit ripple adders, the carry chained from one to the next (36 NAND delays).',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bit('cin', 'in'), bus('s', 16, 'out'), bit('cout', 'out')],
    symbol: { kind: 'box', label: 'ADD16' },
    spec: ([a, b, c]) => {
      const t = a + b + c;
      return [t & 0xffff, t >> 16];
    },
    netlist: () => ({ pins: { a: [0, 6], b: [0, 18], cin: [0, 30], s: [R, 10], cout: [R, 20] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Signed and unsigned less-than from one subtraction. */
export const CMP16: ComponentDef = (() => {
  const b = new Builder(8, 12, 4);
  b.pins('a', 'b');
  const one = b.op1(TIE1, []);
  b.next();
  const d = b.op(addSub(16), ['a', 'b', one], 'a − b');
  b.next();
  b.wire(b.op1(XOR, [`${d}.n`, `${d}.v`], 'N ⊕ V'), 'lt');
  b.wire(b.op1(NOT, [`${d}.cout`], 'no carry'), 'ltu');
  const R = b.right;
  return define({
    id: 'rv16_cmp16', name: 'Less-than (16-bit, signed and unsigned)', category: 'arithmetic',
    summary: 'From a + ¬b + 1: unsigned a < b ⇔ no carry out; signed a < b ⇔ the sign of the difference, corrected for overflow (N ⊕ V).',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bit('lt', 'out'), bit('ltu', 'out')],
    symbol: { kind: 'box', label: 'A < B' },
    spec: ([a, b]) => [((a << 16) >> 16) < ((b << 16) >> 16) ? 1 : 0, a < b ? 1 : 0],
    netlist: () => ({ pins: { a: [0, 6], b: [0, 10], lt: [R, 6], ltu: [R, 10] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The program counter: 0 on reset, d on load, else pc + 1. */
export const PC16: ComponentDef = (() => {
  const b = new Builder(8, 12, 4);
  b.pins('rst', 'ld', 'd', 'clk');
  const one = b.op1(TIE1, []);
  const zero = b.op1(constWord(16, 0), []);
  b.next();
  const inc = b.op(incrementer(16), [''], 'pc + 1');
  b.next();
  const m1 = b.op1(busMux2(16), [`${inc}.y`, 'd', 'ld'], 'load?');
  b.next();
  const m2 = b.op1(busMux2(16), [m1, zero, 'rst'], 'reset?');
  b.next();
  const r = b.op(register(16), [m2, one, 'clk'], 'PC');
  const pc = b.name(`${r}.q`, 'pc', true);
  b.wire(pc, `${inc}.a`);
  b.wire(pc, 'pc');
  const R = b.right;
  return define({
    id: 'rv16_pc', name: 'Program counter (16-bit)', category: 'sequential',
    summary: 'pc ← rst ? 0 : ld ? d : pc + 1 at every rising edge: a register, an incrementer and two bus multiplexers.',
    ports: [bit('rst', 'in'), bit('ld', 'in'), bus('d', 16, 'in'), { name: 'clk', width: 1, dir: 'in', clock: true }, bus('pc', 16, 'out')],
    symbol: { kind: 'box', label: 'PC' },
    netlist: () => ({ pins: { ...pinsAt(['rst', 'ld', 'd', 'clk'], 0), pc: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Eight 16-bit registers, x0 = 0, two read ports, one write port. */
export const RF8: ComponentDef = (() => {
  const b = new Builder(8, 14, 6);
  b.pins('wa', 'we', 'wd', 'ra1', 'ra2', 'clk');
  const dec = b.op1(DEC3, ['wa', 'we'], 'write select');
  const zero = b.name(b.op1(constWord(16, 0), [], 'x0'), 'x0', true);
  b.next();
  const en = b.op(splitter(Array(8).fill(1), 2), [dec]);
  b.next();
  const qs = [zero];
  for (let i = 1; i < 8; i++) qs.push(b.name(`${b.op(register(16), ['wd', `${en}.o${i}`, 'clk'], `x${i}`)}.q`, `x${i}`, true));
  b.next();
  const mux = muxTree(3, 16);
  b.wire(b.op1(mux, [...qs, 'ra1'], 'read rs1'), 'rd1');
  b.wire(b.op1(mux, [...qs, 'ra2'], 'read rs2'), 'rd2');
  const R = b.right;
  return define({
    id: 'rv16_rf', name: 'Register file (8 × 16)', category: 'memory',
    summary: 'Write: the decoder (enabled by we) loads one of x1…x7 at the clock edge. Read: two 8:1 bus multiplexers, combinational. x0 is the constant 0: no register.',
    ports: [bus('wa', 3, 'in'), bit('we', 'in'), bus('wd', 16, 'in'), bus('ra1', 3, 'in'), bus('ra2', 3, 'in'), { name: 'clk', width: 1, dir: 'in', clock: true }, bus('rd1', 16, 'out'), bus('rd2', 16, 'out')],
    symbol: { kind: 'box', label: 'REGS' },
    netlist: () => ({ pins: { ...pinsAt(['wa', 'we', 'wd', 'ra1', 'ra2', 'clk'], 0), rd1: [R, 8], rd2: [R, 16] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Mealy machine: y = 1 when the last three inputs were 1, 0, 1 (overlapping), synchronous reset. */
export const DET101: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('x', 'rst', 'clk');
  const nx = b.name(b.op1(NOT, ['x'], '¬x'), 'nx', true);
  const nr = b.name(b.op1(NOT, ['rst'], '¬rst'), 'nrst', true);
  b.next();
  // States: S0 = 00, S1 (saw 1) = 01, S2 (saw 10) = 10. n0 = x·¬rst; n1 = ¬x·s0·¬rst; y = x·s1.
  const g0 = b.op1(NAND, ['x', nr]);
  const g1 = b.op1(NAND, [nx, nr]);
  b.next();
  const n0 = b.op1(NOT, [g0], 'n0');
  const h1 = b.op1(NOT, [g1]);
  b.next();
  const k1 = b.op1(NAND, [h1, '']);
  b.next();
  const n1 = b.op1(NOT, [k1], 'n1');
  b.next();
  const f0 = b.op(DFF, [n0, 'clk'], 's0');
  const f1 = b.op(DFF, [n1, 'clk'], 's1');
  const s0 = b.name(`${f0}.q`, 's0', true), s1 = b.name(`${f1}.q`, 's1', true);
  b.wire(s0, `${k1.split('.')[0]}.b`);
  b.next();
  const yn = b.op1(NAND, ['x', s1]);
  b.next();
  b.wire(b.op1(NOT, [yn], 'x·s1'), 'y');
  const R = b.right;
  return define({
    id: 'rv16_det101', name: '"101" detector (state machine)', category: 'sequential',
    summary: 'A Mealy machine: two flip-flops hold the state (nothing, saw 1, saw 10); y = 1 when x = 1 completes 1-0-1. Synchronous reset.',
    ports: [bit('x', 'in'), bit('rst', 'in'), { name: 'clk', width: 1, dir: 'in', clock: true }, bit('y', 'out')],
    symbol: { kind: 'box', label: '101?' },
    netlist: () => ({ pins: { ...pinsAt(['x', 'rst', 'clk'], 0), y: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();
