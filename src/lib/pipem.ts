// The M extension for the pipelined CPU: a multiplier split across E and M (partial products and the
// 3:2 tree in E, the final carry-propagate addition in M) and a divide unit that stalls the pipeline
// while the radix-4 SRT divider iterates in E.

import type { ComponentDef, PortDef } from '../sim/types';
import { isZero } from './alu';
import { Builder } from './builder';
import { busMux2 } from './combinational';
import { define, merger, splitter } from './define';
import { koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR, XOR } from './gates';
import { boothTree } from './multiply';
import { condNegate } from './muldiv';
import { srt4Divider } from './srt4';
import { TIE0 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

/**
 * Multiply, E-stage half: extend both operands to 34 bits (sign or zero, as funct3 says: mul / mulh
 * signed × signed, mulhsu signed × unsigned, mulhu unsigned × unsigned), then Booth digits, rows and
 * the 3:2 tree. Out come two 64-bit words whose sum is the product.
 */
export const MUL_E: ComponentDef = (() => {
  const b = new Builder(16, 12);
  b.pins('a', 'b', 'f');
  const sa = b.op(splitter([31, 1]), ['a']);
  const sb = b.op(splitter([31, 1]), ['b']);
  const sf = b.op(splitter([1, 1]), ['f']);
  b.next();
  // a is signed unless mulhu (f = 11); b is signed only for mul and mulh (f[1] = 0)
  const sgA = b.op1(NOT, [b.op1(AND, [`${sf}.o0`, `${sf}.o1`])], 'a signed?');
  const sgB = b.op1(NOT, [`${sf}.o1`], 'b signed?');
  b.next();
  const xa = b.op1(AND, [sgA, `${sa}.o1`]), xb = b.op1(AND, [sgB, `${sb}.o1`]);
  b.next();
  const a34 = b.op1(merger([32, 1, 1]), ['a', xa, xa], 'a, 34 bits');
  const b34 = b.op1(merger([32, 1, 1]), ['b', xb, xb], 'b, 34 bits');
  b.next();
  const t = b.op(boothTree(34), [a34, b34], 'Booth rows and 3:2 tree');
  b.next();
  b.wire(`${b.op(splitter([64, 4]), [`${t}.s`])}.o0`, 's');
  b.wire(`${b.op(splitter([64, 4]), [`${t}.c`])}.o0`, 'c');
  const R = b.right;
  return define({
    id: 'mule', name: 'Multiplier, E-stage half', category: 'cpu',
    summary: 'Sign- or zero-extends the operands to 34 bits (funct3 says which), then the radix-4 Booth partial products and the 3:2 tree reduce them to two 64-bit words. Their sum, formed in M, is the product.',
    ports: [bus('a', 32, 'in'), bus('b', 32, 'in'), bus('f', 2, 'in'), bus('s', 64, 'out'), bus('c', 64, 'out')],
    symbol: { kind: 'box', label: 'MUL (E)' },
    netlist: () => ({ pins: { a: [0, 4], b: [0, 8], f: [0, 12], s: [R, 4], c: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Multiply, M-stage half: the 64-bit carry-propagate addition, then the low word (mul) or the high word. */
export const MUL_M: ComponentDef = (() => {
  const b = new Builder(16, 12);
  b.pins('s', 'c', 'f');
  const sum = b.op(koggeStone(64), ['s', 'c', b.op1(TIE0, [])], 'final adder');
  const sf = b.op(splitter([1, 1]), ['f']);
  b.next();
  const hl = b.op(splitter([32, 32]), [`${sum}.s`]);
  const high = b.op1(OR, [`${sf}.o0`, `${sf}.o1`], 'high word?');
  b.next();
  b.wire(b.op1(busMux2(32), [`${hl}.o0`, `${hl}.o1`, high], 'lo / hi'), 'y');
  const R = b.right;
  return define({
    id: 'mulm', name: 'Multiplier, M-stage half', category: 'cpu',
    summary: 'Adds the two words left by the E-stage tree (a 64-bit Kogge–Stone adder) and keeps the low word for mul, the high word for mulh, mulhsu and mulhu.',
    ports: [bus('s', 64, 'in'), bus('c', 64, 'in'), bus('f', 2, 'in'), bus('y', 32, 'out')],
    symbol: { kind: 'box', label: 'MUL (M)' },
    netlist: () => ({ pins: { s: [0, 4], c: [0, 8], f: [0, 12], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Divide unit for the E stage: strips the signs, runs the radix-4 SRT divider (19 cycles), and puts
 * the sign back, with RISC-V's rules for division by zero and overflow. While go = 1 and the divider is
 * not done, stall = 1 and the pipeline holds the instruction in E.
 */
export const DIV_E: ComponentDef = (() => {
  const b = new Builder(16, 12);
  b.pins('clk', 'go', 'a', 'b', 'f');
  const sa = b.op(splitter([31, 1]), ['a']);
  const sb = b.op(splitter([31, 1]), ['b']);
  const sf = b.op(splitter([1, 1]), ['f']);
  b.next();
  // f[0] = 1: unsigned (divu, remu); f[1] = 1: remainder (rem, remu)
  const sgn = b.op1(NOT, [`${sf}.o0`], 'signed?');
  b.next();
  const negA = b.name(b.op1(AND, [sgn, `${sa}.o1`]), 'negA', true);
  const negB = b.name(b.op1(AND, [sgn, `${sb}.o1`]), 'negB', true);
  b.next();
  const ma = b.op1(condNegate(32), ['a', negA], '|a|');
  const mb = b.op1(condNegate(32), ['b', negB], '|b|');
  b.next();
  const dv = b.op(srt4Divider(32), ['clk', '', ma, mb], 'radix-4 SRT divider');
  const busy = b.name(`${dv}.busy`, 'busy', true), done = b.name(`${dv}.done`, 'done', true);
  b.wire(b.op1(AND, ['go', b.op1(NOT, [busy])], 'start'), `${dv}.start`);
  b.next();
  const qr = b.op1(busMux2(32), [`${dv}.q`, `${dv}.r`, `${sf}.o1`], 'q / r');
  // the quotient is negative when the signs differ (unless b = 0); the remainder takes the dividend's sign
  const bnz = b.op1(NOT, [b.op1(isZero(32), ['b'], 'b = 0')]);
  const negQ = b.op1(AND, [b.op1(XOR, [negA, negB]), bnz]);
  const neg = b.op1(MUX2, [negQ, negA, `${sf}.o1`], 'negate?');
  b.next();
  b.wire(b.op1(condNegate(32), [qr, neg], 'sign fix'), 'y');
  b.wire(b.op1(AND, ['go', b.op1(NOT, [done])], 'stall'), 'stall');
  const R = b.right;
  return define({
    id: 'dive', name: 'Divide unit (E stage)', category: 'cpu',
    summary: 'div, divu, rem, remu: magnitudes into the radix-4 SRT divider (19 cycles), sign fixed on the way out; division by zero gives −1 and the dividend, −2³¹ / −1 gives −2³¹ and 0, both falling out of the hardware. stall holds the pipeline until done.',
    ports: [bit('clk', 'in', 'bottom', true), bit('go', 'in'), bus('a', 32, 'in'), bus('b', 32, 'in'), bus('f', 2, 'in'), bus('y', 32, 'out'), bit('stall', 'out')],
    symbol: { kind: 'box', label: 'DIV (E)' },
    netlist: () => ({ pins: { clk: [0, 24], go: [0, 4], a: [0, 8], b: [0, 12], f: [0, 16], y: [R, 4], stall: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

