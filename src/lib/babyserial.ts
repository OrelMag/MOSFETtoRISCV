// Appendix E: the 1948 serial subtractor. The Baby's accumulator took one digit of each operand at a time, least
// significant digit first, as the words came round the tubes; the subtractor was a single full-adder stage with a flip-flop
// holding the carry from one digit to the next. Subtraction is a + ¬b + 1 as everywhere: the 1 is the carry into digit 0.
// The digit period was 8.5 µs (Kilburn, report of December 1947, §5.4), 32 digits a word: 272 µs of a 306 µs beat (the
// other four digit times are the fly-back, lib/baby.ts BEAT_US). The word-wide accumulator (lib/baby.ts BABY_ACC) uses
// addSub(32) and does all 32 digits in one clock; tests/babyserial.test.ts holds this circuit to it on random words.
//   SERIAL_STAGE   one digit per clock: not b, carry in = first OR carry flip-flop, a full adder, the carry flip-flop
//   BABY_SERIAL    32 digits: A and B parallel-loaded into shift registers (shiftRegister(32)), the stage, the result
//                  shifted into a register of 32 enabled flip-flops; load = 1 for one clock, then run = 1 for 32 clocks

import { Builder } from './builder';
import { constWord } from './alu';
import { FULL_ADDER } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { laid } from './layered';
import { DFF, DFFE } from './sequential';
import { shiftRegister } from './seqparts';
import type { ComponentDef, PortDef } from '../sim/types';

/** Digits in a word, and so clocks to subtract one. */
export const SERIAL_DIGITS = 32;

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });

/**
 * One digit of a − b per clock. `first` = 1 during digit 0 forces the carry in to 1 (the +1 of two's complement); after
 * that the carry comes from the flip-flop, which takes the full adder's carry out on every clock with en = 1.
 * s is the difference digit for the digit now at a and b; c is the carry flip-flop (1: no borrow so far).
 */
export const SERIAL_STAGE: ComponentDef = (() => {
  const b = new Builder(8, 12, 3);
  b.pins('a', 'b', 'first', 'en', 'clk');
  const nb = b.op1(NOT, ['b'], undefined, 'nb');
  b.next();
  const cin = b.op1(OR, ['first', ''], 'first | carry', 'cin');
  b.next();
  const fa = b.op(FULL_ADDER, ['a', nb, cin], undefined, 'fa');
  b.next();
  const cff = b.op1(DFFE, [`${fa}.cout`, 'en', 'clk'], 'carry', 'carry');
  b.wire(cff, 'cin.b');
  b.wire(`${fa}.s`, 's'); b.wire(cff, 'c');
  return define({
    id: 'serial_stage', name: 'Serial subtractor stage', category: 'arithmetic',
    summary: 'One full adder and a carry flip-flop: a − b one digit a clock, least significant digit first. first = 1 on digit 0 supplies the +1 of a + ¬b + 1.',
    ports: [bit('a', 'in'), bit('b', 'in'), bit('first', 'in'), bit('en', 'in'), bit('clk', 'in', 'bottom', true), bit('s', 'out'), bit('c', 'out')],
    symbol: { kind: 'box', label: 'SERIAL −' },
    netlist: laid(b, { keepOrder: true }),
  });
})();

/**
 * The 32-digit serial subtractor. load = 1 for one clock puts a and b in their shift registers and arms `first`; then run = 1
 * for 32 clocks (it may pause: the carry and the registers wait) shifts the digits through the stage and the result in at
 * the top of a 32-flip-flop register, which holds a − b (mod 2^32) after the 32nd clock. r is that register.
 */
export const BABY_SERIAL: ComponentDef = (() => {
  const W = SERIAL_DIGITS, b = new Builder(8, 12, 3);
  b.pins('a', 'b', 'load', 'run', 'clk');
  const zero = b.op1(constWord(1, 0), [], '0', 'zero');
  const m0 = b.op1(OR, ['load', 'run'], undefined, 'm0');
  const mode = b.op1(merger([1, 1]), [m0, 'load'], undefined, 'mode');
  const nrun = b.op1(NOT, ['run'], undefined, 'nrun');
  b.next();
  const sa = b.op(shiftRegister(W), [mode, zero, zero, 'a', 'clk'], 'A', 'sa');
  const sb = b.op(shiftRegister(W), [mode, zero, zero, 'b', 'clk'], 'B', 'sb');
  const keep = b.op1(AND, ['', nrun], undefined, 'keep'); // first stays 1 until a digit has been taken
  const first = b.op1(OR, ['load', keep], undefined, 'next first');
  b.next();
  const da = b.op(splitter([1, W - 1]), [`${sa}.q`], undefined, 'da');
  const db = b.op(splitter([1, W - 1]), [`${sb}.q`], undefined, 'db');
  const ff = b.op1(DFF, [first, 'clk'], 'first digit', 'ffirst');
  b.next();
  const stage = b.op(SERIAL_STAGE, [`${da}.o0`, `${db}.o0`, ff, 'run', 'clk'], 'one digit', 'st');
  b.wire(ff, 'keep.a');
  b.next();
  const rs: string[] = [];
  for (let i = W - 1; i >= 0; i--) {
    const f = b.op1(DFFE, [i === W - 1 ? `${stage}.s` : rs[0], 'run', 'clk'], undefined, `r${i}`);
    rs.unshift(f);
  }
  const mr = b.op(merger(ones(W)), rs, undefined, 'mr');
  b.wire(`${mr}.out`, 'r');
  b.wire(`${stage}.c`, 'carry');
  return define({
    id: 'baby_serial', name: 'Serial subtractor (1948)', category: 'arithmetic',
    summary: 'The Baby\'s subtractor as the 1948 machine had it: a and b shifted through one full-adder stage a digit per clock, a carry flip-flop between digits, the difference shifted into a register. 32 clocks a word (8.5 µs each in 1948).',
    ports: [{ name: 'a', width: W, dir: 'in' }, { name: 'b', width: W, dir: 'in' }, bit('load', 'in'), bit('run', 'in'), bit('clk', 'in', 'bottom', true),
      { name: 'r', width: W, dir: 'out' }, bit('carry', 'out')],
    symbol: { kind: 'box', label: 'SERIAL SUB' },
    netlist: laid(b, { keepOrder: true, wires: Object.fromEntries(rs.map((_, i) => [`r${i}.q`, true])) }),
  });
})();
