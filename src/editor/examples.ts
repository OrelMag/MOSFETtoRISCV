// Example chips the sandbox can load (Examples ▸): small circuits that show a part at work, each
// added as a new chip (never over the user's). Plain documents, built here with terse helpers;
// the tests compile and run every one.

import type { ChipDoc, EndRef, LabelDoc, PartDoc, PartRef, PinDoc, Vec, WireDoc, Workspace } from './model';
import { slug, uniqueName } from './model';
import { MAX_FOLDERS, MAX_FOLDER_NAME, moveToFolder, newFolderName } from './folders';
import { SEG7_FONT } from './memory';
import { openChip } from './session';
import { PICTURE } from '../riscv/ioprograms';
import { CPU4_SUBCHIPS, cpu4Chip } from './example4';
import { dspChip } from './exampledsp';
import { BENCH24 } from '../dsp/programs24';
import { computer6502Chip, memory6502Chip } from './example6502';
import { SAP_SUBCHIPS, sapChip } from './examplesap';
import { busSystemChip } from './examplebus';
import { rv64Chip, rvcChip } from './exampleisa';
import { cardsBootChip } from './examplecards';
import { twoComputersChip, uartComputerChip } from './examplecomms';
import { lanComputerChip, lanSwitchChip, lanTopChip } from './examplenet';
import { add4VerilogChip, sameAdderChip } from './examplehdl';
import { PONG_HZ, pongChip } from '../campaign/bench';
import { numOf } from '../chapters/order';

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
    pins: [pin('clk', 'in', [2, 18], 1, { kind: 'clock' }), pin('instr', 'out', [56, 13], 32), pin('pc', 'out', [56, 21], 32)],
    parts: [
      part('pcr', { lib: 'reg32' }, [12, 10], { label: 'PC' }), part('one', { const: { width: 1, value: 1 } }, [3, 13]),
      part('inc', { lib: 'plus4' }, [22, 2], { flip: true }),
      part('rom', { rom: { k: rom.k, w: 32, addr: 'rv32', lang: 'asm', src: rom.src } }, [34, 11], { label: 'program' }),
    ],
    // the loop: q through the pc pointers (the editor ladder's lesson) to the incrementer above the register (it faces left), its
    // sum down into d; en and clk come in below it, so nothing crosses
    labels: [lbl('p1', 'pc', [30, 9], 'up'), lbl('p2', 'pc', [30, 4], 'right')],
    wires: [
      wire('clk', 'pin:clk', 'pcr.clk'), wire('en', 'one.y', 'pcr.en'),
      wire('q', 'pcr.q', 'rom.addr'),
      wire('qo', { wire: 'q', at: [26, 13] }, 'pin:pc', [[26, 21]]),
      wire('qp', { wire: 'q', at: [30, 13] }, 'lbl:p1'),
      wire('ia', 'lbl:p2', 'inc.a'),
      wire('nx', 'inc.y', 'pcr.d', [[8, 4], [8, 12]]),
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
 * The computer's memory side: the address decoder (what a load or store selects; ioprograms.ts has
 * the map), 4K words of RAM, the read multiplexer and the buses it hands the devices. Bit 31
 * clear: RAM. Bits 31:30 = 11: the screen, its column and row address bits 7:2 and 13:8. 10: the
 * devices, told apart by bits 3:2 (console, LEDs, switches; partial decoding, so they repeat every
 * 16 bytes). A store raises one write enable; a load reads RAM, or the LEDs / switches
 * zero-extended. The devices take the low byte of the store data.
 */
export function memoryChip(id: string, name: string): ChipDoc {
  return chip(id, name, {
    notes: 'The memory side of the computer. RAM: addr[31] = 0 (4K words, word address addr[13:2]). Screen: addr[31:30] = 11, x = addr[7:2], y = addr[13:8]. Devices: addr[31:30] = 10, then addr[3:2] picks the console (00, write), the LEDs (01) or the switches (10, read). A store (we) raises the write enable of the one it selects; a load returns RAM or a device, zero-extended. byte = wdata[7:0] is what a store hands the devices.',
    hue: 200,
    pins: [
      pin('addr', 'in', [0, 8], 32), pin('wdata', 'in', [0, 12], 32), pin('we', 'in', [0, 17]), pin('leds', 'in', [0, 38], 8), pin('sw', 'in', [0, 40], 8),
      pin('clk', 'in', [0, 46], 1, { kind: 'clock' }),
      pin('scrWe', 'out', [66, 10]), pin('conWe', 'out', [66, 14]), pin('ledWe', 'out', [66, 16]), pin('rdata', 'out', [66, 39], 32),
      pin('x', 'out', [66, 50], 6), pin('y', 'out', [66, 52], 6), pin('byte', 'out', [66, 57], 8),
    ],
    parts: [
      part('sa', { split: [2, 1, 1, 26, 1, 1] }, [12, 2]), part('sel', { merge: [1, 1] }, [16, 4]),
      part('n30', { lib: 'not' }, [20, 18]), part('n31', { lib: 'not' }, [24, 24]),
      part('io', { lib: 'and' }, [30, 14], { label: 'I/O store' }), part('ramst', { lib: 'and' }, [30, 22], { label: 'RAM store' }),
      part('scr', { lib: 'and' }, [40, 10], { label: 'screen' }), part('dev', { lib: 'and' }, [40, 16], { label: 'device' }),
      part('dec', { lib: 'dec2e' }, [50, 12], { label: 'device select' }),
      part('z8', { const: { width: 8, value: 0 } }, [28, 35]), part('z24', { const: { width: 24, value: 0 } }, [36, 30]),
      part('dm', { lib: 'mux4x8' }, [36, 34], { label: 'device read' }), part('zx', { merge: [8, 24] }, [44, 38]),
      part('rm', { lib: 'mux2x32' }, [50, 36], { label: 'RAM / device' }),
      part('ra', { split: [2, 12, 18] }, [28, 49]),
      part('ram', { ram: { k: 12, w: 32 } }, [36, 50], { label: 'RAM 4K × 32' }),
      part('xy', { split: [2, 6, 6, 18] }, [58, 47]), part('bs', { split: [8, 24] }, [58, 56]),
    ],
    labels: [
      lbl('s1', 'sel', [20, 6], 'up'), lbl('s2', 'sel', [38, 44], 'down'), lbl('t1', 'a31', [12, 21], 'left'), lbl('t2', 'a31', [52, 42], 'down'),
      lbl('a0', 'addr', [4, 5], 'up'), lbl('a1', 'addr', [28, 52], 'left'), lbl('a2', 'addr', [58, 51], 'left'),
      lbl('w0', 'wdata', [2, 12], 'right'), lbl('w1', 'wdata', [36, 54], 'left'), lbl('w2', 'wdata', [58, 58], 'left'),
      lbl('e0', 'ramWe', [36, 24], 'right'), lbl('e1', 'ramWe', [36, 56], 'left'),
      lbl('d0', 'ramData', [48, 30], 'up'), lbl('d1', 'ramData', [50, 54], 'right'),
      lbl('k0', 'clk', [2, 46], 'right'), lbl('k1', 'clk', [43, 58], 'down'),
    ],
    wires: [
      wire('addr', 'pin:addr', 'sa.in', [], { name: 'addr' }), wire('ap', { wire: 'addr', at: [4, 8] }, 'lbl:a0'),
      wire('a2', 'sa.o1', 'sel.i0'), wire('a3', 'sa.o2', 'sel.i1'),
      wire('a30', 'sa.o4', 'scr.a', [], { name: 'a30' }), wire('a30n', { wire: 'a30', at: [17, 11] }, 'n30.a', [[17, 19]]),
      wire('a31', 'sa.o5', 'n31.a', [[15, 13], [15, 25]], { name: 'a31' }), wire('a31i', { wire: 'a31', at: [15, 15] }, 'io.a'),
      wire('a31p', { wire: 'a31', at: [15, 21] }, 'lbl:t1'),
      wire('we', 'pin:we', 'io.b'), wire('wer', { wire: 'we', at: [26, 17] }, 'ramst.a', [[26, 23]]),
      wire('nr', 'n31.y', 'ramst.b'), wire('nd', 'n30.y', 'dev.b'),
      wire('io', 'io.y', 'scr.b', [[37, 16], [37, 13]], { name: 'I/O store' }), wire('iod', { wire: 'io', at: [37, 16] }, 'dev.a', [[37, 17]]),
      wire('den', 'dev.y', 'dec.en'),
      wire('sel', 'sel.out', 'dec.a', [[46, 6], [46, 16]], { name: 'sel' }), wire('selp', { wire: 'sel', at: [20, 6] }, 'lbl:s1'),
      wire('scrWe', 'scr.y', 'pin:scrWe', [[47, 12], [47, 10]]),
      wire('conWe', 'dec.y0', 'pin:conWe'), wire('ledWe', 'dec.y1', 'pin:ledWe'), wire('ramWe', 'ramst.y', 'lbl:e0'),
      wire('z0', 'z8.y', 'dm.d0'), wire('z3', { wire: 'z0', at: [35, 36] }, 'dm.d3', [[35, 42]]),
      wire('leds', 'pin:leds', 'dm.d1'), wire('sw', 'pin:sw', 'dm.d2'), wire('dsel', 'lbl:s2', 'dm.s'),
      wire('dv', 'dm.y', 'zx.i0'), wire('zh', 'z24.y', 'zx.i1', [[43, 31], [43, 41]]),
      wire('dev32', 'zx.out', 'rm.b'), wire('rd', 'lbl:d0', 'rm.a', [[48, 38]]),
      wire('rsel', 'lbl:t2', 'rm.s'), wire('rdata', 'rm.y', 'pin:rdata'),
      wire('wd', 'pin:wdata', 'lbl:w0'), wire('kp', 'pin:clk', 'lbl:k0'),
      wire('ra', 'lbl:a1', 'ra.in'), wire('rw', 'ra.o1', 'ram.addr'), wire('rdin', 'lbl:w1', 'ram.din'), wire('rwe', 'lbl:e1', 'ram.we'),
      wire('rdo', 'ram.dout', 'lbl:d1'), wire('rk', 'lbl:k1', 'ram.clk'),
      wire('xa', 'lbl:a2', 'xy.in'), wire('x', 'xy.o1', 'pin:x'), wire('y', 'xy.o2', 'pin:y'),
      wire('bi', 'lbl:w2', 'bs.in'), wire('bo', 'bs.o0', 'pin:byte'),
    ],
  });
}

/**
 * The computer's small devices, at 0x8000_0000: a console (a store prints the low byte), eight
 * LEDs behind a latch, eight switches. The memory side raises their write enables.
 */
export function devicesChip(id: string, name: string, at = 'at 0x8000_0000'): ChipDoc {
  return chip(id, name, {
    notes: `The devices ${at}: the console prints byte on a clock edge with conWe = 1, the LED latch takes byte with ledWe = 1, and the memory side reads the switches back (sw). Flip the switches here, on the I/O bar or in the Screens panel.`,
    hue: 140,
    pins: [
      pin('byte', 'in', [0, 4], 8), pin('conWe', 'in', [0, 6]), pin('ledWe', 'in', [0, 24]), pin('clk', 'in', [0, 28], 1, { kind: 'clock' }),
      pin('leds', 'out', [38, 27], 8), pin('sw', 'out', [38, 34], 8),
    ],
    parts: [
      part('con', { console: { cols: 32, rows: 8 } }, [8, 2], { label: 'console' }),
      part('ledr', { lib: 'reg8' }, [8, 20], { label: 'LED latch' }), part('leds', { display: 'led', width: 8 }, [22, 22]),
      part('sw', { switches: 8 }, [8, 32], { label: 'switches' }),
    ],
    labels: [lbl('b0', 'byte', [4, 2], 'up'), lbl('b1', 'byte', [8, 22], 'left'), lbl('k0', 'clk', [4, 30], 'down'), lbl('k1', 'clk', [10, 14], 'down')],
    wires: [
      wire('byte', 'pin:byte', 'con.data', [], { name: 'byte' }), wire('bp', { wire: 'byte', at: [4, 4] }, 'lbl:b0'),
      wire('we', 'pin:conWe', 'con.we'), wire('ck', 'lbl:k1', 'con.clk'),
      wire('ld', 'lbl:b1', 'ledr.d'), wire('len', 'pin:ledWe', 'ledr.en'),
      wire('clk', 'pin:clk', 'ledr.clk', [[12, 28]], { name: 'clk' }), wire('kp', { wire: 'clk', at: [4, 28] }, 'lbl:k0'),
      wire('lq', 'ledr.q', 'leds.a', [], { name: 'leds' }), wire('lo', { wire: 'lq', at: [19, 23] }, 'pin:leds', [[19, 27]]),
      wire('swq', 'sw.q', 'pin:sw'),
    ],
  });
}

const PIPE_NOTES = 'A whole computer around the five-stage pipelined RV32I core (open it: fetch, decode, execute, memory, writeback with forwarding, load-use stalls and branch flushes). It fetches from the program ROM and reaches RAM, the screen, the console, the LEDs and the switches through the memory side from its M stage, with the timing of the single-cycle core port: the address goes out and the word comes back in the same cycle, a store lands at the clock edge. RAM 0x0000_0000 (4K words), console 0x8000_0000, LEDs 0x8000_0004, switches 0x8000_0008, screen 0xC000_0000 + 256·y + 4·x (64 × 64, RGB332). Word loads and stores only. Run (or Run to halt in the CPU drawer, which shows the pipeline diagram and checks every retired instruction against the golden model); Custom… adds your own instructions to it. The halt part stops Run once "j ." (jal x0, 0) has gone round again: three clocks after its first fetch, because the pipeline fetches it, a wrong-path word, then it again, and two more clocks for the older instructions to finish.';

/**
 * The pipelined computer's halt: `j .` (jal x0, 0) is fetched, goes round the pipeline (fetch, a wrong-path word, then it again: three
 * clocks later) and is told apart from a `j .` fetched on a flushed path by that repeat; two more clocks let the older instructions
 * finish before the halt part reads 1.
 */
export function haltChip(id: string, name: string): ChipDoc {
  const at = (n: number): Vec => [18 + 12 * n + (n > 2 ? 8 : 0), (n > 2 ? 4 : 5) + n];
  const dffs = [0, 1, 2, 3, 4].map((n) => part(`h${n + 1}`, { lib: 'dff' }, at(n)));
  return chip(id, name, {
    notes: 'Raises halted two clocks after the instruction word jal x0, 0 (j .) has been seen in fetch twice, three clocks apart: the first fetch, the word behind it (flushed) and the loop coming round. Every older instruction has retired by then. A single-cycle core needs no such wait: its halt part watches the instruction word itself.',
    hue: 200,
    pins: [pin('instr', 'in', [0, 6], 32), pin('clk', 'in', [0, 17], 1, { kind: 'clock' }), pin('halted', 'out', [84, 11])],
    parts: [part('hj', { const: { width: 32, value: 0x6f } }, [2, 9], { label: 'j .' }), part('eq', { lib: 'eq32' }, [8, 4]), ...dffs, part('hg', { lib: 'and' }, [54, 7], { label: 'again' })],
    wires: [
      wire('ins', 'pin:instr', 'eq.a'), wire('hb', 'hj.y', 'eq.b'),
      wire('d1', 'eq.eq', 'h1.d', [], { name: 'isJ' }), wire('d2', 'h1.q', 'h2.d'), wire('d3', 'h2.q', 'h3.d'),
      wire('ga', { wire: 'd1', at: [16, 7] }, 'hg.a', [[16, 1], [52, 1], [52, 8]]), wire('gb', 'h3.q', 'hg.b'),
      wire('d4', 'hg.y', 'h4.d'), wire('d5', 'h4.q', 'h5.d'), wire('out', 'h5.q', 'pin:halted'),
      ...[0, 1, 2, 3, 4].map((n) => wire(`k${n + 1}`, 'pin:clk', `h${n + 1}.clk`, [[at(n)[0] - 2, 17], [at(n)[0] - 2, at(n)[1] + 4]])),
    ],
  });
}

/** The computer's pointers: [id, name, at, face, the end they join]. */
type Ptr = [string, string, Vec, LabelDoc['face'], string];
const COMPUTER_PTRS: Ptr[] = [
  ['c0', 'clk', [19, 12], 'left', 'cpu.clk'], ['c1', 'rdata', [20, 21], 'left', 'cpu.memRData'], ['c2', 'clk', [4, 26], 'right', 'pin:clk'],
  ['m0', 'leds', [42, 24], 'left', 'mem.leds'], ['m1', 'sw', [42, 26], 'left', 'mem.sw'], ['m2', 'clk', [42, 28], 'left', 'mem.clk'],
  ['o0', 'scrWe', [56, 17], 'right', 'mem.scrWe'], ['o1', 'conWe', [56, 19], 'right', 'mem.conWe'], ['o2', 'ledWe', [56, 21], 'right', 'mem.ledWe'],
  ['o3', 'rdata', [56, 23], 'right', 'mem.rdata'], ['o4', 'x', [56, 25], 'right', 'mem.x'], ['o5', 'y', [56, 27], 'right', 'mem.y'],
  ['o6', 'byte', [56, 29], 'right', 'mem.byte'],
  ['s0', 'x', [6, 38], 'left', 'scr.x'], ['s1', 'y', [6, 40], 'left', 'scr.y'], ['s2', 'byte', [6, 42], 'left', 'scr.color'], ['s3', 'scrWe', [6, 44], 'left', 'scr.we'],
  ['s4', 'clk', [8, 64], 'down', 'scr.clk'],
  ['d0', 'byte', [44, 39], 'left', 'dev.byte'], ['d1', 'conWe', [44, 41], 'left', 'dev.conWe'], ['d2', 'ledWe', [44, 43], 'left', 'dev.ledWe'],
  ['d3', 'clk', [44, 45], 'left', 'dev.clk'], ['d4', 'leds', [58, 41], 'right', 'dev.leds'], ['d5', 'sw', [58, 43], 'right', 'dev.sw'],
];

/**
 * A RISC-V computer: the single-cycle RV32I core (its data side a memory port), a 1K-word program
 * ROM, the memory side (`mem`: the address decoder and 4K words of RAM, a user chip of its own), a
 * 64 × 64 screen and the devices (`dev`: console, LEDs, switches). The memory port runs straight
 * into the memory side; the buses it hands each device are pointers. A halt part watches for
 * `j .` (jal x0, 0: 0x0000006f), so Run stops when the program ends; the CPU drawer runs the
 * golden model in lock-step.
 */
export function computerChip(id: string, name: string, sub: { mem: string; dev: string; halt?: string }, src = PICTURE, pipe = false): ChipDoc {
  // the pipelined core: its ports are the single-cycle core's without the hart id and the grant; a `j .` is seen in fetch, so the halt part
  // waits for the loop to come round again (a flushed fetch past a taken branch shows it once) and for the older instructions to finish
  const cpuAt: Vec = pipe ? [18, 10] : [20, 10];
  const ptrs: Ptr[] = (pipe ? [...COMPUTER_PTRS, ['c3', 'clk', [12, 7], 'left', 'hlt.clk'] as Ptr] : COMPUTER_PTRS).map((p) => (!pipe ? p : p[0] === 'c0' ? ['c0', 'clk', [17, 12], 'left', 'cpu.clk'] : p[0] === 'c1' ? ['c1', 'rdata', [18, 19], 'left', 'cpu.memRData'] : p));
  return chip(id, name, {
    notes: pipe ? PIPE_NOTES : 'A whole computer: the RV32I core fetches from the program ROM (Edit program… to change it) and reaches RAM, the screen, the console, the LEDs and the switches through the memory side (double-click it: the address decoder and the RAM). RAM 0x0000_0000 (4K words), console 0x8000_0000, LEDs 0x8000_0004, switches 0x8000_0008, screen 0xC000_0000 + 256·y + 4·x (64 × 64, RGB332). Word loads and stores only: this core has no lb / sb. Run (or Run to halt in the CPU drawer); flip the switches (on the I/O bar), Reset and Run again.',
    pins: [pin('clk', 'in', [2, 26], 1, { kind: 'clock' })],
    parts: [
      part('imem', { rom: { k: 10, w: 32, addr: 'rv32', lang: 'asm', src } }, [2, 15], { label: 'program' }),
      part('cpu', { lib: pipe ? 'rv32i_pipe_core' : 'rv32i_core' }, cpuAt, { label: pipe ? 'RV32I pipelined core' : 'RV32I core' }),
      ...(pipe ? [] : [part('hart', { const: { width: 32, value: 0 } }, [14, 18]), part('grant', { const: { width: 1, value: 1 } }, [18, 22])]),
      ...(pipe ? [part('hlt', { chip: sub.halt! }, [14, 3], { label: 'halt' })] : [part('hj', { const: { width: 32, value: 0x6f } }, [6, 5], { label: 'j .' }), part('eq', { lib: 'eq32' }, [14, 4])]),
      part('halt', { display: 'halt', width: 1 }, pipe ? [30, 5] : [22, 6]),
      part('mem', { chip: sub.mem }, [42, 15]),
      part('scr', { screen: { mode: 'write', size: 64, color: 'rgb332' } }, [6, 36], { label: 'screen' }),
      part('dev', { chip: sub.dev }, [44, 37]),
    ],
    labels: ptrs.map(([lid, n, at, face]) => lbl(lid, n, at, face)),
    wires: [
      wire('pc', 'cpu.pcOut', 'imem.addr', [[38, 12], [38, 2], [0, 2], [0, 17]], { name: 'pc' }),
      wire('instr', 'imem.data', 'cpu.instr', [], { name: 'instr' }),
      ...(pipe ? [wire('hx', { wire: 'instr', at: [13, 17] }, 'hlt.instr', [[13, 5]]), wire('hh', 'hlt.halted', 'halt.a')]
        : [wire('hx', { wire: 'instr', at: [13, 17] }, 'eq.b', [[13, 8]]), wire('hb', 'hj.y', 'eq.a'), wire('hh', 'eq.eq', 'halt.a'), wire('hart', 'hart.y', 'cpu.hartid'), wire('gr', 'grant.y', 'cpu.grant')]),
      wire('addr', 'cpu.memAddr', 'mem.addr', [], { name: 'addr' }), wire('wdata', 'cpu.memWData', 'mem.wdata', [], { name: 'wdata' }),
      wire('we', 'cpu.memWE', 'mem.we', [], { name: 'we' }),
      ...ptrs.map(([lid, , at, , e]) => wire(`p_${lid}`, `lbl:${lid}`, e, lid === 'c0' ? [[at[0], 15]] : [])),
    ],
  });
}

/** The gallery's sections (editor/examplegallery.ts), in order. */
export type ExampleGroup = 'first' | 'computers' | 'widths' | 'techniques';

export interface Example {
  id: string;
  name: string;
  /** Full description: the search rows and the card's tooltip. */
  blurb: string;
  /** One line for the gallery's card. */
  short: string;
  group: ExampleGroup;
  /** Opens with the CPU drawer (editor/cpuui.ts follows it): the gallery's tag. */
  drawer?: true;
  /** The example's chip; `sub` holds the ids given to its sub-chips, `docs` the sub-chips themselves. */
  build(id: string, name: string, sub: Record<string, string>, docs: Record<string, ChipDoc>): ChipDoc;
  /** Chips the example places (its packaged blocks), added alongside it under fresh ids and names. */
  subchips?: Record<string, { name: string; build(id: string, name: string): ChipDoc }>;
  /** A CPU running a program: its automatic clock's rate (ChipDoc.hz), so the output shows within seconds. */
  hz?: number;
}

export const EXAMPLES: Example[] = [
  { id: 'fetch', group: 'first', short: 'PC register, PC + 4 and a program ROM: the fetch of a CPU.', name: 'Fetch loop', blurb: 'PC register, PC + 4 and a program ROM: the instruction fetch of a CPU.', build: (id, n) => fetchChip(id, n) },
  { id: 'counter7', group: 'first', short: 'A counter, a font ROM as the decoder, a digit.', name: '4-bit counter on a 7-segment display', blurb: 'A counter, a font ROM as the decoder, a 7-segment digit.', build: counterSeg7Chip },
  { id: 'console', group: 'first', short: 'A counter walks a ROM and prints it.', name: 'Console: hello', blurb: 'A counter walks a ROM holding a message; a console prints it, a character per clock edge.', build: consoleChip },
  { id: 'screen', group: 'first', short: 'A counter draws on a pixel screen.', name: 'Screen: a sweeping beam', blurb: 'A counter sweeps a 16 × 16 screen pixel by pixel in the colour set on four switches.', build: screenChip },
  {
    id: 'computer', group: 'computers', drawer: true, short: 'Runs a program and draws a picture.', name: 'Computer: RISC-V with a screen and a console',
    blurb: 'An RV32I core, a program ROM, 4K words of RAM, a 64 × 64 screen, a console, LEDs and switches behind a memory map. Run: it greets, then paints.',
    build: (id, n, sub) => computerChip(id, n, { mem: sub.mem, dev: sub.dev }),
    subchips: { mem: { name: 'Memory', build: memoryChip }, dev: { name: 'Devices', build: devicesChip } },
    hz: 10000,
  },
  {
    id: 'computer-pipe', group: 'computers', drawer: true, short: 'The same computer on the pipelined core.', name: 'Computer: the pipelined RISC-V core',
    blurb: 'The computer again with the five-stage pipelined RV32I core on the same memory map: the CPU drawer draws the pipeline diagram and checks every retired instruction; Custom… adds your own instruction to it.',
    build: (id, n, sub) => computerChip(id, n, { mem: sub.mem, dev: sub.dev, halt: sub.halt }, PICTURE, true),
    subchips: { mem: { name: 'Memory', build: memoryChip }, dev: { name: 'Devices', build: devicesChip }, halt: { name: 'Halt', build: haltChip } },
    hz: 10000,
  },
  {
    id: 'cpu4', group: 'computers', drawer: true, short: 'An accumulator machine in 16-bit words.', name: '4-bit CPU (4004-inspired)',
    blurb: 'An accumulator machine with the 4004\'s instructions in six blocks you can open down to NANDs, a ROM in 4-bit assembly, four digits, LEDs, switches and a TEST key. Run: 1234 + 5876 in BCD.',
    build: (id, n, sub) => cpu4Chip(id, n, sub),
    subchips: CPU4_SUBCHIPS,
    hz: 1000,
  },
  ...BENCH24.map((b, i): Example => ({
    id: i === 0 ? 'dsp-core' : `dsp-core-${b.id}`, group: 'computers', drawer: true,
    short: i === 0 ? 'A small DSP core: two memories, a MAC, a hardware loop.' : `The DSP core running ${b.name}.`,
    name: i === 0 ? 'DSP core (FIR filter)' : `DSP core: ${b.name}`,
    blurb: `The DSP core of the "A DSP core" chapter (16-bit data, 24-bit instructions, X and Y memories read in the same clock, a MAC, a hardware loop) with a ROM in DSP24 assembly and the memories loaded with ${b.name}'s samples and coefficients. Run: ${b.outs} output words; Run to halt in the CPU drawer checks every register against the golden model.`,
    build: (id, n) => dspChip(id, n, b),
    hz: 2000,
  })),
  {
    id: 'm6502', group: 'computers', drawer: true, short: 'The part, a ROM in 6502 assembly, RAM and devices.', name: '6502 computer (1975)',
    blurb: 'The MOS 6502 (cycle-exact; open it for its transistors), a 4K ROM in 6502 assembly, 2K of RAM, a console, LEDs and switches behind a memory map. Run: the Fibonacci numbers in decimal.',
    build: (id, n, _sub, docs) => computer6502Chip(id, n, { mem: docs.mem, dev: docs.dev }),
    subchips: { mem: { name: 'Memory map', build: memory6502Chip }, dev: { name: 'Devices', build: (id, n) => devicesChip(id, n, 'at $4000 ($4000 console, $4001 LEDs, $4002 switches)') } },
    hz: 10000,
  },
  {
    id: 'sap1', group: 'computers', drawer: true, short: 'The classic 8-bit teaching computer, chip by chip.', name: 'SAP-1 breadboard computer',
    blurb: 'Ben Eater’s 8-bit breadboard computer: 13 modules of 74xx chips on one bus, 16 bytes of RAM, a microcoded control unit with five steps an instruction. Run: Fibonacci on the digits; PROG, the DIP switches and W program it by hand.',
    build: (id, n, sub, docs) => sapChip(id, n, sub, docs),
    subchips: SAP_SUBCHIPS,
    hz: 100,
  },
  {
    id: 'bussystem', group: 'computers', short: 'Masters, slaves and a boot from flash.', name: 'System on a bus',
    blurb: 'Chapter 38\'s computer: an RV32I core and a DMA engine on one bus to RAM, a flash it boots from, the DRAM of chapter 36, a screen, a keyboard and a timer. Clock rate max, Run, then type.',
    build: busSystemChip,
  },
  {
    id: 'verilog-adder', group: 'techniques', short: 'A 4-bit adder twice: library parts and synthesized.', name: 'The same adder in Verilog',
    blurb: 'A 4-bit adder twice: the library\'s ripple-carry ADD4, and one line of Verilog drawn by Yosys in the page. Compare their NANDs and depth; edit the text.',
    build: (id, n, sub, docs) => sameAdderChip(id, n, sub, docs),
    subchips: { add4: { name: 'add4', build: add4VerilogChip } },
  },
  {
    id: 'twocomputers', group: 'computers', short: 'Two computers chat over a wire.', name: 'Two computers on a wire',
    blurb: 'The last scene of chapter 43: two RV32I bus cores, each with a boot ROM, RAM, a UART and a console, joined by two line parts (a model of a cable). A sends a message, B answers it. Hold a NOISE button to corrupt a byte in flight.',
    build: (id, n, _sub, docs) => twoComputersChip(id, n, { a: docs.a, b: docs.b }),
    subchips: { a: { name: 'Computer A', build: (id, n) => uartComputerChip(id, n, 'A') }, b: { name: 'Computer B', build: (id, n) => uartComputerChip(id, n, 'B') } },
    hz: 5000,
  },
  {
    id: 'twocomputers-switch', group: 'computers', short: 'Two computers with NICs and a learning switch.', name: 'Two computers on a switch',
    blurb: `The last scene of chapter ${numOf('network')}: two RV32I bus cores, each with a boot ROM, RAM and a NIC (descriptor rings, DMA, a MAC), joined by a four-port learning switch. A sends B a frame and B answers it, three times; open the switch and select it to watch it learn. Slow: about 10 000 clocks a round trip.`,
    build: (id, n, _sub, docs) => lanTopChip(id, n, { a: docs.a, b: docs.b, sw: docs.sw }),
    subchips: {
      a: { name: 'Computer A', build: (id, n) => lanComputerChip(id, n, 'A') }, b: { name: 'Computer B', build: (id, n) => lanComputerChip(id, n, 'B') },
      sw: { name: 'Switch (two ports)', build: (id, n) => lanSwitchChip(id, n) },
    },
    hz: 5000, // finite: JSON stores Infinity as null, and a reload would run it at 2 Hz
  },
  {
    id: 'cardboot', group: 'computers', drawer: true, short: 'A deck read into RAM, then run.', name: 'Boot from cards',
    blurb: 'An RV32I core whose boot ROM reads a deck from a card reader into RAM and jumps to it, like the IBM 1401\'s Load key. Run; then drop the deck, Reset and Run, and sort it.',
    build: (id, n) => cardsBootChip(id, n),
  },
  {
    id: 'rvc', group: 'widths', drawer: true, short: '16-bit parcels beside 32-bit words.', name: 'RV32C: compressed instructions',
    blurb: 'The RV32I core with the C extension: a ROM that reads at any even address, 16-bit instructions expanded in the core, PC + 2. Run: it prints 0–9 from compressed code.',
    build: (id, n) => rvcChip(id, n),
  },
  {
    id: 'rv64', group: 'widths', drawer: true, short: 'The core at 64 bits.', name: 'RV64: 64-bit registers',
    blurb: 'The 64-bit core with its program ROM assembled for RV64: ld / sd, the W instructions, a multiply and fib(90), all 64 bits in the CPU drawer, checked against the golden model.',
    build: (id, n) => rv64Chip(id, n),
  },
  {
    id: 'rv16pong', group: 'computers', drawer: true, short: 'Pong on a screen and switches.', name: 'RV16: Pong on the campaign core',
    blurb: 'The campaign’s single-cycle RV16 core on its bench with a 32 × 32 screen and switches: Pong in RV16 assembly, the golden model in lock step. Run; switches 7 and 6 move your paddle.',
    build: pongChip,
    hz: PONG_HZ,
  },
  { id: 'sharedbus', group: 'techniques', short: 'Tri-state drivers taking turns on one line.', name: 'Shared bus', blurb: 'Two tri-state drivers and a pull-down on one wire: a value, a held 0, or a fight (X).', build: sharedBusChip },
  { id: 'wiredand', group: 'techniques', short: 'Open drains and a pull-up.', name: 'Wired-AND', blurb: 'Open-drain NMOS stages and a pull-up: the wire is 1 only when every stage lets go.', build: (id, n) => wiredChip(id, n, 'and') },
  { id: 'wiredor', group: 'techniques', short: 'Open sources and a pull-down.', name: 'Wired-OR', blurb: 'Open-source PMOS stages and a pull-down: the wire is 1 when any stage pulls it up.', build: (id, n) => wiredChip(id, n, 'or') },
];

/** Add an example as a new chip (fresh id and name), with its sub-chips, and open it. */
export function addExample(ws: Workspace, ex: Example): { ws: Workspace; id: string } {
  const id = uniqueName(`u_${slug(ex.id)}`, Object.keys(ws.chips));
  const name = uniqueName(ex.name, Object.values(ws.chips).map((c) => c.name));
  const chips = { ...ws.chips };
  const sub: Record<string, string> = {}, docs: Record<string, ChipDoc> = {};
  for (const [k, c] of Object.entries(ex.subchips ?? {})) {
    const sid = uniqueName(`${id}_${k}`, [...Object.keys(chips), id]);
    chips[sid] = docs[k] = c.build(sid, uniqueName(c.name, Object.values(chips).map((x) => x.name)));
    sub[k] = sid;
  }
  chips[id] = ex.hz ? { ...ex.build(id, name, sub, docs), hz: ex.hz } : ex.build(id, name, sub, docs);
  // the sub-chips go into a folder named after the example, not loose among the learner's own chips (one level only)
  let out: Workspace = { ...ws, chips };
  const short = (name.split(':')[0] || name).slice(0, MAX_FOLDER_NAME - 4);
  const folder = newFolderName(out, short);
  if (Object.keys(sub).length && (out.folders?.length ?? 0) < MAX_FOLDERS)
    for (const sid of Object.values(sub)) out = moveToFolder(out, sid, folder);
  return { ws: openChip(out, id), id };
}
