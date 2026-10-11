// Examples ▸ 4-bit CPU: the library's cpu4 computer (lib/cpu4.ts) as sandbox chips. The top level is
// docFromDef's drawing of it, with each block a user chip of its own (so it opens and edits like
// one the learner drew), the ROM a ROM part holding the program in 4-bit assembly, and the
// computer's pins replaced by the parts they stand for: the TEST key (Space), four switches, four
// hex digits, four LEDs and a halt part, each placed with its port where the pin was.

import type { ComponentDef } from '../sim/types';
import { instPort } from '../sim/geometry';
import { CPU4_ACC, CPU4_ALU, CPU4_DECODE, CPU4_IO, CPU4_PC, CPU4_REGS, cpu4 } from '../lib/cpu4';
import { assemble4 } from '../isa4/asm4';
import { BCD4 } from '../isa4/programs4';
import { docFromDef } from './fromdef';
import type { ChipDoc, PartDoc, PartRef } from './model';
import { isError, partDef } from './parts';

/** The example's blocks: sub-chip key → library block. */
export const CPU4_BLOCKS: Record<string, ComponentDef> = {
  pcs: CPU4_PC, dec: CPU4_DECODE, regs: CPU4_REGS, alu: CPU4_ALU, acc: CPU4_ACC, io: CPU4_IO,
};

const BLOCK_NAMES: Record<string, string> = {
  pcs: 'PC & stack', dec: 'Decode', regs: 'Index registers', alu: 'ALU 4', acc: 'Accumulator', io: 'I/O ports',
};

const BLOCK_HUES: Record<string, number> = { pcs: 210, dec: 280, regs: 150, alu: 20, acc: 330, io: 95 };

function must(doc: ChipDoc | { error: string }): ChipDoc {
  if ('error' in doc) throw new Error(`4-bit CPU example: ${doc.error}`);
  return doc;
}

/** A block of the 4-bit CPU as a user chip. */
export function cpu4BlockChip(key: string) {
  return (id: string, name: string): ChipDoc => ({
    ...must(docFromDef(CPU4_BLOCKS[key], { id, name })),
    hue: BLOCK_HUES[key],
    notes: CPU4_BLOCKS[key].summary,
  });
}

/** The example's sub-chips, for EXAMPLES. */
export const CPU4_SUBCHIPS = Object.fromEntries(Object.keys(CPU4_BLOCKS).map((k) => [k, { name: BLOCK_NAMES[k], build: cpu4BlockChip(k) }]));

/** The pins of the computer and the parts that take their place: [pin, part ref, the part's port]. */
const PIN_PARTS: [string, PartRef, string][] = [
  ['test', { key: ' ' }, 'q'],
  ['sw', { switches: 4 }, 'q'],
  ['d0', { display: 'hex', width: 4 }, 'a'], ['d1', { display: 'hex', width: 4 }, 'a'],
  ['d2', { display: 'hex', width: 4 }, 'a'], ['d3', { display: 'hex', width: 4 }, 'a'],
  ['leds', { display: 'led', width: 4 }, 'a'],
  ['halt', { display: 'halt', width: 1 }, 'a'],
];

const PIN_LABELS: Record<string, string> = { test: 'TEST', sw: 'switches', d0: 'port 0', d1: 'port 1', d2: 'port 2', d3: 'port 3', leds: 'port 4', halt: 'halt' };

export const CPU4_NOTES = 'A 4-bit accumulator machine with the Intel 4004\'s instructions, one per 16-bit ROM word and one per clock. '
  + 'Double-click a block to open it (PC & stack, Decode, Index registers, ALU, Accumulator, I/O ports) and keep going down to NANDs. '
  + 'The program ROM holds 4-bit assembly: Edit program… for the samples (BCD addition, a counter, the switches, a subroutine, the TEST key). '
  + 'SRC Pn picks the port (the pair\'s high nibble: 0–3 the digits, 4 the LEDs), WRR writes A to it; RDR reads the switches; JCN TZ / TN test the TEST key (Space). '
  + 'Run (or Run to halt in the CPU drawer, which checks every register against the golden model): the BCD sample shows 1234 + 5876 = 7110 and halts on JUN to itself. '
  + 'Cost: about 3 400 NANDs without the ROM, against 48 000 for the single-cycle RV32I.';

/** The example's top level; `sub` maps CPU4_BLOCKS keys to the sub-chips' ids. */
export function cpu4Chip(id: string, name: string, sub: Record<string, string>, src = BCD4): ChipDoc {
  const def = cpu4(assemble4(src).words);
  const blockKey = new Map(Object.entries(CPU4_BLOCKS).map(([k, d]) => [d, k]));
  const doc = must(docFromDef(def, {
    id, name,
    refOf: (d) => {
      const k = blockKey.get(d);
      if (k) return { chip: sub[k] };
      if (d.id.startsWith('cpu4_rom_')) return { rom: { k: 8, w: 16, addr: 'word', lang: 'cpu4', src } };
      return undefined;
    },
  }));
  const parts: PartDoc[] = doc.parts.map((p) => {
    const k = Object.entries(sub).find(([, cid]) => 'chip' in p.ref && p.ref.chip === cid)?.[0];
    return k ? { ...p, label: BLOCK_NAMES[k] } : p.id === 'rom' ? { ...p, label: 'program' } : p;
  });
  const wires = doc.wires.map((w) => ({ ...w }));
  const pins = doc.pins.filter((pin) => {
    const pp = PIN_PARTS.find(([n]) => n === pin.id);
    if (!pp) return true;
    const [, ref, port] = pp;
    const pd = partDef(ref, () => undefined);
    if (isError(pd)) throw new Error(`4-bit CPU example: ${pd.error}`);
    const off = instPort(pd, [0, 0], false, port).pos;
    const pid = `io_${pin.id}`;
    parts.push({ id: pid, ref, at: [pin.at[0] - off[0], pin.at[1] - off[1]], label: PIN_LABELS[pin.id] });
    for (const w of wires) {
      if ('pin' in w.a && w.a.pin === pin.id) w.a = { part: pid, port };
      if ('pin' in w.b && w.b.pin === pin.id) w.b = { part: pid, port };
    }
    return false;
  });
  return { ...doc, pins, parts, wires, notes: CPU4_NOTES };
}
