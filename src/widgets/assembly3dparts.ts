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
    // lifted at once and carried behind the gantries, off the belt's far side: never over a station's pallet, named by its own mnemonic
    else out.push(make(s, stationX(i), true, { z: -PULL_Z * Math.min(1, 2 * u), y: PULL_Y * Math.min(1, 4 * u), leaving: 'pulled', text: s.valid ? `${ctx.mnemonicOf(s.pc)} · pulled` : 'bubble' }));
  });
  return out;
}

/** How far a pulled pallet is lifted and carried back (units), well past a pallet's own 8 high and 14 deep. */
const PULL_Y = 14, PULL_Z = 28;
/** A pallet's box: plate and cargo, x0 x1 y0 y1 z0 z1. */
export const palletBox = (p: Pallet): [number, number, number, number, number, number] =>
  [p.x - 9 * p.size, p.x + 9 * p.size, p.y, p.y + 8 * p.size, p.z - 7 * p.size, p.z + 7 * p.size];

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
  // a retiring pallet is not labelled, nor a bubble (its colour and the readout say it); a pulled one is named where it hangs
  const named = pallets.filter((p) => p.leaving !== 'retired' && p.kind !== 'bubble');
  const pulled = named.filter((p) => p.leaving === 'pulled').sort((a, b) => a.x - b.x);
  return [
    ...STATIONS.map((n, i): Anchor => ({ text: n, p: [stationX(i), -1, 10], side: 'b', n: front })),
    // two pulled labels would meet on a narrow stage: one above its pallet, the next below
    ...named.map((p): Anchor => p.leaving === 'pulled'
      ? { text: p.text, p: [p.x, p.y + (pulled.indexOf(p) % 2 ? 0 : 9), p.z], side: pulled.indexOf(p) % 2 ? 'b' : 't', n: up }
      : { text: `${p.wrong ? '✗ ' : ''}${p.text}`, p: [p.x, p.y + 9, p.z], side: 't', n: up }),
  ];
}
