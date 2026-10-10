// Example chips the sandbox can load (Examples ▸): small circuits that show a part at work, each
// added as a new chip (never over the user's). Plain documents, built here with terse helpers;
// the tests compile and run every one.

import type { ChipDoc, EndRef, LabelDoc, PartDoc, PartRef, PinDoc, Vec, WireDoc, Workspace } from './model';
import { slug, uniqueName } from './model';
import { SEG7_FONT } from './memory';
import { openChip } from './session';

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
      part('xy', { split: [4, 4] }, [26, 1]),
      part('colour', { switches: 4 }, [20, 12]),
      part('write', { const: { width: 1, value: 1 } }, [31, 7]),
      part('scr', { screen: { mode: 'write', size: 16, color: 'pal16' } }, [36, 0]),
    ],
    wires: [
      wire('clk', 'pin:clk', 'cnt.clk'), wire('clk2', 'pin:clk', 'scr.clk'),
      wire('en', 'one.y', 'cnt.en'), wire('we', 'write.y', 'scr.we'),
      wire('q', 'cnt.q', 'xy.in'),
      wire('x', 'xy.o0', 'scr.x'), wire('y', 'xy.o1', 'scr.y'),
      wire('c', 'colour.q', 'scr.color', [[35, 14], [35, 6]]),
    ],
  });
}

export interface Example {
  id: string;
  name: string;
  blurb: string;
  build(id: string, name: string): ChipDoc;
}

export const EXAMPLES: Example[] = [
  { id: 'fetch', name: 'Fetch loop', blurb: 'PC register, PC + 4 and a program ROM: the instruction fetch of a CPU.', build: (id, n) => fetchChip(id, n) },
  { id: 'counter7', name: '4-bit counter on a 7-segment display', blurb: 'A counter, a font ROM as the decoder, a 7-segment digit.', build: counterSeg7Chip },
  { id: 'console', name: 'Console: hello', blurb: 'A counter walks a ROM holding a message; a console prints it, a character per clock edge.', build: consoleChip },
  { id: 'screen', name: 'Screen: a sweeping beam', blurb: 'A counter sweeps a 16 × 16 screen pixel by pixel in the colour set on four switches.', build: screenChip },
  { id: 'sharedbus', name: 'Shared bus', blurb: 'Two tri-state drivers and a pull-down on one wire: a value, a held 0, or a fight (X).', build: sharedBusChip },
  { id: 'wiredand', name: 'Wired-AND', blurb: 'Open-drain NMOS stages and a pull-up: the wire is 1 only when every stage lets go.', build: (id, n) => wiredChip(id, n, 'and') },
  { id: 'wiredor', name: 'Wired-OR', blurb: 'Open-source PMOS stages and a pull-down: the wire is 1 when any stage pulls it up.', build: (id, n) => wiredChip(id, n, 'or') },
];

/** Add an example as a new chip (fresh id and name) and open it. */
export function addExample(ws: Workspace, ex: Example): { ws: Workspace; id: string } {
  const id = uniqueName(`u_${slug(ex.id)}`, Object.keys(ws.chips));
  const name = uniqueName(ex.name, Object.values(ws.chips).map((c) => c.name));
  const doc = ex.build(id, name);
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [id]: doc } }, id), id };
}
