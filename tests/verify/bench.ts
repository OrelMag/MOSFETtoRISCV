// The benchmark set (src/riscv/benchprograms.ts) on the golden model and on a gate-level CPU: every program
// the CPU can run at once, one per BitSim lane. A lane's cycle count is taken when the CPU has retired as many
// instructions as the golden model executed (the final jump-to-self included), so pipeline fill and drain,
// stalls and misses are all counted; misses and stall cycles are read off the caches' own stall nets. The final
// registers and data memory are then compared with the golden model's, so every number comes from a correct run.

import { createHash } from 'node:crypto';
import { assemble } from '../../src/riscv/asm';
import { BENCHMARKS, PARK, type Benchmark } from '../../src/riscv/benchprograms';
import { ISS } from '../../src/riscv/iss';
import { MultiISS } from '../../src/riscv/multi';
import { BitSim, LANES } from '../../src/sim/bitsim';
import { flatten } from '../../src/sim/flatten';
import { GateSim } from '../../src/sim/gatesim';
import { PowerMeter } from '../../src/sim/power';
import { stats } from '../../src/sim/stats';
import { analyzeTiming } from '../../src/sim/timing';
import { inPorts, type ComponentDef } from '../../src/sim/types';
import { issOptions, type CpuConfig } from './cpus';
import { diffState, readState, type ArchState } from './fuzz';
import { laneLeaves, pause } from './run';

/** Every CPU gets the same memories: a 128-word instruction ROM and 64 words of data memory. */
export const BENCH_IMEM_K = 7;
export const BENCH_DMEM_K = 6;

export const runsOn = (b: Benchmark, cfg: CpuConfig) => (!b.needs?.m || !!cfg.isa.m) && (!b.needs?.f || !!cfg.isa.f);

export interface BenchCase {
  bench: Benchmark;
  words: number[];
  /** Instructions the golden model executes to the halt (hart 0's on a multi-core). */
  instructions: number;
  golden: ArchState;
}

/** The program as cfg runs it (on a multi-core the other harts park first), run on the golden model. */
export function benchCase(b: Benchmark, cfg: CpuConfig): BenchCase {
  const asm = assemble((cfg.isa.mp ? PARK : '') + b.source);
  if (asm.errors.length) throw new Error(`${b.id}: line ${asm.errors[0].line}: ${asm.errors[0].message}`);
  const words = asm.words, dmemWords = 2 ** BENCH_DMEM_K, imemWords = 2 ** BENCH_IMEM_K;
  if (words.length > imemWords) throw new Error(`${b.id}: ${words.length} words do not fit the ${imemWords}-word ROM`);
  const iss = new ISS(words, { ...issOptions(cfg.isa), dmemWords, imemWords });
  while (!iss.halted && iss.steps < 1_000_000) iss.step();
  if (!iss.halted) throw new Error(`${b.id}: the golden model does not halt`);
  let golden: ArchState = { x: [[...iss.x]], dmem: [...iss.dmem], ...(cfg.isa.f ? { f: [...iss.f], fcsr: (iss.frm << 5) | iss.fflags } : {}) };
  if (cfg.isa.mp) {
    const m = new MultiISS(words, 2, dmemWords, imemWords);
    while (!m.halted && m.cycles < 1_000_000) m.step();
    golden = { x: m.harts.map((h) => [...h.x]), dmem: [...m.dmem] };
  }
  return { bench: b, words, instructions: iss.steps, golden };
}

export interface BenchRun {
  bench: string;
  instructions: number;
  /** Clock cycles until the last instruction retired. */
  cycles: number;
  /** Cache stall episodes (one per miss) and cycles spent stalled, per cache the CPU has. */
  dmiss?: number;
  dstall?: number;
  imiss?: number;
  istall?: number;
  /** '' when the final state matches the golden model's, else what differs. */
  diff: string;
}

export interface CpuMeasure {
  /** NANDs of the CPU with its 64-word data memory (and caches), without the instruction ROM. */
  nands: number;
  /** Clock period in NAND delays (static timing). */
  period: number;
  /** Main memory is a DRAM device (a separate chip, not counted). */
  offChip?: boolean;
}

/** NANDs without the instruction ROM (its size follows the program), and the static-timing period. */
export function measureCpu(def: ComponentDef): CpuMeasure {
  // the program ROM is imem itself or, behind an instruction cache, a ROM inside imem
  const rom = (d: ComponentDef, inImem: boolean): number => {
    const nl = d.netlist?.();
    if (!nl) return 0;
    return nl.instances.reduce((s, i) => {
      const imem = inImem || i.name === 'imem';
      if (imem && i.def.id.startsWith('rom_')) return s + stats(i.def).nands;
      return s + (i.name === 'imem' || /^core\d$/.test(i.name) ? rom(i.def, imem) : 0);
    }, 0);
  };
  const period = analyzeTiming(flatten(def, { mode: 'gate' }))?.period;
  if (period === undefined) throw new Error(`${def.id}: no register-to-register path`);
  const r = rom(def, false);
  if (!r) throw new Error(`${def.id}: no program ROM found`);
  const dram = (d: ComponentDef): boolean => d.id.startsWith('dramdev') || !!d.netlist?.().instances.some((i) => dram(i.def));
  return { nands: stats(def).nands - r, period, ...(dram(def) ? { offChip: true } : {}) };
}

/**
 * The nets that say how many instructions retire at the next edge: validW (pipelines), retire (multi-cycle
 * instructions; more bits: the count, for a CPU that retires several a cycle), retire0 (the multi-core's
 * hart 0); undefined: one every cycle.
 */
const retireNets = (ports: Record<string, number[]>): number[] | undefined => ports.validW ?? ports.retire ?? ports.retire0;

/** Every benchmark cfg can run, at once on one gate-level build (one per lane). */
export async function benchLanes(cfg: CpuConfig, cases: BenchCase[]): Promise<BenchRun[]> {
  if (cases.length > LANES) throw new Error('benchLanes: at most 32 cases');
  const design = flatten(cfg.build(cases[0].words, BENCH_IMEM_K, BENCH_DMEM_K));
  const sim = new BitSim(design);
  const N = 2 ** BENCH_IMEM_K;
  const laneView = laneLeaves(cfg, design, sim, (l) => cases[l % cases.length].words, N);
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const root = design.root, ports = root.ports;
  const retire = retireNets(ports);
  const stallNet = (name: string) => root.children!.get(name)?.ports.stall?.[0];
  const dNet = stallNet('dm'), iNet = stallNet('imem');
  const bit = (net: number, l: number) => (sim.v[net] >>> l) & 1;
  const n = cases.length;
  const retired = new Array<number>(n).fill(0), done = new Array<number>(n).fill(0);
  const dmiss = new Array<number>(n).fill(0), dstall = new Array<number>(n).fill(0), imiss = new Array<number>(n).fill(0), istall = new Array<number>(n).fill(0);
  const prevD = new Array<number>(n).fill(0), prevI = new Array<number>(n).fill(0);
  const max = Math.max(...cases.map((c) => Math.ceil(c.instructions * cfg.cpi * 1.5) + 100));
  for (let c = 0; c < max && done.some((d) => !d); c++) {
    if ((c & 63) === 63) await pause();
    // sampled between edges: what the next rising edge does
    for (let l = 0; l < n; l++) {
      if (done[l]) continue;
      if (dNet !== undefined) { const s = bit(dNet, l); dstall[l] += s; dmiss[l] += s & ~prevD[l]; prevD[l] = s; }
      if (iNet !== undefined) { const s = bit(iNet, l); istall[l] += s; imiss[l] += s & ~prevI[l]; prevI[l] = s; }
      retired[l] += retire ? retire.reduce((a, net, i) => a + (bit(net, l) << i), 0) : 1;
    }
    sim.cycle();
    for (let l = 0; l < n; l++) if (!done[l] && retired[l] >= cases[l].instructions) done[l] = c + 1;
  }
  return cases.map((cs, l) => {
    const view = laneView(l);
    const diff = !done[l] ? `retired ${retired[l]} of ${cs.instructions} in ${max} cycles`
      : retired[l] > cs.instructions ? `retired ${retired[l]}, past the golden model's ${cs.instructions}`
      : diffState(cs.golden, readState(view, root, !!cfg.isa.f));
    return {
      bench: cs.bench.id, instructions: cs.instructions, cycles: done[l], diff,
      ...(dNet !== undefined ? { dmiss: dmiss[l], dstall: dstall[l] } : {}),
      ...(iNet !== undefined ? { imiss: imiss[l], istall: istall[l] } : {}),
    };
  });
}

/** A hash of the programs, saved with the results: tests/benchmarks.test.ts fails when a program changed since. */
export const programsHash = () => createHash('sha256').update(JSON.stringify(BENCHMARKS.map((b) => b.source))).digest('hex').slice(0, 16);

/** The benchmarks cfg can run, as cases. */
export const benchCases = (cfg: CpuConfig) => BENCHMARKS.filter((b) => runsOn(b, cfg)).map((b) => benchCase(b, cfg));

export interface BenchEnergy {
  /** Σ C · toggles (fF) over the whole run, glitches included, and over settled values only. */
  switched: number;
  functional: number;
  /** Cycles run on GateSim (the same as BitSim's count). */
  cycles: number;
}

/**
 * One program on GateSim with its toggles counted (sim/power.ts): every half clock cycle settles, so the
 * glitches of every cycle are in; the run stops where benchLanes' does, at the last retirement.
 */
export async function benchEnergy(cfg: CpuConfig, cs: BenchCase): Promise<BenchEnergy> {
  const sim = new GateSim(flatten(cfg.build(cs.words, BENCH_IMEM_K, BENCH_DMEM_K)));
  for (const p of inPorts(sim.design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const retire = retireNets(sim.design.root.ports);
  const m = new PowerMeter(sim);
  const max = Math.ceil(cs.instructions * cfg.cpi * 1.5) + 100;
  let retired = 0, c = 0;
  while (retired < cs.instructions) {
    if (c >= max) throw new Error(`${cfg.id} ${cs.bench.id}: retired ${retired} of ${cs.instructions} in ${max} cycles`);
    if ((c & 15) === 15) await pause();
    retired += retire ? retire.reduce((a, net, i) => a + ((sim.get(net) === 1 ? 1 : 0) << i), 0) : 1;
    sim.setInput('clk', 1); sim.settle(); m.mark();
    sim.setInput('clk', 0); sim.settle(); m.mark();
    c++;
  }
  const t = m.totals();
  return { switched: Math.round(t.switched), functional: Math.round(t.functional), cycles: c };
}
