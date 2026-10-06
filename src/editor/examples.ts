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

export interface Example {
  id: string;
  name: string;
  blurb: string;
  build(id: string, name: string): ChipDoc;
}

export const EXAMPLES: Example[] = [
  { id: 'fetch', name: 'Fetch loop', blurb: 'PC register, PC + 4 and a program ROM: the instruction fetch of a CPU.', build: (id, n) => fetchChip(id, n) },
  { id: 'counter7', name: '4-bit counter on a 7-segment display', blurb: 'A counter, a font ROM as the decoder, a 7-segment digit.', build: counterSeg7Chip },
];

/** Add an example as a new chip (fresh id and name) and open it. */
export function addExample(ws: Workspace, ex: Example): { ws: Workspace; id: string } {
  const id = uniqueName(`u_${slug(ex.id)}`, Object.keys(ws.chips));
  const name = uniqueName(ex.name, Object.values(ws.chips).map((c) => c.name));
  const doc = ex.build(id, name);
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [id]: doc } }, id), id };
}
