// Every number the FPGA chapter quotes (chapters/ch-fpga.ts), computed here from this site's own circuits and from the
// measured place-and-route results (fpgacosts.json, scripts/fpga-pnr.ts), so the prose cannot drift from them
// (tests/fpga-chapter.test.ts). DOM-free; the costly ones (mapping the ALU at five LUT sizes) are computed on first use.

import '../lib';
import { resolveComponent } from '../lib/resolve';
import { lut } from '../lib/fpga';
import { lutMap } from '../sim/lutmap';
import { logicDepth, stats } from '../sim/stats';
import type { FpgaCosts } from './costs';
import data from './fpgacosts.json';

export const COSTS = data as FpgaCosts;
export const COMPUTER = COSTS.examples.computer;
export const COUNTER = COSTS.examples.counter7;

/** A circuit of the library and what LUT4 mapping makes of it. */
export interface Cover { id: string; name: string; nands: number; depth: number; luts: number; levels: number }

const covers = new Map<string, Cover>();
export function coverOf(id: string, k = 4): Cover {
  const key = `${id}/${k}`;
  let c = covers.get(key);
  if (!c) {
    const d = resolveComponent(id)!;
    const m = lutMap(d, { k });
    c = { id, name: d.name, nands: stats(d).nands, depth: logicDepth(d) ?? 0, luts: m.luts.length, levels: m.depth };
    covers.set(key, c);
  }
  return c;
}

/** The circuits step 4's table maps. */
export const COVER_IDS = ['full_adder', 'rca4', 'rca8', 'mux16x1', 'alu16'];

/** A k-input LUT's cost: its mux tree in NANDs and its configuration bits. */
export const lutCost = (k: number) => ({ k, nands: stats(lut(k)).nands, bits: 2 ** k });

/** Step 3's table: the 16-bit ALU mapped at k = 2 … 6. */
export function kSweep(): { k: number; luts: number; levels: number; muxNands: number; bits: number }[] {
  return [2, 3, 4, 5, 6].map((k) => { const c = coverOf('alu16', k), l = lutCost(k); return { k, luts: c.luts, levels: c.levels, muxNands: l.nands, bits: l.bits }; });
}

/** The data memory of the computer, 4K words of 32 bits, as flip-flops: against the device's. */
export const RAM_WORDS = 4096, RAM_BITS = 32;
export const ramAsFlipFlops = () => ({ bits: RAM_WORDS * RAM_BITS, available: COMPUTER.device.dff.available, times: (RAM_WORDS * RAM_BITS) / COMPUTER.device.dff.available });

/** A GW1N block RAM's data bits (16 Kbit; 18 with the parity bits of its 9-bit-wide modes, which a 32-bit memory does not use). */
export const BSRAM_BITS = 16 * 1024;
/** Block RAMs a memory of words × bits needs. */
export const bsramFor = (words: number, bits: number) => Math.ceil((words * bits) / BSRAM_BITS);
/** The computer's program ROM: 1K words. */
export const ROM_WORDS = 1024;

/** Configuration bits in the LUTs alone: every LUT4 of the device holds 16. */
export const lutConfigBits = () => COMPUTER.device.lut4.available * 16;

/** Configuration bits of the whole fabric: the counter's bitstream, which holds no memory contents (the computer's adds frames for its block RAMs). */
export const fabricBits = () => COUNTER.bitstream.frames * COUNTER.bitstream.frameBits;

/** The block a cell came from, by name (fpgacosts' blocks). */
export const block = (name: string) => COMPUTER.blocks.find((b) => b.name === name) ?? { name, luts: 0, ffs: 0, bsram: 0 };

/** The design clock's critical path: shares of the total. */
export function pathShares() {
  const c = COMPUTER.critical;
  const pct = (x: number) => Math.round((100 * x) / c.ns);
  return { ...c, routingPct: pct(c.routing), logicPct: pct(c.logic), skewPct: pct(c.skew), periodNs: 1000 / COMPUTER.fmax.clk };
}

/** NANDs of our netlist a synthesized LUT stands for, on average, in the computer. */
export const nandsPerLut = () => COMPUTER.ours.nands / COMPUTER.lut4Stages.synth;

/** Fixed fractions written out in the prose. */
export const pct = (a: number, b: number) => Math.round((100 * a) / b);
