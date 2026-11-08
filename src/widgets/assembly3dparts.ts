// The pipeline as an assembly line, as parts (DOM-free, tested). Five stations on a belt, a pallet per fetched instruction.
// Where a pallet is comes from riscv/pipetrace.ts (held to the gate-level pipeline in tests/model-assembly.test.ts); this
// file only places it, and how far a pallet has slid since the last clock is the view's, not the pipeline's.

import type { RGB } from '../gl/instances';
import { box, type Anchor, type Part } from '../gl/parts';
import type { Cycle } from '../riscv/pipetrace';

export const STATIONS = ['Fetch', 'Decode', 'Execute', 'Memory', 'Writeback'] as const;
export const PITCH = 26;
/** A station's x on the belt; fractional stages are positions between two stations. */
export const stationX = (stage: number): number => (stage - 2) * PITCH;

export type Kind = 'alu' | 'load' | 'store' | 'ctl' | 'bubble';
export interface Pallet { seq: number; x: number; y: number; z: number; size: number; kind: Kind; wrong: boolean; text: string; /** On its way off the line: retired out of Writeback, or pulled by a flush. */ leaving?: 'retired' | 'pulled' }

/** The kind of instruction by major opcode: what the cargo is coloured by. */
export function kindOfWord(w: number): Exclude<Kind, 'bubble'> {
  switch (w & 0x7f) {
    case 0x03: return 'load';
    case 0x23: return 'store';
    case 0x63: case 0x67: case 0x6f: return 'ctl';
    default: return 'alu';
  }
}

export interface Ctx { kindOf(pc: number): Exclude<Kind, 'bubble'>; mnemonicOf(pc: number): string }

/**
 * Every pallet at cycle t, `u` of the way from the previous cycle's positions (1: settled). A new fetch comes in from the
 * left, a bubble appears where the hazard unit makes one, the item in W slides off, and the two a flush pulls are lifted
 * off the line towards the viewer.
 */
export function palletsAt(plan: readonly Cycle[], t: number, u: number, ctx: Ctx): Pallet[] {
  const cur = plan[t], prev = u < 1 && t > 0 ? plan[t - 1] : null, out: Pallet[] = [];
  const was = new Map(prev?.slots.map((s, i) => [s.seq, i]));
  const now = new Set(cur.slots.map((s) => s.seq));
  const make = (s: Cycle['slots'][number], x: number, wrong: boolean, o: Partial<Pallet> = {}): Pallet =>
    ({ seq: s.seq, x, y: 0, z: 0, size: 1, kind: s.valid ? ctx.kindOf(s.pc) : 'bubble', wrong, text: s.valid ? ctx.mnemonicOf(s.pc) : 'bubble', ...o });
  cur.slots.forEach((s, i) => {
    const from = was.get(s.seq), wrong = cur.flush && cur.pulled.includes(s.seq);
    if (!prev) out.push(make(s, stationX(i), wrong));
    else if (from !== undefined) out.push(make(s, stationX(from + (i - from) * u), wrong));
    else if (i === 0) out.push(make(s, stationX(-1 + u), wrong));
    else out.push(make(s, stationX(i), wrong, { size: Math.min(1, 2 * u) }));
  });
  prev?.slots.forEach((s, i) => {
    if (now.has(s.seq)) return;
    if (i === 4) out.push(make(s, stationX(4 + u), false, { size: 1 - u, leaving: 'retired' }));
    // lifted clear of the belt within the first half of the slide, named so a still frame says what it is
    else out.push(make(s, stationX(i), true, { z: 15 * Math.min(1, 2 * u), y: 5 * Math.min(1, 2 * u), leaving: 'pulled', text: s.valid ? 'pulled off' : 'bubble' }));
  });
  return out;
}

export type Lamp = 'off' | 'hold' | 'flush';
/** The signal lamps: Fetch and Decode hold on a stall, are emptied on a flush. */
export const lampsOf = (c: Cycle): Lamp[] => [c.flush ? 'flush' : c.stall ? 'hold' : 'off', c.flush ? 'flush' : c.stall ? 'hold' : 'off', 'off', 'off', 'off'];

export interface AssemblyPalette { frame: RGB; belt: RGB; plate: RGB; bubble: RGB; alu: RGB; load: RGB; store: RGB; ctl: RGB; wrong: RGB; off: RGB; hold: RGB; flush: RGB }

export function assemblyParts(pallets: readonly Pallet[], lamps: readonly Lamp[], P: AssemblyPalette): Part[] {
  const out: Part[] = [box(P.belt, stationX(-1.4), stationX(5.4), -3, 0, -10, 10)];
  for (let i = 0; i < STATIONS.length; i++) {
    const x = stationX(i), lamp = lamps[i];
    out.push(box(P.frame, x - 12, x - 10, 0, 17, 9, 11), box(P.frame, x + 10, x + 12, 0, 17, 9, 11), box(P.frame, x - 12, x + 12, 17, 20, 8, 12));
    const lit = lamp === 'off' ? P.off : P[lamp];
    out.push({ ...box(lit, x - 4, x + 4, 20, 23, 8.5, 11.5), emissive: lamp === 'off' ? undefined : [lit[0] * 0.6, lit[1] * 0.6, lit[2] * 0.6] });
  }
  for (const p of pallets) {
    const s = p.size, hw = 9 * s, hd = 7 * s, c = p.wrong ? P.wrong : P[p.kind === 'bubble' ? 'bubble' : p.kind];
    out.push(box(p.kind === 'bubble' ? P.bubble : P.plate, p.x - hw, p.x + hw, p.y, p.y + 2 * s, p.z - hd, p.z + hd));
    if (p.kind !== 'bubble') out.push(box(c, p.x - 6 * s, p.x + 6 * s, p.y + 2 * s, p.y + 8 * s, p.z - 4.5 * s, p.z + 4.5 * s, 0.2));
  }
  return out;
}

export function assemblyAnchors(pallets: readonly Pallet[]): Anchor[] {
  const front: [number, number, number] = [0, 0.3, 1], up: [number, number, number] = [0, 1, 0];
  const settled = pallets.filter((p) => p.leaving !== 'retired'); // a retiring pallet is not labelled; a pulled one says so
  return [
    // a station's name steps aside while a pulled pallet's label hangs where it would be
    ...STATIONS.map((n, i): Anchor => ({ text: n, p: [stationX(i), -1, 10], side: 'b', n: front }))
      .filter((_, i) => !pallets.some((p) => p.leaving === 'pulled' && p.x === stationX(i))),
    // a pulled pallet's name hangs below it, clear of the arriving pallet and its label above
    ...settled.map((p): Anchor => p.leaving === 'pulled'
      ? { text: p.text, p: [p.x, p.y, p.z + 16], side: 'b', n: front }
      : { text: `${p.wrong ? '✗ ' : ''}${p.text}`, p: [p.x, p.y + 9, p.z], side: 't', n: up }),
  ];
}
