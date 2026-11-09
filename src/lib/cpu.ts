// Level 7: a single-cycle RV32I processor, built only from the parts of the earlier levels.
// Every instruction completes in one clock cycle: fetch, decode, execute, memory and
// write-back all happen in the combinational logic between two rising edges.
//
// Implemented: all of RV32I except byte/halfword loads & stores, FENCE, ECALL, EBREAK.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { IMM_SRC } from '../riscv/isa';
import { rowsKey, signalsOf, SLOT_CODE, type CustomRow } from '../riscv/custom';
import { alu, constWord, orN } from './alu';
import { koggeStone } from './fastadd';
import { andN, busMux2, incrementer, muxTree, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { ram } from './memory';
import { cachedMemory } from './cache';
import { iCache, wbCache } from './cache2';
import type { DramConfig } from '../dram/controller';
import { cfgKey } from './dramctrl';
import { FCSR, FPU32, FP_DECODE } from './fpu';
import { VECTOR_UNIT, VEC_LANES, VEC_VLEN, vecMemory } from './vector';
import { MP_DECODE } from './mpdecode';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { C_EXPAND, cFetch, PLUS2OR4 } from './rvc';
import { macParts } from './macslot';

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
      notes: `Simulated as a lookup table for speed. Its structure (shown when you open it) is the real circuit: a ${N}:1 multiplexer tree of 32-bit words whose inputs are wired to the program\'s bits.`,
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

/** Recognises the opcode classes: one 5-input AND per class on true/complement rails. `extra`: more classes
 *  (a custom instruction's: name and opcode[6:2]); without them, the nine of RV32I (OPCODE_DECODER). */
export function opcodeDecoder(extra: readonly [string, number][] = []): ComponentDef {
  const classes: [string, number][] = [...CLASSES, ...extra];
  const key = extra.length ? `opdec_${extra.map(([n, c]) => `${n}_${c}`).join('_')}` : 'opdec';
  return memo(key, () => {
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
    classes.forEach(([name, code], k) => {
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
      id: key,
      name: extra.length ? `Opcode decoder (+ ${extra.map(([nm]) => nm.replace(/^cx_/, '')).join(', ')})` : 'Opcode decoder', category: 'cpu',
      summary: `Which kind of instruction is this? One AND gate per instruction class matches opcode[6:2] (bits 1:0 are always 11)${extra.length ? `; ${extra.length} custom class${extra.length > 1 ? 'es' : ''} on the free slots` : ''}.`,
      ports: [bus('op', 7, 'in'), ...classes.map(([nm]) => bit(nm, 'out'))],
      symbol: { kind: 'box', label: 'OPCODE' },
      netlist: () => ({ pins, instances, nets }),
    });
  });
}

/** The nine RV32I opcode classes. */
export const OPCODE_DECODER: ComponentDef = opcodeDecoder();

/** Control unit: opcode classes → datapath control signals (OR gates), plus the ALU decoder. `custom`: custom
 *  instructions (riscv/custom.ts), each one more opcode class and an OR input on every signal its row asserts. */
export function control(custom: readonly CustomRow[] = [], mac = false): ComponentDef {
  return memo(`${custom.length ? `control_cx${rowsKey(custom)}` : 'control'}${mac ? '_mac' : ''}`, () => buildControl(custom, mac));
}

/** What a control unit is drawn as: three blocks after the opcode decoder. `layout` is the drawing of the signals block (a crossbar: class rails
 *  down the page, one OR gate per signal), found by a search over the router's own crossing count; classes and signals the lists leave out
 *  (custom rows, the MAC) go after them. A drawing only: no gate, wire or name differs from a flat unit. */
export interface CtlLayout {
  rails: string[]; gates: string[]; pinY: Record<string, number>;
  /** merger y and pin pitch */
  imm: [number, number]; res: [number, number];
}
const CTL_LAYOUT: CtlLayout = {
  rails: ['BRANCH', 'R', 'I', 'AUIPC', 'JAL', 'LUI', 'JALR', 'STORE', 'LOAD'],
  gates: ['regWrite', 'resSrc0', 'aluSrcB', 'resSrc1', 'immSrc0', 'immSrc1', 'aluOp'],
  pinY: { regWrite: 6, immSrc: 40, aluSrcA: 11, aluSrcB: 23, memWrite: 17, resultSrc: 14, branch: 2, jump: 31, jalr: 25, aluOp: 50 },
  imm: [28, 2], res: [17, 3],
};
/** Place in `order`; names it leaves out follow, in their own order. */
const rankIn = (order: readonly string[], name: string, all: readonly string[]) => { const k = order.indexOf(name); return k >= 0 ? k : order.length + all.filter((n) => !order.includes(n)).indexOf(name); };

/** mac: the MAC core's custom-2 class (chapter "A MAC on the RV32"): racc writes a register and picks result input 4, and `macEn` lets the unit's accumulator change.
 *  Exported for the layout search (tests, scripts): `lay` overrides the signals block's drawing, `tag` makes its ids distinct. */
export function buildControl(custom: readonly CustomRow[], mac = false, lay: CtlLayout = CTL_LAYOUT, tag = ''): ComponentDef {
  if (mac && custom.some((r) => r.slot === 2)) throw new Error('control: custom-2 belongs to the MAC');
  const key = `${custom.length ? `control_cx${rowsKey(custom)}` : 'control'}${mac ? '_mac' : ''}${tag}`;
  const cx = custom.map((r) => ({ row: r, cls: `cx_${r.name.replace(/[^\w]/g, '_')}`, sigs: new Set(signalsOf(r)) }));
  const macClass: [string, number][] = mac ? [['MAC', SLOT_CODE[2]]] : [];
  const D = opcodeDecoder([...cx.map((c): [string, number] => [c.cls, SLOT_CODE[c.row.slot]]), ...macClass]);
  const classes: [string, number][] = [...CLASSES, ...cx.map((c): [string, number] => [c.cls, SLOT_CODE[c.row.slot]]), ...macClass];
  const classNames = classes.map(([c]) => c);
  const by = (sig: string) => cx.filter((c) => c.sigs.has(sig)).map((c) => c.cls);
  type Sig = { name: string; from: string[] };
  const sigs: Sig[] = [
    { name: 'regWrite', from: ['R', 'I', 'LOAD', 'JAL', 'JALR', 'LUI', 'AUIPC', ...by('regWrite'), ...(mac ? ['macRd'] : [])] },
    { name: 'aluSrcB', from: ['I', 'LOAD', 'STORE', 'JALR', 'AUIPC', ...by('aluSrcB')] },
    { name: 'resSrc0', from: ['LOAD', 'LUI', ...by('resSrc0')] },
    { name: 'resSrc1', from: ['JAL', 'JALR', 'LUI', ...by('resSrc1')] },
    { name: 'immSrc0', from: ['STORE', 'LUI', 'AUIPC', ...by('immSrc0')] },
    { name: 'immSrc1', from: ['BRANCH', 'LUI', 'AUIPC', ...by('immSrc1')] },
    { name: 'aluOp', from: ['R', 'I', ...by('aluOp')] },
  ];
  // A signal one class drives straight through; a custom class that asserts it too turns it into an OR.
  const direct: [string, string][] = [];
  for (const [sig, c] of [['aluSrcA', 'AUIPC'], ['memWrite', 'STORE'], ['branch', 'BRANCH'], ['jump', 'JAL'], ['jalr', 'JALR'], ['immSrc2', 'JAL']] as [string, string][]) {
    const more = by(sig);
    if (more.length) sigs.push({ name: sig, from: [c, ...more] });
    else direct.push([sig, c]);
  }
  const subs = by('alt');
  const ALT = subs.length ? orN(2 + subs.length) : OR;
  const altIn = ALT.ports.filter((p) => p.dir === 'in').map((p) => p.name);
  const outs = ['regWrite', 'immSrc', 'aluSrcA', 'aluSrcB', 'memWrite', 'resultSrc', 'branch', 'jump', 'jalr'];

  // ---- the signals block: class lines in, one OR gate per signal ------------------------------------------------------------
  const SG = (() => {
    const N = classes.length;
    const sc = splitter(ones(N), 3), scg = symbolGeom(sc);
    const railNames = [...classNames, ...(mac ? ['macRd'] : [])];
    const rail = (k: number) => 3 + scg.w + 4 + 3 * k;
    const railOf = (n: string) => rail(rankIn(lay.rails, n, railNames));
    const XO = rail(railNames.length) + 4;
    const instances: InstanceDef[] = [{ name: 'sc', def: sc, at: [3, 0] }];
    const nets: NetDef[] = [{ name: 'cls', ends: ['cls', 'sc.in'] }];
    const ends = new Map<string, string[]>(classNames.map((n, i) => [n, [`sc.o${i}`]]));
    if (mac) ends.set('macRd', ['macRd', 'mres.i2']);
    const names = sigs.map((x) => x.name);
    const order = sigs.slice().sort((a, b) => rankIn(lay.gates, a.name, names) - rankIn(lay.gates, b.name, names));
    let y = 2;
    const gateOut = new Map<string, string>();
    for (const s of order) {
      const g = s.from.length === 2 ? OR : orN(s.from.length), gg = symbolGeom(g);
      const ins = g.ports.filter((p) => p.dir === 'in').map((p) => p.name);
      instances.push({ name: `g_${s.name}`, def: g, at: [XO, y] });
      s.from.forEach((c, i) => ends.get(c)!.push(`g_${s.name}.${ins[i]}`));
      gateOut.set(s.name, `g_${s.name}.y`);
      y += gg.h + 2;
    }
    const yBelow = y + 1;
    const mimm = merger([1, 1, 1], lay.imm[1]), mres = merger(mac ? [1, 1, 1] : [1, 1], lay.res[1]);
    instances.push({ name: 'mimm', def: mimm, at: [XO + 40, lay.imm[0]] }, { name: 'mres', def: mres, at: [XO + 40, lay.res[0]] });
    for (const [sig, c] of direct) gateOut.set(sig, `sc.o${classNames.indexOf(c)}`);
    // racc's wire (a rail of its own) enters regWrite's OR, then runs under the gates and up the lane before the merger into resultSrc
    const macVia = mac ? { 'mres.i2': [[railOf('macRd'), yBelow], [XO + 38, yBelow], [XO + 38, lay.res[0] + symbolGeom(mres).ports.i2.pos[1]]] as [number, number][] } : undefined;
    for (const [c, e] of ends) if (e.length > 1) nets.push({ name: c, ends: e, trunk: railOf(c), ...(c === 'macRd' ? { via: macVia } : {}) });
    nets.push(
      { name: 'immSrc0', ends: [gateOut.get('immSrc0')!, 'mimm.i0'] }, { name: 'immSrc1', ends: [gateOut.get('immSrc1')!, 'mimm.i1'] },
      { name: 'immSrc2', ends: [gateOut.get('immSrc2')!, 'mimm.i2'] }, { name: 'immSrc', ends: ['mimm.out', 'immSrc'] },
      { name: 'resSrc0', ends: [gateOut.get('resSrc0')!, 'mres.i0'] }, { name: 'resSrc1', ends: [gateOut.get('resSrc1')!, 'mres.i1'] },
      { name: 'resultSrc', ends: ['mres.out', 'resultSrc'] }, { name: 'aluOp', ends: [gateOut.get('aluOp')!, 'aluOp'] },
    );
    for (const s of ['regWrite', 'aluSrcB', 'aluSrcA', 'memWrite', 'branch', 'jump', 'jalr']) nets.push({ name: s, ends: [gateOut.get(s)!, s] });
    // a direct signal's wire is the class line's own: one net
    const byDriver = new Map<string, NetDef>(), merged: NetDef[] = [];
    for (const n of nets) {
      const prev = byDriver.get(n.ends[0]);
      if (prev && n.ends[0].startsWith('sc.')) { prev.ends.push(...n.ends.slice(1)); continue; }
      byDriver.set(n.ends[0], n);
      merged.push(n);
    }
    const OX = XO + 50;
    const pins: Record<string, [number, number]> = { cls: [0, 4], ...(mac ? { macRd: [0, yBelow + 2] } : {}) };
    for (const o of [...outs, 'aluOp']) pins[o] = [OX, lay.pinY[o] ?? 2];
    return define({
      id: `${key}_signals`, name: 'Control signals', category: 'cpu',
      summary: 'One OR gate per datapath signal over the instruction classes that assert it; a signal one class alone asserts is that class line itself. The ALU control has its own block.',
      ports: [
        bus('cls', N, 'in'), ...(mac ? [bit('macRd', 'in')] : []),
        bit('regWrite', 'out'), bus('immSrc', 3, 'out'), bit('aluSrcA', 'out'), bit('aluSrcB', 'out'),
        bit('memWrite', 'out'), bus('resultSrc', mac ? 3 : 2, 'out'), bit('branch', 'out'), bit('jump', 'out'),
        bit('jalr', 'out'), bit('aluOp', 'out', 'bottom'),
      ],
      symbol: { kind: 'box', label: 'SIGNALS' },
      netlist: () => ({ pins, instances, nets: merged }),
    });
  })();

  // ---- the ALU decoder: ctl[2:0] = aluOp ? funct3 : 0; ctl[3] = aluOp & f7b5 & (R | f3 == 101) | BRANCH (| a subtracting custom class) -----
  const AD = (() => {
    const altH = symbolGeom(ALT).h, X = 14, ya = 0;
    const instances: InstanceDef[] = [
      { name: 'sf3', def: splitter([1, 1, 1]), at: [4, ya] },
      { name: 'sf7', def: splitter([5, 1, 1]), at: [4, ya + 8] },
      { name: 'a0', def: AND, at: [X, ya] },
      { name: 'a1', def: AND, at: [X, ya + 5] },
      { name: 'a2', def: AND, at: [X, ya + 10] },
      { name: 'nf1', def: NOT, at: [X + 6, ya + 16] },
      { name: 'is101', def: andN(3), at: [X + 11, ya + 14] },
      { name: 'shR', def: OR, at: [X + 18, ya + 15] },
      { name: 'alt1', def: andN(3), at: [X + 25, ya + 13] },
      { name: 'alt', def: ALT, at: [X + 32, ya + 17 - altH / 2] },
      { name: 'mctl', def: merger([1, 1, 1, 1], 4), at: [X + 40, 2] },
    ];
    const altY = ya + 17 - altH / 2 + symbolGeom(ALT).ports[altIn[1]].pos[1];
    const nets: NetDef[] = [
      { name: 'f3', ends: ['funct3', 'sf3.in'] }, { name: 'f7', ends: ['funct7', 'sf7.in'] },
      { name: 'aluOp', ends: ['aluOp', 'a0.a', 'a1.a', 'a2.a', 'alt1.i0'], trunk: X - 2 },
      { name: 'R', ends: ['R', 'shR.a'] },
      // the inputs from below run under the gates and up a lane of their own into the OR
      { name: 'BRANCH', ends: ['BRANCH', `alt.${altIn[1]}`], via: { [`alt.${altIn[1]}`]: [[X + 30, 24], [X + 30, altY]] } },
      ...subs.map((c, i) => ({ name: c, ends: [c, `alt.${altIn[2 + i]}`], via: { [`alt.${altIn[2 + i]}`]: [[X + 30.5 + 0.5 * i, 31 + 3 * i], [X + 30.5 + 0.5 * i, ya + 17 - altH / 2 + symbolGeom(ALT).ports[altIn[2 + i]].pos[1]]] as [number, number][] } })),
      { name: 'f3_0', ends: ['sf3.o0', 'a0.b', 'is101.i0'] }, { name: 'f3_1', ends: ['sf3.o1', 'a1.b', 'nf1.a'] }, { name: 'f3_2', ends: ['sf3.o2', 'a2.b', 'is101.i2'] },
      { name: 'nf3_1', ends: ['nf1.y', 'is101.i1'] }, { name: 'f7b5', ends: ['sf7.o1', 'alt1.i1'] },
      { name: 'is101', ends: ['is101.y', 'shR.b'] }, { name: 'shR', ends: ['shR.y', 'alt1.i2'] }, { name: 'alt1', ends: ['alt1.y', `alt.${altIn[0]}`] },
      { name: 'c0', ends: ['a0.y', 'mctl.i0'] }, { name: 'c1', ends: ['a1.y', 'mctl.i1'] }, { name: 'c2', ends: ['a2.y', 'mctl.i2'] }, { name: 'c3', ends: ['alt.y', 'mctl.i3'] },
      { name: 'aluCtl', ends: ['mctl.out', 'aluCtl'] },
    ];
    return define({
      id: `${key}_alu`, name: 'ALU control decoder', category: 'cpu',
      summary: 'ctl[2:0] = funct3 for the instructions that use the ALU as such (aluOp), else 000 (an address add); ctl[3] = funct7[5] where it means subtract or arithmetic shift (R-type, or funct3 = 101), forced for a branch.',
      ports: [bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), bit('aluOp', 'in', 'top'), bit('R', 'in'), bit('BRANCH', 'in'), ...subs.map((c) => bit(c, 'in')), bus('aluCtl', 4, 'out')],
      symbol: { kind: 'box', label: 'ALU CTL' },
      netlist: () => ({ pins: { funct3: [0, 1.5], funct7: [0, 11], aluOp: [0, -4], R: [0, 28], BRANCH: [0, 24], ...Object.fromEntries(subs.map((c, i) => [c, [0, 31 + 3 * i]])), aluCtl: [X + 50, 4] }, instances, nets }),
    });
  })();

  // ---- the MAC's decode: custom-2 is a MAC instruction only with funct7 = 0 and funct3 < 4 (anything else does nothing, as the golden model): macEn, and racc = funct3 11
  const MD = mac ? define({
    id: `${key}_mac`, name: 'MAC decode', category: 'cpu',
    summary: 'custom-2 is a MAC instruction only with funct7 = 0 and funct3 < 4: macEn lets the accumulator change; racc (funct3 = 011) writes a register.',
    ports: [bit('MAC', 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), bit('macEn', 'out'), bit('macRd', 'out')],
    symbol: { kind: 'box', label: 'MAC DEC' },
    netlist: () => ({
      pins: { MAC: [0, -2], funct3: [0, 1.5], funct7: [0, 11], macEn: [40, 4], macRd: [40, 8] },
      instances: [
        { name: 'mf3', def: splitter([1, 1, 1]), at: [4, 0] },
        { name: 'mf7', def: splitter([1, 1, 1, 1, 1, 1, 1]), at: [4, 8] },
        { name: 'mor', def: orN(7), at: [14, 8] },
        { name: 'mbad', def: OR, at: [22, 10] },
        { name: 'mok', def: NOT, at: [28, 11] },
        { name: 'mv', def: AND, at: [33, 10] },
        { name: 'misr', def: AND, at: [33, 16] },
        { name: 'mrd', def: AND, at: [41, 12] },
      ],
      nets: [
        { name: 'f3', ends: ['funct3', 'mf3.in'] }, { name: 'f7', ends: ['funct7', 'mf7.in'] }, { name: 'MAC', ends: ['MAC', 'mv.a'] },
        { name: 'f3_0', ends: ['mf3.o0', 'misr.a'] }, { name: 'f3_1', ends: ['mf3.o1', 'misr.b'] }, { name: 'f3_2', ends: ['mf3.o2', 'mbad.b'], via: { 'mbad.b': [[12, 5], [12, 23], [20, 23], [20, 13]] } },
        { name: 'mbad', ends: ['mor.y', 'mbad.a'] }, { name: 'mnz', ends: ['mbad.y', 'mok.a'] }, { name: 'mok', ends: ['mok.y', 'mv.b'] },
        { name: 'macEn', ends: ['mv.y', 'mrd.a', 'macEn'] }, { name: 'mis3', ends: ['misr.y', 'mrd.b'] }, { name: 'macRd', ends: ['mrd.y', 'macRd'] },
        ...Array.from({ length: 7 }, (_, i) => ({ ends: [`mf7.o${i}`, `mor.i${i}`] })),
      ],
    }),
  }) : null;

  // ---- the top: decoder → class lines (a bus) → signals; the ALU decoder and the MAC's beside ------------------------------------
  const dg = symbolGeom(D), sgg = symbolGeom(SG), adg = symbolGeom(AD);
  const mcls = merger(ones(classes.length), 2), mg = symbolGeom(mcls);
  const instances: InstanceDef[] = [
    { name: 'dec', def: D, at: [4, 0] },
    { name: 'mcls', def: mcls, at: [dg.w + 10, dg.ports[classes[0][0]].pos[1] - mg.ports.i0.pos[1]] },
    { name: 'sig', def: SG, at: [dg.w + 24, 0] },
  ];
  const adY = Math.max(dg.h, sgg.h) + 6;
  instances.push({ name: 'aludec', def: AD, at: [dg.w + 24, adY] });
  const mdY = adY + adg.h + 6;
  if (MD) instances.push({ name: 'macdec', def: MD, at: [dg.w + 24, mdY] });
  const nets: NetDef[] = [{ name: 'op', ends: ['op', 'dec.op'] }];
  classes.forEach(([c], i) => nets.push({
    name: c, ends: [`dec.${c}`, `mcls.i${i}`, ...(c === 'R' || c === 'BRANCH' || subs.includes(c) ? [`aludec.${c}`] : []), ...(c === 'MAC' ? ['macdec.MAC'] : [])],
  }));
  nets.push(
    { name: 'cls', ends: ['mcls.out', 'sig.cls'] },
    { name: 'f3', ends: ['funct3', 'aludec.funct3', ...(mac ? ['macdec.funct3'] : [])] },
    { name: 'f7', ends: ['funct7', 'aludec.funct7', ...(mac ? ['macdec.funct7'] : [])] },
    { name: 'aluOp', ends: ['sig.aluOp', 'aludec.aluOp'] },
    { name: 'aluCtl', ends: ['aludec.aluCtl', 'aluCtl'] },
    ...(mac ? [{ name: 'macRd', ends: ['macdec.macRd', 'sig.macRd'] }, { name: 'macEn', ends: ['macdec.macEn', 'macEn'] }] : []),
  );
  for (const o of outs) nets.push({ name: o, ends: [`sig.${o}`, o] });
  const OX = dg.w + 24 + sgg.w + 12;
  const pins: Record<string, [number, number]> = { op: [0, dg.ports.op.pos[1]], funct3: [dg.w + 12, adY + adg.ports.funct3.pos[1]], funct7: [dg.w + 14, adY + adg.ports.funct7.pos[1]] };
  outs.forEach((o, i) => (pins[o] = [OX, sgg.ports[o].pos[1] + (i % 2 ? 0 : 0)]));
  pins.aluCtl = [OX, adY + adg.ports.aluCtl.pos[1]];
  if (mac) pins.macEn = [OX, mdY + symbolGeom(MD!).ports.macEn.pos[1]];
  const customRows = custom.map((r) => {
    const res = r.regWrite ? { alu: 'ALU', mem: 'mem', pc4: 'PC+4', imm: 'imm' }[r.result] : '–';
    return `<tr><td>${r.name} (custom-${r.slot})</td><td>${r.regWrite ? 1 : 0}</td><td>${r.fmt}</td><td>${r.srcA === 'pc' ? 'PC' : 'rs1'}</td><td>${r.srcB}</td><td>${r.memWrite ? 1 : 0}</td><td>${res}</td></tr>`;
  }).join('');
  return define({
    id: key,
    name: custom.length || mac ? `Control unit (+ ${[...custom.map((r) => r.name), ...(mac ? ['MAC'] : [])].join(', ')})` : 'Control unit', category: 'cpu',
    summary: `Turns the instruction's opcode and function fields into the switch settings for the datapath: which mux inputs to pick, whether to write a register or memory, which ALU operation.${custom.length ? ` With ${custom.map((r) => r.name).join(', ')}: one more opcode class each, ORed into the signals its row asserts.` : ''}${mac ? ' With the MAC: custom-2 is one more class; racc writes a register and takes the result mux\'s fifth input, and macEn lets mac, mac2 and clracc change the accumulator.' : ''}`,
    ports: [
      bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'),
      bit('regWrite', 'out'), bus('immSrc', 3, 'out'), bit('aluSrcA', 'out'), bit('aluSrcB', 'out'),
      bit('memWrite', 'out'), bus('resultSrc', mac ? 3 : 2, 'out'), bit('branch', 'out'), bit('jump', 'out'),
      bit('jalr', 'out'), bus('aluCtl', 4, 'out'), ...(mac ? [bit('macEn', 'out')] : []),
    ],
    symbol: { kind: 'box', label: 'CONTROL' },
    netlist: () => ({ pins, instances, nets }),
    notes: `<table><tr><th>class</th><th>RegW</th><th>ImmSrc</th><th>SrcA</th><th>SrcB</th><th>MemW</th><th>Result</th></tr>
      <tr><td>R</td><td>1</td><td>–</td><td>rs1</td><td>rs2</td><td>0</td><td>ALU</td></tr>
      <tr><td>I</td><td>1</td><td>I</td><td>rs1</td><td>imm</td><td>0</td><td>ALU</td></tr>
      <tr><td>LOAD</td><td>1</td><td>I</td><td>rs1</td><td>imm</td><td>0</td><td>mem</td></tr>
      <tr><td>STORE</td><td>0</td><td>S</td><td>rs1</td><td>imm</td><td>1</td><td>–</td></tr>
      <tr><td>BRANCH</td><td>0</td><td>B</td><td>rs1</td><td>rs2</td><td>0</td><td>–</td></tr>
      <tr><td>JAL</td><td>1</td><td>J</td><td>–</td><td>–</td><td>0</td><td>PC+4</td></tr>
      <tr><td>JALR</td><td>1</td><td>I</td><td>rs1</td><td>imm</td><td>0</td><td>PC+4</td></tr>
      <tr><td>LUI</td><td>1</td><td>U</td><td>–</td><td>–</td><td>0</td><td>imm</td></tr>
      <tr><td>AUIPC</td><td>1</td><td>U</td><td>PC</td><td>imm</td><td>0</td><td>ALU</td></tr>${customRows}${mac ? '<tr><td>racc (custom-2)</td><td>1</td><td>R</td><td>rs1</td><td>–</td><td>0</td><td>MAC</td></tr><tr><td>mac, mac2, clracc</td><td>0</td><td>R</td><td>rs1</td><td>rs2</td><td>0</td><td>–</td></tr>' : ''}</table>`,
  });
}

/** The control unit of RV32I. */
export const CONTROL: ComponentDef = control();


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
  /** With dcache 'wb' / 'wb2': main memory is a DRAM controller and device of this geometry (chapter memctrl), not a fixed latency. */
  dram?: DramConfig;
  /** Fetch through an 8-line instruction cache in front of the ROM (fetch misses stall). */
  icache?: boolean;
  /** Add the floating-point register file, the FPU and fcsr (RV32F of chapter float). */
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
  /** Custom instructions (riscv/custom.ts): the control unit gains an opcode class per row. */
  custom?: readonly CustomRow[];
  /**
   * The C extension (chapter widths): the ROM read at any even address through two halfword banks and the expander
   * (lib/rvc.ts cFetch), PC + 2 after a 16-bit instruction. Not with the caches, the FPU or a shared memory.
   */
  c?: boolean;
  /**
   * The MAC (chapter "A MAC on the RV32"): mac, mac2, clracc and racc on custom-2 (riscv/isa.ts MAC_INSTRS), the unit of lib/macunit.ts beside the ALU
   * with its accumulator, the result mux's fifth input, and `accOut`. Not with the caches, the FPU, a shared memory or the C extension; custom rows
   * keep custom-1 and custom-3 (custom-2 is the MAC's).
   */
  mac?: boolean;
  /**
   * The vector unit (chapter vectors, lib/vector.ts): four lanes, VLEN 128, the RVV subset of ISS({ v: { vlen: 128, gates: true } });
   * the data memory becomes four word-interleaved banks (vecMemory), and the core gains `retire` (low while a vector
   * instruction runs its beats). Not with the caches, the FPU, a shared memory, the C extension, the MAC or custom rows.
   */
  vector?: { lanes: 4; vlen: 128 };
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
  const IM = opts.c ? cFetch(program, opts.imemK ?? 6) : rom(program, opts.imemK ?? 6);
  const adder = opts.adder ?? 'rca';
  const key = `cpu1_${IM.id}_${opts.dmemK ?? 5}_${adder}${opts.dcache ? `_dc${opts.dcache === true ? '' : opts.dcache}` : ''}${opts.fpu ? '_fp' : ''}${opts.shared ? '_mp' : ''}${opts.imemPort ? '_ip' : ''}${opts.icache ? '_ic' : ''}${opts.dram ? `_dram${cfgKey(opts.dram)}` : ''}${opts.custom?.length ? `_cx${rowsKey(opts.custom)}` : ''}${opts.c ? '_c' : ''}${opts.mac ? '_mac' : ''}${opts.vector ? '_v' : ''}`;
  if (opts.vector && (opts.vector.lanes !== VEC_LANES || opts.vector.vlen !== VEC_VLEN)) throw new Error(`singleCycleCpu: the vector unit is built with ${VEC_LANES} lanes and VLEN ${VEC_VLEN}`);
  return memo(key, () => buildCpu(IM, opts.dmemK ?? 5, adder, opts.dcache ?? false, !!opts.fpu, !!opts.shared, !!opts.imemPort, !!opts.icache, opts.imemK ?? 6, opts.dram, opts.custom ?? [], !!opts.c, !!opts.mac, !!opts.vector));
}

function buildCpu(IM: ComponentDef, dmemK: number, adder: 'rca' | 'ks', dcache: boolean | 'wb' | 'wb2' = false, fpu = false, shared = false, imemPort = false, icache = false, imemK = 6, dram?: DramConfig, custom: readonly CustomRow[] = [], c = false, mac = false, vector = false): ComponentDef {
  if (vector && (c || dcache || icache || fpu || shared || mac || custom.length)) throw new Error('singleCycleCpu: vector with a cache, the FPU, a shared memory, the C extension, the MAC or custom rows is not supported');
  if (mac && (c || dcache || icache || fpu || shared)) throw new Error('singleCycleCpu: mac with a cache, the FPU, a shared memory or the C extension is not supported');
  if (mac && custom.some((r) => r.slot === 2)) throw new Error('singleCycleCpu: custom-2 is the MAC\'s: a custom row may use custom-1 or custom-3');
  if (c && (dcache || icache || fpu || (shared && !imemPort))) throw new Error('singleCycleCpu: c with a cache, the FPU or a shared memory is not supported');
  if (dram && dcache !== 'wb' && dcache !== 'wb2') throw new Error('singleCycleCpu: dram needs a write-back data cache');
  if (icache && (fpu || shared)) throw new Error('singleCycleCpu: icache with fpu or shared is not supported');
  const IMEM = icache ? iCache(IM, 3, imemK) : IM;
  const PC = register(32), RF = regfile(5, 32), ALU = alu(32, adder), DM = dcache === 'wb' ? wbCache(dmemK, 2, 1, dram) : dcache === 'wb2' ? wbCache(dmemK, 1, 2, dram) : dcache ? cachedMemory(dmemK) : vector ? vecMemory(dmemK) : dataMemory(dmemK);
  const M2 = busMux2(32), M4 = muxTree(2, 32), RES = mac ? muxTree(3, 32) : M4, ADD = adder === 'ks' ? koggeStone(32) : rca(32), SI = splitter([7, 5, 3, 5, 5, 7]);
  const P4 = c ? PLUS2OR4 : adder === 'ks' ? PLUS4_FAST : PLUS4;
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
  const dx = c && !shared ? 6 : 0; // the C fetch unit's wider box pushes the decode columns right
  alignY('pcmux', M4, 2, 'y', Y);
  alignY('pc', PC, 12, 'd', Y);
  place('one', TIE1, [8, P('pc', 'en')[1] - 1]);
  const pcY = P('pc', 'q')[1];
  alignY('imem', IMEM, 27, 'addr', pcY);
  const instrY = P('imem', 'data')[1];
  alignY('si', SI, 45 + dx, 'in', instrY);
  alignY('rf', RF, 62 + dx, 'wa', P('si', 'o1')[1]);
  alignY('imm', IMM_GEN, 60 + dx, 'instr', Y + 18);
  const rfR = at.get('rf')![0] + g(RF).w;
  alignY('srcA', M2, rfR + 8, 'a', P('rf', 'rd1')[1]);
  alignY('srcB', M2, rfR + 8, 'a', P('rf', 'rd2')[1] + 9);
  alignY('alu', ALU, rfR + 18, 'a', P('srcA', 'y')[1]);
  const aluR = at.get('alu')![0] + g(ALU).w;
  // The plain core is drawn with wires: control below the datapath (selects take their signal from below), each signal
  // on its own row and the farthest lowest, feedback over the top and along the bottom. Variants keep their pointers.
  const wired = !(icache && dcache) && !(imemPort && c) && !vector;
  const dmX = aluR + (wired ? 24 : 18);
  alignY('dm', DM, dmX, 'addr', P('alu', 'y')[1]);
  alignY('res', RES, dmX + g(DM).w + (dcache ? 18 : 10), 'd1', P('dm', 'rd')[1]); // a cache's stall / hit labels need room
  place('plus4', P4, [27, Y - 10]);
  alignY('target', ADD, rfR + 18, 'a', Y + 24);
  place('gndT', TIE0, wired ? [P('target', 'cin')[0] - 6, P('target', 'cin')[1] - 1] : [P('target', 'cin')[0] - 7, P('target', 'cin')[1] - 5]);
  alignY('clr0', CLEAR_BIT0, aluR + 12, 'in', Y + 18);
  place('gndJ', TIE0, [P('clr0', 'zero')[0] - 6, P('clr0', 'zero')[1] + 1]);
  place('ctl', custom.length || mac ? control(custom, mac) : CONTROL, wired ? [30, 78] : [8, 0]);
  if (mac) {
    // below the ALU, clear of the control rows: fed by both read ports, its result is the mux's fifth input
    const mp = macParts();
    place('macu', mp.unit, [rfR + 18, 104]);
    place('shamt', mp.cut(32, 0, 6), [rfR + 8, 100]);
    place('f3op', mp.cut(3, 0, 2), [rfR + 8, 110]);
  }
  place('npc', NEXT_PC, wired ? [dmX + 8, 44] : [62, 0]);

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
    ...(c ? [{ name: 'C', ends: ['imem.c', 'plus4.c'], tags: true as const }] : []),
    { name: 'PCTarget', ends: ['target.s', 'pcmux.d1'], tags: true },
    { name: 'JalrTarget', ends: ['clr0.out', 'pcmux.d2'], tags: true },
    { name: 'PCSrc', ends: ['npc.pcSrc', 'pcmux.s'], tags: true },
    // decode
    { name: 'Instr', ends: ['imem.data', 'si.in', 'imm.instr', 'instrOut'], trunk: 43 + dx, tags: ['instrOut'] },
    { name: 'op', ends: ['si.o0', 'ctl.op'], tags: true },
    { name: 'rd', ends: ['si.o1', 'rf.wa'] },
    { name: 'funct3', ends: ['si.o2', 'ctl.funct3', 'npc.funct3', ...(mac ? ['f3op.a'] : [])], tags: true },
    { name: 'rs1', ends: ['si.o3', 'rf.ra1'], trunk: 55 + dx },
    { name: 'rs2', ends: ['si.o4', 'rf.ra2'], trunk: 56.5 + dx },
    { name: 'funct7', ends: ['si.o5', 'ctl.funct7'], tags: true },
    { name: 'ImmExt', ends: ['imm.imm', 'srcB.b', 'target.b', 'res.d3'], trunk: immY[0] + 3, tags: ['res.d3'] },
    // execute
    { name: 'rd1', ends: ['rf.rd1', 'srcA.a', ...(mac ? ['macu.a', 'shamt.a'] : [])] },
    { name: 'WriteData', ends: ['rf.rd2', 'srcB.a', 'dm.wd', ...(mac ? ['macu.b'] : [])], trunk: rfR + 2.5, tags: ['dm.wd'] },
    { name: 'SrcA', ends: ['srcA.y', 'alu.a'] },
    { name: 'SrcB', ends: ['srcB.y', 'alu.b'] },
    {
      name: 'ALUResult', ends: ['alu.y', 'dm.addr', 'res.d0', 'clr0.in', 'aluOut'], trunk: aluY[0] + 9, tags: ['aluOut'],
      via: { 'res.d0': [[aluY[0] + 9, aluY[1] - 8], [P('res', 'd0')[0] - 3, aluY[1] - 8], [P('res', 'd0')[0] - 3, P('res', 'd0')[1]]] },
    },
    { name: 'ReadData', ends: ['dm.rd', 'res.d1'] },
    {
      name: 'Result', ends: ['res.y', 'rf.wd'],
      via: { 'rf.wd': [[resY[0] + 3, resY[1]], [resY[0] + 3, bottom - 4], [58 + dx, bottom - 4], [58 + dx, P('rf', 'wd')[1]]] },
    },
    { name: 'gndT', ends: ['gndT.y', 'target.cin'], via: { 'target.cin': [[P('target', 'cin')[0], P('gndT', 'y')[1]]] } },
    { name: 'gndJ', ends: ['gndJ.y', 'clr0.zero'], via: { 'clr0.zero': [[P('clr0', 'zero')[0], P('gndJ', 'y')[1]]] } },
    { name: 'clk', ends: ['clk', 'pc.clk', 'rf.clk', 'dm.clk', ...(mac ? ['macu.clk'] : [])], via: clkVia },
    ...(mac ? [
      { name: 'shift', ends: ['shamt.y', 'macu.sh'] },
      { name: 'macOp', ends: ['f3op.y', 'macu.op'] },
      { name: 'MacEn', ends: ['ctl.macEn', 'macu.en'], tags: true as const },
      { name: 'MacOut', ends: ['macu.y', 'res.d4', 'res.d5', 'res.d6', 'res.d7'] }, // inputs 4 to 7 all read the unit (5 to 7 are never selected): one trunk beside the mux, not four routes
      { name: 'accOut', ends: ['macu.acc', 'accOut'], tags: true as const },
    ] : []),
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
  if (mac) {
    const mo = nets.find((n) => n.name === 'MacOut')!, my = P('macu', 'y'), tx = P('res', 'd0')[0] - 1.5;
    mo.via = Object.fromEntries(['d4', 'd5', 'd6', 'd7'].map((d) => [`res.${d}`, [[tx, my[1]], [tx, P('res', d)[1]]] as [number, number][]]));
  }
  if (wired) {
    const rows = (name: string, via: NonNullable<NetDef['via']>, tags?: string[]) => {
      const n = nets.find((x) => x.name === name)!;
      n.via = { ...n.via, ...via };
      delete n.trunk;
      if (tags) n.tags = tags;
      else delete n.tags;
    };
    const [px, py] = P('plus4', 'y');
    const up = (name: string, port: string, end: string, lane: number, ...more: [number, number][]) =>
      rows(name, { [end]: [[lane, P('ctl', port)[1]], ...more] });
    // feedback: PC + 4 over the top, the targets along the bottom, into the next-PC mux's left side
    rows('PCPlus4', {
      'pcmux.d0': [[px + 2, py], [px + 2, 24], [-2, 24], [-2, P('pcmux', 'd0')[1]]],
      'pcmux.d3': [[px + 2, py], [px + 2, 24], [-2, 24], [-2, P('pcmux', 'd3')[1]]],
      'res.d2': [[px + 2, py], [px + 2, 24], [P('res', 'd2')[0] - 4.5, 24], [P('res', 'd2')[0] - 4.5, P('res', 'd2')[1]]],
    });
    rows('PCTarget', { 'pcmux.d1': [[P('target', 's')[0] + 2, P('target', 's')[1]], [P('target', 's')[0] + 2, 68], [-0.5, 68], [-0.5, P('pcmux', 'd1')[1]]] });
    rows('JalrTarget', { 'pcmux.d2': [[P('clr0', 'out')[0] + 1, P('clr0', 'out')[1]], [P('clr0', 'out')[0] + 1, 69], [0.5, 69], [0.5, P('pcmux', 'd2')[1]]] });
    rows('PCSrc', { 'pcmux.s': [[resY[0], P('npc', 'pcSrc')[1]], [resY[0], 72], [P('pcmux', 's')[0], 72]] });
    // the PC's other readers, over the register file; the store data the same way
    const pcRow = c ? 25 : 30.5; // over the register file, and over +2/4 where the C fetch lifts the file
    rows('PC', {
      'srcA.b': [[pcq[0] + 3, pcq[1]], [pcq[0] + 3, pcRow], [rfR + 5, pcRow], [rfR + 5, P('srcA', 'b')[1]]],
      'target.a': [[pcq[0] + 3, pcq[1]], [pcq[0] + 3, pcRow], [rfR + 5, pcRow], [rfR + 5, P('target', 'a')[1]]],
    }, ['pcOut']);
    rows('WriteData', { 'dm.wd': [[rfR + 2.5, P('rf', 'rd2')[1]], [rfR + 2.5, 30], [dmX - 3, 30], [dmX - 3, P('dm', 'wd')[1]]] });
    // the instruction's fields to control, down past the datapath and in from the left
    const lane = (o: string, x: number, row: number, into: string, left: number) =>
      [[x, P('si', o)[1]], [x, row], [left, row], [left, P('ctl', into)[1]]] as [number, number][];
    rows('op', { 'ctl.op': lane('o0', 48 + dx, 75.5, 'op', 28) });
    rows('funct3', {
      'ctl.funct3': lane('o2', 49.5 + dx, 76.5, 'funct3', 27),
      'npc.funct3': [[49.5 + dx, P('si', 'o2')[1]], [49.5 + dx, 71], [P('npc', 'funct3')[0] - 7, 71], [P('npc', 'funct3')[0] - 7, P('npc', 'funct3')[1]]],
    });
    rows('funct7', { 'ctl.funct7': lane('o5', 51 + dx, 77.5, 'funct7', 26) });
    // control: each signal straight out of its port, then up to its unit
    up('RegWrite', 'regWrite', 'rf.we', 59.5 + dx, [59.5 + dx, P('rf', 'we')[1]]);
    up('ImmSrc', 'immSrc', 'imm.src', P('imm', 'src')[0]);
    up('ALUSrcA', 'aluSrcA', 'srcA.s', rfR + 6.5, [rfR + 6.5, P('srcA', 's')[1] + 2.5], [P('srcA', 's')[0], P('srcA', 's')[1] + 2.5]);
    up('ALUSrcB', 'aluSrcB', 'srcB.s', P('srcB', 's')[0]);
    up('MemWrite', 'memWrite', 'dm.we', dmX - 4, [dmX - 4, P('dm', 'we')[1]]);
    up('ResultSrc', 'resultSrc', 'res.s', P('res', 's')[0]);
    up('Branch', 'branch', 'npc.branch', P('npc', 'branch')[0] - 6, [P('npc', 'branch')[0] - 6, P('npc', 'branch')[1]]);
    up('Jump', 'jump', 'npc.jump', P('npc', 'jump')[0] - 5, [P('npc', 'jump')[0] - 5, P('npc', 'jump')[1]]);
    up('Jalr', 'jalr', 'npc.jalr', P('npc', 'jalr')[0] - 4, [P('npc', 'jalr')[0] - 4, P('npc', 'jalr')[1]]);
    up('ALUControl', 'aluCtl', 'alu.ctl', P('target', 'a')[0] - 1.5, [P('target', 'a')[0] - 1.5, P('alu', 'ctl')[1] + 2], [P('alu', 'ctl')[0], P('alu', 'ctl')[1] + 2]);
    for (const n of nets) if (['RegWrite', 'ImmSrc', 'ALUSrcA', 'ALUSrcB', 'MemWrite', 'ResultSrc', 'Branch', 'Jump', 'Jalr', 'ALUControl', 'Zero', 'Neg', 'Ovf', 'Carry', 'PCSrc', 'C', 'op', 'funct3', 'funct7'].includes(n.name!)) n.quiet = true;
    // the tie in line with a pin on the adder's left; the ripple adder's is on top, clear of the ALUControl lane
    const cinTop = g(ADD).ports.cin.exit === 'up';
    if (cinTop) at.set('gndT', [P('target', 'cin')[0] - 4, P('target', 'cin')[1] - 3]);
    const tie = nets.find((n) => n.name === 'gndT')!;
    instances.find((i) => i.name === 'gndT')!.at = at.get('gndT');
    if (cinTop) tie.via = { 'target.cin': [[P('target', 'cin')[0], P('gndT', 'y')[1]]] };
    else delete tie.via;
    // a cache is wider than the memory: its clock comes round the next-PC unit under it
    if (P('dm', 'clk')[0] > P('npc', 'zero')[0]) clkVia['dm.clk'] = [[P('npc', 'zero')[0] - 1, bottom], [P('npc', 'zero')[0] - 1, P('dm', 'clk')[1] + 0.5], [P('dm', 'clk')[0], P('dm', 'clk')[1] + 0.5]];
    // the register file's clock passes beside the immediate generator, which sits under it
    const immR = at.get('imm')![0] + g(IMM_GEN).w;
    clkVia['rf.clk'] = [[immR + 1, bottom], [immR + 1, P('rf', 'clk')[1] + 2], [P('rf', 'clk')[0], P('rf', 'clk')[1] + 2]];
    if (c) rows('C', { 'plus4.c': [[P('imem', 'c')[0] + 1, P('imem', 'c')[1]], [P('imem', 'c')[0] + 1, 31.5], [P('plus4', 'c')[0], 31.5]] });
    // the ALU's flags, nested so that they do not cross each other
    ([['Zero', 'zero', 108.5], ['Neg', 'neg', 107], ['Ovf', 'ovf', 105.5], ['Carry', 'carry', 104]] as const).forEach(([name, port, x0]) => { const x = x0 + dx;
      rows(name, { [`npc.${port}`]: [[x, P('alu', port)[1]], [x, P('npc', port)[1]]] }); });
  }

  const pins: Record<string, [number, number]> = { clk: [0, bottom], pcOut: [resY[0] + 22, bottom - 8], instrOut: [resY[0] + 22, bottom - 5], aluOut: [resY[0] + 22, bottom - 2], ...(mac ? { accOut: [resY[0] + 22, bottom + 1] } : {}) };
  if (dcache || icache) {
    // a load (ResultSrc = 01) or, with an I-cache, a fetch that misses stalls the PC and the register
    // write until the line arrives. The extra gates sit in a strip below the datapath, lined up so that
    // neighbours connect with straight wires.
    const add = (name: string, def: ComponentDef, xy: [number, number]) => instances.push({ name, def, at: xy });
    const xs = aluR - 12, y0 = wired ? 102 : bottom + 10;
    if (dcache) {
      add('rsplit', splitter([1, 1]), [xs, y0]);
      add('nr1', NOT, [xs + 5, y0 + 2]);
      add('isLoad', AND, [xs + 12, y0]);
    }
    add('rwg', AND, wired ? [54, 75] : [52, bottom - 8]);
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    const net = (name: string) => nets.find((n) => n.name === name)!;
    nets.splice(nets.indexOf(net('en')), 1);
    net('RegWrite').ends = ['ctl.regWrite', 'rwg.a'];
    if (icache) {
      // while the fetch misses, the instruction is not valid: hold back its data-memory request too
      add('ivalid', NOT, wired ? [xs + 2, y0] : [xs + 12, y0 + 10]);
      add('weg', AND, wired ? [xs + 10, y0] : [xs + 20, y0 + 10]);
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
    add('nstall', NOT, wired ? (dcache ? [dmX + 21, 37] : [xs + 2, y0 + 6]) : both ? [xs + 20, y0 + 19] : [xs + 20, y0 + 18]);
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
    if (wired) {
      // the strip sits under the control rows; the stall chain is drawn with wires: the stall beside the cache, retire
      // along the bottom to the PC's enable, the register write gate under the control block's first row
      const net = (name: string) => nets.find((n) => n.name === name)!;
      const Q = (inst: string, port: string): [number, number] => {
        const i = instances.find((x) => x.name === inst)!;
        const p = g(i.def).ports[port].pos;
        return [i.at![0] + p[0], i.at![1] + p[1]];
      };
      const wire = (name: string, via: NonNullable<NetDef['via']>) => { const n = net(name); n.via = { ...n.via, ...via }; delete n.tags; n.quiet = true; };
      const ctlY = (port: string) => P('ctl', port)[1];
      const hx = dmX + 23, rx = dmX + 25.5;
      delete net('RegWrite').via?.['rf.we'];
      wire('RegWrite', { 'rwg.a': [[52, ctlY('regWrite')], [52, Q('rwg', 'a')[1]]] });
      wire('RegWriteQ', { 'rf.we': [[59.5, Q('rwg', 'y')[1]], [59.5, P('rf', 'we')[1]]] });
      if (dcache) {
        wire('retire', {
          'pc.en': [[rx, Q('nstall', 'y')[1]], [rx, 73], [10, 73], [10, P('pc', 'en')[1]]],
          'rwg.b': [[rx, Q('nstall', 'y')[1]], [rx, 73], [52.5, 73], [52.5, Q('rwg', 'b')[1]]],
          retire: [[rx, pins.retire[1]]],
        });
      } else {
        // the instruction cache's gates sit in the strip; its stall comes down the left channel and retire goes back up it
        const ny = Q('nstall', 'y'), under = y0 + 9.5, left = 24;
        pins.retire = [resY[0] + 22, under];
        pins.ihit = [resY[0] + 22, under + 2.5];
        wire('istall', {
          'nstall.a': [[Q('imem', 'stall')[0], 56], [left, 56], [left, Q('nstall', 'a')[1]]],
          'ivalid.a': [[Q('imem', 'stall')[0], 56], [left, 56], [left, Q('nstall', 'a')[1]], [xs, Q('nstall', 'a')[1]], [xs, Q('ivalid', 'a')[1]]],
        });
        wire('instrValid', {});
        wire('MemWriteQ', { 'dm.we': [[dmX - 4, Q('weg', 'y')[1]], [dmX - 4, P('dm', 'we')[1]]] });
        delete net('MemWrite').via?.['dm.we'];
        wire('MemWrite', { 'weg.b': [[xs + 8, ctlY('memWrite')], [xs + 8, Q('weg', 'b')[1]]] });
        wire('ihit', { ihit: [[Q('imem', 'hit')[0], 57], [left - 1.5, 57], [left - 1.5, pins.ihit[1]]] });
        net('clk').via = { ...net('clk').via, 'imem.clk': [[Q('imem', 'clk')[0], bottom]] };
        wire('retire', {
          'pc.en': [[ny[0] + 2, ny[1]], [ny[0] + 2, under], [10, under], [10, P('pc', 'en')[1]]],
          'rwg.b': [[ny[0] + 2, ny[1]], [ny[0] + 2, under], [10, under], [10, 73], [52.5, 73], [52.5, Q('rwg', 'b')[1]]],
          retire: [[ny[0] + 2, pins.retire[1]]],
        });
      }
      if (dcache) {
        wire('stall', {});
        wire('dhit', { dhit: [[hx, P('dm', 'hit')[1]], [hx, pins.dhit[1]]] });
        wire('ResultSrc', { 'rsplit.in': [[xs - 2, ctlY('resultSrc')], [xs - 2, Q('rsplit', 'in')[1]]] });
        wire('MemRead', { 'dm.re': [[dmX - 2, Q('isLoad', 'y')[1]], [dmX - 2, P('dm', 're')[1]]] });
        for (const n of ['rs0', 'rs1', '¬rs1']) wire(n, {});
        // the strip's pins: the stall chain's outputs on the right edge
      }
    }
  }
  if (fpu) pins.retire = [resY[0] + 22, bottom + 1];
  if (fpu) {
    // ---- RV32F subset: a second register file, the FPU, and a few multiplexers. The f registers sit under the integer ones and
    // the FPU beside them (the read ports straight into its operands); the FP decode under the control block, whose field lanes
    // it shares; the fcsr under the FPU. The fields reaching the FPU and the fcsr, the control from the decode, the operands
    // of the integer side and the result coming back stay named pointers.
    const add = (name: string, def: ComponentDef, xy: [number, number], label?: string) => { instances.push({ name, def, at: xy, label }); defs.set(name, def); at.set(name, xy); };
    const rfAt = at.get('rf')!, rfR = rfAt[0] + g(RF).w;
    const FRF = regfile(5, 32, false, 3), gF = g(FRF), gP = g(FPU32), gC = g(FCSR), mg = g(M2);
    const fy = 108; // top of the f registers: under the control block (it ends at 100) and the gates' row
    const frfX = rfAt[0] + 12, fpuX = frfX + gF.w + 14;
    add('frf', FRF, [frfX, fy], 'f registers');
    add('fpu', FPU32, [fpuX, fy + gF.ports.rd1.pos[1] - gP.ports.a.pos[1]], 'FPU');
    add('fcsr', FCSR, [fpuX + 50, P('fpu', 'flags')[1] - gC.ports.flags.pos[1]], 'fcsr');
    add('fdec', FP_DECODE, [30, 104]);
    // x-register write enable: (RegWrite AND NOT flw) OR toInt OR isCSR, then AND retire; a row under the f registers' left edge
    const cy = 101;
    add('nflw', NOT, [60, cy + 1]);
    add('rwx', AND, [67, cy]);
    add('rwi', orN(3), [80, cy - 1]);
    add('xwg', AND, [96, cy]);
    add('sr3', splitter([2, 5]), [52, 100]);
    add('nstall', NOT, [fpuX + 16, P('fpu', 'stall')[1] - 1]);
    add('fwd', M2, [fpuX + 24, P('fpu', 'y')[1] - mg.ports.a.pos[1] - 8], 'mem / FPU');
    add('fwg', AND, [fpuX + 22, P('fpu', 'stall')[1] + 3]);
    add('fpg', AND, [fpuX + 22, P('fpu', 'stall')[1] + 9]);
    // the multiplexers on the result path: ALU / FPU, then FP / CSR, beside the result multiplexer
    const xresAt: [number, number] = [resY[0] + 12, resY[1] - mg.ports.a.pos[1]];
    add('xres', M2, xresAt, 'ALU / FPU');
    add('cres', M2, [xresAt[0] + mg.w + 8, xresAt[1] + mg.ports.y.pos[1] - mg.ports.a.pos[1]], 'FP / CSR');
    add('swd', M2, [dmX - 11, 28], 'x / f store');
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    const net = (name: string) => nets.find((n) => n.name === name)!;
    nets.splice(nets.indexOf(net('en')), 1);
    net('op').ends = ['si.o0', 'fdec.op', 'fpu.op', 'fcsr.op'];
    net('op').tags = ['fpu.op', 'fcsr.op'];
    nets.push({ name: 'opInt', ends: ['fdec.opInt', 'ctl.op'], tags: true });
    net('rs1').ends.push('frf.ra1', 'fcsr.rs1');
    net('rs1').tags = ['fcsr.rs1'];
    net('rs2').ends.push('frf.ra2', 'fpu.rs2', 'fcsr.rs2');
    net('rs2').tags = ['fpu.rs2', 'fcsr.rs2'];
    net('rd').ends.push('frf.wa');
    net('funct7').ends.push('fpu.funct7', 'fdec.funct7', 'fcsr.funct7', 'sr3.in');
    net('funct7').tags = ['fpu.funct7', 'fcsr.funct7'];
    net('funct3').ends.push('fpu.funct3', 'fcsr.funct3');
    net('funct3').tags = ['fpu.funct3', 'fcsr.funct3'];
    net('rd1').ends.push('fpu.xa', 'fcsr.xa');
    net('rd1').tags = ['fpu.xa', 'fcsr.xa'];
    const wdn = net('WriteData');
    wdn.ends = wdn.ends.filter((e) => e !== 'dm.wd').concat('swd.a');
    net('ReadData').ends.push('fwd.b');
    net('ReadData').tags = ['fwd.b'];
    const res = net('Result');
    res.ends = ['res.y', 'xres.a'];
    delete res.via;
    net('RegWrite').ends = ['ctl.regWrite', 'rwx.a'];
    net('clk').ends.push('frf.clk', 'fcsr.clk', 'fpu.clk');
    net('clk').tags = ['frf.clk', 'fcsr.clk', 'fpu.clk'];
    nets.push(
      { name: 'frs1', ends: ['frf.rd1', 'fpu.a'] },
      { name: 'frs2', ends: ['frf.rd2', 'fpu.b', 'swd.b'], tags: ['swd.b'] },
      { name: 'frs3', ends: ['frf.rd3', 'fpu.c'] },
      { name: 'StoreData', ends: ['swd.y', 'dm.wd'] },
      { name: 'FPUResult', ends: ['fpu.y', 'xres.b', 'fwd.a'], tags: ['xres.b'] },
      { name: 'FWriteData', ends: ['fwd.y', 'frf.wd'], tags: true },
      { name: 'XResult0', ends: ['xres.y', 'cres.a'] },
      { name: 'CSRData', ends: ['fcsr.rdata', 'cres.b'], tags: true },
      { name: 'isCSR', ends: ['fcsr.hit', 'cres.s', 'rwi.i2'], tags: ['cres.s', 'rwi.i2'] },
      { name: 'XResult', ends: ['cres.y', 'rf.wd'] },
      { name: 'FFlags', ends: ['fpu.flags', 'fcsr.flags'] },
      { name: 'isOPFP', ends: ['fdec.opfp', 'fpu.go'], tags: true },
      { name: 'FPOp', ends: ['fdec.fpOp', 'fpg.a'], tags: true },
      { name: 'rs3', ends: ['sr3.o1', 'frf.ra3'], tags: true },
      { name: 'FFlagsWE', ends: ['fpg.y', 'fcsr.fpOp'] },
      { name: 'stall', ends: ['fpu.stall', 'nstall.a'] },
      { name: 'retire', ends: ['nstall.y', 'pc.en', 'xwg.b', 'fwg.b', 'fpg.b', 'retire'], tags: ['pc.en', 'xwg.b', 'retire'] },
      { name: 'frm', ends: ['fcsr.frm', 'fpu.frm'] },
      { name: 'isFLW', ends: ['fdec.flw', 'fwd.s', 'nflw.a'], tags: ['fwd.s'] },
      { name: 'isFSW', ends: ['fdec.fsw', 'swd.s'], tags: true },
      { name: 'toInt', ends: ['fdec.toInt', 'xres.s', 'rwi.i1'], tags: ['xres.s'] },
      { name: 'FRegWrite', ends: ['fdec.fWrite', 'fwg.a'], tags: true },
      { name: 'FRegWriteQ', ends: ['fwg.y', 'frf.we'], tags: true },
      { name: '¬flw', ends: ['nflw.y', 'rwx.b'] },
      { name: 'RegWriteInt', ends: ['rwx.y', 'rwi.i0'] },
      { name: 'XRegWrite', ends: ['rwi.y', 'xwg.a'] },
      { name: 'XRegWriteQ', ends: ['xwg.y', 'rf.we'] },
    );
    // fwd: a = ReadData? the FPU result is the common case, the memory word only for flw
    net('FPUResult').ends = ['fpu.y', 'xres.b', 'fwd.a'];
    for (const n of nets) if (['XRegWriteQ', 'XRegWrite', 'RegWriteInt', '¬flw', 'FFlagsWE', 'isFLW', 'isFSW', 'toInt', 'isOPFP', 'FPOp', 'FRegWrite', 'FRegWriteQ', 'stall', 'retire', 'isCSR', 'opInt'].includes(n.name!)) n.quiet = true;
    // ---- wires: the fields down the control block's lanes, the f registers' ports straight into the FPU
    const Qp = (inst: string, port: string) => P(inst, port);
    const setVia = (name: string, via: NonNullable<NetDef['via']>) => { const n = net(name); n.via = { ...n.via, ...via }; };
    const oy = (o: string) => P('si', o)[1];
    setVia('op', { 'fdec.op': [[48 + dx, oy('o0')], [48 + dx, 75.5], [28, 75.5], [28, Qp('fdec', 'op')[1]]] });
    setVia('funct7', {
      'fdec.funct7': [[51 + dx, oy('o5')], [51 + dx, 77.5], [26, 77.5], [26, Qp('fdec', 'funct7')[1]]],
      'sr3.in': [[51 + dx, oy('o5')], [51 + dx, Qp('sr3', 'in')[1]]],
    });
    net('rd').trunk = 53.5 + dx;
    setVia('WriteData', { 'swd.a': [[rfR + 2.5, P('rf', 'rd2')[1]], [rfR + 2.5, 30], [Qp('swd', 'a')[0] - 2, 30], [Qp('swd', 'a')[0] - 2, Qp('swd', 'a')[1]]] });
    setVia('StoreData', { 'dm.wd': [[Qp('swd', 'y')[0] + 2, Qp('swd', 'y')[1]], [Qp('swd', 'y')[0] + 2, P('dm', 'wd')[1]]] });
    delete net('WriteData').via?.['dm.wd'];
    setVia('Result', {});
    setVia('XResult', { 'rf.wd': [[Qp('cres', 'y')[0] + 3, Qp('cres', 'y')[1]], [Qp('cres', 'y')[0] + 3, bottom - 4], [58 + dx, bottom - 4], [58 + dx, P('rf', 'wd')[1]]] });
    setVia('XRegWriteQ', { 'rf.we': [[Qp('xwg', 'y')[0] + 2, Qp('xwg', 'y')[1]], [Qp('xwg', 'y')[0] + 2, 98.5], [59.5 + dx, 98.5], [59.5 + dx, P('rf', 'we')[1]]] });
    setVia('RegWrite', { 'rwx.a': [[52, P('ctl', 'regWrite')[1]], [52, Qp('rwx', 'a')[1]]] });
    delete net('RegWrite').via?.['rf.we'];
  }
  const extraPorts: PortDef[] = [];
  if (vector) {
    // ---- the vector unit under the datapath: it reads the instruction and x[rs1] / x[rs2], writes x[rd] through a
    // multiplexer after the result one, holds the PC (retire) while it runs, and drives the banks' vector port
    const add = (name: string, def: ComponentDef, xy: [number, number], label?: string) => instances.push({ name, def, at: xy, label });
    const net = (name: string) => nets.find((n) => n.name === name)!;
    const tagged = (n: NetDef, ...ends: string[]) => { n.ends.push(...ends); if (Array.isArray(n.tags)) n.tags.push(...ends); else if (!n.tags) n.tags = ends; };
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    nets.splice(nets.indexOf(net('en')), 1);
    add('vu', VECTOR_UNIT, [8, bottom + 10], 'vector unit');
    add('xw', M2, [resY[0] + 6, resY[1] - 6], 'result / vector');
    add('rwo', OR, [56, bottom - 2]);
    tagged(net('Instr'), 'vu.instr');
    tagged(net('rd1'), 'vu.xa', 'dm.vBase');
    tagged(net('WriteData'), 'vu.xb');
    tagged(net('clk'), 'vu.clk');
    const res = net('Result');
    res.ends = ['res.y', 'xw.a'];
    res.via = undefined;
    net('RegWrite').ends = ['ctl.regWrite', 'rwo.a'];
    nets.push(
      { name: 'XResult', ends: ['xw.y', 'rf.wd'], tags: true },
      { name: 'VXData', ends: ['vu.xData', 'xw.b'], tags: true },
      { name: 'VXWrite', ends: ['vu.xWe', 'xw.s', 'rwo.b'], tags: true },
      { name: 'XRegWrite', ends: ['rwo.y', 'rf.we'], tags: true },
      { name: 'retire', ends: ['vu.retire', 'pc.en', 'retire'], tags: true },
      { name: 'vAct', ends: ['vu.vAct', 'dm.vAct'], tags: true },
      { name: 'vBeat', ends: ['vu.vBeat', 'dm.vBeat'], tags: true },
      { name: 'vWe', ends: ['vu.vWe', 'dm.vWe'], tags: true },
      { name: 'vWd', ends: ['vu.vWd', 'dm.vWd'], tags: true },
      { name: 'vRd', ends: ['dm.vRd', 'vu.vRd'], tags: true },
    );
    pins.retire = [resY[0] + 22, bottom + 1];
    extraPorts.push(bit('retire', 'out'));
  }
  if (shared) {
    // ---- a core of the multi-core: memory goes through ports; atomics; hart id
    const add = (name: string, def: ComponentDef, xy: [number, number], label?: string) => instances.push({ name, def, at: xy, label });
    const dmAt = at.get('dm')!;
    instances.splice(instances.findIndex((i) => i.name === 'dm'), 1);
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    add('mpd', MP_DECODE, wired ? [8, 104] : [8, bottom + 10]);
    add('amux', M2, [dmAt[0], dmAt[1]], 'address: ALU / rs1');
    add('amoadd', ADD, wired ? [dmAt[0] + 24, 106] : [dmAt[0] + 14, bottom + 10], 'old + rs2');
    add('gndA', TIE0, wired ? [dmAt[0] + 19, 114] : [dmAt[0] + 8, bottom + 6]);
    add('wmux', M2, wired ? [dmAt[0] + 24, 118] : [dmAt[0] + 14, dmAt[1] + 22], 'store / amoadd');
    add('rsplit', splitter([1, 1]), wired ? [aluR + 4, 104] : [aluR + 4, bottom - 12]);
    add('nr1', NOT, wired ? [aluR + 8, 106] : [aluR + 8, bottom - 10]);
    add('isLoad', AND, wired ? [aluR + 13, 104] : [aluR + 13, bottom - 12]);
    add('req', OR, wired ? [aluR + 30, 104] : [aluR + 20, bottom - 12]);
    add('weo', OR, wired ? [aluR + 20, 110] : [aluR + 20, bottom - 6]);
    add('weg', AND, wired ? [aluR + 30, 110] : [aluR + 26, bottom - 6]);
    add('ngr', NOT, wired ? [aluR + 20, 118] : [aluR + 20, bottom]);
    add('stl', AND, wired ? [aluR + 30, 118] : [aluR + 26, bottom]);
    add('nstall', NOT, wired ? [4, 46] : [8, P('pc', 'en')[1] - 1]);
    add('rwg', AND, wired ? [54, 75] : [52, bottom - 8]);
    add('rwh', OR, wired ? [68, 75] : [56, bottom - 2]);
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
    if (wired) {
      // the core's own wires stay wires; what the multi-core adds (decode, arbitration, the memory port) keeps its pointers
      const some = (name: string, tagged: string[], via?: string[]) => {
        const n = net(name);
        n.tags = tagged;
        if (n.via) for (const k of via ?? []) delete n.via[k];
      };
      net('op').tags = true;
      some('funct3', ['mpd.funct3']);
      some('funct7', ['mpd.funct7']);
      some('rs1', ['mpd.rs1']);
      some('rs2', ['mpd.rs2']);
      some('rd1', ['amux.b']);
      some('WriteData', ['wmux.a', 'amoadd.b']);
      some('ResultSrc', ['rsplit.in']);
      net('ReadData').tags = true;
      net('MemWrite').tags = true;
      net('gndA').via = { 'amoadd.cin': [[dmAt[0] + 22.5, 115], [dmAt[0] + 22.5, 112]] };
      const rw = net('RegWrite');
      rw.via = { 'rwg.a': [[52, P('ctl', 'regWrite')[1]], [52, 76]] };
      delete rw.tags;
      net('retire').tags = ['rwg.b', 'retire'];
      net('retire').via = { 'pc.en': [[10, 47], [10, P('pc', 'en')[1]]] };
    }
    const ox = resY[0] + 22;
    Object.assign(pins, { hartid: [0, bottom + 6], memRData: [0, bottom + 9], grant: [0, bottom + 12], memAddr: [ox, bottom + 1], memWData: [ox, bottom + 4], memWE: [ox, bottom + 7], memReq: [ox, bottom + 10], retire: [ox, bottom + 13] });
    if (imemPort) {
      // the program comes from outside (an instruction memory macro in a real chip)
      instances.splice(instances.findIndex((i) => i.name === 'imem'), 1);
      drop(net('PC'), 'imem.addr');
      const ins = net('Instr');
      ins.ends = ['instr', ...ins.ends.filter((e) => e !== 'imem.data')];
      pins.instr = wired ? [40, P('imem', 'data')[1]] : [0, bottom + 15];
      extraPorts.push(bus('instr', 32, 'in'));
      if (c) {
        // C: the port carries the 32-bit window at pc (a window ROM, editor/parts.ts); the expander is inside the core
        instances.push({ name: 'cx', def: C_EXPAND, at: at.get('imem')!, label: 'C expander' });
        ins.ends = ins.ends.map((e) => (e === 'instr' ? 'cx.instr' : e));
        nets.push({ name: 'window', ends: ['instr', 'cx.w'], tags: true });
        const cn = nets.find((n) => n.name === 'C')!;
        cn.ends = cn.ends.map((e) => (e === 'imem.c' ? 'cx.c' : e));
        nets.push({ name: 'cIllegal', ends: ['cx.illegal', 'illegal'], tags: true });
        extraPorts.push(bit('illegal', 'out'));
        pins.illegal = [ox, bottom + 16];
      }
    }
    extraPorts.push(bus('hartid', 32, 'in'), bus('memRData', 32, 'in'), bit('grant', 'in'),
      bus('memAddr', 32, 'out'), bus('memWData', 32, 'out'), bit('memWE', 'out'), bit('memReq', 'out'), bit('retire', 'out'));
  }
  for (const n of nets) if (n.via) for (const k of Object.keys(n.via)) if (!n.ends.includes(k)) delete n.via[k];
  return {
    id: imemPort ? (custom.length ? `rv32i_cx${rowsKey(custom)}_core` : c ? 'rv32ic_core' : 'rv32i_core') : (custom.length ? `cx${rowsKey(custom)}_` : '') + key2(IM) + (adder === 'ks' ? '_ks' : '') + (dcache ? `_dc${dcache === true ? '' : dcache}${dmemK}` : dmemK !== 5 && !shared ? `_d${dmemK}` : '') + (icache ? '_ic' : '') + (fpu ? '_fp' : '') + (shared ? '_core' : '') + (dram ? `_dram${cfgKey(dram)}` : '') + (mac ? '_mac' : '') + (vector ? '_v' : ''), name: `Single-cycle RV32I${fpu ? 'F' : ''}${c ? 'C' : ''}${mac ? ' + MAC' : ''}${vector ? ' + vector unit' : ''} CPU${adder === 'ks' ? ' (fast adders)' : ''}${dcache ? ` with a ${dcache === true ? '' : 'write-back '}data cache` : ''}${dram ? ` over DRAM (${dram.policy} page)` : ''}${icache ? `${dcache ? ' and' : ' with'} an instruction cache` : ''}`, category: 'cpu',
    summary: dcache === 'wb' || dcache === 'wb2'
      ? `The single-cycle processor with its data memory behind a ${dcache === 'wb2' ? '2-way set-associative' : 'direct-mapped'} write-back cache. Loads and stores that miss hold the PC and the register write (retire = 0): ${dram ? `as long as the DRAM controller takes for the line (${dram.banks} banks, ${dram.policy} page): 8 cycles on a row hit, 12 on a closed bank, 16 on another open row, plus a write-back of a dirty victim first` : '8 cycles, or 12 when a dirty line must be written back first'}.`
      : dcache
      ? 'The single-cycle processor with its data memory replaced by a slow main memory behind a 64-byte direct-mapped cache. A load that misses holds the PC and the register write (retire = 0) for 8 cycles while the line is fetched.'
      : 'A complete RISC-V processor: every instruction is fetched, decoded, executed and retired in one clock cycle. Built entirely from the blocks of the previous chapters.',
    ports: [bit('clk', 'in', 'left', true), bus('pcOut', 32, 'out'), bus('instrOut', 32, 'out'), bus('aluOut', 32, 'out'), ...(mac ? [bus('accOut', 40, 'out')] : []), ...(dcache || icache ? [bit('retire', 'out')] : []), ...(dcache ? [bit('dhit', 'out')] : []), ...(icache ? [bit('ihit', 'out')] : []), ...(fpu ? [bit('retire', 'out')] : []), ...extraPorts],
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

