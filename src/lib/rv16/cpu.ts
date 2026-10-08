// The campaign's act 5 blocks: the immediate generator (pure wiring), the control unit (the opcode
// table as logic), the branch comparator, the next-PC logic, and the single-cycle RV16 core that
// joins them with the register file, the ALU and the program counter. Each uses only the parts
// the levels below it unlock, so each is that level's reference solution.

import type { ComponentDef, PortDef } from '../../sim/types';
import { alu, constWord } from '../alu';
import { koggeStone } from '../fastadd';
import { Builder } from '../builder';
import { busMux2, decoder, incrementer, muxTree } from '../combinational';
import { define, merger, splitter } from '../define';
import { AND, MUX2, NOT, OR, XOR } from '../gates';
import { orN } from '../wide';
import { TIE0 } from '../transistors';
import { ADD16, CMP16, EQ16, PC16, RF8 } from './logic';
import { DIV16, MUL16 } from './md';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

/** The four immediates of an instruction word, sign-extended (U: the value lui loads). */
export function immediates(w: number): [number, number, number, number] {
  const sx = (v: number, b: number) => (v & (1 << (b - 1)) ? v - (1 << b) : v) & 0xffff;
  const i = sx(w >> 10, 6);
  const sb = sx((((w >> 13) & 7) << 3) | ((w >> 4) & 7), 6);
  const j = sx(w >> 7, 9);
  const u = (((((w >> 7) & 0x1ff) << 1) | ((w >> 3) & 1)) << 6) & 0xffff;
  return [i, sb, j, u];
}

/** Immediate generator: every format's immediate, by wiring alone. */
export const IMM16: ComponentDef = (() => {
  const b = new Builder(8, 16, 6);
  b.pins('instr');
  // Fields: [1:0] [3:2]… are not needed; split at the boundaries the immediates use.
  const s = b.op(splitter([3, 1, 3, 3, 3, 2, 1], 4), ['instr'], 'fields');
  const z6 = b.op1(constWord(6, 0), [], '0');
  const sign = b.name(`${s}.o6`, 'sign', true);
  const f = (k: number) => b.name(`${s}.o${k}`, ['op', 'i3', 'f6_4', 'f9_7', 'f12_10', 'f14_13'][k], true);
  b.next();
  const ten = Array(10).fill(sign);
  b.wire(b.op1(merger([3, 2, 1, ...Array(10).fill(1)], 2), [f(4), f(5), sign, ...ten], 'I'), 'i');
  b.wire(b.op1(merger([3, 2, 1, ...Array(10).fill(1)], 2), [f(2), f(5), sign, ...ten], 'S / B'), 'sb');
  b.wire(b.op1(merger([3, 3, 2, 1, ...Array(7).fill(1)], 2), [f(3), f(4), f(5), sign, ...Array(7).fill(sign)], 'J'), 'j');
  b.wire(b.op1(merger([6, 1, 3, 3, 2, 1], 4), [z6, f(1), f(3), f(4), f(5), sign], 'U'), 'u');
  const R = b.right;
  return define({
    id: 'rv16_imm', name: 'Immediate generator (RV16)', category: 'cpu',
    summary: 'The I, S/B, J and U immediates of an instruction word, sign-extended to 16 bits: splitters, mergers and the sign bit fanned out. No gates at all.',
    ports: [bus('instr', 16, 'in'), bus('i', 16, 'out'), bus('sb', 16, 'out'), bus('j', 16, 'out'), bus('u', 16, 'out')],
    symbol: { kind: 'box', label: 'IMM' },
    spec: ([w]) => immediates(w),
    netlist: () => ({ pins: { instr: [0, 8], ...pinsAt(['i', 'sb', 'j', 'u'], R) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Control signals, in port order. */
export const CTL_OUTS = ['rwe', 'bimm', 'isel', 'alu', 'mwe', 'wb', 'br', 'jal', 'jalr'] as const;
export const CTL_WIDTHS = [1, 1, 2, 4, 1, 2, 1, 1, 1];

/**
 * The control unit's table: outputs and which bits matter (a don't-care is free to be anything).
 * isel: 0 I, 1 S/B, 2 J, 3 U. wb: 0 ALU, 1 memory, 2 pc + 1, 3 the immediate (lui).
 * MD and SYSTEM instructions are not part of RV16I: they do nothing.
 */
export function controlSpec(w: number): { out: number[]; care: number[] } {
  const op = w & 15, f3 = (w >> 13) & 7;
  const lui = (op & 7) === 7;
  let rwe = 0, bimm = 0, isel = 0, aluc = 0, mwe = 0, wb = 0, br = 0, jal = 0, jalr = 0;
  let cB = 0, cI = 0, cA = 0, cW = 0;
  if (op === 1 || op === 2) { rwe = 1; aluc = (op === 2 ? 8 : 0) | f3; cB = cA = cW = 1; }
  else if (op === 4) { rwe = 1; bimm = 1; cB = cI = cA = cW = 1; }
  else if (op === 5) { rwe = 1; bimm = 1; const t = f3 >> 1; aluc = t === 0 ? 1 : t & 2 ? 13 : 5; cB = cI = cA = cW = 1; }
  else if (op === 6) { rwe = 1; bimm = 1; wb = 1; cB = cI = cA = cW = 1; }
  else if (lui) { rwe = 1; isel = 3; wb = 3; cI = cW = 1; }
  else if (op >= 8 && op <= 11) { br = 1; isel = 1; cI = 1; }
  else if (op === 12) { rwe = 1; jal = 1; isel = 2; wb = 2; cI = cW = 1; }
  else if (op === 13) { rwe = 1; jalr = 1; isel = 0; wb = 2; cI = cW = 1; }
  else if (op === 14) { mwe = 1; bimm = 1; isel = 1; cB = cI = cA = 1; }
  return { out: [rwe, bimm, isel, aluc, mwe, wb, br, jal, jalr], care: [1, cB, cI ? 3 : 0, cA ? 15 : 0, 1, cW ? 3 : 0, 1, 1, 1] };
}

/** The control unit: a 4→16 decoder on the opcode, then an OR per signal. */
export const CTL16: ComponentDef = (() => {
  const b = new Builder(8, 14, 4);
  b.pins('instr');
  const s = b.op(splitter([4, 9, 1, 1, 1], 4), ['instr'], 'op, f3');
  const f0 = b.name(`${s}.o2`, 'f0', true), f1 = b.name(`${s}.o3`, 'f1', true), f2 = b.name(`${s}.o4`, 'f2', true);
  b.next();
  const dec = b.op(decoder(4), [`${s}.o0`], 'opcode');
  const y = (k: number) => b.name(`${dec}.y${k}`, `y${k}`, true);
  b.next();
  const or = (xs: string[], label: string): string => {
    if (xs.length === 1) return xs[0];
    if (xs.length === 2) return b.op1(OR, xs, label);
    const n = xs.length <= 3 ? 3 : xs.length <= 4 ? 4 : 8;
    const pad = [...xs];
    while (pad.length < n) pad.push(b.op1(TIE0, []));
    return b.op1(orN(n), pad, label);
  };
  const lui = or([y(7), y(15)], 'LUI');
  const opx = y(2), shi = y(5);
  const alu1 = or([y(1), opx], 'OP | OPX');
  b.next();
  const rwe = or([y(1), y(2), y(4), y(5), y(6), y(12), y(13), lui], 'rwe');
  const bimm = or([y(4), y(5), y(6), y(14)], 'bimm');
  const isel0 = or([y(8), y(9), y(10), y(11), y(14), lui], 'isel0');
  const isel1 = or([y(12), lui], 'isel1');
  const br = or([y(8), y(9), y(10), y(11)], 'br');
  const wb0 = or([y(6), lui], 'wb0');
  const wb1 = or([y(12), y(13), lui], 'wb1');
  const a0r = b.op1(AND, [alu1, f0]);
  const a1 = b.op1(AND, [alu1, f1], 'alu1');
  const a2r = b.op1(AND, [alu1, f2]);
  const t = b.op1(OR, [f2, f1], 'shift right?');
  const a3s = b.op1(AND, [shi, f2]);
  b.next();
  const a2s = b.op1(AND, [shi, t]);
  const a0 = b.op1(OR, [a0r, shi], 'alu0');
  const a3 = b.op1(OR, [opx, a3s], 'alu3');
  b.next();
  const a2 = b.op1(OR, [a2r, a2s], 'alu2');
  b.next();
  b.wire(rwe, 'rwe');
  b.wire(bimm, 'bimm');
  b.wire(b.op1(merger([1, 1], 2), [isel0, isel1], 'isel'), 'isel');
  b.wire(b.op1(merger([1, 1, 1, 1], 2), [a0, a1, a2, a3], 'alu'), 'alu');
  b.wire(y(14), 'mwe');
  b.wire(b.op1(merger([1, 1], 2), [wb0, wb1], 'wb'), 'wb');
  b.wire(br, 'br');
  b.wire(y(12), 'jal');
  b.wire(y(13), 'jalr');
  const R = b.right;
  return define({
    id: 'rv16_ctl', name: 'Control unit (RV16)', category: 'cpu',
    summary: 'Opcode → control signals: a 4→16 decoder, then each signal is the OR of the opcodes that need it. The ALU operation is {OPX, f3} (shifts: from the shift type).',
    ports: [bus('instr', 16, 'in'), ...CTL_OUTS.map((n, i) => (CTL_WIDTHS[i] > 1 ? bus(n, CTL_WIDTHS[i], 'out') : bit(n, 'out')))],
    symbol: { kind: 'box', label: 'CONTROL' },
    spec: ([w]) => controlSpec(w).out,
    netlist: () => ({ pins: { instr: [0, 8], ...pinsAt([...CTL_OUTS], R, 3) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Branch decision: cond = op[1:0]: 00 eq, 01 ne, 10 lt, 11 ge (bit 0 inverts). */
export const BRANCH16: ComponentDef = (() => {
  const b = new Builder(8, 14, 6);
  b.pins('a', 'b', 'cond');
  const c = b.op(splitter([1, 1], 4), ['cond']);
  const eq = b.op(EQ16, ['a', 'b'], 'a = b');
  const lt = b.op(CMP16, ['a', 'b'], 'a < b');
  b.next();
  const pick = b.op1(MUX2, [`${eq}.eq`, `${lt}.lt`, `${c}.o1`], 'eq or lt');
  b.next();
  b.wire(b.op1(XOR, [pick, `${c}.o0`], 'invert?'), 'take');
  const R = b.right;
  return define({
    id: 'rv16_branch', name: 'Branch comparator (RV16)', category: 'cpu',
    summary: 'take = beq: a = b, bne: a ≠ b, blt: a < b (signed), bge: a ≥ b. Bit 1 of the condition picks equality or less-than, bit 0 inverts.',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bus('cond', 2, 'in'), bit('take', 'out')],
    symbol: { kind: 'box', label: 'BRANCH' },
    spec: ([a, bb, cond]) => {
      const s = (v: number) => (v & 0x8000 ? v - 0x10000 : v);
      const r = cond & 2 ? s(a) < s(bb) : a === bb;
      return [Number(r) ^ (cond & 1)];
    },
    netlist: () => ({ pins: { ...pinsAt(['a', 'b', 'cond'], 0), take: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Next PC: pc + 1, or pc + imm (taken branch, jal), or rs1 + imm (jalr). fast: Kogge–Stone adders. */
function nextPc(fast: boolean): ComponentDef {
  const b = new Builder(18, 14, 6);
  const ADD = fast ? koggeStone(16) : ADD16;
  b.pins('pc', 'imm', 'rs1', 'br', 'take', 'jal', 'jalr');
  const zero = b.op1(TIE0, []);
  const inc = b.op(incrementer(16), ['pc'], 'pc + 1');
  const ta = b.op(ADD, ['pc', 'imm', zero], 'pc + imm');
  const tb = b.op(ADD, ['rs1', 'imm', zero], 'rs1 + imm');
  const taken = b.op1(AND, ['br', 'take'], 'branch taken');
  b.next();
  const j = b.op1(OR, ['jal', 'jalr']);
  b.next();
  b.wire(b.op1(OR, [j, taken], 'redirect'), 'ld');
  b.wire(b.op1(busMux2(16), [`${ta}.s`, `${tb}.s`, 'jalr'], 'target'), 'target');
  b.wire(`${inc}.y`, 'pc1');
  const R = b.right;
  return define({
    id: fast ? 'rv16_nextpc_ks' : 'rv16_nextpc', name: fast ? 'Next-PC logic (RV16, fast adders)' : 'Next-PC logic (RV16)', category: 'cpu',
    summary: 'ld = jal | jalr | (branch & taken); target = jalr ? rs1 + imm : pc + imm; pc1 = pc + 1 (the link value of jal / jalr).',
    ports: [bus('pc', 16, 'in'), bus('imm', 16, 'in'), bus('rs1', 16, 'in'), bit('br', 'in'), bit('take', 'in'), bit('jal', 'in'), bit('jalr', 'in'),
      bit('ld', 'out'), bus('target', 16, 'out'), bus('pc1', 16, 'out')],
    symbol: { kind: 'box', label: 'NEXT PC' },
    spec: ([pc, imm, rs1, br, take, jal, jalr]) => [(jal | jalr | (br & take)) ? 1 : 0, ((jalr ? rs1 : pc) + imm) & 0xffff, (pc + 1) & 0xffff],
    netlist: () => ({ pins: { ...pinsAt(['pc', 'imm', 'rs1', 'br', 'take', 'jal', 'jalr'], 0), ld: [R, 4], target: [R, 8], pc1: [R, 12] }, instances: b.instances, nets: b.nets() }),
  });
}

export const NEXTPC16 = nextPc(false);
export const NEXTPC16F = nextPc(true);

/** The pins every core level shares (memories are outside: the test bench serves them). */
export const CORE_PORTS: PortDef[] = [
  bit('clk', 'in'), bit('rst', 'in'), bus('instr', 16, 'in'), bus('drdata', 16, 'in'),
  bus('pc', 16, 'out'), bus('daddr', 16, 'out'), bus('dwdata', 16, 'out'), bit('dwe', 'out'),
  bit('rwe', 'out'), bus('rwa', 3, 'out'), bus('rwd', 16, 'out'),
];

const cores = new Map<string, ComponentDef>();

/** The MD opcode in a single-cycle core: multiplies only, or multiplies and (stalling) divides. */
export type CoreMd = '' | 'mul' | 'div';

/**
 * The single-cycle RV16 core. full = false: no branch or jump hardware (the PC only counts), the
 * reference for the first two core levels; full = true: all of RV16I. md: the MD opcode too (full
 * only): a multiplier on the result mux, and a divider that holds the PC until it is done.
 */
export function rv16Core(full: boolean, fast = false, md: CoreMd = ''): ComponentDef {
  const key = `${full ? 'full' : 'straight'}${fast ? '_ks' : ''}${md ? `_${md}` : ''}`;
  let d = cores.get(key);
  if (d) return d;
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'rst', 'instr', 'drdata');
  const f = b.op(splitter([2, 2, 3, 3, 3, 3], 4), ['instr'], 'fields');
  const cond = b.name(`${f}.o0`, 'cond', true), rd = b.name(`${f}.o2`, 'rd', true);
  const rs1 = b.name(`${f}.o3`, 'rs1f', true), rs2 = b.name(`${f}.o4`, 'rs2f', true);
  b.next();
  const ctl = b.op(CTL16, ['instr'], 'control');
  const imm = b.op(IMM16, ['instr'], 'immediates');
  b.next();
  const immv = b.name(b.op1(muxTree(2, 16), [`${imm}.i`, `${imm}.sb`, `${imm}.j`, `${imm}.u`, `${ctl}.isel`], 'imm'), 'imm', true);
  let rwe = b.name(`${ctl}.rwe`, 'rwe', true);
  const rf = b.op(RF8, [rd, md ? '' : rwe, '', rs1, rs2, 'clk'], 'registers');
  const r1 = b.name(`${rf}.rd1`, 'r1', true), r2 = b.name(`${rf}.rd2`, 'r2', true);
  b.next();
  const bsrc = b.op1(busMux2(16), [r2, immv, `${ctl}.bimm`], 'ALU b');
  b.next();
  const y = b.name(`${b.op(alu(16, fast ? 'ks' : 'rca'), [r1, bsrc, `${ctl}.alu`], 'ALU')}.y`, 'aluy', true);
  let ld: string, target: string, pc1: string;
  let np = '';
  if (full) {
    const take = b.op1(BRANCH16, [r1, r2, cond], 'branch?');
    b.next();
    np = b.op(fast ? NEXTPC16F : NEXTPC16, ['', immv, r1, `${ctl}.br`, take, `${ctl}.jal`, `${ctl}.jalr`], 'next PC');
    ld = `${np}.ld`;
    target = `${np}.target`;
    pc1 = `${np}.pc1`;
  } else {
    ld = b.op1(TIE0, []);
    target = b.op1(constWord(16, 0), []);
    pc1 = b.op1(constWord(16, 0), [], 'no jumps');
  }
  b.next();
  let wbv = b.name(b.op1(muxTree(2, 16), [y, 'drdata', pc1, immv, `${ctl}.wb`], 'result'), 'wbv', true);
  let hold = '';
  if (md) {
    // MD = opcode 0011; f3[2] picks a divide, f3[1:0] the variant.
    const ops = b.op(splitter([1, 1, 1, 1], 2), [b.op1(merger([2, 2], 2), [cond, `${f}.o1`])], 'opcode');
    const fs = b.op(splitter([2, 1], 2), [`${f}.o5`], 'f3');
    b.next();
    const lo = b.op1(AND, [`${ops}.o0`, `${ops}.o1`]);
    const hi = b.op1(OR, [`${ops}.o2`, `${ops}.o3`]);
    const mul = b.op1(MUL16, [r1, r2, `${fs}.o0`], 'multiplier');
    b.next();
    const isMd = b.name(b.op1(AND, [lo, b.op1(NOT, [hi])], 'MD?'), 'md', true);
    let mdY = mul, mdWe = isMd;
    if (md === 'div') {
      const start = b.op1(AND, [isMd, `${fs}.o1`], 'divide?');
      b.next();
      const dv = b.op(DIV16, ['clk', start, r1, r2, `${fs}.o0`], 'divider');
      b.next();
      hold = b.name(b.op1(AND, [start, b.op1(NOT, [`${dv}.done`])], 'wait for the divider'), 'stall', true);
      mdY = b.op1(busMux2(16), [mul, `${dv}.y`, `${fs}.o1`], 'mul or div');
      b.next();
      mdWe = b.op1(AND, [isMd, b.op1(NOT, [hold])]);
    }
    b.next();
    rwe = b.name(b.op1(OR, [rwe, mdWe], 'rwe'), 'rwe2', true);
    wbv = b.name(b.op1(busMux2(16), [wbv, mdY, isMd], 'or MD'), 'wbv2', true);
    b.wire(rwe, `${rf}.we`);
  }
  b.wire(wbv, `${rf}.wd`);
  b.next();
  if (hold) {
    ld = b.op1(OR, [ld, hold], 'load (or hold)');
    target = b.op1(busMux2(16), [target, '', hold], 'hold: pc');
  }
  const pc = b.op(PC16, ['rst', ld, target, 'clk'], 'PC');
  b.name(`${pc}.pc`, 'pc', true);
  if (np) b.wire(`${pc}.pc`, `${np}.pc`);
  if (hold) b.wire(`${pc}.pc`, `${target.split('.')[0]}.b`);
  b.wire(`${pc}.pc`, 'pc');
  b.wire(y, 'daddr');
  b.wire(r2, 'dwdata');
  b.wire(`${ctl}.mwe`, 'dwe');
  b.wire(rwe, 'rwe');
  b.wire(rd, 'rwa');
  b.wire(wbv, 'rwd');
  const R = b.right;
  d = define({
    id: `${full ? 'rv16_cpu' : 'rv16_cpu_nb'}${fast ? '_ks' : ''}${md === 'mul' ? '_m' : md === 'div' ? '_md' : ''}`,
    name: `${full ? 'RV16 single-cycle core' : 'RV16 single-cycle core (no branches)'}${fast ? ', fast adders' : ''}${md === 'mul' ? ', multiply' : md === 'div' ? ', multiply and divide' : ''}`, category: 'cpu',
    summary: 'PC → (instruction from the bench) → control and immediates → register file → ALU → result mux → register file. The bench serves instr = imem[pc] and drdata = dmem[daddr] combinationally.'
      + (md === 'mul' ? ' MD instructions take the multiplier\'s result instead.' : md === 'div' ? ' MD instructions take the multiplier\'s or the divider\'s result; a divide holds the PC (and writes nothing) until the divider is done.' : ''),
    ports: CORE_PORTS,
    symbol: { kind: 'box', label: full ? (md ? 'RV16 M' : 'RV16') : 'RV16 (no br)' },
    netlist: () => ({
      pins: { ...pinsAt(['clk', 'rst', 'instr', 'drdata'], 0, 4), ...pinsAt(['pc', 'daddr', 'dwdata', 'dwe', 'rwe', 'rwa', 'rwd'], R, 4) },
      instances: b.instances, nets: b.nets(),
    }),
  });
  cores.set(key, d);
  return d;
}

// Built at load, so that a chip placing one by library id resolves after a reload.
export const RV16_CORE = rv16Core(true);
export const RV16_CORE_NB = rv16Core(false);
export const RV16_CORE_KS = rv16Core(true, true);
export const RV16_CORE_M = rv16Core(true, false, 'mul');
export const RV16_CORE_MD = rv16Core(true, false, 'div');
