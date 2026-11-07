// The MAC chapter's benchmarks (src/dsp/macbench.ts) on gates: every kernel of a machine at once, one per BitSim lane, together with its setup alone (the data
// written into memory), so a kernel's cycles are the difference. A lane is done when its PC reaches the halt; its dmem words are read back and held
// to the exact outputs, and its cycle count to the golden model's instruction count (the single-cycle cores retire one instruction a clock).
import { singleCycleCpu, xlenCpu } from '../../src/lib';
import '../../src/lib/macunit';
import { MAC_BENCHES, MAC_DMEM_K, MAC_IMEM_K, macPlan, type MacBench, type MacMachine, type MacPlan } from '../../src/dsp/macbench';
import { assemble } from '../../src/riscv/asm';
import { dmemWords } from '../../src/riscv/cosim';
import { ISS } from '../../src/riscv/iss';
import { BitSim, LANES } from '../../src/sim/bitsim';
import { flatten } from '../../src/sim/flatten';
import { stats } from '../../src/sim/stats';
import { analyzeTiming } from '../../src/sim/timing';
import { inPorts, type ComponentDef } from '../../src/sim/types';
import { laneLeaves, pause } from './run';
import type { CpuConfig } from './cpus';

export const isMac = (m: MacMachine) => m.startsWith('mac');

/** The core of each machine. rv32im is chapter 25's one-drawing core at 32 bits (singleCycleCpu has no M): Kogge–Stone adders, its own memory. */
export function macCore(m: MacMachine, words: number[], imemK = MAC_IMEM_K, dmemK = MAC_DMEM_K): ComponentDef {
  if (m === 'rv32im') return xlenCpu(words, { xlen: 32, m: true, imemK, dmemK });
  return singleCycleCpu(words, { imemK, dmemK, ...(isMac(m) ? { mac: true } : {}) });
}

export interface LaneResult {
  bench: MacBench;
  machine: MacMachine;
  /** Instructions to the halt on the golden model, and clocks on the gates, for the whole program and for its setup alone. */
  instructions: number;
  cycles: number;
  setupInstructions: number;
  setupCycles: number;
  /** '' when the gates left the exact outputs in memory. */
  diff: string;
}

/** The assembled programs of a machine: for each benchmark the full one and the setup alone. */
export function macPrograms(m: MacMachine, benches: readonly MacBench[] = MAC_BENCHES): { plan: MacPlan; full: number[]; setup: number[]; endPc: number; setupEndPc: number }[] {
  return benches.map((b) => {
    const plan = macPlan(b, m), mac = isMac(m);
    const a = assemble(plan.source, [], { mac }), s = assemble(plan.setupSource, [], { mac });
    for (const r of [a, s]) if (r.errors.length) throw new Error(`${b} on ${m}: line ${r.errors[0].line}: ${r.errors[0].message}`);
    return { plan, full: a.words, setup: s.words, endPc: a.labels.get('end')!, setupEndPc: s.labels.get('end')!, };
  });
}

/** The golden model's instruction count to a halt label. */
export function issCount(words: number[], endPc: number, m: MacMachine): { n: number; iss: ISS } {
  const iss = new ISS(words, { mac: isMac(m), m: m === 'rv32im', imemWords: 2 ** MAC_IMEM_K, dmemWords: 2 ** MAC_DMEM_K });
  let n = 0;
  while (iss.pc !== endPc && n < 5_000_000) { iss.step(); n++; }
  if (iss.pc !== endPc) throw new Error('the golden model does not reach the halt');
  return { n, iss };
}

/** Every benchmark of a machine at once on one gate-level build. */
export async function runMachine(m: MacMachine, benches: readonly MacBench[] = MAC_BENCHES): Promise<LaneResult[]> {
  const progs = macPrograms(m, benches);
  const jobs = progs.flatMap((p) => [{ words: p.full, end: p.endPc, set: false, p }, { words: p.setup, end: p.setupEndPc, set: true, p }]);
  if (jobs.length > LANES) throw new Error('too many lanes');
  const counts = jobs.map((j) => issCount(j.words, j.end, m));
  const design = flatten(macCore(m, jobs[0].words));
  const sim = new BitSim(design);
  const N = 2 ** MAC_IMEM_K;
  const cfg = { id: `mac-${m}` } as CpuConfig;
  const view = laneLeaves(cfg, design, sim, (l) => jobs[l % jobs.length].words, N);
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const root = design.root, pcNets = root.ports.pcOut;
  const pcOf = (l: number) => { let v = 0; for (let i = pcNets.length - 1; i >= 0; i--) v = v * 2 + ((sim.v[pcNets[i]] >>> l) & 1); return v; };
  const done = jobs.map(() => -1);
  const max = Math.max(...counts.map((c) => c.n)) + 50;
  for (let c = 0; c <= max && done.some((d) => d < 0); c++) {
    if ((c & 255) === 255) await pause();
    jobs.forEach((j, l) => { if (done[l] < 0 && pcOf(l) === j.end) done[l] = c; });
    if (done.every((d) => d >= 0)) break;
    sim.cycle();
  }
  const dm = root.children!.get('dm')!;
  return progs.map((p, i): LaneResult => {
    const lf = 2 * i, ls = 2 * i + 1;
    const mem = dmemWords(view(lf), dm);
    let diff = '';
    for (const [w, v] of p.plan.expect) if ((mem[w] >>> 0) !== v) { diff = `word ${w}: gates ${mem[w] | 0}, exact ${v | 0}`; break; }
    if (!diff && done[lf] !== counts[lf].n) diff = `${done[lf]} clocks for ${counts[lf].n} instructions`;
    if (!diff && done[ls] !== counts[ls].n) diff = `setup: ${done[ls]} clocks for ${counts[ls].n} instructions`;
    return { bench: p.plan.bench, machine: m, instructions: counts[lf].n, cycles: done[lf], setupInstructions: counts[ls].n, setupCycles: done[ls], diff };
  });
}

/** NANDs without the program ROM (the data memory is the default 32 words, as in the chapters' tables) and the period in NAND delays. */
export function macCost(m: MacMachine): { nands: number; period: number } {
  const def = m === 'rv32im' ? xlenCpu([0x13, 0x13], { xlen: 32, m: true }) : singleCycleCpu([0x13, 0x13], isMac(m) ? { mac: true } : {});
  const rom = (d: ComponentDef): number => (d.netlist?.().instances ?? []).reduce((s, i) => s + (i.name === 'imem' ? stats(i.def).nands : 0), 0);
  const period = analyzeTiming(flatten(def, { mode: 'gate' }))?.period;
  if (period === undefined) throw new Error(`${m}: no register-to-register path`);
  return { nands: stats(def).nands - rom(def), period };
}
