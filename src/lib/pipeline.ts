// Level 8: the five-stage pipelined RV32I processor (primer ch. 8, hdl/rv_pipe.sv), extended
// to all of RV32I. Stages: F(etch) D(ecode) E(xecute) M(emory) W(riteback).
//  - Pipeline registers: wide registers with enable (stall) and synchronous clear (bubble).
//  - Hazard unit: forwarding to E from M and W, a W→D bypass (instead of a falling-edge
//    register-file write, so every flip-flop shares one clock edge), load-use stall, and a
//    two-bubble flush when a branch or jump resolves taken in E.
//  - PC and a valid bit travel with every instruction (pipeline diagram; later, exceptions).

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord } from './alu';
import { andN, busMux2, decoder, equal, muxTree, rca } from './combinational';
export { equal } from './combinational';
import { cachedMemory } from './cache';
import { wbCache } from './cache2';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, PLUS4, PLUS4_FAST, dataMemory, rom } from './cpu';
import { DIV_E, MUL_E, MUL_M } from './pipem';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, NOT, OR, XOR } from './gates';
import { readPort, regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

// ---- small parts ---------------------------------------------------------------------------


/** Is the word non-zero? An OR tree. */
export function nonZero(n: number): ComponentDef {
  return memo(`nz${n}`, () => {
    const O = orN(n);
    const og = symbolGeom(O);
    return define({
      id: `nz${n}`, name: `${n}-bit non-zero`, category: 'routing',
      summary: 'OR of all bits: 1 unless the word is zero. Used so that x0 is never forwarded.',
      ports: [bus('a', n, 'in'), bit('nz', 'out')],
      symbol: { kind: 'box', label: '≠0' },
      spec: ([a]) => [a ? 1 : 0],
      netlist: () => ({
        pins: { a: [1, n], nz: [8 + og.w + 4, og.h / 2] },
        instances: [{ name: 's', def: splitter(ones(n)), at: [3, 0] }, { name: 'or', def: O, at: [7, 0] }],
        nets: [{ ends: ['a', 's.in'] }, ...Array.from({ length: n }, (_, i): NetDef => ({ ends: [`s.o${i}`, `or.i${i}`] })), { ends: ['or.y', 'nz'] }],
      }),
    });
  });
}

/** Register with load enable and synchronous clear (clear wins and also forces a load). */
export function clearableRegister(n: number): ComponentDef {
  return memo(`creg${n}`, () => {
    const R = register(n), A = bitwise('and', n), F = fanout(n);
    const rg = symbolGeom(R), ag = symbolGeom(A);
    const aAt: [number, number] = [14, 2];
    const rAt: [number, number] = [aAt[0] + ag.w + 6, aAt[1] + ag.ports.y.pos[1] - rg.ports.d.pos[1]];
    const yb = Math.max(aAt[1] + ag.h, rAt[1] + rg.h) + 4;
    return define({
      id: `creg${n}`, name: `${n}-bit register with clear`, category: 'sequential',
      summary: 'A register with enable and synchronous clear: clr = 1 loads zeros on the next edge (a pipeline bubble), en = 0 holds (a stall).',
      ports: [bus('d', n, 'in'), bit('en', 'in'), bit('clr', 'in'), bit('clk', 'in', 'bottom', true), bus('q', n, 'out')],
      symbol: { kind: 'box', label: `REG${n}+CLR` },
      netlist: () => ({
        pins: { d: [0, aAt[1] + ag.ports.a.pos[1]], en: [0, yb], clr: [0, yb + 3], clk: [0, yb + 6], q: [rAt[0] + rg.w + 5, rAt[1] + rg.ports.q.pos[1]] },
        instances: [
          { name: 'nclr', def: NOT, at: [3, yb + 2] },
          { name: 'fan', def: F, at: [8, aAt[1] + ag.ports.b.pos[1] - 1] },
          { name: 'mask', def: A, at: aAt },
          { name: 'load', def: OR, at: [rAt[0] - 6, yb - 1] },
          { name: 'reg', def: R, at: rAt },
        ],
        nets: [
          { name: 'd', ends: ['d', 'mask.a'] },
          { name: 'clr', ends: ['clr', 'nclr.a', 'load.b'], trunk: 1.5 },
          { name: 'keep', ends: ['nclr.y', 'fan.in'], via: { 'fan.in': [[7, yb + 3], [7, aAt[1] + ag.ports.b.pos[1]]] } },
          { name: 'keepw', ends: ['fan.out', 'mask.b'] },
          { name: 'en', ends: ['en', 'load.a'] },
          { name: 'next', ends: ['mask.y', 'reg.d'] },
          { name: 'ld', ends: ['load.y', 'reg.en'], via: { 'reg.en': [[rAt[0] - 1, yb + 1], [rAt[0] - 1, rAt[1] + rg.ports.en.pos[1]]] } },
          { name: 'clk', ends: ['clk', 'reg.clk'], via: { 'reg.clk': [[rAt[0] + rg.ports.clk.pos[0], yb + 6]] } },
          { name: 'q', ends: ['reg.q', 'q'] },
        ],
      }),
    });
  });
}

// ---- pipeline registers ------------------------------------------------------------------------

/** Row of each field in every pipeline register, so that shared fields line up across stages. */
const ROWS: Record<string, number> = {
  valid: 0, pc: 1, pcPlus4: 2, instr: 3, rd1: 3, aluResult: 3, rd2: 4, writeData: 4, readData: 4, imm: 5, predTarget: 6,
  rs1: 7, rs2: 8, rd: 9,
  regWrite: 10, aluSrcA: 12, aluSrcB: 13, memWrite: 14, resultSrc: 15, branch: 16, jump: 17, jalr: 18, aluCtl: 19, funct3: 20,
  fwdA: 21, fwdB: 22, predTaken: 23,
};
const WIDTH: Record<string, number> = {
  valid: 1, pc: 32, pcPlus4: 32, instr: 32, rd1: 32, aluResult: 32, rd2: 32, writeData: 32, readData: 32, imm: 32, predTarget: 32,
  rs1: 5, rs2: 5, rd: 5, regWrite: 1, aluSrcA: 1, aluSrcB: 1, memWrite: 1, resultSrc: 2, branch: 1, jump: 1, jalr: 1, aluCtl: 4, funct3: 3,
  fwdA: 2, fwdB: 2, predTaken: 1,
};
/** y of a field row relative to the top of a pipeline register. Data rows are 4 apart, control rows 2. */
export const rowY = (field: string) => { const r = ROWS[field]; return r <= 9 ? 2 + 4 * r : 42 + 2 * (r - 10); };
export const PIPE_H = rowY('predTaken') + 6;

export function pipeReg(name: string, from: string, to: string, fields: string[]): ComponentDef {
  const sig = fields.join(',');
  return memo(`pipe_${name}_${sig}`, () => {
    const widths = fields.map((f) => WIDTH[f]);
    const total = widths.reduce((a, b) => a + b, 0);
    const C = clearableRegister(total);
    const cg = symbolGeom(C);
    const portPos: Record<string, number> = { en: PIPE_H - 4, clr: PIPE_H - 2 };
    for (const f of fields) {
      portPos[f + from] = rowY(f);
      portPos[f + to] = rowY(f);
    }
    const P = 3;
    return define({
      id: `pipe_${name.replace('/', '')}_${total}`, name: `${name} pipeline register`, category: 'sequential',
      summary: `Holds everything the next stage needs (${total} bits): ${fields.join(', ')}. en = 0 stalls it, clr = 1 turns its contents into a bubble.`,
      ports: [
        ...fields.map((f) => bus(f + from, WIDTH[f], 'in')), bit('en', 'in'), bit('clr', 'in'), bit('clk', 'in', 'bottom', true),
        ...fields.map((f) => bus(f + to, WIDTH[f], 'out')),
      ],
      symbol: { kind: 'box', label: name, w: 3, h: PIPE_H, portPos, noPortLabels: true, verticalLabel: true },
      netlist: () => ({
        pins: {
          ...Object.fromEntries(fields.map((f, i) => [f + from, [0, 2 + P * i] as [number, number]])),
          ...Object.fromEntries(fields.map((f, i) => [f + to, [24 + cg.w + 14, 2 + P * i] as [number, number]])),
          en: [0, 2 + P * fields.length + 3], clr: [0, 2 + P * fields.length + 5], clk: [0, 2 + P * fields.length + 7],
        },
        instances: [
          { name: 'bundle', def: merger(widths, P), at: [8, 2 - P / 2] },
          { name: 'r', def: C, at: [18, 2] },
          { name: 'unbundle', def: splitter(widths, P), at: [24 + cg.w + 6, 2 - P / 2] },
        ],
        nets: [
          ...fields.map((f, i): NetDef => ({ name: f + from, ends: [f + from, `bundle.i${i}`] })),
          { name: 'd', ends: ['bundle.out', 'r.d'] },
          { name: 'en', ends: ['en', 'r.en'] }, { name: 'clr', ends: ['clr', 'r.clr'] }, { name: 'clk', ends: ['clk', 'r.clk'] },
          { name: 'q', ends: ['r.q', 'unbundle.in'] },
          ...fields.map((f, i): NetDef => ({ name: f + to, ends: [`unbundle.o${i}`, f + to] })),
        ],
      }),
    });
  });
}

const CTRL_E = ['regWrite', 'aluSrcA', 'aluSrcB', 'memWrite', 'resultSrc', 'branch', 'jump', 'jalr', 'aluCtl', 'funct3'];
export const REG_FD = (pred = false) => pipeReg('IF/ID', 'F', 'D', ['valid', 'pc', 'pcPlus4', 'instr', ...(pred ? ['predTarget', 'predTaken'] : [])]);
export const REG_DE = (pre = false, pred = false) => pipeReg('ID/EX', 'D', 'E', [
  'valid', 'pc', 'pcPlus4', 'rd1', 'rd2', 'imm', ...(pred ? ['predTarget'] : []), 'rs1', 'rs2', 'rd', ...CTRL_E,
  ...(pre ? ['fwdA', 'fwdB'] : []), ...(pred ? ['predTaken'] : []),
]);
export const REG_EM = () => pipeReg('EX/MEM', 'E', 'M', ['valid', 'pc', 'pcPlus4', 'aluResult', 'writeData', 'imm', 'rd', 'regWrite', 'memWrite', 'resultSrc']);
export const REG_MW = () => pipeReg('MEM/WB', 'M', 'W', ['valid', 'pc', 'pcPlus4', 'aluResult', 'readData', 'imm', 'rd', 'regWrite', 'resultSrc']);

// ---- hazard unit ---------------------------------------------------------------------------------

/**
 * Hazard unit. With `pre` (balanced pipeline) the forwarding decision for the instruction in D
 * is computed one stage early from rdE / rdM (which will be in M / W next cycle) and handed
 * to ID/EX, so no comparator sits in the execute stage.
 */
export function hazardUnit(pre: boolean): ComponentDef {
  return memo(`hazard_${pre}`, () => {
    const E5 = equal(5), NZ = nonZero(5);
    const eg = symbolGeom(E5);
    const cmps: [string, string, string][] = pre
      ? [['aM', 'rs1D', 'rdM'], ['bM', 'rs2D', 'rdM'], ['lw1', 'rs1D', 'rdE'], ['lw2', 'rs2D', 'rdE'], ['dA', 'rs1D', 'rdW'], ['dB', 'rs2D', 'rdW']]
      : [['aM', 'rs1E', 'rdM'], ['aW', 'rs1E', 'rdW'], ['bM', 'rs2E', 'rdM'], ['bW', 'rs2E', 'rdW'],
        ['lw1', 'rs1D', 'rdE'], ['lw2', 'rs2D', 'rdE'], ['dA', 'rs1D', 'rdW'], ['dB', 'rs2D', 'rdW']];
    const nzs: [string, string][] = pre ? [['nz1D', 'rs1D'], ['nz2D', 'rs2D']] : [['nz1E', 'rs1E'], ['nz2E', 'rs2E'], ['nz1D', 'rs1D'], ['nz2D', 'rs2D']];
    const instances: InstanceDef[] = [];
    const ends = new Map<string, string[]>();
    const sink = (net: string, end: string) => { if (!ends.has(net)) ends.set(net, [net]); ends.get(net)!.push(end); };
    cmps.forEach(([n, a, b], i) => {
      instances.push({ name: `eq_${n}`, def: E5, at: [14, 2 + i * (eg.h + 2)] });
      sink(a, `eq_${n}.a`);
      sink(b, `eq_${n}.b`);
    });
    const yN = 2 + cmps.length * (eg.h + 2);
    nzs.forEach(([n, a], i) => {
      instances.push({ name: n, def: NZ, at: [14, yN + i * 6] });
      sink(a, `${n}.a`);
    });
    const A3 = andN(3), A4 = andN(4);
    // Comparator outputs (x = 20) are tagged to the right and the gate inputs to the left: the
    // gap holds the longest names ('rs1E=rdW' one way, '¬resSrcE[1]' the other) side by side.
    const gx = 38;
    let gy = 2;
    const gate = (name: string, def: ComponentDef) => { instances.push({ name, def, at: [gx, gy] }); gy += symbolGeom(def).h + 3; };
    gate('fA1', A3); gate('nfA1', NOT); gate('fA0', A4);
    gate('fB1', A3); gate('nfB1', NOT); gate('fB0', A4);
    gate('byA', A3); gate('byB', A3);
    gate('nres1', NOT); gate('isLoad', AND); gate('lwUse', OR); gate('lwStall', andN(3));
    gate('taken', OR); gate('noStall', NOT); gate('flDE', OR);
    const ySp = yN + nzs.length * 6 + 4;
    // Mergers sit with their M input (i1) level with the M gate's output, so that wire is straight.
    instances.push({ name: 'mfa', def: merger([1, 1]), at: [gx + 12, 2] }, { name: 'mfb', def: merger([1, 1]), at: [gx + 12, 27] });
    instances.push({ name: 'srs', def: splitter([1, 1]), at: [6, ySp] }, { name: 'sps', def: splitter([1, 1]), at: [6, ySp + 6] });
    // Which comparators feed forwarding: E-stage versions, or the D-stage look-ahead versions.
    const fA1src = pre ? 'eq_lw1.eq' : 'eq_aM.eq', fA0src = pre ? 'eq_aM.eq' : 'eq_aW.eq';
    const fB1src = pre ? 'eq_lw2.eq' : 'eq_bM.eq', fB0src = pre ? 'eq_bM.eq' : 'eq_bW.eq';
    const nzA = pre ? 'nz1D.nz' : 'nz1E.nz', nzB = pre ? 'nz2D.nz' : 'nz2E.nz';
    const regM = pre ? 'regWriteE' : 'regWriteM', regW = pre ? 'regWriteM' : 'regWriteW';
    const wires = new Map<string, string[]>();
    const w = (drv: string, ...ss: string[]) => wires.set(drv, [...(wires.get(drv) ?? []), ...ss]);
    w(fA1src, 'fA1.i1'); w(fA0src, 'fA0.i1'); w(fB1src, 'fB1.i1'); w(fB0src, 'fB0.i1');
    w('eq_lw1.eq', 'lwUse.a'); w('eq_lw2.eq', 'lwUse.b'); w('eq_dA.eq', 'byA.i1'); w('eq_dB.eq', 'byB.i1');
    w(nzA, 'fA1.i0', 'fA0.i0'); w(nzB, 'fB1.i0', 'fB0.i0'); w('nz1D.nz', 'byA.i0'); w('nz2D.nz', 'byB.i0');
    w('fA1.y', 'nfA1.a', 'mfa.i1'); w('nfA1.y', 'fA0.i3'); w('fA0.y', 'mfa.i0');
    w('fB1.y', 'nfB1.a', 'mfb.i1'); w('nfB1.y', 'fB0.i3'); w('fB0.y', 'mfb.i0');
    w('srs.o1', 'nres1.a'); w('srs.o0', 'isLoad.a'); w('nres1.y', 'isLoad.b');
    w('isLoad.y', 'lwStall.i0'); w('lwUse.y', 'lwStall.i1');
    w('sps.o0', 'taken.a'); w('sps.o1', 'taken.b');
    w('lwStall.y', 'noStall.a', 'flDE.a'); w('taken.y', 'flDE.b', 'flushFD');
    const nets: NetDef[] = [];
    for (const [n, e] of ends) nets.push({ name: n, ends: e, tags: e.slice(1) });
    const named: Record<string, string> = {
      'eq_aM.eq': pre ? 'rs1D=rdM' : 'rs1E=rdM', 'eq_aW.eq': 'rs1E=rdW', 'eq_bM.eq': pre ? 'rs2D=rdM' : 'rs2E=rdM', 'eq_bW.eq': 'rs2E=rdW',
      'eq_lw1.eq': 'rs1D=rdE', 'eq_lw2.eq': 'rs2D=rdE', 'eq_dA.eq': 'rs1D=rdW', 'eq_dB.eq': 'rs2D=rdW',
      'nz1E.nz': 'rs1E≠0', 'nz2E.nz': 'rs2E≠0', 'nz1D.nz': 'rs1D≠0', 'nz2D.nz': 'rs2D≠0',
      'fA1.y': 'fwdA_M', 'nfA1.y': '¬fwdA_M', 'fA0.y': 'fwdA_W', 'fB1.y': 'fwdB_M', 'nfB1.y': '¬fwdB_M', 'fB0.y': 'fwdB_W',
      'srs.o1': 'resSrcE[1]', 'srs.o0': 'resSrcE[0]', 'nres1.y': '¬resSrcE[1]', 'isLoad.y': 'loadE', 'lwUse.y': 'uses rdE',
      'sps.o0': 'pcSrcE[0]', 'sps.o1': 'pcSrcE[1]', 'lwStall.y': 'lwStall', 'taken.y': 'taken',
    };
    // fwd*_M is drawn: straight into its merger, and looped under its gate into the inverter below.
    const loop = (g: number): NetDef['via'] => ({ [`nf${g === 0 ? 'A' : 'B'}1.a`]: [[gx + 6, g === 0 ? 9 : 34], [gx - 2, g === 0 ? 9 : 34]] });
    const drawnNets: Record<string, Partial<NetDef>> = { 'fA1.y': { tags: undefined, via: loop(0) }, 'fB1.y': { tags: undefined, via: loop(1) } };
    for (const [drv, ss] of wires) nets.push({ name: named[drv], ends: [drv, ...ss], tags: true, ...drawnNets[drv] });
    nets.push(
      { name: regM, ends: [regM, 'fA1.i2', 'fB1.i2'], tags: ['fA1.i2', 'fB1.i2'] },
      { name: regW, ends: [regW, 'fA0.i2', 'fB0.i2', ...(pre ? [] : ['byA.i2', 'byB.i2'])], tags: ['fA0.i2', 'fB0.i2', ...(pre ? [] : ['byA.i2', 'byB.i2'])] },
      ...(pre ? [{ name: 'regWriteW', ends: ['regWriteW', 'byA.i2', 'byB.i2'], tags: ['byA.i2', 'byB.i2'] } as NetDef] : []),
      { name: 'resultSrcE', ends: ['resultSrcE', 'srs.in'] },
      { name: 'validE', ends: ['validE', 'lwStall.i2'], tags: ['lwStall.i2'] },
      { name: 'pcSrcE', ends: ['pcSrcE', 'sps.in'] },
      { name: 'forwardA', ends: ['mfa.out', 'forwardA'] },
      { name: 'forwardB', ends: ['mfb.out', 'forwardB'], trunk: gx + 14 },
      { name: 'bypassA', ends: ['byA.y', 'bypassA'], tags: true },
      { name: 'bypassB', ends: ['byB.y', 'bypassB'], tags: true },
      { name: 'enable', ends: ['noStall.y', 'enPC', 'enFD'], tags: true },
      { name: 'flushDE', ends: ['flDE.y', 'flushDE'], tags: true },
    );
    const regIns = pre ? ['regWriteE', 'regWriteM', 'regWriteW'] : ['regWriteM', 'regWriteW'];
    const rsIns = pre ? ['rs1D', 'rs2D'] : ['rs1D', 'rs2D', 'rs1E', 'rs2E'];
    const inNames = [...rsIns, 'rdE', 'rdM', 'rdW', ...regIns, 'validE'];
    const pins: Record<string, [number, number]> = {};
    inNames.forEach((n, i) => (pins[n] = [0, 2 + 3 * i]));
    pins.resultSrcE = [0, ySp + 1];
    pins.pcSrcE = [0, ySp + 7];
    const outNames = ['forwardA', 'forwardB', 'bypassA', 'bypassB', 'enPC', 'enFD', 'flushFD', 'flushDE'];
    outNames.forEach((n, i) => (pins[n] = [gx + 22, 4 + 6 * i]));
    return define({
      id: pre ? 'hazard_pre' : 'hazard', name: pre ? 'Hazard unit (look-ahead forwarding)' : 'Hazard unit', category: 'cpu',
      summary: pre
        ? 'Like the basic hazard unit, but forwarding is decided while the instruction is still in D (against the instructions that will be in M and W next cycle), and handed to ID/EX. The execute stage only sees a ready-made mux select.'
        : 'Watches register numbers across the stages. Forwards results from M or W to the ALU inputs, bypasses W into D, stalls on load-use, and flushes the two wrong-path instructions after a taken branch.',
      ports: [
        ...rsIns.map((n) => bus(n, 5, 'in')), bus('rdE', 5, 'in'), bus('rdM', 5, 'in'), bus('rdW', 5, 'in'),
        ...regIns.map((n) => bit(n, 'in')), bit('validE', 'in'), bus('resultSrcE', 2, 'in'), bus('pcSrcE', 2, 'in'),
        bus('forwardA', 2, 'out'), bus('forwardB', 2, 'out'), bit('bypassA', 'out'), bit('bypassB', 'out'),
        bit('enPC', 'out'), bit('enFD', 'out'), bit('flushFD', 'out'), bit('flushDE', 'out'),
      ],
      symbol: { kind: 'box', label: 'HAZARD UNIT' },
      netlist: () => ({ pins, instances, nets }),
      hdl: {
        verilog: pre ? `// Look-ahead forwarding: decided in D for the instruction about to enter E.
assign forwardA[1] = (rs1D != 0) && (rs1D == rdE) && regWriteE;           // producer will be in M
assign forwardA[0] = (rs1D != 0) && (rs1D == rdM) && regWriteM && !forwardA[1];  // ... or in W
// (same for B; bypass, load-use stall and flushes as in the basic unit)` : `module hazard (
  input  logic [4:0] rs1D, rs2D, rs1E, rs2E, rdE, rdM, rdW,
  input  logic       regWriteM, regWriteW, validE,
  input  logic [1:0] resultSrcE, pcSrcE,
  output logic [1:0] forwardA, forwardB,     // 00 register file, 01 W, 10 M
  output logic       bypassA, bypassB,       // W → D
  output logic       enPC, enFD, flushFD, flushDE);
  logic lwStall, taken;
  assign forwardA[1] = (rs1E != 0) && (rs1E == rdM) && regWriteM;
  assign forwardA[0] = (rs1E != 0) && (rs1E == rdW) && regWriteW && !forwardA[1];
  assign forwardB[1] = (rs2E != 0) && (rs2E == rdM) && regWriteM;
  assign forwardB[0] = (rs2E != 0) && (rs2E == rdW) && regWriteW && !forwardB[1];
  assign bypassA = (rs1D != 0) && (rs1D == rdW) && regWriteW;
  assign bypassB = (rs2D != 0) && (rs2D == rdW) && regWriteW;
  assign lwStall = validE && (resultSrcE == 2'b01) && ((rs1D == rdE) || (rs2D == rdE));   // load in E, use in D
  assign taken   = pcSrcE != 2'b00;                                         // redirect from E
  assign enPC = !lwStall;  assign enFD = !lwStall;
  assign flushFD = taken;  assign flushDE = lwStall || taken;
endmodule`,
      },
    });
  });
}
export const HAZARD = hazardUnit(false);

// ---- E-stage helpers for the balanced pipeline ------------------------------------------------------

/** Branch decision from the operands directly: equality comparator + fast subtractor, in parallel with the ALU. */
export const BRANCH_CMP: ComponentDef = (() => {
  const EQ = equal(32), SUB = addSubFast(32), NP = NEXT_PC;
  const eg = symbolGeom(EQ), sg = symbolGeom(SUB), ng = symbolGeom(NP);
  const sAt: [number, number] = [10, eg.h + 6];
  // Wide enough for the subtractor's flag tags and the next-PC input tags side by side.
  const nAt: [number, number] = [sAt[0] + sg.w + 12, 2];
  return define({
    id: 'branchcmp', name: 'Branch comparator', category: 'cpu',
    summary: 'Decides the branch from the (forwarded) operands with its own equality comparator and a fast subtractor, in parallel with the ALU, so the branch no longer waits for the ALU\'s result multiplexer and zero detector.',
    ports: [bus('a', 32, 'in'), bus('b', 32, 'in'), bus('funct3', 3, 'in'), bit('branch', 'in'), bit('jump', 'in'), bit('jalr', 'in'), bus('pcSrc', 2, 'out')],
    symbol: { kind: 'box', label: 'BRANCH' },
    netlist: () => ({
      pins: { a: [0, 4], b: [0, 6], funct3: [0, sAt[1] + sg.h + 4], branch: [0, sAt[1] + sg.h + 7], jump: [0, sAt[1] + sg.h + 10], jalr: [0, sAt[1] + sg.h + 13], pcSrc: [nAt[0] + ng.w + 5, nAt[1] + ng.ports.pcSrc.pos[1]] },
      instances: [
        { name: 'eq', def: EQ, at: [10, 2] },
        { name: 'sub', def: SUB, at: sAt },
        { name: 'one', def: TIE1, at: [4, sAt[1] + sg.ports.sub.pos[1] - 1] },
        { name: 'npc', def: NP, at: nAt },
      ],
      nets: [
        { name: 'a', ends: ['a', 'eq.a', 'sub.a'], trunk: 3 },
        { name: 'b', ends: ['b', 'eq.b', 'sub.b'], trunk: 5 },
        { name: 'sub1', ends: ['one.y', 'sub.sub'] },
        { name: 'equal', ends: ['eq.eq', 'npc.zero'], tags: true },
        { name: 'neg', ends: ['sub.n', 'npc.neg'], tags: true },
        { name: 'ovf', ends: ['sub.v', 'npc.ovf'], tags: true },
        { name: 'carry', ends: ['sub.cout', 'npc.carry'], tags: true },
        { name: 'funct3', ends: ['funct3', 'npc.funct3'], tags: ['npc.funct3'] },
        { name: 'branch', ends: ['branch', 'npc.branch'], tags: ['npc.branch'] },
        { name: 'jump', ends: ['jump', 'npc.jump'], tags: ['npc.jump'] },
        { name: 'jalr', ends: ['jalr', 'npc.jalr'], tags: ['npc.jalr'] },
        { name: 'pcSrc', ends: ['npc.pcSrc', 'pcSrc'] },
      ],
    }),
  });
})();

// ---- branch prediction -----------------------------------------------------------------------------------

/** 2-bit saturating counter update: new entries start weak; hits count up when taken, down otherwise. */
export const SAT_COUNTER: ComponentDef = define({
  id: 'satctr', name: '2-bit saturating counter (next state)', category: 'cpu',
  summary: 'Next prediction state: 00/01 predict not-taken, 10/11 taken. Taken counts up, not-taken counts down, saturating at the ends; a new entry starts weakly in the direction just seen.',
  ports: [bus('c', 2, 'in'), bit('taken', 'in'), bit('hit', 'in'), bus('next', 2, 'out')],
  symbol: { kind: 'box', label: '2-bit' },
  spec: ([c, t, hit]) => {
    if (!hit) return [t ? 2 : 1];
    return [t ? Math.min(3, c + 1) : Math.max(0, c - 1)];
  },
  netlist: () => ({
    pins: { c: [0, 4], taken: [0, 16], hit: [0, 22], next: [52, 10] },
    instances: [
      { name: 'sc', def: splitter([1, 1]), at: [3, 2] },
      { name: 'nc0', def: NOT, at: [6, 8] },
      { name: 'inc1', def: OR, at: [14, 0] }, { name: 'inc0', def: OR, at: [14, 6] },
      { name: 'dec1', def: AND, at: [14, 12] }, { name: 'dec0', def: AND, at: [14, 18] },
      { name: 'nt', def: NOT, at: [8, 24] },
      { name: 'm1', def: muxTree(1, 1), at: [24, 2] }, { name: 'm0', def: muxTree(1, 1), at: [24, 12] },
      { name: 'h1', def: muxTree(1, 1), at: [34, 4] }, { name: 'h0', def: muxTree(1, 1), at: [34, 14] },
      { name: 'mo', def: merger([1, 1]), at: [44, 9] },
    ],
    nets: [
      { name: 'c', ends: ['c', 'sc.in'] },
      { name: 'c1', ends: ['sc.o1', 'inc1.a', 'inc0.a', 'dec1.a', 'dec0.a'], tags: true },
      { name: 'c0', ends: ['sc.o0', 'inc1.b', 'nc0.a', 'dec1.b'], tags: true },
      { name: '¬c0', ends: ['nc0.y', 'inc0.b', 'dec0.b'], tags: ['dec0.b'] },
      { name: 'inc1', ends: ['inc1.y', 'm1.d1'] }, { name: 'inc0', ends: ['inc0.y', 'm0.d1'] },
      { name: 'dec1', ends: ['dec1.y', 'm1.d0'] }, { name: 'dec0', ends: ['dec0.y', 'm0.d0'] },
      { name: 'taken', ends: ['taken', 'm1.s', 'm0.s', 'nt.a', 'h1.d0'], tags: true },
      { name: '¬taken', ends: ['nt.y', 'h0.d0'], tags: true },
      { name: 'cnt1', ends: ['m1.y', 'h1.d1'] }, { name: 'cnt0', ends: ['m0.y', 'h0.d1'] },
      { name: 'hit', ends: ['hit', 'h1.s', 'h0.s'], tags: true },
      { name: 'n1', ends: ['h1.y', 'mo.i1'] }, { name: 'n0', ends: ['h0.y', 'mo.i0'] },
      { name: 'next', ends: ['mo.out', 'next'] },
    ],
  }),
});

/**
 * Branch target buffer: 16 entries of {valid, tag, target, 2-bit counter, is-jump}, built like
 * the register file (decoder + registers + two read ports). Read in F (predict), written in E.
 */
export const BTB: ComponentDef = (() => {
  const K = 4, N = 16, W = 1 + 26 + 32 + 2 + 1; // valid, tag, target, ctr, jmp
  const R = register(W);
  const rg = symbolGeom(R);
  const P = Math.max(rg.h + 4, 10);
  const D = decoder(K, true, P);
  const dg = symbolGeom(D);
  const RP = readPort(K, W), rpg = symbolGeom(RP);
  const fields = [1, 26, 32, 2, 1];
  const dAt: [number, number] = [20, 2];
  const xR = dAt[0] + dg.w + 8;
  const rTop = (i: number) => dAt[1] + dg.ports[`y${i}`].pos[1] - rg.ports.en.pos[1];
  const qY = (i: number) => rTop(i) + rg.ports.q.pos[1];
  const xQ = xR + rg.w + 6;
  const mqTop = qY(0) - P / 2;
  const xP = xQ + 8;
  const rpF: [number, number] = [xP, mqTop + 10];
  const rpE: [number, number] = [xP, rpF[1] + rpg.h + 20];
  const instances: InstanceDef[] = [
    { name: 'dec', def: D, at: dAt },
    { name: 'bundle', def: merger(Array(N).fill(W), P), at: [xQ, mqTop] },
    { name: 'rdF', def: RP, at: rpF, label: 'read (fetch)' },
    { name: 'rdE', def: RP, at: rpE, label: 'read (update)' },
    { name: 'spF', def: splitter([2, K, 26]), at: [4, -7] },
    { name: 'spE', def: splitter([2, K, 26]), at: [4, 3] },
    { name: 'fF', def: splitter([1, 26, 32, 1, 1, 1]), at: [xP + rpg.w + 6, rpF[1] + rpg.ports.y.pos[1] - 6] },
    { name: 'fE', def: splitter(fields), at: [xP + rpg.w + 6, rpE[1] + rpg.ports.y.pos[1] - 5] },
    { name: 'hitF', def: equal(26), at: [xP + rpg.w + 24, rpF[1] - 5] },
    { name: 'hitE', def: equal(26), at: [xP + rpg.w + 24, rpE[1] - 4] },
    { name: 'vF', def: AND, at: [xP + rpg.w + 40, rpF[1] - 4] },
    { name: 'vE', def: AND, at: [xP + rpg.w + 40, rpE[1] - 4] },
    { name: 'dir', def: OR, at: [xP + rpg.w + 40, rpF[1] + 4] },
    { name: 'pt', def: AND, at: [xP + rpg.w + 48, rpF[1]] },
    { name: 'ctr', def: SAT_COUNTER, at: [xP + rpg.w + 48, rpE[1] + 4] },
    { name: 'one', def: TIE1, at: [6, 18] },
    { name: 'newE', def: merger(fields), at: [10, 22] },
  ];
  const nets: NetDef[] = [
    { name: 'pcF', ends: ['pcF', 'spF.in'] },
    { name: 'pcE', ends: ['pcE', 'spE.in'] },
    { name: 'idxF', ends: ['spF.o1', 'rdF.sel'], tags: true },
    { name: 'tagF', ends: ['spF.o2', 'hitF.a'], tags: true },
    { name: 'idxE', ends: ['spE.o1', 'dec.a', 'rdE.sel'], tags: true },
    { name: 'tagE', ends: ['spE.o2', 'hitE.a', 'newE.i1'], tags: true },
    { name: 'upd', ends: ['updE', 'dec.en'], tags: true },
    { name: 'entries', ends: ['bundle.out', 'rdF.words', 'rdE.words'], trunk: xP - 3 },
    { name: 'entryF', ends: ['rdF.y', 'fF.in'] },
    { name: 'entryE', ends: ['rdE.y', 'fE.in'] },
    { name: 'validF', ends: ['fF.o0', 'vF.a'], tags: true },
    { name: 'storedTagF', ends: ['fF.o1', 'hitF.b'] },
    { name: 'predTarget', ends: ['fF.o2', 'predTarget'], tags: true },
    { name: 'ctrF[1]', ends: ['fF.o4', 'dir.b'], tags: true },
    { name: 'jmpF', ends: ['fF.o5', 'dir.a'], tags: true },
    { name: 'tagEqF', ends: ['hitF.eq', 'vF.b'] },
    { name: 'hitF', ends: ['vF.y', 'pt.a'], tags: true },
    { name: 'dirF', ends: ['dir.y', 'pt.b'] },
    { name: 'predTaken', ends: ['pt.y', 'predTaken'], tags: true },
    { name: 'validE', ends: ['fE.o0', 'vE.a'], tags: true },
    { name: 'storedTagE', ends: ['fE.o1', 'hitE.b'] },
    { name: 'ctrE', ends: ['fE.o3', 'ctr.c'], tags: true },
    { name: 'tagEqE', ends: ['hitE.eq', 'vE.b'] },
    { name: 'hitE', ends: ['vE.y', 'ctr.hit'], tags: true },
    { name: 'takenE', ends: ['takenE', 'ctr.taken'], tags: true },
    { name: 'ctrNext', ends: ['ctr.next', 'newE.i3'], tags: true },
    { name: 'v1', ends: ['one.y', 'newE.i0'] },
    { name: 'targetE', ends: ['targetE', 'newE.i2'], tags: true },
    { name: 'isJumpE', ends: ['isJumpE', 'newE.i4'], tags: true },
  ];
  const fieldsSink = Array.from({ length: N }, (_, i) => `w${i}.d`);
  const clk: string[] = ['clk'];
  for (let i = 0; i < N; i++) {
    instances.push({ name: `w${i}`, def: R, at: [xR, rTop(i)], label: `entry ${i}` });
    nets.push({ name: `en${i}`, ends: [`dec.y${i}`, `w${i}.en`] });
    nets.push({ name: `e${i}`, ends: [`w${i}.q`, `bundle.i${i}`] });
    clk.push(`w${i}.clk`);
  }
  nets.push({ name: 'newEntry', ends: ['newE.out', ...fieldsSink], trunk: xR - 3 });
  nets.push({ name: 'clk', ends: clk, tags: clk.slice(1) });
  void fieldsSink;
  return define({
    id: 'btb16', name: 'Branch target buffer (16 entries)', category: 'cpu',
    summary: '16 entries indexed by PC[5:2], each {valid, tag = PC[31:6], target, 2-bit counter, is-jump}. Fetch reads it to predict; Execute writes the outcome back. Built from the register file\'s parts: a decoder, registers and two read ports.',
    ports: [
      bus('pcF', 32, 'in'), bus('pcE', 32, 'in'), bit('updE', 'in'), bit('takenE', 'in'), bit('isJumpE', 'in'), bus('targetE', 32, 'in'),
      bit('clk', 'in', 'bottom', true), bit('predTaken', 'out'), bus('predTarget', 32, 'out'),
    ],
    symbol: { kind: 'box', label: 'BTB' },
    netlist: () => ({
      pins: { pcF: [0, -4], pcE: [0, 6], updE: [0, 10], takenE: [0, 12], isJumpE: [0, 14], targetE: [0, 16], clk: [0, 34], predTaken: [xP + rpg.w + 60, rpF[1] + 1], predTarget: [xP + rpg.w + 60, rpF[1] + 6] },
      instances, nets,
    }),
    hdl: {
      verilog: `// Primer hdl/rv_pipe_bp.sv
assign hitF = valid[iF] && (tag[iF] == pcF[31:6]);
assign predTakenF  = hitF && (jmp[iF] || ctr[iF][1]);
assign predTargetF = tgt[iF];
always_ff @(posedge clk)
  if (updE) begin
    valid[iE] <= 1; tag[iE] <= pcE[31:6]; tgt[iE] <= targetE; jmp[iE] <= isJumpE;
    if (!hitE)       ctr[iE] <= takenE ? 2'b10 : 2'b01;      // new entry: weak
    else if (takenE) ctr[iE] <= (ctr[iE] == 2'b11) ? 2'b11 : ctr[iE] + 1;
    else             ctr[iE] <= (ctr[iE] == 2'b00) ? 2'b00 : ctr[iE] - 1;
  end`,
    },
  });
})();

/** Misprediction check in E: wrong direction, or right direction with a wrong target. */
export const MISPREDICT: ComponentDef = define({
  id: 'mispredict', name: 'Misprediction detector', category: 'cpu',
  summary: 'Compares the prediction made in Fetch with the outcome computed in Execute: a control instruction mispredicts if its direction differs, or if it was taken to a different target; any other instruction mispredicts only if Fetch predicted it taken. The predicted target is checked against both candidate targets in parallel (PC + imm, and rs1 + imm for jalr), so the check does not wait for the branch decision.',
  ports: [bit('branch', 'in'), bit('jump', 'in'), bit('jalr', 'in'), bus('pcSrc', 2, 'in'), bit('predTaken', 'in'), bus('predTarget', 32, 'in'), bus('tgtB', 32, 'in'), bus('tgtJ', 32, 'in'), bit('valid', 'in'), bit('mispredict', 'out'), bit('isCtrl', 'out'), bit('taken', 'out')],
  symbol: { kind: 'box', label: 'MISPREDICT?' },
  netlist: () => ({
    pins: { branch: [0, 2], jump: [0, 4], jalr: [0, 6], pcSrc: [0, 12], predTaken: [0, 18], predTarget: [0, 26], tgtB: [0, 30], tgtJ: [0, 44], valid: [0, 58], mispredict: [70, 14], isCtrl: [70, 4], taken: [70, 24] },
    instances: [
      { name: 'ctl', def: orN(3), at: [8, 1] },
      { name: 'sp', def: splitter([1, 1]), at: [4, 10] },
      { name: 'tk', def: OR, at: [10, 10] },
      { name: 'dirx', def: XOR, at: [20, 14] },
      { name: 'teq', def: equal(32), at: [8, 24] },
      { name: 'jeq', def: equal(32), at: [8, 40] },
      { name: 'tsel', def: muxTree(1, 1), at: [36, 30] },
      { name: 'tne', def: NOT, at: [44, 26] },
      { name: 'badt', def: AND, at: [50, 22] },
      { name: 'wrong', def: OR, at: [57, 16] },
      { name: 'sel', def: muxTree(1, 1), at: [62, 8] },
      { name: 'gate', def: AND, at: [62, 30] },
    ],
    nets: [
      { name: 'branch', ends: ['branch', 'ctl.i0'] }, { name: 'jump', ends: ['jump', 'ctl.i1'] },
      { name: 'isCtrl', ends: ['ctl.y', 'sel.s', 'isCtrl'], tags: true },
      { name: 'pcSrc', ends: ['pcSrc', 'sp.in'] },
      { ends: ['sp.o0', 'tk.a'] }, { ends: ['sp.o1', 'tk.b'] },
      { name: 'taken', ends: ['tk.y', 'dirx.a', 'badt.a', 'taken'], tags: true },
      { name: 'predTaken', ends: ['predTaken', 'dirx.b', 'sel.d0'], tags: ['dirx.b', 'sel.d0'] },
      { name: 'predTarget', ends: ['predTarget', 'teq.a', 'jeq.a'], tags: ['jeq.a'] },
      { name: 'tgtB', ends: ['tgtB', 'teq.b'] }, { name: 'tgtJ', ends: ['tgtJ', 'jeq.b'] },
      { name: 'okB', ends: ['teq.eq', 'tsel.d0'] }, { name: 'okJ', ends: ['jeq.eq', 'tsel.d1'] },
      { name: 'jalr', ends: ['jalr', 'ctl.i2', 'tsel.s'], tags: ['tsel.s'] },
      { name: 'targetOk', ends: ['tsel.y', 'tne.a'] }, { name: 'targetBad', ends: ['tne.y', 'badt.b'] },
      { name: 'dirWrong', ends: ['dirx.y', 'wrong.a'], tags: true }, { name: 'tgtWrong', ends: ['badt.y', 'wrong.b'] },
      { name: 'wrong', ends: ['wrong.y', 'sel.d1'], tags: true },
      { name: 'mis', ends: ['sel.y', 'gate.a'], tags: true },
      { name: 'valid', ends: ['valid', 'gate.b'], tags: ['gate.b'] },
      { name: 'mispredict', ends: ['gate.y', 'mispredict'] },
    ],
  }),
});

// ---- the pipelined processor -----------------------------------------------------------------------

export interface PipeOptions {
  dmemK?: number;
  adder?: 'rca' | 'ks';
  /** Look-ahead forwarding, dedicated branch comparator and jalr adder: shorter execute stage. */
  balanced?: boolean;
  /** BTB + 2-bit counters in Fetch; only mispredictions flush. */
  predictor?: boolean;
  /**
   * A data cache in the M stage: 'wt' write-through (4 lines), 'wb' write-back, 'wb2' 2-way write-back.
   * A miss freezes the whole pipeline until the line is in (main memory of 64 words).
   */
  dcache?: 'wt' | 'wb' | 'wb2';
  /**
   * The M extension: multiplies split across E and M (they behave like loads for hazards), divides on
   * the radix-4 SRT divider in E, which stalls the front of the pipeline for 18 cycles.
   */
  m?: boolean;
}

/** Replace one end of a net (and its tag, if it had one). */
function retargetEnd(n: NetDef, from: string, to: string): void {
  n.ends = n.ends.map((e) => (e === from ? to : e));
  if (Array.isArray(n.tags)) n.tags = n.tags.map((e) => (e === from ? to : e));
}

export function pipelinedCpu(program: number[], opts: PipeOptions = {}): ComponentDef {
  const IM = rom(program);
  const o = { dmemK: opts.dcache ? 6 : opts.dmemK ?? 5, adder: opts.adder ?? 'rca', balanced: !!opts.balanced, predictor: !!opts.predictor, dcache: opts.dcache, m: !!opts.m } as const;
  return memo(`pipe_${IM.id}_${o.dmemK}_${o.adder}_${o.balanced}_${o.predictor}_${o.dcache ?? ''}_${o.m}`, () => buildPipe(IM, o));
}

function buildPipe(IM: ComponentDef, o: { dmemK: number; adder: 'rca' | 'ks'; balanced: boolean; predictor: boolean; dcache?: 'wt' | 'wb' | 'wb2'; m: boolean }): ComponentDef {
  const { adder, balanced: bal, predictor: pred, dcache, m } = o;
  if (m && dcache) throw new Error('pipelinedCpu: m and dcache together are not supported');
  const DM = dcache === 'wt' ? cachedMemory(o.dmemK) : dcache === 'wb' ? wbCache(o.dmemK, 2, 1) : dcache === 'wb2' ? wbCache(o.dmemK, 1, 2) : dataMemory(o.dmemK);
  const PC = register(32), RF = regfile(5, 32), ALU = alu(32, adder);
  const M2 = busMux2(32), M4 = muxTree(2, 32), ADD = adder === 'ks' || bal ? koggeStone(32) : rca(32);
  const P4 = adder === 'ks' ? PLUS4_FAST : PLUS4, SI = splitter([7, 5, 3, 5, 5, 7]);
  const FD = REG_FD(pred), DE = REG_DE(bal, pred), EM = REG_EM(), MW = REG_MW();
  const HZ = hazardUnit(bal);
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const defs = new Map<string, ComponentDef>();
  const place = (n: string, d: ComponentDef, xy: [number, number]) => { at.set(n, xy); defs.set(n, d); };
  const P = (inst: string, port: string): [number, number] => {
    const a = at.get(inst)!, p = g(defs.get(inst)!).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  };
  const alignY = (n: string, d: ComponentDef, x: number, port: string, y: number) => place(n, d, [x, y - g(d).ports[port].pos[1]]);

  const T = 6; // top of the pipeline registers
  const row = (f: string) => T + rowY(f);
  const xFD = 40, xDE = 112, xEM = 196, xMW = 232;
  place('FD', FD, [xFD, T]); place('DE', DE, [xDE, T]); place('EM', EM, [xEM, T]); place('MW', MW, [xMW, T]);
  // F
  alignY('pcmux', M4, 2, 'y', row('pc') + 10);
  alignY('pc', PC, 12, 'd', row('pc') + 10);
  place('one', TIE1, [6, P('pc', 'en')[1] + 2]);
  alignY('imem', IM, 24, 'addr', row('instr'));
  alignY('plus4', P4, 26, 'a', row('pcPlus4'));
  place('vF', TIE1, [xFD - 6, row('valid') - 1]);
  if (pred) {
    place('btb', BTB, [6, row('rs1') + 4]);
    place('fsel', merger([1, 1]), [-3, P('pcmux', 's')[1] + 2]);
    // prediction and correction sit in a row below the pipeline registers, out of the E-stage datapath
    place('corr', M4, [xDE + 64, T + PIPE_H + 12]);
    place('mis', MISPREDICT, [xDE + 84, T + PIPE_H + 12]);
    place('gndM', TIE0, [xFD + 30, T + PIPE_H + 12]);
    place('mspc', merger([1, 1]), [xFD + 26, T + PIPE_H + 14]);
  }
  // D
  alignY('si', SI, xFD + 8, 'in', row('instr'));
  alignY('rf', RF, xFD + 22, 'ra1', row('rd1') + 6);
  alignY('byA', M2, xFD + 46, 'a', P('rf', 'rd1')[1]);
  alignY('byB', M2, xFD + 46, 'a', P('rf', 'rd2')[1] + 8);
  alignY('ctl', CONTROL, xFD + 46, 'regWrite', row('regWrite'));
  alignY('imm', IMM_GEN, xFD + 22, 'instr', row('imm') + 26);
  // E
  alignY('fwdA', M4, xDE + 12, 'd0', row('rd1'));
  alignY('fwdB', M4, xDE + 12, 'd0', row('rd2') + 18);
  alignY('srcA', M2, xDE + 24, 'a', P('fwdA', 'y')[1]);
  alignY('srcB', M2, xDE + 24, 'a', P('fwdB', 'y')[1]);
  alignY('alu', ALU, xDE + 36, 'a', P('srcA', 'y')[1]);
  alignY('target', ADD, xDE + 36, 'a', row('regWrite') + 6);
  alignY('clr0', CLEAR_BIT0, xDE + 58, 'in', row('rd') + 2);
  if (bal) {
    place('bcmp', BRANCH_CMP, [xDE + 14, T + PIPE_H + 12]);
    place('jtgt', koggeStone(32), [xDE + 40, T + PIPE_H + 30]);
    place('gJT', TIE0, [P('jtgt', 'cin')[0] - 10, P('jtgt', 'cin')[1] + 3]);
  } else {
    place('npc', NEXT_PC, pred ? [xDE + 14, T + PIPE_H + 12] : [xDE + 52, row('jalr') + 4]);
  }
  // the tie for the target adder's carry-in: above it when cin is on top (ripple carry), below-left otherwise
  const cinTop = g(ADD).ports.cin.exit === 'up';
  place('gT', TIE0, cinTop ? [P('target', 'cin')[0] - 6, P('target', 'cin')[1] - 4] : [P('target', 'cin')[0] - 10, P('target', 'cin')[1] + 3]);
  place('gJ', TIE0, [P('clr0', 'zero')[0] - 5, P('clr0', 'zero')[1] + 1]);
  // M
  alignY('dm', DM, xEM + 12, 'addr', row('aluResult'));
  alignY('fwdM', M4, xEM + 12, 'd0', row('imm') + 14);
  // W
  alignY('res', M4, xMW + 10, 'd0', row('aluResult'));
  // hazard unit and register controls
  place('hz', HZ, [xFD + 40, T + PIPE_H + 18]);
  place('en1', TIE1, [xDE - 6, T + PIPE_H - 5]);
  place('clr0E', TIE0, [xEM - 6, T + PIPE_H + 2]);

  const labels: Record<string, string> = {
    pcmux: 'next PC', pc: 'PC', byA: 'bypass A', byB: 'bypass B', fwdA: 'forward A', fwdB: 'forward B', srcA: 'SrcA', srcB: 'SrcB',
    target: 'PC + imm', fwdM: 'M result', res: 'result', hz: 'hazard unit', jtgt: 'rs1 + imm', corr: 'correct PC', btb: 'branch predictor',
  };
  const instances: InstanceDef[] = [...at.keys()].map((n) => ({ name: n, def: defs.get(n)!, at: at.get(n), label: labels[n] }));

  const decide = bal ? 'bcmp' : 'npc';
  const nets: NetDef[] = [
    // F
    { name: 'PCNext', ends: ['pcmux.y', 'pc.d'] },
    { name: 'enPC', ends: ['hz.enPC', 'pc.en'], tags: true },
    { name: 'PCF', ends: ['pc.q', 'imem.addr', 'plus4.a', 'FD.pcF', 'pcF', ...(pred ? ['btb.pcF'] : [])], trunk: P('pc', 'q')[0] + 3, tags: ['pcF', ...(pred ? ['btb.pcF'] : [])] },
    { name: 'InstrF', ends: ['imem.data', 'FD.instrF'] },
    { name: 'vF', ends: ['vF.y', 'FD.validF'] },
    { name: 'enFD', ends: ['hz.enFD', 'FD.en'], tags: true },
    { name: 'flushFD', ends: ['hz.flushFD', 'FD.clr'], tags: true },
    // D
    { name: 'validD', ends: ['FD.validD', 'DE.validD'] },
    { name: 'PCD', ends: ['FD.pcD', 'DE.pcD'] },
    { name: 'PCPlus4D', ends: ['FD.pcPlus4D', 'DE.pcPlus4D'] },
    { name: 'InstrD', ends: ['FD.instrD', 'si.in', 'imm.instr'], trunk: xFD + 6 },
    { name: 'opD', ends: ['si.o0', 'ctl.op'], tags: true },
    { name: 'rdD', ends: ['si.o1', 'DE.rdD'], tags: true },
    { name: 'funct3D', ends: ['si.o2', 'ctl.funct3', 'DE.funct3D'], tags: true },
    { name: 'rs1D', ends: ['si.o3', 'rf.ra1', 'DE.rs1D', 'hz.rs1D'], tags: ['DE.rs1D', 'hz.rs1D'] },
    { name: 'rs2D', ends: ['si.o4', 'rf.ra2', 'DE.rs2D', 'hz.rs2D'], tags: ['DE.rs2D', 'hz.rs2D'] },
    { name: 'funct7D', ends: ['si.o5', 'ctl.funct7'], tags: true },
    { name: 'rfRd1', ends: ['rf.rd1', 'byA.a'] },
    { name: 'rfRd2', ends: ['rf.rd2', 'byB.a'] },
    { name: 'RD1D', ends: ['byA.y', 'DE.rd1D'] },
    { name: 'RD2D', ends: ['byB.y', 'DE.rd2D'] },
    { name: 'bypassA', ends: ['hz.bypassA', 'byA.s'], tags: true },
    { name: 'bypassB', ends: ['hz.bypassB', 'byB.s'], tags: true },
    { name: 'ImmSrcD', ends: ['ctl.immSrc', 'imm.src'], tags: true },
    { name: 'ImmExtD', ends: ['imm.imm', 'DE.immD'] },
    ...['regWrite', 'aluSrcA', 'aluSrcB', 'memWrite', 'resultSrc', 'branch', 'jump', 'jalr'].map((f): NetDef => ({ name: `${f}D`, ends: [`ctl.${f}`, `DE.${f}D`] })),
    { name: 'aluCtlD', ends: ['ctl.aluCtl', 'DE.aluCtlD'] },
    { name: 'en1', ends: ['en1.y', 'DE.en', 'EM.en', 'MW.en'], tags: ['EM.en', 'MW.en'] },
    { name: 'flushDE', ends: ['hz.flushDE', 'DE.clr'], tags: true },
    // E
    { name: 'validE', ends: ['DE.validE', 'EM.validE', 'hz.validE', ...(pred ? ['mis.valid'] : [])], tags: ['hz.validE', ...(pred ? ['mis.valid'] : [])] },
    { name: 'PCE', ends: ['DE.pcE', 'EM.pcE', 'srcA.b', 'target.a', ...(pred ? ['btb.pcE'] : [])], tags: ['srcA.b', 'target.a', ...(pred ? ['btb.pcE'] : [])] },
    { name: 'PCPlus4E', ends: ['DE.pcPlus4E', 'EM.pcPlus4E', ...(pred ? ['corr.d0', 'corr.d3'] : [])], tags: pred ? ['corr.d0', 'corr.d3'] : undefined },
    { name: 'RD1E', ends: ['DE.rd1E', 'fwdA.d0'] },
    { name: 'RD2E', ends: ['DE.rd2E', 'fwdB.d0'] },
    { name: 'ImmExtE', ends: ['DE.immE', 'EM.immE', 'srcB.b', 'target.b', ...(bal ? ['jtgt.b'] : [])], tags: ['srcB.b', 'target.b', ...(bal ? ['jtgt.b'] : [])] },
    { name: 'rs1E', ends: ['DE.rs1E', ...(bal ? [] : ['hz.rs1E'])], tags: true },
    { name: 'rs2E', ends: ['DE.rs2E', ...(bal ? [] : ['hz.rs2E'])], tags: true },
    { name: 'rdE', ends: ['DE.rdE', 'EM.rdE', 'hz.rdE'], tags: ['hz.rdE'] },
    { name: 'regWriteE', ends: ['DE.regWriteE', 'EM.regWriteE', ...(bal ? ['hz.regWriteE'] : [])], tags: bal ? ['hz.regWriteE'] : undefined },
    { name: 'memWriteE', ends: ['DE.memWriteE', 'EM.memWriteE'] },
    { name: 'resultSrcE', ends: ['DE.resultSrcE', 'EM.resultSrcE', 'hz.resultSrcE'], tags: ['hz.resultSrcE'] },
    { name: 'ALUSrcAE', ends: ['DE.aluSrcAE', 'srcA.s'], tags: true },
    { name: 'ALUSrcBE', ends: ['DE.aluSrcBE', 'srcB.s'], tags: true },
    { name: 'BranchE', ends: ['DE.branchE', `${decide}.branch`, ...(pred ? ['mis.branch'] : [])], tags: true },
    { name: 'JumpE', ends: ['DE.jumpE', `${decide}.jump`, ...(pred ? ['mis.jump'] : [])], tags: true },
    { name: 'JalrE', ends: ['DE.jalrE', `${decide}.jalr`, ...(pred ? ['mis.jalr'] : [])], tags: true },
    { name: 'ALUControlE', ends: ['DE.aluCtlE', 'alu.ctl'], tags: true },
    { name: 'funct3E', ends: ['DE.funct3E', `${decide}.funct3`], tags: true },
    { name: 'forwardA', ends: bal ? ['DE.fwdAE', 'fwdA.s'] : ['hz.forwardA', 'fwdA.s'], tags: true },
    { name: 'forwardB', ends: bal ? ['DE.fwdBE', 'fwdB.s'] : ['hz.forwardB', 'fwdB.s'], tags: true },
    ...(bal ? [
      { name: 'fwdNextA', ends: ['hz.forwardA', 'DE.fwdAD'], tags: true } as NetDef,
      { name: 'fwdNextB', ends: ['hz.forwardB', 'DE.fwdBD'], tags: true } as NetDef,
    ] : []),
    { name: 'ResultW', ends: ['res.y', 'fwdA.d1', 'fwdB.d1', 'byA.b', 'byB.b', 'rf.wd'], tags: true },
    { name: 'FwdM', ends: ['fwdM.y', 'fwdA.d2', 'fwdA.d3', 'fwdB.d2', 'fwdB.d3'], tags: true },
    { name: 'SrcAE', ends: ['fwdA.y', 'srcA.a', ...(bal ? ['bcmp.a', 'jtgt.a'] : [])], tags: bal ? ['bcmp.a', 'jtgt.a'] : undefined },
    { name: 'WriteDataE', ends: ['fwdB.y', 'srcB.a', 'EM.writeDataE', ...(bal ? ['bcmp.b'] : [])], tags: ['EM.writeDataE', ...(bal ? ['bcmp.b'] : [])] },
    { name: 'SrcA', ends: ['srcA.y', 'alu.a'] },
    { name: 'SrcB', ends: ['srcB.y', 'alu.b'] },
    { name: 'ALUResultE', ends: ['alu.y', 'EM.aluResultE', ...(bal ? [] : ['clr0.in'])], trunk: P('alu', 'y')[0] + 8 },
    ...(bal ? [
      { name: 'JalrSum', ends: ['jtgt.s', 'clr0.in'], tags: true } as NetDef,
      { name: 'gJT', ends: ['gJT.y', 'jtgt.cin'], via: { 'jtgt.cin': [[P('jtgt', 'cin')[0] - 2, P('gJT', 'y')[1]], [P('jtgt', 'cin')[0] - 2, P('jtgt', 'cin')[1]]] } } as NetDef,
    ] : [
      { name: 'Zero', ends: ['alu.zero', 'npc.zero'], tags: true } as NetDef,
      { name: 'Neg', ends: ['alu.neg', 'npc.neg'], tags: true } as NetDef,
      { name: 'Ovf', ends: ['alu.ovf', 'npc.ovf'], tags: true } as NetDef,
      { name: 'Carry', ends: ['alu.carry', 'npc.carry'], tags: true } as NetDef,
    ]),
    { name: 'gT', ends: ['gT.y', 'target.cin'], via: { 'target.cin': cinTop ? [[P('target', 'cin')[0], P('gT', 'y')[1]]] : [[P('target', 'cin')[0] - 2, P('gT', 'y')[1]], [P('target', 'cin')[0] - 2, P('target', 'cin')[1]]] } },
    { name: 'gJ', ends: ['gJ.y', 'clr0.zero'], via: { 'clr0.zero': [[P('clr0', 'zero')[0], P('gJ', 'y')[1]]] } },
    // M
    { name: 'validM', ends: ['EM.validM', 'MW.validM'] },
    { name: 'PCM', ends: ['EM.pcM', 'MW.pcM'] },
    { name: 'PCPlus4M', ends: ['EM.pcPlus4M', 'MW.pcPlus4M', 'fwdM.d2'], tags: ['fwdM.d2'] },
    { name: 'ALUResultM', ends: ['EM.aluResultM', 'dm.addr', 'MW.aluResultM', 'fwdM.d0', 'fwdM.d1'], tags: ['fwdM.d0', 'fwdM.d1'] },
    { name: 'WriteDataM', ends: ['EM.writeDataM', 'dm.wd'] },
    { name: 'ImmExtM', ends: ['EM.immM', 'MW.immM', 'fwdM.d3'], tags: ['fwdM.d3'] },
    { name: 'rdM', ends: ['EM.rdM', 'MW.rdM', 'hz.rdM'], tags: ['hz.rdM'] },
    { name: 'regWriteM', ends: ['EM.regWriteM', 'MW.regWriteM', 'hz.regWriteM'], tags: ['hz.regWriteM'] },
    { name: 'MemWriteM', ends: ['EM.memWriteM', 'dm.we'], tags: true },
    { name: 'resultSrcM', ends: ['EM.resultSrcM', 'MW.resultSrcM', 'fwdM.s'], tags: ['fwdM.s'] },
    { name: 'ReadDataM', ends: ['dm.rd', 'MW.readDataM'] },
    { name: 'clr0', ends: ['clr0E.y', 'EM.clr', 'MW.clr'], tags: ['MW.clr'] },
    // W
    { name: 'validW', ends: ['MW.validW', 'validW'], tags: true },
    { name: 'PCW', ends: ['MW.pcW', 'pcW'], tags: true },
    { name: 'ALUResultW', ends: ['MW.aluResultW', 'res.d0'] },
    { name: 'ReadDataW', ends: ['MW.readDataW', 'res.d1'] },
    { name: 'PCPlus4W', ends: ['MW.pcPlus4W', 'res.d2'], tags: ['res.d2'] },
    { name: 'ImmExtW', ends: ['MW.immW', 'res.d3'], tags: ['res.d3'] },
    { name: 'rdW', ends: ['MW.rdW', 'rf.wa', 'hz.rdW'], tags: true },
    { name: 'regWriteW', ends: ['MW.regWriteW', 'rf.we', 'hz.regWriteW'], tags: true },
    { name: 'resultSrcW', ends: ['MW.resultSrcW', 'res.s'], tags: true },
    { name: 'clk', ends: ['clk', 'pc.clk', 'FD.clk', 'rf.clk', 'DE.clk', 'EM.clk', 'dm.clk', 'MW.clk', ...(pred ? ['btb.clk'] : [])], tags: ['pc.clk', 'FD.clk', 'rf.clk', 'DE.clk', 'EM.clk', 'dm.clk', 'MW.clk', ...(pred ? ['btb.clk'] : [])] },
  ];
  if (pred) {
    nets.push(
      // F: predicted next PC, overridden by the E-stage correction.
      { name: 'PCPlus4F', ends: ['plus4.y', 'FD.pcPlus4F', 'pcmux.d0'], tags: ['pcmux.d0'] },
      { name: 'PredTargetF', ends: ['btb.predTarget', 'pcmux.d1', 'FD.predTargetF'], tags: true },
      { name: 'PredTakenF', ends: ['btb.predTaken', 'fsel.i0', 'FD.predTakenF'], tags: true },
      { name: 'Mispredict', ends: ['mis.mispredict', 'fsel.i1', 'mspc.i0'], tags: true },
      { name: 'PCSel', ends: ['fsel.out', 'pcmux.s'] },
      { name: 'CorrectPC', ends: ['corr.y', 'pcmux.d2', 'pcmux.d3'], tags: true },
      { name: 'PCSrcE', ends: [`${decide}.pcSrc`, 'corr.s', 'mis.pcSrc'], tags: true },
      { name: 'PCTargetE', ends: ['target.s', 'corr.d1', 'mis.tgtB'], tags: true },
      { name: 'JalrTargetE', ends: ['clr0.out', 'corr.d2', 'mis.tgtJ'], tags: true },
      { name: 'predTargetD', ends: ['FD.predTargetD', 'DE.predTargetD'] },
      { name: 'predTakenD', ends: ['FD.predTakenD', 'DE.predTakenD'] },
      { name: 'predTargetE', ends: ['DE.predTargetE', 'mis.predTarget'], tags: true },
      { name: 'predTakenE', ends: ['DE.predTakenE', 'mis.predTaken'], tags: true },
      { name: 'updE', ends: ['mis.isCtrl', 'btb.updE'], tags: true },
      { name: 'takenE', ends: ['mis.taken', 'btb.takenE'], tags: true },
      { name: 'isJumpE', ends: [`${decide === 'bcmp' ? 'bcmp' : 'npc'}.pcSrc`] },
      { name: 'redirect', ends: ['mspc.out', 'hz.pcSrcE'], tags: true },
      { name: 'gndM', ends: ['gndM.y', 'mspc.i1'] },
    );
    // targetE for the BTB = the actual target (correct PC when taken); isJump = jump | jalr.
    const cpcNet = nets.find((n) => n.name === 'CorrectPC')!;
    cpcNet.ends.push('btb.targetE'); // tags: true covers the new end too
    nets.splice(nets.findIndex((n) => n.name === 'isJumpE'), 1);
    instances.push({ name: 'isJ', def: OR, at: [xDE + 64, T + PIPE_H + 30] });
    defs.set('isJ', OR);
    nets.find((n) => n.name === 'JumpE')!.ends.push('isJ.a');
    nets.find((n) => n.name === 'JalrE')!.ends.push('isJ.b');
    nets.push({ name: 'isJumpE', ends: ['isJ.y', 'btb.isJumpE'], tags: true });
  } else {
    nets.push(
      { name: 'PCPlus4F', ends: ['plus4.y', 'FD.pcPlus4F', 'pcmux.d0', 'pcmux.d3'], tags: ['pcmux.d0', 'pcmux.d3'] },
      { name: 'PCTargetE', ends: ['target.s', 'pcmux.d1'], tags: true },
      { name: 'JalrTargetE', ends: ['clr0.out', 'pcmux.d2'], tags: true },
      { name: 'PCSrcE', ends: [`${decide}.pcSrc`, 'pcmux.s', 'hz.pcSrcE'], tags: true },
    );
  }

  const yb = T + PIPE_H + 6;
  const extraPorts: PortDef[] = [];
  if (dcache) {
    // A load or store that misses in M freezes every stage: the PC and all pipeline registers hold,
    // flushes and predictor updates wait, and W reports a retirement only once, when the miss is over.
    const yc = yb + 44, add = (name: string, def: ComponentDef, x: number, y: number) => { instances.push({ name, def, at: [x, yc + y] }); defs.set(name, def); };
    const net = (name: string) => nets.find((n) => n.name === name)!;
    const retarget = (name: string, from: string, to: string) => { const e = net(name).ends; e[e.indexOf(from)] = to; };
    add('rsl', splitter([1, 1]), xEM - 20, 0);
    add('nrs1', NOT, xEM - 16, 2);
    add('isLd', AND, xEM - 10, 0);
    add('ldV', AND, xEM - 4, 4);
    const dmAt = at.get('dm')!, dmg = symbolGeom(DM);
    instances.push({ name: 'go', def: NOT, at: [dmAt[0] + dmg.w - 6, dmAt[1] + dmg.h + 4] }); defs.set('go', NOT);
    add('gPC', AND, 14, 44);
    add('gFD', AND, 34, 44);
    add('gFl1', AND, 54, 44);
    add('gFl2', AND, 74, 44);
    add('gV', AND, xMW + 12, 0);
    instances.splice(instances.findIndex((i) => i.name === 'en1'), 1);
    net('resultSrcM').ends.push('rsl.in');
    net('validM').ends.push('ldV.b');
    net('validM').tags = ['ldV.b'];
    retarget('enPC', 'pc.en', 'gPC.a');
    retarget('enFD', 'FD.en', 'gFD.a');
    retarget('flushFD', 'FD.clr', 'gFl1.a');
    retarget('flushDE', 'DE.clr', 'gFl2.a');
    retarget('validW', 'validW', 'gV.a');
    const en1 = net('en1');
    en1.ends = ['go.y', 'gPC.b', 'gFD.b', 'gFl1.b', 'gFl2.b', 'gV.b', 'DE.en', 'EM.en', 'MW.en'];
    en1.name = 'go';
    en1.tags = true;
    if (pred) {
      add('gU', AND, xDE + 40, 0);
      retarget('updE', 'btb.updE', 'gU.a');
      en1.ends.push('gU.b');
      nets.push({ name: 'updGo', ends: ['gU.y', 'btb.updE'], tags: true });
    }
    net('clk').ends.push('dm.clk');
    nets.push(
      { name: 'rs0M', ends: ['rsl.o0', 'isLd.a'], tags: true },
      { name: 'rs1M', ends: ['rsl.o1', 'nrs1.a'] },
      { ends: ['nrs1.y', 'isLd.b'] },
      // a flushed bubble may still look like a load: only a valid instruction may access the cache
      { name: 'isLoadM', ends: ['isLd.y', 'ldV.a'] },
      { name: 'MemReadM', ends: ['ldV.y', 'dm.re'], tags: true },
      { name: 'dstall', ends: ['dm.stall', 'go.a', 'dstall'], tags: ['dstall'] },
      { name: 'enPCgo', ends: ['gPC.y', 'pc.en'], tags: true },
      { name: 'enFDgo', ends: ['gFD.y', 'FD.en'], tags: true },
      { name: 'flushFDgo', ends: ['gFl1.y', 'FD.clr'], tags: true },
      { name: 'flushDEgo', ends: ['gFl2.y', 'DE.clr'], tags: true },
      { name: 'retireW', ends: ['gV.y', 'validW'], tags: true },
    );
    extraPorts.push(bit('dstall', 'out'));
  }
  if (m) {
    // ---- M extension. D: decode; E: multiply (first half) and divide; M: multiply (second half).
    const ym = T + PIPE_H + 72; // below the hazard unit and the prediction row
    const add = (name: string, def: ComponentDef, x: number, y: number, label?: string) => { instances.push({ name, def, at: [x, ym + y], label }); defs.set(name, def); };
    const at2 = (name: string, def: ComponentDef, xy: [number, number], label?: string) => { instances.push({ name, def, at: xy, label }); defs.set(name, def); };
    const net = (name: string) => nets.find((n) => n.name === name)!;
    const drop = (name: string, end: string) => { const n = net(name); n.ends = n.ends.filter((e) => e !== end); if (Array.isArray(n.tags)) n.tags = n.tags.filter((e) => e !== end); };
    const R = register(64), CR2 = clearableRegister(2), CR3 = clearableRegister(3), M22 = busMux2(2);
    // D: isM = (op = OP) and (funct7 = 1); a multiply asks for the load path (ResultSrc = 01)
    add('kOp', constWord(7, 0x33), xFD - 12, 2); add('opM', equal(7), xFD + 6, 0);
    add('kF7', constWord(7, 1), xFD - 12, 16); add('f7M', equal(7), xFD + 6, 14);
    add('sf3D', splitter([2, 1]), xFD + 6, 30); add('nf2', NOT, xFD + 30, 32);
    add('isMD', AND, xFD + 30, 6);
    add('isMul', AND, xFD + 44, 7); add('isDiv', AND, xFD + 44, 16);
    add('mfl', merger([1, 1]), xFD + 58, 8); add('kLd', constWord(2, 1), xFD + 52, 26);
    at2('rsm', M22, [xDE - 6, P('DE', 'resultSrcD')[1] - g(M22).ports.y.pos[1]], 'load path');
    // E: the multiplier's first half, the divider, and the result multiplexer
    add('mE', CR2, xDE + 4, 6, 'M flags');
    add('smE', splitter([1, 1]), xDE + 18, 6); add('sf3E', splitter([2, 1]), xDE + 18, 20);
    add('goDiv', AND, xDE + 28, 2);
    add('mule', MUL_E, xDE + 40, 20, 'multiply (E)');
    add('dive', DIV_E, xDE + 40, 44, 'divide');
    add('mdE', busMux2(32), xDE + 56, -16, 'ALU / divide');
    add('run', NOT, xDE + 58, -4);
    add('gPC', AND, 4, 44); add('gFD', AND, 24, 44);
    // M: the multiplier's second half, and its result in place of the memory word
    add('mfMd', merger([1, 2]), xEM - 30, 6);
    add('mfM', CR3, xEM - 20, 4, 'mul?, funct3'); add('msM', R, xEM - 20, 20, 'sum'); add('mcM', R, xEM - 20, 36, 'carry');
    add('smM', splitter([1, 2]), xEM + 4, 6);
    add('mulm', MUL_M, xEM + 12, 22, 'multiply (M)');
    add('rdm', busMux2(32), xEM + 34, 4, 'memory / product');
    // the ID/EX enable now comes from the stall; the constants that remain move clear of the clock labels
    instances.find((x) => x.name === 'en1')!.at = [xDE - 6, T + PIPE_H + 3];
    instances.find((x) => x.name === 'clr0E')!.at = [xMW - 6, T + PIPE_H + 3];
    // D wiring
    net('opD').ends.push('opM.a'); net('funct7D').ends.push('f7M.a'); net('funct3D').ends.push('sf3D.in');
    retargetEnd(net('resultSrcD'), 'DE.resultSrcD', 'rsm.a');
    nets.push(
      { ends: ['kOp.y', 'opM.b'] }, { ends: ['kF7.y', 'f7M.b'] },
      { name: 'isOP', ends: ['opM.eq', 'isMD.a'], tags: true }, { name: 'f7is1', ends: ['f7M.eq', 'isMD.b'], tags: true },
      { name: 'isMD', ends: ['isMD.y', 'isMul.a', 'isDiv.a'], tags: ['isDiv.a'] },
      { name: 'f3hi', ends: ['sf3D.o1', 'nf2.a', 'isDiv.b'], tags: ['isDiv.b'] }, { name: '¬f3hi', ends: ['nf2.y', 'isMul.b'], tags: true },
      { name: 'isMulD', ends: ['isMul.y', 'mfl.i0', 'rsm.s'], tags: ['rsm.s'] }, { name: 'isDivD', ends: ['isDiv.y', 'mfl.i1'], tags: true },
      { ends: ['kLd.y', 'rsm.b'] }, { name: 'resultSrcD2', ends: ['rsm.y', 'DE.resultSrcD'] },
      { name: 'mFlagsD', ends: ['mfl.out', 'mE.d'], tags: true },
    );
    // the divider's stall holds PC, IF/ID and ID/EX (and the M flags with them) and sends bubbles into M
    retargetEnd(net('enPC'), 'pc.en', 'gPC.a');
    retargetEnd(net('enFD'), 'FD.en', 'gFD.a');
    drop('en1', 'DE.en');
    net('flushDE').ends.push('mE.clr');
    drop('clr0', 'EM.clr');
    net('clk').ends.push('mE.clk', 'dive.clk', 'msM.clk', 'mcM.clk', 'mfM.clk');
    net('en1').ends.push('msM.en', 'mcM.en', 'mfM.en');
    nets.push(
      { name: 'enPCm', ends: ['gPC.y', 'pc.en'], tags: true }, { name: 'enFDm', ends: ['gFD.y', 'FD.en'], tags: true },
      { name: 'divStall', ends: ['dive.stall', 'run.a', 'EM.clr', 'mfM.clr'], tags: true },
      { name: 'runE', ends: ['run.y', 'DE.en', 'mE.en', 'gPC.b', 'gFD.b'], tags: true },
      // E wiring
      { name: 'mFlagsE', ends: ['mE.q', 'smE.in'] },
      { name: 'isMulE', ends: ['smE.o0', 'mfMd.i0'], tags: true }, { name: 'isDivE', ends: ['smE.o1', 'goDiv.a', 'mdE.s'], tags: true },
      { name: 'f3E', ends: ['sf3E.o0', 'mule.f', 'dive.f', 'mfMd.i1'], tags: true },
      { name: 'divGo', ends: ['goDiv.y', 'dive.go'], tags: true },
      { name: 'mulS', ends: ['mule.s', 'msM.d'], tags: true }, { name: 'mulC', ends: ['mule.c', 'mcM.d'], tags: true },
      { name: 'divY', ends: ['dive.y', 'mdE.b'], tags: true },
      { name: 'ALUResultE2', ends: ['mdE.y', 'EM.aluResultE'], tags: true },
      // M wiring
      { name: 'mFlagsM', ends: ['mfM.q', 'smM.in'] },
      // mfM holds {isMul (bit 0), funct3[1:0]}
      { name: 'isMulM', ends: ['smM.o0', 'rdm.s'], tags: true }, { name: 'f3M', ends: ['smM.o1', 'mulm.f'], tags: true },
      { name: 'mulSM', ends: ['msM.q', 'mulm.s'] }, { name: 'mulCM', ends: ['mcM.q', 'mulm.c'] },
      { name: 'productM', ends: ['mulm.y', 'rdm.b'], tags: true },
      { name: 'ReadDataM2', ends: ['rdm.y', 'MW.readDataM'], tags: true },
    );
    nets.push({ name: 'mFlagsE2', ends: ['mfMd.out', 'mfM.d'] });
    net('funct3E').ends.push('sf3E.in'); (net('funct3E').tags as true | string[]) = true;
    net('validE').ends.push('goDiv.b');
    if (Array.isArray(net('validE').tags)) (net('validE').tags as string[]).push('goDiv.b');
    net('SrcAE').ends.push('mule.a', 'dive.a');
    net('WriteDataE').ends.push('mule.b', 'dive.b');
    { const t = net('SrcAE').tags; net('SrcAE').tags = [...(Array.isArray(t) ? t : []), 'mule.a', 'dive.a']; }
    { const t = net('WriteDataE').tags; net('WriteDataE').tags = [...(Array.isArray(t) ? t : []), 'mule.b', 'dive.b']; }
    retargetEnd(net('ALUResultE'), 'EM.aluResultE', 'mdE.a');
    retargetEnd(net('ReadDataM'), 'MW.readDataM', 'rdm.a');
  }
  const variant = [adder === 'ks' ? 'fast adders' : '', bal ? 'balanced' : '', pred ? 'branch prediction' : '', dcache ? `${dcache === 'wt' ? 'write-through' : dcache === 'wb2' ? '2-way write-back' : 'write-back'} data cache` : ''].filter(Boolean).join(', ');
  return {
    id: `pipe_${IM.id}${adder === 'ks' ? '_ks' : ''}${bal ? '_bal' : ''}${pred ? '_bp' : ''}${dcache ? `_dc${dcache}` : ''}${m ? '_m' : ''}`,
    name: `Pipelined RV32I${m ? 'M' : ''} CPU${variant ? ` (${variant})` : ''}`, category: 'cpu',
    summary: 'Five stages, one instruction entering per cycle. Forwarding, a W→D bypass, load-use stalls and branch flushes keep it architecturally identical to the single-cycle machine.',
    ports: [bit('clk', 'in', 'left', true), bus('pcF', 32, 'out'), bit('validW', 'out'), bus('pcW', 32, 'out'), ...extraPorts],
    symbol: { kind: 'box', label: dcache ? 'RV32I PIPE + D$' : 'RV32I PIPE' },
    netlist: () => ({ pins: { clk: [0, yb], pcF: [xMW + 30, yb + 4], validW: [xMW + 30, yb + 7], pcW: [xMW + 30, yb + 10], ...(dcache ? { dstall: [xMW + 30, yb + 13] } : {}) }, instances, nets }),
    hdl: { verilog: '// Structure follows the primer\'s hdl/rv_pipe.sv (and rv_pipe_bp.sv for branch prediction), extended to all of RV32I.' },
  };
}
