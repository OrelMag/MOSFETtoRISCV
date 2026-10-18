// The 4-bit CPU (Examples ▸ 4-bit CPU; ISA in src/isa4): a 4004-inspired accumulator machine in six
// blocks read by drilling in, each built from library parts the chapters open: PC & stack, Decode,
// Index registers, ALU, Accumulator & carry, I/O. One instruction per clock: the ROM word goes
// through Decode to controls, and every register takes its next value at the rising edge.
// cpu4(words) joins them with a 256 × 16 program ROM; the sandbox example is its drawing.

import { assemble4 } from '../isa4/asm4';
import { decode4, JCN } from '../isa4/isa4';
import { BCD4 } from '../isa4/programs4';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree, rca } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOR, NOT, OR, XOR } from './gates';
import { DFFE, register } from './sequential';
import { TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);
const outs = (ps: PortDef[]) => ps.filter((p) => p.dir === 'out').map((p) => p.name);

// ---- Decode ----------------------------------------------------------------------------------

/** Decode's outputs, in port order: [name, width]. */
export const CTL4 = [
  ['pcsel', 2], ['push', 1], ['pop', 1], ['rwe', 1], ['winc', 1], ['pwe', 1], ['awe', 1], ['asel', 2],
  ['xa', 1], ['inv', 1], ['bk', 1], ['k', 4], ['cin', 1], ['f', 2], ['cwe', 1], ['csel', 2], ['orcy', 1],
  ['cconst', 1], ['srcwe', 1], ['wrr', 1],
] as const;

/**
 * The control table: what Decode drives for an instruction word, the accumulator, the carry, the
 * TEST pin and rz (the addressed register is 15, so r + 1 wraps to 0). pcsel: next PC = PC + 1,
 * the word's address byte, a pair (JIN) or the stack top (BBL). asel: A ← ALU, r, OPA, switches.
 * The ALU adds (xa ? A : 0) + (bk ? k : inv ? ¬r : r) + cin; f picks sum, ¬A, RAL, RAR; csel picks
 * the carry out (| CY with orcy, for DAA), A3, A0 or cconst.
 */
export function control4(w: number, acc: number, cy: number, test: number, rz: number): Record<(typeof CTL4)[number][0], number> {
  const d = decode4(w);
  const n = d.name, opa = d.opa;
  const is = (...names: string[]) => (names.includes(n) ? 1 : 0);
  const cond = ((opa & JCN.AZ) && acc === 0) || ((opa & JCN.CY) && cy === 1) || ((opa & JCN.TEST0) && test === 0);
  const jump = (n === 'JCN' && Boolean(cond) !== Boolean(opa & JCN.INVERT)) || is('JUN', 'JMS') || (n === 'ISZ' && !rz);
  const adj = acc > 9 || cy === 1;
  return {
    pcsel: n === 'BBL' ? 3 : n === 'JIN' ? 2 : jump ? 1 : 0,
    push: is('JMS'), pop: is('BBL'),
    rwe: is('INC', 'ISZ', 'XCH'), winc: is('INC', 'ISZ'), pwe: is('FIM'),
    awe: is('ADD', 'SUB', 'LD', 'XCH', 'BBL', 'LDM', 'RDR', 'CLB', 'IAC', 'CMA', 'RAL', 'RAR', 'TCC', 'DAC', 'TCS', 'DAA'),
    asel: is('LD', 'XCH') ? 1 : is('BBL', 'LDM') ? 2 : is('RDR') ? 3 : 0,
    xa: 1 - is('TCC', 'TCS', 'CLB'), inv: is('SUB'), bk: 1 - is('ADD', 'SUB'),
    k: n === 'DAC' ? 15 : n === 'TCS' ? 9 : n === 'DAA' && adj ? 6 : 0,
    cin: is('ADD', 'TCC', 'TCS') ? cy : n === 'SUB' ? 1 - cy : is('IAC'),
    f: is('CMA') ? 1 : is('RAL') ? 2 : is('RAR') ? 3 : 0,
    cwe: is('ADD', 'SUB', 'IAC', 'DAC', 'DAA', 'TCC', 'TCS', 'CLB', 'CLC', 'CMC', 'STC', 'RAL', 'RAR'),
    csel: is('RAL') ? 1 : is('RAR') ? 2 : is('CLC', 'CMC', 'STC') ? 3 : 0,
    orcy: is('DAA'), cconst: is('STC') | (is('CMC') & (1 - cy)),
    srcwe: is('SRC'), wrr: is('WRR'),
  };
}

const DECODE_PORTS: PortDef[] = [
  bus('instr', 16, 'in'), bus('acc', 4, 'in'), bit('cy', 'in'), bit('test', 'in'), bit('rz', 'in'),
  ...CTL4.map(([n, w]) => bus(n, w, 'out')),
];

export const CPU4_DECODE: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('instr', 'acc', 'cy', 'test', 'rz');
  const fl = b.op(splitter([8, 4, 4], 4), ['instr'], 'fields');
  const opa = b.name(`${fl}.o1`, 'opa', true);
  const sc = b.op(splitter([1, 1, 1, 1], 2), [opa], 'OPA bits');
  const [c0, c1, c2, c3] = [0, 1, 2, 3].map((i) => b.name(`${sc}.o${i}`, `c${i}`, true));
  const sa = b.op(splitter([1, 1, 1, 1], 2), ['acc'], 'A bits');
  for (const i of [1, 2, 3]) b.name(`${sa}.o${i}`, `a${i}`, true);
  b.next();
  // OPR → one line per opcode; the accumulator group (OPR = 15) → one line per OPA.
  const od = b.op(decoder(4), [`${fl}.o2`], 'OPR');
  const OPR = ['nop', 'jcn', 'fim_src', 'jin', 'jun', 'jms', 'inc', 'isz', 'add', 'sub', 'ld', 'xch', 'bbl', 'ldm', 'io', 'accgrp'];
  const O = OPR.map((nm, i) => b.name(`${od}.y${i}`, nm, true));
  const fd = b.op(decoder(4, true), [opa, O[15]], 'accumulator group');
  const [clb, clc, iac, cmc, cma, ral, rar, tcc, dac, tcs, stc, daa] =
    ['clb', 'clc', 'iac', 'cmc', 'cma', 'ral', 'rar', 'tcc', 'dac', 'tcs', 'stc', 'daa'].map((nm, i) => b.name(`${fd}.y${i}`, nm, true));
  const az = b.name(b.op1(isZero(4), ['acc'], 'A = 0'), 'az', true);
  const nc0 = b.name(b.op1(NOT, [c0]), 'nc0', true);
  const ncy = b.name(b.op1(NOT, ['cy']), 'ncy', true);
  b.next();
  // Jumps: JCN's condition, ISZ's non-zero test, JUN / JMS always.
  const t = b.op1(orN(3), [b.op1(AND, [c2, az], 'A = 0?'), b.op1(AND, [c1, 'cy'], 'CY?'), b.op1(AND, [c0, b.op1(NOT, ['test'])], 'TEST = 0?')]);
  const take = b.op1(AND, [O[1], b.op1(XOR, [t, c3], 'invert?')], 'JCN taken');
  const isz = b.op1(AND, [O[7], b.op1(NOT, ['rz'])], 'ISZ taken');
  const jin = b.op1(AND, [O[3], c0], 'JIN');
  const src = b.name(b.op1(AND, [O[2], c0], 'SRC'), 'src', true);
  const fim = b.name(b.op1(AND, [O[2], nc0], 'FIM'), 'fim', true);
  // I/O group: OPA = 0010 (WRR) or 1010 (RDR).
  const m = b.op1(andN(4), [O[14], b.op1(NOT, [c2]), c1, nc0], 'x010');
  const wrr = b.name(b.op1(AND, [m, b.op1(NOT, [c3])], 'WRR'), 'wrr', true);
  const rdr = b.name(b.op1(AND, [m, c3], 'RDR'), 'rdr', true);
  b.next();
  const jt = b.op1(orN(4), [take, O[4], O[5], isz], 'jump');
  const p0 = b.op1(OR, [jt, O[12]]);
  const p1 = b.op1(OR, [jin, O[12]]);
  const winc = b.name(b.op1(OR, [O[6], O[7]], 'INC / ISZ'), 'winc', true);
  const rwe = b.op1(OR, [winc, O[11]], 'register write');
  const awe = b.op1(orN(16), [O[8], O[9], O[10], O[11], O[12], O[13], rdr, clb, iac, cma, ral, rar, tcc, dac, tcs, daa], 'A write');
  const as0 = b.op1(orN(3), [O[10], O[11], rdr]);
  const as1 = b.op1(orN(3), [O[12], O[13], rdr]);
  const xa = b.op1(NOT, [b.op1(orN(3), [tcc, tcs, clb])], 'A into the adder');
  const bk = b.op1(NOR, [O[8], O[9]], 'constant into the adder');
  // DAA adds 6 when A > 9 or CY: A3 & (A2 | A1) | CY.
  const gt9 = b.op1(AND, [`${sa}.o3`, b.op1(OR, [`${sa}.o2`, `${sa}.o1`])], 'A > 9');
  const adj = b.op1(AND, [daa, b.op1(OR, [gt9, 'cy'])], 'DAA adjusts');
  const kx = b.op1(OR, [dac, tcs], 'k0, k3');
  const ky = b.op1(OR, [dac, adj], 'k1, k2');
  const cin = b.op1(orN(3), [b.op1(AND, [b.op1(orN(3), [O[8], tcc, tcs]), 'cy']), b.op1(AND, [O[9], ncy]), iac], 'carry in');
  const f0 = b.op1(OR, [cma, rar]);
  const f1 = b.op1(OR, [ral, rar]);
  const cwe = b.op1(orN(13), [O[8], O[9], iac, dac, daa, tcc, tcs, clb, clc, cmc, stc, ral, rar], 'CY write');
  const cc = b.op1(orN(3), [clc, cmc, stc], 'CY constant');
  const cs0 = b.op1(OR, [ral, cc]);
  const cs1 = b.op1(OR, [rar, cc]);
  const cconst = b.op1(OR, [stc, b.op1(AND, [cmc, ncy])], 'STC | CMC & ¬CY');
  b.next();
  const pair = (lo: string, hi: string) => b.op1(merger([1, 1], 2), [lo, hi]);
  b.wire(pair(p0, p1), 'pcsel');
  b.wire(O[5], 'push');
  b.wire(O[12], 'pop');
  b.wire(rwe, 'rwe');
  b.wire(winc, 'winc');
  b.wire(fim, 'pwe');
  b.wire(awe, 'awe');
  b.wire(pair(as0, as1), 'asel');
  b.wire(xa, 'xa');
  b.wire(O[9], 'inv');
  b.wire(bk, 'bk');
  b.wire(b.op1(merger([1, 1, 1, 1], 2), [kx, ky, ky, kx], 'k'), 'k');
  b.wire(cin, 'cin');
  b.wire(pair(f0, f1), 'f');
  b.wire(cwe, 'cwe');
  b.wire(pair(cs0, cs1), 'csel');
  b.wire(daa, 'orcy');
  b.wire(cconst, 'cconst');
  b.wire(src, 'srcwe');
  b.wire(wrr, 'wrr');
  const R = b.right;
  return define({
    id: 'cpu4_decode', name: 'Decode (4-bit CPU)', category: 'cpu',
    summary: 'The instruction word → every control signal of the 4-bit CPU: a decoder on OPR (one line per opcode), a second on OPA for the accumulator group, the JCN condition, and OR gates gathering the lines each control needs.',
    ports: DECODE_PORTS,
    symbol: { kind: 'box', label: 'DECODE' },
    spec: ([w, acc, cy, test, rz]) => {
      const c = control4(w, acc, cy, test, rz);
      return CTL4.map(([n]) => c[n]);
    },
    netlist: () => ({ pins: { ...pinsAt(ins(DECODE_PORTS), 0, 4), ...pinsAt(outs(DECODE_PORTS), R, 3) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- ALU -------------------------------------------------------------------------------------

/** The ALU's function: y and the next carry (see control4 for the controls). */
export function alu4(a: number, r: number, cy: number, xa: number, inv: number, bk: number, k: number, cin: number, f: number, csel: number, orcy: number, cconst: number): [number, number] {
  const b = bk ? k : inv ? ~r & 15 : r;
  const s = (xa ? a : 0) + b + cin;
  const y = [s & 15, ~a & 15, ((a << 1) | cy) & 15, (cy << 3) | (a >> 1)][f];
  const c = [(s >> 4) | (orcy & cy), a >> 3, a & 1, cconst][csel];
  return [y, c];
}

const ALU_PORTS: PortDef[] = [
  bus('a', 4, 'in'), bus('r', 4, 'in'), bit('cy', 'in'), bit('xa', 'in'), bit('inv', 'in'), bit('bk', 'in'), bus('k', 4, 'in'),
  bit('cin', 'in'), bus('f', 2, 'in'), bus('csel', 2, 'in'), bit('orcy', 'in'), bit('cconst', 'in'),
  bus('y', 4, 'out'), bit('cout', 'out'),
];

export const CPU4_ALU: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('a', 'r', 'cy', 'xa', 'inv', 'bk', 'k', 'cin', 'f', 'csel', 'orcy', 'cconst');
  const four = (s: string, label?: string) => b.op1(merger([1, 1, 1, 1], 2), [s, s, s, s], label);
  const sa = b.op(splitter([1, 1, 1, 1], 2), ['a'], 'A bits');
  const [a0, a1, a2, a3] = [0, 1, 2, 3].map((i) => b.name(`${sa}.o${i}`, `a${i}`, true));
  const xs = four('xa');
  const is = four('inv');
  b.next();
  const x = b.op1(bitwise('and', 4), ['a', xs], 'A or 0');
  const rr = b.op1(bitwise('xor', 4), ['r', is], 'r or ¬r');
  const na = b.name(b.op1(bitwise('xor', 4), ['a', b.op1(constWord(4, 15), [])], '¬A'), 'na', true);
  b.next();
  const bb = b.op1(busMux2(4), [rr, 'k', 'bk'], 'b');
  const ral = b.name(b.op1(merger([1, 1, 1, 1], 2), ['cy', a0, a1, a2], 'RAL'), 'ral', true);
  const rar = b.name(b.op1(merger([1, 1, 1, 1], 2), [a1, a2, a3, 'cy'], 'RAR'), 'rar', true);
  b.next();
  const add = b.op(rca(4), [x, bb, 'cin'], 'adder');
  b.name(`${add}.s`, 'sum', true);
  b.name(`${add}.cout`, 'co', true);
  b.next();
  b.wire(b.op1(muxTree(2, 4), [`${add}.s`, na, ral, rar, 'f'], 'result'), 'y');
  const co = b.op1(OR, [`${add}.cout`, b.op1(AND, ['orcy', 'cy'], 'DAA keeps CY')]);
  b.next();
  b.wire(b.op1(muxTree(2, 1), [co, a3, a0, 'cconst', 'csel'], 'next CY'), 'cout');
  const R = b.right;
  return define({
    id: 'cpu4_alu', name: 'ALU (4-bit CPU)', category: 'cpu',
    summary: 'One 4-bit adder does ADD, SUB (A + ¬r + ¬CY), IAC, DAC, DAA (+ 6), TCC, TCS and CLB by choosing its operands: A or 0, r, ¬r or a constant k, and the carry in. Beside it: ¬A and the two rotations through the carry.',
    ports: ALU_PORTS,
    symbol: { kind: 'box', label: 'ALU 4' },
    spec: (v) => alu4(...(v as Parameters<typeof alu4>)),
    netlist: () => ({ pins: { ...pinsAt(ins(ALU_PORTS), 0, 4), y: [R, 8], cout: [R, 16] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- Index registers -------------------------------------------------------------------------

const REGS_PORTS: PortDef[] = [
  bus('ra', 4, 'in'), bus('a', 4, 'in'), bus('lo', 8, 'in'), bit('we', 'in'), bit('winc', 'in'), bit('pwe', 'in'), bit('clk', 'in', true),
  bus('r', 4, 'out'), bus('pair', 8, 'out'), bit('rz', 'out'),
];

/**
 * Sixteen 4-bit registers as eight pairs (Pn = R2n:R2n+1, the even one high). One register reads
 * out (r) and its pair (pair, for SRC / JIN); a write takes A (XCH) or r + 1 (INC, ISZ) into the
 * addressed register, or the second byte into a whole pair (FIM).
 */
export const CPU4_REGS: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('ra', 'a', 'lo', 'we', 'winc', 'pwe', 'clk');
  const sr = b.op(splitter([1, 3], 2), ['ra'], 'register');
  const odd = b.name(`${sr}.o0`, 'odd', true), rp = b.name(`${sr}.o1`, 'psel', true);
  const lo = b.op(splitter([4, 4], 2), ['lo'], 'data');
  b.name(`${lo}.o0`, 'lo4', true);
  b.name(`${lo}.o1`, 'hi4', true);
  b.next();
  const pd = b.op(decoder(3), [rp], 'pair');
  const wE = b.name(b.op1(OR, ['pwe', b.op1(AND, ['we', b.op1(NOT, [odd])])], 'write even'), 'wE', true);
  const wO = b.name(b.op1(OR, ['pwe', b.op1(AND, ['we', odd])], 'write odd'), 'wO', true);
  const wd = b.op(busMux2(4), ['a', '', 'winc'], 'A or r + 1');
  b.next();
  const dE = b.name(b.op1(busMux2(4), [`${wd}.y`, `${lo}.o1`, 'pwe'], 'even d'), 'dE', true);
  const dO = b.name(b.op1(busMux2(4), [`${wd}.y`, `${lo}.o0`, 'pwe'], 'odd d'), 'dO', true);
  b.next();
  const en: string[] = [];
  for (let p = 0; p < 8; p++) {
    const sel = b.name(`${pd}.y${p}`, `p${p}`, true);
    en.push(b.name(b.op1(AND, [sel, wE]), `en${2 * p}`, true), b.name(b.op1(AND, [sel, wO]), `en${2 * p + 1}`, true));
  }
  const q: string[] = [];
  for (let i = 0; i < 16; i++) {
    if (i === 8) b.next(); else if (i === 0) b.next();
    q.push(b.name(b.op1(register(4), [i % 2 ? dO : dE, en[i], 'clk'], `R${i}`, `r${i}`), `R${i}`, true));
  }
  b.next();
  const pq: string[] = [];
  for (let p = 0; p < 8; p++) pq.push(b.op1(merger([4, 4], 2), [q[2 * p + 1], q[2 * p]], `P${p}`));
  b.next();
  const pair = b.name(b.op1(muxTree(3, 8), [...pq, rp], 'read pair'), 'pairv', true);
  b.next();
  const ps = b.op(splitter([4, 4], 2), [pair]);
  b.next();
  const r = b.name(b.op1(busMux2(4), [`${ps}.o1`, `${ps}.o0`, odd], 'read register'), 'rv', true);
  b.next();
  const inc = b.op(incrementer(4), [r], 'r + 1');
  b.wire(`${inc}.y`, `${wd}.b`);
  b.wire(r, 'r');
  b.wire(pair, 'pair');
  b.wire(`${inc}.cout`, 'rz');
  const R = b.right;
  return define({
    id: 'cpu4_regs', name: 'Index registers (4-bit CPU)', category: 'cpu',
    summary: 'Sixteen 4-bit registers, R0–R15, in eight pairs. Reads the register OPA names and its pair; writes A (XCH) or r + 1 (INC, ISZ) into one register, or a byte into a whole pair (FIM). rz: r + 1 wraps to 0.',
    ports: REGS_PORTS,
    symbol: { kind: 'box', label: 'REGS 16×4' },
    netlist: () => ({ pins: { ...pinsAt(ins(REGS_PORTS), 0, 4), r: [R, 6], pair: [R, 12], rz: [R, 18] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- Accumulator & carry ---------------------------------------------------------------------

const ACC_PORTS: PortDef[] = [
  bus('alu', 4, 'in'), bus('r', 4, 'in'), bus('imm', 4, 'in'), bus('sw', 4, 'in'), bus('asel', 2, 'in'), bit('awe', 'in'),
  bit('cyn', 'in'), bit('cwe', 'in'), bit('clk', 'in', true),
  bus('a', 4, 'out'), bit('cy', 'out'),
];

export const CPU4_ACC: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('alu', 'r', 'imm', 'sw', 'asel', 'awe', 'cyn', 'cwe', 'clk');
  const m = b.op1(muxTree(2, 4), ['alu', 'r', 'imm', 'sw', 'asel'], 'next A');
  b.next();
  b.wire(b.op1(register(4), [m, 'awe', 'clk'], 'A', 'a'), 'a');
  b.wire(b.op1(DFFE, ['cyn', 'cwe', 'clk'], 'CY', 'cy'), 'cy');
  const R = b.right;
  return define({
    id: 'cpu4_acc', name: 'Accumulator & carry (4-bit CPU)', category: 'cpu',
    summary: 'A takes the ALU\'s result, a register (LD, XCH), the instruction\'s OPA (LDM, BBL) or the switches (RDR) when awe = 1; the carry flip-flop takes the ALU\'s next carry when cwe = 1.',
    ports: ACC_PORTS,
    symbol: { kind: 'box', label: 'ACC' },
    netlist: () => ({ pins: { ...pinsAt(ins(ACC_PORTS), 0, 4), a: [R, 8], cy: [R, 16] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- PC & stack ------------------------------------------------------------------------------

const PC_PORTS: PortDef[] = [
  bus('sel', 2, 'in'), bus('target', 8, 'in'), bus('pair', 8, 'in'), bit('push', 'in'), bit('pop', 'in'), bit('clk', 'in', true),
  bus('pc', 8, 'out'),
];

/** PC and a three-level return stack: a call shifts PC + 1 in at the top, a return shifts the stack up (the bottom keeps its value). */
export const CPU4_PC: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('sel', 'target', 'pair', 'push', 'pop', 'clk');
  const inc = b.op(incrementer(8), [''], 'PC + 1');
  const pc1 = b.name(`${inc}.y`, 'pc1', true);
  const any = b.name(b.op1(OR, ['push', 'pop'], 'call or return'), 'move', true);
  b.next();
  const next = b.op(muxTree(2, 8), [pc1, 'target', 'pair', '', 'sel'], 'next PC');
  const d1 = b.op(busMux2(8), ['', pc1, 'push'], 'S1 ← S2 or PC + 1');
  const d2 = b.op(busMux2(8), ['', '', 'push'], 'S2 ← S3 or S1');
  b.next();
  const one = b.op1(TIE1, []);
  const pc = b.name(b.op1(register(8), [`${next}.y`, one, 'clk'], 'PC', 'pc'), 'pcv', true);
  const s1 = b.name(b.op1(register(8), [`${d1}.y`, any, 'clk'], 'S1', 's1'), 's1v', true);
  const s2 = b.name(b.op1(register(8), [`${d2}.y`, any, 'clk'], 'S2', 's2'), 's2v', true);
  const s3 = b.name(b.op1(register(8), [s2, 'push', 'clk'], 'S3', 's3'), 's3v', true);
  b.wire(pc, `${inc}.a`);
  b.wire(s1, `${next}.d3`);
  b.wire(s2, `${d1}.a`);
  b.wire(s3, `${d2}.a`);
  b.wire(s1, `${d2}.b`);
  b.wire(pc, 'pc');
  const R = b.right;
  return define({
    id: 'cpu4_pc', name: 'PC & stack (4-bit CPU)', category: 'cpu',
    summary: 'An 8-bit PC loading PC + 1, a jump address, a pair (JIN) or the stack top (BBL), and three return addresses that shift down on a call (JMS) and up on a return. A fourth call drops the oldest, as on the 4004.',
    ports: PC_PORTS,
    symbol: { kind: 'box', label: 'PC & STACK' },
    netlist: () => ({ pins: { ...pinsAt(ins(PC_PORTS), 0, 4), pc: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- I/O -------------------------------------------------------------------------------------

/** Output ports the I/O block has (0–3 digits, 4 LEDs). */
export const IO4_OUTS = ['d0', 'd1', 'd2', 'd3', 'leds'] as const;

const IO_PORTS: PortDef[] = [
  bus('pair', 8, 'in'), bit('srcwe', 'in'), bus('a', 4, 'in'), bit('wrr', 'in'), bit('clk', 'in', true),
  ...IO4_OUTS.map((n) => bus(n, 4, 'out')),
];

export const CPU4_IO: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('pair', 'srcwe', 'a', 'wrr', 'clk');
  const src = b.op1(register(8), ['pair', 'srcwe', 'clk'], 'SRC', 'src');
  b.next();
  const s = b.op(splitter([4, 3, 1], 2), [src], 'port number');
  b.next();
  const en = b.op1(AND, ['wrr', b.op1(NOT, [`${s}.o2`])], 'port < 8');
  b.next();
  const dec = b.op(decoder(3, true), [`${s}.o1`, en], 'which port');
  b.next();
  IO4_OUTS.forEach((n, i) => b.wire(b.op1(register(4), ['a', `${dec}.y${i}`, 'clk'], n === 'leds' ? 'LEDs' : `port ${i}`, `port${i}`), n));
  const R = b.right;
  return define({
    id: 'cpu4_io', name: 'I/O (4-bit CPU)', category: 'cpu',
    summary: 'SRC latches a pair as the port address; WRR writes A into output port (address bits 7–4): 0–3 the digits, 4 the LEDs. Higher port numbers write nothing.',
    ports: IO_PORTS,
    symbol: { kind: 'box', label: 'I/O' },
    netlist: () => ({ pins: { ...pinsAt(ins(IO_PORTS), 0, 4), ...pinsAt([...IO4_OUTS], R, 4) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- program ROM and the computer ------------------------------------------------------------

function hash(words: ArrayLike<number>): string {
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) { h ^= words[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

const roms = new Map<string, ComponentDef>();

/**
 * The 256 × 16 program ROM: a multiplexer tree of constants, simulated as a lookup. Its ports and
 * symbol are the sandbox ROM part's (8-bit addr, 16-bit data, a box labelled ROM), so the example
 * places a ROM part where the drawing has this one.
 */
export function rom4(words: ArrayLike<number>): ComponentDef {
  const content = Array.from({ length: 256 }, (_, i) => (words[i] ?? 0) & 0xffff);
  const key = hash(content);
  let d = roms.get(key);
  if (d) return d;
  const M = muxTree(8, 16, 4);
  const mg = symbolGeom(M);
  d = {
    id: `cpu4_rom_${key}`, name: 'Program ROM 256×16', category: 'memory',
    summary: '256 words of 16 bits, read-only: a 256:1 multiplexer tree whose inputs are tied to the program\'s bits.',
    ports: [bus('addr', 8, 'in'), bus('data', 16, 'out')],
    symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : content[a & 255]], delay: 24 },
    preferBehavior: true,
    spec: ([a]) => [content[a & 255]],
    netlist: () => {
      const instances: InstanceDef[] = [{ name: 'mux', def: M, at: [16, 0] }];
      const nets: NetDef[] = [
        { name: 'addr', ends: ['addr', 'mux.s'], via: { 'mux.s': [[16 + mg.ports.s.pos[0], mg.h + 7]] } },
        { name: 'data', ends: ['mux.y', 'data'] },
      ];
      content.forEach((v, i) => {
        instances.push({ name: `c${i}`, def: constWord(16, v), at: [8, mg.ports[`d${i}`].pos[1] - 1], label: `[${i}]` });
        nets.push({ ends: [`c${i}.y`, `mux.d${i}`] });
      });
      return { pins: { addr: [0, mg.h + 7], data: [16 + mg.w + 6, mg.ports.y.pos[1]] }, instances, nets };
    },
  };
  roms.set(key, d);
  return d;
}

export const CPU4_PORTS: PortDef[] = [
  bit('clk', 'in', true), bit('test', 'in'), bus('sw', 4, 'in'),
  ...IO4_OUTS.map((n) => bus(n, 4, 'out')), bit('halt', 'out'),
];

const cpus = new Map<string, ComponentDef>();

/**
 * Everything of the 4-bit CPU but its program memory, from the instruction word on: its fields and the halt detector
 * (the word is JUN to its own address), then Decode over the index registers, the ALU over the accumulator, the PC &
 * stack over the I/O ports (which run straight out). The PC also goes to `pcSinks` (the ROM's address, or a pin).
 */
function cpu4Body(b: Builder, instr: string, pcSinks: string[]): void {
  const fl = b.op(splitter([8, 4, 4], 4), [instr], 'fields');
  const lo = b.name(`${fl}.o0`, 'lo', true), opa = b.name(`${fl}.o1`, 'opa', true);
  // Halt: the word is JUN (0x40) to its own address.
  const hi = b.op1(merger([4, 4], 2), [opa, b.name(`${fl}.o2`, 'opr', true)], 'OPR:OPA');
  const isJun = b.op1(equal(8), [hi, b.op1(constWord(8, 0x40), [], 'JUN')], 'JUN?');
  const self = b.op(equal(8), [lo, ''], 'to itself?');
  b.next();
  const dec = b.op(CPU4_DECODE, [instr, '', '', 'test', ''], 'Decode', 'dec');
  const c = (n: string) => b.name(`${dec}.${n}`, n, true);
  const regs = b.op(CPU4_REGS, [opa, '', lo, c('rwe'), c('winc'), c('pwe'), 'clk'], 'Index regs', 'regs');
  const r = b.name(`${regs}.r`, 'r', true), pair = b.name(`${regs}.pair`, 'pair', true);
  b.wire(b.name(`${regs}.rz`, 'rz', true), `${dec}.rz`);
  b.wire(b.name(b.op1(AND, [isJun, `${self}.eq`], 'halt'), 'halts', true), 'halt');
  b.next();
  const alu = b.op(CPU4_ALU, ['', r, '', c('xa'), c('inv'), c('bk'), c('k'), c('cin'), c('f'), c('csel'), c('orcy'), c('cconst')], 'ALU 4', 'alu');
  const acc = b.op(CPU4_ACC, [b.name(`${alu}.y`, 'result', true), r, opa, 'sw', c('asel'), c('awe'), b.name(`${alu}.cout`, 'cyn', true), c('cwe'), 'clk'], 'Acc & carry', 'acc');
  const a = b.name(`${acc}.a`, 'a', true), cy = b.name(`${acc}.cy`, 'cy', true);
  for (const s of [`${dec}.acc`, `${regs}.a`, `${alu}.a`]) b.wire(a, s);
  for (const s of [`${dec}.cy`, `${alu}.cy`]) b.wire(cy, s);
  b.next();
  const pcs = b.op(CPU4_PC, [c('pcsel'), lo, pair, c('push'), c('pop'), 'clk'], 'PC & stack', 'pcs');
  const pc = b.name(`${pcs}.pc`, 'pc', true);
  for (const s of pcSinks) b.wire(pc, s);
  b.wire(pc, `${self}.b`);
  const io = b.op(CPU4_IO, [pair, c('srcwe'), a, c('wrr'), 'clk'], 'I/O', 'io');
  IO4_OUTS.forEach((n) => b.wire(`${io}.${n}`, n));
}

/**
 * The 4-bit computer: program ROM, the six blocks, and a halt detector (the word is JUN to its own
 * address). Inputs: the TEST pin and four switches; outputs: four digits, four LEDs, halt.
 */
export function cpu4(words: ArrayLike<number>): ComponentDef {
  const R0 = rom4(words);
  let d = cpus.get(R0.id);
  if (d) return d;
  const b = new Builder(10, 12, 6);
  b.pins('clk', 'test', 'sw');
  // Four columns: the ROM and its fields (with the halt detector), Decode over the index registers,
  // the ALU over the accumulator, the PC & stack over the I/O ports (which run straight out).
  const rom = b.op(R0, [''], 'program', 'rom');
  cpu4Body(b, b.name(`${rom}.data`, 'instr', true), [`${rom}.addr`]);
  const R = b.right;
  d = define({
    id: `cpu4_${R0.id.slice('cpu4_rom_'.length)}`, name: '4-bit CPU (4004-inspired)', category: 'cpu',
    summary: 'A 4-bit accumulator machine with the 4004\'s instructions, one per 16-bit ROM word and per clock: PC & stack, a 256-word program ROM, Decode, sixteen 4-bit index registers, a 4-bit ALU, the accumulator and carry, and SRC / WRR output ports for four digits and four LEDs.',
    ports: CPU4_PORTS,
    symbol: { kind: 'box', label: 'CPU 4' },
    netlist: () => ({ pins: { ...pinsAt(ins(CPU4_PORTS), 0, 6), ...pinsAt(outs(CPU4_PORTS), R, 6) }, instances: b.instances, nets: b.nets() }),
  });
  cpus.set(R0.id, d);
  return d;
}

/** Paths of the architectural state in cpu4() (and the sandbox example): [what, instance path, port]. */
export const CPU4_STATE = {
  pc: 'pcs.pc', stack: ['pcs.s1', 'pcs.s2', 'pcs.s3'], a: 'acc.a', cy: 'acc.cy', src: 'io.src',
  regs: Array.from({ length: 16 }, (_, i) => `regs.r${i}`), ports: IO4_OUTS.map((_, i) => `io.port${i}`),
} as const;

// Built at load (the example's program), so the layout and routing checks cover the whole computer.
export const CPU4_BCD = cpu4(assemble4(BCD4).words);

export const CPU4_CORE_PORTS: PortDef[] = [
  bit('clk', 'in', true), bit('test', 'in'), bus('sw', 4, 'in'), bus('instr', 16, 'in'),
  bus('pc', 8, 'out'), ...IO4_OUTS.map((n) => bus(n, 4, 'out')), bit('halt', 'out'),
];

/**
 * The 4-bit CPU without its ROM: the instruction word comes in on `instr` and the PC goes out on `pc`, so a program
 * memory of any kind can sit outside (Act P's card loader fills a RAM, then hands it to this core). The same blocks,
 * wired the same way, as cpu4(); the halt detector stays inside.
 */
export const CPU4_CORE: ComponentDef = (() => {
  const b = new Builder(18, 12, 6);
  b.pins('clk', 'test', 'sw', 'instr');
  cpu4Body(b, 'instr', ['pc']);
  const R = b.right;
  return define({
    id: 'cpu4_proc', name: '4-bit CPU without ROM', category: 'cpu',
    summary: 'The 4-bit CPU with an instruction port instead of its ROM: it shows its PC on pc and executes the 16-bit word on instr at every rising clk edge. PC & stack, Decode, sixteen 4-bit index registers, a 4-bit ALU, the accumulator and carry, SRC / WRR output ports for four digits and four LEDs; halt = 1 while instr is a JUN to its own address.',
    ports: CPU4_CORE_PORTS,
    symbol: { kind: 'box', label: 'CPU 4 CORE' },
    netlist: () => ({ pins: { ...pinsAt(ins(CPU4_CORE_PORTS), 0, 6), ...pinsAt(outs(CPU4_CORE_PORTS), R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();
