// Load/store unit: byte and halfword access on a 32-bit memory. Stores replicate the data
// into every lane and enable only the addressed bytes; loads pick the addressed lane and
// sign- or zero-extend it. The data memory is four byte-wide banks, each with its own write
// enable, the way real SRAM macros implement byte writes.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { decoder, muxTree } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { ram } from './memory';
import { TIE0 } from './transistors';

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
    { name: 'sa', def: splitter([2, k, 30 - k]), at: [4, 0] as [number, number] },
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
      pins: { addr: [0, 1], wdata: [0, bankY(1) + 2], be: [0, bankY(4) + 4], we: [0, bankY(4) + 8], clk: [0, bankY(4) + 11], rdata: [24 + rg.w + 12, bankY(2)] },
      instances, nets,
    }),
  });
}
