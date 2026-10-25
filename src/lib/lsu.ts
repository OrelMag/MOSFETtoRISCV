// Load/store unit: byte and halfword access on a 32-bit memory. Stores replicate the data
// into every lane and enable only the addressed bytes; loads pick the addressed lane and
// sign- or zero-extend it. The data memory is four byte-wide banks, each with its own write
// enable, the way real SRAM macros implement byte writes.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { andN, decoder, muxTree } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { ram } from './memory';
import { TIE0 } from './transistors';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

function wire(id: string, name: string, inW: number, map: (i: number) => number | 'zero', label: string, summary: string): ComponentDef {
  const alias: [string, number, string, number][] = [];
  for (let i = 0; i < 32; i++) {
    const s = map(i);
    alias.push(s === 'zero' ? ['zero', 0, 'out', i] : ['in', s, 'out', i]);
  }
  const usesZero = alias.some((a) => a[0] === 'zero');
  return define({
    id, name, category: 'plumbing', summary,
    ports: [bus('in', inW, 'in'), ...(usesZero ? [bit('zero', 'in', 'bottom')] : []), bus('out', 32, 'out')],
    symbol: { kind: 'box', label, w: 6, h: 2 }, prim: 'alias', alias,
  });
}

export const SEXT8 = wire('lsu_sext8', 'Sign-extend byte (wiring)', 8, (i) => (i < 8 ? i : 7), 'sext8', 'Bit 7 copied into bits 31..8.');
export const ZEXT8 = wire('lsu_zext8', 'Zero-extend byte (wiring)', 8, (i) => (i < 8 ? i : 'zero'), 'zext8', 'Bits 31..8 tied to 0.');
export const SEXT16 = wire('lsu_sext16', 'Sign-extend half (wiring)', 16, (i) => (i < 16 ? i : 15), 'sext16', 'Bit 15 copied into bits 31..16.');
export const ZEXT16 = wire('lsu_zext16', 'Zero-extend half (wiring)', 16, (i) => (i < 16 ? i : 'zero'), 'zext16', 'Bits 31..16 tied to 0.');
export const REP8 = wire('lsu_rep8', 'Replicate byte (wiring)', 32, (i) => i % 8, 'b b b b', 'The low byte copied into all four lanes (for sb).');
export const REP16 = wire('lsu_rep16', 'Replicate half (wiring)', 32, (i) => i % 16, 'h h', 'The low half copied into both halves (for sh).');

/** Store side: lane replication, byte enables, misalignment. */
export const STORE_ALIGN: ComponentDef = define({
  id: 'storealign', name: 'Store alignment', category: 'cpu',
  summary: 'sb / sh / sw: replicate the data into every lane it might go to, and raise the byte enables only for the addressed bytes. A halfword at an odd address or a word not on a 4-byte boundary is misaligned.',
  ports: [bus('wd', 32, 'in'), bus('addr', 2, 'in'), bus('size', 2, 'in'), bus('wdata', 32, 'out'), bus('be', 4, 'out'), bit('misaligned', 'out')],
  symbol: { kind: 'box', label: 'STORE' },
  spec: ([wd, addr, size]) => {
    const rep8 = (wd & 0xff) * 0x01010101, rep16 = (wd & 0xffff) * 0x00010001;
    const wdata = size === 0 ? rep8 >>> 0 : size === 1 ? rep16 >>> 0 : wd;
    const be = size === 0 ? 1 << addr : size === 1 ? (addr & 2 ? 0b1100 : 0b0011) : 0b1111;
    const mis = (size === 1 && (addr & 1)) || (size >= 2 && addr !== 0) ? 1 : 0;
    return [wdata, be, mis];
  },
  netlist: () => {
    const M32 = muxTree(2, 32), M4 = muxTree(2, 4), D2 = decoder(2);
    const mg = symbolGeom(M32), bg = symbolGeom(M4);
    return {
      pins: { wd: [0, 6], addr: [0, 34], size: [0, 46], wdata: [56, 2 + mg.ports.y.pos[1]], be: [56, 29 + bg.ports.y.pos[1]], misaligned: [56, 49] },
      instances: [
        { name: 'r8', def: REP8, at: [8, 2] }, { name: 'r16', def: REP16, at: [8, 6] },
        { name: 'wsel', def: M32, at: [40, 2] },
        { name: 'sa', def: splitter([1, 1]), at: [4, 32] },
        { name: 'dec', def: D2, at: [12, 26] },
        { name: 'onehot', def: merger([1, 1, 1, 1]), at: [28, 27] },
        { name: 'na1', def: NOT, at: [14, 38] },
        { name: 'hmask', def: merger([1, 1, 1, 1]), at: [28, 37] },
        { name: 'all', def: constWord(4, 15), at: [32, 36] },
        { name: 'bsel', def: M4, at: [40, 29] },
        { name: 'ss', def: splitter([1, 1]), at: [4, 44] },
        { name: 'mh', def: AND, at: [24, 46] }, { name: 'ao', def: OR, at: [24, 52] }, { name: 'mw', def: AND, at: [36, 51] },
        { name: 'mis', def: OR, at: [44, 47] },
      ],
      nets: [
        { name: 'wd', ends: ['wd', 'r8.in', 'r16.in', 'wsel.d2', 'wsel.d3'], trunk: 4, tags: ['wsel.d2', 'wsel.d3'] },
        { name: 'rep8', ends: ['r8.out', 'wsel.d0'] }, { name: 'rep16', ends: ['r16.out', 'wsel.d1'] },
        { name: 'size', ends: ['size', 'wsel.s', 'bsel.s', 'ss.in'], tags: ['wsel.s', 'bsel.s'] },
        { name: 'wdata', ends: ['wsel.y', 'wdata'] },
        { name: 'addr', ends: ['addr', 'dec.a', 'sa.in'] },
        { name: 'a0', ends: ['sa.o0', 'mh.b', 'ao.a'], tags: true },
        { name: 'a1', ends: ['sa.o1', 'na1.a', 'hmask.i2', 'hmask.i3', 'ao.b'], tags: true },
        { name: '¬a1', ends: ['na1.y', 'hmask.i0', 'hmask.i1'], tags: true },
        ...[0, 1, 2, 3].map((i): NetDef => ({ ends: [`dec.y${i}`, `onehot.i${i}`] })),
        { name: 'byteMask', ends: ['onehot.out', 'bsel.d0'] }, { name: 'halfMask', ends: ['hmask.out', 'bsel.d1'], trunk: 31 },
        { name: 'all', ends: ['all.y', 'bsel.d2', 'bsel.d3'] },
        { name: 'be', ends: ['bsel.y', 'be'] },
        { name: 'isHalf', ends: ['ss.o0', 'mh.a'], tags: true }, { name: 'isWord', ends: ['ss.o1', 'mw.a'], tags: true },
        { name: 'lowBits', ends: ['ao.y', 'mw.b'] },
        { name: 'misH', ends: ['mh.y', 'mis.a'] }, { name: 'misW', ends: ['mw.y', 'mis.b'] },
        { name: 'misaligned', ends: ['mis.y', 'misaligned'] },
      ],
    };
  },
});

/** Load side: select the addressed byte / half and extend it. */
export const LOAD_EXTRACT: ComponentDef = define({
  id: 'loadextract', name: 'Load extraction', category: 'cpu',
  summary: 'lb / lh / lw / lbu / lhu: a multiplexer picks the addressed byte (or half), wiring sign- or zero-extends it, and funct3 picks the final value.',
  ports: [bus('rdata', 32, 'in'), bus('addr', 2, 'in'), bus('funct3', 3, 'in'), bus('value', 32, 'out')],
  symbol: { kind: 'box', label: 'LOAD' },
  spec: ([rdata, addr, f3]) => {
    const byte = (rdata >>> (8 * addr)) & 0xff, half = (rdata >>> (addr & 2 ? 16 : 0)) & 0xffff;
    const sx = (v: number, b: number) => (v & (1 << (b - 1)) ? v - 2 ** b + 2 ** 32 : v);
    const opts = [sx(byte, 8), sx(half, 16), rdata, rdata, byte, half, rdata, rdata];
    return [opts[f3] >>> 0];
  },
  netlist: () => {
    const M8 = muxTree(2, 8), M16 = muxTree(1, 16), M32 = muxTree(3, 32);
    const mg = symbolGeom(M32);
    return {
      pins: { rdata: [0, 8], addr: [0, 40], funct3: [0, 48], value: [70, 2 + mg.ports.y.pos[1]] },
      instances: [
        { name: 'lanes', def: splitter([8, 8, 8, 8]), at: [4, 2] },
        { name: 'halves', def: splitter([16, 16]), at: [4, 14] },
        { name: 'bsel', def: M8, at: [14, 0] },
        { name: 'hsel', def: M16, at: [14, 16] },
        { name: 'sa', def: splitter([1, 1]), at: [4, 38] },
        { name: 'sb', def: SEXT8, at: [30, 4] }, { name: 'zb', def: ZEXT8, at: [30, 16] },
        { name: 'sh', def: SEXT16, at: [30, 10] }, { name: 'zh', def: ZEXT16, at: [30, 22] },
        { name: 'gnd', def: TIE0, at: [24, 26] },
        { name: 'fsel', def: M32, at: [52, 2] },
      ],
      nets: [
        { name: 'rdata', ends: ['rdata', 'lanes.in', 'halves.in', 'fsel.d2', 'fsel.d3', 'fsel.d6', 'fsel.d7'], trunk: 2, tags: ['fsel.d2', 'fsel.d3', 'fsel.d6', 'fsel.d7'] },
        ...[0, 1, 2, 3].map((i): NetDef => ({ ends: [`lanes.o${i}`, `bsel.d${i}`] })),
        { ends: ['halves.o0', 'hsel.d0'] }, { ends: ['halves.o1', 'hsel.d1'] },
        { name: 'addr', ends: ['addr', 'bsel.s', 'sa.in'], tags: ['bsel.s'] },
        { name: 'a1', ends: ['sa.o1', 'hsel.s'], tags: true },
        { name: 'byte', ends: ['bsel.y', 'sb.in', 'zb.in'], trunk: 26 },
        { name: 'half', ends: ['hsel.y', 'sh.in', 'zh.in'], tags: true },
        { name: 'gnd', ends: ['gnd.y', 'zb.zero', 'zh.zero'], tags: true },
        { name: 'lb', ends: ['sb.out', 'fsel.d0'] }, { name: 'lh', ends: ['sh.out', 'fsel.d1'] },
        { name: 'lbu', ends: ['zb.out', 'fsel.d4'] }, { name: 'lhu', ends: ['zh.out', 'fsel.d5'] },
        { name: 'funct3', ends: ['funct3', 'fsel.s'], tags: ['fsel.s'] },
        { name: 'value', ends: ['fsel.y', 'value'] },
      ],
    };
  },
});

const banked = new Map<number, ComponentDef>();

/** Data memory as four byte-wide banks with individual write enables. */
export function bankedMemory(k: number): ComponentDef {
  const hit = banked.get(k);
  if (hit) return hit;
  const def = buildBanked(k);
  banked.set(k, def);
  return def;
}

function buildBanked(k: number): ComponentDef {
  const R = ram(k, 8);
  const rg = symbolGeom(R);
  const pitch = rg.h + 6;
  const bankY = (i: number) => 4 + pitch * i;
  const nets: NetDef[] = [
    { name: 'addr', ends: ['addr', 'sa.in'] },
    { name: 'index', ends: ['sa.o1', ...[0, 1, 2, 3].map((i) => `b${i}.addr`)], tags: [0, 1, 2, 3].map((i) => `b${i}.addr`) },
    { name: 'wdata', ends: ['wdata', 'lanes.in'] },
    { name: 'be', ends: ['be', 'sbe.in'] },
    { name: 'we', ends: ['we', ...[0, 1, 2, 3].map((i) => `w${i}.a`)], tags: [0, 1, 2, 3].map((i) => `w${i}.a`) },
    { name: 'clk', ends: ['clk', ...[0, 1, 2, 3].map((i) => `b${i}.clk`)], tags: [0, 1, 2, 3].map((i) => `b${i}.clk`) },
    { name: 'rdata', ends: ['mr.out', 'rdata'] },
  ];
  const instances = [
    // above the lanes splitter, which shares its column
    { name: 'sa', def: splitter([2, k, 30 - k]), at: [4, -6] as [number, number] },
    { name: 'lanes', def: splitter([8, 8, 8, 8], pitch), at: [4, bankY(0) + rg.ports.din.pos[1] - pitch / 2] as [number, number] },
    { name: 'sbe', def: splitter([1, 1, 1, 1]), at: [4, bankY(4) + 2] as [number, number] },
    { name: 'mr', def: merger([8, 8, 8, 8], pitch), at: [24 + rg.w + 6, bankY(0) + rg.ports.dout.pos[1] - pitch / 2] as [number, number] },
  ];
  for (let i = 0; i < 4; i++) {
    instances.push({ name: `w${i}`, def: AND, at: [14, bankY(i) + rg.ports.we.pos[1] - 1] });
    instances.push({ name: `b${i}`, def: R, at: [24, bankY(i)] });
    nets.push(
      { name: `lane${i}`, ends: [`lanes.o${i}`, `b${i}.din`] },
      { name: `be${i}`, ends: [`sbe.o${i}`, `w${i}.b`], tags: true },
      { name: `we${i}`, ends: [`w${i}.y`, `b${i}.we`] },
      { name: `out${i}`, ends: [`b${i}.dout`, `mr.i${i}`] },
    );
  }
  return define({
    id: `bmem${k}`, name: 'Data memory (byte banks)', category: 'memory',
    summary: `${2 ** k} words as four byte-wide banks. Each bank has its own write enable, so a store can write one, two or four bytes; reads return the whole word.`,
    ports: [bus('addr', 32, 'in'), bus('wdata', 32, 'in'), bus('be', 4, 'in'), bit('we', 'in'), bit('clk', 'in', 'bottom', true), bus('rdata', 32, 'out')],
    symbol: { kind: 'box', label: 'DATA MEM' },
    netlist: () => ({
      pins: { addr: [0, -3], wdata: [0, bankY(1) + 2], be: [0, bankY(4) + 4], we: [0, bankY(4) + 8], clk: [0, bankY(4) + 11], rdata: [24 + rg.w + 12, bankY(2)] },
      instances, nets,
    }),
  });
}

// ---- any width: the 64-bit core's load / store unit (chapter 25) ------------------------------------------
// The same three blocks at XLEN bits (XLEN / 8 byte lanes); at 32 bits they are the objects above. Every access
// stays inside its word, aligned to its own size (lh at 8k + 7 reads bytes 6 and 7), as riscv/iss64.ts models it.

const wideCache = new Map<string, ComponentDef>();
function wmemo(key: string, f: () => ComponentDef): ComponentDef {
  let d = wideCache.get(key);
  if (!d) wideCache.set(key, (d = f()));
  return d;
}

/** Wiring: in (inW bits) → out (outW bits), the upper bits copies of in's top bit (signed) or 0. Costs nothing. */
export function extWire(inW: number, outW: number, signed: boolean): ComponentDef {
  return wmemo(`ext${signed ? 's' : 'z'}${inW}_${outW}`, () => {
    const alias: [string, number, string, number][] = [];
    for (let i = 0; i < outW; i++) alias.push(i < inW ? ['in', i, 'out', i] : signed ? ['in', inW - 1, 'out', i] : ['zero', 0, 'out', i]);
    return define({
      id: `lsu_${signed ? 's' : 'z'}ext${inW}_${outW}`, name: `${signed ? 'Sign' : 'Zero'}-extend ${inW} → ${outW} (wiring)`, category: 'plumbing',
      summary: signed ? `Bit ${inW - 1} copied into bits ${outW - 1}..${inW}: no gates, only wires.` : `Bits ${outW - 1}..${inW} tied to 0.`,
      ports: [bus('in', inW, 'in'), ...(signed ? [] : [bit('zero', 'in', 'bottom')]), bus('out', outW, 'out')],
      symbol: { kind: 'box', label: `${signed ? 's' : 'z'}ext${inW}`, w: 6, h: 2 }, prim: 'alias', alias,
    });
  });
}

/** Wiring: the low k bits copied into every k-bit lane of an outW-bit word (sb / sh / sw on a wider memory). */
export function repWire(k: number, outW: number): ComponentDef {
  return wmemo(`rep${k}_${outW}`, () => define({
    id: `lsu_rep${k}_${outW}`, name: `Replicate ${k} bits ×${outW / k} (wiring)`, category: 'plumbing',
    summary: `The low ${k} bits copied into all ${outW / k} lanes.`,
    ports: [bus('in', outW, 'in'), bus('out', outW, 'out')],
    symbol: { kind: 'box', label: `${k}×${outW / k}`, w: 6, h: 2 }, prim: 'alias',
    alias: Array.from({ length: outW }, (_, i): [string, number, string, number] => ['in', i % k, 'out', i]),
  }));
}

/** Store alignment at xlen bits: 32 → STORE_ALIGN; 64 → sb / sh / sw / sd on eight byte lanes. */
export function storeAlign(xlen: 32 | 64): ComponentDef {
  return xlen === 32 ? STORE_ALIGN : wmemo('storealign64', buildStore64);
}

function buildStore64(): ComponentDef {
  const W = 64;
  const M64 = muxTree(2, W), M8 = muxTree(2, 8), D3 = decoder(3), D2 = decoder(2);
  const mg = symbolGeom(M64), bg = symbolGeom(M8), d3 = symbolGeom(D3);
  const MG8 = merger([1, 1, 1, 1, 1, 1, 1, 1]), mgg = symbolGeom(MG8);
  const yB = 20; // byte-mask decoder's top
  const yH = yB + d3.h + 6, yW = yH + mgg.h + 4, ySz = yW + mgg.h + 8;
  const xM = 34, xS = xM + 12; // mask mergers, mask select
  const bsAt: [number, number] = [xS, yH];
  const right = xS + bg.w + 26;
  const nets: NetDef[] = [
    { name: 'wd', ends: ['wd', 'r8.in', 'r16.in', 'r32.in', 'wsel.d3'], trunk: 4, tags: ['wsel.d3'] },
    { name: 'rep8', ends: ['r8.out', 'wsel.d0'] }, { name: 'rep16', ends: ['r16.out', 'wsel.d1'] }, { name: 'rep32', ends: ['r32.out', 'wsel.d2'] },
    { name: 'size', ends: ['size', 'wsel.s', 'bsel.s', 'ss.in'], tags: ['wsel.s', 'bsel.s'] },
    { name: 'wdata', ends: ['wsel.y', 'wdata'] },
    { name: 'addr', ends: ['addr', 'dec.a', 'sa.in', 'sa2.in'], tags: ['sa2.in'] },
    { name: 'a0', ends: ['sa.o0', 'mh.b', 'ao.a'], tags: true },
    { name: 'a1', ends: ['sa.o1', 'ao.b'], tags: true },
    { name: 'a2', ends: ['sa.o2', 'na2.a', ...[4, 5, 6, 7].map((i) => `wmask.i${i}`), 'md.i2'], tags: true },
    { name: '¬a2', ends: ['na2.y', ...[0, 1, 2, 3].map((i) => `wmask.i${i}`)], tags: true },
    { name: 'a[2:1]', ends: ['sa2.o1', 'hdec.a'], tags: true },
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): NetDef => ({ ends: [`dec.y${i}`, `onehot.i${i}`] })),
    ...[0, 1, 2, 3].map((i): NetDef => ({ name: `h${i}`, ends: [`hdec.y${i}`, `hmask.i${2 * i}`, `hmask.i${2 * i + 1}`] })),
    { name: 'byteMask', ends: ['onehot.out', 'bsel.d0'] }, { name: 'halfMask', ends: ['hmask.out', 'bsel.d1'] },
    { name: 'wordMask', ends: ['wmask.out', 'bsel.d2'] }, { name: 'all', ends: ['all.y', 'bsel.d3'], tags: true },
    { name: 'be', ends: ['bsel.y', 'be'] },
    { name: 's0', ends: ['ss.o0', 'mh.a', 'md.i0'], tags: true }, { name: 's1', ends: ['ss.o1', 'mw.a', 'md.i1'], tags: true },
    { name: 'lowBits', ends: ['ao.y', 'mw.b'] },
    { name: 'misH', ends: ['mh.y', 'mis.i0'] }, { name: 'misW', ends: ['mw.y', 'mis.i1'] }, { name: 'misD', ends: ['md.y', 'mis.i2'] },
    { name: 'misaligned', ends: ['mis.y', 'misaligned'] },
  ];
  return define({
    id: 'storealign64', name: 'Store alignment (64-bit)', category: 'cpu',
    summary: 'sb / sh / sw / sd on eight byte lanes: replicate the data into every lane it might go to and raise the byte enables only for the addressed bytes (each access aligned to its own size inside the doubleword). A halfword at an odd address, a word not on a 4-byte or a doubleword not on an 8-byte boundary is flagged misaligned.',
    ports: [bus('wd', W, 'in'), bus('addr', 3, 'in'), bus('size', 2, 'in'), bus('wdata', W, 'out'), bus('be', 8, 'out'), bit('misaligned', 'out')],
    symbol: { kind: 'box', label: 'STORE' },
    netlist: () => ({
      pins: { wd: [0, 6], addr: [0, yB + 4], size: [0, ySz + 2], wdata: [right, 2 + mg.ports.y.pos[1]], be: [right, bsAt[1] + bg.ports.y.pos[1]], misaligned: [right, ySz + 6] },
      instances: [
        { name: 'r8', def: repWire(8, W), at: [10, 2] }, { name: 'r16', def: repWire(16, W), at: [10, 6] }, { name: 'r32', def: repWire(32, W), at: [10, 10] },
        { name: 'wsel', def: M64, at: [xS, 2] },
        { name: 'sa', def: splitter([1, 1, 1]), at: [4, yB + 12] },
        { name: 'sa2', def: splitter([1, 2]), at: [4, yH + 4] },
        { name: 'dec', def: D3, at: [16, yB] },
        { name: 'onehot', def: MG8, at: [xM, yB + 1] },
        { name: 'hdec', def: D2, at: [16, yH + 1] },
        { name: 'hmask', def: MG8, at: [xM, yH] },
        { name: 'na2', def: NOT, at: [20, yW + 6] },
        { name: 'wmask', def: MG8, at: [xM, yW] },
        { name: 'all', def: constWord(8, 255), at: [xS, yW + 4] },
        { name: 'bsel', def: M8, at: bsAt },
        { name: 'ss', def: splitter([1, 1]), at: [4, ySz] },
        { name: 'ao', def: OR, at: [14, ySz + 8] }, { name: 'mh', def: AND, at: [24, ySz + 2] }, { name: 'mw', def: AND, at: [24, ySz + 8] },
        { name: 'md', def: andN(3), at: [24, ySz + 14] },
        { name: 'mis', def: orN(3), at: [xS + 6, ySz + 4] },
      ],
      nets,
    }),
    hdl: {
      verilog: `// size = funct3[1:0]: 0 sb, 1 sh, 2 sw, 3 sd
always_comb case (size)
  2'd0: begin wdata = {8{wd[7:0]}};  be = 8'b1 << addr; end
  2'd1: begin wdata = {4{wd[15:0]}}; be = 8'b11 << {addr[2:1], 1'b0}; end
  2'd2: begin wdata = {2{wd[31:0]}}; be = addr[2] ? 8'hF0 : 8'h0F; end
  default: begin wdata = wd; be = 8'hFF; end
endcase
assign misaligned = (size[0] & addr[0]) | (size[1] & |addr[1:0]) | (&size & addr[2]);`,
    },
  });
}

/** Load extraction at xlen bits: 32 → LOAD_EXTRACT; 64 → lb / lh / lw / ld / lbu / lhu / lwu. */
export function loadExtract(xlen: 32 | 64): ComponentDef {
  return xlen === 32 ? LOAD_EXTRACT : wmemo('loadextract64', buildLoad64);
}

function buildLoad64(): ComponentDef {
  const W = 64;
  const M8 = muxTree(3, 8), M16 = muxTree(2, 16), M32 = muxTree(1, 32), MW = muxTree(3, W);
  const gW = symbolGeom(MW);
  const xF = 60;
  const right = xF + gW.w + 8;
  const exts: [string, ComponentDef, number][] = [
    ['sb', extWire(8, W, true), 0], ['sh', extWire(16, W, true), 1], ['sw', extWire(32, W, true), 2],
    ['zb', extWire(8, W, false), 4], ['zh', extWire(16, W, false), 5], ['zw', extWire(32, W, false), 6],
  ];
  return define({
    id: 'loadextract64', name: 'Load extraction (64-bit)', category: 'cpu',
    summary: 'lb / lh / lw / ld / lbu / lhu / lwu: multiplexers pick the addressed byte, half or word of the doubleword, wiring sign- or zero-extends it to 64 bits, and funct3 picks the final value. lwu is new in RV64: a word load now has to say whether the upper half copies bit 31.',
    ports: [bus('rdata', W, 'in'), bus('addr', 3, 'in'), bus('funct3', 3, 'in'), bus('value', W, 'out')],
    symbol: { kind: 'box', label: 'LOAD' },
    netlist: () => ({
      pins: { rdata: [0, 10], addr: [0, 50], funct3: [0, 58], value: [right, 2 + gW.ports.y.pos[1]] },
      instances: [
        { name: 'lanes', def: splitter([8, 8, 8, 8, 8, 8, 8, 8]), at: [6, 2] },
        { name: 'halves', def: splitter([16, 16, 16, 16]), at: [6, 22] },
        { name: 'words', def: splitter([32, 32]), at: [6, 34] },
        { name: 'bsel', def: M8, at: [16, 0] },
        { name: 'hsel', def: M16, at: [16, 22] },
        { name: 'wsel', def: M32, at: [16, 36] },
        { name: 'sa', def: splitter([2, 1]), at: [6, 48] },
        { name: 'sa2', def: splitter([1, 2]), at: [10, 52] },
        ...exts.map(([n, d, i]): InstanceDef => ({ name: n, def: d, at: [38, (i < 4 ? 4 : 30) + 8 * (i % 4)] })),
        { name: 'gnd', def: TIE0, at: [30, 52] },
        { name: 'fsel', def: MW, at: [xF, 2] },
      ],
      nets: [
        { name: 'rdata', ends: ['rdata', 'lanes.in', 'halves.in', 'words.in', 'fsel.d3', 'fsel.d7'], trunk: 3, tags: ['fsel.d3', 'fsel.d7'] },
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): NetDef => ({ ends: [`lanes.o${i}`, `bsel.d${i}`] })),
        ...[0, 1, 2, 3].map((i): NetDef => ({ ends: [`halves.o${i}`, `hsel.d${i}`] })),
        { ends: ['words.o0', 'wsel.d0'] }, { ends: ['words.o1', 'wsel.d1'] },
        { name: 'addr', ends: ['addr', 'bsel.s', 'sa.in', 'sa2.in'], tags: ['bsel.s'] },
        { name: 'a2', ends: ['sa.o1', 'wsel.s'], tags: true },
        { name: 'a[2:1]', ends: ['sa2.o1', 'hsel.s'], tags: true },
        { name: 'byte', ends: ['bsel.y', 'sb.in', 'zb.in'], tags: true },
        { name: 'half', ends: ['hsel.y', 'sh.in', 'zh.in'], tags: true },
        { name: 'word', ends: ['wsel.y', 'sw.in', 'zw.in'], tags: true },
        { name: 'gnd', ends: ['gnd.y', 'zb.zero', 'zh.zero', 'zw.zero'], tags: true },
        ...exts.map(([n, , i]): NetDef => ({ name: ['lb', 'lh', 'lw', '', 'lbu', 'lhu', 'lwu'][i], ends: [`${n}.out`, `fsel.d${i}`] })),
        { name: 'funct3', ends: ['funct3', 'fsel.s'], tags: ['fsel.s'] },
        { name: 'value', ends: ['fsel.y', 'value'] },
      ],
    }),
    hdl: {
      verilog: `wire [7:0] b = rdata >> {addr, 3'b0};  wire [15:0] h = rdata >> {addr[2:1], 4'b0};  wire [31:0] w = rdata >> {addr[2], 5'b0};
always_comb case (funct3)
  3'd0: value = {{56{b[7]}}, b};   3'd1: value = {{48{h[15]}}, h};   3'd2: value = {{32{w[31]}}, w};
  3'd4: value = {56'b0, b};        3'd5: value = {48'b0, h};         3'd6: value = {32'b0, w};
  default: value = rdata;          // ld
endcase`,
    },
  });
}

/** Data memory as xlen / 8 byte-wide banks: 32 → bankedMemory(k); 64 → eight banks of 2^k bytes. */
export function laneMemory(k: number, xlen: 32 | 64): ComponentDef {
  return xlen === 32 ? bankedMemory(k) : wmemo(`bmem64_${k}`, () => buildBanked64(k));
}

function buildBanked64(k: number): ComponentDef {
  const W = 64, L = 8;
  const R = ram(k, 8);
  const rg = symbolGeom(R);
  const pitch = rg.h + 6;
  const bankY = (i: number) => 4 + pitch * i;
  const lanes = Array.from({ length: L }, (_, i) => i);
  const nets: NetDef[] = [
    { name: 'addr', ends: ['addr', 'sa.in'] },
    { name: 'index', ends: ['sa.o1', ...lanes.map((i) => `b${i}.addr`)], tags: lanes.map((i) => `b${i}.addr`) },
    { name: 'wdata', ends: ['wdata', 'lanes.in'] },
    { name: 'be', ends: ['be', 'sbe.in'] },
    { name: 'we', ends: ['we', ...lanes.map((i) => `w${i}.a`)], tags: lanes.map((i) => `w${i}.a`) },
    { name: 'clk', ends: ['clk', ...lanes.map((i) => `b${i}.clk`)], tags: lanes.map((i) => `b${i}.clk`) },
    { name: 'rdata', ends: ['mr.out', 'rdata'] },
  ];
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter([3, k, W - 3 - k]), at: [4, -6] },
    { name: 'lanes', def: splitter(lanes.map(() => 8), pitch), at: [4, bankY(0) + rg.ports.din.pos[1] - pitch / 2] },
    { name: 'sbe', def: splitter(lanes.map(() => 1)), at: [4, bankY(L) + 2] },
    { name: 'mr', def: merger(lanes.map(() => 8), pitch), at: [24 + rg.w + 6, bankY(0) + rg.ports.dout.pos[1] - pitch / 2] },
  ];
  for (const i of lanes) {
    instances.push({ name: `w${i}`, def: AND, at: [14, bankY(i) + rg.ports.we.pos[1] - 1] });
    instances.push({ name: `b${i}`, def: R, at: [24, bankY(i)] });
    nets.push(
      { name: `lane${i}`, ends: [`lanes.o${i}`, `b${i}.din`] },
      { name: `be${i}`, ends: [`sbe.o${i}`, `w${i}.b`], tags: true },
      { name: `we${i}`, ends: [`w${i}.y`, `b${i}.we`] },
      { name: `out${i}`, ends: [`b${i}.dout`, `mr.i${i}`] },
    );
  }
  return define({
    id: `bmem64_${k}`, name: 'Data memory (8 byte banks)', category: 'memory',
    summary: `${2 ** k} doublewords (${8 * 2 ** k} bytes) as eight byte-wide banks, each with its own write enable: a store writes one, two, four or eight bytes; reads return the whole doubleword. Address bits [${k + 2}:3] select it.`,
    ports: [bus('addr', W, 'in'), bus('wdata', W, 'in'), bus('be', L, 'in'), bit('we', 'in'), bit('clk', 'in', 'bottom', true), bus('rdata', W, 'out')],
    symbol: { kind: 'box', label: 'DATA MEM' },
    netlist: () => ({
      pins: { addr: [0, -3], wdata: [0, bankY(1) + 2], be: [0, bankY(L) + 4 + L], we: [0, bankY(L) + 8 + L], clk: [0, bankY(L) + 11 + L], rdata: [24 + rg.w + 12, bankY(4)] },
      instances, nets,
    }),
  });
}
