// Level 10c: the five-stage pipeline with a pipelined FPU. One stage (X) is added between M and W
// so that every instruction takes the same path (F D E M X W) and retires in order; the FPU's
// add / multiply / fused multiply-add / int→float path is the fused multiply-add split over E
// (multiply), M (align and add) and X (round). Simple FP operations finish in E, fdiv / fsqrt run
// on the iterative units in E and stall the front end (a structural hazard). FP results are
// visible from W: a dependent FP instruction waits in D while its producer is in E or M
// (interlock), then takes the value forwarded from W. fcsr is read in E and written in W; CSR
// instructions and FP instructions do not overtake each other (they wait in D).

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord, isZero } from './alu';
import { andN, busMux2, equal, muxTree } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, PLUS4, PLUS4_FAST, dataMemory, rom } from './cpu';
import { define, merger, splitter } from './define';
import { fanout, koggeStone } from './fastadd';
import { Builder, FP_DECODE, fmaAdd, fmaMultiply, fmaRound, fpClassify, fpCompare, fpDivSqrtHeld, fpMinMax, fpToIntAlign, fpToIntRound } from './fpu';
import { F32 } from '../sim/fpref';
import { AND, MUX2, NOT, OR, XOR } from './gates';
import { condNegate } from './muldiv';
import { clearableRegister, nonZero, pipeReg, PIPE_H, REG_DE, REG_EM, REG_FD, rowY } from './pipeline';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });
const K = (w: number, v: number) => constWord(w, v >>> 0);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Latency of the FP pipe (E, M, X): an FP result can be forwarded from W, three cycles after it entered E. */
export const FP_PIPE_STAGES = 3;

// ---- pipeline registers for the FP fields ------------------------------------------------------

/** A pipeline register for the FP side: named fields, one row each, enable (stall) and clear (bubble). */
function fpPipeReg(name: string, from: string, to: string, fields: [string, number][]): ComponentDef {
  const sig = fields.map(([f, w]) => `${f}${w}`).join('_');
  return memo(`fppipe_${name}_${sig}`, () => {
    const widths = fields.map(([, w]) => w), total = widths.reduce((a, b) => a + b, 0);
    const C = clearableRegister(total), cg = symbolGeom(C);
    const P = 3, H = 2 + P * fields.length + 6;
    const portPos: Record<string, number> = { en: H - 4, clr: H - 2 };
    fields.forEach(([f], i) => { portPos[f + from] = 2 + P * i; portPos[f + to] = 2 + P * i; });
    return define({
      id: `fppipe_${name.replace('/', '')}_${total}`, name: `${name} FP pipeline register`, category: 'sequential',
      summary: `The FP fields crossing this stage boundary (${total} bits): ${fields.map(([f]) => f).join(', ')}. It stalls and clears together with the integer register beside it.`,
      ports: [...fields.map(([f, w]) => bus(f + from, w, 'in')), bit('en', 'in'), bit('clr', 'in'), bit('clk', 'in', 'bottom', true), ...fields.map(([f, w]) => bus(f + to, w, 'out'))],
      symbol: { kind: 'box', label: name, w: 3, h: H, portPos, noPortLabels: true, verticalLabel: true },
      netlist: () => ({
        pins: {
          ...Object.fromEntries(fields.map(([f], i) => [f + from, [0, 2 + P * i] as [number, number]])),
          ...Object.fromEntries(fields.map(([f], i) => [f + to, [24 + cg.w + 14, 2 + P * i] as [number, number]])),
          en: [0, 2 + P * fields.length + 3], clr: [0, 2 + P * fields.length + 5], clk: [0, 2 + P * fields.length + 7],
        },
        instances: [
          { name: 'bundle', def: merger(widths, P), at: [8, 2 - P / 2] },
          { name: 'r', def: C, at: [18, 2] },
          { name: 'unbundle', def: splitter(widths, P), at: [24 + cg.w + 6, 2 - P / 2] },
        ],
        nets: [
          ...fields.map(([f], i): NetDef => ({ name: f + from, ends: [f + from, `bundle.i${i}`] })),
          { name: 'd', ends: ['bundle.out', 'r.d'] },
          { name: 'en', ends: ['en', 'r.en'] }, { name: 'clr', ends: ['clr', 'r.clr'] }, { name: 'clk', ends: ['clk', 'r.clk'] },
          { name: 'q', ends: ['r.q', 'unbundle.in'] },
          ...fields.map(([f], i): NetDef => ({ name: f + to, ends: [`unbundle.o${i}`, f + to] })),
        ],
      }),
    });
  });
}

const INT_LATE = ['valid', 'pc', 'pcPlus4', 'aluResult', 'readData', 'imm', 'rd', 'regWrite', 'resultSrc'];
const CTRL: [string, number][] = [['fWrite', 1], ['toInt', 1], ['fpOp', 1], ['isFlw', 1], ['isCsr', 1]];
const CSRW: [string, number][] = [['csrNew', 8], ['csrWeF', 1], ['csrWeR', 1]];
const ARITH: [string, number][] = [['arith', 1], ['simpleY', 32], ['simpleFl', 5], ['nan', 1], ['invalid', 1], ['anyInf', 1], ['infSign', 1], ['dz', 1], ['rm', 3]];
const REG_DEF = () => fpPipeReg('ID/EX', 'D', 'E', [['instr', 32], ['frd1', 32], ['frd2', 32], ['frd3', 32], ['fwdA', 1], ['fwdB', 1], ['fwdC', 1], ['isFsw', 1], ...CTRL]);
const TOINT: [string, number][] = [['tiT', 33], ['tiSt', 1], ['tiSign', 1], ['tiNaN', 1], ['tiBad', 1], ['cvtW', 1], ['tiSigned', 1]];
const REG_EMF = () => fpPipeReg('EX/MEM', 'E', 'M', [['p', 48], ['mc', 24], ['dsat', 6], ['cBig', 1], ['eB', 16], ['sB', 1], ['effSub', 1], ...ARITH, ...TOINT, ...CTRL, ...CSRW]);
const REG_MXF = () => fpPipeReg('MEM/X', 'M', 'X', [['sign', 1], ['ex', 16], ['sum', 52], ...ARITH, ...CTRL, ...CSRW]);
const REG_XWF = () => fpPipeReg('X/WB', 'X', 'W', [['fpResult', 32], ['flags', 5], ...CTRL, ...CSRW]);

// ---- decode and hazards ------------------------------------------------------------------------

/**
 * Which registers does the instruction in D read, for the FP interlocks: f[rs1], f[rs2], f[rs3]
 * (the FP operands), x[rs1] / x[rs2] (to wait for an FP-to-integer result), and is it an fcsr access?
 */
export const FP_USES: ComponentDef = (() => {
  const b = new Builder();
  const f7 = b.op(splitter([2, 1, 1, 1, 1, 1]), ['funct7']);
  const f3 = b.op(splitter([1, 1, 1]), ['funct3']);
  const isSys = b.op1(equal(7), ['op', b.op1(K(7, 0b1110011), [])], 'SYSTEM?');
  const addr = b.op(splitter([1, 1, 3, 7]), [b.op1(merger([5, 7]), ['rs2', 'funct7'])]);
  b.next();
  const intSrc = b.name(b.op1(andN(3), [`${f7}.o5`, `${f7}.o4`, `${f7}.o2`], 'fcvt.s.w / fmv.w.x'), 'xSource');
  const unary11 = b.op1(AND, [`${f7}.o5`, `${f7}.o4`]);
  const sqrt = b.op1(andN(5), [b.op1(NOT, [`${f7}.o5`]), `${f7}.o4`, b.op1(NOT, [`${f7}.o3`]), `${f7}.o2`, `${f7}.o1`], 'fsqrt?');
  const hi0 = b.op1(AND, [b.op1(isZero(3), [`${addr}.o2`]), b.op1(isZero(7), [`${addr}.o3`])]);
  b.next();
  const usesF1 = b.name(b.op1(OR, [b.op1(AND, ['opfp', b.op1(NOT, [intSrc])]), 'fma'], 'reads f[rs1]'), 'usesF1');
  const binary = b.op1(AND, ['opfp', b.op1(NOT, [b.op1(OR, [unary11, sqrt])])]);
  const usesF2 = b.name(b.op1(orN(3), [binary, 'fma', 'fsw'], 'reads f[rs2]'), 'usesF2');
  b.wire(b.op1(andN(4), [isSys, b.op1(OR, [`${f3}.o0`, `${f3}.o1`]), hi0, b.op1(OR, [`${addr}.o0`, `${addr}.o1`])], 'fflags / frm / fcsr'), 'isCsr');
  b.next();
  b.wire(usesF1, 'usesF1');
  b.wire(usesF2, 'usesF2');
  b.wire('fma', 'usesF3');
  b.wire(b.op1(NOT, [usesF1]), 'readsX1');
  b.wire(b.op1(NOT, [b.op1(orN(4), ['opfp', 'fma', 'flw', 'fsw'])], 'reads x[rs2]'), 'readsX2');
  return define({
    id: 'fpuses', name: 'FP operand usage', category: 'cpu',
    summary: 'Which register files the instruction in D reads: f[rs1] (all FP arithmetic except fcvt.s.w and fmv.w.x, which read x[rs1]), f[rs2] (binary ops, fma, fsw\'s data), f[rs3] (fma); x[rs1] and x[rs2] otherwise (conservatively). Also: is it a CSR access to fflags, frm or fcsr?',
    ports: [bus('op', 7, 'in'), bus('funct7', 7, 'in'), bus('funct3', 3, 'in'), bus('rs2', 5, 'in'), bit('opfp', 'in'), bit('fma', 'in'), bit('flw', 'in'), bit('fsw', 'in'),
      bit('usesF1', 'out'), bit('usesF2', 'out'), bit('usesF3', 'out'), bit('readsX1', 'out'), bit('readsX2', 'out'), bit('isCsr', 'out')],
    symbol: { kind: 'box', label: 'FP USES' },
    netlist: () => ({
      pins: { op: [0, 2], funct7: [0, 6], funct3: [0, 10], rs2: [0, 14], opfp: [0, 18], fma: [0, 22], flw: [0, 26], fsw: [0, 30], usesF1: [b.right, 2], usesF2: [b.right, 6], usesF3: [b.right, 10], readsX1: [b.right, 14], readsX2: [b.right, 18], isCsr: [b.right, 22] },
      instances: b.instances, nets: b.nets(),
    }),
  });
})();

/**
 * Integer hazards of the six-stage pipeline: forwarding to E from M, X and W (M first, it is the
 * youngest), the W → D bypass, the load-use stall (a load's data exists from X on) and the taken
 * branch / jump redirect.
 */
export const HAZARD6: ComponentDef = (() => {
  const b = new Builder();
  const fwd = (rs: string, label: string) => {
    const nz = b.op1(nonZero(5), [rs]);
    const m = b.op1(andN(3), [nz, b.op1(equal(5), [rs, 'rdM']), 'regWriteM'], `${label} from M`);
    const x = b.op1(andN(3), [nz, b.op1(equal(5), [rs, 'rdX']), 'regWriteX'], `${label} from X`);
    const w = b.op1(andN(3), [nz, b.op1(equal(5), [rs, 'rdW']), 'regWriteW'], `${label} from W`);
    const nm = b.op1(NOT, [m]);
    const xs = b.op1(AND, [x, nm]);
    const ws = b.op1(andN(3), [w, nm, b.op1(NOT, [x])]);
    // 00 register, 01 W, 10 M, 11 X
    return b.op1(merger([1, 1]), [b.op1(OR, [xs, ws]), b.op1(OR, [m, xs])], label);
  };
  b.wire(fwd('rs1E', 'forward A'), 'forwardA');
  b.wire(fwd('rs2E', 'forward B'), 'forwardB');
  b.next();
  const by = (rs: string) => b.op1(andN(3), [b.op1(nonZero(5), [rs]), b.op1(equal(5), [rs, 'rdW']), 'regWriteW']);
  b.wire(by('rs1D'), 'bypassA');
  b.wire(by('rs2D'), 'bypassB');
  const rs = b.op(splitter([1, 1]), ['resultSrcE']);
  const load = b.op1(AND, [`${rs}.o0`, b.op1(NOT, [`${rs}.o1`])], 'load in E');
  const use = b.op1(OR, [b.op1(equal(5), ['rs1D', 'rdE']), b.op1(equal(5), ['rs2D', 'rdE'])]);
  b.next();
  b.wire(b.op1(andN(3), ['validE', load, use], 'load-use'), 'lwStall');
  b.wire(b.op1(nonZero(2), ['pcSrcE'], 'redirect'), 'taken');
  return define({
    id: 'hazard6', name: 'Hazard unit (six stages)', category: 'cpu',
    summary: 'Integer hazards with the extra X stage: each ALU operand can come from M, X or W (the youngest producer wins), x registers are bypassed W → D, a load in E stalls a dependent instruction in D for one cycle (its data can be forwarded from X), and a taken branch or jump in E flushes F and D.',
    ports: [bus('rs1D', 5, 'in'), bus('rs2D', 5, 'in'), bus('rs1E', 5, 'in'), bus('rs2E', 5, 'in'), bus('rdE', 5, 'in'), bus('rdM', 5, 'in'), bus('rdX', 5, 'in'), bus('rdW', 5, 'in'),
      bit('regWriteM', 'in'), bit('regWriteX', 'in'), bit('regWriteW', 'in'), bit('validE', 'in'), bus('resultSrcE', 2, 'in'), bus('pcSrcE', 2, 'in'),
      bus('forwardA', 2, 'out'), bus('forwardB', 2, 'out'), bit('bypassA', 'out'), bit('bypassB', 'out'), bit('lwStall', 'out'), bit('taken', 'out')],
    symbol: { kind: 'box', label: 'HAZARD UNIT' },
    netlist: () => ({
      pins: Object.fromEntries([
        ...['rs1D', 'rs2D', 'rs1E', 'rs2E', 'rdE', 'rdM', 'rdX', 'rdW', 'regWriteM', 'regWriteX', 'regWriteW', 'validE', 'resultSrcE', 'pcSrcE'].map((n, i) => [n, [0, 2 + 3 * i]]),
        ...['forwardA', 'forwardB', 'bypassA', 'bypassB', 'lwStall', 'taken'].map((n, i) => [n, [b.right, 4 + 4 * i]]),
      ]) as Record<string, [number, number]>,
      instances: b.instances, nets: b.nets(),
    }),
    hdl: {
      verilog: `// forwarding: 00 register file, 01 W, 10 M, 11 X; the youngest producer (M) wins
assign fM = rs1E != 0 && rs1E == rdM && regWriteM;
assign fX = rs1E != 0 && rs1E == rdX && regWriteX && !fM;
assign fW = rs1E != 0 && rs1E == rdW && regWriteW && !fM && !fX;
assign forwardA = {fM | fX, fX | fW};          // (same for B)
assign lwStall = validE && resultSrcE == 2'b01 && (rs1D == rdE || rs2D == rdE);
assign taken = pcSrcE != 2'b00;`,
    },
  });
})();

/**
 * FP hazards. A result of the FP pipe exists only at the end of X, so an instruction in D that
 * reads an f register written by an instruction in E or M waits (interlock); one cycle later
 * the producer is in W and its result is forwarded to E (or bypassed into D). FP results bound
 * for an x register (compares, fmv.x.w, fclass, fcvt.w.s) are handled the same way. fcsr: a CSR
 * access waits until no FP instruction is in E, M, X or W (its flags are accrued at W), and FP
 * instructions or CSR accesses wait while an older CSR access (written at W) is in E, M or X.
 */
export const FP_HAZARD: ComponentDef = (() => {
  const b = new Builder();
  const hit = (rs: string, rd: string, we: string) => b.op1(AND, [we, b.op1(equal(5), [rs, rd])]);
  const raw = (rs: string, uses: string) => b.op1(AND, [uses, b.op1(OR, [hit(rs, 'rdE', 'fWriteE'), hit(rs, 'rdM', 'fWriteM')])]);
  const rawF = b.name(b.op1(orN(3), [raw('rs1D', 'usesF1'), raw('rs2D', 'usesF2'), raw('rs3D', 'usesF3')], 'f RAW'), 'fRAW');
  const rawX = (rs: string, uses: string) => b.op1(andN(3), [uses, b.op1(nonZero(5), [rs]), b.op1(OR, [hit(rs, 'rdE', 'toIntE'), hit(rs, 'rdM', 'toIntM')])]);
  const rawT = b.name(b.op1(OR, [rawX('rs1D', 'readsX1'), rawX('rs2D', 'readsX2')], 'x RAW on an FP result'), 'xRAW');
  b.next();
  const drain = b.name(b.op1(AND, ['isCsrD', b.op1(orN(4), ['fpOpE', 'fpOpM', 'fpOpX', 'fpOpW'])], 'CSR waits for FP'), 'drain');
  const fence = b.name(b.op1(AND, [b.op1(OR, ['fpOpD', 'isCsrD']), b.op1(orN(3), ['csrE', 'csrM', 'csrX'])], 'waits for CSR write'), 'fence');
  b.next();
  b.wire(b.op1(orN(4), [rawF, rawT, drain, fence], 'stall'), 'stall');
  b.next();
  // forwarding into E from W, decided one cycle early: the instruction now in X will be in W
  const x = (rs: string) => hit(rs, 'rdX', 'fWriteX'), w = (rs: string) => hit(rs, 'rdW', 'fWriteW');
  b.wire(x('rs1D'), 'fwdA'); b.wire(x('rs2D'), 'fwdB'); b.wire(x('rs3D'), 'fwdC');
  b.wire(w('rs1D'), 'byA'); b.wire(w('rs2D'), 'byB'); b.wire(w('rs3D'), 'byC');
  const ins = ['rs1D', 'rs2D', 'rs3D', 'usesF1', 'usesF2', 'usesF3', 'readsX1', 'readsX2', 'isCsrD', 'fpOpD',
    'rdE', 'fWriteE', 'toIntE', 'fpOpE', 'csrE', 'rdM', 'fWriteM', 'toIntM', 'fpOpM', 'csrM', 'rdX', 'fWriteX', 'fpOpX', 'csrX', 'rdW', 'fWriteW', 'fpOpW'];
  const five = new Set(['rs1D', 'rs2D', 'rs3D', 'rdE', 'rdM', 'rdX', 'rdW']);
  const outs = ['stall', 'fwdA', 'fwdB', 'fwdC', 'byA', 'byB', 'byC'];
  return define({
    id: 'fphazard', name: 'FP hazard unit', category: 'cpu',
    summary: 'Interlocks for the FP pipe: an instruction in D that reads a register an FP instruction in E or M will write waits (the result exists only after X); then the value comes forwarded from W into E (fwd, decided while the instruction is still in D, against the producer in X, and carried in ID/EX) or bypassed into D (by). CSR accesses to fcsr wait for every FP instruction in flight (their flags are accrued at W), and FP instructions wait behind a pending CSR write.',
    ports: [...ins.map((n) => (five.has(n) ? bus(n, 5, 'in') : bit(n, 'in'))), ...outs.map((n) => bit(n, 'out'))],
    symbol: { kind: 'box', label: 'FP HAZARDS' },
    netlist: () => ({
      pins: Object.fromEntries([...ins.map((n, i) => [n, [0, 2 + 3 * i]]), ...outs.map((n, i) => [n, [b.right, 4 + 4 * i]])]) as Record<string, [number, number]>,
      instances: b.instances, nets: b.nets(),
    }),
    hdl: {
      verilog: `wire rawF = usesF1 && fWriteE && rs1D == rdE || usesF1 && fWriteM && rs1D == rdM || /* rs2, rs3 alike */ 1'b0;
wire rawX = readsX1 && rs1D != 0 && (toIntE && rs1D == rdE || toIntM && rs1D == rdM) || /* rs2 alike */ 1'b0;
wire drain = isCsrD && (fpOpE || fpOpM || fpOpX || fpOpW);      // flags accrue at W
wire fence = (fpOpD || isCsrD) && (csrE || csrM || csrX);       // fcsr is written at W
assign stall = rawF || rawX || drain || fence;
assign fwdA = fWriteX && rs1D == rdX;   // registered in ID/EX: next cycle the producer is in W
assign byA  = fWriteW && rs1D == rdW;   // (B, C alike)`,
    },
  });
})();

// ---- the FP stages ---------------------------------------------------------------------------------

/**
 * The FP unit's execute stage. The add / sub / mul / fma / fcvt.s.w group goes into the fused
 * multiply-add pipe (fadd = a × 1 + b, fmul = a × b + 0 with the zero's sign chosen so that a
 * zero product keeps its sign; fcvt.s.w puts |x| where the product would be): this stage does its
 * multiply step. Everything else finishes here: sign injection, min / max, compares, fclass,
 * fcvt.w[u].s, moves; fdiv / fsqrt run on the iterative units (stall = 1 until done).
 */
export const FP_EXEC: ComponentDef = (() => {
  const f = F32;
  const b = new Builder();
  const ins = b.op(splitter([7, 5, 3, 5, 5, 7]), ['instr']);
  const op = `${ins}.o0`, f3 = `${ins}.o2`, rs2 = `${ins}.o4`, f7 = `${ins}.o5`;
  const o = b.op(splitter([1, 1, 1, 1, 1, 1, 1]), [op]);
  const s7 = b.op(splitter([2, 1, 1, 1, 1, 1]), [f7]);
  const f3s = b.op(splitter([1, 1, 1]), [f3]);
  const as = b.op(splitter([31, 1]), ['a']), bs = b.op(splitter([31, 1]), ['b']);
  b.next();
  const isOp = b.name(b.op1(equal(7), [op, b.op1(K(7, 0b1010011), [])], 'OP-FP?'), 'isOPFP');
  const isFma = b.name(b.op1(andN(5), [`${o}.o0`, `${o}.o1`, `${o}.o6`, b.op1(NOT, [`${o}.o5`]), b.op1(NOT, [`${o}.o4`])], 'fma group?'), 'isFMA');
  const f5 = b.op1(merger([1, 1, 1, 1, 1]), [`${s7}.o1`, `${s7}.o2`, `${s7}.o3`, `${s7}.o4`, `${s7}.o5`], 'funct5');
  const dyn = b.op1(andN(3), [`${f3s}.o0`, `${f3s}.o1`, `${f3s}.o2`]);
  const r2 = b.op(splitter([1, 4]), [rs2]);
  b.next();
  const is = (v: number, label: string) => b.name(b.op1(AND, [isOp, b.op1(equal(5), [f5, b.op1(K(5, v), [])])], label), label);
  const f5hi = b.op(splitter([1, 4]), [f5]);
  const addSub = b.name(b.op1(AND, [isOp, b.op1(isZero(4), [`${f5hi}.o1`])], 'fadd / fsub?'), 'isAddSub');
  const isMul = is(0b00010, 'fmul?'), isDiv = is(0b00011, 'fdiv?'), isSqrt = is(0b01011, 'fsqrt?'), isCvt = is(0b11010, 'fcvt.s.w?');
  const rm = b.name(b.op1(busMux2(3), [f3, 'frm', dyn], 'rounding mode'), 'rm');
  const signed = b.op1(NOT, [`${r2}.o0`], 'signed?');
  b.next();
  // operands of the fused multiply-add for each operation
  const one = b.op1(K(32, 0x3f800000), [], '1.0');
  const B = b.op1(busMux2(32), ['b', one, addSub], 'b or 1.0');
  const C0 = b.op1(busMux2(32), [b.op1(K(32, 0), []), 'b', addSub]);
  const C = b.op1(busMux2(32), [C0, 'c', isFma], 'addend');
  const negProd = b.op1(AND, [isFma, `${o}.o3`]);
  const mulSign = b.op1(AND, [isMul, b.op1(XOR, [`${as}.o1`, `${bs}.o1`])], 'zero takes the product\'s sign');
  const negC = b.op1(MUX2, [b.op1(OR, [b.op1(AND, [addSub, `${s7}.o1`]), mulSign]), `${o}.o2`, isFma], 'negate c');
  b.next();
  const mul = b.op(fmaMultiply(f), ['a', B, C, negProd, negC], 'FMA stage 1: multiply');
  // fcvt.s.w: |x| takes the product's place (top 32 of 48 bits, weight 2^31), the addend is 0
  const xs = b.op(splitter([31, 1]), ['xa']);
  const xneg = b.name(b.op1(AND, [`${xs}.o1`, signed], 'x < 0'), 'xNeg');
  const mag = b.op1(condNegate(32), ['xa', xneg], '|x|');
  b.next();
  const pc = b.op1(merger([16, 32]), [b.op1(K(16, 0), []), mag]);
  // fdiv / fsqrt: the unrounded quotient or root (and its sticky bit) takes the product's place too
  const ds = b.op(fpDivSqrtHeld(f), ['clk', isDiv, isSqrt, 'a', 'b', rm], 'divide / square root (iterative)');
  const iter = b.name(b.op1(OR, [isDiv, isSqrt]), 'iterative');
  const pIt = b.op1(merger([20, 1, 27]), [b.op1(K(20, 0), []), `${ds}.sticky`, `${ds}.m`]);
  const other = b.op1(OR, [isCvt, iter], 'not a multiply-add');
  b.next();
  b.wire(b.op1(busMux2(48), [b.op1(busMux2(48), [`${mul}.p`, pc, isCvt], 'product or |x|'), pIt, iter], 'or quotient / root'), 'p');
  b.wire(b.op1(busMux2(24), [`${mul}.mc`, b.op1(K(24, 0), []), other]), 'mc');
  b.wire(`${mul}.dsat`, 'dsat');
  const ncv = b.op1(NOT, [other]);
  b.wire(b.op1(AND, [`${mul}.cBig`, ncv]), 'cBig');
  b.wire(b.op1(busMux2(16), [b.op1(busMux2(16), [`${mul}.eB`, b.op1(K(16, 31 + 127), []), isCvt]), `${ds}.e`, iter]), 'eB');
  b.wire(b.op1(MUX2, [b.op1(MUX2, [`${mul}.sB`, xneg, isCvt]), `${ds}.sign`, iter]), 'sB');
  b.wire(b.op1(AND, [`${mul}.effSub`, ncv]), 'effSub');
  for (const [s, d] of [['nan', 'nan'], ['invalid', 'invalid'], ['anyInf', 'inf'], ['infSign', 'infSign']]) {
    b.wire(b.op1(MUX2, [b.op1(AND, [`${mul}.${s}`, b.op1(NOT, [isCvt])]), `${ds}.${d}`, iter]), s);
  }
  b.wire(b.op1(AND, [`${ds}.dz`, iter]), 'dz');
  b.wire(rm, 'rmOut');
  b.wire(b.op1(orN(5), [addSub, isMul, isFma, isCvt, iter], 'goes down the FMA pipe'), 'arith');
  // the operations that finish here
  const cmp = b.op(fpCompare(f), ['a', 'b'], 'comparator');
  const mm = b.op(fpMinMax(f), ['a', 'b', `${f3s}.o0`], 'min / max');
  const toI = b.op(fpToIntAlign(f), ['a'], 'float → int: align (round in M)');
  b.wire(`${toI}.t`, 'tiT'); b.wire(`${toI}.sticky`, 'tiSt'); b.wire(`${toI}.sign`, 'tiSign'); b.wire(`${toI}.nan`, 'tiNaN'); b.wire(`${toI}.bad`, 'tiBad');
  b.wire(is(0b11000, 'fcvt.w.s?'), 'cvtW');
  b.wire(signed, 'tiSigned');
  const cls = b.op1(fpClassify(f), ['a'], 'classify');
  b.next();
  const sjSel = b.op1(merger([1, 1]), [`${f3s}.o0`, `${f3s}.o1`]);
  const sj = b.op1(muxTree(2, 1), [`${bs}.o1`, b.op1(NOT, [`${bs}.o1`]), b.op1(XOR, [`${as}.o1`, `${bs}.o1`]), `${bs}.o1`, sjSel], 'sign injection');
  const sgnj = b.op1(merger([31, 1]), [`${as}.o0`, sj]);
  const cbit = b.op1(muxTree(2, 1), [`${cmp}.le`, `${cmp}.lt`, `${cmp}.eq`, b.op1(TIE0, []), sjSel]);
  const cmp32 = b.op1(merger([1, 31]), [cbit, b.op1(K(31, 0), [])]);
  const cmpNV = b.op1(merger([4, 1]), [b.op1(K(4, 0), []), b.op1(MUX2, [`${cmp}.unord`, `${cmp}.snan`, `${f3s}.o1`], 'feq is quiet')]);
  const cls32 = b.op1(merger([10, 22]), [cls, b.op1(K(22, 0), [])]);
  const sel = b.op1(merger([1, 1, 1, 1]), [`${s7}.o2`, `${s7}.o3`, `${s7}.o4`, `${s7}.o5`], 'op');
  b.next();
  const g2 = b.op1(busMux2(32), [sgnj, `${mm}.y`, `${s7}.o1`], 'sgnj / min-max');
  const g14 = b.op1(busMux2(32), ['a', cls32, `${f3s}.o0`], 'fmv.x.w / fclass');
  const fl2 = b.op1(busMux2(5), [b.op1(K(5, 0), []), `${mm}.flags`, `${s7}.o1`]);
  b.next();
  const z = b.op1(K(32, 0), []), z5 = b.op1(K(5, 0), []);
  const ys = Array.from({ length: 16 }, () => z), fs = Array.from({ length: 16 }, () => z5);
  ys[2] = g2; ys[10] = cmp32; ys[14] = g14; ys[15] = 'xa';
  fs[2] = fl2; fs[10] = cmpNV;
  b.wire(b.op1(muxTree(4, 32), [...ys, sel], 'simple result'), 'simpleY');
  b.wire(b.op1(muxTree(4, 5), [...fs, sel], 'simple flags'), 'simpleFl');
  const wait = b.op1(AND, [b.op1(OR, [isDiv, isSqrt]), b.op1(NOT, [`${ds}.done`])]);
  b.wire(wait, 'stall');
  return define({
    id: 'fpexec', name: 'FP execute stage', category: 'cpu',
    summary: 'fadd, fsub, fmul, the fused multiply-adds and fcvt.s.w all become one operation, a × b + c (fadd: b = 1; fmul: c = ±0; fcvt.s.w: |x| in place of the product), and this stage does its multiply step; align / add and round follow in M and X. Sign injection, min / max, compares, fclass, fcvt.w[u].s and the moves finish here; fdiv and fsqrt run on the iterative units behind operand latches and stall the pipeline until done.',
    ports: [bit('clk', 'in', 'bottom', true), bus('a', 32, 'in'), bus('b', 32, 'in'), bus('c', 32, 'in'), bus('xa', 32, 'in'), bus('instr', 32, 'in'), bus('frm', 3, 'in'),
      bus('p', 48, 'out'), bus('mc', 24, 'out'), bus('dsat', 6, 'out'), bit('cBig', 'out'), bus('eB', 16, 'out'), bit('sB', 'out'), bit('effSub', 'out'),
      bit('nan', 'out'), bit('invalid', 'out'), bit('anyInf', 'out'), bit('infSign', 'out'), bit('dz', 'out'), bus('rmOut', 3, 'out'), bit('arith', 'out'),
      bus('simpleY', 32, 'out'), bus('simpleFl', 5, 'out'), bus('tiT', 33, 'out'), bit('tiSt', 'out'), bit('tiSign', 'out'), bit('tiNaN', 'out'), bit('tiBad', 'out'), bit('cvtW', 'out'), bit('tiSigned', 'out'), bit('stall', 'out')],
    symbol: { kind: 'box', label: 'FP EXECUTE' },
    netlist: () => ({
      pins: Object.fromEntries([
        ...['a', 'b', 'c', 'xa', 'instr', 'frm', 'clk'].map((n, i) => [n, [0, 4 + 4 * i]]),
        ...['p', 'mc', 'dsat', 'cBig', 'eB', 'sB', 'effSub', 'nan', 'invalid', 'anyInf', 'infSign', 'dz', 'rmOut', 'arith', 'simpleY', 'simpleFl', 'tiT', 'tiSt', 'tiSign', 'tiNaN', 'tiBad', 'cvtW', 'tiSigned', 'stall'].map((n, i) => [n, [b.right, 2 + 3 * i]]),
      ]) as Record<string, [number, number]>,
      instances: b.instances, nets: b.nets(),
    }),
    hdl: {
      verilog: `// one multiply-add pipe for fadd / fsub / fmul / fma / fcvt.s.w (stage 1 here, 2 in M, 3 in X)
wire [31:0] B = isAddSub ? 32'h3f800000 : b;                    // fadd: a x 1 + b
wire [31:0] C = isFma ? c : isAddSub ? b : 32'h0;               // fmul: a x b + 0
wire negC = isFma ? op[2] : isAddSub ? funct7[2] : isMul & (a[31] ^ b[31]);
fma_multiply s1 (.a, .b(B), .c(C), .negProd(isFma & op[3]), .negC, ...);
// fcvt.s.w: p = {|x|, 16'b0}, exponent 31 + bias, addend 0
// everything else finishes in E; fdiv / fsqrt: stall = (isDiv | isSqrt) & ~done`,
    },
  });
})();

/** FP stage 3 (X): round the multiply-add result, or pass the result computed in E. */
export const FP_RESULT: ComponentDef = (() => {
  const f = F32;
  const b = new Builder();
  const r = b.op(fmaRound(f), ['sign', 'ex', 'sum', 'rm', 'nan', 'invalid', 'anyInf', 'infSign', 'dz'], 'FMA stage 3: round');
  b.next();
  b.wire(b.op1(busMux2(32), ['simpleY', `${r}.y`, 'arith']), 'y');
  b.wire(b.op1(busMux2(5), ['simpleFl', `${r}.flags`, 'arith']), 'flags');
  return define({
    id: 'fpresult', name: 'FP result stage', category: 'cpu',
    summary: 'The third stage of the FP pipe: one shared normalize & round for the multiply-add group and for fdiv / fsqrt, or the result computed back in E.',
    ports: [bit('sign', 'in'), bus('ex', 16, 'in'), bus('sum', 52, 'in'), bus('rm', 3, 'in'), bit('nan', 'in'), bit('invalid', 'in'), bit('anyInf', 'in'), bit('infSign', 'in'), bit('dz', 'in'),
      bit('arith', 'in'), bus('simpleY', 32, 'in'), bus('simpleFl', 5, 'in'), bus('y', 32, 'out'), bus('flags', 5, 'out')],
    symbol: { kind: 'box', label: 'FP ROUND' },
    netlist: () => ({
      pins: Object.fromEntries([...['sign', 'ex', 'sum', 'rm', 'nan', 'invalid', 'anyInf', 'infSign', 'dz', 'arith', 'simpleY', 'simpleFl'].map((n, i) => [n, [0, 2 + 3 * i]]), ['y', [b.right, 4]], ['flags', [b.right, 10]]]) as Record<string, [number, number]>,
      instances: b.instances, nets: b.nets(),
    }),
  });
})();

/**
 * fcsr, split for the pipeline. In E: is this a CSR access to fflags / frm / fcsr, the old value
 * (for rd) and the new value with its write enables. They travel to W, where FCSR_REGS writes
 * them, so fcsr changes exactly when the instruction retires.
 */
export const FCSR_CALC: ComponentDef = (() => {
  const b = new Builder();
  const isSys = b.op1(equal(7), ['op', b.op1(K(7, 0b1110011), [])], 'SYSTEM?');
  const f3 = b.op(splitter([1, 1, 1]), ['funct3']);
  const addr = b.op1(merger([5, 7]), ['rs2', 'funct7'], 'csr address');
  const r1z = b.op1(isZero(5), ['rs1']);
  const old = b.op(splitter([5, 3]), ['fcsr']);
  b.next();
  const as = b.op(splitter([1, 1, 10]), [addr]);
  const hit = b.name(b.op1(andN(4), [isSys, b.op1(OR, [`${f3}.o0`, `${f3}.o1`]), b.op1(isZero(10), [`${as}.o2`]), b.op1(OR, [`${as}.o0`, `${as}.o1`])], 'fflags / frm / fcsr?'), 'hit');
  const isW = b.op1(AND, [`${f3}.o0`, b.op1(NOT, [`${f3}.o1`])], 'csrrw?');
  const a2 = b.op1(AND, [`${as}.o1`, b.op1(NOT, [`${as}.o0`])], 'frm alone');
  b.next();
  const writes = b.name(b.op1(AND, [hit, b.op1(OR, [isW, b.op1(NOT, [r1z])])], 'writes?'), 'writes');
  const xs = b.op(splitter([8, 24]), ['xa']);
  const src = b.op1(busMux2(8), [`${xs}.o0`, b.op1(merger([5, 3]), ['rs1', b.op1(K(3, 0), [])]), `${f3}.o2`], 'rs1 / imm');
  const ssp = b.op(splitter([3, 5]), [src]);
  b.next();
  const srcA = b.op1(busMux2(8), [src, b.op1(merger([5, 3]), [b.op1(K(5, 0), []), `${ssp}.o0`]), a2], 'align');
  b.next();
  const setv = b.op1(bitwise('or', 8), ['fcsr', srcA]);
  const clrv = b.op1(bitwise('and', 8), ['fcsr', b.op1(bitwise('xor', 8), [srcA, b.op1(K(8, 255), [])])]);
  b.next();
  b.wire(b.op1(muxTree(2, 8), ['fcsr', srcA, setv, clrv, b.op1(merger([1, 1]), [`${f3}.o0`, `${f3}.o1`])], 'new value'), 'newv');
  b.wire(b.op1(AND, [writes, `${as}.o0`]), 'weF');
  b.wire(b.op1(AND, [writes, `${as}.o1`]), 'weR');
  const low5 = b.op1(busMux2(5), [`${old}.o0`, b.op1(merger([3, 2]), [`${old}.o1`, b.op1(K(2, 0), [])]), a2]);
  const high3 = b.op1(bitwise('and', 3), [`${old}.o1`, b.op1(fanout(3), [b.op1(AND, [`${as}.o0`, `${as}.o1`])])]);
  b.next();
  b.wire(b.op1(merger([5, 3, 24]), [low5, high3, b.op1(K(24, 0), [])], 'read value'), 'rdata');
  b.wire(hit, 'hit');
  return define({
    id: 'fcsrcalc', name: 'fcsr access (execute)', category: 'cpu',
    summary: 'In E: recognises csrrw / csrrs / csrrc (and the immediate forms) on fflags, frm and fcsr, reads the old value for rd, and computes the new value and which fields it writes. The write itself happens in W.',
    ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('rs1', 5, 'in'), bus('funct7', 7, 'in'), bus('rs2', 5, 'in'), bus('xa', 32, 'in'), bus('fcsr', 8, 'in'),
      bus('rdata', 32, 'out'), bit('hit', 'out'), bus('newv', 8, 'out'), bit('weF', 'out'), bit('weR', 'out')],
    symbol: { kind: 'box', label: 'fcsr (E)' },
    netlist: () => ({
      pins: Object.fromEntries([...['op', 'funct3', 'rs1', 'funct7', 'rs2', 'xa', 'fcsr'].map((n, i) => [n, [0, 2 + 4 * i]]), ...['rdata', 'hit', 'newv', 'weF', 'weR'].map((n, i) => [n, [b.right, 2 + 4 * i]])]) as Record<string, [number, number]>,
      instances: b.instances, nets: b.nets(),
    }),
  });
})();

/** The fcsr registers, written in W: a CSR write (new value, field enables) and the accrued flags of a retiring FP instruction. */
export const FCSR_REGS: ComponentDef = (() => {
  const b = new Builder();
  const nv = b.op(splitter([5, 3]), ['newv']);
  b.next();
  const keep = b.op1(busMux2(5), ['flagsReg.q', `${nv}.o0`, 'weF']);
  const acc = b.op1(bitwise('and', 5), ['flags', b.op1(fanout(5), ['fpOp'])]);
  b.next();
  b.wire(b.op1(bitwise('or', 5), [keep, acc], 'accrue'), 'flagsReg.d');
  b.wire(b.op1(TIE1, []), 'flagsReg.en');
  b.add(register(5), 'fflags', 'flagsReg');
  b.wire(`${nv}.o1`, 'frmReg.d');
  b.wire('weR', 'frmReg.en');
  b.add(register(3), 'frm', 'frmReg');
  b.wire('clk', 'flagsReg.clk');
  b.wire('clk', 'frmReg.clk');
  b.next();
  b.wire('frmReg.q', 'frm');
  b.wire(b.op1(merger([5, 3]), ['flagsReg.q', 'frmReg.q'], 'fcsr'), 'fcsr');
  return define({
    id: 'fcsrregs', name: 'fcsr registers (write-back)', category: 'cpu',
    summary: 'frm and fflags, written when an instruction retires: a CSR write sets or clears fields; a retiring FP instruction ORs its exception flags in.',
    ports: [bit('clk', 'in', 'bottom', true), bus('newv', 8, 'in'), bit('weF', 'in'), bit('weR', 'in'), bus('flags', 5, 'in'), bit('fpOp', 'in'), bus('frm', 3, 'out'), bus('fcsr', 8, 'out')],
    symbol: { kind: 'box', label: 'fcsr' },
    netlist: () => ({ pins: { newv: [0, 2], weF: [0, 6], weR: [0, 10], flags: [0, 14], fpOp: [0, 18], clk: [0, 22], frm: [b.right, 4], fcsr: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the processor ---------------------------------------------------------------------------------

export interface FpPipeOptions { dmemK?: number; adder?: 'rca' | 'ks'; /** Instruction ROM of 2^imemK words (default 6). */ imemK?: number }

/** The pipelined RV32IF CPU: F D E M X W, with the three-stage FP pipe in E, M, X. */
export function pipelinedFpCpu(program: number[], opts: FpPipeOptions = {}): ComponentDef {
  const IM = rom(program, opts.imemK ?? 6);
  const o = { dmemK: opts.dmemK ?? 5, adder: opts.adder ?? 'ks' } as const;
  return memo(`fppipe_${IM.id}_${o.dmemK}_${o.adder}`, () => buildFpPipe(IM, o));
}

function buildFpPipe(IM: ComponentDef, o: { dmemK: number; adder: 'rca' | 'ks' }): ComponentDef {
  const { adder } = o;
  const PC = register(32), RF = regfile(5, 32), FRF = regfile(5, 32, false, 3), DM = dataMemory(o.dmemK);
  const M2 = busMux2(32), M4 = muxTree(2, 32);
  const P4 = adder === 'ks' ? PLUS4_FAST : PLUS4, SI = splitter([7, 5, 3, 5, 5, 7]);
  const ALU = alu(32, adder), ADD = koggeStone(32);
  const FD = REG_FD(false), DE = REG_DE(false, false), EM = REG_EM();
  const MX = pipeReg('MEM/X', 'M', 'X', INT_LATE), XW = pipeReg('X/WB', 'X', 'W', INT_LATE);
  const DEF = REG_DEF(), EMF = REG_EMF(), MXF = REG_MXF(), XWF = REG_XWF();
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const defs = new Map<string, ComponentDef>();
  const labels: Record<string, string> = {};
  const place = (n: string, d: ComponentDef, xy: [number, number], label?: string) => { at.set(n, xy); defs.set(n, d); if (label) labels[n] = label; };
  const P = (inst: string, port: string): [number, number] => { const a = at.get(inst)!, p = g(defs.get(inst)!).ports[port].pos; return [a[0] + p[0], a[1] + p[1]]; };
  const alignY = (n: string, d: ComponentDef, x: number, port: string, y: number, label?: string) => place(n, d, [x, y - g(d).ports[port].pos[1]], label);

  const T = 6, row = (f: string) => T + rowY(f);
  // stage columns: wide enough for the FP blocks of M (align + add, float → int), X (round) and W
  const xFD = 40, xDE = 150, xEM = xDE + 92, xMX = xEM + 64, xXW = xMX + 54;
  const yF = T + PIPE_H + 60; // top of the FP pipeline registers
  place('FD', FD, [xFD, T]); place('DE', DE, [xDE, T]); place('EM', EM, [xEM, T]); place('MX', MX, [xMX, T]); place('XW', XW, [xXW, T]);
  place('DEF', DEF, [xDE, yF]); place('EMF', EMF, [xEM, yF]); place('MXF', MXF, [xMX, yF]); place('XWF', XWF, [xXW, yF]);
  // F
  alignY('pcmux', M4, 2, 'y', row('pc') + 10);
  alignY('pc', PC, 12, 'd', row('pc') + 10, 'PC');
  alignY('imem', IM, 24, 'addr', row('instr'));
  alignY('plus4', P4, 26, 'a', row('pcPlus4'));
  place('vF', TIE1, [xFD - 6, row('valid') - 1]);
  // D
  alignY('si', SI, xFD + 12, 'in', row('instr'));
  alignY('rf', RF, xFD + 28, 'ra1', row('rd1') + 6, 'x registers');
  alignY('byA', M2, xFD + 54, 'a', P('rf', 'rd1')[1], 'bypass A');
  alignY('byB', M2, xFD + 54, 'a', P('rf', 'rd2')[1] + 8, 'bypass B');
  alignY('ctl', CONTROL, xFD + 54, 'regWrite', row('regWrite'));
  alignY('imm', IMM_GEN, xFD + 26, 'instr', row('imm') + 26);
  place('fdec', FP_DECODE, [xFD + 8, yF + 4]);
  place('fuse', FP_USES, [xFD + 40, yF + 4]);
  place('frf', FRF, [xFD + 22, yF + 44], 'f registers');
  place('sr3', splitter([2, 5]), [xFD + 10, yF + 40]);
  place('fbyA', M2, [xFD + 66, yF + 44], 'f bypass A');
  place('fbyB', M2, [xFD + 66, yF + 54], 'f bypass B');
  place('fbyC', M2, [xFD + 66, yF + 64], 'f bypass C');
  // x write enable: (RegWrite AND NOT flw) OR toInt, each output on the next input's row
  place('nflw', NOT, [xFD + 72, yF + 6]); place('rwx', AND, [xFD + 80, yF + 4]); place('rwi', OR, [xFD + 90, yF + 5]);
  // E
  alignY('fwdA', M4, xDE + 20, 'd0', row('rd1'), 'forward A');
  alignY('fwdB', M4, xDE + 20, 'd0', row('rd2') + 18, 'forward B');
  alignY('srcA', M2, xDE + 32, 'a', P('fwdA', 'y')[1], 'SrcA');
  alignY('srcB', M2, xDE + 32, 'a', P('fwdB', 'y')[1], 'SrcB');
  alignY('alu', ALU, xDE + 44, 'a', P('srcA', 'y')[1]);
  alignY('target', ADD, xDE + 44, 'a', row('regWrite') + 6, 'PC + imm');
  alignY('clr0', CLEAR_BIT0, xDE + 62, 'in', row('rd') + 2);
  place('npc', NEXT_PC, [xDE + 58, row('jalr') + 4]);
  place('gT', TIE0, [P('target', 'cin')[0] - 10, P('target', 'cin')[1] + 3]);
  place('gJ', TIE0, [P('clr0', 'zero')[0] - 5, P('clr0', 'zero')[1] + 1]);
  place('aluOrCsr', M2, [xDE + 72, row('aluResult') - 4], 'ALU / CSR');
  place('stData', M2, [xDE + 72, row('writeData') + 4], 'x / f store');
  place('rwc', OR, [xDE + 84, row('regWrite') - 2]);
  place('fA', M2, [xDE + 20, yF + 4], 'forward fa');
  place('fB', M2, [xDE + 20, yF + 16], 'forward fb');
  place('fC', M2, [xDE + 20, yF + 28], 'forward fc');
  place('fpx', FP_EXEC, [xDE + 36, yF + 4], 'FP execute (stage 1)');
  place('fcsrE', FCSR_CALC, [xDE + 30, yF + 120], 'fcsr read');
  place('siE', splitter([7, 5, 3, 5, 5, 7]), [xDE + 14, yF + 120]);
  // M
  alignY('dm', DM, xEM + 18, 'addr', row('aluResult'));
  alignY('fwdM', M4, xEM + 12, 'd0', row('imm') + 14, 'M result');
  place('fadd', fmaAdd(F32), [xEM + 18, yF + 10], 'FP align + add (stage 2)');
  place('ftoi', fpToIntRound(F32), [xEM + 18, yF + 70], 'float → int: round');
  place('tiY', M2, [xEM + 44, yF + 70]); place('tiF', busMux2(5), [xEM + 44, yF + 82]);
  // X
  alignY('resX', M4, xMX + 12, 'd0', row('aluResult'), 'X result');
  place('fres', FP_RESULT, [xMX + 18, yF + 10], 'FP round (stage 3)');
  // W
  alignY('resW', M4, xXW + 10, 'd0', row('aluResult'), 'result');
  place('xres', M2, [xXW + 24, row('aluResult') - 6], 'int / FP');
  place('fwres', M2, [xXW + 16, yF + 10], 'FP / load');
  place('fcsr', FCSR_REGS, [xXW + 16, yF + 40], 'fcsr');
  // hazards and stall logic
  place('hz', HAZARD6, [xFD + 40, T + PIPE_H + 4], 'hazard unit');
  place('fhz', FP_HAZARD, [xFD + 78, T + PIPE_H + 4], 'FP hazards');
  place('stD', OR, [xFD + 106, T + PIPE_H + 4]); place('stAll', OR, [xFD + 118, T + PIPE_H + 5]); place('go', NOT, [xFD + 130, T + PIPE_H + 6]);
  place('ndv', NOT, [xFD + 112, T + PIPE_H + 24]); place('flD', OR, [xFD + 118, T + PIPE_H + 16]); place('flDg', AND, [xFD + 130, T + PIPE_H + 16]);
  place('en1', TIE1, [xEM - 8, T + PIPE_H - 5]); place('zero', TIE0, [xMX - 8, T + PIPE_H - 3]);

  const instances: InstanceDef[] = [...at.keys()].map((n) => ({ name: n, def: defs.get(n)!, at: at.get(n), label: labels[n] }));
  // tags default to all ends; 'wire' draws the net as wires (an explicit undefined would select the default)
  const N = (name: string, ends: string[], tags: NetDef['tags'] | 'wire' = true): NetDef => ({ name, ends, tags: tags === 'wire' ? undefined : tags });
  const nets: NetDef[] = [
    // F
    N('PCNext', ['pcmux.y', 'pc.d'], 'wire'),
    N('enPC', ['go.y', 'pc.en', 'FD.en']),
    { name: 'PCF', ends: ['pc.q', 'imem.addr', 'plus4.a', 'FD.pcF', 'pcF'], tags: ['pcF'], trunk: P('pc', 'q')[0] + 3 },
    N('PCPlus4F', ['plus4.y', 'FD.pcPlus4F', 'pcmux.d0', 'pcmux.d3'], ['pcmux.d0', 'pcmux.d3']),
    N('InstrF', ['imem.data', 'FD.instrF'], 'wire'),
    N('vF', ['vF.y', 'FD.validF'], 'wire'),
    N('flushFD', ['hz.taken', 'FD.clr', 'flD.b']),
    // D
    N('validD', ['FD.validD', 'DE.validD'], 'wire'),
    N('PCD', ['FD.pcD', 'DE.pcD'], 'wire'),
    N('PCPlus4D', ['FD.pcPlus4D', 'DE.pcPlus4D'], 'wire'),
    N('InstrD', ['FD.instrD', 'si.in', 'imm.instr', 'DEF.instrD'], ['imm.instr', 'DEF.instrD']),
    N('opD', ['si.o0', 'fdec.op', 'fuse.op']),
    N('opIntD', ['fdec.opInt', 'ctl.op']),
    N('rdD', ['si.o1', 'DE.rdD']),
    N('funct3D', ['si.o2', 'ctl.funct3', 'DE.funct3D', 'fuse.funct3']),
    N('rs1D', ['si.o3', 'rf.ra1', 'frf.ra1', 'DE.rs1D', 'hz.rs1D', 'fhz.rs1D']),
    N('rs2D', ['si.o4', 'rf.ra2', 'frf.ra2', 'DE.rs2D', 'hz.rs2D', 'fhz.rs2D', 'fuse.rs2']),
    N('funct7D', ['si.o5', 'ctl.funct7', 'fdec.funct7', 'fuse.funct7', 'sr3.in']),
    N('rs3D', ['sr3.o1', 'frf.ra3', 'fhz.rs3D']),
    N('rfRd1', ['rf.rd1', 'byA.a'], 'wire'), N('rfRd2', ['rf.rd2', 'byB.a'], 'wire'),
    N('RD1D', ['byA.y', 'DE.rd1D'], 'wire'), N('RD2D', ['byB.y', 'DE.rd2D'], 'wire'),
    N('bypassA', ['hz.bypassA', 'byA.s']), N('bypassB', ['hz.bypassB', 'byB.s']),
    N('ImmSrcD', ['ctl.immSrc', 'imm.src']), N('ImmExtD', ['imm.imm', 'DE.immD'], 'wire'),
    ...['aluSrcA', 'aluSrcB', 'memWrite', 'resultSrc', 'branch', 'jump', 'jalr'].map((f) => N(`${f}D`, [`ctl.${f}`, `DE.${f}D`], undefined)),
    N('aluCtlD', ['ctl.aluCtl', 'DE.aluCtlD'], 'wire'),
    N('ctlRegWrite', ['ctl.regWrite', 'rwx.a']),
    N('isFlwD', ['fdec.flw', 'nflw.a', 'DEF.isFlwD', 'fuse.flw']), N('¬flw', ['nflw.y', 'rwx.b'], 'wire'),
    N('isFswD', ['fdec.fsw', 'DEF.isFswD', 'fuse.fsw']),
    N('toIntD', ['fdec.toInt', 'rwi.b', 'DEF.toIntD']),
    N('RegWriteIntD', ['rwx.y', 'rwi.a'], 'wire'), N('regWriteD', ['rwi.y', 'DE.regWriteD']),
    N('fWriteD', ['fdec.fWrite', 'DEF.fWriteD']),
    N('opfpD', ['fdec.opfp', 'fuse.opfp']),
    N('fpOpD', ['fdec.fpOp', 'DEF.fpOpD', 'fhz.fpOpD']),
    N('fmaD', ['fdec.fma', 'fuse.fma']),
    N('usesF1', ['fuse.usesF1', 'fhz.usesF1']), N('usesF2', ['fuse.usesF2', 'fhz.usesF2']), N('usesF3', ['fuse.usesF3', 'fhz.usesF3']),
    N('readsX1', ['fuse.readsX1', 'fhz.readsX1']), N('readsX2', ['fuse.readsX2', 'fhz.readsX2']),
    N('isCsrD', ['fuse.isCsr', 'fhz.isCsrD', 'DEF.isCsrD']),
    N('frfRd1', ['frf.rd1', 'fbyA.a'], 'wire'), N('frfRd2', ['frf.rd2', 'fbyB.a'], 'wire'), N('frfRd3', ['frf.rd3', 'fbyC.a'], 'wire'),
    N('FRD1D', ['fbyA.y', 'DEF.frd1D']), N('FRD2D', ['fbyB.y', 'DEF.frd2D']), N('FRD3D', ['fbyC.y', 'DEF.frd3D']),
    N('fbypassA', ['fhz.byA', 'fbyA.s']), N('fbypassB', ['fhz.byB', 'fbyB.s']), N('fbypassC', ['fhz.byC', 'fbyC.s']),
    // stall / flush: D waits (load-use, FP interlocks), E waits (fdiv / fsqrt), a taken branch flushes F and D
    N('lwStall', ['hz.lwStall', 'stD.a']), N('fpStall', ['fhz.stall', 'stD.b']),
    N('stallD', ['stD.y', 'stAll.a', 'flD.a'], ['flD.a']),
    N('divStall', ['fpx.stall', 'stAll.b', 'ndv.a', 'EM.clr', 'EMF.clr']),
    N('stall', ['stAll.y', 'go.a'], 'wire'),
    N('¬divStall', ['ndv.y', 'DE.en', 'DEF.en', 'flDg.b']),
    N('flushOrStall', ['flD.y', 'flDg.a']),
    N('flushDE', ['flDg.y', 'DE.clr', 'DEF.clr']),
    N('en1', ['en1.y', 'EM.en', 'EMF.en', 'MX.en', 'MXF.en', 'XW.en', 'XWF.en'], ['EMF.en', 'MX.en', 'MXF.en', 'XW.en', 'XWF.en']),
    N('noClear', ['zero.y', 'MX.clr', 'MXF.clr', 'XW.clr', 'XWF.clr'], ['MXF.clr', 'XW.clr', 'XWF.clr']),
    // E
    N('validE', ['DE.validE', 'EM.validE', 'hz.validE'], ['hz.validE']),
    N('PCE', ['DE.pcE', 'EM.pcE', 'srcA.b', 'target.a'], ['srcA.b', 'target.a']),
    N('PCPlus4E', ['DE.pcPlus4E', 'EM.pcPlus4E'], 'wire'),
    N('RD1E', ['DE.rd1E', 'fwdA.d0'], 'wire'), N('RD2E', ['DE.rd2E', 'fwdB.d0'], 'wire'),
    N('ImmExtE', ['DE.immE', 'EM.immE', 'srcB.b', 'target.b'], ['srcB.b', 'target.b']),
    N('rs1E', ['DE.rs1E', 'hz.rs1E']), N('rs2E', ['DE.rs2E', 'hz.rs2E']),
    N('rdE', ['DE.rdE', 'EM.rdE', 'hz.rdE', 'fhz.rdE'], ['hz.rdE', 'fhz.rdE']),
    N('regWriteE', ['DE.regWriteE', 'rwc.a']), N('regWriteE2', ['rwc.y', 'EM.regWriteE']),
    N('memWriteE', ['DE.memWriteE', 'EM.memWriteE'], 'wire'),
    N('resultSrcE', ['DE.resultSrcE', 'EM.resultSrcE', 'hz.resultSrcE'], ['hz.resultSrcE']),
    N('ALUSrcAE', ['DE.aluSrcAE', 'srcA.s']), N('ALUSrcBE', ['DE.aluSrcBE', 'srcB.s']),
    N('BranchE', ['DE.branchE', 'npc.branch']), N('JumpE', ['DE.jumpE', 'npc.jump']), N('JalrE', ['DE.jalrE', 'npc.jalr']),
    N('ALUControlE', ['DE.aluCtlE', 'alu.ctl']), N('funct3E', ['DE.funct3E', 'npc.funct3']),
    N('forwardA', ['hz.forwardA', 'fwdA.s']), N('forwardB', ['hz.forwardB', 'fwdB.s']),
    N('ResultW', ['xres.y', 'fwdA.d1', 'fwdB.d1', 'byA.b', 'byB.b', 'rf.wd']),
    N('FwdM', ['fwdM.y', 'fwdA.d2', 'fwdB.d2']),
    N('ResultX', ['resX.y', 'fwdA.d3', 'fwdB.d3']),
    N('SrcAE', ['fwdA.y', 'srcA.a', 'fpx.xa', 'fcsrE.xa'], ['fpx.xa', 'fcsrE.xa']),
    N('WriteDataE', ['fwdB.y', 'srcB.a', 'stData.a'], ['stData.a']),
    N('SrcA', ['srcA.y', 'alu.a'], 'wire'), N('SrcB', ['srcB.y', 'alu.b'], 'wire'),
    N('ALUResultE', ['alu.y', 'aluOrCsr.a', 'clr0.in'], ['clr0.in']),
    N('Zero', ['alu.zero', 'npc.zero']), N('Neg', ['alu.neg', 'npc.neg']), N('Ovf', ['alu.ovf', 'npc.ovf']), N('Carry', ['alu.carry', 'npc.carry']),
    { name: 'gT', ends: ['gT.y', 'target.cin'], via: { 'target.cin': [[P('target', 'cin')[0] - 2, P('gT', 'y')[1]], [P('target', 'cin')[0] - 2, P('target', 'cin')[1]]] } }, N('gJ', ['gJ.y', 'clr0.zero'], 'wire'),
    N('PCTargetE', ['target.s', 'pcmux.d1']), N('JalrTargetE', ['clr0.out', 'pcmux.d2']),
    N('PCSrcE', ['npc.pcSrc', 'pcmux.s', 'hz.pcSrcE']),
    N('InstrE', ['DEF.instrE', 'fpx.instr', 'siE.in']),
    N('opE', ['siE.o0', 'fcsrE.op']), N('csrF3E', ['siE.o2', 'fcsrE.funct3']), N('csrRs1E', ['siE.o3', 'fcsrE.rs1']),
    N('csrRs2E', ['siE.o4', 'fcsrE.rs2']), N('csrF7E', ['siE.o5', 'fcsrE.funct7']),
    N('FRD1E', ['DEF.frd1E', 'fA.a'], 'wire'), N('FRD2E', ['DEF.frd2E', 'fB.a'], 'wire'), N('FRD3E', ['DEF.frd3E', 'fC.a'], 'wire'),
    N('ffwdAD', ['fhz.fwdA', 'DEF.fwdAD']), N('ffwdBD', ['fhz.fwdB', 'DEF.fwdBD']), N('ffwdCD', ['fhz.fwdC', 'DEF.fwdCD']),
    N('ffwdA', ['DEF.fwdAE', 'fA.s']), N('ffwdB', ['DEF.fwdBE', 'fB.s']), N('ffwdC', ['DEF.fwdCE', 'fC.s']),
    N('FAE', ['fA.y', 'fpx.a']), N('FBE', ['fB.y', 'fpx.b', 'stData.b']), N('FCE', ['fC.y', 'fpx.c']),
    N('isFswE', ['DEF.isFswE', 'stData.s']),
    N('StoreDataE', ['stData.y', 'EM.writeDataE']),
    N('csrData', ['fcsrE.rdata', 'aluOrCsr.b']), N('isCsrHitE', ['fcsrE.hit', 'aluOrCsr.s', 'rwc.b']),
    N('ALUorCSR', ['aluOrCsr.y', 'EM.aluResultE']),
    N('frm', ['fcsr.frm', 'fpx.frm']), N('fcsrNow', ['fcsr.fcsr', 'fcsrE.fcsr']),
    N('csrNewE', ['fcsrE.newv', 'EMF.csrNewE']), N('csrWeFE', ['fcsrE.weF', 'EMF.csrWeFE']), N('csrWeRE', ['fcsrE.weR', 'EMF.csrWeRE']),
    ...['p', 'mc', 'dsat', 'cBig', 'eB', 'sB', 'effSub', 'nan', 'invalid', 'anyInf', 'infSign', 'dz', 'arith', 'simpleY', 'simpleFl', ...TOINT.map(([f]) => f)].map((f) => N(`${f}E`, [`fpx.${f}`, `EMF.${f}E`])),
    N('rmE', ['fpx.rmOut', 'EMF.rmE']),
    N('fWriteE', ['DEF.fWriteE', 'EMF.fWriteE', 'fhz.fWriteE']), N('toIntE', ['DEF.toIntE', 'EMF.toIntE', 'fhz.toIntE']),
    N('fpOpE', ['DEF.fpOpE', 'EMF.fpOpE', 'fhz.fpOpE']), N('isFlwE', ['DEF.isFlwE', 'EMF.isFlwE']), N('isCsrE', ['DEF.isCsrE', 'EMF.isCsrE', 'fhz.csrE']),
    // M
    N('validM', ['EM.validM', 'MX.validM'], 'wire'), N('PCM', ['EM.pcM', 'MX.pcM'], 'wire'),
    N('PCPlus4M', ['EM.pcPlus4M', 'MX.pcPlus4M', 'fwdM.d2'], ['fwdM.d2']),
    N('ALUResultM', ['EM.aluResultM', 'dm.addr', 'MX.aluResultM', 'fwdM.d0', 'fwdM.d1'], ['fwdM.d0', 'fwdM.d1']),
    N('WriteDataM', ['EM.writeDataM', 'dm.wd'], 'wire'),
    N('ImmExtM', ['EM.immM', 'MX.immM', 'fwdM.d3'], ['fwdM.d3']),
    N('rdM', ['EM.rdM', 'MX.rdM', 'hz.rdM', 'fhz.rdM'], ['hz.rdM', 'fhz.rdM']),
    N('regWriteM', ['EM.regWriteM', 'MX.regWriteM', 'hz.regWriteM'], ['hz.regWriteM']),
    N('MemWriteM', ['EM.memWriteM', 'dm.we']),
    N('resultSrcM', ['EM.resultSrcM', 'MX.resultSrcM', 'fwdM.s'], ['fwdM.s']),
    N('ReadDataM', ['dm.rd', 'MX.readDataM'], 'wire'),
    ...['p', 'mc', 'dsat', 'cBig', 'eB', 'sB', 'effSub'].map((f) => N(`${f}M`, [`EMF.${f}M`, `fadd.${f}`])),
    N('rmM', ['EMF.rmM', 'fadd.rm', 'MXF.rmM', 'ftoi.rm']),
    N('signM', ['fadd.sign', 'MXF.signM']), N('exM', ['fadd.ex', 'MXF.exM']), N('sumM', ['fadd.sum', 'MXF.sumM']),
    ...['nan', 'invalid', 'anyInf', 'infSign', 'dz', 'arith', 'csrNew', 'csrWeF', 'csrWeR', 'isFlw'].map((f) => N(`${f}M`, [`EMF.${f}M`, `MXF.${f}M`], undefined)),
    N('tiTM', ['EMF.tiTM', 'ftoi.t']), N('tiStM', ['EMF.tiStM', 'ftoi.sticky']), N('tiSignM', ['EMF.tiSignM', 'ftoi.sign']), N('tiNaNM', ['EMF.tiNaNM', 'ftoi.nan']),
    N('tiBadM', ['EMF.tiBadM', 'ftoi.bad']), N('tiSignedM', ['EMF.tiSignedM', 'ftoi.signed']), N('cvtWM', ['EMF.cvtWM', 'tiY.s', 'tiF.s']),
    N('simpleY_EM', ['EMF.simpleYM', 'tiY.a']), N('intY', ['ftoi.y', 'tiY.b']), N('simpleYM', ['tiY.y', 'MXF.simpleYM']),
    N('simpleFl_EM', ['EMF.simpleFlM', 'tiF.a']), N('intFl', ['ftoi.flags', 'tiF.b']), N('simpleFlM', ['tiF.y', 'MXF.simpleFlM']),
    N('fWriteM', ['EMF.fWriteM', 'MXF.fWriteM', 'fhz.fWriteM']), N('toIntM', ['EMF.toIntM', 'MXF.toIntM', 'fhz.toIntM']),
    N('fpOpM', ['EMF.fpOpM', 'MXF.fpOpM', 'fhz.fpOpM']), N('isCsrM', ['EMF.isCsrM', 'MXF.isCsrM', 'fhz.csrM']),
    // X
    N('validX', ['MX.validX', 'XW.validX'], 'wire'), N('PCX', ['MX.pcX', 'XW.pcX'], 'wire'),
    N('PCPlus4X', ['MX.pcPlus4X', 'XW.pcPlus4X', 'resX.d2'], ['resX.d2']),
    N('ALUResultX', ['MX.aluResultX', 'XW.aluResultX', 'resX.d0'], ['resX.d0']),
    N('ReadDataX', ['MX.readDataX', 'XW.readDataX', 'resX.d1'], ['resX.d1']),
    N('ImmExtX', ['MX.immX', 'XW.immX', 'resX.d3'], ['resX.d3']),
    N('rdX', ['MX.rdX', 'XW.rdX', 'hz.rdX', 'fhz.rdX'], ['hz.rdX', 'fhz.rdX']),
    N('regWriteX', ['MX.regWriteX', 'XW.regWriteX', 'hz.regWriteX'], ['hz.regWriteX']),
    N('resultSrcX', ['MX.resultSrcX', 'XW.resultSrcX', 'resX.s'], ['resX.s']),
    ...['sign', 'ex', 'sum', 'rm', 'nan', 'invalid', 'anyInf', 'infSign', 'dz', 'arith', 'simpleY', 'simpleFl'].map((f) => N(`${f}X`, [`MXF.${f}X`, `fres.${f}`])),
    N('fpResultX', ['fres.y', 'XWF.fpResultX']), N('flagsX', ['fres.flags', 'XWF.flagsX']),
    ...['csrNew', 'csrWeF', 'csrWeR', 'toInt', 'isFlw'].map((f) => N(`${f}X`, [`MXF.${f}X`, `XWF.${f}X`], undefined)),
    N('fWriteX', ['MXF.fWriteX', 'XWF.fWriteX', 'fhz.fWriteX']),
    N('fpOpX', ['MXF.fpOpX', 'XWF.fpOpX', 'fhz.fpOpX']), N('isCsrX', ['MXF.isCsrX', 'XWF.isCsrX', 'fhz.csrX']),
    // W
    N('validW', ['XW.validW', 'validW']), N('PCW', ['XW.pcW', 'pcW']),
    N('ALUResultW', ['XW.aluResultW', 'resW.d0'], 'wire'),
    N('ReadDataW', ['XW.readDataW', 'resW.d1', 'fwres.b'], ['fwres.b']),
    N('PCPlus4W', ['XW.pcPlus4W', 'resW.d2'], ['resW.d2']), N('ImmExtW', ['XW.immW', 'resW.d3'], ['resW.d3']),
    N('rdW', ['XW.rdW', 'rf.wa', 'frf.wa', 'hz.rdW', 'fhz.rdW']),
    N('regWriteW', ['XW.regWriteW', 'rf.we', 'hz.regWriteW']),
    N('resultSrcW', ['XW.resultSrcW', 'resW.s']),
    N('IntResultW', ['resW.y', 'xres.a'], 'wire'),
    N('fpResultW', ['XWF.fpResultW', 'xres.b', 'fwres.a']),
    N('toIntW', ['XWF.toIntW', 'xres.s']), N('isFlwW', ['XWF.isFlwW', 'fwres.s']),
    N('FResultW', ['fwres.y', 'frf.wd', 'fA.b', 'fB.b', 'fC.b', 'fbyA.b', 'fbyB.b', 'fbyC.b']),
    N('fWriteW', ['XWF.fWriteW', 'frf.we', 'fhz.fWriteW']),
    N('fpOpW', ['XWF.fpOpW', 'fcsr.fpOp', 'fhz.fpOpW']), N('flagsW', ['XWF.flagsW', 'fcsr.flags']),
    N('csrNewW', ['XWF.csrNewW', 'fcsr.newv']), N('csrWeFW', ['XWF.csrWeFW', 'fcsr.weF']), N('csrWeRW', ['XWF.csrWeRW', 'fcsr.weR']),
    N('clk', ['clk', 'pc.clk', 'FD.clk', 'rf.clk', 'frf.clk', 'DE.clk', 'DEF.clk', 'EM.clk', 'EMF.clk', 'dm.clk', 'MX.clk', 'MXF.clk', 'XW.clk', 'XWF.clk', 'fpx.clk', 'fcsr.clk']),
  ];
  const yb = yF + 150;
  return {
    id: `fppipe_${IM.id}${adder === 'ks' ? '_ks' : ''}${o.dmemK !== 5 ? `_d${o.dmemK}` : ''}`,
    name: `Pipelined RV32IF CPU${adder === 'ks' ? ' (fast adders)' : ''}`, category: 'cpu',
    summary: 'Six stages (F D E M X W) so that every instruction, integer or FP, retires in order after the same path. The FP pipe is the fused multiply-add split in three (multiply in E, align and add in M, round in X); fdiv / fsqrt iterate in E and stall the front end. An FP result can be used three cycles after it entered E (forwarded from W); a dependent instruction waits in D.',
    ports: [bit('clk', 'in', 'left', true), bus('pcF', 32, 'out'), bit('validW', 'out'), bus('pcW', 32, 'out')],
    symbol: { kind: 'box', label: 'RV32IF PIPE' },
    netlist: () => ({ pins: { clk: [0, yb], pcF: [xXW + 40, yb + 4], validW: [xXW + 40, yb + 7], pcW: [xXW + 40, yb + 10] }, instances, nets }),
    hdl: { verilog: FPPIPE_VERILOG },
  };
}

const FPPIPE_VERILOG = `// Pipelined RV32IF: F D E M X W. Integer instructions pass X unchanged; the FP pipe is
//   E: fma_multiply (and the operations that finish in one stage; fdiv / fsqrt iterate here)
//   M: fma_add      X: fma_round      W: write x or f register, accrue fflags, write fcsr
// Hazards: forwarding to E from M, X, W (integer) and from W (FP); a load stalls a dependent
// instruction one cycle; an FP result stalls a dependent instruction while it is in E or M;
// fdiv / fsqrt hold F, D, E and send bubbles into M; a taken branch flushes F and D.`;
