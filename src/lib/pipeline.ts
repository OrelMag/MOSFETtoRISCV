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
import { andN, busMux2, muxTree, rca } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, PLUS4, PLUS4_FAST, dataMemory, rom } from './cpu';
import { define, merger, ones, splitter } from './define';
import { fanout, koggeStone } from './fastadd';
import { AND, NOT, OR, XNOR } from './gates';
import { regfile } from './regfile';
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

/** a == b: one XNOR per bit and an AND tree. */
export function equal(n: number): ComponentDef {
  return memo(`eq${n}`, () => {
    const P = 6;
    const A = andN(n);
    const ag = symbolGeom(A);
    const aIns = A.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter(ones(n), P), at: [4, 0] },
      { name: 'sb', def: splitter(ones(n), P), at: [7, 2] },
      { name: 'all', def: A, at: [24, (P * n) / 2 - ag.h / 2 + 1] },
    ];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] }, { name: 'eq', ends: ['all.y', 'eq'] }];
    for (let i = 0; i < n; i++) {
      instances.push({ name: `x${i}`, def: XNOR, at: [10, 2 + P * i] });
      nets.push({ ends: [`sa.o${i}`, `x${i}.a`] }, { ends: [`sb.o${i}`, `x${i}.b`] });
      nets.push({ name: `same${i}`, ends: [`x${i}.y`, `all.${aIns[i]}`], trunk: 16 + i });
    }
    return define({
      id: `eq${n}`, name: `${n}-bit equality comparator`, category: 'routing',
      summary: 'Equal when every bit pair is equal: an XNOR per bit, ANDed together.',
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bit('eq', 'out')],
      symbol: { kind: 'box', label: '=' },
      spec: ([a, b]) => [a === b ? 1 : 0],
      netlist: () => ({ pins: { a: [1, (P * n) / 2], b: [1, 2 + (P * n) / 2], eq: [24 + ag.w + 4, (P * n) / 2 + 1] }, instances, nets }),
    });
  });
}

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
  valid: 0, pc: 1, pcPlus4: 2, instr: 3, rd1: 3, aluResult: 3, rd2: 4, writeData: 4, readData: 4, imm: 5,
  rs1: 6, rs2: 7, rd: 8,
  regWrite: 9, aluSrcA: 11, aluSrcB: 12, memWrite: 13, resultSrc: 14, branch: 15, jump: 16, jalr: 17, aluCtl: 18, funct3: 19,
};
const WIDTH: Record<string, number> = {
  valid: 1, pc: 32, pcPlus4: 32, instr: 32, rd1: 32, aluResult: 32, rd2: 32, writeData: 32, readData: 32, imm: 32,
  rs1: 5, rs2: 5, rd: 5, regWrite: 1, aluSrcA: 1, aluSrcB: 1, memWrite: 1, resultSrc: 2, branch: 1, jump: 1, jalr: 1, aluCtl: 4, funct3: 3,
};
/** y of a field row relative to the top of a pipeline register. Data rows are 4 apart, control rows 2. */
export const rowY = (field: string) => { const r = ROWS[field]; return r <= 8 ? 2 + 4 * r : 38 + 2 * (r - 9); };
export const PIPE_H = rowY('funct3') + 6;

function pipeReg(name: string, from: string, to: string, fields: string[]): ComponentDef {
  return memo(`pipe_${name}`, () => {
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
      id: `pipe_${name}`, name: `${name} pipeline register`, category: 'sequential',
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
export const REG_FD = () => pipeReg('IF/ID', 'F', 'D', ['valid', 'pc', 'pcPlus4', 'instr']);
export const REG_DE = () => pipeReg('ID/EX', 'D', 'E', ['valid', 'pc', 'pcPlus4', 'rd1', 'rd2', 'imm', 'rs1', 'rs2', 'rd', ...CTRL_E]);
export const REG_EM = () => pipeReg('EX/MEM', 'E', 'M', ['valid', 'pc', 'pcPlus4', 'aluResult', 'writeData', 'imm', 'rd', 'regWrite', 'memWrite', 'resultSrc']);
export const REG_MW = () => pipeReg('MEM/WB', 'M', 'W', ['valid', 'pc', 'pcPlus4', 'aluResult', 'readData', 'imm', 'rd', 'regWrite', 'resultSrc']);

// ---- hazard unit ---------------------------------------------------------------------------------

export const HAZARD: ComponentDef = (() => {
  const E5 = equal(5), NZ = nonZero(5);
  const eg = symbolGeom(E5);
  const cmps: [string, string, string][] = [
    ['aM', 'rs1E', 'rdM'], ['aW', 'rs1E', 'rdW'], ['bM', 'rs2E', 'rdM'], ['bW', 'rs2E', 'rdW'],
    ['lw1', 'rs1D', 'rdE'], ['lw2', 'rs2D', 'rdE'], ['dA', 'rs1D', 'rdW'], ['dB', 'rs2D', 'rdW'],
  ];
  const nzs: [string, string][] = [['nz1E', 'rs1E'], ['nz2E', 'rs2E'], ['nz1D', 'rs1D'], ['nz2D', 'rs2D']];
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
  const gx = 32;
  let gy = 2;
  const gate = (name: string, def: ComponentDef) => { instances.push({ name, def, at: [gx, gy] }); gy += symbolGeom(def).h + 3; };
  gate('fA1', A3); gate('nfA1', NOT); gate('fA0', A4);
  gate('fB1', A3); gate('nfB1', NOT); gate('fB0', A4);
  gate('byA', A3); gate('byB', A3);
  gate('nres1', NOT); gate('isLoad', AND); gate('lwUse', OR); gate('lwStall', andN(3));
  gate('taken', OR); gate('noStall', NOT); gate('flDE', OR);
  instances.push({ name: 'mfa', def: merger([1, 1]), at: [gx + 10, 4] }, { name: 'mfb', def: merger([1, 1]), at: [gx + 10, 30] });
  instances.push({ name: 'srs', def: splitter([1, 1]), at: [6, yN + 26] }, { name: 'sps', def: splitter([1, 1]), at: [6, yN + 32] });
  const ins3 = ['i0', 'i1', 'i2'], ins4 = ['i0', 'i1', 'i2', 'i3'];
  const wires: [string, string[]][] = [
    ['eq_aM.eq', ['fA1.i1']], ['eq_aW.eq', ['fA0.i1']], ['eq_bM.eq', ['fB1.i1']], ['eq_bW.eq', ['fB0.i1']],
    ['eq_lw1.eq', ['lwUse.a']], ['eq_lw2.eq', ['lwUse.b']], ['eq_dA.eq', ['byA.i1']], ['eq_dB.eq', ['byB.i1']],
    ['nz1E.nz', ['fA1.i0', 'fA0.i0']], ['nz2E.nz', ['fB1.i0', 'fB0.i0']], ['nz1D.nz', ['byA.i0']], ['nz2D.nz', ['byB.i0']],
    ['fA1.y', ['nfA1.a', 'mfa.i1']], ['nfA1.y', ['fA0.i3']], ['fA0.y', ['mfa.i0']],
    ['fB1.y', ['nfB1.a', 'mfb.i1']], ['nfB1.y', ['fB0.i3']], ['fB0.y', ['mfb.i0']],
    ['srs.o1', ['nres1.a']], ['srs.o0', ['isLoad.a']], ['nres1.y', ['isLoad.b']],
    ['isLoad.y', ['lwStall.i0']], ['lwUse.y', ['lwStall.i1']],
    ['sps.o0', ['taken.a']], ['sps.o1', ['taken.b']],
    ['lwStall.y', ['noStall.a', 'flDE.a']], ['taken.y', ['flDE.b', 'flushFD']],
  ];
  void ins3; void ins4;
  const nets: NetDef[] = [];
  for (const [n, e] of ends) nets.push({ name: n, ends: e, tags: e.slice(1) });
  for (const [drv, ss] of wires) nets.push({ ends: [drv, ...ss], tags: true });
  nets.push(
    { name: 'regWriteM', ends: ['regWriteM', 'fA1.i2', 'fB1.i2'], tags: ['fA1.i2', 'fB1.i2'] },
    { name: 'regWriteW', ends: ['regWriteW', 'fA0.i2', 'fB0.i2', 'byA.i2', 'byB.i2'], tags: ['fA0.i2', 'fB0.i2', 'byA.i2', 'byB.i2'] },
    { name: 'resultSrcE', ends: ['resultSrcE', 'srs.in'] },
    { name: 'validE', ends: ['validE', 'lwStall.i2'], tags: ['lwStall.i2'] },
    { name: 'pcSrcE', ends: ['pcSrcE', 'sps.in'] },
    { name: 'forwardA', ends: ['mfa.out', 'forwardA'] },
    { name: 'forwardB', ends: ['mfb.out', 'forwardB'] },
    { name: 'bypassA', ends: ['byA.y', 'bypassA'], tags: true },
    { name: 'bypassB', ends: ['byB.y', 'bypassB'], tags: true },
    { name: 'enable', ends: ['noStall.y', 'enPC', 'enFD'], tags: true },
    { name: 'flushDE', ends: ['flDE.y', 'flushDE'], tags: true },
  );
  // tag renaming for the wires list: give them readable names
  const named: Record<string, string> = {
    'eq_aM.eq': 'rs1E=rdM', 'eq_aW.eq': 'rs1E=rdW', 'eq_bM.eq': 'rs2E=rdM', 'eq_bW.eq': 'rs2E=rdW', 'eq_lw1.eq': 'rs1D=rdE', 'eq_lw2.eq': 'rs2D=rdE',
    'eq_dA.eq': 'rs1D=rdW', 'eq_dB.eq': 'rs2D=rdW', 'nz1E.nz': 'rs1E≠0', 'nz2E.nz': 'rs2E≠0', 'nz1D.nz': 'rs1D≠0', 'nz2D.nz': 'rs2D≠0',
    'fA1.y': 'fwdA_M', 'nfA1.y': '¬fwdA_M', 'fA0.y': 'fwdA_W', 'fB1.y': 'fwdB_M', 'nfB1.y': '¬fwdB_M', 'fB0.y': 'fwdB_W',
    'srs.o1': 'resSrcE[1]', 'srs.o0': 'resSrcE[0]', 'nres1.y': '¬resSrcE[1]', 'isLoad.y': 'loadE', 'lwUse.y': 'uses rdE',
    'sps.o0': 'pcSrcE[0]', 'sps.o1': 'pcSrcE[1]', 'lwStall.y': 'lwStall', 'taken.y': 'taken',
  };
  for (const n of nets) if (!n.name && named[n.ends[0]]) n.name = named[n.ends[0]];
  // Input pins on the left; output pins on the right.
  const inNames = ['rs1D', 'rs2D', 'rs1E', 'rs2E', 'rdE', 'rdM', 'rdW', 'regWriteM', 'regWriteW', 'validE', 'resultSrcE', 'pcSrcE'];
  const pins: Record<string, [number, number]> = {};
  inNames.forEach((n, i) => (pins[n] = [0, 2 + 3 * i]));
  pins.resultSrcE = [0, yN + 27];
  pins.pcSrcE = [0, yN + 33];
  const outNames = ['forwardA', 'forwardB', 'bypassA', 'bypassB', 'enPC', 'enFD', 'flushFD', 'flushDE'];
  outNames.forEach((n, i) => (pins[n] = [gx + 22, 4 + 6 * i]));
  return define({
    id: 'hazard', name: 'Hazard unit', category: 'cpu',
    summary: 'Watches register numbers across the stages. Forwards results from M or W to the ALU inputs, bypasses W into D, stalls on load-use, and flushes the two wrong-path instructions after a taken branch.',
    ports: [
      bus('rs1D', 5, 'in'), bus('rs2D', 5, 'in'), bus('rs1E', 5, 'in'), bus('rs2E', 5, 'in'), bus('rdE', 5, 'in'), bus('rdM', 5, 'in'), bus('rdW', 5, 'in'),
      bit('regWriteM', 'in'), bit('regWriteW', 'in'), bit('validE', 'in'), bus('resultSrcE', 2, 'in'), bus('pcSrcE', 2, 'in'),
      bus('forwardA', 2, 'out'), bus('forwardB', 2, 'out'), bit('bypassA', 'out'), bit('bypassB', 'out'),
      bit('enPC', 'out'), bit('enFD', 'out'), bit('flushFD', 'out'), bit('flushDE', 'out'),
    ],
    symbol: { kind: 'box', label: 'HAZARD UNIT' },
    netlist: () => ({ pins, instances, nets }),
    hdl: {
      verilog: `module hazard (
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
  assign taken   = pcSrcE != 2'b00;                                         // branch / jump resolved in E
  assign enPC = !lwStall;  assign enFD = !lwStall;
  assign flushFD = taken;  assign flushDE = lwStall || taken;
endmodule`,
    },
  });
})();

// ---- the pipelined processor -----------------------------------------------------------------------

export interface PipeOptions {
  dmemK?: number;
  adder?: 'rca' | 'ks';
}

export function pipelinedCpu(program: number[], opts: PipeOptions = {}): ComponentDef {
  const IM = rom(program);
  const adder = opts.adder ?? 'rca';
  return memo(`pipe_${IM.id}_${opts.dmemK ?? 5}_${adder}`, () => buildPipe(IM, opts.dmemK ?? 5, adder));
}

function buildPipe(IM: ComponentDef, dmemK: number, adder: 'rca' | 'ks'): ComponentDef {
  const PC = register(32), RF = regfile(5, 32), ALU = alu(32, adder), DM = dataMemory(dmemK);
  const M2 = busMux2(32), M4 = muxTree(2, 32), ADD = adder === 'ks' ? koggeStone(32) : rca(32);
  const P4 = adder === 'ks' ? PLUS4_FAST : PLUS4, SI = splitter([7, 5, 3, 5, 5, 7]);
  const FD = REG_FD(), DE = REG_DE(), EM = REG_EM(), MW = REG_MW();
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
  // pipeline registers
  place('FD', FD, [xFD, T]); place('DE', DE, [xDE, T]); place('EM', EM, [xEM, T]); place('MW', MW, [xMW, T]);
  // F
  alignY('pcmux', M4, 4, 'y', row('pc') + 10);
  alignY('pc', PC, 12, 'd', row('pc') + 10);
  place('one', TIE1, [6, P('pc', 'en')[1] + 2]);
  alignY('imem', IM, 24, 'addr', row('instr'));
  alignY('plus4', P4, 26, 'a', row('pcPlus4'));
  place('vF', TIE1, [xFD - 6, row('valid') - 1]);
  // D
  alignY('si', SI, xFD + 8, 'in', row('instr'));
  alignY('rf', RF, xFD + 22, 'ra1', row('rd1') + 6);
  alignY('byA', M2, xFD + 46, 'a', P('rf', 'rd1')[1]);
  alignY('byB', M2, xFD + 46, 'a', P('rf', 'rd2')[1] + 6);
  alignY('ctl', CONTROL, xFD + 46, 'regWrite', row('regWrite'));
  alignY('imm', IMM_GEN, xFD + 22, 'instr', row('imm') + 22);
  // E
  alignY('fwdA', M4, xDE + 12, 'd0', row('rd1'));
  alignY('fwdB', M4, xDE + 12, 'd0', row('rd2') + 12);
  alignY('srcA', M2, xDE + 24, 'a', P('fwdA', 'y')[1]);
  alignY('srcB', M2, xDE + 24, 'a', P('fwdB', 'y')[1]);
  alignY('alu', ALU, xDE + 36, 'a', P('srcA', 'y')[1]);
  alignY('target', ADD, xDE + 36, 'a', row('regWrite') + 6);
  alignY('clr0', CLEAR_BIT0, xDE + 58, 'in', row('rd') + 2);
  place('npc', NEXT_PC, [xDE + 52, row('jalr') + 4]);
  place('gT', TIE0, [P('target', 'cin')[0] - 6, P('target', 'cin')[1] - 4]);
  place('gJ', TIE0, [P('clr0', 'zero')[0] - 5, P('clr0', 'zero')[1] + 1]);
  // M
  alignY('dm', DM, xEM + 12, 'addr', row('aluResult'));
  alignY('fwdM', M4, xEM + 12, 'd0', row('imm') + 14);
  // W
  alignY('res', M4, xMW + 10, 'd0', row('aluResult'));
  // hazard unit and register controls
  place('hz', HAZARD, [xFD + 30, T + PIPE_H + 18]);
  place('en1', TIE1, [xDE - 6, T + PIPE_H - 5]);
  place('clr0E', TIE0, [xEM - 6, T + PIPE_H - 3]);

  const instances: InstanceDef[] = [...at.keys()].map((n) => ({
    name: n, def: defs.get(n)!, at: at.get(n),
    label: ({ pcmux: 'next PC', pc: 'PC', byA: 'bypass A', byB: 'bypass B', fwdA: 'forward A', fwdB: 'forward B', srcA: 'SrcA', srcB: 'SrcB', target: 'PC + imm', fwdM: 'M result', res: 'result', hz: 'hazard unit' } as Record<string, string>)[n],
  }));

  const nets: NetDef[] = [
    // F
    { name: 'PCNext', ends: ['pcmux.y', 'pc.d'] },
    { name: 'enPC', ends: ['hz.enPC', 'pc.en'], tags: true },
    { name: 'PCF', ends: ['pc.q', 'imem.addr', 'plus4.a', 'FD.pcF'], trunk: P('pc', 'q')[0] + 3 },
    { name: 'InstrF', ends: ['imem.data', 'FD.instrF'] },
    { name: 'PCPlus4F', ends: ['plus4.y', 'FD.pcPlus4F', 'pcmux.d0', 'pcmux.d3'], tags: ['pcmux.d0', 'pcmux.d3'] },
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
    { name: 'validE', ends: ['DE.validE', 'EM.validE', 'hz.validE'], tags: ['hz.validE'] },
    { name: 'PCE', ends: ['DE.pcE', 'EM.pcE', 'srcA.b', 'target.a'], tags: ['srcA.b', 'target.a'] },
    { name: 'PCPlus4E', ends: ['DE.pcPlus4E', 'EM.pcPlus4E'] },
    { name: 'RD1E', ends: ['DE.rd1E', 'fwdA.d0'] },
    { name: 'RD2E', ends: ['DE.rd2E', 'fwdB.d0'] },
    { name: 'ImmExtE', ends: ['DE.immE', 'EM.immE', 'srcB.b', 'target.b'], tags: ['srcB.b', 'target.b'] },
    { name: 'rs1E', ends: ['DE.rs1E', 'hz.rs1E'], tags: true },
    { name: 'rs2E', ends: ['DE.rs2E', 'hz.rs2E'], tags: true },
    { name: 'rdE', ends: ['DE.rdE', 'EM.rdE', 'hz.rdE'], tags: ['hz.rdE'] },
    { name: 'regWriteE', ends: ['DE.regWriteE', 'EM.regWriteE'] },
    { name: 'memWriteE', ends: ['DE.memWriteE', 'EM.memWriteE'] },
    { name: 'resultSrcE', ends: ['DE.resultSrcE', 'EM.resultSrcE', 'hz.resultSrcE'], tags: ['hz.resultSrcE'] },
    { name: 'ALUSrcAE', ends: ['DE.aluSrcAE', 'srcA.s'], tags: true },
    { name: 'ALUSrcBE', ends: ['DE.aluSrcBE', 'srcB.s'], tags: true },
    { name: 'BranchE', ends: ['DE.branchE', 'npc.branch'], tags: true },
    { name: 'JumpE', ends: ['DE.jumpE', 'npc.jump'], tags: true },
    { name: 'JalrE', ends: ['DE.jalrE', 'npc.jalr'], tags: true },
    { name: 'ALUControlE', ends: ['DE.aluCtlE', 'alu.ctl'], tags: true },
    { name: 'funct3E', ends: ['DE.funct3E', 'npc.funct3'], tags: true },
    { name: 'forwardA', ends: ['hz.forwardA', 'fwdA.s'], tags: true },
    { name: 'forwardB', ends: ['hz.forwardB', 'fwdB.s'], tags: true },
    { name: 'ResultW', ends: ['res.y', 'fwdA.d1', 'fwdB.d1', 'byA.b', 'byB.b', 'rf.wd'], tags: true },
    { name: 'FwdM', ends: ['fwdM.y', 'fwdA.d2', 'fwdA.d3', 'fwdB.d2', 'fwdB.d3'], tags: true },
    { name: 'SrcAE', ends: ['fwdA.y', 'srcA.a'] },
    { name: 'WriteDataE', ends: ['fwdB.y', 'srcB.a', 'EM.writeDataE'], tags: ['EM.writeDataE'] },
    { name: 'SrcA', ends: ['srcA.y', 'alu.a'] },
    { name: 'SrcB', ends: ['srcB.y', 'alu.b'] },
    { name: 'ALUResultE', ends: ['alu.y', 'EM.aluResultE', 'clr0.in'], trunk: P('alu', 'y')[0] + 8 },
    { name: 'Zero', ends: ['alu.zero', 'npc.zero'], tags: true },
    { name: 'Neg', ends: ['alu.neg', 'npc.neg'], tags: true },
    { name: 'Ovf', ends: ['alu.ovf', 'npc.ovf'], tags: true },
    { name: 'Carry', ends: ['alu.carry', 'npc.carry'], tags: true },
    { name: 'PCTargetE', ends: ['target.s', 'pcmux.d1'], tags: true },
    { name: 'JalrTargetE', ends: ['clr0.out', 'pcmux.d2'], tags: true },
    { name: 'PCSrcE', ends: ['npc.pcSrc', 'pcmux.s', 'hz.pcSrcE'], tags: true },
    { name: 'gT', ends: ['gT.y', 'target.cin'], via: { 'target.cin': [[P('target', 'cin')[0], P('gT', 'y')[1]]] } },
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
    // clock to every register (as a net label)
    { name: 'clk', ends: ['clk', 'pc.clk', 'FD.clk', 'rf.clk', 'DE.clk', 'EM.clk', 'dm.clk', 'MW.clk'], tags: ['pc.clk', 'FD.clk', 'rf.clk', 'DE.clk', 'EM.clk', 'dm.clk', 'MW.clk'] },
    { name: 'pcF_out', ends: ['pc.q', 'pcF'] },
  ];
  // pc.q appears twice: fold the observation pin into the PCF net.
  const pcfNet = nets.find((n) => n.name === 'PCF')!;
  pcfNet.ends.push('pcF');
  pcfNet.tags = ['pcF'];
  const filtered = nets.filter((n) => n.name !== 'pcF_out');
  void constWord;

  const yb = T + PIPE_H + 6;
  return {
    id: `pipe_${IM.id}${adder === 'ks' ? '_ks' : ''}`, name: `Pipelined RV32I CPU${adder === 'ks' ? ' (fast adders)' : ''}`, category: 'cpu',
    summary: 'Five stages, one instruction entering per cycle. Forwarding, a W→D bypass, load-use stalls and branch flushes keep it architecturally identical to the single-cycle machine.',
    ports: [bit('clk', 'in', 'left', true), bus('pcF', 32, 'out'), bit('validW', 'out'), bus('pcW', 32, 'out')],
    symbol: { kind: 'box', label: 'RV32I PIPE' },
    netlist: () => ({ pins: { clk: [0, yb], pcF: [xMW + 30, yb + 4], validW: [xMW + 30, yb + 7], pcW: [xMW + 30, yb + 10] }, instances, nets: filtered }),
    hdl: { verilog: '// See the hazard unit, pipeline registers and stage blocks; structure follows the primer\'s hdl/rv_pipe.sv.' },
  };
}
