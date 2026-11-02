// DOM-free models behind the four 2D analogy figures (ui/analogyfigs.ts), each drawn from the numbers the chapter uses.

import { VDD, discharge, loadOf } from '../mosphys';
import { CELL_C, BITLINE_C, CELL_HALFLIFE } from '../../lib/dram';
import { SENSE_OFFSET, VDD_VOLTS } from '../../sim/switchsim';

// ---- buckets: chapter 1's "What one switch costs" ----
export const BUCKET_T_MAX = 120; // ps

export interface BucketRun { cLoad: number; t50: number; energy: number; t: number[]; fill: number[] }

/** `fanout` inputs on a unit-width driver: load in fF, time to half full in ps, C·V² in fJ, and the fill level
 *  (0..1, the output voltage's rise as a fraction of VDD) every ps. Same model as the step's own widget. */
export function bucketRun(fanout: number): BucketRun {
  const cLoad = loadOf(fanout), r = discharge(1, cLoad, BUCKET_T_MAX);
  return { cLoad, t50: r.t50, energy: cLoad * VDD * VDD, t: r.t, fill: r.v.map((v) => 1 - v / VDD) };
}

// ---- airlock: the master-slave flip-flop ----
export interface Airlock { clk: boolean; d: boolean; master: boolean; q: boolean; outer: boolean; inner: boolean }

export const airlockStart = (): Airlock => ({ clk: false, d: false, master: false, q: false, outer: true, inner: false });

/** D moves: through the outer door while it is open, otherwise only the input changes. */
export const airlockSetD = (s: Airlock, d: boolean): Airlock => ({ ...s, d, master: s.outer ? d : s.master });

/** The phases of a clock edge, in order: the door that is open shuts first, then the other opens. */
export function airlockEdge(s: Airlock, rising: boolean): Airlock[] {
  if (rising === s.clk) return [s];
  const shut: Airlock = { ...s, clk: rising, outer: false, inner: false, master: s.outer ? s.d : s.master };
  return rising
    ? [shut, { ...shut, inner: true, q: shut.master }]
    : [shut, { ...shut, outer: true, master: shut.d }];
}

// ---- laundry: the pipeline ----
export interface Cell { load: number; stage: number; slot: number }
export interface Schedule { cells: Cell[]; bubbles: { stage: number; slot: number }[]; slots: number }

export const LOADS = 4, STAGES = 3;
export const STAGE_NAMES = ['Wash', 'Dry', 'Fold'];

/** `pipelined`: a load enters a machine as soon as it is free (it stays until the next machine takes it). Else one
 *  load at a time. `stall`: load 3's dry must wait one slot for load 2's dryer: a bubble behind it, and the loads
 *  after it wait in the washer. */
export function laundry(pipelined: boolean, stall: boolean): Schedule {
  const start: number[][] = [];
  for (let i = 0; i < LOADS; i++) {
    start.push([]);
    for (let s = 0; s < STAGES; s++) {
      let t = 0;
      if (!pipelined) t = i * STAGES + s;
      else {
        if (s > 0) t = start[i][s - 1] + 1 + (stall && i === 2 && s === 1 ? 1 : 0);
        if (i > 0) t = Math.max(t, start[i - 1][s] + 1);
        // the machine is busy until its load moves on
        if (i > 0 && s + 1 < STAGES) t = Math.max(t, start[i - 1][s + 1]);
      }
      start[i].push(t);
    }
  }
  const cells: Cell[] = [], bubbles: { stage: number; slot: number }[] = [];
  let slots = 0;
  for (let i = 0; i < LOADS; i++) for (let s = 0; s < STAGES; s++) { cells.push({ load: i, stage: s, slot: start[i][s] }); slots = Math.max(slots, start[i][s] + 1); }
  if (pipelined && stall) for (let s = 1; s < STAGES; s++) {
    // a slot a machine sits empty between two loads, after the pipe has started
    for (let t = start[0][s]; t < slots; t++) if (!cells.some((c) => c.stage === s && c.slot === t) && cells.some((c) => c.stage === s && c.slot > t)) bubbles.push({ stage: s, slot: t });
  }
  return { cells, bubbles, slots };
}

// ---- leaky DRAM cells ----
export const DRAM_OFFSET_MV = SENSE_OFFSET * VDD_VOLTS * 1000;
export const DRAM_SHARE = CELL_C / (CELL_C + BITLINE_C);
export type Read = 0 | 1 | 'X';

/** A stored 1 loses charge toward 0, halving every CELL_HALFLIFE cycles (SwitchSim.leak); a 0 stays at 0. */
export const decay = (level: number, cycles: number): number => level * 2 ** (-cycles / CELL_HALFLIFE);

/** The bit line's move from its VDD/2 precharge when the cell joins it, in mV. */
export const deltaMv = (level: number): number => (level - 0.5) * VDD_VOLTS * 1000 * DRAM_SHARE;

/** The sense amplifier: X when the move is under its offset. */
export const senseRead = (level: number): Read => (Math.abs(deltaMv(level)) < DRAM_OFFSET_MV ? 'X' : level > 0.5 ? 1 : 0);

/** Refresh writes back what the amplifier read: a 0 or a 1 restored, an X settles either way (a coin toss). */
export function refreshLevel(level: number, coin: () => boolean = () => Math.random() < 0.5): number {
  const r = senseRead(level);
  return r === 'X' ? (coin() ? 1 : 0) : r;
}
