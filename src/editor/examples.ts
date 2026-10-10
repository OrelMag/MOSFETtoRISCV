// Example chips the sandbox can load (Examples ▸): small circuits that show a part at work, each
// added as a new chip (never over the user's). Plain documents, built here with terse helpers;
// the tests compile and run every one.

import type { ChipDoc, EndRef, LabelDoc, PartDoc, PartRef, PinDoc, Vec, WireDoc, Workspace } from './model';
import { slug, uniqueName } from './model';
import { SEG7_FONT } from './memory';
import { openChip } from './session';
import { PICTURE } from '../riscv/ioprograms';

const pin = (id: string, dir: PinDoc['dir'], at: Vec, width = 1, extra: Partial<PinDoc> = {}): PinDoc => ({ id, name: id, dir, width, at, ...extra });
const part = (id: string, ref: PartRef, at: Vec, extra: Partial<PartDoc> = {}): PartDoc => ({ id, ref, at, ...extra });
const lbl = (id: string, name: string, at: Vec, face?: LabelDoc['face']): LabelDoc => ({ id, name, at, ...(face ? { face } : {}) });
/** 'x.a' → part port, 'pin:a' → pin, 'lbl:l1' → pointer. */
const end = (s: string | EndRef): EndRef => {
  if (typeof s !== 'string') return s;
  if (s.startsWith('pin:')) return { pin: s.slice(4) };
  if (s.startsWith('lbl:')) return { label: s.slice(4) };
  const i = s.indexOf('.');
  return { part: s.slice(0, i), port: s.slice(i + 1) };
};
const wire = (id: string, a: string | EndRef, b: string | EndRef, pts: Vec[] = [], extra: Partial<WireDoc> = {}): WireDoc =>
  ({ id, a: end(a), b: end(b), pts, ...extra });
const chip = (id: string, name: string, c: Partial<ChipDoc>): ChipDoc => ({ id, name, pins: [], parts: [], wires: [], labels: [], ...c });

/** Eight instructions: the fetch loop walks through all of them, then wraps to 0. */
export const FETCH_PROGRAM = `# sum = 1 + 2 + ... + 10 (fetched, not executed:
# no CPU here, so the branches are not taken)
        li   a0, 0          # sum
        li   t0, 1          # i
        li   t1, 11         # limit
loop:   add  a0, a0, t0     # sum += i
        addi t0, t0, 1      # i++
        bne  t0, t1, loop   # until i == 11
        sw   a0, 0(zero)    # store the result
halt:   j    halt`;

/**
 * Fetch: a 32-bit PC register, PC + 4 and a program ROM addressed by bytes. The PC reaches the
 * incrementer through a pair of `pc` pointers; the incremented value loops back to the
 * register's d. Every clock edge fetches the next word, wrapping at the end of the ROM.
 */
export function fetchChip(id: string, name: string, rom: { k: number; src: string } = { k: 3, src: FETCH_PROGRAM }): ChipDoc {
  return chip(id, name, {
    notes: 'Each clock edge: PC ← PC + 4. The ROM turns the PC into the instruction at that byte address. Open the ROM (Edit program…) to change the program and watch the listing follow the PC.',
    pins: [pin('clk', 'in', [2, 12], 1, { kind: 'clock' }), pin('instr', 'out', [56, 7], 32), pin('pc', 'out', [56, 2], 32)],
    parts: [
      part('pcr', { lib: 'reg32' }, [12, 4], { label: 'PC' }), part('one', { const: { width: 1, value: 1 } }, [3, 7]),
      part('inc', { lib: 'plus4' }, [22, 15], { flip: true }),
      part('rom', { rom: { k: rom.k, w: 32, addr: 'rv32', lang: 'asm', src: rom.src } }, [34, 5], { label: 'program' }),
    ],
    labels: [lbl('p1', 'pc', [28, 11], 'down'), lbl('p2', 'pc', [32, 17], 'right')],
    wires: [
      wire('clk', 'pin:clk', 'pcr.clk'), wire('en', 'one.y', 'pcr.en'),
      wire('q', 'pcr.q', 'rom.addr'),
      wire('qo', { wire: 'q', at: [24, 7] }, 'pin:pc', [[24, 2]]),
      wire('qp', { wire: 'q', at: [28, 7] }, 'lbl:p1'),
      wire('ia', 'lbl:p2', 'inc.a'),
      wire('nx', 'inc.y', 'pcr.d', [[8, 17], [8, 6]]),
      wire('i', 'rom.data', 'pin:instr'),
    ],
  });
}

/** The 7-segment font as the decoder ROM's program (hex, one word per digit). */
const FONT_SRC = `# 7-segment font: bit 0 = segment a ... bit 6 = g
# 0  1  2  3  4  5  6  7
${SEG7_FONT.slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join(' ')}
# 8  9  A  b  C  d  E  F
${SEG7_FONT.slice(8).map((x) => x.toString(16).padStart(2, '0')).join(' ')}`;

/**
 * A 4-bit counter shown on a 7-segment digit: the count addresses a 16 × 8 ROM that holds the
 * font (the decoder is a lookup table), and a hex display shows the count itself.
 */
export function counterSeg7Chip(id: string, name: string): ChipDoc {
  return chip(id, name, {
    notes: 'A 4-bit counter addresses a 16 × 8 ROM holding the 7-segment font: a decoder written as a table. Run the clock and watch the digit count 0–F.',
    pins: [pin('clk', 'in', [2, 14], 1, { kind: 'clock' })],
    parts: [
      part('one', { const: { width: 1, value: 1 } }, [3, 7]), part('cnt', { lib: 'counter4' }, [10, 6]),
      part('font', { rom: { k: 4, w: 8, addr: 'word', lang: 'hex', src: FONT_SRC } }, [26, 6], { label: 'font ROM' }),
      part('seg', { display: 'seg7', width: 8 }, [42, 6]), part('digit', { display: 'hex', width: 4 }, [26, 14]),
    ],
    wires: [
      wire('clk', 'pin:clk', 'cnt.clk'), wire('en', 'one.y', 'cnt.en'),
      wire('q', 'cnt.q', 'font.addr'),
      wire('qd', { wire: 'q', at: [22, 8] }, 'digit.a', [[22, 16]]),
      wire('segs', 'font.data', 'seg.a'),
    ],
  });
}

/**
 * A shared bus: two tri-state buffers drive one wire, a pull-down holds it at 0 while neither is
 * enabled. Enable both with different values and the drivers fight (X).
 */
export function sharedBusChip(id: string, name: string): ChipDoc {
  return chip(id, name, {
    notes: 'Two tri-state buffers on one wire. Enable one: the bus carries its value. Enable none: the pull-down holds the bus at 0 (delete it and the bus floats, Z). Enable both with different values: VDD shorts to GND through both drivers (X). Solved at switch level.',
    pins: [
      pin('ea', 'in', [2, 2], 1, { value: 1 }), pin('a', 'in', [2, 6], 1, { value: 1 }),
      pin('eb', 'in', [2, 12]), pin('b', 'in', [2, 16]),
      pin('bus', 'out', [30, 11]),
    ],
    parts: [
      part('ta', { lib: 'tribuf' }, [10, 4]), part('tb', { lib: 'tribuf' }, [10, 14]),
      part('pd', { lib: 'pulldown' }, [23, 13]),
    ],
    wires: [
      wire('ea', 'pin:ea', 'ta.en', [[12, 2]]), wire('a', 'pin:a', 'ta.a'),
      wire('eb', 'pin:eb', 'tb.en', [[12, 12]]), wire('b', 'pin:b', 'tb.a'),
      wire('bus', 'ta.y', 'pin:bus', [[20, 6], [20, 11]], { name: 'bus' }),
      wire('busb', 'tb.y', { wire: 'bus', at: [20, 11] }, [[20, 16]]),
      wire('pull', { wire: 'bus', at: [24, 11] }, 'pd.y'),
    ],
  });
}

/**
 * Wired logic: open-drain (or open-source) stages on one wire with a pull resistor. Each stage is
 * an inverter and one transistor that either pulls the wire or lets go of it. With NMOS to GND
 * and a pull-up the wire is the AND of the inputs; with PMOS to VDD and a pull-down, the OR.
 */
export function wiredChip(id: string, name: string, kind: 'and' | 'or'): ChipDoc {
  const and = kind === 'and';
  return chip(id, name, {
    notes: and
      ? 'Open-drain wired-AND: each stage pulls the wire to 0 when its input is 0 and otherwise lets go; the pull-up makes it 1 when every stage lets go. Any number of stages can share the wire (I²C, interrupt lines). The price: static current through the pull-up while the wire is low.'
      : 'Open-source wired-OR: each stage pulls the wire to 1 when its input is 1 and otherwise lets go; the pull-down makes it 0 when every stage lets go. The price: static current through the pull-down while the wire is high.',
    pins: [pin('a', 'in', [2, and ? 9 : 10], 1, { value: 1 }), pin('b', 'in', [2, and ? 16 : 3], 1, { value: 1 }), pin('y', 'out', [30, and ? 5 : 14])],
    parts: and ? [
      part('ia', { lib: 'inv_cmos' }, [6, 8]), part('ib', { lib: 'inv_cmos' }, [14, 15]),
      part('na', { lib: 'nmos' }, [12, 7]), part('nb', { lib: 'nmos' }, [20, 7]),
      part('ga', { lib: 'gnd' }, [14, 12]), part('gb', { lib: 'gnd' }, [22, 12]),
      part('pu', { lib: 'pullup' }, [18, 0]),
    ] : [
      part('ia', { lib: 'inv_cmos' }, [6, 9]), part('ib', { lib: 'inv_cmos' }, [14, 2]),
      part('pa', { lib: 'pmos' }, [12, 8]), part('pb', { lib: 'pmos' }, [20, 8]),
      part('va', { lib: 'vdd' }, [14, 6]), part('vb', { lib: 'vdd' }, [22, 6]),
      part('pd', { lib: 'pulldown' }, [18, 15]),
    ],
    wires: and ? [
      wire('a', 'pin:a', 'ia.a'), wire('an', 'ia.y', 'na.g'),
      wire('b', 'pin:b', 'ib.a'), wire('bn', 'ib.y', 'nb.g', [[18, 16], [18, 9]]),
      wire('sa', 'na.s', 'ga.p'), wire('sb', 'nb.s', 'gb.p'),
      wire('bus', 'na.d', 'pin:y', [[15, 5]], { name: 'bus' }),
      wire('busb', 'nb.d', { wire: 'bus', at: [23, 5] }),
      wire('pull', 'pu.y', { wire: 'bus', at: [19, 5] }),
    ] : [
      wire('a', 'pin:a', 'ia.a'), wire('an', 'ia.y', 'pa.g'),
      wire('b', 'pin:b', 'ib.a'), wire('bn', 'ib.y', 'pb.g', [[18, 3], [18, 10]]),
      wire('sa', 'va.p', 'pa.s'), wire('sb', 'vb.p', 'pb.s'),
      wire('bus', 'pa.d', 'pin:y', [[15, 14]], { name: 'bus' }),
      wire('busb', 'pb.d', { wire: 'bus', at: [23, 14] }),
      wire('pull', { wire: 'bus', at: [19, 14] }, 'pd.y'),
    ],
  });
}

/** 'Hello, sandbox!' and a new line: 16 characters, one per ROM word. */
const HELLO = 'Hello, sandbox!\n';
const HELLO_SRC = `# ASCII, one character per word: "Hello, sandbox!\\n"
${[...HELLO].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')}`;

/**
 * A console printing a message: a 4-bit counter walks a 16 × 8 ROM holding the text, and the
 * console takes one character per clock edge (we tied to 1).
 */
export function consoleChip(id: string, name: string): ChipDoc {
  return chip(id, name, {
    notes: 'A counter walks a ROM holding a message; the console prints the character on data at every rising clock edge while we = 1. Run the clock and watch it type. Reset clears the console.',
    pins: [pin('clk', 'in', [2, 16], 1, { kind: 'clock' })],
    parts: [
      part('one', { const: { width: 1, value: 1 } }, [3, 7]), part('cnt', { lib: 'counter4' }, [10, 6]),
      part('text', { rom: { k: 4, w: 8, addr: 'word', lang: 'hex', src: HELLO_SRC } }, [24, 6], { label: 'message ROM' }),
      part('write', { const: { width: 1, value: 1 } }, [38, 11]),
      part('con', { console: { cols: 24, rows: 6 } }, [44, 4]),
    ],
    wires: [
      wire('clk', 'pin:clk', 'cnt.clk'), wire('clk2', 'pin:clk', 'con.clk'),
      wire('en', 'one.y', 'cnt.en'), wire('we', 'write.y', 'con.we', [[42, 12], [42, 8]]),
      wire('q', 'cnt.q', 'text.addr'),
      wire('ch', 'text.data', 'con.data', [[41, 8], [41, 6]]),
    ],
  });
}

/**
 * A screen painted by a sweeping beam: an 8-bit counter is the address (x = its low 4 bits, y the
 * high 4), the colour comes from four switches, and every clock edge writes one pixel.
 */
export function screenChip(id: string, name: string): ChipDoc {
  return chip(id, name, {
    notes: 'An 8-bit counter sweeps the 16 × 16 screen pixel by pixel (x = count[3:0], y = count[7:4]); each rising clock edge writes the colour set on the switches (the 16-colour palette: 0 black … 15 white). Run at a high rate and flip the switches while it paints.',
    pins: [pin('clk', 'in', [2, 18], 1, { kind: 'clock' })],
    parts: [
      part('one', { const: { width: 1, value: 1 } }, [3, 7]), part('cnt', { lib: 'counter8' }, [10, 6]),
      part('xy', { split: [4, 4] }, [30, 1]),
      part('colour', { switches: 4 }, [18, 12]),
      part('write', { const: { width: 1, value: 1 } }, [31, 9]),
      part('scr', { screen: { mode: 'write', size: 16, color: 'pal16' } }, [36, 0]),
    ],
    wires: [
      wire('clk', 'pin:clk', 'cnt.clk'), wire('clk2', 'pin:clk', 'scr.clk'),
      wire('en', 'one.y', 'cnt.en'), wire('we', 'write.y', 'scr.we', [[34, 10], [34, 8]]),
      wire('q', 'cnt.q', 'xy.in', [[24, 8], [24, 3]]),
      wire('x', 'xy.o0', 'scr.x'), wire('y', 'xy.o1', 'scr.y'),
      // the colour bus rises left of the write constant, so it never meets the we wire
      wire('c', 'colour.q', 'scr.color', [[29, 14], [29, 6]]),
    ],
  });
}

// ---- a whole computer -------------------------------------------------------------------------

/**
 * The computer's address decoder and read multiplexer: what the address of a load or store
 * selects (ioprograms.ts has the map). Bit 31 clear: RAM. Bits 31:30 = 11: the screen. 10: the
 * devices, told apart by bits 3:2 (console, LEDs, switches; partial decoding, so they repeat every
 * 16 bytes). A store raises one write enable; a load reads RAM, or the LEDs / switches zero-extended.
 */
export function memoryMapChip(id: string, name: string): ChipDoc {
  return chip(id, name, {
    notes: 'Address decoding for the computer. RAM: addr[31] = 0. Screen: addr[31:30] = 11. Devices: addr[31:30] = 10, then addr[3:2] picks the console (00, write), the LEDs (01) or the switches (10, read). A store (we) raises the write enable of the one it selects; a load returns RAM or a device, zero-extended.',
    hue: 200,
    pins: [
      pin('addr', 'in', [0, 8], 32), pin('we', 'in', [0, 17]), pin('ramData', 'in', [0, 28], 32), pin('leds', 'in', [0, 38], 8), pin('switches', 'in', [0, 40], 8),
      pin('scrWe', 'out', [60, 10]), pin('conWe', 'out', [60, 14]), pin('ledWe', 'out', [60, 16]), pin('ramWe', 'out', [60, 24]), pin('rdata', 'out', [60, 39], 32),
    ],
    parts: [
      part('sa', { split: [2, 1, 1, 26, 1, 1] }, [6, 2]), part('sel', { merge: [1, 1] }, [10, 4]),
      part('n30', { lib: 'not' }, [14, 18]), part('n31', { lib: 'not' }, [18, 24]),
      part('io', { lib: 'and' }, [24, 14], { label: 'I/O store' }), part('ram', { lib: 'and' }, [24, 22], { label: 'RAM store' }),
      part('scr', { lib: 'and' }, [34, 10], { label: 'screen' }), part('dev', { lib: 'and' }, [34, 16], { label: 'device' }),
      part('dec', { lib: 'dec2e' }, [44, 12], { label: 'device select' }),
      part('z8', { const: { width: 8, value: 0 } }, [22, 35]), part('z24', { const: { width: 24, value: 0 } }, [30, 30]),
      part('dm', { lib: 'mux4x8' }, [30, 34], { label: 'device read' }), part('zx', { merge: [8, 24] }, [38, 38]),
      part('rm', { lib: 'mux2x32' }, [44, 36], { label: 'RAM / device' }),
    ],
    labels: [lbl('s1', 'sel', [14, 6], 'up'), lbl('s2', 'sel', [32, 44], 'down'), lbl('t1', 'a31', [6, 21], 'left'), lbl('t2', 'a31', [46, 42], 'down')],
    wires: [
      wire('addr', 'pin:addr', 'sa.in'),
      wire('a2', 'sa.o1', 'sel.i0'), wire('a3', 'sa.o2', 'sel.i1'),
      wire('a30', 'sa.o4', 'scr.a', [], { name: 'a30' }), wire('a30n', { wire: 'a30', at: [11, 11] }, 'n30.a', [[11, 19]]),
      wire('a31', 'sa.o5', 'n31.a', [[9, 13], [9, 25]], { name: 'a31' }), wire('a31i', { wire: 'a31', at: [9, 15] }, 'io.a'),
      wire('a31p', { wire: 'a31', at: [9, 21] }, 'lbl:t1'),
      wire('we', 'pin:we', 'io.b'), wire('wer', { wire: 'we', at: [20, 17] }, 'ram.a', [[20, 23]]),
      wire('nr', 'n31.y', 'ram.b'), wire('nd', 'n30.y', 'dev.b'),
      wire('io', 'io.y', 'scr.b', [[31, 16], [31, 13]], { name: 'I/O store' }), wire('iod', { wire: 'io', at: [31, 16] }, 'dev.a', [[31, 17]]),
      wire('den', 'dev.y', 'dec.en'),
      wire('sel', 'sel.out', 'dec.a', [[40, 6], [40, 16]], { name: 'sel' }), wire('selp', { wire: 'sel', at: [14, 6] }, 'lbl:s1'),
      wire('scrWe', 'scr.y', 'pin:scrWe', [[41, 12], [41, 10]]),
      wire('conWe', 'dec.y0', 'pin:conWe'), wire('ledWe', 'dec.y1', 'pin:ledWe'), wire('ramWe', 'ram.y', 'pin:ramWe'),
      wire('z0', 'z8.y', 'dm.d0'), wire('z3', { wire: 'z0', at: [29, 36] }, 'dm.d3', [[29, 42]]),
      wire('leds', 'pin:leds', 'dm.d1'), wire('sw', 'pin:switches', 'dm.d2'), wire('dsel', 'lbl:s2', 'dm.s'),
      wire('dv', 'dm.y', 'zx.i0'), wire('zh', 'z24.y', 'zx.i1', [[37, 31], [37, 41]]),
      wire('dev32', 'zx.out', 'rm.b'), wire('rd', 'pin:ramData', 'rm.a', [[42, 28], [42, 38]]),
      wire('rsel', 'lbl:t2', 'rm.s'), wire('rdata', 'rm.y', 'pin:rdata'),
    ],
  });
}

/**
 * A RISC-V computer: the single-cycle RV32I core (its data side a memory port), a 1K-word program
 * ROM, the memory map (`map`: a user chip of its own), 4K words of RAM, a 64 × 64 screen, a
 * console, eight LEDs and eight switches. The core's buses reach the devices through pointers
 * (addr, wdata, byte = wdata[7:0], rdata, clk); the write enables are wires from the memory map,
 * so the decoding reads left to right. A halt part watches for `j .` (jal x0, 0: 0x0000006f), so
 * Run stops when the program ends; the CPU drawer runs the golden model in lock-step.
 */
export function computerChip(id: string, name: string, mapChip: string, src = PICTURE): ChipDoc {
  return chip(id, name, {
    notes: 'A whole computer: the RV32I core fetches from the program ROM (Edit program… to change it) and reaches RAM, the screen, the console, the LEDs and the switches through the memory map (double-click it). RAM 0x0000_0000 (4K words), console 0x8000_0000, LEDs 0x8000_0004, switches 0x8000_0008, screen 0xC000_0000 + 256·y + 4·x (64 × 64, RGB332). Word loads and stores only: this core has no lb / sb. Run (or Run to halt in the CPU drawer); flip the switches, Reset and Run again.',
    pins: [pin('clk', 'in', [2, 17], 1, { kind: 'clock' })],
    parts: [
      part('imem', { rom: { k: 10, w: 32, addr: 'rv32', lang: 'asm', src } }, [8, 10], { label: 'program' }),
      part('cpu', { lib: 'rv32i_core' }, [24, 12], { label: 'RV32I core' }),
      part('hart', { const: { width: 32, value: 0 } }, [12, 20], { label: 'hart 0' }), part('grant', { const: { width: 1, value: 1 } }, [22, 24]),
      part('hj', { const: { width: 32, value: 0x6f } }, [12, 5], { label: 'j .' }), part('eq', { lib: 'eq32' }, [26, 2]), part('halt', { display: 'halt', width: 1 }, [34, 4]),
      part('map', { chip: mapChip }, [56, 18], { label: 'memory map' }),
      part('sw', { switches: 8 }, [40, 32], { label: 'switches' }),
      part('bs', { split: [8, 24] }, [46, 40]),
      part('xy', { split: [2, 6, 6, 18] }, [86, 11]),
      part('scr', { screen: { mode: 'write', size: 64, color: 'rgb332' } }, [96, 12], { label: 'screen' }),
      part('con', { console: { cols: 32, rows: 8 } }, [96, 46], { label: 'console' }),
      part('ledr', { lib: 'reg8' }, [86, 62], { label: 'LED latch' }), part('leds', { display: 'led', width: 8 }, [98, 64]),
      part('ra', { split: [2, 12, 18] }, [84, 70]),
      part('ram', { ram: { k: 12, w: 32 } }, [90, 74], { label: 'RAM 4K × 32' }),
    ],
    labels: [
      lbl('k0', 'clk', [5, 17], 'down'), lbl('k1', 'clk', [98, 40], 'down'), lbl('k2', 'clk', [98, 58], 'down'), lbl('k3', 'clk', [90, 68], 'down'), lbl('k4', 'clk', [97, 82], 'down'),
      lbl('p0', 'pc', [8, 12], 'left'), lbl('p1', 'pc', [40, 14], 'right'),
      lbl('r0', 'rdata', [24, 23], 'left'), lbl('r1', 'rdata', [74, 28], 'right'),
      lbl('a0', 'addr', [46, 20], 'up'), lbl('a1', 'addr', [86, 15], 'left'), lbl('a2', 'addr', [84, 73], 'left'),
      lbl('w0', 'wdata', [40, 22], 'right'), lbl('w1', 'wdata', [90, 78], 'left'), lbl('w2', 'wdata', [46, 42], 'left'),
      lbl('b0', 'byte', [47, 41], 'right'), lbl('b1', 'byte', [96, 18], 'left'), lbl('b2', 'byte', [96, 48], 'left'), lbl('b3', 'byte', [86, 64], 'left'),
      lbl('d0', 'ramData', [56, 24], 'left'), lbl('d1', 'ramData', [104, 78], 'right'),
      lbl('l0', 'leds', [56, 26], 'left'), lbl('l1', 'leds', [96, 65], 'up'),
    ],
    wires: [
      wire('clk', 'pin:clk', 'cpu.clk', [], { name: 'clk' }), wire('kp', { wire: 'clk', at: [5, 17] }, 'lbl:k0'),
      wire('pcr', 'lbl:p0', 'imem.addr'), wire('pco', 'cpu.pcOut', 'lbl:p1'),
      wire('instr', 'imem.data', 'cpu.instr', [[21, 12], [21, 19]], { name: 'instr' }),
      wire('hx', { wire: 'instr', at: [20, 12] }, 'eq.a', [[20, 4]]), wire('hb', 'hj.y', 'eq.b'), wire('hh', 'eq.eq', 'halt.a'),
      wire('hart', 'hart.y', 'cpu.hartid'), wire('gr', 'grant.y', 'cpu.grant'), wire('rd', 'lbl:r0', 'cpu.memRData'),
      wire('addr', 'cpu.memAddr', 'map.addr', [], { name: 'addr' }), wire('ap', { wire: 'addr', at: [46, 20] }, 'lbl:a0'),
      wire('wd', 'cpu.memWData', 'lbl:w0'), wire('we', 'cpu.memWE', 'map.we', [[48, 24], [48, 22]]),
      wire('md', 'lbl:d0', 'map.ramData'), wire('ml', 'lbl:l0', 'map.leds'), wire('msw', 'sw.q', 'map.switches', [[54, 28]]),
      wire('mr', 'map.rdata', 'lbl:r1'),
      wire('scrWe', 'map.scrWe', 'scr.we'), wire('conWe', 'map.conWe', 'con.we', [[82, 22], [82, 50]]),
      wire('ledWe', 'map.ledWe', 'ledr.en', [[80, 24], [80, 66]]), wire('ramWe', 'map.ramWe', 'ram.we', [[78, 26], [78, 80]]),
      wire('xa', 'lbl:a1', 'xy.in'), wire('x', 'xy.o1', 'scr.x'), wire('y', 'xy.o2', 'scr.y'), wire('sc', 'lbl:b1', 'scr.color'), wire('sk', 'lbl:k1', 'scr.clk'),
      wire('cd', 'lbl:b2', 'con.data'), wire('ck', 'lbl:k2', 'con.clk'),
      wire('ld', 'lbl:b3', 'ledr.d'), wire('lk', 'lbl:k3', 'ledr.clk'),
      wire('lq', 'ledr.q', 'leds.a', [], { name: 'leds' }), wire('lp', { wire: 'lq', at: [96, 65] }, 'lbl:l1'),
      wire('ra', 'lbl:a2', 'ra.in'), wire('rw', 'ra.o1', 'ram.addr', [[88, 73], [88, 76]]), wire('rdin', 'lbl:w1', 'ram.din'),
      wire('rdo', 'ram.dout', 'lbl:d1'), wire('rk', 'lbl:k4', 'ram.clk'),
      wire('bi', 'lbl:w2', 'bs.in'), wire('bo', 'bs.o0', 'lbl:b0'),
    ],
  });
}

export interface Example {
  id: string;
  name: string;
  blurb: string;
  /** The example's chip; `sub` holds the ids given to its sub-chips. */
  build(id: string, name: string, sub: Record<string, string>): ChipDoc;
  /** Chips the example places (its packaged blocks), added alongside it under fresh ids and names. */
  subchips?: Record<string, { name: string; build(id: string, name: string): ChipDoc }>;
}

export const EXAMPLES: Example[] = [
  { id: 'fetch', name: 'Fetch loop', blurb: 'PC register, PC + 4 and a program ROM: the instruction fetch of a CPU.', build: (id, n) => fetchChip(id, n) },
  { id: 'counter7', name: '4-bit counter on a 7-segment display', blurb: 'A counter, a font ROM as the decoder, a 7-segment digit.', build: counterSeg7Chip },
  { id: 'console', name: 'Console: hello', blurb: 'A counter walks a ROM holding a message; a console prints it, a character per clock edge.', build: consoleChip },
  { id: 'screen', name: 'Screen: a sweeping beam', blurb: 'A counter sweeps a 16 × 16 screen pixel by pixel in the colour set on four switches.', build: screenChip },
  {
    id: 'computer', name: 'Computer: RISC-V with a screen and a console',
    blurb: 'An RV32I core, a program ROM, 4K words of RAM, a 64 × 64 screen, a console, LEDs and switches behind a memory map. Run: it greets, then paints.',
    build: (id, n, sub) => computerChip(id, n, sub.map), subchips: { map: { name: 'Memory map', build: memoryMapChip } },
  },
  { id: 'sharedbus', name: 'Shared bus', blurb: 'Two tri-state drivers and a pull-down on one wire: a value, a held 0, or a fight (X).', build: sharedBusChip },
  { id: 'wiredand', name: 'Wired-AND', blurb: 'Open-drain NMOS stages and a pull-up: the wire is 1 only when every stage lets go.', build: (id, n) => wiredChip(id, n, 'and') },
  { id: 'wiredor', name: 'Wired-OR', blurb: 'Open-source PMOS stages and a pull-down: the wire is 1 when any stage pulls it up.', build: (id, n) => wiredChip(id, n, 'or') },
];

/** Add an example as a new chip (fresh id and name), with its sub-chips, and open it. */
export function addExample(ws: Workspace, ex: Example): { ws: Workspace; id: string } {
  const id = uniqueName(`u_${slug(ex.id)}`, Object.keys(ws.chips));
  const name = uniqueName(ex.name, Object.values(ws.chips).map((c) => c.name));
  const chips = { ...ws.chips };
  const sub: Record<string, string> = {};
  for (const [k, c] of Object.entries(ex.subchips ?? {})) {
    const sid = uniqueName(`${id}_${k}`, [...Object.keys(chips), id]);
    chips[sid] = c.build(sid, uniqueName(c.name, Object.values(chips).map((x) => x.name)));
    sub[k] = sid;
  }
  chips[id] = ex.build(id, name, sub);
  return { ws: openChip({ ...ws, chips }, id), id };
}
