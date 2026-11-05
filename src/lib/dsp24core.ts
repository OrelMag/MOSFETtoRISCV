// The DSP core joined (chapter "A DSP core"): registers, the MAC block of the RV32 chapter behind a small adapter, the program ROM, and
// dsp24Computer(program, x, y), the core with its ROM and its two 256-word memories. dsp24Core has the three outside (pins), for the
// sandbox. The blocks are in dsp24.ts (decode, ALU), dsp24agu.ts and dsp24seq.ts.

import { assemble24 } from '../dsp/asm24';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { constWord } from './alu';
import { bigRam, bigRamWithInit } from './bigmem';
import { Builder } from './builder';
import { busMux2, decoder, muxTree } from './combinational';
import { define, merger, ones } from './define';
import { DSP24_ALU, DSP24_DECODE } from './dsp24';
import { DSP24_AGU } from './dsp24agu';
import { DSP24_SEQ } from './dsp24seq';
import { cut, placed } from './fft';
import { clampWord } from './fixedpt';
import { macUnit } from './macunit';
import { register } from './sequential';
import { TIE0 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);
const outs = (ps: PortDef[]) => ps.filter((p) => p.dir === 'out').map((p) => p.name);

// ---- Registers -------------------------------------------------------------------------------

const REGS_PORTS: PortDef[] = [
  bus('ra', 3, 'in'), bus('rb', 3, 'in'), bus('wi', 3, 'in'), bit('we', 'in'), bus('d', 16, 'in'), bit('clk', 'in', true),
  bus('qa', 16, 'out'), bus('qb', 16, 'out'),
];

/** Eight 16-bit registers, r0 an ordinary one, two read ports and one write port. */
export const DSP24_REGS: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('ra', 'rb', 'wi', 'we', 'd', 'clk');
  const dec = b.op(decoder(3, true), ['wi', 'we'], 'write enable of one');
  b.next();
  const q: string[] = [];
  for (let i = 0; i < 8; i++) {
    if (i === 4) b.next();
    q.push(b.name(b.op1(register(16), ['d', `${dec}.y${i}`, 'clk'], `r${i}`, `r${i}`), `R${i}`, true));
  }
  b.next();
  b.wire(b.op1(muxTree(3, 16), [...q, 'ra'], 'read port A'), 'qa');
  b.wire(b.op1(muxTree(3, 16), [...q, 'rb'], 'read port B'), 'qb');
  const R = b.right;
  return define({
    id: 'dsp24_regs', name: 'Registers (DSP core)', category: 'cpu',
    summary: 'Eight 16-bit registers, r0 to r7 (r0 is an ordinary register), with two read ports and one write port. A decoder turns the write index into one enable.',
    ports: REGS_PORTS,
    symbol: { kind: 'box', label: 'REGS 8×16' },
    netlist: () => ({ pins: { ...pinsAt(ins(REGS_PORTS), 0, 4), qa: [R, 8], qb: [R, 16] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- The MAC block, as the RV32 chapter built it ---------------------------------------------

const MAC_PORTS: PortDef[] = [
  bus('x', 16, 'in'), bus('y', 16, 'in'), bus('op', 2, 'in'), bit('en', 'in'), bus('sh', 6, 'in'), bit('clk', 'in', true),
  bus('r', 16, 'out'), bus('acc', 40, 'out'),
];

/**
 * The adapter: macUnit() unchanged, its 32-bit operands a = {0, x}, b = {0, y} (only the low halves are the DSP core's data;
 * the unit's second multiplier, for mac2, sees zeros and is never used), and its 32-bit read clamped to 16 bits.
 * op 00 is mac, 10 clracc (rndc reads the accumulator in the same clock that clears it); en = 0 leaves it alone (rnd).
 */
export const DSP24_MAC: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('x', 'y', 'op', 'en', 'sh', 'clk');
  const z16 = b.op1(constWord(16, 0), [], '0');
  const a = b.op1(merger([16, 16], 2), ['x', z16], 'a = {0, x}');
  const bb = b.op1(merger([16, 16], 2), ['y', z16], 'b = {0, y}');
  b.next();
  const mu = b.op(macUnit(), [a, bb, 'op', 'en', 'sh', 'clk'], 'MAC unit of the RV32 chapter', 'unit');
  b.next();
  const cl = b.op(clampWord(16, 32), [`${mu}.y`], 'clamp to 16 bits', 'clamp');
  b.next();
  b.wire(`${cl}.y`, 'r');
  b.wire(`${mu}.acc`, 'acc');
  const R = b.right;
  return define({
    id: 'dsp24_mac', name: 'MAC (DSP core)', category: 'cpu',
    summary: 'The RV32 chapter\'s MAC unit, unchanged, with 16-bit data in its low halves and its 32-bit rounded read clamped to 16 bits: the 40-bit accumulator, a signed 16 × 16 multiply-add, and a read that shifts, rounds once and saturates once.',
    ports: MAC_PORTS,
    symbol: { kind: 'box', label: 'MAC' },
    netlist: () => ({ pins: { ...pinsAt(ins(MAC_PORTS), 0, 4), r: [R, 8], acc: [R, 16] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- Program ROM -----------------------------------------------------------------------------

function hash(words: ArrayLike<number>): string {
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) { h ^= words[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

const roms = new Map<string, ComponentDef>();

/** The 256 × 24 program ROM: a multiplexer tree of constants, simulated as a lookup (the 4-bit CPU's, 24 bits wide). */
export function rom24(words: ArrayLike<number>): ComponentDef {
  const content = Array.from({ length: 256 }, (_, i) => (words[i] ?? 0) & 0xffffff);
  const key = hash(content);
  let d = roms.get(key);
  if (d) return d;
  const M = muxTree(8, 24, 4);
  const mg = symbolGeom(M);
  d = {
    id: `dsp24_rom_${key}`, name: 'Program ROM 256×24', category: 'memory',
    summary: '256 words of 24 bits, read-only: a 256:1 multiplexer tree whose inputs are tied to the program\'s bits.',
    ports: [bus('addr', 8, 'in'), bus('data', 24, 'out')],
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
        instances.push({ name: `c${i}`, def: constWord(24, v), at: [8, mg.ports[`d${i}`].pos[1] - 1], label: `[${i}]` });
        nets.push({ ends: [`c${i}.y`, `mux.d${i}`] });
      });
      return { pins: { addr: [0, mg.h + 7], data: [16 + mg.w + 6, mg.ports.y.pos[1]] }, instances, nets };
    },
  };
  roms.set(key, d);
  return d;
}

// ---- The core ---------------------------------------------------------------------------------

/** Pins of the core without its memories. */
export const DSP24_CORE_PORTS: PortDef[] = [
  bit('clk', 'in', true), bus('instr', 24, 'in'), bus('xdata', 16, 'in'), bus('ydata', 16, 'in'),
  bus('pc', 8, 'out'), bus('xaddr', 8, 'out'), bus('yaddr', 8, 'out'), bit('xwe', 'out'), bit('ywe', 'out'), bus('wdata', 16, 'out'),
  bus('out', 16, 'out'), bit('outv', 'out'), bit('halt', 'out'),
];

/** Pins of the computer. */
export const DSP24_PORTS: PortDef[] = [
  bit('clk', 'in', true), bus('pc', 8, 'out'), bus('out', 16, 'out'), bit('outv', 'out'), bit('halt', 'out'),
];

interface Wiring { instr: string; xd: string; yd: string; sinks: { pc: string[]; xa: string[]; ya: string[]; xwe: string[]; ywe: string[]; wd: string[] } }

/** The datapath: Decode, registers, ALU, the two address generators, the MAC, the sequencer; returns nothing, the sinks are wired. */
function dsp24Body(b: Builder, w: Wiring): void {
  const dec = b.op(DSP24_DECODE, [w.instr], 'Decode', 'dec');
  const c = (n: string) => b.name(`${dec}.${n}`, n, true);
  const regs = b.op(DSP24_REGS, [c('ra'), c('rb'), c('rd'), c('rwe'), '', 'clk'], 'Registers', 'regs');
  const qa = b.name(`${regs}.qa`, 'qa', true), qb = b.name(`${regs}.qb`, 'qb', true);
  const seq = b.op(DSP24_SEQ, [c('halt'), c('jmp'), c('jz'), c('jnz'), qa, c('addr'), c('isloop'), c('lreg'), c('cnt'), c('lend'), 'clk'], 'Sequencer', 'seq');
  const pc = b.name(`${seq}.pc`, 'pc', true);
  for (const s of w.sinks.pc) b.wire(pc, s);
  b.next();
  const agx = b.op(DSP24_AGU, [c('xp'), c('xmode'), c('xact'), c('wex'), c('wsel'), '', c('rsel'), 'clk'], 'AGU X', 'aguX');
  const agy = b.op(DSP24_AGU, [c('yp'), c('ymode'), c('yact'), c('wey'), c('wsel'), '', c('rsel'), 'clk'], 'AGU Y', 'aguY');
  for (const s of w.sinks.xa) b.wire(`${agx}.a`, s);
  for (const s of w.sinks.ya) b.wire(`${agy}.a`, s);
  b.next();
  const mac = b.op(DSP24_MAC, [w.xd, w.yd, c('macop'), c('macen'), c('sh'), 'clk'], 'MAC', 'mac');
  const imm = c('imm');
  const imm8 = b.op1(cut(14, 0, 8), [imm], 'imm8');
  const imm8sx = b.op1(placed(8, 0, 16), [imm8], 'imm8, signed');
  const ldi = b.op1(placed(14, 0, 16), [imm], 'imm14, signed');
  const bsel = b.op1(busMux2(16), [qb, imm8sx, c('bimm')], 'b operand');
  const alu = b.op(DSP24_ALU, [qa, bsel, c('aluf')], 'ALU', 'alu');
  b.next();
  const qxy = b.op1(busMux2(8), [`${agx}.q`, `${agy}.q`, c('srcy')], 'AGU register read');
  const z8 = b.op1(constWord(8, 0), []), z16 = b.op1(constWord(16, 0), []);
  const qxz = b.op1(merger([8, 8], 2), [qxy, z8], 'zero-extended');
  const movv = b.op1(muxTree(2, 16), [qa, qxz, qxz, z16, c('msrc')], 'mov source');
  const ldh = b.op1(merger([8, 8], 2), [b.op1(cut(16, 0, 8), [qa]), imm8], 'ldh: {imm8, rd low}');
  b.next();
  const d = b.name(b.op1(muxTree(3, 16), [`${alu}.y`, w.xd, w.yd, movv, ldi, ldh, `${mac}.r`, z16, c('wsrc')], 'register write data'), 'd', true);
  b.wire(d, `${regs}.d`);
  const dlow = b.op1(cut(16, 0, 8), [d], 'low byte');
  b.wire(dlow, `${agx}.wd`);
  b.wire(dlow, `${agy}.wd`);
  for (const s of w.sinks.xwe) b.wire(c('xwe'), s);
  for (const s of w.sinks.ywe) b.wire(c('ywe'), s);
  for (const s of w.sinks.wd) b.wire(qa, s);
  b.wire(c('halt'), 'halt');
  b.wire(c('outv'), 'outv');
  b.wire(qa, 'out');
}

const cores = new Map<string, ComponentDef>();

/** The core with its memories outside: instr in, pc out; the X and Y memories on xaddr / xdata / xwe and yaddr / ydata / ywe, stores on wdata. */
export function dsp24Core(): ComponentDef {
  let d = cores.get('core');
  if (d) return d;
  const b = new Builder(18, 12, 6);
  b.pins('clk', 'instr', 'xdata', 'ydata');
  dsp24Body(b, { instr: 'instr', xd: 'xdata', yd: 'ydata', sinks: { pc: ['pc'], xa: ['xaddr'], ya: ['yaddr'], xwe: ['xwe'], ywe: ['ywe'], wd: ['wdata'] } });
  const R = b.right;
  d = define({
    id: 'dsp24_core', name: 'DSP core without memories', category: 'cpu',
    summary: 'The DSP core with its program and data memories outside: it shows its PC on pc and runs the 24-bit word on instr at every rising clk edge; X and Y are read on xaddr / xdata and yaddr / ydata in the same clock, and a store puts qa on wdata with xwe or ywe.',
    ports: DSP24_CORE_PORTS,
    symbol: { kind: 'box', label: 'DSP CORE' },
    netlist: () => ({ pins: { ...pinsAt(ins(DSP24_CORE_PORTS), 0, 6), ...pinsAt(outs(DSP24_CORE_PORTS), R, 6) }, instances: b.instances, nets: b.nets() }),
  });
  cores.set('core', d);
  return d;
}

/** The computer: the 256-word program ROM, the core, and the X and Y memories (256 words of 16 bits, with their starting contents). */
export function dsp24Computer(program: ArrayLike<number>, x: ArrayLike<number> = [], y: ArrayLike<number> = []): ComponentDef {
  const R0 = rom24(program);
  const key = `${R0.id}_${hash(Array.from({ length: 256 }, (_, i) => x[i] ?? 0))}_${hash(Array.from({ length: 256 }, (_, i) => y[i] ?? 0))}`;
  let d = cores.get(key);
  if (d) return d;
  const mem = (words: ArrayLike<number>) => (Array.from({ length: 256 }, (_, i) => words[i] ?? 0).some((v) => v) ? bigRamWithInit(8, 16, Array.from({ length: 256 }, (_, i) => (words[i] ?? 0) & 0xffff)) : bigRam(8, 16));
  const b = new Builder(10, 12, 6);
  b.pins('clk');
  const rom = b.op(R0, [''], 'program', 'rom');
  const xr = b.op(mem(x), ['', '', '', 'clk'], 'X memory', 'xram');
  const yr = b.op(mem(y), ['', '', '', 'clk'], 'Y memory', 'yram');
  dsp24Body(b, {
    instr: b.name(`${rom}.data`, 'instr', true), xd: `${xr}.dout`, yd: `${yr}.dout`,
    sinks: { pc: [`${rom}.addr`, 'pc'], xa: [`${xr}.addr`], ya: [`${yr}.addr`], xwe: [`${xr}.we`], ywe: [`${yr}.we`], wd: [`${xr}.din`, `${yr}.din`] },
  });
  const R = b.right;
  d = define({
    id: `dsp24_${R0.id.slice('dsp24_rom_'.length)}`, name: 'DSP core computer', category: 'cpu',
    summary: 'A small DSP core of our own: 16-bit data, 24-bit instructions, one per clock. Two data memories (X for samples, Y for coefficients) read in the same cycle by one instruction, an address generator for each (post-increment, circular windows, bit-reversed order), a hardware loop with no branch, and the RV32 chapter\'s MAC unit.',
    ports: DSP24_PORTS,
    symbol: { kind: 'box', label: 'DSP CORE' },
    netlist: () => ({ pins: { ...pinsAt(ins(DSP24_PORTS), 0, 6), ...pinsAt(outs(DSP24_PORTS), R, 6) }, instances: b.instances, nets: b.nets() }),
  });
  cores.set(key, d);
  return d;
}

/** Paths of the architectural state in dsp24Computer (instance path; every register has its value on port q). */
export const DSP24_STATE = {
  pc: 'seq.pc', r: Array.from({ length: 8 }, (_, i) => `regs.r${i}`),
  p: [0, 1, 2, 3].map((i) => `aguX.p${i}`).concat([0, 1, 2, 3].map((i) => `aguY.p${i}`)),
  xb: 'aguX.base', xl: 'aguX.len', xm: 'aguX.mod', yb: 'aguY.base', yl: 'aguY.len', ym: 'aguY.mod',
  acc: 'mac.unit.acc', ls: 'seq.loop.ls', le: 'seq.loop.le', lc: 'seq.loop.lc', la: 'seq.loop.la',
  xram: 'xram', yram: 'yram',
} as const;

void TIE0; void ones; void assemble24;
