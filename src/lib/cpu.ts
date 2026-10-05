// Level 7: a single-cycle RV32I processor, built only from the parts of the earlier levels.
// Every instruction completes in one clock cycle: fetch, decode, execute, memory and
// write-back all happen in the combinational logic between two rising edges.
//
// Implemented: all of RV32I except byte/halfword loads & stores, FENCE, ECALL, EBREAK.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord, orN } from './alu';
import { andN, busMux2, incrementer, muxTree, rca } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR, XNOR, XOR } from './gates';
import { ram } from './memory';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

// ---- memories ------------------------------------------------------------------------------

function hash(words: number[]): string {
  let h = 2166136261;
  for (const w of words) { h ^= w; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

/**
 * Instruction memory: a read-only memory of 2^k words. Simulated by its behaviour (a lookup);
 * open it to see the real structure: a multiplexer tree whose inputs are constants, i.e. wires
 * tied to VDD or GND.
 */
export function rom(words: number[], k = 6): ComponentDef {
  const N = 2 ** k;
  const content = Array.from({ length: N }, (_, i) => (words[i] ?? 0x00000013) >>> 0);
  return memo(`rom${k}_${hash(content)}`, () => {
    const M = muxTree(k, 32, 4);
    const mg = symbolGeom(M);
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter([2, k, 30 - k]), at: [3, mg.h + 6] },
      { name: 'mux', def: M, at: [16, 0] },
    ];
    const nets: NetDef[] = [
      { name: 'addr', ends: ['addr', 'sa.in'] },
      { name: 'index', ends: ['sa.o1', 'mux.s'], via: { 'mux.s': [[16 + mg.ports.s.pos[0], mg.h + 7]] } },
      { name: 'data', ends: ['mux.y', 'data'] },
    ];
    content.forEach((w, i) => {
      instances.push({ name: `c${i}`, def: constWord(32, w), at: [8, mg.ports[`d${i}`].pos[1] - 1], label: `[${i}]` });
      nets.push({ ends: [`c${i}.y`, `mux.d${i}`] });
    });
    return {
      id: `rom_${hash(content)}`, name: 'Instruction memory', category: 'memory',
      summary: `${N} words of program, read-only. The address selects a word; a ROM is just a multiplexer tree whose inputs are tied to constants.`,
      ports: [bus('addr', 32, 'in'), bus('data', 32, 'out')],
      symbol: { kind: 'box', label: 'INSTR MEM' },
      behavior: { eval: ([a]) => [a < 0 ? -1 : content[Math.floor(a / 4) % N]] },
      preferBehavior: true,
      netlist: () => ({ pins: { addr: [0, mg.h + 6 + 1 + 0], data: [16 + mg.w + 6, mg.ports.y.pos[1]] }, instances, nets }),
      notes: 'Simulated as a lookup table for speed. Its structure (shown when you open it) is the real circuit: a 64:1 multiplexer tree of 32-bit words whose inputs are wired to the program\'s bits.',
    } satisfies ComponentDef;
  });
}

/** Word-addressed data memory: 2^k words; the low two address bits are ignored. */
export function dataMemory(k = 5): ComponentDef {
  return memo(`dmem${k}`, () => {
    const R = ram(k, 32);
    const rg = symbolGeom(R);
    return define({
      id: `dmem${k}`, name: 'Data memory', category: 'memory',
      summary: `${2 ** k} words (${4 * 2 ** k} bytes). The memory array from Chapter 10 at 32 bits wide; address bits [${k + 1}:2] select the word.`,
      ports: [bus('addr', 32, 'in'), bus('wd', 32, 'in'), bit('we', 'in'), bit('clk', 'in', 'bottom', true), bus('rd', 32, 'out')],
      symbol: { kind: 'box', label: 'DATA MEM' },
      netlist: () => ({
        pins: { addr: [0, 3], wd: [0, 3 + rg.ports.din.pos[1]], we: [0, 3 + rg.ports.we.pos[1]], clk: [0, 3 + rg.h + 3], rd: [14 + rg.w + 5, 3 + rg.ports.dout.pos[1]] },
        instances: [
          { name: 'sa', def: splitter([2, k, 30 - k]), at: [4, 3 + rg.ports.addr.pos[1] - 3] },
          { name: 'ram', def: R, at: [14, 3] },
        ],
        nets: [
          { name: 'addr', ends: ['addr', 'sa.in'] },
          { name: 'index', ends: ['sa.o1', 'ram.addr'] },
          { name: 'wd', ends: ['wd', 'ram.din'] },
          { name: 'we', ends: ['we', 'ram.we'] },
          { name: 'clk', ends: ['clk', 'ram.clk'] },
          { name: 'rd', ends: ['ram.dout', 'rd'] },
        ],
      }),
    });
  });
}

// ---- immediates ----------------------------------------------------------------------------

type BitSrc = number | 'zero';
function wiring(id: string, name: string, map: (i: number) => BitSrc, summary: string): ComponentDef {
  const alias: [string, number, string, number][] = [];
  for (let i = 0; i < 32; i++) {
    const s = map(i);
    alias.push(s === 'zero' ? ['zero', 0, 'out', i] : ['in', s, 'out', i]);
  }
  const usesZero = alias.some((a) => a[0] === 'zero');
  return define({
    id, name, category: 'plumbing', summary,
    ports: [bus('in', 32, 'in'), ...(usesZero ? [bit('zero', 'in', 'bottom')] : []), bus('out', 32, 'out')],
    symbol: { kind: 'box', label: name.replace(/ .*/, ''), w: 6, h: 2 }, prim: 'alias', alias,
  });
}

export const IMM_I = wiring('imm_i', 'I-imm (wiring)', (i) => (i < 12 ? 20 + i : 31), 'instr[31:20], sign-extended: bit 31 is copied into every upper bit.');
export const IMM_S = wiring('imm_s', 'S-imm (wiring)', (i) => (i < 5 ? 7 + i : i < 11 ? 25 + (i - 5) : 31), '{instr[31:25], instr[11:7]}, sign-extended. The split keeps rs1/rs2 in the same place in every format.');
export const IMM_B = wiring('imm_b', 'B-imm (wiring)', (i) => (i === 0 ? 'zero' : i < 5 ? 7 + i : i < 11 ? 25 + (i - 5) : i === 11 ? 7 : 31), 'Branch offset: like S but in units of 2 bytes, so bit 0 is always 0 and bit 11 moves to instr[7].');
export const IMM_U = wiring('imm_u', 'U-imm (wiring)', (i) => (i < 12 ? 'zero' : i), 'instr[31:12] in the upper 20 bits, zeros below (lui, auipc).');
export const IMM_J = wiring('imm_j', 'J-imm (wiring)', (i) => (i === 0 ? 'zero' : i < 11 ? 20 + i : i === 11 ? 20 : i < 20 ? i : 31), 'Jump offset: instr[31|19:12|20|30:21] scrambled so that the sign bit is always instr[31].');

/** Immediate generator: all five formats are pure wiring; a multiplexer picks one (ImmSrc). */
export const IMM_GEN: ComponentDef = (() => {
  const M = muxTree(3, 32, 4);
  const mg = symbolGeom(M);
  const mx = 16, my = 0;
  const dY = (i: number) => my + mg.ports[`d${i}`].pos[1];
  const fmts = [IMM_I, IMM_S, IMM_B, IMM_U, IMM_J];
  const instances: InstanceDef[] = [
    { name: 'mux', def: M, at: [mx, my] },
    { name: 'gnd', def: TIE0, at: [2, mg.h + 3] },
    { name: 'z32', def: constWord(32, 0), at: [6, dY(6) - 1], label: 'unused' },
  ];
  const nets: NetDef[] = [{ name: 'imm', ends: ['mux.y', 'imm'] }, { name: 'src', ends: ['src', 'mux.s'], via: { 'mux.s': [[mx + mg.ports.s.pos[0], mg.h + 5]] } }];
  const inEnds = ['instr'];
  const zeroEnds = ['gnd.y'];
  const zeroVia: Record<string, [number, number][]> = {};
  fmts.forEach((f, i) => {
    const nm = ['i', 's', 'b', 'u', 'j'][i];
    instances.push({ name: nm, def: f, at: [6, dY(i) - 1] });
    inEnds.push(`${nm}.in`);
    nets.push({ name: `imm_${nm}`, ends: [`${nm}.out`, `mux.d${i}`] });
    if (f.ports.some((p) => p.name === 'zero')) {
      zeroEnds.push(`${nm}.zero`);
      zeroVia[`${nm}.zero`] = [[4.5, dY(i) + 2], [9, dY(i) + 2]];
    }
  });
  nets.push({ name: 'instr', ends: inEnds, trunk: 3 });
  nets.push({ name: 'zero', ends: zeroEnds, via: zeroVia });
  nets.push({ name: 'unused', ends: ['z32.y', 'mux.d5', 'mux.d6', 'mux.d7'], trunk: 14 });
  return define({
    id: 'immgen', name: 'Immediate generator', category: 'cpu',
    summary: 'Extracts the constant hidden in an instruction. Each of the five formats is pure wiring (no gates); ImmSrc picks one: 0 I, 1 S, 2 B, 3 U, 4 J.',
    ports: [bus('instr', 32, 'in'), bus('src', 3, 'in', 'bottom'), bus('imm', 32, 'out')],
    symbol: { kind: 'box', label: 'IMM' },
    netlist: () => ({ pins: { instr: [0, dY(2)], src: [0, mg.h + 5], imm: [mx + mg.w + 6, my + mg.ports.y.pos[1]] }, instances, nets }),
    hdl: {
      verilog: `module immgen (input logic [31:0] instr, input logic [2:0] src, output logic [31:0] imm);
  always_comb
    case (src)
      3'd0: imm = {{20{instr[31]}}, instr[31:20]};                                // I
      3'd1: imm = {{20{instr[31]}}, instr[31:25], instr[11:7]};                   // S
      3'd2: imm = {{19{instr[31]}}, instr[31], instr[7], instr[30:25], instr[11:8], 1'b0};  // B
      3'd3: imm = {instr[31:12], 12'b0};                                          // U
      3'd4: imm = {{11{instr[31]}}, instr[31], instr[19:12], instr[20], instr[30:21], 1'b0}; // J
      default: imm = '0;
    endcase
endmodule`,
    },
  });
})();

// ---- control ---------------------------------------------------------------------------------

const CLASSES: [string, number][] = [
  ['R', 0b01100], ['I', 0b00100], ['LOAD', 0b00000], ['STORE', 0b01000], ['BRANCH', 0b11000],
  ['JAL', 0b11011], ['JALR', 0b11001], ['LUI', 0b01101], ['AUIPC', 0b00101],
];

/** Recognises the nine opcode classes: one 5-input AND per class on true/complement rails. */
export const OPCODE_DECODER: ComponentDef = (() => {
  const n = 5;
  const g = andN(n);
  const gh = symbolGeom(g).h;
  const pitch = gh + 2;
  const T = (i: number) => 8 + 7 * i, C = (i: number) => T(i) + 5;
  const XG = T(n) + 3, Y0 = 2 * n + 4;
  const instances: InstanceDef[] = [{ name: 'sa', def: splitter([2, 1, 1, 1, 1, 1]), at: [3, -2] }];
  const trueEnds: string[][] = Array.from({ length: n }, (_, i) => [`sa.o${i + 1}`, `inv${i}.a`]);
  const compEnds: string[][] = Array.from({ length: n }, (_, i) => [`inv${i}.y`]);
  for (let i = 0; i < n; i++) instances.push({ name: `inv${i}`, def: NOT, at: [T(i) + 1, 2 * i] });
  const gIn = g.ports.filter((p) => p.dir === 'in').map((p) => p.name);
  const nets: NetDef[] = [{ name: 'op', ends: ['op', 'sa.in'] }];
  const pins: Record<string, [number, number]> = { op: [0, 4] };
  CLASSES.forEach(([name, code], k) => {
    instances.push({ name: `is_${name}`, def: g, at: [XG, Y0 + pitch * k] });
    for (let i = 0; i < n; i++) ((code >> i) & 1 ? trueEnds : compEnds)[i].push(`is_${name}.${gIn[i]}`);
    nets.push({ name, ends: [`is_${name}.y`, name] });
    pins[name] = [XG + 8, Y0 + pitch * k + gh / 2];
  });
  for (let i = 0; i < n; i++) {
    nets.push({ name: `op${i + 2}`, ends: trueEnds[i], trunk: T(i) });
    nets.push({ name: `op${i + 2}_n`, ends: compEnds[i], trunk: C(i) });
  }
  return define({
    id: 'opdec', name: 'Opcode decoder', category: 'cpu',
    summary: 'Which kind of instruction is this? One AND gate per instruction class matches opcode[6:2] (bits 1:0 are always 11).',
    ports: [bus('op', 7, 'in'), ...CLASSES.map(([n]) => bit(n, 'out'))],
    symbol: { kind: 'box', label: 'OPCODE' },
    netlist: () => ({ pins, instances, nets }),
  });
})();

/** Control unit: opcode classes → datapath control signals (OR gates), plus the ALU decoder. */
export const CONTROL: ComponentDef = (() => {
  const D = OPCODE_DECODER;
  const dg = symbolGeom(D);
  const rail = (k: number) => dg.w + 4 + 2 * k; // vertical rail per class
  const classIdx = new Map(CLASSES.map(([n], i) => [n, i]));
  const XO = rail(CLASSES.length) + 4; // OR gate column
  type Sig = { name: string; from: string[] };
  const sigs: Sig[] = [
    { name: 'regWrite', from: ['R', 'I', 'LOAD', 'JAL', 'JALR', 'LUI', 'AUIPC'] },
    { name: 'aluSrcB', from: ['I', 'LOAD', 'STORE', 'JALR', 'AUIPC'] },
    { name: 'resSrc0', from: ['LOAD', 'LUI'] },
    { name: 'resSrc1', from: ['JAL', 'JALR', 'LUI'] },
    { name: 'immSrc0', from: ['STORE', 'LUI', 'AUIPC'] },
    { name: 'immSrc1', from: ['BRANCH', 'LUI', 'AUIPC'] },
    { name: 'aluOp', from: ['R', 'I'] },
  ];
  const direct: [string, string][] = [['aluSrcA', 'AUIPC'], ['memWrite', 'STORE'], ['branch', 'BRANCH'], ['jump', 'JAL'], ['jalr', 'JALR'], ['immSrc2', 'JAL']];
  const instances: InstanceDef[] = [{ name: 'dec', def: D, at: [4, 0] }];
  const nets: NetDef[] = [{ name: 'op', ends: ['op', 'dec.op'] }];
  const classEnds = new Map<string, string[]>(CLASSES.map(([n]) => [n, [`dec.${n}`]]));
  let y = 2;
  const gateOut = new Map<string, string>();
  for (const s of sigs) {
    const g = s.from.length === 2 ? OR : orN(s.from.length);
    const gg = symbolGeom(g);
    const ins = g.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    instances.push({ name: `g_${s.name}`, def: g, at: [XO, y] });
    s.from.forEach((c, i) => classEnds.get(c)!.push(`g_${s.name}.${ins[i]}`));
    gateOut.set(s.name, `g_${s.name}.y`);
    y += gg.h + 2;
  }
  for (const [sig, c] of direct) gateOut.set(sig, `dec.${c}`);
  // ALU decoder: ctl[2:0] = aluOp ? funct3 : 0; ctl[3] = aluOp & f7b5 & (R | f3 == 101) | BRANCH
  const ya = y + 2;
  instances.push(
    { name: 'sf3', def: splitter([1, 1, 1]), at: [XO - 10, ya] },
    { name: 'sf7', def: splitter([5, 1, 1]), at: [XO - 10, ya + 8] },
    { name: 'a0', def: AND, at: [XO, ya] },
    { name: 'a1', def: AND, at: [XO, ya + 5] },
    { name: 'a2', def: AND, at: [XO, ya + 10] },
    { name: 'nf1', def: NOT, at: [XO + 6, ya + 16] },
    { name: 'is101', def: andN(3), at: [XO + 11, ya + 14] },
    { name: 'shR', def: OR, at: [XO + 18, ya + 15] },
    { name: 'alt1', def: andN(3), at: [XO + 25, ya + 13] },
    { name: 'alt', def: OR, at: [XO + 32, ya + 15] },
    { name: 'mctl', def: merger([1, 1, 1, 1]), at: [XO + 40, ya] },
    { name: 'mimm', def: merger([1, 1, 1]), at: [XO + 40, 22] },
    { name: 'mres', def: merger([1, 1]), at: [XO + 40, 9] },
  );
  for (const [c, ends] of classEnds) nets.push({ name: c, ends: [...ends, ...(c === 'R' ? ['shR.a'] : []), ...(c === 'BRANCH' ? ['alt.b'] : [])], trunk: rail(classIdx.get(c)!) });
  nets.push(
    { name: 'f3', ends: ['funct3', 'sf3.in'] },
    { name: 'f7', ends: ['funct7', 'sf7.in'] },
    { name: 'aluOp', ends: [gateOut.get('aluOp')!, 'a0.a', 'a1.a', 'a2.a', 'alt1.i0'], trunk: XO + 5 },
    { name: 'f3_0', ends: ['sf3.o0', 'a0.b', 'is101.i0'] },
    { name: 'f3_1', ends: ['sf3.o1', 'a1.b', 'nf1.a'] },
    { name: 'f3_2', ends: ['sf3.o2', 'a2.b', 'is101.i2'] },
    { name: 'nf3_1', ends: ['nf1.y', 'is101.i1'] },
    { name: 'f7b5', ends: ['sf7.o1', 'alt1.i1'] },
    { name: 'is101', ends: ['is101.y', 'shR.b'] },
    { name: 'shR', ends: ['shR.y', 'alt1.i2'] },
    { name: 'alt1', ends: ['alt1.y', 'alt.a'] },
    { name: 'c0', ends: ['a0.y', 'mctl.i0'] },
    { name: 'c1', ends: ['a1.y', 'mctl.i1'] },
    { name: 'c2', ends: ['a2.y', 'mctl.i2'] },
    { name: 'c3', ends: ['alt.y', 'mctl.i3'] },
    { name: 'aluCtl', ends: ['mctl.out', 'aluCtl'] },
    { name: 'immSrc0', ends: [gateOut.get('immSrc0')!, 'mimm.i0'] },
    { name: 'immSrc1', ends: [gateOut.get('immSrc1')!, 'mimm.i1'] },
    { name: 'immSrc2', ends: [gateOut.get('immSrc2')!, 'mimm.i2'] },
    { name: 'immSrc', ends: ['mimm.out', 'immSrc'] },
    { name: 'resSrc0', ends: [gateOut.get('resSrc0')!, 'mres.i0'] },
    { name: 'resSrc1', ends: [gateOut.get('resSrc1')!, 'mres.i1'] },
    { name: 'resultSrc', ends: ['mres.out', 'resultSrc'] },
  );
  for (const s of ['regWrite', 'aluSrcB', 'aluSrcA', 'memWrite', 'branch', 'jump', 'jalr']) {
    nets.push({ name: s, ends: [gateOut.get(s)!, s] });
  }
  // The direct class signals already belong to class nets; merge them.
  const merged: NetDef[] = [];
  const byDriver = new Map<string, NetDef>();
  for (const n of nets) {
    const k = n.ends[0];
    const prev = byDriver.get(k);
    if (prev && k.startsWith('dec.')) {
      prev.ends.push(...n.ends.slice(1));
      continue;
    }
    byDriver.set(k, n);
    merged.push(n);
  }
  const outs = ['regWrite', 'immSrc', 'aluSrcA', 'aluSrcB', 'memWrite', 'resultSrc', 'branch', 'jump', 'jalr', 'aluCtl'];
  const OX = XO + 50;
  const pins: Record<string, [number, number]> = { op: [0, 4], funct3: [XO - 14, ya + 1.5], funct7: [XO - 14, ya + 11] };
  outs.forEach((o, i) => (pins[o] = [OX, 2 + 4 * i]));
  return define({
    id: 'control', name: 'Control unit', category: 'cpu',
    summary: 'Turns the instruction\'s opcode and function fields into the switch settings for the datapath: which mux inputs to pick, whether to write a register or memory, which ALU operation.',
    ports: [
      bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'),
      bit('regWrite', 'out', 'bottom'), bus('immSrc', 3, 'out', 'bottom'), bit('aluSrcA', 'out', 'bottom'), bit('aluSrcB', 'out', 'bottom'),
      bit('memWrite', 'out', 'bottom'), bus('resultSrc', 2, 'out', 'bottom'), bit('branch', 'out', 'bottom'), bit('jump', 'out', 'bottom'),
      bit('jalr', 'out', 'bottom'), bus('aluCtl', 4, 'out', 'bottom'),
    ],
    symbol: { kind: 'box', label: 'CONTROL', w: 26 },
    netlist: () => ({ pins, instances, nets: merged }),
    notes: `<table><tr><th>class</th><th>RegW</th><th>ImmSrc</th><th>SrcA</th><th>SrcB</th><th>MemW</th><th>Result</th></tr>
      <tr><td>R</td><td>1</td><td>–</td><td>rs1</td><td>rs2</td><td>0</td><td>ALU</td></tr>
      <tr><td>I</td><td>1</td><td>I</td><td>rs1</td><td>imm</td><td>0</td><td>ALU</td></tr>
      <tr><td>LOAD</td><td>1</td><td>I</td><td>rs1</td><td>imm</td><td>0</td><td>mem</td></tr>
      <tr><td>STORE</td><td>0</td><td>S</td><td>rs1</td><td>imm</td><td>1</td><td>–</td></tr>
      <tr><td>BRANCH</td><td>0</td><td>B</td><td>rs1</td><td>rs2</td><td>0</td><td>–</td></tr>
      <tr><td>JAL</td><td>1</td><td>J</td><td>–</td><td>–</td><td>0</td><td>PC+4</td></tr>
      <tr><td>JALR</td><td>1</td><td>I</td><td>rs1</td><td>imm</td><td>0</td><td>PC+4</td></tr>
      <tr><td>LUI</td><td>1</td><td>U</td><td>–</td><td>–</td><td>0</td><td>imm</td></tr>
      <tr><td>AUIPC</td><td>1</td><td>U</td><td>PC</td><td>imm</td><td>0</td><td>ALU</td></tr></table>`,
  });
})();

/** Branch decision and next-PC select. */
export const NEXT_PC: ComponentDef = (() => {
  const M = muxTree(3, 1);
  const mg = symbolGeom(M);
  const mx = 20;
  const dY = (i: number) => mg.ports[`d${i}`].pos[1];
  return define({
    id: 'nextpc', name: 'Branch & next-PC logic', category: 'cpu',
    summary: 'Decides where the next instruction comes from: PC+4, PC+offset (taken branch or jal), or the ALU result (jalr). Branch conditions are read from the ALU flags of rs1 − rs2.',
    ports: [
      bit('zero', 'in'), bit('neg', 'in'), bit('ovf', 'in'), bit('carry', 'in'), bus('funct3', 3, 'in'),
      bit('branch', 'in'), bit('jump', 'in'), bit('jalr', 'in'), bus('pcSrc', 2, 'out'),
    ],
    symbol: { kind: 'box', label: 'NEXT PC' },
    netlist: () => ({
      pins: { zero: [0, dY(0)], neg: [0, dY(4) - 1], ovf: [0, dY(4) + 1], carry: [0, dY(7) + 2], funct3: [0, mg.h + 4], branch: [0, mg.h + 8], jump: [0, mg.h + 11], jalr: [0, mg.h + 14], pcSrc: [mx + 30, mg.h / 2 + 4] },
      instances: [
        { name: 'nz', def: NOT, at: [8, dY(1) - 1] },
        { name: 'lt', def: XOR, at: [6, dY(4) - 2] },
        { name: 'ge', def: XNOR, at: [6, dY(5) + 1] },
        { name: 'nc', def: NOT, at: [8, dY(6) - 1] },
        { name: 'gnd', def: TIE0, at: [14, dY(2) - 1] },
        { name: 'cond', def: M, at: [mx, 0] },
        { name: 'take', def: AND, at: [mx + 7, mg.h / 2 + 1] },
        { name: 'src0', def: OR, at: [mx + 14, mg.h / 2 + 2] },
        { name: 'mp', def: merger([1, 1]), at: [mx + 24, mg.h / 2 + 2] },
      ],
      nets: [
        { name: 'zero', ends: ['zero', 'cond.d0', 'nz.a'], trunk: 3 },
        { name: 'nzero', ends: ['nz.y', 'cond.d1'] },
        { name: 'neg', ends: ['neg', 'lt.a', 'ge.a'], trunk: 2 },
        { name: 'ovf', ends: ['ovf', 'lt.b', 'ge.b'], trunk: 4 },
        { name: 'lt', ends: ['lt.y', 'cond.d4'] },
        { name: 'ge', ends: ['ge.y', 'cond.d5'] },
        { name: 'carry', ends: ['carry', 'cond.d7', 'nc.a'], trunk: 5 },
        { name: 'ltu', ends: ['nc.y', 'cond.d6'] },
        { name: 'never', ends: ['gnd.y', 'cond.d2', 'cond.d3'], trunk: 18 },
        { name: 'funct3', ends: ['funct3', 'cond.s'], via: { 'cond.s': [[mx + mg.ports.s.pos[0], mg.h + 4]] } },
        { name: 'cond', ends: ['cond.y', 'take.b'] },
        { name: 'branch', ends: ['branch', 'take.a'], via: { 'take.a': [[mx + 5, mg.h + 8], [mx + 5, mg.h / 2 + 2]] } },
        { name: 'take', ends: ['take.y', 'src0.a'] },
        { name: 'jump', ends: ['jump', 'src0.b'], via: { 'src0.b': [[mx + 12, mg.h + 11], [mx + 12, mg.h / 2 + 5]] } },
        { name: 'src0', ends: ['src0.y', 'mp.i0'] },
        { name: 'jalr', ends: ['jalr', 'mp.i1'], via: { 'mp.i1': [[mx + 22, mg.h + 14], [mx + 22, mg.h / 2 + 5]] } },
        { name: 'pcSrc', ends: ['mp.out', 'pcSrc'] },
      ],
    }),
    notes: `<table><tr><th>funct3</th><th>branch</th><th>taken when</th></tr>
      <tr><td>000</td><td>beq</td><td>Z</td></tr><tr><td>001</td><td>bne</td><td>¬Z</td></tr>
      <tr><td>100</td><td>blt</td><td>N ⊕ V</td></tr><tr><td>101</td><td>bge</td><td>¬(N ⊕ V)</td></tr>
      <tr><td>110</td><td>bltu</td><td>¬C</td></tr><tr><td>111</td><td>bgeu</td><td>C</td></tr></table>`,
  });
})();

/** PC + 4: the low two bits pass through; an incrementer adds 1 to bits [31:2]. */
export const PLUS4: ComponentDef = define({
  id: 'plus4', name: 'PC + 4', category: 'arithmetic',
  summary: 'Instructions are 4 bytes, so the next one is at PC + 4: increment bits [31:2] and pass bits [1:0] through. A 30-bit chain of half adders.',
  ports: [bus('a', 32, 'in'), bus('y', 32, 'out')],
  symbol: { kind: 'box', label: '+4' },
  spec: ([a]) => [(a + 4) % 2 ** 32],
  netlist: () => {
    const I = incrementer(30);
    const ig = symbolGeom(I);
    return {
      pins: { a: [0, 4], y: [30, 4] },
      instances: [
        { name: 'sa', def: splitter([2, 30]), at: [3, 2] },
        { name: 'inc', def: I, at: [10, 5 - ig.ports.a.pos[1] + 0] },
        { name: 'my', def: merger([2, 30]), at: [24, 2] },
      ],
      nets: [
        { name: 'a', ends: ['a', 'sa.in'] },
        { name: 'lo', ends: ['sa.o0', 'my.i0'], via: { 'my.i0': [[5, 1], [22, 1], [22, 3]] } },
        { name: 'hi', ends: ['sa.o1', 'inc.a'] },
        { name: 'hi1', ends: ['inc.y', 'my.i1'] },
        { name: 'y', ends: ['my.out', 'y'] },
      ],
    };
  },
});

/** Clear bit 0 (jalr targets are always even). */
export const CLEAR_BIT0: ComponentDef = wiring('clr0', 'AND ~1 (wiring)', (i) => (i === 0 ? 'zero' : i), 'jalr target = (rs1 + imm) with bit 0 cleared: wire bit 0 to ground.');

// ---- the processor ------------------------------------------------------------------------

export interface CpuOptions {
  /** Data memory: 2^k words. */
  dmemK?: number;
}

/**
 * Single-cycle RV32I CPU running `program` (instruction words). Inputs: clk. Outputs expose
 * the key buses for the waveform viewer.
 */
export function singleCycleCpu(program: number[], opts: CpuOptions = {}): ComponentDef {
  const IM = rom(program);
  const key = `cpu1_${IM.id}_${opts.dmemK ?? 5}`;
  return memo(key, () => buildCpu(IM, opts.dmemK ?? 5));
}

function buildCpu(IM: ComponentDef, dmemK: number): ComponentDef {
  const PC = register(32), RF = regfile(5, 32), ALU = alu(32), DM = dataMemory(dmemK);
  const M2 = busMux2(32), M4 = muxTree(2, 32), ADD = rca(32);
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const P = (inst: string, def: ComponentDef, port: string): [number, number] => {
    const a = at.get(inst)!;
    const p = g(def).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  };

  // Main row baseline.
  const Y = 40;
  at.set('pcmux', [4, Y - 2]);
  at.set('pc', [14, Y + g(M4).ports.y.pos[1] - 2 - g(PC).ports.d.pos[1]]);
  at.set('imem', [30, P('pc', PC, 'q')[1] - g(IM).ports.addr.pos[1]]);
  const instrY = P('imem', IM, 'data')[1];
  at.set('si', [48, instrY - 6]); // instruction field splitter: op, rd, f3, rs1, rs2, f7
  at.set('rf', [62, Y - 2]);
  at.set('imm', [62, Y + 22]);
  at.set('srcA', [86, P('rf', RF, 'rd1')[1] - g(M2).ports.a.pos[1]]);
  at.set('srcB', [86, P('rf', RF, 'rd2')[1] - g(M2).ports.a.pos[1] + 4]);
  at.set('alu', [98, P('srcA', M2, 'y')[1] - g(ALU).ports.a.pos[1]]);
  at.set('dm', [124, P('alu', ALU, 'y')[1] - g(DM).ports.addr.pos[1]]);
  at.set('res', [146, P('dm', DM, 'rd')[1] - g(M4).ports.d1.pos[1]]);
  at.set('plus4', [24, Y - 18]);
  at.set('target', [100, Y + 30]);
  at.set('clr0', [128, Y + 30]);
  at.set('ctl', [56, 0]);
  at.set('npc', [106, 2]);
  at.set('one', [8, P('pc', PC, 'en')[1] - 1]);

  const instances: InstanceDef[] = [
    { name: 'pcmux', def: M4, at: at.get('pcmux'), label: 'next PC' },
    { name: 'pc', def: PC, at: at.get('pc'), label: 'PC' },
    { name: 'one', def: TIE1, at: at.get('one') },
    { name: 'imem', def: IM, at: at.get('imem') },
    { name: 'si', def: splitter([7, 5, 3, 5, 5, 7]), at: at.get('si') },
    { name: 'rf', def: RF, at: at.get('rf') },
    { name: 'imm', def: IMM_GEN, at: at.get('imm') },
    { name: 'srcA', def: M2, at: at.get('srcA'), label: 'SrcA' },
    { name: 'srcB', def: M2, at: at.get('srcB'), label: 'SrcB' },
    { name: 'alu', def: ALU, at: at.get('alu') },
    { name: 'dm', def: DM, at: at.get('dm') },
    { name: 'res', def: M4, at: at.get('res'), label: 'result' },
    { name: 'plus4', def: PLUS4, at: at.get('plus4') },
    { name: 'target', def: ADD, at: at.get('target'), label: 'PC + imm' },
    { name: 'clr0', def: CLEAR_BIT0, at: at.get('clr0') },
    { name: 'gnd', def: TIE0, at: [at.get('target')![0] - 6, at.get('target')![1] - 4] },
    { name: 'ctl', def: CONTROL, at: at.get('ctl') },
    { name: 'npc', def: NEXT_PC, at: at.get('npc') },
  ];

  const ctlBottom = at.get('ctl')![1] + g(CONTROL).h;
  const lane = (i: number) => ctlBottom + 2 + i; // horizontal control lanes under the control unit
  const bottom = Y + 44;
  const pcq = P('pc', PC, 'q');
  const nets: NetDef[] = [
    { name: 'pcNext', ends: ['pcmux.y', 'pc.d'] },
    { name: 'en1', ends: ['one.y', 'pc.en'] },
    { name: 'clk', ends: ['clk', 'pc.clk', 'rf.clk', 'dm.clk'], trunk: bottom + 6, via: { 'pc.clk': [[P('pc', PC, 'clk')[0], bottom + 6]], 'rf.clk': [[P('rf', RF, 'clk')[0], bottom + 6]], 'dm.clk': [[P('dm', DM, 'clk')[0], bottom + 6]] } },
    {
      name: 'pc', ends: ['pc.q', 'imem.addr', 'plus4.a', 'srcA.b', 'target.a', 'pcOut'], trunk: pcq[0] + 2,
      via: {
        'srcA.b': [[pcq[0] + 2, Y + 18], [82, Y + 18], [82, P('srcA', M2, 'b')[1]]],
        'target.a': [[pcq[0] + 2, P('target', ADD, 'a')[1]]],
        'pcOut': [[pcq[0] + 2, bottom + 10]],
      },
    },
    { name: 'instr', ends: ['imem.data', 'si.in', 'imm.instr', 'instrOut'], trunk: 44, via: { 'imm.instr': [[44, P('imm', IMM_GEN, 'instr')[1]]], instrOut: [[44, bottom + 12]] } },
    { name: 'op', ends: ['si.o0', 'ctl.op'], via: { 'ctl.op': [[52, P('ctl', CONTROL, 'op')[1]]] } },
    { name: 'rd', ends: ['si.o1', 'rf.wa'], via: { 'rf.wa': [[55, P('si', splitter([7, 5, 3, 5, 5, 7]), 'o1')[1]], [55, P('rf', RF, 'wa')[1]]] } },
    { name: 'funct3', ends: ['si.o2', 'ctl.funct3', 'npc.funct3'], via: { 'ctl.funct3': [[53, P('ctl', CONTROL, 'funct3')[1]]], 'npc.funct3': [[53, lane(11)], [102, lane(11)], [102, P('npc', NEXT_PC, 'funct3')[1]]] } },
    { name: 'rs1', ends: ['si.o3', 'rf.ra1'], via: { 'rf.ra1': [[57, P('si', splitter([7, 5, 3, 5, 5, 7]), 'o3')[1]], [57, P('rf', RF, 'ra1')[1]]] } },
    { name: 'rs2', ends: ['si.o4', 'rf.ra2'], via: { 'rf.ra2': [[58.5, P('si', splitter([7, 5, 3, 5, 5, 7]), 'o4')[1]], [58.5, P('rf', RF, 'ra2')[1]]] } },
    { name: 'funct7', ends: ['si.o5', 'ctl.funct7'], via: { 'ctl.funct7': [[54, P('ctl', CONTROL, 'funct7')[1]]] } },
    { name: 'rd1', ends: ['rf.rd1', 'srcA.a'] },
    { name: 'rd2', ends: ['rf.rd2', 'srcB.a', 'dm.wd'], via: { 'dm.wd': [[80, P('rf', RF, 'rd2')[1]], [80, Y + 16], [120, Y + 16], [120, P('dm', DM, 'wd')[1]]] } },
    { name: 'imm', ends: ['imm.imm', 'srcB.b', 'target.b', 'res.d3'], via: { 'srcB.b': [[84, P('imm', IMM_GEN, 'imm')[1]], [84, P('srcB', M2, 'b')[1]]], 'target.b': [[84, P('imm', IMM_GEN, 'imm')[1]], [84, P('target', ADD, 'b')[1]]], 'res.d3': [[84, P('imm', IMM_GEN, 'imm')[1]], [84, bottom], [142, bottom], [142, P('res', M4, 'd3')[1]]] } },
    { name: 'srcA', ends: ['srcA.y', 'alu.a'] },
    { name: 'srcB', ends: ['srcB.y', 'alu.b'] },
    {
      name: 'aluResult', ends: ['alu.y', 'dm.addr', 'res.d0', 'clr0.in', 'aluOut'], trunk: P('alu', ALU, 'y')[0] + 3,
      via: { 'res.d0': [[P('alu', ALU, 'y')[0] + 3, P('alu', ALU, 'y')[1] - 6], [140, P('alu', ALU, 'y')[1] - 6], [140, P('res', M4, 'd0')[1]]], 'clr0.in': [[P('alu', ALU, 'y')[0] + 3, P('clr0', CLEAR_BIT0, 'in')[1]]], aluOut: [[P('alu', ALU, 'y')[0] + 3, bottom + 14]] },
    },
    { name: 'readData', ends: ['dm.rd', 'res.d1'] },
    { name: 'pcPlus4', ends: ['plus4.y', 'pcmux.d0', 'pcmux.d3', 'res.d2'], via: { 'pcmux.d0': [[P('plus4', PLUS4, 'y')[0] + 2, Y - 22], [2, Y - 22], [2, P('pcmux', M4, 'd0')[1]]], 'pcmux.d3': [[P('plus4', PLUS4, 'y')[0] + 2, Y - 22], [2, Y - 22], [2, P('pcmux', M4, 'd3')[1]]], 'res.d2': [[P('plus4', PLUS4, 'y')[0] + 2, Y - 22], [143, Y - 22], [143, P('res', M4, 'd2')[1]]] } },
    { name: 'pcTarget', ends: ['target.s', 'pcmux.d1'], via: { 'pcmux.d1': [[P('target', ADD, 's')[0] + 2, bottom + 2], [1, bottom + 2], [1, P('pcmux', M4, 'd1')[1]]] } },
    { name: 'gnd0', ends: ['gnd.y', 'target.cin', 'clr0.zero'], via: { 'clr0.zero': [[at.get('target')![0] - 2, bottom + 4]] } },
    { name: 'jalrTarget', ends: ['clr0.out', 'pcmux.d2'], via: { 'pcmux.d2': [[P('clr0', CLEAR_BIT0, 'out')[0] + 2, bottom + 3], [0, bottom + 3], [0, P('pcmux', M4, 'd2')[1]]] } },
    { name: 'result', ends: ['res.y', 'rf.wd'], via: { 'rf.wd': [[P('res', M4, 'y')[0] + 2, bottom + 8], [59.5, bottom + 8], [59.5, P('rf', RF, 'wd')[1]]] } },
    // control lines
    { name: 'regWrite', ends: ['ctl.regWrite', 'rf.we'], via: { 'rf.we': [[P('ctl', CONTROL, 'regWrite')[0], lane(0)], [60.5, lane(0)], [60.5, P('rf', RF, 'we')[1]]] } },
    { name: 'immSrc', ends: ['ctl.immSrc', 'imm.src'], via: { 'imm.src': [[P('ctl', CONTROL, 'immSrc')[0], lane(1)], [61, lane(1)], [61, P('imm', IMM_GEN, 'src')[1]]] } },
    { name: 'aluSrcA', ends: ['ctl.aluSrcA', 'srcA.s'], via: { 'srcA.s': [[P('ctl', CONTROL, 'aluSrcA')[0], lane(2)], [P('srcA', M2, 's')[0] + 3, lane(2)], [P('srcA', M2, 's')[0] + 3, P('srcA', M2, 's')[1] + 1], [P('srcA', M2, 's')[0], P('srcA', M2, 's')[1] + 1]] } },
    { name: 'aluSrcB', ends: ['ctl.aluSrcB', 'srcB.s'], via: { 'srcB.s': [[P('ctl', CONTROL, 'aluSrcB')[0], lane(3)], [P('srcB', M2, 's')[0] + 3, lane(3)], [P('srcB', M2, 's')[0] + 3, P('srcB', M2, 's')[1] + 1], [P('srcB', M2, 's')[0], P('srcB', M2, 's')[1] + 1]] } },
    { name: 'memWrite', ends: ['ctl.memWrite', 'dm.we'], via: { 'dm.we': [[P('ctl', CONTROL, 'memWrite')[0], lane(4)], [121, lane(4)], [121, P('dm', DM, 'we')[1]]] } },
    { name: 'resultSrc', ends: ['ctl.resultSrc', 'res.s'], via: { 'res.s': [[P('ctl', CONTROL, 'resultSrc')[0], lane(5)], [P('res', M4, 's')[0] + 3, lane(5)], [P('res', M4, 's')[0] + 3, P('res', M4, 's')[1] + 1], [P('res', M4, 's')[0], P('res', M4, 's')[1] + 1]] } },
    { name: 'branch', ends: ['ctl.branch', 'npc.branch'], via: { 'npc.branch': [[P('ctl', CONTROL, 'branch')[0], lane(6)], [103, lane(6)], [103, P('npc', NEXT_PC, 'branch')[1]]] } },
    { name: 'jump', ends: ['ctl.jump', 'npc.jump'], via: { 'npc.jump': [[P('ctl', CONTROL, 'jump')[0], lane(7)], [103.5, lane(7)], [103.5, P('npc', NEXT_PC, 'jump')[1]]] } },
    { name: 'jalr', ends: ['ctl.jalr', 'npc.jalr'], via: { 'npc.jalr': [[P('ctl', CONTROL, 'jalr')[0], lane(8)], [104, lane(8)], [104, P('npc', NEXT_PC, 'jalr')[1]]] } },
    { name: 'aluCtl', ends: ['ctl.aluCtl', 'alu.ctl'], via: { 'alu.ctl': [[P('ctl', CONTROL, 'aluCtl')[0], lane(9)], [95, lane(9)], [95, P('alu', ALU, 'ctl')[1]]] } },
    // flags → next-PC logic
    { name: 'zero', ends: ['alu.zero', 'npc.zero'], via: { 'npc.zero': [[P('alu', ALU, 'zero')[0] + 1, lane(10) + 0.5], [101, lane(10) + 0.5], [101, P('npc', NEXT_PC, 'zero')[1]]] } },
    { name: 'neg', ends: ['alu.neg', 'npc.neg'], via: { 'npc.neg': [[P('alu', ALU, 'neg')[0] + 2, lane(12)], [100, lane(12)], [100, P('npc', NEXT_PC, 'neg')[1]]] } },
    { name: 'ovf', ends: ['alu.ovf', 'npc.ovf'], via: { 'npc.ovf': [[P('alu', ALU, 'ovf')[0] + 3, lane(13)], [99, lane(13)], [99, P('npc', NEXT_PC, 'ovf')[1]]] } },
    { name: 'carry', ends: ['alu.carry', 'npc.carry'], via: { 'npc.carry': [[P('alu', ALU, 'carry')[0] + 4, lane(14)], [98, lane(14)], [98, P('npc', NEXT_PC, 'carry')[1]]] } },
    { name: 'pcSrc', ends: ['npc.pcSrc', 'pcmux.s'], via: { 'pcmux.s': [[P('npc', NEXT_PC, 'pcSrc')[0] + 2, -3], [P('pcmux', M4, 's')[0] - 3.5, -3], [P('pcmux', M4, 's')[0] - 3.5, P('pcmux', M4, 's')[1] + 1], [P('pcmux', M4, 's')[0], P('pcmux', M4, 's')[1] + 1]] } },
    { name: 'memWriteOut', ends: ['dm.we'] },
  ].filter((n) => n.ends.length > 1) as NetDef[];

  return {
    id: key2(IM), name: 'Single-cycle RV32I CPU', category: 'cpu',
    summary: 'A complete RISC-V processor: every instruction is fetched, decoded, executed and retired in one clock cycle. Built entirely from the blocks of the previous chapters.',
    ports: [bit('clk', 'in', 'left', true), bus('pcOut', 32, 'out'), bus('instrOut', 32, 'out'), bus('aluOut', 32, 'out')],
    symbol: { kind: 'box', label: 'RV32I' },
    netlist: () => ({
      pins: { clk: [-4, bottom + 6], pcOut: [170, bottom + 10], instrOut: [170, bottom + 12], aluOut: [170, bottom + 14] },
      instances, nets,
    }),
    hdl: {
      verilog: `// Structure of the processor (cf. primer hdl/rv_single.sv, extended to all of RV32I)
module rv_single (input logic clk);
  logic [31:0] pc, pcnext, pcplus4, pctarget, instr, imm, srca, srcb, aluresult, readdata, result, rd1, rd2;
  logic [3:0] aluctl; logic [2:0] immsrc; logic [1:0] resultsrc, pcsrc;
  logic regwrite, alusrca, alusrcb, memwrite, branch, jump, jalr, zero, neg, ovf, carry;

  control  ctl (.op(instr[6:0]), .funct3(instr[14:12]), .funct7(instr[31:25]), .regWrite(regwrite),
                .immSrc(immsrc), .aluSrcA(alusrca), .aluSrcB(alusrcb), .memWrite(memwrite),
                .resultSrc(resultsrc), .branch, .jump, .jalr, .aluCtl(aluctl));
  nextpc   npc (.zero, .neg, .ovf, .carry, .funct3(instr[14:12]), .branch, .jump, .jalr, .pcSrc(pcsrc));

  always_ff @(posedge clk) pc <= pcnext;
  assign pcplus4  = pc + 4;
  assign pctarget = pc + imm;
  always_comb case (pcsrc) 2'd1: pcnext = pctarget; 2'd2: pcnext = {aluresult[31:1], 1'b0}; default: pcnext = pcplus4; endcase

  imem     im  (.addr(pc), .data(instr));
  regfile  rf  (.clk, .we(regwrite), .ra1(instr[19:15]), .ra2(instr[24:20]), .wa(instr[11:7]), .wd(result), .rd1, .rd2);
  immgen   ig  (.instr, .src(immsrc), .imm);
  assign srca = alusrca ? pc  : rd1;
  assign srcb = alusrcb ? imm : rd2;
  alu      alu (.a(srca), .b(srcb), .ctl(aluctl), .y(aluresult), .zero, .neg, .ovf, .carry);
  dmem     dm  (.clk, .we(memwrite), .addr(aluresult), .wd(rd2), .rd(readdata));
  always_comb case (resultsrc) 2'd0: result = aluresult; 2'd1: result = readdata; 2'd2: result = pcplus4; default: result = imm; endcase
endmodule`,
    },
  };
}

function key2(IM: ComponentDef): string {
  return `rv32i_${IM.id.replace(/^rom_/, '')}`;
}

