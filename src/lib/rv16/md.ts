// The MD opcode's units (Act 8): a multiplier for mul / mulh / mulhsu / mulhu, made from one
// unsigned array multiplier and two sign corrections, and a divider for div / divu / rem / remu,
// made from the iterative unsigned divider with signs taken off before and put back after.

import type { ComponentDef, PortDef } from '../../sim/types';
import { constWord, isZero } from '../alu';
import { Builder } from '../builder';
import { addSub, busMux2 } from '../combinational';
import { define, splitter } from '../define';
import { AND, NOT, OR, XOR } from '../gates';
import { arrayMul, seqDivider } from '../muldiv';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);

/** The MD result for f3 (0…7), as RISC-V defines it at 16 bits. */
export function mdResult(f3: number, a: number, b: number): number {
  const sa = s16(a), sb = s16(b);
  switch (f3 & 7) {
    case 0: return Math.imul(a, b) & 0xffff;
    case 1: return ((sa * sb) >> 16) & 0xffff;
    case 2: return ((sa * b) >> 16) & 0xffff;
    case 3: return ((a * b) >>> 16) & 0xffff;
    case 4: return (b === 0 ? -1 : sa === -32768 && sb === -1 ? sa : Math.trunc(sa / sb)) & 0xffff;
    case 5: return b === 0 ? 0xffff : Math.floor(a / b);
    case 6: return (b === 0 ? sa : sa === -32768 && sb === -1 ? 0 : sa % sb) & 0xffff;
    default: return b === 0 ? a : a % b;
  }
}

/**
 * mul / mulh / mulhsu / mulhu (f3 = 0…3). The unsigned product's high half needs correcting for a
 * signed operand: a negative a is worth a − 2^16, so a signed × b loses b · 2^16, i.e. b from the
 * high half (and likewise a when b is signed). The low half is the same either way.
 */
export const MUL16: ComponentDef = (() => {
  const b = new Builder(10, 16, 6);
  b.pins('a', 'b', 'f3');
  const p = b.op(arrayMul(16), ['a', 'b'], '16 × 16 (unsigned)');
  const sa = b.op(splitter([15, 1], 4), ['a']), sb = b.op(splitter([15, 1], 4), ['b']);
  const f = b.op(splitter([1, 1], 2), ['f3']);
  const z = b.name(b.op1(constWord(16, 0), []), 'z16', true);
  b.next();
  const ph = b.op(splitter([16, 16], 8), [`${p}.p`], 'lo, hi');
  const signedA = b.op1(XOR, [`${f}.o0`, `${f}.o1`], 'a signed? (mulh, mulhsu)');
  const nf1 = b.op1(NOT, [`${f}.o1`]);
  b.next();
  const corrA = b.op1(AND, [`${sa}.o1`, signedA], 'a < 0');
  const signedB = b.op1(AND, [`${f}.o0`, nf1], 'b signed? (mulh)');
  b.next();
  const corrB = b.op1(AND, [`${sb}.o1`, signedB], 'b < 0');
  const mb = b.op1(busMux2(16), [z, 'b', corrA], 'b or 0');
  b.next();
  const ma = b.op1(busMux2(16), [z, 'a', corrB], 'a or 0');
  const h1 = b.op(addSub(16), [`${ph}.o1`, mb, b.op1(constWord(1, 1), [])], 'hi − b');
  b.next();
  const h2 = b.op(addSub(16), [`${h1}.s`, ma, b.op1(constWord(1, 1), [])], '− a');
  const high = b.op1(OR, [`${f}.o0`, `${f}.o1`], 'high half?');
  b.next();
  b.wire(b.op1(busMux2(16), [`${ph}.o0`, `${h2}.s`, high], 'result'), 'y');
  const R = b.right;
  return define({
    id: 'rv16_mul', name: 'MD multiplier (RV16)', category: 'arithmetic',
    summary: 'mul, mulh, mulhsu, mulhu: one unsigned 16 × 16 array multiplier; the high half is corrected for signed operands by subtracting b when a < 0 and a when b < 0 (as signed).',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bus('f3', 2, 'in'), bus('y', 16, 'out')],
    symbol: { kind: 'box', label: 'MUL' },
    spec: ([a, bb, f3]) => [mdResult(f3, a, bb)],
    netlist: () => ({ pins: { a: [0, 4], b: [0, 8], f3: [0, 12], y: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * div / divu / rem / remu (f3[1:0] = 0…3: bit 0 unsigned, bit 1 remainder). start (while idle)
 * loads |a| and |b| into the unsigned iterative divider; when done the quotient takes the sign
 * a XOR b (unless b = 0: −1 stays −1) and the remainder the sign of a. RISC-V's special cases fall
 * out: b = 0 gives q = all ones, r = a; −32768 / −1 overflows back to −32768, r = 0.
 */
export const DIV16: ComponentDef = (() => {
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'start', 'a', 'b', 'f3');
  const f = b.op(splitter([1, 1], 2), ['f3']);
  const sa = b.op(splitter([15, 1], 4), ['a']), sb = b.op(splitter([15, 1], 4), ['b']);
  const z = b.name(b.op1(constWord(16, 0), []), 'z16', true);
  b.next();
  const signed = b.op1(NOT, [`${f}.o0`], 'signed?');
  const bz = b.op1(isZero(16), ['b'], 'b = 0');
  b.next();
  const na = b.name(b.op1(AND, [`${sa}.o1`, signed], 'a < 0'), 'na', true);
  const nb = b.op1(AND, [`${sb}.o1`, signed], 'b < 0');
  b.next();
  const ua = b.op(addSub(16), [z, 'a', na], '|a|');
  const ub = b.op(addSub(16), [z, 'b', nb], '|b|');
  const nq0 = b.op1(XOR, [na, nb]);
  b.next();
  const dv = b.op(seqDivider(16), ['clk', 'start', `${ua}.s`, `${ub}.s`], 'unsigned divider');
  const nq = b.op1(AND, [nq0, b.op1(NOT, [bz])], 'negate q?');
  b.next();
  const q = b.op(addSub(16), [z, `${dv}.q`, nq], '± q');
  const r = b.op(addSub(16), [z, `${dv}.r`, na], '± r');
  b.next();
  b.wire(b.op1(busMux2(16), [`${q}.s`, `${r}.s`, `${f}.o1`], 'q or r'), 'y');
  b.wire(`${dv}.done`, 'done');
  const R = b.right;
  return define({
    id: 'rv16_div', name: 'MD divider (RV16)', category: 'sequential',
    summary: 'div, divu, rem, remu: signs off (|a|, |b|), the iterative unsigned divider (18 cycles), signs back on. start loads it while idle; done rises for one cycle with y valid.',
    ports: [bit('clk', 'in'), bit('start', 'in'), bus('a', 16, 'in'), bus('b', 16, 'in'), bus('f3', 2, 'in'), bus('y', 16, 'out'), bit('done', 'out')],
    symbol: { kind: 'box', label: 'DIV' },
    netlist: () => ({ pins: { clk: [0, 4], start: [0, 8], a: [0, 12], b: [0, 16], f3: [0, 20], y: [R, 8], done: [R, 12] }, instances: b.instances, nets: b.nets() }),
  });
})();
