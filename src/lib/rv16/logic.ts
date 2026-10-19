// The campaign's blocks for acts 1–3 (docs/CAMPAIGN.md): each one is built only from NAND, wiring
// and the parts unlocked by the levels below it, so its sandbox drawing is the level's reference
// solution (campaign/levels.ts: docFromDef). Drawn with the Builder; long or shared nets are labels.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../../sim/types';
import { Builder } from '../builder';
import { aluOf, constWord, shifterOf } from '../alu';
import { busMux2, HALF_ADDER, muxTreeOf, rca, type Mux2Kind } from '../combinational';
import { define, merger, splitter } from '../define';
import type { FsmInputs, FsmSpec } from '../fsm';
import { AND, MUX2, NOT, OR, XOR } from '../gates';
import { SR_LATCH } from '../sequential';
import { NAND, TIE1 } from '../transistors';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

/** Is a 4-bit number prime? The g_sop level's function, read off its K-map. */
export const PRIMES4 = [2, 3, 5, 7, 11, 13];

/**
 * The fewest 2-input NANDs (8: an exhaustive search finds none with 7) at the least depth (5: no NAND circuit
 * reaches the function in 4). The map's lower half (a3 = 0) is a2 ? a0 : a1, a multiplexer; its upper half keeps
 * only 11 and 13 of that mux's ones, so y = mux · (¬a3 + a0·¬(a1·a2)). ¬(a1·a2) serves both factors, and
 * ¬(a1·¬a2) = NAND(a1, ¬(a1·a2)) stands in for the mux's inverter (tests/content-walk-a.test.ts).
 */
export const PRIME4: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('a');
  const s = b.op(splitter([1, 1, 1, 1], 4), ['a']);
  const [a0, a1, a2, a3] = [0, 1, 2, 3].map((i) => b.name(`${s}.o${i}`, `a${i}`, true));
  b.next();
  const n12 = b.name(b.op1(NAND, [a1, a2], '¬(a1·a2)', 'n12'), 'n12', true);
  const n02 = b.op1(NAND, [a0, a2], '¬(a2·a0)', 'n02');
  b.next();
  const k1 = b.op1(NAND, [a1, n12], '¬(a1·¬a2)', 'k1');
  const k0 = b.op1(NAND, [a0, n12], '¬(a0·¬(a1·a2))', 'k0');
  b.next();
  const mux = b.op1(NAND, [n02, k1], 'a2 ? a0 : a1', 'mux');
  const hi = b.op1(NAND, [a3, k0], '¬a3 + a0·¬(a1·a2)', 'hi');
  b.next();
  const ny = b.op1(NAND, [mux, hi], '¬y', 'ny');
  b.next();
  b.wire(b.op1(NOT, [ny], 'y', 'inv'), 'y');
  const R = b.right;
  return define({
    id: 'rv16_prime4', name: 'Prime detector (4-bit)', category: 'gate',
    summary: 'y = 1 when a is prime (2, 3, 5, 7, 11, 13): y = (a2 ? a0 : a1) · (¬a3 + a0·¬(a1·a2)), 8 NANDs, depth 5 (a sum of products read off the K-map: 20, depth 7).',
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

/**
 * 3→8 decoder with enable, one-hot output bus, predecoded in two groups: (a0, a1) into four lines p0–p3,
 * (a2, en) into two, q0 = en·¬a2 and q1 = en·a2; output k = p[k mod 4] · q[k div 4]. 30 NANDs, depth 5,
 * against 51 for eight 4-input ANDs. q0 = en·NAND(en, a2) needs no inverter on a2.
 */
export const DEC3: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a', 'en');
  const s = b.op(splitter([1, 1, 1], 4), ['a']);
  const [a0, a1, a2] = [0, 1, 2].map((i) => b.name(`${s}.o${i}`, `a${i}`, true));
  b.next();
  const na0 = b.name(b.op1(NOT, [a0], '¬a0', 'na0'), 'na0', true);
  const na1 = b.name(b.op1(NOT, [a1], '¬a1', 'na1'), 'na1', true);
  const t = b.name(b.op1(NAND, [a2, 'en'], '¬(en·a2)', 't'), 't', true);
  b.next();
  const p = [[na0, na1], [a0, na1], [na0, a1], [a0, a1]].map(([x, y], j) => b.name(b.op1(AND, [x, y], `p${j}`, `p${j}`), `p${j}`, true));
  const q = [b.op1(AND, ['en', t], 'en·¬a2', 'q0'), b.op1(NOT, [t], 'en·a2', 'q1')].map((x, j) => b.name(x, `q${j}`, true));
  b.next();
  const ys = Array.from({ length: 8 }, (_, k) => b.op1(AND, [p[k & 3], q[k >> 2]], `y${k}`, `y${k}`));
  b.next();
  b.wire(b.op1(merger(Array(8).fill(1), 2), ys, undefined, 'my'), 'y');
  const R = b.right;
  return define({
    id: 'rv16_dec3', name: '3→8 decoder (bus)', category: 'routing',
    summary: 'y = en ? 1 << a : 0, predecoded: (a0, a1) into four lines, (a2, en) into two, output k the AND of one of each (30 NANDs, depth 5; eight 4-input ANDs: 51).',
    ports: [bus('a', 3, 'in'), bit('en', 'in'), bus('y', 8, 'out')],
    symbol: { kind: 'box', label: 'DEC 3→8' },
    spec: ([a, en]) => [en ? 1 << a : 0],
    netlist: () => ({ pins: { a: [0, 4], en: [0, 8], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** 16-bit 2:1 bus multiplexer, y = s ? b : a, with one inverter on s shared by every bit: 3n + 1 NANDs. */
export const MUX16: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a', 'b', 's');
  const sa = b.op(splitter(Array(16).fill(1), 2), ['a'], undefined, 'sa');
  const sb = b.op(splitter(Array(16).fill(1), 2), ['b'], undefined, 'sb');
  const ns = b.name(b.op1(NOT, ['s'], '¬s', 'inv'), 'ns', true);
  b.next();
  const t = Array.from({ length: 16 }, (_, i) => [b.op1(NAND, [`${sa}.o${i}`, ns], undefined, `ta${i}`), b.op1(NAND, [`${sb}.o${i}`, 's'], undefined, `tb${i}`)]);
  b.next();
  const ys = t.map(([ta, tb], i) => b.op1(NAND, [ta, tb], `y${i}`, `y${i}`));
  b.next();
  b.wire(b.op1(merger(Array(16).fill(1), 2), ys, undefined, 'my'), 'y');
  const R = b.right;
  return define({
    id: 'rv16_mux16', name: '16-bit 2:1 multiplexer (shared inverter)', category: 'routing',
    summary: 'y = s ? b : a on 16-bit buses: per bit ¬(¬(a·¬s) · ¬(b·s)), three NANDs, and one inverter on s for all sixteen (49 NANDs, not 64).',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), { name: 's', width: 1, dir: 'in', side: 'bottom' }, bus('y', 16, 'out')],
    symbol: { kind: 'mux' },
    spec: ([a, b, s]) => [s ? b : a],
    netlist: () => ({ pins: { a: [0, 16], b: [0, 50], s: [0, 84], y: [R, 34] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The library generators' 2:1 mux choice for campaign references: MUX16 for 16-bit words, the library's otherwise. */
export const RV16_MUX2: Mux2Kind = { tag: '_rv16', of: (w) => (w === 16 ? MUX16 : busMux2(w)) };

const trees = new Map<string, ComponentDef>();
/**
 * 4:1 and 8:1 16-bit bus multiplexers as trees of MUX16 (49 NANDs a node): 147 and 343 NANDs, against the
 * library trees' 192 and 448, at the same depth. Unlocked by g_mux8 with the 2:1, so the parts a learner
 * places cost what they would build. pitch: the data inputs' spacing (the ALU lines its units up at 16).
 */
export function rv16Mux(k: 2 | 3, pitch = 2): ComponentDef {
  const N = 2 ** k, key = `${N}x16${pitch !== 2 ? `_p${pitch}` : ''}`;
  let d = trees.get(key);
  if (!d) {
    d = muxTreeOf(k, pitch, MUX16, `rv16_mux${key}`, `Selects one of ${N} 16-bit inputs: a tree of ${N - 1} shared-inverter 2:1 multiplexers, ${k} levels deep (${49 * (N - 1)} NANDs).`);
    trees.set(key, d);
  }
  return d;
}
export const RV16_MUX4 = rv16Mux(2), RV16_MUX8 = rv16Mux(3);

/**
 * A choice among four 16-bit words by a 2-bit select, built as a learner would: RV16_MUX4 when all four are used,
 * else 2:1 muxes for those that are (null: never selected, or a copy of another input whose select it shares):
 * three inputs on two MUX16 (98 NANDs, not 147), two on one. Inputs '' are wired later through sinks[i]. The select
 * splitter and the first mux are named, so the output mux takes the one numbered id a single mux would (walks name it).
 */
export function choose4(b: Builder, d: (string | null)[], sel: string, label?: string): { y: string; sinks: string[] } {
  const used = [0, 1, 2, 3].filter((i) => d[i] !== null);
  const sinks = ['', '', '', ''];
  if (used.length === 4) {
    const m = b.op(RV16_MUX4, [...(d as string[]), sel], label);
    used.forEach((i) => (sinks[i] = `${m}.d${i}`));
    return { y: `${m}.y`, sinks };
  }
  const k = b.instances.length;
  const s = b.op(splitter([1, 1], 2), [sel], undefined, `sel${k}`);
  if (used.length === 2) {
    const [i, j] = used, bit = (i ^ j) === 1 ? 0 : (i ^ j) === 2 ? 1 : -1;
    if (bit < 0) throw new Error(`choose4: inputs ${i} and ${j} differ in both select bits`);
    const m = b.op(MUX16, [d[i]!, d[j]!, `${s}.o${bit}`], label);
    sinks[i] = `${m}.a`; sinks[j] = `${m}.b`;
    return { y: `${m}.y`, sinks };
  }
  // Three: the pair without the idle input is told apart by bit 0; bit 1 then picks it or the idle one's partner.
  if (used.length !== 3) throw new Error('choose4: no input used');
  const idle = [0, 1, 2, 3].find((i) => d[i] === null)!, lone = idle ^ 1, [p, q] = idle < 2 ? [2, 3] : [0, 1];
  const m1 = b.op(MUX16, [d[p]!, d[q]!, `${s}.o0`], undefined, `pick${k}`);
  sinks[p] = `${m1}.a`; sinks[q] = `${m1}.b`;
  const m2 = b.op(MUX16, lone < 2 ? [d[lone]!, `${m1}.y`, `${s}.o1`] : [`${m1}.y`, d[lone]!, `${s}.o1`], label);
  sinks[lone] = `${m2}.${lone < 2 ? 'a' : 'b'}`;
  return { y: `${m2}.y`, sinks };
}

/** The 16-bit barrel shifter on MUX16 (shifter(16) otherwise): six 2:1 muxes at 49 NANDs, not 64. */
export const RV16_SHIFT16 = shifterOf(MUX16, 'rv16_shift16', '16-bit barrel shifter (RV16)');

/** The 16-bit ALU with RV16_SHIFT16 and its result picked by RV16_MUX8's tree (alu(16) otherwise). */
export const RV16_ALU16 = aluOf(16, 'rca', rv16Mux(3, 16), RV16_SHIFT16, 'rv16_alu16', '16-bit ALU (RV16)');
export const RV16_ALU16KS = aluOf(16, 'ks', rv16Mux(3, 16), RV16_SHIFT16, 'rv16_alu16ks', '16-bit ALU (RV16, Kogge–Stone)');

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

/** 16-bit incrementer: bit 0 is ¬a0 and carries a0 on; half adders do the other fifteen bits. */
export const INC16: ComponentDef = (() => {
  const P = 8, X = 10, Y0 = 4, n = 16;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(Array(n).fill(1), P), at: [5, Y0 + 2 - P / 2] },
    { name: 'my', def: merger(Array(n).fill(1), P), at: [20, Y0 + 2 - P / 2] },
    { name: 'n0', def: NOT, at: [X, Y0 + 1], label: '¬a0' },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] },
    { name: 'y', ends: ['my.out', 'y'] },
    { name: 'a0', ends: ['sa.o0', 'n0.a', 'ha1.b'], via: { 'ha1.b': [[X - 2, Y0 + 2], [X - 2, Y0 + 5], [X + 3, Y0 + 5]] } },
    { name: 'y0', ends: ['n0.y', 'my.i0'] },
  ];
  for (let i = 1; i < n; i++) {
    instances.push({ name: `ha${i}`, def: HALF_ADDER, at: [X, Y0 + P * i] });
    nets.push({ name: `a${i}`, ends: [`sa.o${i}`, `ha${i}.a`] });
    nets.push({ name: `y${i}`, ends: [`ha${i}.s`, `my.i${i}`] });
    nets.push({ name: `c${i + 1}`, ends: [`ha${i}.c`, i < n - 1 ? `ha${i + 1}.b` : 'cout'] });
  }
  const mid = Y0 + 2 - P / 2 + (P * n) / 2;
  return define({
    id: 'rv16_inc16', name: '16-bit incrementer (RV16)', category: 'arithmetic',
    summary: '{cout, y} = a + 1. Bit 0 of a + 1 is ¬a0 and its carry is a0 itself, so one inverter replaces the first half adder (76 NANDs, depth 31).',
    ports: [bus('a', 16, 'in'), bus('y', 16, 'out'), bit('cout', 'out')],
    symbol: { kind: 'box', label: '+1' },
    spec: ([a]) => [(a + 1) & 0xffff, a === 0xffff ? 1 : 0],
    netlist: () => ({ pins: { a: [1, mid], y: [25, mid], cout: [X + 3, Y0 + P * n + 1] }, pinDirs: { cout: 'up' }, instances, nets }),
  });
})();

/** Signed and unsigned less-than from one subtraction, a + ¬b + 1, of which only the carry is read. */
export const CMP16: ComponentDef = (() => {
  const b = new Builder(8, 12, 2);
  b.pins('a', 'b');
  const one = b.op1(TIE1, []);
  const sb = b.op(splitter(Array(16).fill(1), 2), ['b']);
  b.next();
  const nb = Array.from({ length: 16 }, (_, i) => b.op1(NOT, [`${sb}.o${i}`]));
  b.next();
  const d = b.op(ADD16, ['a', b.op1(merger(Array(16).fill(1), 2), nb, '¬b'), one], 'a + ¬b + 1');
  const sa = b.op(splitter([15, 1], 2), ['a'], 'sign of a');
  const sbs = b.op(splitter([15, 1], 2), ['b'], 'sign of b');
  b.next();
  const ltu = b.name(b.op1(NOT, [`${d}.cout`], 'no carry'), 'ltu', true);
  const differ = b.name(b.op1(XOR, [`${sa}.o1`, `${sbs}.o1`], 'signs differ'), 'differ', true);
  b.next();
  // lt = differ ? a15 : ltu, as NANDs (the mux part is not unlocked yet at this level).
  const t1 = b.op1(NAND, [differ, `${sa}.o1`]), t2 = b.op1(NAND, [b.op1(NOT, [differ]), ltu]);
  b.next();
  b.wire(b.op1(NAND, [t1, t2], 'lt'), 'lt');
  b.wire(ltu, 'ltu');
  const R = b.right;
  return define({
    id: 'rv16_cmp16', name: 'Less-than (16-bit, signed and unsigned)', category: 'arithmetic',
    summary: 'From a + ¬b + 1: unsigned a < b ⇔ no carry out. Signed: if the signs differ, a < b ⇔ a is negative; if they agree the difference cannot overflow and the unsigned answer holds. Only the carry is read, so ¬b needs inverters, not XORs.',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bit('lt', 'out'), bit('ltu', 'out')],
    symbol: { kind: 'box', label: 'A < B' },
    spec: ([a, b]) => [((a << 16) >> 16) < ((b << 16) >> 16) ? 1 : 0, a < b ? 1 : 0],
    netlist: () => ({ pins: { a: [0, 6], b: [0, 10], lt: [R, 6], ltu: [R, 10] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- storage at the learner's cost: what s_dlatch … s_reg16 build, so the parts they unlock
// (and every later reference) cost what the levels' pars count. The library's D latch has an
// explicit inverter on d (5 NANDs, so 11 per flip-flop and 15 per enable flip-flop).

const clkIn = (name = 'clk'): PortDef => ({ name, width: 1, dir: 'in', clock: true });

/** D latch from 4 NANDs: the second gate takes the first one's output in place of ¬d. */
export const RV16_DLATCH: ComponentDef = define({
  id: 'rv16_dlatch', name: 'D latch (4 NANDs)', category: 'sequential',
  summary: 'Transparent while e = 1, holding while e = 0. s_n = ¬(d·e) sets the SR latch; r_n = ¬(s_n·e) resets it, since with e = 1 s_n is ¬d: no inverter needed.',
  ports: [bit('d', 'in'), bit('e', 'in'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'D latch' },
  netlist: () => ({
    pins: { d: [1, 3], e: [1, 12], q: [32, 4] },
    instances: [
      { name: 'g1', def: NAND, at: [8, 2] },
      { name: 'g2', def: NAND, at: [8, 8] },
      { name: 'sr', def: SR_LATCH, at: [16, 2] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'g1.a'] },
      { name: 'e', ends: ['e', 'g1.b', 'g2.b'], trunk: 7 },
      { name: 's_n', ends: ['g1.y', 'sr.s_n', 'g2.a'], via: { 'g2.a': [[13, 4], [13, 7], [6, 7], [6, 9]] } },
      { name: 'r_n', ends: ['g2.y', 'sr.r_n'], trunk: 14.5 },
      { name: 'q', ends: ['sr.q', 'q'] },
    ],
  }),
});

/** Positive-edge master–slave D flip-flop: 9 NANDs. */
export const RV16_DFF: ComponentDef = define({
  id: 'rv16_dff', name: 'D flip-flop (9 NANDs)', category: 'sequential',
  summary: 'Samples d at the rising edge of clk: the master latch is open while clk = 0, the slave while clk = 1, never both. Two 4-NAND latches and an inverter.',
  ports: [bit('d', 'in'), clkIn(), bit('q', 'out')],
  symbol: { kind: 'box', label: 'DFF' },
  ff: { d: 'd', q: 'q', clk: 'clk' },
  netlist: () => ({
    pins: { d: [1, 4], clk: [1, 12], q: [37, 6] },
    instances: [
      { name: 'inv', def: NOT, at: [3, 11] },
      { name: 'master', def: RV16_DLATCH, at: [9, 2] },
      { name: 'slave', def: RV16_DLATCH, at: [23, 3] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'master.d'] },
      { name: 'clk', ends: ['clk', 'inv.a', 'slave.e'], via: { 'slave.e': [[2, 12], [2, 14], [21, 14], [21, 7]] } },
      { name: 'clk_n', ends: ['inv.y', 'master.e'], trunk: 7.5 },
      { name: 'm', ends: ['master.q', 'slave.d'] },
      { name: 'q', ends: ['slave.q', 'q'] },
    ],
  }),
});

/** D flip-flop with enable: a mux feeds q back while en = 0 (13 NANDs). */
export const RV16_DFFE: ComponentDef = define({
  id: 'rv16_dffe', name: 'D flip-flop with enable (13 NANDs)', category: 'sequential',
  summary: 'Loads d at the rising edge only when en = 1; otherwise the mux feeds q back. The clock itself is never gated.',
  ports: [bit('d', 'in'), bit('en', 'in'), clkIn(), bit('q', 'out')],
  symbol: { kind: 'box', label: 'DFFE' },
  ff: { d: 'd', q: 'q', clk: 'clk', en: 'en' },
  netlist: () => ({
    pins: { d: [1, 5], en: [1, 9], clk: [1, 11], q: [27, 5] },
    instances: [
      { name: 'mux', def: MUX2, at: [5, 1] },
      { name: 'ff', def: RV16_DFF, at: [13, 2] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'mux.b'] },
      { name: 'en', ends: ['en', 'mux.s'], via: { 'mux.s': [[7, 9]] } },
      { name: 'clk', ends: ['clk', 'ff.clk'], via: { 'ff.clk': [[11, 11], [11, 6]] } },
      { name: 'next', ends: ['mux.y', 'ff.d'] },
      { name: 'q', ends: ['ff.q', 'q', 'mux.a'], via: { 'mux.a': [[23, 5], [23, 0], [3, 0], [3, 3]] } },
    ],
  }),
});

/** n cells (enable flip-flops, or registers cw bits wide) side by side on one bus, sharing en and clk. */
function regOf(n: number, cell: ComponentDef, cw: number, id: string, name: string, summary: string): ComponentDef {
  const b = new Builder(8, 10, 2);
  b.pins('d', 'en', 'clk');
  const s = b.op(splitter(Array(n).fill(cw), 2), ['d']);
  b.next();
  const qs = Array.from({ length: n }, (_, i) => b.op1(cell, [`${s}.o${i}`, 'en', 'clk'], cw === 1 ? `bit ${i}` : `bits ${cw * i + cw - 1}…${cw * i}`));
  b.next();
  b.wire(b.op1(merger(Array(n).fill(cw), 2), qs), 'q');
  const R = b.right, w = n * cw;
  return define({
    id, name, category: 'sequential', summary,
    ports: [bus('d', w, 'in'), bit('en', 'in'), clkIn(), bus('q', w, 'out')],
    symbol: { kind: 'box', label: `REG${w}` },
    netlist: () => ({ pins: { d: [0, 6], en: [0, 10], clk: [0, 14], q: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
}

export const RV16_REG4 = regOf(4, RV16_DFFE, 1, 'rv16_reg4', '4-bit register (52 NANDs)', 'Four enable flip-flops sharing en and clk: q ← d at the rising edge when en = 1, else hold.');
export const RV16_REG16 = regOf(4, RV16_REG4, 4, 'rv16_reg16', '16-bit register (208 NANDs)', 'Four 4-bit registers sharing en and clk: q ← d at the rising edge when en = 1, else hold.');

/** 16 flip-flops without an enable: a register that loads at every edge (144 NANDs). */
export const RV16_DREG16: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('d', 'clk');
  const s = b.op(splitter(Array(16).fill(1), 2), ['d']);
  b.next();
  const qs = Array.from({ length: 16 }, (_, i) => b.op1(RV16_DFF, [`${s}.o${i}`, 'clk'], `bit ${i}`));
  b.next();
  b.wire(b.op1(merger(Array(16).fill(1), 2), qs), 'q');
  const R = b.right;
  return define({
    id: 'rv16_dreg16', name: '16-bit register, no enable (144 NANDs)', category: 'sequential',
    summary: 'Sixteen flip-flops on one clock: q ← d at every rising edge. For a register whose next value is always chosen in front of it (the PC), enable muxes would do nothing.',
    ports: [bus('d', 16, 'in'), clkIn(), bus('q', 16, 'out')],
    symbol: { kind: 'box', label: 'REG16' },
    netlist: () => ({ pins: { d: [0, 6], clk: [0, 10], q: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The program counter: 0 on reset, d on load, else pc + 1. */
export const PC16: ComponentDef = (() => {
  const b = new Builder(8, 12, 4);
  b.pins('rst', 'ld', 'd', 'clk');
  const zero = b.op1(constWord(16, 0), []);
  b.next();
  const inc = b.op(INC16, [''], 'pc + 1');
  b.next();
  const m1 = b.op1(MUX16, [`${inc}.y`, 'd', 'ld'], 'load?');
  b.next();
  const m2 = b.op1(MUX16, [m1, zero, 'rst'], 'reset?');
  b.next();
  const r = b.op(RV16_DREG16, [m2, 'clk'], 'PC');
  const pc = b.name(`${r}.q`, 'pc', true);
  b.wire(pc, `${inc}.a`);
  b.wire(pc, 'pc');
  const R = b.right;
  return define({
    id: 'rv16_pc', name: 'Program counter (16-bit)', category: 'sequential',
    summary: 'pc ← rst ? 0 : ld ? d : pc + 1 at every rising edge: sixteen flip-flops (the PC loads every cycle, so no enable), an incrementer and two bus multiplexers.',
    ports: [bit('rst', 'in'), bit('ld', 'in'), bus('d', 16, 'in'), clkIn(), bus('pc', 16, 'out')],
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
  for (let i = 1; i < 8; i++) qs.push(b.name(`${b.op(RV16_REG16, ['wd', `${en}.o${i}`, 'clk'], `x${i}`)}.q`, `x${i}`, true));
  b.next();
  const mux = RV16_MUX8;
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
  // Instances are named: DET101_FSM's arcs light them (n0 for the arcs into S1, n1 for S1 → S2, yg for the output).
  const nx = b.name(b.op1(NOT, ['x'], '¬x', 'inv_x'), 'nx', true);
  const nr = b.name(b.op1(NOT, ['rst'], '¬rst', 'inv_rst'), 'nrst', true);
  b.next();
  // States: S0 = 00, S1 (saw 1) = 01, S2 (saw 10) = 10. n0 = x·¬rst; n1 = ¬x·s0·¬rst; y = x·s1.
  const g0 = b.op1(NAND, ['x', nr], undefined, 'g0');
  const g1 = b.op1(NAND, [nx, nr], undefined, 'g1');
  b.next();
  const n0 = b.op1(NOT, [g0], 'n0', 'n0');
  const h1 = b.op1(NOT, [g1], undefined, 'h1');
  b.next();
  const k1 = b.op1(NAND, [h1, ''], undefined, 'k1');
  b.next();
  const n1 = b.op1(NOT, [k1], 'n1', 'n1');
  b.next();
  const f0 = b.op(RV16_DFF, [n0, 'clk'], 's0', 's0');
  const f1 = b.op(RV16_DFF, [n1, 'clk'], 's1', 's1');
  const s0 = b.name(`${f0}.q`, 's0', true), s1 = b.name(`${f1}.q`, 's1', true);
  b.wire(s0, `${k1.split('.')[0]}.b`);
  b.next();
  const yn = b.op1(NAND, ['x', s1], undefined, 'yn');
  b.next();
  b.wire(b.op1(NOT, [yn], 'x·s1', 'yg'), 'y');
  const R = b.right;
  return define({
    id: 'rv16_det101', name: '"101" detector (state machine)', category: 'sequential',
    summary: 'A Mealy machine: two flip-flops hold the state (nothing, saw 1, saw 10); y = 1 when x = 1 completes 1-0-1. Synchronous reset.',
    ports: [bit('x', 'in'), bit('rst', 'in'), { name: 'clk', width: 1, dir: 'in', clock: true }, bit('y', 'out')],
    symbol: { kind: 'box', label: '101?' },
    netlist: () => ({ pins: { ...pinsAt(['x', 'rst', 'clk'], 0), y: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** DET101 as a state machine (Mealy: arc labels x / y), drawn 400 × 200. */
export const DET101_FSM: FsmSpec = (() => {
  const x0 = 90, dx = 120, y = 108;
  const x = (v: number) => (inp: FsmInputs) => inp.x === v;
  const into1 = ['g0', 'n0'], to2 = ['g1', 'h1', 'k1', 'n1'];
  return {
    title: '"101" detector', shape: 'circle', size: [400, 200],
    states: [
      { name: 'S0', code: 0, does: 'Nothing useful seen yet.', at: [x0, y] },
      { name: 'S1', code: 1, does: 'The last input was 1.', at: [x0 + dx, y] },
      { name: 'S2', code: 2, does: 'The last two inputs were 1, 0: a 1 now completes the pattern.', at: [x0 + 2 * dx, y] },
    ],
    arcs: [
      { from: 0, to: 0, when: x(0), label: '0/0', loop: -90 },
      { from: 0, to: 1, when: x(1), label: '1/0', bend: 22, parts: into1 },
      { from: 1, to: 1, when: x(1), label: '1/0', loop: -90, parts: into1 },
      { from: 1, to: 2, when: x(0), label: '0/0', bend: 22, parts: to2 },
      { from: 2, to: 1, when: x(1), label: '1/1', bend: 22, out: { y: 1 }, parts: [...into1, 'yn', 'yg'] },
      { from: 2, to: 0, when: x(0), label: '0/0', bend: -70 },
    ],
    reset: 0, inputs: ['x', 'rst'], outputs: ['y'], resetIn: { rst: 1 },
    stateBits: ['s0.q', 's1.q'], codeBits: 2, entry: [x0 - 72, y],
  };
})();
