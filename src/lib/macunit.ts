// The MAC unit (chapter "A MAC on the RV32"), in gates: two 16 x 16 tree multipliers, an adder for the pair, a 40-bit adder and register for the
// accumulator, and a read path (arithmetic shift, round once, clamp once). dsp/mac.ts is the specification, cycle for cycle
// (tests/dsp-mac-gates.test.ts). The interface is kept stable for the DSP core, which reuses the block:
//
//   in : a, b (32)  the operands: lo = bits 15:0, hi = bits 31:16, both signed. A narrower machine ties the upper bits to the sign or to 0.
//        op (2)     funct3[1:0]: 00 mac (acc += lo*lo), 01 mac2 (acc += lo*lo + hi*hi), 10 clracc (acc = 0), 11 racc (the accumulator is only read)
//        en         the instruction is a MAC one: the accumulator may change at the next rising edge (racc never changes it)
//        sh (6)     the read shift (racc: rs1[5:0]); y follows acc and sh at all times, so it is racc's result whenever op = 11
//        clk
//   out: y (32)     clamp32(round(acc >> sh)), sat (the clamp acted), acc (40, the register)

import { ACC_BITS, raccOf } from '../dsp/mac';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, shiftRightWire } from './alu';
import { Builder } from './builder';
import { busMux2, rca } from './combinational';
import { define, ones, splitter } from './define';
import { cut, placed, roundUp } from './fft';
import { clampWide } from './firmac';
import { AND, NOT } from './gates';
import { macSlot } from './macslot';
import { treeMul } from './muldiv';
import { register } from './sequential';
import { TIE0 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, ...(clock ? { clock } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

const W = ACC_BITS, R = W + 1; // the accumulator, and the read path's word: one more bit, the bit the shift drops first (and room for the rounding carry)

/** Arithmetic shift right of an R-bit word by 0 .. 63: six stages, stage j moving by 2^j when sh[j] = 1. The vacated bits copy the sign. */
export function readShifter(): ComponentDef {
  return memo(`macshift${R}`, () => {
    const b = new Builder(6, 8, 3);
    b.pins('x', 'sh');
    const sp = b.op(splitter(ones(6), 4), ['sh'], undefined, 'ssh');
    const sign = b.op1(cut(R, R - 1, 1), ['x'], 'sign', 'sign');
    let t = 'x';
    for (let j = 0; j < 6; j++) {
      b.next();
      const w = b.op(shiftRightWire(R, 2 ** j), [t, sign], `≫ ${2 ** j}`, `w${j}`);
      b.next();
      t = b.op1(busMux2(R), [t, `${w}.out`, `${sp}.o${j}`], `by ${2 ** j}?`, `m${j}`);
    }
    b.next();
    b.wire(t, 'y');
    const right = b.right;
    return define({
      id: `macshift${R}`, name: `${R}-bit arithmetic shifter, 0-63`, category: 'arithmetic',
      summary: `Shifts a ${R}-bit word right by 0 to 63 places in six stages (stage j moves by 2^j), filling with the sign. A shift past the width leaves only the sign.`,
      ports: [bus('x', R, 'in'), bus('sh', 6, 'in'), bus('y', R, 'out')],
      symbol: { kind: 'box', label: 'SHIFT', w: 8 },
      spec: ([x, sh]) => {
        const v = BigInt.asIntN(R, BigInt(x)) >> BigInt(sh);
        return [Number(BigInt.asUintN(R, v))];
      },
      netlist: () => ({ pins: { x: [0, 6], sh: [0, 14], y: [right, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** acc (40 bits) and the shift to the result: {acc, 0} shifted right, the bit that falls out first is the rounding bit, the rest is added to it once. */
export function macRead(): ComponentDef {
  return memo('macread', () => {
    const b = new Builder(8, 10, 4);
    b.pins('acc', 'sh');
    const zero = b.op1(TIE0, [], undefined, 'zero');
    b.next();
    const wide = b.op1(placed(W, 1, R), ['acc', zero], '{acc, 0}: one place of room', 'wide');
    b.next();
    const sh = b.op1(readShifter(), [wide, 'sh'], 'acc ≫ sh, and the dropped bit', 'shift');
    b.next();
    const hi = b.op1(cut(R, 1, W), [sh], 'acc ≫ sh', 'hi');
    const rnd = b.op1(cut(R, 0, 1), [sh], 'first bit dropped', 'rnd');
    b.next();
    const ext = b.op1(placed(W, 0, R), [hi], 'one more bit for the carry', 'ext');
    b.next();
    const r = b.op1(roundUp(R), [ext, rnd], 'round half up', 'round');
    b.next();
    const cl = b.op(clampWide(R, 32), [r], 'clamp once', 'clamp');
    b.next();
    b.wire(`${cl}.y`, 'y');
    b.wire(`${cl}.sat`, 'sat');
    const right = b.right;
    return define({
      id: 'macread', name: 'Accumulator read: shift, round, clamp', category: 'arithmetic',
      summary: 'The accumulator to a 32-bit word: a barrel shifter, the first bit it drops added back (round half up), and one clamp for what does not fit. Done once per output, not per product.',
      ports: [bus('acc', W, 'in'), bus('sh', 6, 'in'), bus('y', 32, 'out'), bit('sat', 'out')],
      symbol: { kind: 'box', label: 'READ', w: 8 },
      spec: ([a, sh]) => { const r = raccOf(BigInt.asIntN(W, BigInt(a)), sh); return [r.y >>> 0, r.sat ? 1 : 0]; },
      netlist: () => ({ pins: { acc: [0, 6], sh: [0, 14], y: [right, 6], sat: [right, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The MAC unit. See the header for the interface. */
export function macUnit(): ComponentDef {
  return memo('macunit', () => {
    const b = new Builder(10, 10, 4);
    b.pins('a', 'b', 'op', 'en', 'sh', 'clk');
    const sop = b.op(splitter(ones(2), 4), ['op'], undefined, 'sop');
    const alo = b.op1(cut(32, 0, 16), ['a'], 'rs1[15:0]', 'alo');
    const ahi = b.op1(cut(32, 16, 16), ['a'], 'rs1[31:16]', 'ahi');
    const blo = b.op1(cut(32, 0, 16), ['b'], 'rs2[15:0]', 'blo');
    const bhi = b.op1(cut(32, 16, 16), ['b'], 'rs2[31:16]', 'bhi');
    const zero32 = b.op1(constWord(32, 0), [], undefined, 'zero32');
    const zero40 = b.op1(constWord(W, 0), [], 'clracc', 'zero40');
    const cin = b.op1(TIE0, [], 'no carry in', 'cin');
    b.next();
    const m0 = b.op(treeMul(16, true), [alo, blo], 'lo × lo, signed', 'mul0');
    const m1 = b.op(treeMul(16, true), [ahi, bhi], 'hi × hi, signed', 'mul1');
    b.next();
    const g1 = b.op1(busMux2(32), [zero32, `${m1}.p`, `${sop}.o0`], 'only for mac2', 'g1');
    const e0 = b.op1(placed(32, 0, 33), [`${m0}.p`], '32 → 33 bits', 'e0');
    b.next();
    const e1 = b.op1(placed(32, 0, 33), [g1], '32 → 33 bits', 'e1');
    b.next();
    const pair = b.op(rca(33), [e0, e1, cin], 'the pair of products', 'pair');
    b.next();
    const pe = b.op1(placed(33, 0, W), [`${pair}.s`], '33 → 40 bits', 'pe');
    b.next();
    const add = b.op(rca(W), ['', pe, cin], 'acc + products', 'add');
    // control: clr = op is clracc (10); racc (11) reads only, so the register loads when en and not racc
    const nop0 = b.op1(NOT, [`${sop}.o0`], undefined, 'nop0');
    const clr = b.op1(AND, [`${sop}.o1`, nop0], 'clracc', 'clr');
    const isr = b.op1(AND, [`${sop}.o1`, `${sop}.o0`], 'racc', 'isr');
    const nr = b.op1(NOT, [isr], undefined, 'nr');
    const we = b.op1(AND, ['en', nr], 'changes the accumulator', 'we');
    b.next();
    const nxt = b.op1(busMux2(W), [`${add}.s`, zero40, clr], '0 for clracc', 'nxt');
    b.next();
    const acc = b.op(register(W), [nxt, we, 'clk'], 'accumulator, 40 bits', 'acc');
    b.wire(`${acc}.q`, `${add}.a`);
    b.next();
    const rd = b.op(macRead(), [`${acc}.q`, 'sh'], 'racc: shift, round, clamp', 'read');
    b.next();
    b.wire(`${rd}.y`, 'y');
    b.wire(`${rd}.sat`, 'sat');
    b.wire(`${acc}.q`, 'acc');
    const right = b.right;
    return define({
      id: 'macunit', name: 'MAC unit (40-bit accumulator)', category: 'arithmetic',
      summary: 'Two signed 16 × 16 multipliers, an adder for their sum, and a 40-bit accumulator. mac adds the low halves\' product, mac2 both halves\', clracc empties it. The read path shifts, rounds once and clamps once to 32 bits.',
      ports: [bus('a', 32, 'in'), bus('b', 32, 'in'), bus('op', 2, 'in'), bit('en', 'in'), bus('sh', 6, 'in'), bit('clk', 'in', 'bottom', true), bus('y', 32, 'out'), bit('sat', 'out'), bus('acc', W, 'out')],
      symbol: { kind: 'box', label: 'MAC', w: 8, h: 14 },
      netlist: () => ({ pins: { a: [0, 6], b: [0, 14], op: [0, 22], en: [0, 30], sh: [0, 38], clk: [0, 46], y: [right, 6], sat: [right, 14], acc: [right, 22] }, instances: b.instances, nets: b.nets() }),
    });
  });
}


macSlot.unit = macUnit;
macSlot.cut = cut;
