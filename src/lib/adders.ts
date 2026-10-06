// More adders: carry-select (compute both answers, pick one), carry-skip (let the carry jump over a
// block that would only propagate it) and a decimal (BCD) adder.

import type { ComponentDef, PortDef } from '../sim/types';
import { mask } from '../sim/values';
import { Builder } from './builder';
import { andN, busMux2, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, OR } from './gates';
import { TIE0, TIE1 } from './transistors';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const addSpec = (n: number) => ([a, b, c]: number[]) => {
  const t = a + b + c;
  return [t % 2 ** n, t > mask(n) ? 1 : 0];
};
const adderPorts = (n: number) => [bus('a', n, 'in'), bus('b', n, 'in'), bit('cin', 'in'), bus('s', n, 'out'), bit('cout', 'out')];

/**
 * Carry-select: every block after the first is built twice, once assuming carry-in 0 and once 1. When
 * the real carry arrives, a multiplexer picks the right sum and carry: one mux delay per block instead of
 * a ripple through it.
 */
export function carrySelect(n: number, k = 4): ComponentDef {
  const nb = n / k;
  return memo(`csel${n}_${k}`, () => {
    const b = new Builder(8, 12, 8);
    b.pins('a', 'b', 'cin');
    const sa = b.op(splitter(Array(nb).fill(k), 6), ['a']);
    const sb = b.op(splitter(Array(nb).fill(k), 6), ['b']);
    const z = b.op1(TIE0, []), one = b.op1(TIE1, []);
    b.next();
    const first = b.op(rca(k), [`${sa}.o0`, `${sb}.o0`, 'cin'], 'block 0');
    const pairs = Array.from({ length: nb - 1 }, (_, i) => [
      b.op(rca(k), [`${sa}.o${i + 1}`, `${sb}.o${i + 1}`, z], `block ${i + 1}, carry 0`),
      b.op(rca(k), [`${sa}.o${i + 1}`, `${sb}.o${i + 1}`, one], `block ${i + 1}, carry 1`),
    ]);
    b.next();
    const sums = [`${first}.s`];
    let carry = b.name(`${first}.cout`, 'c1', true);
    pairs.forEach(([a0, a1], i) => {
      sums.push(b.op1(busMux2(k), [`${a0}.s`, `${a1}.s`, carry], `pick sum ${i + 1}`));
      carry = b.name(b.op1(MUX2, [`${a0}.cout`, `${a1}.cout`, carry], `pick carry ${i + 1}`), `c${i + 2}`, true);
    });
    b.next();
    b.wire(b.op1(merger(Array(nb).fill(k), 6), sums), 's');
    b.wire(carry, 'cout');
    const R = b.right;
    return define({
      id: `csel${n}_${k}`, name: `${n}-bit carry-select adder`, category: 'arithmetic',
      summary: `${nb} blocks of ${k} bits. All blocks but the first are duplicated (carry-in 0 and 1) and work in parallel; the carry then only passes one multiplexer per block. About 1.8 times the area of ripple carry.`,
      ports: adderPorts(n),
      symbol: { kind: 'box', label: `CSEL${n}` },
      spec: n <= 24 ? addSpec(n) : undefined,
      netlist: () => ({ pins: { a: [0, 4], b: [0, 8], cin: [0, 12], s: [R, 4], cout: [R, 8] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `// block i (i > 0): both answers, then pick
assign {c0_i, s0_i} = a_i + b_i;
assign {c1_i, s1_i} = a_i + b_i + 1;
assign s_i  = c_i ? s1_i : s0_i;
assign c_i1 = c_i ? c1_i : c0_i;`,
      },
    });
  });
}

/**
 * Carry-skip (carry-bypass): if every bit of a block propagates (a XOR b = 1 throughout), the block's
 * carry-out equals its carry-in, so a multiplexer lets the carry skip the block. The ripple path through
 * the block still exists in the netlist but can never be the last to change: a false path.
 */
export function carrySkip(n: number, k = 4): ComponentDef {
  const nb = n / k;
  return memo(`cskip${n}_${k}`, () => {
    const b = new Builder(8, 12, 8);
    b.pins('a', 'b');
    const sa = b.op(splitter(Array(nb).fill(k), 6), ['a']);
    const sb = b.op(splitter(Array(nb).fill(k), 6), ['b']);
    b.next();
    const props = Array.from({ length: nb }, (_, i) => b.op1(bitwise('xor', k), [`${sa}.o${i}`, `${sb}.o${i}`], `propagate ${i}`));
    b.next();
    const alls = props.map((p, i) => {
      const sp = b.op(splitter(ones(k)), [p]);
      return { sp, i };
    });
    b.next();
    const P = alls.map(({ sp, i }) => b.name(b.op1(andN(k), Array.from({ length: k }, (_, j) => `${sp}.o${j}`), `block ${i} propagates`), `P${i}`, true));
    b.next();
    let carry = b.name('cin', 'cin', true);
    const sums: string[] = [];
    for (let i = 0; i < nb; i++) {
      const add = b.op(rca(k), [`${sa}.o${i}`, `${sb}.o${i}`, carry], `block ${i}`);
      sums.push(`${add}.s`);
      // P = 1: the block would only pass its carry-in along, so skip it
      carry = b.name(b.op1(MUX2, [`${add}.cout`, carry, P[i]], `skip ${i}?`), `c${(i + 1) * k}`, true);
    }
    b.next();
    b.wire(b.op1(merger(Array(nb).fill(k), 6), sums), 's');
    b.wire(carry, 'cout');
    const R = b.right;
    return define({
      id: `cskip${n}_${k}`, name: `${n}-bit carry-skip adder`, category: 'arithmetic',
      summary: `${nb} ripple blocks of ${k} bits. A block whose bits all propagate passes its carry-in straight to the next block through a multiplexer. Static analysis still sees the ripple through every block (a false path); the real worst case ripples through the first and last blocks and skips the rest.`,
      ports: adderPorts(n),
      symbol: { kind: 'box', label: `CSKIP${n}` },
      spec: n <= 24 ? addSpec(n) : undefined,
      netlist: () => ({ pins: { a: [0, 4], b: [0, 8], cin: [0, 12], s: [R, 4], cout: [R, 8] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `// block i
assign {co_i, s_i} = a_i + b_i + c_i;
assign c_i1 = &(a_i ^ b_i) ? c_i : co_i;   // all propagate: skip`,
      },
    });
  });
}

/** One BCD digit: add in binary, and if the result is above 9 add 6 more (skipping the six unused codes). */
export const BCD_DIGIT: ComponentDef = (() => {
  const b = new Builder(8, 10);
  b.pins('a', 'b', 'cin');
  const z = b.op1(TIE0, []);
  const add = b.op(rca(4), ['a', 'b', 'cin'], 'binary sum');
  b.next();
  const sp = b.op(splitter(ones(4)), [`${add}.s`]);
  b.next();
  const hi = b.op1(OR, [`${sp}.o1`, `${sp}.o2`]);
  const big = b.op1(AND, [`${sp}.o3`, hi], '10..15');
  b.next();
  const fix = b.name(b.op1(OR, [`${add}.cout`, big], '> 9'), 'fix', true);
  b.next();
  const six = b.op1(merger(ones(4)), [z, fix, fix, z], '6 or 0');
  b.next();
  const corr = b.op(rca(4), [`${add}.s`, six, z], 'add 6');
  b.next();
  b.wire(`${corr}.s`, 's');
  b.wire(fix, 'cout');
  const R = b.right;
  return define({
    id: 'bcddigit', name: 'BCD digit adder', category: 'arithmetic',
    summary: 'Adds two decimal digits (0–9, four bits each) and a carry. A binary sum above 9 (a carry out, or 1010–1111) gets 6 added, which wraps it into 0–9 and makes the decimal carry.',
    ports: [bus('a', 4, 'in'), bus('b', 4, 'in'), bit('cin', 'in'), bus('s', 4, 'out'), bit('cout', 'out')],
    symbol: { kind: 'box', label: 'BCD' },
    spec: ([a, bb, c]) => {
      const t = a + bb + c, fix = t > 9;
      return [(t + (fix ? 6 : 0)) % 16, fix ? 1 : 0];
    },
    netlist: () => ({ pins: { a: [0, 4], b: [0, 8], cin: [0, 12], s: [R, 4], cout: [R, 8] }, instances: b.instances, nets: b.nets() }),
    hdl: {
      verilog: `wire [4:0] t = a + b + cin;
assign cout = t > 9;
assign s    = cout ? t[3:0] + 4'd6 : t[3:0];`,
    },
  });
})();

/** d-digit BCD adder: digit adders in a ripple chain. */
export function bcdAdder(d: number): ComponentDef {
  return memo(`bcd${d}`, () => {
    if (d === 1) return BCD_DIGIT;
    const b = new Builder(8, 12);
    b.pins('a', 'b', 'cin');
    const sa = b.op(splitter(Array(d).fill(4), 6), ['a']);
    const sb = b.op(splitter(Array(d).fill(4), 6), ['b']);
    b.next();
    let carry = 'cin';
    const sums: string[] = [];
    for (let i = 0; i < d; i++) {
      const dig = b.op(BCD_DIGIT, [`${sa}.o${i}`, `${sb}.o${i}`, carry], `digit ${i}`);
      sums.push(`${dig}.s`);
      carry = b.name(`${dig}.cout`, `carry ${i + 1}`, i < d - 1);
    }
    b.next();
    b.wire(b.op1(merger(Array(d).fill(4), 6), sums), 's');
    b.wire(carry, 'cout');
    const R = b.right;
    return define({
      id: `bcd${d}`, name: `${d}-digit BCD adder`, category: 'arithmetic',
      summary: `${d} decimal digits, each four bits (0x0–0x9), added digit by digit with a decimal carry between them. Read the inputs and the sum in hex: they look like decimal numbers.`,
      ports: [bus('a', 4 * d, 'in'), bus('b', 4 * d, 'in'), bit('cin', 'in'), bus('s', 4 * d, 'out'), bit('cout', 'out')],
      symbol: { kind: 'box', label: `BCD${d}` },
      spec: ([a, bb, c]) => {
        let s = 0, carry = c;
        for (let i = 0; i < d; i++) {
          const t = ((a >> (4 * i)) & 15) + ((bb >> (4 * i)) & 15) + carry;
          carry = t > 9 ? 1 : 0;
          s += ((t + (carry ? 6 : 0)) % 16) * 16 ** i;
        }
        return [s, carry];
      },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 8], cin: [0, 12], s: [R, 4], cout: [R, 8] }, instances: b.instances, nets: b.nets() }),
    });
  });
}
