// The DSP core joined (chapter "A DSP core"): registers, the MAC block of the RV32 chapter behind a small adapter, the program ROM, and
// dsp24Computer(program, x, y), the core with its ROM and its two 256-word memories. dsp24Core has the three outside (pins), for the
// sandbox. The blocks are in dsp24.ts (decode, ALU), dsp24agu.ts and dsp24seq.ts.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { constWord } from './alu';
import { bigRam, bigRamWithInit } from './bigmem';
import { assemble24 } from '../dsp/asm24';
import { BENCH24 } from '../dsp/programs24';
import { Builder } from './builder';
import { Sheet } from './dsp24draw';
import { busMux2, decoder, muxTree } from './combinational';
import { define, merger } from './define';
import { DSP24_ALU, DSP24_DECODE } from './dsp24';
import { DSP24_AGU } from './dsp24agu';
import { DSP24_SEQ } from './dsp24seq';
import { cut, placed } from './fft';
import { clampWord } from './fixedpt';
import { macUnit } from './macunit';
import { register } from './sequential';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock, side: 'bottom' as const } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> =>
  Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const ins = (ps: PortDef[]) => ps.filter((p) => p.dir === 'in').map((p) => p.name);

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

/** The memories of the computer: the core without them has pins where their ports are, so one drawing serves both. */
interface Mems { rom: ComponentDef; xram: ComponentDef; yram: ComponentDef }

/**
 * The datapath drawn by hand, left to right as the mockup shows: fetch (SEQUENCER, PROGRAM, DECODE), the two address generators and
 * their memories, the MAC, the registers and the ALU, and the register write multiplexer. The X and Y buses are real wires from the
 * memories to the MAC and the write multiplexer. What DECODE sends to the units is a label (control), and so are the few long ways
 * back (the register write data, the store data).
 */
function dsp24Drawing(mem: Mems | null): { instances: InstanceDef[]; nets: NetDef[]; pins: Record<string, [number, number]> } {
  const S = new Sheet();
  const M16 = busMux2(16);
  const XR = 88, YR = 88; // memories' column
  const XY = 9, YY = 81; // top rows of the X and Y memories
  if (mem) {
    S.alignY('rom', mem.rom, 24, 'addr', 38, 'program');
    S.place('xram', mem.xram, XR, XY, 'X memory');
    S.place('yram', mem.yram, YR, YY, 'Y memory');
  }
  S.place('dec', DSP24_DECODE, 40, 2, 'Decode');
  S.place('regs', DSP24_REGS, 112, 22, 'Registers');
  S.alignY('seq', DSP24_SEQ, 0, 'pc', 38, 'Sequencer');
  S.place('aguX', DSP24_AGU, 68, 4, 'AGU X');
  S.place('aguY', DSP24_AGU, 68, 76, 'AGU Y');
  S.place('mac', DSP24_MAC, 130, 60, 'MAC');
  S.place('u0', cut(14, 0, 8), 112, 40, 'imm8');
  S.place('u1', placed(8, 0, 16), 122, 40, 'imm8, signed');
  S.place('u2', placed(14, 0, 16), 142, 36, 'imm14, signed');
  S.place('u3', M16, 130, 31, 'b operand');
  S.place('alu', DSP24_ALU, 140, 25, 'ALU');
  S.place('u4', busMux2(8), 112, 46, 'AGU register read');
  S.place('u5', constWord(8, 0), 118, 52);
  S.place('u6', constWord(16, 0), 126, 54);
  S.place('u7', merger([8, 8], 2), 126, 49, 'zero-extended');
  S.place('u8', muxTree(2, 16), 136, 44, 'mov source');
  S.place('u9', cut(16, 0, 8), 126, 43);
  S.place('u10', merger([8, 8], 2), 146, 41, 'ldh: {imm8, rd low}');
  S.place('u11', muxTree(3, 16), 160, 27, 'register write data');
  S.place('u12', cut(16, 0, 8), 170, 35, 'low byte');

  const ctl = (n: string, ...sinks: string[]): NetDef => ({ name: n, ends: [`dec.${n}`, ...sinks], tags: true });
  const mx = (inst: string, pin: string) => (mem ? inst : pin);
  const nets: NetDef[] = [
    { name: 'clk', ends: ['clk', ...(mem ? ['xram.clk', 'yram.clk'] : []), 'regs.clk', 'seq.clk', 'aguX.clk', 'aguY.clk', 'mac.clk'], tags: true },
    { name: 'instr', ends: [mem ? 'rom.data' : 'instr', 'dec.instr'] },
    ctl('ra', 'regs.ra'), ctl('rb', 'regs.rb'), ctl('rd', 'regs.wi'), ctl('rwe', 'regs.we'),
    ctl('halt', 'seq.halt', 'halt'), ctl('jmp', 'seq.jmp'), ctl('jz', 'seq.jz'), ctl('jnz', 'seq.jnz'),
    {
      name: 'qa', ends: ['regs.qa', 'alu.a', 'u8.d0', 'u9.a', 'seq.qa', ...(mem ? ['xram.din', 'yram.din'] : ['wdata']), 'out'],
      tags: ['seq.qa', ...(mem ? ['xram.din', 'yram.din'] : ['wdata']), 'out'],
    },
    ctl('addr', 'seq.addr'), ctl('isloop', 'seq.isloop'), ctl('lreg', 'seq.lreg'), ctl('cnt', 'seq.cnt'), ctl('lend', 'seq.lend'),
    { name: 'pc', ends: ['seq.pc', ...(mem ? ['rom.addr'] : []), 'pc'], tags: ['pc'] },
    ctl('xp', 'aguX.sel'), ctl('xmode', 'aguX.mode'), ctl('xact', 'aguX.act'), ctl('wex', 'aguX.we'),
    ctl('wsel', 'aguX.wsel', 'aguY.wsel'), ctl('rsel', 'aguX.rsel', 'aguY.rsel'),
    ctl('yp', 'aguY.sel'), ctl('ymode', 'aguY.mode'), ctl('yact', 'aguY.act'), ctl('wey', 'aguY.we'),
    { ends: ['aguX.a', mx('xram.addr', 'xaddr')] },
    { ends: ['aguY.a', mx('yram.addr', 'yaddr')] },
    { ends: [mx('xram.dout', 'xdata'), 'mac.x', 'u11.d1'], via: { 'u11.d1': [[158, 13], [158, 31]] } },
    { ends: [mx('yram.dout', 'ydata'), 'mac.y', 'u11.d2'], via: { 'u11.d2': [[156, 85], [156, 33]] } },
    ctl('macop', 'mac.op'), ctl('macen', 'mac.en'), ctl('sh', 'mac.sh'),
    ctl('imm', 'u0.a', 'u2.a'),
    { ends: ['u0.y', 'u1.a', 'u10.i1'] },
    { name: 'qb', ends: ['regs.qb', 'u3.a'] },
    { ends: ['u1.y', 'u3.b'] },
    ctl('bimm', 'u3.s'),
    { ends: ['u3.y', 'alu.b'] },
    ctl('aluf', 'alu.f'),
    { ends: ['aguX.q', 'u4.a'] },
    { ends: ['aguY.q', 'u4.b'] },
    ctl('srcy', 'u4.s'),
    { ends: ['u4.y', 'u7.i0'] },
    { ends: ['u5.y', 'u7.i1'] },
    { ends: ['u7.out', 'u8.d1', 'u8.d2'] },
    { ends: ['u6.y', 'u8.d3', 'u11.d7'], tags: ['u11.d7'] },
    ctl('msrc', 'u8.s'),
    { ends: ['u9.y', 'u10.i0'] },
    { ends: ['alu.y', 'u11.d0'] },
    { ends: ['u8.y', 'u11.d3'] },
    { ends: ['u2.y', 'u11.d4'] },
    { ends: ['u10.out', 'u11.d5'] },
    { ends: ['mac.r', 'u11.d6'], via: { 'u11.d6': [[152, 65], [152, 41]] } },
    ctl('wsrc', 'u11.s'),
    { name: 'd', ends: ['u11.y', 'regs.d', 'u12.a'], tags: ['regs.d'] },
    { ends: ['u12.y', 'aguX.wd', 'aguY.wd'], tags: true },
    ctl('xwe', mx('xram.we', 'xwe')), ctl('ywe', mx('yram.we', 'ywe')),
    ctl('outv', 'outv'),
  ];
  const pins: Record<string, [number, number]> = mem
    ? { clk: [0, 90], pc: [20, 32], out: [180, 22], outv: [180, 26], halt: [180, 30] }
    : {
      clk: [0, 90], instr: [34, 38], xdata: [104, 13], ydata: [104, 85], pc: [22, 38], xaddr: [84, 11], yaddr: [84, 83], xwe: [84, 15], ywe: [84, 87],
      wdata: [84, 13], out: [180, 22], outv: [180, 26], halt: [180, 30],
    };
  return { instances: S.instances(), nets, pins };
}

const cores = new Map<string, ComponentDef>();

/** The core with its memories outside: instr in, pc out; the X and Y memories on xaddr / xdata / xwe and yaddr / ydata / ywe, stores on wdata. */
export function dsp24Core(): ComponentDef {
  let d = cores.get('core');
  if (d) return d;
  d = define({
    id: 'dsp24_core', name: 'DSP core without memories', category: 'cpu',
    summary: 'The DSP core with its program and data memories outside: it shows its PC on pc and runs the 24-bit word on instr at every rising clk edge; X and Y are read on xaddr / xdata and yaddr / ydata in the same clock, and a store puts qa on wdata with xwe or ywe.',
    ports: DSP24_CORE_PORTS,
    symbol: { kind: 'box', label: 'DSP CORE' },
    netlist: () => dsp24Drawing(null),
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
  const mems = { rom: R0, xram: mem(x), yram: mem(y) };
  d = define({
    id: `dsp24_${R0.id.slice('dsp24_rom_'.length)}`, name: 'DSP core computer', category: 'cpu',
    summary: 'A small DSP core of our own: 16-bit data, 24-bit instructions, one per clock. Two data memories (X for samples, Y for coefficients) read in the same cycle by one instruction, an address generator for each (post-increment, circular windows, bit-reversed order), a hardware loop with no branch, and the RV32 chapter\'s MAC unit.',
    ports: DSP24_PORTS,
    symbol: { kind: 'box', label: 'DSP CORE' },
    netlist: () => dsp24Drawing(mems),
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

// Built at load (the FIR 16 benchmark), so the layout and routing checks cover the whole computer.
const FIR16 = BENCH24[0];
export const DSP24_FIR16 = dsp24Computer(assemble24(FIR16.src).words, FIR16.x, FIR16.y);
