// The out-of-order core's cost by window size (chapter 26's lab): scripts/ooo-sizes.ts writes the grid to
// src/bench/ooosizes.json, tests/ooosizes-cost.test.ts holds the file to these functions.
import { type OooSizes } from '../../src/lib/ooo';
import { oooCpu } from '../../src/lib/ooocore';
import { flatten } from '../../src/sim/flatten';
import { stats } from '../../src/sim/stats';
import { analyzeTiming } from '../../src/sim/timing';
import { BENCH_DMEM_K, BENCH_IMEM_K, benchCases, measureCpu } from './bench';
import { CPUS } from './cpus';

export const ROB_SIZES = [8, 16, 32], IQ_SIZES = [4, 8, 16], SQ_SIZES = [2, 4, 8];
/** The units whose size follows the knobs (instance names in the core). */
export const SIZED_UNITS = ['rob', 'iq', 'sq', 'rat'] as const;

export interface SizePoint extends OooSizes {
  /** NANDs without the program ROM, and the static-timing period in NAND delays: measureCpu's, as results.json. */
  nands: number;
  period: number;
  /** The period under the load-dependent delay model (sim/delay.ts: logical effort, fan-out counted), in NAND delays. */
  periodLoad: number;
  /** The top-level instances the (unit-delay) critical path crosses, launch to capture. */
  path: string[];
  units: Record<(typeof SIZED_UNITS)[number], number>;
}

/** The program the benchmarks build the core with (its ROM is left out of the count, so any program would do). */
export const sizeProgram = () => benchCases(CPUS.find((c) => c.id === 'ooo')!)[0].words;

/** One size measured as the benchmarks measure a CPU (measureCpu), with its sized units' NANDs. */
export function measureSize(z: OooSizes, words = sizeProgram()): SizePoint {
  const def = oooCpu(words, { imemK: BENCH_IMEM_K, dmemK: BENCH_DMEM_K, ...z });
  const m = measureCpu(def), kids = def.netlist!().instances;
  const units = Object.fromEntries(SIZED_UNITS.map((n) => [n, stats(kids.find((i) => i.name === n)!.def).nands])) as SizePoint['units'];
  const flat = flatten(def, { mode: 'gate' }), unit = analyzeTiming(flat)!, load = analyzeTiming(flat, { delay: 'load' })!;
  if (unit.period !== m.period) throw new Error('two timings of one design differ');
  return { rob: z.rob, iq: z.iq, sq: z.sq, nands: m.nands, period: m.period, periodLoad: Math.round(load.period * 10) / 10, path: unit.stages.map((s) => s.inst), units };
}
