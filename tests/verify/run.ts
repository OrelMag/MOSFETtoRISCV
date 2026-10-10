// Run a riscv-tests image on the golden model or on a gate-level CPU, until it writes tohost.

import { clockCycle, dmemWords } from '../../src/riscv/cosim';
import { ISS, type IssOptions } from '../../src/riscv/iss';
import { BitSim, LANES } from '../../src/sim/bitsim';
import { flatten, type FlatDesign } from '../../src/sim/flatten';
import { GateSim } from '../../src/sim/gatesim';
import { type Bit, inPorts } from '../../src/sim/types';
import type { IsaCoverage, LaneProbe } from './coverage';
import { issOptions, type CpuConfig } from './cpus';
import { loadable, verdict, type Loadable, type RvImage } from './images';

export interface RunResult {
  pass: boolean;
  /** pass, fails test n, no result, … */
  text: string;
  /** Instructions (golden model) or clock cycles (CPU) until tohost was written. */
  count: number;
  ms: number;
}

export function runOnIss(img: RvImage, l: Loadable, opts: IssOptions, maxSteps = 100_000, cov?: IsaCoverage): RunResult {
  const t0 = performance.now();
  const iss = new ISS(l.words, { ...opts, dmemWords: 2 ** l.dmemK, imemWords: 2 ** l.imemK });
  let tohost: number | undefined;
  while (iss.steps < maxSteps && !iss.halted) {
    const s = iss.step();
    cov?.step(s);
    if (s.store && ((s.store.addr >>> 2) & (2 ** l.dmemK - 1)) === l.tohost && iss.dmem[l.tohost]) { tohost = iss.dmem[l.tohost]; break; }
  }
  return { ...verdict(tohost, img.env), count: iss.steps, ms: performance.now() - t0 };
}

export interface LaneJob {
  img: RvImage;
  l: Loadable;
  /** Cycle budget. */
  max: number;
  /** The image on the golden model (configured like the CPU). */
  golden: RunResult;
}

export interface LaneBatch { jobs: LaneJob[]; imemK: number; dmemK: number }

/**
 * The images as lane batches for `cfg`: grouped by data-memory size (a bigger memory is a bigger circuit),
 * at most 32 per batch, each with its golden-model run and a cycle budget of the CPU's worst CPI.
 */
export function cpuJobs(cfg: CpuConfig, imgs: RvImage[], cov?: IsaCoverage): LaneBatch[] {
  const groups = new Map<number, LaneJob[]>();
  for (const img of imgs) {
    const l = loadable(img, cfg.imemK, cfg.fixedDmemK ?? cfg.dmemK);
    const golden = runOnIss(img, l, issOptions(cfg.isa), undefined, cov);
    const job = { img, l, golden, max: Math.ceil(golden.count * cfg.cpi * 1.25) + 100 };
    groups.set(l.dmemK, [...(groups.get(l.dmemK) ?? []), job]);
  }
  const out: LaneBatch[] = [];
  for (const [dmemK, jobs] of groups) {
    for (let at = 0; at < jobs.length; at += LANES) {
      const js = jobs.slice(at, at + LANES);
      out.push({ jobs: js, dmemK, imemK: Math.max(...js.map((j) => j.l.imemK)) });
    }
  }
  return out;
}

/**
 * Up to 32 images on one gate-level CPU at once, one per lane of the bit-parallel simulator: the
 * instruction ROM is evaluated per lane (each lane its own program), every other leaf is a NAND.
 * All jobs share the CPU's memory sizes (imemK, dmemK). Returns one result per job.
 */
/** Let the event loop run (Vitest's worker RPC times out behind a long synchronous stretch). */
export const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function runLanes(cfg: CpuConfig, jobs: LaneJob[], imemK: number, dmemK: number, probe?: (design: FlatDesign) => LaneProbe): Promise<RunResult[]> {
  if (jobs.length > LANES) throw new Error('runLanes: at most 32 jobs');
  const t0 = performance.now();
  const design = flatten(cfg.build(jobs[0].l.words, imemK, dmemK));
  const sim = new BitSim(design);
  const N = 2 ** imemK;
  const progs = Array.from({ length: LANES }, (_, l) => jobs[l % jobs.length].l.words);
  const pr = probe?.(design);
  design.leaves.forEach((leaf, i) => {
    if (leaf.kind !== 'behavior' || leaf.inputs.length === 0) return;
    // stateless ROMs only: the program ROM (imem) gets each lane's program, others (microcode) keep theirs
    if (!leaf.def.id.startsWith('rom_')) throw new Error(`${cfg.id}: behavioural leaf ${leaf.node.path.join('.')} (${leaf.def.id}) is not a ROM`);
    if (leaf.node.path.includes('imem')) sim.setLaneBehavior(i, ([a], lane) => [progs[lane][Math.floor(a / 4) % N] ?? 0x13]);
    else sim.setLaneBehavior(i, (ins) => leaf.def.behavior!.eval(ins, undefined));
  });
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const dm = design.root.children!.get('dm');
  if (!dm) throw new Error(`${cfg.id}: no data memory 'dm'`);
  const lane = (l: number) => ({ getBits: (nets: readonly number[]) => nets.map((n) => ((sim.v[n] >>> l) & 1) as Bit) });
  const out: (RunResult | undefined)[] = jobs.map(() => undefined);
  const max = Math.max(...jobs.map((j) => j.max));
  let c = 0;
  while (c < max && out.some((r) => !r)) {
    if ((c & 63) === 63) await pause();
    sim.cycle();
    c++;
    pr?.cycle(sim, out.reduce((m, r, l) => (r ? m : m | (1 << l)), 0));
    if ((c & 7) && c !== max) continue;
    jobs.forEach((j, l) => {
      if (out[l]) return;
      const t = dmemWords(lane(l), dm)[j.l.tohost];
      if (t || c >= j.max) out[l] = { ...verdict(t, j.img.env), count: c, ms: 0 };
    });
  }
  const ms = performance.now() - t0;
  return out.map((r, l) => ({ ...(r ?? { ...verdict(0, jobs[l].img.env), count: c }), ms }));
}

/** Clock the CPU until tohost (data-memory word l.tohost) is written, or the budget runs out. */
export async function runOnCpu(cfg: CpuConfig, img: RvImage, l: Loadable, maxCycles: number): Promise<RunResult> {
  const t0 = performance.now();
  const design = flatten(cfg.build(l.words, l.imemK, l.dmemK));
  const sim = new GateSim(design);
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const dm = design.root.children!.get('dm');
  if (!dm) throw new Error(`${cfg.id}: no data memory 'dm'`);
  let tohost: number | undefined, c = 0;
  while (c < maxCycles) {
    if ((c & 15) === 15) await pause();
    clockCycle(sim);
    c++;
    if ((c & 7) === 0 || c === maxCycles) {
      const t = dmemWords(sim, dm)[l.tohost];
      if (t) { tohost = t; break; }
    }
  }
  return { ...verdict(tohost, img.env), count: c, ms: performance.now() - t0 };
}
