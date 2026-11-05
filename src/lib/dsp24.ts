// The DSP core in gates (chapter "A DSP core"; ISA, assembler and golden model in src/dsp/*24.ts): 16-bit data, 24-bit instructions,
// one instruction per clock. Blocks, each read by drilling in: DECODE (the word to every control), REGS (r0–r7), ALU, two address
// generators AGU X / AGU Y (four pointers, base, length, modifier; one step per access: +1, −1, +m, −m, circular, bit-reversed),
// SEQ (PC, the hardware loop unit, jumps), the MAC block of the RV32 chapter (lib/macunit.ts, unchanged, behind a small adapter),
// the program ROM and the X and Y memories. dsp24Computer(program, x, y) joins them; dsp24Core is the same without the three
// memories (their pins out), which is the sandbox's part.

import { type Decoded24, decode24 } from '../dsp/isa24';
import { aguStep } from '../dsp/iss24';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { constWord, isZero, reverseWire, shifter } from './alu';
import { bigRam, bigRamWithInit, wordsHash } from './bigmem';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { cut, placed } from './fft';
import { clampWord } from './fixedpt';
import { AND, NOT, OR, XOR } from './gates';
import { macUnit } from './macunit';
import { register } from './sequential';
import { DFFE } from './sequential';
import { TIE0 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);
const outs = (ps: PortDef[]) => ps.filter((p) => p.dir === 'out').map((p) => p.name);

// ---- Decode ----------------------------------------------------------------------------------

/** DECODE's outputs, in port order: [name, width]. Fields are passed through where the datapath needs them. */
export const CTL24 = [
  ['halt', 1], ['rwe', 1], ['wsrc', 3], ['aluf', 4], ['bimm', 1], ['ra', 3], ['rb', 3], ['rd', 3],
  ['xact', 1], ['yact', 1], ['xwe', 1], ['ywe', 1], ['xmode', 3], ['xp', 2], ['ymode', 3], ['yp', 2],
  ['macen', 1], ['macop', 2], ['wex', 1], ['wey', 1], ['wsel', 3], ['rsel', 3], ['msrc', 2], ['srcy', 1],
  ['isloop', 1], ['lreg', 1], ['cnt', 10], ['lend', 8], ['jmp', 1], ['jz', 1], ['jnz', 1], ['addr', 8], ['outv', 1],
  ['imm', 14], ['sh', 6],
] as const;
export type Ctl24 = Record<(typeof CTL24)[number][0], number>;

const ALU_OPS = ['addi', 'add', 'sub', 'adds', 'subs', 'and', 'or', 'xor', 'shl', 'shr', 'sar'];

/** What DECODE drives for a word (the specification of the gates: tests compare them on every field). */
export function control24(w: number): Ctl24 {
  const d: Decoded24 = decode24(w);
  const n = d.name;
  const is = (...names: string[]) => (names.includes(n) ? 1 : 0);
  const bus1 = d.bus, single = is('ld', 'st');
  const singleY = single & bus1;
  const dhi = n === 'mov' ? (w >> 11) & 3 : (w >> 14) & 3;
  const movLdi = is('mov', 'ldi');
  const wmask = movLdi & ((dhi >> 1) ^ (dhi & 1));
  const lo3top = (w >> 18) & 1;
  return {
    halt: is('halt'),
    rwe: ALU_OPS.includes(n) || is('ld', 'ldh', 'rnd', 'rndc') || (movLdi && dhi === 0) ? 1 : 0,
    wsrc: ALU_OPS.includes(n) ? 0 : n === 'ld' ? (bus1 ? 2 : 1) : n === 'mov' ? 3 : n === 'ldi' ? 4 : n === 'ldh' ? 5 : is('rnd', 'rndc') ? 6 : 0,
    aluf: (w >> 19) & 15,
    bimm: is('addi'),
    ra: d.ra, rb: d.rb, rd: d.rd,
    xact: is('mac') | (single & (1 - bus1)), yact: is('mac') | singleY,
    xwe: is('st') & (1 - bus1), ywe: is('st') & bus1,
    xmode: d.xmode, xp: d.xp,
    ymode: singleY ? d.xmode : d.ymode, yp: singleY ? d.xp : d.yp,
    macen: is('mac', 'clr', 'rndc'), macop: is('clr', 'rndc') ? 2 : 0,
    wex: wmask & (1 - lo3top), wey: wmask & lo3top,
    wsel: ((dhi >> 1) << 2) | ((w >> 16) & 3),
    rsel: (((w >> 10) & 1) << 2) | ((w >> 13) & 3),
    msrc: (w >> 9) & 3, srcy: (w >> 15) & 1,
    isloop: is('loop'), lreg: (w >> 18) & 1, cnt: (w >> 8) & 1023, lend: w & 255,
    jmp: is('jmp'), jz: is('jz'), jnz: is('jnz'), addr: w & 255, outv: is('out'),
    imm: w & 0x3fff, sh: w & 63,
  };
}

const DECODE_PORTS: PortDef[] = [bus('instr', 24, 'in'), ...CTL24.map(([n, w]) => bus(n, w, 'out'))];

export const DSP24_DECODE: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('instr');
  const f = (lo: number, w: number, name: string, label?: string) => b.name(b.op1(cut(24, lo, w), ['instr'], label ?? `[${lo + w - 1}:${lo}]`), name, true);
  const op = f(19, 5, 'op', 'op');
  const bus1 = f(2, 1, 'bus', 'memory: X / Y');
  const hiMov = f(11, 2, 'hiMov', 'mov: dst high'), hiLdi = f(14, 2, 'hiLdi', 'ldi: dst high');
  const lreg = f(18, 1, 'lreg0');
  b.next();
  const od = b.op(decoder(5), [op], 'op');
  const L = (name: string) => `${od}.y${['nop', 'halt', 'mov', 'ldi', 'ldh', 'addi', 'add', 'sub', 'adds', 'subs', 'and', 'or', 'xor', 'shl', 'shr', 'sar', 'ld', 'st', 'clr', 'mac', 'rnd', 'rndc', 'out', 'loop', 'jmp', 'jz', 'jnz'].indexOf(name)}`;
  b.next();
  const single = b.name(b.op1(OR, [L('ld'), L('st')], 'ld / st'), 'single', true);
  const nbus = b.op1(NOT, [bus1]);
  const singleY = b.name(b.op1(AND, [single, bus1], 'on Y'), 'singleY', true);
  const singleX = b.op1(AND, [single, nbus], 'on X');
  const clrr = b.name(b.op1(OR, [L('clr'), L('rndc')], 'clr / rndc'), 'clrr', true);
  const movLdi = b.name(b.op1(OR, [L('mov'), L('ldi')], 'mov / ldi'), 'movldi', true);
  const aluAny = b.op1(orN(11), ['addi', 'add', 'sub', 'adds', 'subs', 'and', 'or', 'xor', 'shl', 'shr', 'sar'].map(L), 'ALU op');
  const dhi = b.op1(busMux2(2), [hiLdi, hiMov, L('mov')], 'destination high bits');
  const sd = b.op(splitter([1, 1], 2), [dhi]);
  b.next();
  const dnz = b.op1(OR, [`${sd}.o0`, `${sd}.o1`], 'not a register');
  const dxor = b.op1(AND, [dnz, b.op1(NOT, [b.op1(AND, [`${sd}.o0`, `${sd}.o1`])])], 'pointer or AGU register');
  const wmask = b.name(b.op1(AND, [movLdi, dxor], 'write an AGU register'), 'wmask', true);
  const toReg = b.op1(AND, [movLdi, b.op1(NOT, [dnz])], 'mov / ldi to r');
  const l2 = f(18, 1, 'lo3top', 'dst bit 2');
  b.next();
  const rwe = b.op1(orN(5), [aluAny, L('ld'), L('ldh'), b.op1(OR, [L('rnd'), L('rndc')]), toReg], 'register write');
  const ldX = b.op1(AND, [L('ld'), nbus]), ldY = b.op1(AND, [L('ld'), bus1]);
  const rn = b.op1(OR, [L('rnd'), L('rndc')], 'rnd / rndc');
  const w0 = b.op1(orN(3), [ldX, L('mov'), L('ldh')]);
  const w1 = b.op1(orN(3), [ldY, L('mov'), rn]);
  const w2 = b.op1(orN(3), [L('ldi'), L('ldh'), rn]);
  const xact = b.op1(OR, [L('mac'), singleX], 'X access');
  const yact = b.op1(OR, [L('mac'), singleY], 'Y access');
  const xwe = b.op1(AND, [L('st'), nbus], 'store to X');
  const ywe = b.op1(AND, [L('st'), bus1], 'store to Y');
  const wex = b.op1(AND, [wmask, b.op1(NOT, [l2])], 'write AGU X register');
  const wey = b.op1(AND, [wmask, l2], 'write AGU Y register');
  const macen = b.op1(orN(3), [L('mac'), L('clr'), L('rndc')], 'MAC op');
  b.next();
  const xslot = f(8, 5, 'xslot', 'X operand'), yslot = f(3, 5, 'yslot', 'Y operand');
  const ym = b.op1(busMux2(5), [yslot, xslot, singleY], 'Y operand: its own, or the X one');
  const sy = b.op(splitter([2, 3], 2), [ym]);
  b.next();
  const xmode = f(10, 3, 'xmode0', 'X mode'), xp = f(8, 2, 'xp0', 'X pointer');
  const f3 = (lo: number, w: number, label: string) => b.op1(cut(24, lo, w), ['instr'], label);
  const wsrc = b.op1(merger([1, 1, 1], 2), [w0, w1, w2], 'data source');
  const wsel = b.op1(merger([2, 1], 2), [f3(16, 2, 'dst[1:0]'), `${sd}.o1`], 'AGU register');
  const rsel = b.op1(merger([2, 1], 2), [f3(13, 2, 'src[1:0]'), f3(10, 1, 'src hi')], 'AGU register to read');
  b.next();
  b.wire(L('halt'), 'halt');
  b.wire(rwe, 'rwe');
  b.wire(wsrc, 'wsrc');
  b.wire(f3(19, 4, 'op[3:0]'), 'aluf');
  b.wire(L('addi'), 'bimm');
  b.wire(f3(13, 3, 'ra'), 'ra');
  b.wire(f3(10, 3, 'rb'), 'rb');
  b.wire(f3(16, 3, 'rd'), 'rd');
  b.wire(xact, 'xact'); b.wire(yact, 'yact'); b.wire(xwe, 'xwe'); b.wire(ywe, 'ywe');
  b.wire(xmode, 'xmode'); b.wire(xp, 'xp');
  b.wire(`${sy}.o1`, 'ymode'); b.wire(`${sy}.o0`, 'yp');
  b.wire(macen, 'macen');
  b.wire(b.op1(merger([1, 1], 2), [b.op1(constWord(1, 0), []), clrr], 'MAC op'), 'macop');
  b.wire(wex, 'wex'); b.wire(wey, 'wey');
  b.wire(wsel, 'wsel'); b.wire(rsel, 'rsel');
  b.wire(f3(9, 2, 'src high'), 'msrc'); b.wire(f3(15, 1, 'src bit 2'), 'srcy');
  b.wire(L('loop'), 'isloop'); b.wire(lreg, 'lreg');
  b.wire(f3(8, 10, 'count'), 'cnt'); b.wire(f3(0, 8, 'end'), 'lend');
  b.wire(L('jmp'), 'jmp'); b.wire(L('jz'), 'jz'); b.wire(L('jnz'), 'jnz'); b.wire(f3(0, 8, 'address'), 'addr');
  b.wire(L('out'), 'outv');
  b.wire(f3(0, 14, 'imm'), 'imm'); b.wire(f3(0, 6, 'shift'), 'sh');
  const R = b.right;
  return define({
    id: 'dsp24_decode', name: 'Decode (DSP core)', category: 'cpu',
    summary: 'The 24-bit instruction word to every control signal of the DSP core: a 5-to-32 decoder on the op field, OR gates gathering the lines each control needs, and the fields the datapath reads passed through (register numbers, the X and Y operand slots, the constants).',
    ports: DECODE_PORTS,
    symbol: { kind: 'box', label: 'DECODE' },
    spec: ([w]) => { const c = control24(w); return CTL24.map(([n]) => c[n]); },
    netlist: () => ({ pins: { ...pinsAt(ins(DECODE_PORTS), 0, 4), ...pinsAt(outs(DECODE_PORTS), R, 3) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- ALU -------------------------------------------------------------------------------------

const s16 = (v: number) => ((v & 0xffff) ^ 0x8000) - 0x8000;

/** The ALU's function; f is the op field's low four bits (5 addi and 6 add both add; the unused codes add too). */
export function alu24(a: number, b: number, f: number): number {
  const sat = (v: number) => Math.max(-32768, Math.min(32767, v));
  switch (f) {
    case 7: return (a - b) & 0xffff;
    case 8: return sat(s16(a) + s16(b)) & 0xffff;
    case 9: return sat(s16(a) - s16(b)) & 0xffff;
    case 10: return a & b;
    case 11: return a | b;
    case 12: return a ^ b;
    case 13: return (a << (b & 15)) & 0xffff;
    case 14: return a >>> (b & 15);
    case 15: return (s16(a) >> (b & 15)) & 0xffff;
    default: return (a + b) & 0xffff;
  }
}

export const DSP24_ALU: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('a', 'b', 'f');
  const fd = b.op(decoder(4), ['f'], 'which function');
  const Y = (i: number) => b.name(`${fd}.y${i}`, `f${i}`, true);
  const [f7, f8, f9, f13, f15] = [7, 8, 9, 13, 15].map(Y);
  const sub = b.name(b.op1(OR, [f7, f9], 'subtract'), 'sub', true);
  const satf = b.op1(OR, [f8, f9], 'saturating');
  const subw = b.op1(merger(ones(16), 2), Array(16).fill(sub), 'sub × 16');
  const zero = b.name(b.op1(TIE0, [], '0'), 'zero', true);
  b.next();
  const bx = b.op1(bitwise('xor', 16), ['b', subw], 'b or ¬b');
  const sh = b.op1(cut(16, 0, 4), ['b'], 'shift amount');
  b.next();
  const add = b.op(rca(16), ['a', bx, sub], 'a ± b');
  const a15 = b.op1(cut(16, 15, 1), ['a'], 'sign of a');
  const b15 = b.op1(cut(16, 15, 1), [bx], 'sign of the addend');
  b.next();
  const s15 = b.op1(cut(16, 15, 1), [`${add}.s`], 'sign of the sum');
  const same = b.op1(NOT, [b.op1(XOR, [a15, b15])], 'same sign');
  const diff = b.op1(XOR, [s15, a15], 'sum differs');
  b.next();
  const ov = b.op1(AND, [b.op1(AND, [same, diff]), satf], 'saturate');
  const lim = b.op1(merger([15, 1], 2), [b.op1(merger(ones(15), 2), Array(15).fill(b.op1(NOT, [a15]))), a15], "limit for a's sign");
  b.next();
  const addres = b.name(b.op1(busMux2(16), [`${add}.s`, lim, ov], 'sum or limit'), 'addres', true);
  const lg = (['and', 'or', 'xor'] as const).map((op) => b.op1(bitwise(op, 16), ['a', 'b'], op.toUpperCase()));
  const shl = b.op1(shifter(16), ['a', sh, f13, zero], 'a << b');
  const shr = b.op1(shifter(16), ['a', sh, zero, zero], 'a >> b');
  const sar = b.op1(shifter(16), ['a', sh, zero, f15], 'a >>> b');
  b.next();
  b.wire(b.op1(muxTree(4, 16), [...Array(10).fill(addres), ...lg, shl, shr, sar, 'f'], 'result'), 'y');
  const R = b.right;
  return define({
    id: 'dsp24_alu', name: 'ALU (DSP core)', category: 'cpu',
    summary: 'Sixteen bits: add, subtract, saturating add and subtract, AND, OR, XOR, and three shifts. One adder serves all four additive functions (the subtractions invert b and carry in); the saturating ones replace an overflowed sum by the limit for the sign of a.',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bus('f', 4, 'in'), bus('y', 16, 'out')],
    symbol: { kind: 'box', label: 'ALU 16' },
    spec: ([a, bb, f]) => [alu24(a, bb, f)],
    netlist: () => ({ pins: { a: [0, 4], b: [0, 8], f: [0, 12], y: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();
