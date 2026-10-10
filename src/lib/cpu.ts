// Level 7: a single-cycle RV32I processor, built only from the parts of the earlier levels.
// Every instruction completes in one clock cycle: fetch, decode, execute, memory and
// write-back all happen in the combinational logic between two rising edges.
//
// Implemented: all of RV32I except byte/halfword loads & stores, FENCE, ECALL, EBREAK.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { IMM_SRC } from '../riscv/isa';
import { alu, constWord, orN } from './alu';
import { koggeStone } from './fastadd';
import { andN, busMux2, incrementer, muxTree, rca } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { ram } from './memory';
import { cachedMemory } from './cache';
import { iCache, wbCache } from './cache2';
import { FCSR, FPU32, FP_DECODE } from './fpu';
import { MP_DECODE } from './mpdecode';
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
export function rom(words: number[], k = 6, label?: string): ComponentDef {
  const N = 2 ** k;
  const content = Array.from({ length: N }, (_, i) => (words[i] ?? 0x00000013) >>> 0);
  return memo(`rom${k}_${hash(content)}${label ? `_${label}` : ''}`, () => {
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
      id: `rom_${hash(content)}${label ? `_${label.replace(/\W+/g, '_')}` : ''}`, name: label ?? 'Instruction memory', category: 'memory',
      summary: `${N} words of program, read-only. The address selects a word; a ROM is just a multiplexer tree whose inputs are tied to constants.`,
      ports: [bus('addr', 32, 'in'), bus('data', 32, 'out')],
      symbol: { kind: 'box', label: label ? label.toUpperCase() : 'INSTR MEM' },
      // Delay = depth of the real structure (k levels of MUX2, 3 NANDs each).
      behavior: { eval: ([a]) => [a < 0 ? -1 : content[Math.floor(a / 4) % N]], delay: 3 * k },
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
function wiring(id: string, name: string, map: (i: number) => BitSrc, summary: string, label?: string): ComponentDef {
  const alias: [string, number, string, number][] = [];
  for (let i = 0; i < 32; i++) {
    const s = map(i);
    alias.push(s === 'zero' ? ['zero', 0, 'out', i] : ['in', s, 'out', i]);
  }
  const usesZero = alias.some((a) => a[0] === 'zero');
  return define({
    id, name, category: 'plumbing', summary,
    ports: [bus('in', 32, 'in'), ...(usesZero ? [bit('zero', 'in', 'bottom')] : []), bus('out', 32, 'out')],
    symbol: { kind: 'box', label: label ?? name.replace(/ .*/, ''), w: 6, h: 2 }, prim: 'alias', alias,
  });
}

export const IMM_I = wiring('imm_i', 'I-imm (wiring)', IMM_SRC.I, 'instr[31:20], sign-extended: bit 31 is copied into every upper bit.');
export const IMM_S = wiring('imm_s', 'S-imm (wiring)', IMM_SRC.S, '{instr[31:25], instr[11:7]}, sign-extended. The split keeps rs1/rs2 in the same place in every format.');
export const IMM_B = wiring('imm_b', 'B-imm (wiring)', IMM_SRC.B, 'Branch offset: like S but in units of 2 bytes, so bit 0 is always 0 and bit 11 moves to instr[7].');
export const IMM_U = wiring('imm_u', 'U-imm (wiring)', IMM_SRC.U, 'instr[31:12] in the upper 20 bits, zeros below (lui, auipc).');
export const IMM_J = wiring('imm_j', 'J-imm (wiring)', IMM_SRC.J, 'Jump offset: instr[31|19:12|20|30:21] scrambled so that the sign bit is always instr[31].');

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

/** Opcode classes the decoder recognises: name and opcode[6:2]. */
export const CLASSES: [string, number][] = [
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
      bit('regWrite', 'out'), bus('immSrc', 3, 'out'), bit('aluSrcA', 'out'), bit('aluSrcB', 'out'),
      bit('memWrite', 'out'), bus('resultSrc', 2, 'out'), bit('branch', 'out'), bit('jump', 'out'),
      bit('jalr', 'out'), bus('aluCtl', 4, 'out'),
    ],
    symbol: { kind: 'box', label: 'CONTROL' },
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
        // bge = ¬blt: one inverter on lt rather than an XNOR of its own beside it
        { name: 'ge', def: NOT, at: [16, dY(5) - 1] },
        { name: 'nc', def: NOT, at: [12, dY(6) - 1] },
        // low enough that its name clears nz's output wire
        { name: 'gnd', def: TIE0, at: [14, dY(3) - 1] },
        { name: 'cond', def: M, at: [mx, 0] },
        { name: 'take', def: AND, at: [mx + 7, mg.h / 2 + 1] },
        { name: 'src0', def: OR, at: [mx + 14, mg.h / 2 + 2] },
        { name: 'mp', def: merger([1, 1]), at: [mx + 24, mg.h / 2 + 2] },
      ],
      nets: [
        { name: 'zero', ends: ['zero', 'cond.d0', 'nz.a'], trunk: 3 },
        { name: 'nzero', ends: ['nz.y', 'cond.d1'] },
        { name: 'neg', ends: ['neg', 'lt.a'] },
        { name: 'ovf', ends: ['ovf', 'lt.b'] },
        { name: 'lt', ends: ['lt.y', 'cond.d4', 'ge.a'], trunk: 15 },
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
export const CLEAR_BIT0: ComponentDef = wiring('clr0', 'Clear bit 0 (wiring)', (i) => (i === 0 ? 'zero' : i), 'jalr target = (rs1 + imm) with bit 0 cleared: wire bit 0 to ground.', 'bit0 := 0');

// ---- the processor ------------------------------------------------------------------------

export interface CpuOptions {
  /** Data memory: 2^k words. */
  dmemK?: number;
  /** 'ks' uses Kogge–Stone adders in the ALU, the branch-target adder and PC + 4. */
  adder?: 'rca' | 'ks';
  /**
   * Put a data cache in front of a slow main memory: true = 4-line direct-mapped write-through (loads
   * can stall); 'wb' = write-back, write-allocate; 'wb2' = 2-way write-back with LRU (loads and stores can stall).
   */
  dcache?: boolean | 'wb' | 'wb2';
  /** Fetch through an 8-line instruction cache in front of the ROM (fetch misses stall). */
  icache?: boolean;
  /** Add the floating-point register file, the FPU and fcsr (RV32F of chapter 23). */
  fpu?: boolean;
  /**
   * A core of the multi-core processor: no data memory of its own but a memory port (address,
   * write data, write enable, request; read data and grant come back), amoswap.w / amoadd.w, and
   * csrr mhartid from the hartid input. A core that loses arbitration stalls (retire = 0).
   */
  shared?: boolean;
  /** With shared: no instruction ROM inside; the instruction arrives on an `instr` input (for layout). */
  imemPort?: boolean;
  /** Instruction ROM of 2^imemK words (default 6: 64 words). */
  imemK?: number;
}

/** PC + 4 with a parallel-prefix adder. */
export const PLUS4_FAST: ComponentDef = define({
  id: 'plus4ks', name: 'PC + 4 (fast)', category: 'arithmetic',
  summary: 'PC + 4 with a Kogge–Stone adder: the carry into the top bit no longer ripples through 30 half adders.',
  ports: [bus('a', 32, 'in'), bus('y', 32, 'out')],
  symbol: { kind: 'box', label: '+4' },
  spec: ([a]) => [(a + 4) % 2 ** 32],
  netlist: () => {
    const K = koggeStone(32);
    const kg = symbolGeom(K);
    return {
      pins: { a: [0, 2 + kg.ports.a.pos[1]], y: [16 + kg.w + 6, 2 + kg.ports.s.pos[1]] },
      instances: [
        { name: 'four', def: constWord(32, 4), at: [4, 2 + kg.ports.b.pos[1] + 3] },
        { name: 'gnd', def: TIE0, at: [8, -3] },
        { name: 'add', def: K, at: [16, 2] },
      ],
      nets: [
        { name: 'a', ends: ['a', 'add.a'] },
        { name: 'four', ends: ['four.y', 'add.b'] },
        { name: 'gnd', ends: ['gnd.y', 'add.cin'] },
        { name: 'y', ends: ['add.s', 'y'] },
      ],
    };
  },
});

/**
 * Single-cycle RV32I CPU running `program` (instruction words). Inputs: clk. Outputs expose
 * the key buses for the waveform viewer.
 */
export function singleCycleCpu(program: number[], opts: CpuOptions = {}): ComponentDef {
  const IM = rom(program, opts.imemK ?? 6);
  const adder = opts.adder ?? 'rca';
  const key = `cpu1_${IM.id}_${opts.dmemK ?? 5}_${adder}${opts.dcache ? `_dc${opts.dcache === true ? '' : opts.dcache}` : ''}${opts.fpu ? '_fp' : ''}${opts.shared ? '_mp' : ''}${opts.imemPort ? '_ip' : ''}${opts.icache ? '_ic' : ''}`;
  return memo(key, () => buildCpu(IM, opts.dmemK ?? 5, adder, opts.dcache ?? false, !!opts.fpu, !!opts.shared, !!opts.imemPort, !!opts.icache, opts.imemK ?? 6));
}

function buildCpu(IM: ComponentDef, dmemK: number, adder: 'rca' | 'ks', dcache: boolean | 'wb' | 'wb2' = false, fpu = false, shared = false, imemPort = false, icache = false, imemK = 6): ComponentDef {
  if (icache && (fpu || shared)) throw new Error('singleCycleCpu: icache with fpu or shared is not supported');
  const IMEM = icache ? iCache(IM, 3, imemK) : IM;
  const PC = register(32), RF = regfile(5, 32), ALU = alu(32, adder), DM = dcache === 'wb' ? wbCache(dmemK, 2, 1) : dcache === 'wb2' ? wbCache(dmemK, 1, 2) : dcache ? cachedMemory(dmemK) : dataMemory(dmemK);
  const M2 = busMux2(32), M4 = muxTree(2, 32), ADD = adder === 'ks' ? koggeStone(32) : rca(32), SI = splitter([7, 5, 3, 5, 5, 7]);
  const P4 = adder === 'ks' ? PLUS4_FAST : PLUS4;
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const defs = new Map<string, ComponentDef>();
  const place = (name: string, def: ComponentDef, xy: [number, number]) => { at.set(name, xy); defs.set(name, def); };
  /** Absolute position of an instance port. */
  const P = (inst: string, port: string): [number, number] => {
    const a = at.get(inst)!;
    const p = g(defs.get(inst)!).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  };
  /** Place `inst` at column x so that its `port` lands on row y. */
  const alignY = (inst: string, def: ComponentDef, x: number, port: string, y: number) => place(inst, def, [x, y - g(def).ports[port].pos[1]]);

  const Y = 36; // main datapath row
  alignY('pcmux', M4, 2, 'y', Y);
  alignY('pc', PC, 12, 'd', Y);
  place('one', TIE1, [8, P('pc', 'en')[1] - 1]);
  const pcY = P('pc', 'q')[1];
  alignY('imem', IMEM, 27, 'addr', pcY);
  const instrY = P('imem', 'data')[1];
  alignY('si', SI, 45, 'in', instrY);
  alignY('rf', RF, 62, 'wa', P('si', 'o1')[1]);
  alignY('imm', IMM_GEN, 60, 'instr', Y + 18);
  const rfR = at.get('rf')![0] + g(RF).w;
  alignY('srcA', M2, rfR + 8, 'a', P('rf', 'rd1')[1]);
  alignY('srcB', M2, rfR + 8, 'a', P('rf', 'rd2')[1] + 9);
  alignY('alu', ALU, rfR + 18, 'a', P('srcA', 'y')[1]);
  const aluR = at.get('alu')![0] + g(ALU).w;
  alignY('dm', DM, aluR + 18, 'addr', P('alu', 'y')[1]);
  alignY('res', M4, aluR + 18 + g(DM).w + (dcache ? 18 : 10), 'd1', P('dm', 'rd')[1]); // a cache's stall / hit labels need room
  place('plus4', P4, [27, Y - 10]);
  alignY('target', ADD, rfR + 18, 'a', Y + 24);
  place('gndT', TIE0, [P('target', 'cin')[0] - 7, P('target', 'cin')[1] - 5]);
  alignY('clr0', CLEAR_BIT0, aluR + 12, 'in', Y + 18);
  place('gndJ', TIE0, [P('clr0', 'zero')[0] - 6, P('clr0', 'zero')[1] + 1]);
  place('ctl', CONTROL, [8, 0]);
  place('npc', NEXT_PC, [62, 0]);

  const labels: Record<string, string> = { pcmux: 'next PC', pc: 'PC', srcA: 'SrcA', srcB: 'SrcB', res: 'result', target: 'PC + imm' };
  const instances: InstanceDef[] = [...at.keys()].map((name) => ({ name, def: defs.get(name)!, at: at.get(name), label: labels[name] }));

  const pcq = P('pc', 'q');
  const aluY = P('alu', 'y');
  const immY = P('imm', 'imm');
  const bottom = Y + 38;
  const resY = P('res', 'y');
  const clkVia: Record<string, [number, number][]> = {};
  for (const u of ['pc', 'rf', 'dm']) clkVia[`${u}.clk`] = [[P(u, 'clk')[0], bottom]];
  const nets: NetDef[] = [
    // fetch
    { name: 'PCNext', ends: ['pcmux.y', 'pc.d'] },
    { name: 'en', ends: ['one.y', 'pc.en'] },
    { name: 'PC', ends: ['pc.q', 'imem.addr', 'plus4.a', 'srcA.b', 'target.a', 'pcOut'], trunk: pcq[0] + 3, tags: ['srcA.b', 'target.a', 'pcOut'] },
    { name: 'PCPlus4', ends: ['plus4.y', 'pcmux.d0', 'pcmux.d3', 'res.d2'], tags: true },
    { name: 'PCTarget', ends: ['target.s', 'pcmux.d1'], tags: true },
    { name: 'JalrTarget', ends: ['clr0.out', 'pcmux.d2'], tags: true },
    { name: 'PCSrc', ends: ['npc.pcSrc', 'pcmux.s'], tags: true },
    // decode
    { name: 'Instr', ends: ['imem.data', 'si.in', 'imm.instr', 'instrOut'], trunk: 43, tags: ['instrOut'] },
    { name: 'op', ends: ['si.o0', 'ctl.op'], tags: true },
    { name: 'rd', ends: ['si.o1', 'rf.wa'] },
    { name: 'funct3', ends: ['si.o2', 'ctl.funct3', 'npc.funct3'], tags: true },
    { name: 'rs1', ends: ['si.o3', 'rf.ra1'], trunk: 55 },
    { name: 'rs2', ends: ['si.o4', 'rf.ra2'], trunk: 56.5 },
    { name: 'funct7', ends: ['si.o5', 'ctl.funct7'], tags: true },
    { name: 'ImmExt', ends: ['imm.imm', 'srcB.b', 'target.b', 'res.d3'], trunk: immY[0] + 3, tags: ['res.d3'] },
    // execute
    { name: 'rd1', ends: ['rf.rd1', 'srcA.a'] },
    { name: 'WriteData', ends: ['rf.rd2', 'srcB.a', 'dm.wd'], trunk: rfR + 2.5, tags: ['dm.wd'] },
    { name: 'SrcA', ends: ['srcA.y', 'alu.a'] },
    { name: 'SrcB', ends: ['srcB.y', 'alu.b'] },
    {
      name: 'ALUResult', ends: ['alu.y', 'dm.addr', 'res.d0', 'clr0.in', 'aluOut'], trunk: aluY[0] + 9, tags: ['aluOut'],
      via: { 'res.d0': [[aluY[0] + 9, aluY[1] - 8], [P('res', 'd0')[0] - 3, aluY[1] - 8], [P('res', 'd0')[0] - 3, P('res', 'd0')[1]]] },
    },
    { name: 'ReadData', ends: ['dm.rd', 'res.d1'] },
    {
      name: 'Result', ends: ['res.y', 'rf.wd'],
      via: { 'rf.wd': [[resY[0] + 3, resY[1]], [resY[0] + 3, bottom - 4], [58, bottom - 4], [58, P('rf', 'wd')[1]]] },
    },
    { name: 'gndT', ends: ['gndT.y', 'target.cin'], via: { 'target.cin': [[P('target', 'cin')[0], P('gndT', 'y')[1]]] } },
    { name: 'gndJ', ends: ['gndJ.y', 'clr0.zero'], via: { 'clr0.zero': [[P('clr0', 'zero')[0], P('gndJ', 'y')[1]]] } },
    { name: 'clk', ends: ['clk', 'pc.clk', 'rf.clk', 'dm.clk'], via: clkVia },
    // control, as net labels
    { name: 'RegWrite', ends: ['ctl.regWrite', 'rf.we'], tags: true },
    { name: 'ImmSrc', ends: ['ctl.immSrc', 'imm.src'], tags: true },
    { name: 'ALUSrcA', ends: ['ctl.aluSrcA', 'srcA.s'], tags: true },
    { name: 'ALUSrcB', ends: ['ctl.aluSrcB', 'srcB.s'], tags: true },
    { name: 'MemWrite', ends: ['ctl.memWrite', 'dm.we'], tags: true },
    { name: 'ResultSrc', ends: ['ctl.resultSrc', 'res.s'], tags: true },
    { name: 'Branch', ends: ['ctl.branch', 'npc.branch'], tags: true },
    { name: 'Jump', ends: ['ctl.jump', 'npc.jump'], tags: true },
    { name: 'Jalr', ends: ['ctl.jalr', 'npc.jalr'], tags: true },
    { name: 'ALUControl', ends: ['ctl.aluCtl', 'alu.ctl'], tags: true },
    { name: 'Zero', ends: ['alu.zero', 'npc.zero'], tags: true },
    { name: 'Neg', ends: ['alu.neg', 'npc.neg'], tags: true },
    { name: 'Ovf', ends: ['alu.ovf', 'npc.ovf'], tags: true },
    { name: 'Carry', ends: ['alu.carry', 'npc.carry'], tags: true },
  ];

  const pins: Record<string, [number, number]> = { clk: [0, bottom], pcOut: [resY[0] + 22, bottom - 8], instrOut: [resY[0] + 22, bottom - 5], aluOut: [resY[0] + 22, bottom - 2] };
  if (dcache || icache) {
    // a load (ResultSrc = 01) or, with an I-cache, a fetch that misses stalls the PC and the register
    // write until the line arrives. The extra gates sit in a strip below the datapath, lined up so that
    // neighbours connect with straight wires.
    const add = (name: string, def: ComponentDef, xy: [number, number]) => instances.push({ name, def, at: xy });
    const xs = aluR - 12, y0 = bottom + 10;
    if (dcache) {
      add('rsplit', splitter([1, 1]), [xs, y0]);
      add('nr1', NOT, [xs + 5, y0 + 2]);
      add('isLoad', AND, [xs + 12, y0]);
    }
    add('rwg', AND, [52, bottom - 8]);
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    const net = (name: string) => nets.find((n) => n.name === name)!;
    nets.splice(nets.indexOf(net('en')), 1);
    net('RegWrite').ends = ['ctl.regWrite', 'rwg.a'];
    if (icache) {
      // while the fetch misses, the instruction is not valid: hold back its data-memory request too
      add('ivalid', NOT, [xs + 12, y0 + 10]);
      add('weg', AND, [xs + 20, y0 + 10]);
      net('MemWrite').ends = ['ctl.memWrite', 'weg.b'];
      net('clk').ends.push('imem.clk');
      nets.push(
        { name: 'instrValid', ends: ['ivalid.y', 'weg.a', ...(dcache ? ['reg.b'] : [])], tags: dcache ? ['reg.b'] : undefined },
        { name: 'MemWriteQ', ends: ['weg.y', 'dm.we'], tags: true },
        { name: 'ihit', ends: ['imem.hit', 'ihit'], tags: true },
      );
      if (dcache) add('reg', AND, [xs + 24, y0 + 1]);
      pins.ihit = [resY[0] + 22, bottom + 7];
    }
    // stall = the data cache's, the instruction cache's, or either
    const both = dcache && icache;
    if (both) add('anyStall', OR, [xs + 12, y0 + 18]);
    add('nstall', NOT, both ? [xs + 20, y0 + 19] : [xs + 20, y0 + 18]);
    if (both) {
      nets.push(
        { name: 'dstall', ends: ['dm.stall', 'anyStall.a'], tags: true },
        { name: 'istall', ends: ['imem.stall', 'anyStall.b', 'ivalid.a'], tags: true },
        { name: 'stall', ends: ['anyStall.y', 'nstall.a'] },
      );
    } else if (dcache) nets.push({ name: 'stall', ends: ['dm.stall', 'nstall.a'], tags: true });
    else nets.push({ name: 'istall', ends: ['imem.stall', 'nstall.a', 'ivalid.a'], tags: true });
    if (dcache) {
      net('ResultSrc').ends.push('rsplit.in');
      nets.push(
        { name: 'rs0', ends: ['rsplit.o0', 'isLoad.a'] },
        { name: 'rs1', ends: ['rsplit.o1', 'nr1.a'] },
        { name: '¬rs1', ends: ['nr1.y', 'isLoad.b'] },
        ...(icache
          ? [{ name: 'MemRead', ends: ['isLoad.y', 'reg.a'] }, { name: 'MemReadQ', ends: ['reg.y', 'dm.re'], tags: true as const }]
          : [{ name: 'MemRead', ends: ['isLoad.y', 'dm.re'], tags: true as const }]),
        { name: 'dhit', ends: ['dm.hit', 'dhit'], tags: true },
      );
      pins.dhit = [resY[0] + 22, bottom + 4];
    }
    nets.push(
      { name: 'retire', ends: ['nstall.y', 'pc.en', 'rwg.b', 'retire'], tags: ['pc.en', 'rwg.b', 'retire'] },
      { name: 'RegWriteQ', ends: ['rwg.y', 'rf.we'], tags: true },
    );
    pins.retire = [resY[0] + 22, bottom + 1];
  }
  if (fpu) pins.retire = [resY[0] + 22, bottom + 1];
  if (fpu) {
    // ---- RV32F subset: a second register file, the FPU, and a few multiplexers
    const add = (name: string, def: ComponentDef, xy: [number, number], label?: string) => instances.push({ name, def, at: xy, label });
    const rfAt = at.get('rf')!, rfR = rfAt[0] + g(RF).w;
    const FRF = regfile(5, 32, false, 3);
    add('frf', FRF, [rfAt[0], bottom + 10], 'f registers');
    add('fpu', FPU32, [rfR + 24, bottom + 14], 'FPU');
    add('fdec', FP_DECODE, [8, bottom + 10]);
    add('fwd', M2, [rfAt[0] - 18, bottom + 14], 'mem / FPU');
    const mg = g(M2), xresAt: [number, number] = [resY[0] + 10, resY[1] - 6];
    add('xres', M2, xresAt, 'ALU / FPU');
    add('swd', M2, [rfR + 4, bottom - 6], 'x / f store');
    // x-register write enable: (RegWrite AND NOT flw) OR toInt OR isCSR, then AND retire; each gate's
    // output on the next one's input row
    const yw = bottom - 10;
    add('nflw', NOT, [30, yw]);
    add('rwx', AND, [38, yw - 2]);
    add('rwi', orN(3), [48, yw - 1]);
    add('fcsr', FCSR, [rfR + 24, bottom + 62], 'fcsr');
    add('sr3', splitter([2, 5]), [rfAt[0] - 6, bottom + 40]);
    add('cres', M2, [xresAt[0] + mg.w + 10, xresAt[1] + mg.ports.y.pos[1] - mg.ports.a.pos[1]], 'FP / CSR');
    // fdiv.s / fsqrt.s stall: the PC and every register write wait for the iterative unit
    if (dcache) throw new Error('singleCycleCpu: fpu and dcache together are not supported');
    add('nstall', NOT, [20, yw + 6]);
    add('xwg', AND, [60, yw + 1]);
    add('fwg', AND, [rfAt[0] - 6, bottom + 6]);
    add('fpg', AND, [rfR + 18, bottom + 58]);
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    const net = (name: string) => nets.find((n) => n.name === name)!;
    nets.splice(nets.indexOf(net('en')), 1);
    net('op').ends = ['si.o0', 'fdec.op', 'fpu.op'];
    nets.push({ name: 'opInt', ends: ['fdec.opInt', 'ctl.op'], tags: true });
    net('op').ends.push('fcsr.op');
    net('rs1').ends.push('frf.ra1', 'fcsr.rs1');
    net('rs2').ends.push('frf.ra2', 'fpu.rs2', 'fcsr.rs2');
    net('rd').ends.push('frf.wa');
    net('funct7').ends.push('fpu.funct7', 'fdec.funct7', 'fcsr.funct7', 'sr3.in');
    net('funct3').ends.push('fpu.funct3', 'fcsr.funct3');
    net('rd1').ends.push('fpu.xa', 'fcsr.xa');
    (net('rd1') as NetDef).tags = ['fpu.xa', 'fcsr.xa'];
    const wdn = net('WriteData');
    wdn.ends = wdn.ends.filter((e) => e !== 'dm.wd').concat('swd.a');
    wdn.tags = ['swd.a'];
    net('ReadData').ends.push('fwd.a');
    const res = net('Result');
    res.ends = ['res.y', 'xres.a'];
    res.via = undefined;
    net('RegWrite').ends = ['ctl.regWrite', 'rwx.a'];
    net('clk').ends.push('frf.clk', 'fcsr.clk', 'fpu.clk');
    nets.push(
      { name: 'frs1', ends: ['frf.rd1', 'fpu.a'], tags: true },
      { name: 'frs2', ends: ['frf.rd2', 'fpu.b', 'swd.b'], tags: true },
      { name: 'StoreData', ends: ['swd.y', 'dm.wd'], tags: true },
      { name: 'FPUResult', ends: ['fpu.y', 'xres.b', 'fwd.b'], tags: true },
      { name: 'FWriteData', ends: ['fwd.y', 'frf.wd'], tags: true },
      { name: 'XResult0', ends: ['xres.y', 'cres.a'] },
      { name: 'CSRData', ends: ['fcsr.rdata', 'cres.b'], tags: true },
      { name: 'isCSR', ends: ['fcsr.hit', 'cres.s', 'rwi.i2'], tags: true },
      { name: 'XResult', ends: ['cres.y', 'rf.wd'], tags: true },
      { name: 'FFlags', ends: ['fpu.flags', 'fcsr.flags'], tags: true },
      { name: 'isOPFP', ends: ['fdec.opfp', 'fpu.go'], tags: true },
      { name: 'FPOp', ends: ['fdec.fpOp', 'fpg.a'], tags: true },
      { name: 'rs3', ends: ['sr3.o1', 'frf.ra3'], tags: true },
      { name: 'frs3', ends: ['frf.rd3', 'fpu.c'], tags: true },
      { name: 'FFlagsWE', ends: ['fpg.y', 'fcsr.fpOp'], tags: true },
      { name: 'stall', ends: ['fpu.stall', 'nstall.a'], tags: true },
      { name: 'retire', ends: ['nstall.y', 'pc.en', 'xwg.b', 'fwg.b', 'fpg.b', 'retire'], tags: ['pc.en', 'xwg.b', 'fwg.b', 'fpg.b', 'retire'] },
      { name: 'frm', ends: ['fcsr.frm', 'fpu.frm'], tags: true },
      { name: 'isFLW', ends: ['fdec.flw', 'fwd.s', 'nflw.a'], tags: true },
      { name: 'isFSW', ends: ['fdec.fsw', 'swd.s'], tags: true },
      { name: 'toInt', ends: ['fdec.toInt', 'xres.s', 'rwi.i1'], tags: true },
      { name: 'FRegWrite', ends: ['fdec.fWrite', 'fwg.a'], tags: true },
      { name: 'FRegWriteQ', ends: ['fwg.y', 'frf.we'], tags: true },
      { name: '¬flw', ends: ['nflw.y', 'rwx.b'] },
      { name: 'RegWriteInt', ends: ['rwx.y', 'rwi.i0'] },
      { name: 'XRegWrite', ends: ['rwi.y', 'xwg.a'] },
      { name: 'XRegWriteQ', ends: ['xwg.y', 'rf.we'], tags: true },
    );
    // fwd: a = ReadData? the FPU result is the common case, the memory word only for flw
    nets.find((n) => n.name === 'ReadData')!.ends = nets.find((n) => n.name === 'ReadData')!.ends.map((e) => (e === 'fwd.a' ? 'fwd.b' : e));
    nets.find((n) => n.name === 'FPUResult')!.ends = ['fpu.y', 'xres.b', 'fwd.a'];
  }
  const extraPorts: PortDef[] = [];
  if (shared) {
    // ---- a core of the multi-core: memory goes through ports; atomics; hart id
    const add = (name: string, def: ComponentDef, xy: [number, number], label?: string) => instances.push({ name, def, at: xy, label });
    const dmAt = at.get('dm')!;
    instances.splice(instances.findIndex((i) => i.name === 'dm'), 1);
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    add('mpd', MP_DECODE, [8, bottom + 10]);
    add('amux', M2, [dmAt[0], dmAt[1]], 'address: ALU / rs1');
    add('amoadd', ADD, [dmAt[0] + 14, bottom + 10], 'old + rs2');
    add('gndA', TIE0, [dmAt[0] + 8, bottom + 6]);
    add('wmux', M2, [dmAt[0] + 14, dmAt[1] + 22], 'store / amoadd');
    add('rsplit', splitter([1, 1]), [aluR + 4, bottom - 12]);
    add('nr1', NOT, [aluR + 8, bottom - 10]);
    add('isLoad', AND, [aluR + 13, bottom - 12]);
    add('req', OR, [aluR + 20, bottom - 12]);
    add('weo', OR, [aluR + 20, bottom - 6]);
    add('weg', AND, [aluR + 26, bottom - 6]);
    add('ngr', NOT, [aluR + 20, bottom]);
    add('stl', AND, [aluR + 26, bottom]);
    add('nstall', NOT, [8, P('pc', 'en')[1] - 1]);
    add('rwg', AND, [52, bottom - 8]);
    add('rwh', OR, [56, bottom - 2]);
    add('hmux', M2, [resY[0] + 6, resY[1] - 6], 'result / hart id');
    const net = (name: string) => nets.find((n) => n.name === name)!;
    const drop = (n: NetDef, e: string) => { n.ends = n.ends.filter((x) => x !== e); if (Array.isArray(n.tags)) n.tags = n.tags.filter((x) => x !== e); };
    nets.splice(nets.indexOf(net('en')), 1);
    drop(net('ALUResult'), 'dm.addr'); net('ALUResult').ends.push('amux.a');
    drop(net('WriteData'), 'dm.wd'); net('WriteData').ends.push('wmux.a', 'amoadd.b');
    const clkN = net('clk');
    drop(clkN, 'dm.clk');
    if (clkN.via) delete clkN.via['dm.clk'];
    net('ReadData').ends = ['memRData', 'res.d1', 'amoadd.a'];
    net('MemWrite').ends = ['ctl.memWrite', 'weo.a', 'req.b'];
    net('op').ends = ['si.o0', 'mpd.op'];
    net('funct3').ends.push('mpd.funct3');
    net('funct7').ends.push('mpd.funct7');
    net('rs1').ends.push('mpd.rs1');
    net('rs2').ends.push('mpd.rs2');
    net('rd1').ends.push('amux.b');
    net('ResultSrc').ends.push('rsplit.in');
    net('RegWrite').ends = ['ctl.regWrite', 'rwg.a'];
    const res = net('Result');
    res.ends = ['res.y', 'hmux.a'];
    res.via = undefined;
    nets.push(
      { name: 'opInt', ends: ['mpd.opInt', 'ctl.op'], tags: true },
      { name: 'isAMO', ends: ['mpd.isAMO', 'amux.s', 'weo.b'], tags: true },
      { name: 'amoAdd', ends: ['mpd.amoAdd', 'wmux.s'], tags: true },
      { name: 'isHart', ends: ['mpd.isHart', 'hmux.s', 'rwh.b'], tags: true },
      { name: 'gndA', ends: ['gndA.y', 'amoadd.cin'] },
      { name: 'amoSum', ends: ['amoadd.s', 'wmux.b'], tags: true },
      { name: 'memAddr', ends: ['amux.y', 'memAddr'], tags: true },
      { name: 'memWData', ends: ['wmux.y', 'memWData'], tags: true },
      { name: 'rs0', ends: ['rsplit.o0', 'isLoad.a'], tags: true },
      { name: 'rs1bit', ends: ['rsplit.o1', 'nr1.a'], tags: true },
      { name: '¬rs1', ends: ['nr1.y', 'isLoad.b'], tags: true },
      { name: 'MemRead', ends: ['isLoad.y', 'req.a'], tags: true },
      { name: 'memReq', ends: ['req.y', 'memReq', 'stl.a'], tags: true },
      { name: 'wantWrite', ends: ['weo.y', 'weg.a'], tags: true },
      { name: 'grant', ends: ['grant', 'weg.b', 'ngr.a'], tags: true },
      { name: 'memWE', ends: ['weg.y', 'memWE'], tags: true },
      { name: '¬grant', ends: ['ngr.y', 'stl.b'], tags: true },
      { name: 'stall', ends: ['stl.y', 'nstall.a'], tags: true },
      { name: 'retire', ends: ['nstall.y', 'pc.en', 'rwg.b', 'retire'], tags: ['rwg.b', 'retire'] },
      { name: 'RegWriteQ', ends: ['rwg.y', 'rwh.a'], tags: true },
      { name: 'XRegWrite', ends: ['rwh.y', 'rf.we'], tags: true },
      { name: 'hartid', ends: ['hartid', 'hmux.b'], tags: true },
      { name: 'XResult', ends: ['hmux.y', 'rf.wd'], tags: true },
    );
    const ox = resY[0] + 22;
    Object.assign(pins, { hartid: [0, bottom + 6], memRData: [0, bottom + 9], grant: [0, bottom + 12], memAddr: [ox, bottom + 1], memWData: [ox, bottom + 4], memWE: [ox, bottom + 7], memReq: [ox, bottom + 10], retire: [ox, bottom + 13] });
    if (imemPort) {
      // the program comes from outside (an instruction memory macro in a real chip)
      instances.splice(instances.findIndex((i) => i.name === 'imem'), 1);
      drop(net('PC'), 'imem.addr');
      const ins = net('Instr');
      ins.ends = ['instr', ...ins.ends.filter((e) => e !== 'imem.data')];
      pins.instr = [0, bottom + 15];
      extraPorts.push(bus('instr', 32, 'in'));
    }
    extraPorts.push(bus('hartid', 32, 'in'), bus('memRData', 32, 'in'), bit('grant', 'in'),
      bus('memAddr', 32, 'out'), bus('memWData', 32, 'out'), bit('memWE', 'out'), bit('memReq', 'out'), bit('retire', 'out'));
  }
  return {
    id: imemPort ? 'rv32i_core' : key2(IM) + (adder === 'ks' ? '_ks' : '') + (dcache ? `_dc${dcache === true ? '' : dcache}${dmemK}` : dmemK !== 5 && !shared ? `_d${dmemK}` : '') + (icache ? '_ic' : '') + (fpu ? '_fp' : '') + (shared ? '_core' : ''), name: `Single-cycle RV32I${fpu ? 'F' : ''} CPU${adder === 'ks' ? ' (fast adders)' : ''}${dcache ? ` with a ${dcache === true ? '' : 'write-back '}data cache` : ''}${icache ? `${dcache ? ' and' : ' with'} an instruction cache` : ''}`, category: 'cpu',
    summary: dcache === 'wb' || dcache === 'wb2'
      ? `The single-cycle processor with its data memory behind a ${dcache === 'wb2' ? '2-way set-associative' : 'direct-mapped'} write-back cache. Loads and stores that miss hold the PC and the register write (retire = 0): 8 cycles, or 12 when a dirty line must be written back first.`
      : dcache
      ? 'The single-cycle processor with its data memory replaced by a slow main memory behind a 64-byte direct-mapped cache. A load that misses holds the PC and the register write (retire = 0) for 8 cycles while the line is fetched.'
      : 'A complete RISC-V processor: every instruction is fetched, decoded, executed and retired in one clock cycle. Built entirely from the blocks of the previous chapters.',
    ports: [bit('clk', 'in', 'left', true), bus('pcOut', 32, 'out'), bus('instrOut', 32, 'out'), bus('aluOut', 32, 'out'), ...(dcache || icache ? [bit('retire', 'out')] : []), ...(dcache ? [bit('dhit', 'out')] : []), ...(icache ? [bit('ihit', 'out')] : []), ...(fpu ? [bit('retire', 'out')] : []), ...extraPorts],
    symbol: { kind: 'box', label: shared ? 'CORE' : dcache ? 'RV32I + D$' : 'RV32I' },
    netlist: () => ({ pins, instances, nets }),
    hdl: { verilog: CPU_VERILOG },
  };
}

const CPU_VERILOG = `// Structure of the processor (cf. primer hdl/rv_single.sv, extended to all of RV32I)
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
endmodule`;

function key2(IM: ComponentDef): string {
  return `rv32i_${IM.id.replace(/^rom_/, '')}`;
}

