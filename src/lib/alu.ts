// Level 5: the ALU and its parts. The ALU implements every RV32I integer operation. Its
// 4-bit control code is {funct7[5], funct3}: the instruction's own encoding, so the decoder
// barely has to translate it.
//   0000 ADD  1000 SUB  0001 SLL  0010 SLT  0011 SLTU  0100 XOR  0101 SRL  1101 SRA  0110 OR  0111 AND

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { mask } from '../sim/values';
import { addSub } from './combinational';
import { busMux2, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';
import { addSubFast } from './fastadd';

export { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

function memo<A extends unknown[]>(f: (...a: A) => ComponentDef): (...a: A) => ComponentDef {
  const cache = new Map<string, ComponentDef>();
  return (...a: A) => {
    const k = JSON.stringify(a);
    let d = cache.get(k);
    if (!d) cache.set(k, (d = f(...a)));
    return d;
  };
}

const log2 = (n: number) => Math.round(Math.log2(n));

// ---- constants and wiring --------------------------------------------------------------

/** A w-bit constant: each bit tied to VDD or GND. */
export const constWord = memo((w: number, v: number): ComponentDef => {
  const nets: NetDef[] = [{ name: 'y', ends: ['m.out', 'y'] }];
  const zeros = ['z.y'], onesE = ['o.y'];
  for (let i = 0; i < w; i++) (Math.floor(v / 2 ** i) % 2 ? onesE : zeros).push(`m.i${i}`);
  if (zeros.length > 1) nets.push({ name: 'gnd', ends: zeros, trunk: 4 });
  if (onesE.length > 1) nets.push({ name: 'vdd', ends: onesE, trunk: 5 });
  return define({
    id: `const${w}_${v.toString(16)}`, name: `Constant 0x${v.toString(16).toUpperCase()}`, category: 'plumbing',
    summary: 'Wires tied to VDD (1) or GND (0): a constant costs no gates.',
    ports: [bus('y', w, 'out')],
    symbol: { kind: 'box', label: w > 4 ? `0x${v.toString(16).toUpperCase()}` : v.toString(2).padStart(w, '0'), w: 6, h: 2 },
    behavior: { eval: () => [v] },
    spec: () => [v],
    netlist: () => ({
      pins: { y: [12, w / 2] },
      instances: [
        { name: 'z', def: TIE0, at: [0, 0] },
        { name: 'o', def: TIE1, at: [0, 3] },
        { name: 'm', def: merger(ones(w), 1), at: [8, 0] },
      ],
      nets,
    }),
  });
});

/** Zero-extend one bit to w bits. */
export const zext = memo((w: number): ComponentDef => define({
  id: `zext${w}`, name: `Zero-extend 1→${w}`, category: 'plumbing',
  summary: 'Puts a single bit in position 0 of a word whose other bits are 0.',
  ports: [bit('a', 'in'), bus('y', w, 'out')],
  symbol: { kind: 'box', label: 'ZEXT', w: 6, h: 2 },
  spec: ([a]) => [a],
  netlist: () => ({
    pins: { a: [1, 0.5], y: [12, w / 2] },
    instances: [{ name: 'z', def: TIE0, at: [1, 3] }, { name: 'm', def: merger(ones(w), 1), at: [8, 0] }],
    nets: [
      { name: 'a', ends: ['a', 'm.i0'] },
      { name: 'gnd', ends: ['z.y', ...Array.from({ length: w - 1 }, (_, i) => `m.i${i + 1}`)], trunk: 6 },
      { name: 'y', ends: ['m.out', 'y'] },
    ],
  }),
}));

/** Pure wiring: out[i] = in[i + s], with the top s bits taken from `fill`. */
export const shiftRightWire = memo((n: number, s: number): ComponentDef => {
  const alias: [string, number, string, number][] = [];
  for (let i = 0; i < n; i++) alias.push(i + s < n ? ['in', i + s, 'out', i] : ['fill', 0, 'out', i]);
  return define({
    id: `shr${n}_${s}`, name: `Wiring: shift right by ${s}`, category: 'plumbing',
    summary: `Each wire moves ${s} place${s > 1 ? 's' : ''} down; the vacated top bits come from "fill". Costs nothing: it is just how the wires are laid.`,
    ports: [bus('in', n, 'in'), bit('fill', 'in', 'bottom'), bus('out', n, 'out')],
    symbol: { kind: 'box', label: `≫${s}`, w: 4, h: 2 }, prim: 'alias', alias,
  });
});

/** Pure wiring: reverse the bit order. */
export const reverseWire = memo((n: number): ComponentDef => define({
  id: `rev${n}`, name: 'Wiring: reverse bits', category: 'plumbing',
  summary: 'Bit i goes to position n−1−i. A left shift is a right shift of the reversed word, reversed back.',
  ports: [bus('in', n, 'in'), bus('out', n, 'out')],
  symbol: { kind: 'box', label: '⇅', w: 4, h: 2 }, prim: 'alias',
  alias: Array.from({ length: n }, (_, i): [string, number, string, number] => ['in', i, 'out', n - 1 - i]),
}));

/** 1 when every bit of the word is 0: an OR tree and an inverter. */
export const isZero = memo((n: number): ComponentDef => {
  const t = orN(n);
  const tg = symbolGeom(t);
  return define({
    id: `zero${n}`, name: `${n}-bit zero detect`, category: 'gate',
    summary: `Is the word zero? OR all ${n} bits together and invert. Used for beq/bne.`,
    ports: [bus('a', n, 'in'), bit('z', 'out')],
    symbol: { kind: 'box', label: '=0?' },
    spec: ([a]) => [a === 0 ? 1 : 0],
    netlist: () => ({
      pins: { a: [1, n], z: [8 + tg.w + 9, tg.h / 2] },
      instances: [
        { name: 's', def: splitter(ones(n)), at: [3, 0] },
        { name: 'or', def: t, at: [7, 0] },
        { name: 'inv', def: NOT, at: [8 + tg.w + 1, tg.h / 2 - 1] },
      ],
      nets: [
        { name: 'a', ends: ['a', 's.in'] },
        ...Array.from({ length: n }, (_, i): NetDef => ({ ends: [`s.o${i}`, `or.i${i}`] })),
        { name: 'any', ends: ['or.y', 'inv.a'] },
        { name: 'z', ends: ['inv.y', 'z'] },
      ],
    }),
  });
});

// ---- barrel shifter ----------------------------------------------------------------------

/**
 * Logarithmic barrel shifter: log2(n) stages, stage j shifts right by 2^j when sh[j] = 1.
 * Left shifts reverse the word on the way in and out. Arithmetic right shifts fill with the
 * sign bit.
 */
export const shifter = memo((n: number): ComponentDef => {
  const k = log2(n);
  const m2 = busMux2(n);
  const X = (c: number) => 6 + 16 * c;
  const yL = 22 + 2 * k, yA = yL + 4, yF = yL + 4;
  const last = k + 1;
  const instances: InstanceDef[] = [
    { name: 'ss', def: splitter(ones(k)), at: [2, 20] },
    { name: 'sa', def: splitter([n - 1, 1]), at: [6, yA - 3] },
    { name: 'nl', def: NOT, at: [8, yL + 1] },
    { name: 'f1', def: AND, at: [10, yA - 1] },
    { name: 'f2', def: AND, at: [16, yL + 2] },
    { name: 'rin', def: reverseWire(n), at: [X(0), 15] },
    { name: 'mr', def: m2, at: [X(0) + 7, 12] },
    { name: 'rout', def: reverseWire(n), at: [X(last), 15] },
    { name: 'mo', def: m2, at: [X(last) + 7, 12] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'mr.a', 'rin.in', 'sa.in'], trunk: 4.5 },
    { name: 'ra', ends: ['rin.out', 'mr.b'] },
    { name: 'sh', ends: ['sh', 'ss.in'] },
    {
      name: 'left', ends: ['left', 'nl.a', 'mr.s', 'mo.s'], trunk: 1,
      via: { 'mr.s': [[X(0) + 9, yL]], 'mo.s': [[X(last) + 9, yL]] },
    },
    { name: 'msb', ends: ['sa.o1', 'f1.a'] },
    { name: 'arith', ends: ['arith', 'f1.b'] },
    { name: 'nleft', ends: ['nl.y', 'f2.a'] },
    { name: 'sgn', ends: ['f1.y', 'f2.b'] },
    { name: 'y', ends: ['mo.y', 'y'] },
  ];
  const fillEnds = ['f2.y'];
  const fillVia: Record<string, [number, number][]> = {};
  let prev = 'mr.y';
  for (let j = 0; j < k; j++) {
    const c = j + 1, s = 2 ** j;
    instances.push({ name: `w${j}`, def: shiftRightWire(n, s), at: [X(c), 15] });
    instances.push({ name: `m${j}`, def: m2, at: [X(c) + 7, 12] });
    nets.push({ name: `t${j}`, ends: [prev, `m${j}.a`, `w${j}.in`], trunk: X(c) - 1.5 });
    nets.push({ ends: [`w${j}.out`, `m${j}.b`] });
    nets.push({ name: `sh${j}`, ends: [`ss.o${j}`, `m${j}.s`], trunk: X(c) + 9 });
    fillEnds.push(`w${j}.fill`);
    fillVia[`w${j}.fill`] = [[X(c) + 2, yF]];
    prev = `m${j}.y`;
  }
  nets.push({ name: 'u', ends: [prev, 'mo.a', 'rout.in'], trunk: X(last) - 1.5 });
  nets.push({ ends: ['rout.out', 'mo.b'] });
  nets.push({ name: 'fill', ends: fillEnds, via: fillVia });
  const M = mask(n);
  return define({
    id: `shift${n}`, name: `${n}-bit barrel shifter`, category: 'arithmetic',
    summary: `Shifts by 0–${n - 1} places in ${k} stages of multiplexers (stage j shifts by 2^j). Left shifts reverse the word; arithmetic shifts copy the sign bit in.`,
    ports: [bus('a', n, 'in'), bus('sh', k, 'in'), bit('left', 'in'), bit('arith', 'in'), bus('y', n, 'out')],
    symbol: { kind: 'box', label: 'SHIFT' },
    spec: ([a, sh, left, arith]) => {
      if (left) return [(a * 2 ** sh) % (M + 1)];
      let r = Math.floor(a / 2 ** sh);
      if (arith && a >= 2 ** (n - 1)) r += M + 1 - 2 ** (n - sh);
      return [r];
    },
    netlist: () => ({
      pins: { a: [1, 15], sh: [0, 20 + k], left: [0, yL], arith: [0, yA + 2], y: [X(last) + 15, 15] },
      instances, nets,
    }),
    hdl: {
      verilog: `module shifter #(parameter int N = ${n}) (input logic [N-1:0] a, input logic [$clog2(N)-1:0] sh,
                                        input logic left, arith, output logic [N-1:0] y);
  always_comb
    if (left)       y = a << sh;
    else if (arith) y = $signed(a) >>> sh;
    else            y = a >> sh;
endmodule`,
    },
  });
});

// ---- the ALU -----------------------------------------------------------------------------

export function aluSpec(n: number): (v: number[]) => number[] {
  const M = mask(n), H = 2 ** (n - 1);
  return ([a, b, ctl]) => {
    const f3 = ctl & 7, alt = ctl >> 3;
    const sub = alt || f3 === 2 || f3 === 3 ? 1 : 0;
    const bb = sub ? (~b & M) >>> 0 : b;
    const t = a + bb + sub;
    const s = t % (M + 1);
    const c = t > M ? 1 : 0;
    const v = (a >= H) === (bb >= H) && (s >= H) !== (a >= H) ? 1 : 0;
    const neg = s >= H ? 1 : 0;
    const sh = b % n;
    let y: number;
    switch (f3) {
      case 0: y = s; break;
      case 1: y = (a * 2 ** sh) % (M + 1); break;
      case 2: y = neg ^ v; break;
      case 3: y = c ? 0 : 1; break;
      case 4: y = (a ^ b) >>> 0; break;
      case 5: y = Math.floor(a / 2 ** sh) + (alt && a >= H ? M + 1 - 2 ** (n - sh) : 0); break;
      case 6: y = (a | b) >>> 0; break;
      default: y = (a & b) >>> 0;
    }
    return [y, y === 0 ? 1 : 0, neg, v, c];
  };
}

export const alu = memo((n: number, adder: 'rca' | 'ks' = 'rca'): ComponentDef => {
  const k = log2(n);
  const P = 16;
  const AS = adder === 'ks' ? addSubFast(n) : addSub(n), SH = shifter(n), MX = muxTree(3, n, P), ZD = isZero(n), ZX = zext(n);
  const asg = symbolGeom(AS), shg = symbolGeom(SH), mxg = symbolGeom(MX), zdg = symbolGeom(ZD);
  const ux = 14; // unit column
  const mxAt: [number, number] = [50, 4];
  const d = (i: number) => mxAt[1] + mxg.ports[`d${i}`].pos[1]; // y of mux input i
  const asAt: [number, number] = [ux, d(0) - asg.ports.s.pos[1]];
  const shAt: [number, number] = [ux, d(1) - shg.ports.y.pos[1]];
  const bw = (op: 'and' | 'or' | 'xor') => bitwise(op, n);
  const bwg = symbolGeom(bw('and'));
  const bwAt = (i: number): [number, number] => [ux, d(i) - bwg.ports.y.pos[1]];
  const asR = ux + asg.w;
  const port = (at: [number, number], g: ReturnType<typeof symbolGeom>, p: string) => [at[0] + g.ports[p].pos[0], at[1] + g.ports[p].pos[1]];
  const asN = port(asAt, asg, 'n'), asV = port(asAt, asg, 'v'), asC = port(asAt, asg, 'cout');
  const [nT, vT, cT] = [asR + 2, asR + 4, asR + 6];
  const yC = 126; // control area
  const mxBottom = mxAt[1] + mxg.h;
  const mxY = mxAt[1] + mxg.ports.y.pos[1];
  const zdAt: [number, number] = [mxAt[0] + mxg.w + 4, mxY + 4 - zdg.ports.a.pos[1]];

  const instances: InstanceDef[] = [
    { name: 'add', def: AS, at: asAt },
    { name: 'shift', def: SH, at: shAt },
    { name: 'sb', def: splitter([k, n - k]), at: [9, shAt[1] + shg.ports.sh.pos[1] - 1] },
    { name: 'slt', def: XOR, at: [cT + 2, d(2) - 2] },
    { name: 'zslt', def: ZX, at: [cT + 8, d(2) - 1] },
    { name: 'sltu', def: NOT, at: [cT + 3, d(3) - 1] },
    { name: 'zsltu', def: ZX, at: [cT + 8, d(3) - 1] },
    { name: 'xor', def: bw('xor'), at: bwAt(4) },
    { name: 'or', def: bw('or'), at: bwAt(6) },
    { name: 'and', def: bw('and'), at: bwAt(7) },
    { name: 'mux', def: MX, at: mxAt },
    { name: 'zero', def: ZD, at: zdAt },
    { name: 'sc', def: splitter([3, 1]), at: [4, yC + 1] },
    { name: 'sf', def: splitter([1, 1, 1]), at: [8, yC + 6] },
    { name: 'nf2', def: NOT, at: [12, yC + 10] },
    { name: 'g_and', def: AND, at: [17, yC + 8] },
    { name: 'g_or', def: OR, at: [24, yC + 3] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'add.a', 'shift.a', 'xor.a', 'or.a', 'and.a'], trunk: 6 },
    { name: 'b', ends: ['b', 'add.b', 'sb.in', 'xor.b', 'or.b', 'and.b'], trunk: 8 },
    { name: 'shamt', ends: ['sb.o0', 'shift.sh'] },
    { name: 'sum', ends: ['add.s', 'mux.d0'] },
    { name: 'shifted', ends: ['shift.y', 'mux.d1', 'mux.d5'] },
    { name: 'neg', ends: ['add.n', 'slt.a', 'neg'], trunk: nT },
    { name: 'ovf', ends: ['add.v', 'slt.b', 'ovf'], trunk: vT },
    { name: 'carry', ends: ['add.cout', 'sltu.a', 'carry'], trunk: cT },
    { name: 'lt', ends: ['slt.y', 'zslt.a'] },
    { name: 'ltu', ends: ['sltu.y', 'zsltu.a'] },
    { name: 'slt_w', ends: ['zslt.y', 'mux.d2'] },
    { name: 'sltu_w', ends: ['zsltu.y', 'mux.d3'] },
    { name: 'xor_w', ends: ['xor.y', 'mux.d4'] },
    { name: 'or_w', ends: ['or.y', 'mux.d6'] },
    { name: 'and_w', ends: ['and.y', 'mux.d7'] },
    { name: 'y', ends: ['mux.y', 'y', 'zero.a'] },
    { name: 'z', ends: ['zero.z', 'zero'] },
    { name: 'ctl', ends: ['ctl', 'sc.in'] },
    { name: 'f3', ends: ['sc.o0', 'mux.s', 'sf.in'], trunk: 6.5, via: { 'mux.s': [[6.5, mxBottom + 1], [mxAt[0] + mxg.ports.s.pos[0], mxBottom + 1]] } },
    { name: 'alt', ends: ['sc.o1', 'g_or.a', 'shift.arith'], via: { 'shift.arith': [[13, yC + 4], [13, shAt[1] + shg.ports.arith.pos[1]]] } },
    { name: 'f1', ends: ['sf.o1', 'g_and.a'] },
    { name: 'f2', ends: ['sf.o2', 'nf2.a'] },
    {
      name: 'left', ends: ['nf2.y', 'g_and.b', 'shift.left'],
      via: { 'shift.left': [[16, yC - 1], [12, yC - 1], [12, shAt[1] + shg.ports.left.pos[1]]] },
    },
    { name: 'lt_op', ends: ['g_and.y', 'g_or.b'] },
    { name: 'sub', ends: ['g_or.y', 'add.sub'], via: { 'add.sub': [[29, yC - 2], [11, yC - 2], [11, asAt[1] + asg.ports.sub.pos[1]]] } },
  ];
  void asN; void asV; void asC;
  const spec = aluSpec(n);
  return define({
    id: `alu${n}${adder === 'ks' ? 'ks' : ''}`, name: `${n}-bit ALU${adder === 'ks' ? ' (Kogge–Stone)' : ''}`, category: 'arithmetic',
    summary: 'Every RV32I integer operation in one block: add, subtract, shifts, set-less-than, XOR, OR, AND. All units compute in parallel; a multiplexer picks one result.',
    ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('ctl', 4, 'in', 'bottom'), bus('y', n, 'out'), bit('zero', 'out'), bit('neg', 'out'), bit('ovf', 'out'), bit('carry', 'out')],
    symbol: { kind: 'box', label: 'ALU' },
    spec,
    netlist: () => ({
      pins: {
        a: [1, 50], b: [1, 54], ctl: [0, yC + 3],
        y: [mxAt[0] + mxg.w + 18, mxY], zero: [zdAt[0] + zdg.w + 4, zdAt[1] + zdg.ports.z.pos[1]],
        neg: [nT, -2], ovf: [vT, -5], carry: [cT, -8],
      },
      pinDirs: { neg: 'down', ovf: 'down', carry: 'down' },
      instances, nets,
    }),
    notes: `<table><tr><th>ctl</th><th>op</th><th>ctl</th><th>op</th></tr>
      <tr><td>0000</td><td>ADD</td><td>1000</td><td>SUB</td></tr>
      <tr><td>0001</td><td>SLL</td><td>0101</td><td>SRL</td></tr>
      <tr><td>0010</td><td>SLT</td><td>1101</td><td>SRA</td></tr>
      <tr><td>0011</td><td>SLTU</td><td>0110</td><td>OR</td></tr>
      <tr><td>0100</td><td>XOR</td><td>0111</td><td>AND</td></tr></table>
      ctl = {funct7[5], funct3}: the low three bits select the result, the top bit selects subtract / arithmetic shift.
      SLT and SLTU subtract and read the flags: a &lt; b (signed) is N ⊕ V; a &lt; b (unsigned) is NOT carry.`,
    hdl: {
      verilog: `module alu #(parameter int N = ${n}) (
  input  logic [N-1:0] a, b,
  input  logic [3:0]   ctl,          // {funct7[5], funct3}
  output logic [N-1:0] y,
  output logic         zero, neg, ovf, carry);
  logic [N-1:0] sum;
  logic sub;
  assign sub = ctl[3] | (ctl[2:1] == 2'b01);          // SUB, SLT, SLTU subtract
  addsub #(N) add (.a, .b, .sub, .s(sum), .cout(carry), .v(ovf), .n(neg));
  always_comb
    case (ctl[2:0])
      3'b000: y = sum;
      3'b001: y = a << b[$clog2(N)-1:0];
      3'b010: y = {{(N-1){1'b0}}, neg ^ ovf};         // signed a < b
      3'b011: y = {{(N-1){1'b0}}, ~carry};            // unsigned a < b
      3'b100: y = a ^ b;
      3'b101: y = ctl[3] ? $signed(a) >>> b[$clog2(N)-1:0] : a >> b[$clog2(N)-1:0];
      3'b110: y = a | b;
      default: y = a & b;
    endcase
  assign zero = (y == '0);
endmodule`,
    },
  });
});
