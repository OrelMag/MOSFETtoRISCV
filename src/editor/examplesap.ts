// Examples ▸ SAP-1 breadboard computer: Appendix C's machine (lib/sap.ts) as sandbox chips, the way example4.ts does
// the 4-bit CPU. The top level is docFromDef's drawing of SAP_COMPUTER with each module (Ben Eater's breadboards: clock,
// PC, MAR, RAM, IR, control, A, ALU, flags, B, output, display, bus) a user chip of its own, so it opens and edits like
// one the learner drew, and keeps opening down to the 74xx chips and their NANDs. The computer's pins become the parts
// they stand for: a PROG switch, DIP switches for the address and the data, a WRITE key, the display's three digits and
// OUT's value, LEDs on the bus, a clash LED and a halt part.
//
// The program: the RAM chip's two 74LS189s are placed as ls189_i<nibbles> (lib/ttl.ts ls189With), a 189 that holds
// its 16 nibbles at power-on. A chip document can only give power-on values to its own wires, and the 189's latches
// are three levels inside it; the part's id can carry them, as a RAM part's initial contents ride in its ref. So the
// program survives Reset and a page load, and Load program (the CPU drawer) or the DIP switches change it.

import { SAP_ALU, SAP_AREG, SAP_BREG, SAP_BUS, SAP_CLOCK, SAP_COMPUTER, SAP_CONTROL, SAP_DISPLAY, SAP_FLAGS, SAP_IR, SAP_MAR, SAP_OUT, SAP_PC, SAP_RAM } from '../lib/sap';
import { ls189With } from '../lib/ttl';
import { sapBytes } from '../sap/asm';
import { SAP_PROGRAMS } from '../sap/programs';
import { instPort } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import { docFromDef } from './fromdef';
import { UserLibrary } from './library';
import { lintChip } from './lint';
import { type ChipDoc, emptyWorkspace, type PartDoc, type PartRef, polyline } from './model';
import { isError, partDef } from './parts';
import { collapseWires } from './unravel';

/** The modules: sub-chip key (the top instance's name) → library module. */
export const SAP_BLOCKS: Record<string, ComponentDef> = {
  clock: SAP_CLOCK, pc: SAP_PC, mar: SAP_MAR, ram: SAP_RAM, ir: SAP_IR, ctl: SAP_CONTROL, a: SAP_AREG,
  alu: SAP_ALU, flags: SAP_FLAGS, b: SAP_BREG, out: SAP_OUT, disp: SAP_DISPLAY, bus: SAP_BUS,
};

const BLOCK_NAMES: Record<string, string> = {
  clock: 'Clock', pc: 'Program counter', mar: 'Memory address register', ram: 'RAM', ir: 'Instruction register', ctl: 'Control logic',
  a: 'A register', alu: 'ALU', flags: 'Flags register', b: 'B register', out: 'Output register', disp: 'Output display', bus: 'Bus',
};

const BLOCK_HUES: Record<string, number> = {
  clock: 50, pc: 210, mar: 180, ram: 150, ir: 260, ctl: 290, a: 20, alu: 0, flags: 330, b: 30, out: 95, disp: 120, bus: 230,
};

/** The sample the example starts with. */
export const SAP_EXAMPLE_PROGRAM = SAP_PROGRAMS.find((p) => p.id === 'fib')!;

function must(doc: ChipDoc | { error: string }): ChipDoc {
  if ('error' in doc) throw new Error(`SAP-1 example: ${doc.error}`);
  return doc;
}

/**
 * The drawing with no two nets on one line (the sandbox's lint): where docFromDef's wires of two nets share a line (its
 * router leaves a pin's stub on another net's run), one of them becomes a pair of pointers, as a schematic would label it.
 * `chips`: the user chips the drawing places.
 */
export function untangled(doc: ChipDoc, chips: Record<string, ChipDoc> = {}): ChipDoc {
  for (let round = 0; round < 16; round++) {
    const lib = new UserLibrary({ ...emptyWorkspace(), chips: { ...chips, [doc.id]: doc } });
    const built = lib.compiled(doc.id);
    if (!built) return doc;
    const defOf = (p: { ref: PartRef }) => {
      const d = 'chip' in p.ref ? lib.defOf(p.ref.chip) : partDef(p.ref, (x) => lib.defOf(x));
      return !d || 'error' in d ? undefined : d;
    };
    const polys = new Map(doc.wires.flatMap((w) => { const p = polyline(doc, w, defOf); return p ? [[w.id, p] as const] : []; }));
    const clash = lintChip(doc, built, polys).diags.find((d) => d.msg.startsWith('two nets drawn on one line') && d.wires?.length);
    if (!clash) return doc;
    // the net with fewer wires on that line becomes pointers
    const byNet = new Map<number, string[]>();
    for (const w of clash.wires!) {
      const n = built.netOfWire.get(w) ?? -1;
      byNet.set(n, [...(byNet.get(n) ?? []), w]);
    }
    const pick = [...byNet.values()].sort((a, b) => a.length - b.length)[0];
    const r = collapseWires(doc, pick, defOf);
    if (r.reason || r.doc === doc) return doc;
    doc = r.doc;
  }
  return doc;
}

/** The RAM chip's two 189s (instance names in SAP_RAM): the low and the high nibble of each byte. */
export const SAP_RAM_CHIPS = { lo: 'lo', hi: 'hi' } as const;

/** The 189s' refs holding `bytes` (16 at most; the rest 0). */
export function sapRamRefs(bytes: ArrayLike<number>): { lo: PartRef; hi: PartRef } {
  const b = Array.from({ length: 16 }, (_, i) => (bytes[i] ?? 0) & 0xff);
  return { lo: { lib: ls189With(b.map((x) => x & 15)).id }, hi: { lib: ls189With(b.map((x) => x >> 4)).id } };
}

/** A RAM chip (a sub-chip of the example) with `bytes` loaded into its 189s. */
export function withSapProgram(doc: ChipDoc, bytes: ArrayLike<number>): ChipDoc {
  const refs = sapRamRefs(bytes);
  return { ...doc, parts: doc.parts.map((p) => (p.id === SAP_RAM_CHIPS.lo ? { ...p, ref: refs.lo } : p.id === SAP_RAM_CHIPS.hi ? { ...p, ref: refs.hi } : p)) };
}

/** A module of the SAP-1 as a user chip (the RAM with `bytes` in it). */
export function sapBlockChip(key: string, bytes: ArrayLike<number> = sapBytes(SAP_EXAMPLE_PROGRAM.src)) {
  return (id: string, name: string): ChipDoc => {
    const doc: ChipDoc = { ...untangled(must(docFromDef(SAP_BLOCKS[key], { id, name }))), hue: BLOCK_HUES[key], notes: SAP_BLOCKS[key].summary };
    return key === 'ram' ? withSapProgram(doc, bytes) : doc;
  };
}

/** The example's sub-chips, for EXAMPLES. */
export const SAP_SUBCHIPS = Object.fromEntries(Object.keys(SAP_BLOCKS).map((k) => [k, { name: BLOCK_NAMES[k], build: sapBlockChip(k) }]));

/** The computer's pins and the parts that take their place: [pin, part ref, the part's port, label]. */
const PIN_PARTS: [string, PartRef, string, string][] = [
  ['prog', { switches: 1 }, 'q', 'PROG'],
  ['addrSw', { switches: 4 }, 'q', 'address'],
  ['dataSw', { switches: 8 }, 'q', 'data'],
  ['write', { key: 'w' }, 'q', 'WRITE (W)'],
  ['bus', { display: 'led', width: 8 }, 'a', 'bus'],
  ['out', { display: 'value', width: 8 }, 'a', 'OUT'],
  ['d0', { display: 'seg7', width: 8 }, 'a', 'ones'],
  ['d1', { display: 'seg7', width: 8 }, 'a', 'tens'],
  ['d2', { display: 'seg7', width: 8 }, 'a', 'hundreds'],
  ['halt', { display: 'halt', width: 1 }, 'a', 'halt'],
  ['clash', { display: 'led', width: 1 }, 'a', 'bus clash'],
];

export const SAP_NOTES = 'Ben Eater\'s 8-bit breadboard computer (SAP-1, after Malvino and Brown), one user chip per breadboard, each built from 74xx chips you can open down to NANDs. '
  + '16 bytes of RAM hold the program (Fibonacci to start with); every instruction takes five clock steps T0–T4, each a 16-bit control word read from the control logic\'s two EEPROMs. '
  + 'Run (or Run to halt in the CPU drawer, which checks every register, the bus and the RAM against the golden model at every clock): the numbers show on the digits and OUT; HLT stops the clock. '
  + 'Load program… in the CPU drawer puts another sample (or your own SAP-1 assembly) into the RAM. Or program it by hand, as on the breadboard: PROG on, set an address and a byte on the DIP switches, press W, and so on for each byte; PROG off, then Run. '
  + 'The bus is a wired OR of the modules\' 74LS245s; the clash LED lights if two drive it at once.';

/** The example's top level; `sub` maps SAP_BLOCKS keys to the sub-chips' ids. */
export function sapChip(id: string, name: string, sub: Record<string, string>, docs: Record<string, ChipDoc> = {}): ChipDoc {
  const blockKey = new Map(Object.entries(SAP_BLOCKS).map(([k, d]) => [d, k]));
  const doc = must(docFromDef(SAP_COMPUTER, {
    id, name,
    refOf: (d) => {
      const k = blockKey.get(d);
      return k ? { chip: sub[k] } : undefined;
    },
  }));
  const parts: PartDoc[] = doc.parts.map((p) => {
    const k = Object.entries(sub).find(([, cid]) => 'chip' in p.ref && p.ref.chip === cid)?.[0];
    return k ? { ...p, label: BLOCK_NAMES[k] } : p;
  });
  const wires = doc.wires.map((w) => ({ ...w }));
  const pins = doc.pins.filter((pin) => {
    const pp = PIN_PARTS.find(([n]) => n === pin.id);
    if (!pp) return true;
    const [, ref, port, label] = pp;
    const pd = partDef(ref, () => undefined);
    if (isError(pd)) throw new Error(`SAP-1 example: ${pd.error}`);
    const off = instPort(pd, [0, 0], false, port).pos;
    const pid = `io_${pin.id}`;
    parts.push({ id: pid, ref, at: [pin.at[0] - off[0], pin.at[1] - off[1]], label });
    for (const w of wires) {
      if ('pin' in w.a && w.a.pin === pin.id) w.a = { part: pid, port };
      if ('pin' in w.b && w.b.pin === pin.id) w.b = { part: pid, port };
    }
    return false;
  });
  // The switches and the key first: their leaves then settle to 0 before the RAM's at power-on. Relaxation walks the
  // leaves in order, and a 189 latch whose enable is still X there loses the word its hints gave it.
  const io = parts.filter((p) => p.id.startsWith('io_'));
  const chips = Object.fromEntries(Object.entries(sub).flatMap(([k, cid]) => (docs[k] ? [[cid, docs[k]]] : [])));
  return untangled({ ...doc, pins, parts: [...io, ...parts.filter((p) => !p.id.startsWith('io_'))], wires, notes: SAP_NOTES }, chips);
}
