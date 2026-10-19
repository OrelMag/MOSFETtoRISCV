// The saved benchmark results (results.json, written by scripts/benchmarks.ts --write) as the
// workbench's Benchmarks tab reads them: times, energies, means, the cost / speed front. DOM-free.

import { energyFj, VDD } from '../sim/power';
import data from './results.json';

export interface BenchRun {
  bench: string;
  instructions: number;
  cycles: number;
  dmiss?: number;
  dstall?: number;
  imiss?: number;
  istall?: number;
  /** Σ C · toggles over the run (fF, sim/power.ts), glitches included, and over settled values only. */
  switched?: number;
  functional?: number;
}

export interface BenchCpu {
  id: string;
  name: string;
  /** Without the instruction ROM (its size follows the program); with the 64-word data memory and caches. */
  nands: number;
  /** NAND delays (static timing). */
  period: number;
  /** Main memory is an off-chip DRAM device (chapter 34): not in `nands`, so kept out of the cost comparisons. */
  offChip?: boolean;
  runs: BenchRun[];
}

export interface BenchResults {
  programs: string;
  psPerNand: number;
  imemWords: number;
  dmemWords: number;
  cpus: BenchCpu[];
}

export const RESULTS = data as BenchResults;

/** The programs every CPU runs (the mean is taken over these, so every CPU does the same work). */
export const COMMON = ['fib', 'sort', 'matmul', 'crc'];

export type Family = 'single' | 'multi' | 'pipe' | 'wide';
export const FAMILIES: { key: Family; label: string }[] = [
  { key: 'single', label: 'Single-cycle' },
  { key: 'multi', label: 'Multicycle' },
  { key: 'pipe', label: 'Pipelined' },
  { key: 'wide', label: 'Two-wide (dual issue, out of order)' },
];

/** CPUs that issue two instructions a cycle (chapter 24). */
const WIDE = new Set(['pipe-2w', 'ooo']);
/** The system CPUs and the dual-core are single-cycle cores. */
export const familyOf = (id: string): Family => (WIDE.has(id) ? 'wide' : id.startsWith('mc') ? 'multi' : id.startsWith('pipe') || id === 'fppipe' ? 'pipe' : 'single');

/** The chapter that builds each CPU. */
const CHAPTER: Record<string, string> = {
  sc: 'cpu', 'sc-ks': 'fastadd', 'sc-dc': 'cache', 'sc-wb2': 'cache', 'sc-ic': 'cache', 'sc-wb-ic': 'cache', 'sc-f': 'float',
  'mc-fsm': 'multicycle', 'mc-micro': 'multicycle', pipe: 'pipeline', 'pipe-ks': 'pipepay', 'pipe-bal': 'pipepay',
  'pipe-bp': 'pipepay', 'pipe-bal-bp': 'pipepay', 'pipe-wb2': 'cache', 'pipe-wt-bal-bp': 'cache', 'pipe-m': 'muldiv',
  'pipe-m-bal-bp': 'muldiv', 'pipe-2w': 'ooo', fppipe: 'float', sys: 'traps', 'sys-m': 'muldiv', dual: 'multicore',
  'sc-wb2-dram': 'memctrl', 'sc-wb2-dramc': 'memctrl', 'pipe-wb2-dram': 'memctrl',
};
export const chapterOf = (id: string): string | undefined => CHAPTER[id];

export const geoMean = (xs: number[]) => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);

/** A run's time in µs: cycles × period × ps per NAND. */
export const runUs = (cpu: BenchCpu, r: BenchRun, ps = RESULTS.psPerNand) => (r.cycles * cpu.period * ps) / 1e6;

export const runOf = (cpu: BenchCpu, bench: string) => cpu.runs.find((r) => r.bench === bench);

/** A run's energy in nJ at v volts (an estimate: sim/power.ts). */
export const runNj = (r: BenchRun, v = VDD) => energyFj(r.switched ?? NaN, v) / 1e6;

export type Metric = 'time' | 'cycles' | 'cpi' | 'energy' | 'epi';
export function metricOf(cpu: BenchCpu, r: BenchRun, m: Metric): number {
  return m === 'time' ? runUs(cpu, r) : m === 'cycles' ? r.cycles : m === 'cpi' ? r.cycles / r.instructions
    : m === 'energy' ? runNj(r) : (runNj(r) * 1e3) / r.instructions;
}

/** The geometric mean of a metric over the common programs. */
export const meanOf = (cpu: BenchCpu, m: Metric) => geoMean(COMMON.map((b) => metricOf(cpu, runOf(cpu, b)!, m)));

/** The CPUs no other CPU beats on both x (default: cost in NANDs) and mean time, lowest x first. */
export function front(cpus: BenchCpu[], x: (c: BenchCpu) => number = (c) => c.nands): BenchCpu[] {
  const t = new Map(cpus.map((c) => [c, meanOf(c, 'time')]));
  // a CPU whose main memory is off chip costs more than its NANDs say: it is no one's trade-off
  return cpus.filter((c) => !c.offChip).sort((a, b) => x(a) - x(b) || t.get(a)! - t.get(b)!)
    .filter((c, i, a) => a.slice(0, i).every((d) => t.get(d)! > t.get(c)!));
}
