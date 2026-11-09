// Does an edited microprogram still run RISC-V? The multicycle CPU built from it (control 'micro', microcode) runs the
// riscv-tests rv32ui images it supports and the benchmark programs on BitSim lanes (32 programs at once, the
// instruction ROM per lane), each compared with the golden model: a test writes its verdict to tohost, a benchmark's
// final registers and memory must equal the ISS's. Cycles per benchmark give the CPI. On a failure `firstMismatch`
// replays the smallest failing program in lock step on GateSim and names the instruction after which the CPU and the
// golden model first differ. DOM-free; the images are a lazy chunk (the prebuilt JSON of tests/verify). Slices:
// the loops yield to the event loop every ~12 ms, so a dialog stays responsive.

import { assemble } from '../riscv/asm';
import { BENCHMARKS } from '../riscv/benchprograms';
import { clockCycle, cpuState, dmemWords, retiring } from '../riscv/cosim';
import { ABI } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { decodeWords, loadable, verdict, type RvImage } from '../riscv/rvimage';
import { BitSim, LANES } from '../sim/bitsim';
import { flatten, type FlatDesign } from '../sim/flatten';
import { DualSim } from '../sim/dualsim';
import { stats } from '../sim/stats';
import { type Bit, inPorts, type ComponentDef } from '../sim/types';
import { MC_PROGRAM, microController, multicycleCpu } from './multicycle';
import { cyclesByClass, validate, type Microprogram, type UProblem } from './ucode';

export interface TestResult { name: string; pass: boolean; text: string; cycles: number; instructions: number }
export interface BenchResult { id: string; name: string; ok: boolean; diff: string; instructions: number; cycles: number }
export interface UcodeReport {
  problems: UProblem[];
  tests: TestResult[];
  benches: BenchResult[];
  /** Every test passed and every benchmark's final state equals the golden model's. */
  allPass: boolean;
  /** Benchmark cycles per instruction, over the whole set (null when one did not finish). */
  cpi: number | null;
  /** Clock cycles per instruction class. */
  cycles: Record<string, number | null>;
  /** The smallest failing program replayed in lock step: where the CPU first differs from the golden model. */
  firstMismatch?: string;
  /** NANDs of the controller (the ROMs are constants: the size does not follow the contents). */
  nands: number;
  ms: number;
}

export interface CheckOptions {
  onProgress?(text: string): void;
  /** Aborted: the promise rejects with 'aborted'. */
  signal?: { aborted: boolean };
}

const SUBWORD = new Set(['lb', 'lbu', 'lh', 'lhu', 'sb', 'sh', 'ld_st', 'st_ld']);
const SKIP = new Set(['fence_i', 'ma_data']);
const MAX_CPI = 6;
const BENCH_IMEM_K = 7, BENCH_DMEM_K = 6;

let imageCache: Promise<RvImage[]> | null = null;
/** The rv32ui images a word-only RV32I CPU with a ROM program memory can run (as the verification suites select them). */
export function rv32uiImages(): Promise<RvImage[]> {
  return (imageCache ??= import('../../tests/verify/riscv-tests/bare.json').then((m) => {
    const f = (m as { default: { dataBase: number; tests: Record<string, { text: string; data: string }> } }).default;
    return Object.entries(f.tests)
      .filter(([n]) => n.startsWith('rv32ui-') && !SUBWORD.has(n.slice(7)) && !SKIP.has(n.slice(7)))
      .map(([name, t]): RvImage => ({ name, suite: 'rv32ui', env: 'bare', text: decodeWords(t.text), data: decodeWords(t.data), dataBase: f.dataBase }));
  }));
}

const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export function slicer(signal?: { aborted: boolean }) {
  let t = performance.now();
  return async () => {
    if (signal?.aborted) throw new Error('aborted');
    if (performance.now() - t < 12) return;
    await yieldNow();
    t = performance.now();
  };
}

/** Give BitSim's behavioural leaves their lanes: the program ROM each lane's program, the microcode ROMs one table. */
function laneLeaves(design: FlatDesign, sim: BitSim, prog: (lane: number) => number[], N: number): void {
  design.leaves.forEach((leaf, i) => {
    if (leaf.kind !== 'behavior' || leaf.inputs.length === 0) return;
    const b = leaf.def.behavior!;
    if (leaf.node.path.includes('imem')) sim.setLaneBehavior(i, ([a], lane) => [prog(lane)[Math.floor(a / 4) % N] ?? 0x13]);
    else if (leaf.def.id.startsWith('rom_')) sim.setLaneBehavior(i, (ins) => b.eval(ins, undefined));
    else throw new Error(`behavioural leaf ${leaf.node.path.join('.')} (${leaf.def.id}) is neither a ROM nor edge-triggered`);
  });
}

export interface Job { name: string; words: number[]; golden: { instructions: number; x: number[]; dmem: number[] }; max: number; tohost?: number; label: string }

export interface LaneRun { cycles: number[]; verdicts: (number | undefined)[] }

/** Up to 32 riscv-tests images on one build, one per lane: run until each has written its verdict to tohost. */
export async function runLanes(def: ComponentDef, jobs: Job[], imemK: number, tick: () => Promise<void>): Promise<LaneRun> {
  const design = flatten(def);
  const sim = new BitSim(design);
  const N = 2 ** imemK, n = jobs.length;
  laneLeaves(design, sim, (l) => jobs[l % n].words, N);
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const root = design.root, dm = root.children!.get('dm')!;
  const view = (l: number) => ({ design, getBits: (nets: readonly number[]): Bit[] => nets.map((net) => ((sim.v[net] >>> l) & 1) as Bit) });
  const done = new Array<number>(n).fill(0), verdicts = new Array<number | undefined>(n).fill(undefined);
  const max = Math.max(...jobs.map((j) => j.max));
  let c = 0;
  while (c < max && done.some((d) => !d)) {
    await tick();
    sim.cycle();
    c++;
    if ((c & 7) && c !== max) continue;
    for (let l = 0; l < n; l++) {
      if (done[l]) continue;
      const t = dmemWords(view(l), dm)[jobs[l].tohost ?? 0];
      if (t || c >= jobs[l].max) { done[l] = c; verdicts[l] = t; }
    }
  }
  return {
    cycles: jobs.map((_, l) => done[l] || c), verdicts,
  };
}

/** One program on the cycle engine (DualSim, exact against the gate simulator, ~65 times faster per cycle than BitSim): run until as many instructions retired as the golden model's. */
async function runOnEngine(def: ComponentDef, j: Job, tick: () => Promise<void>): Promise<{ cycles: number; retired: number; state: { x: number[]; dmem: number[] } }> {
  const sim = new DualSim(flatten(def));
  sim.preferFast = true;
  sim.setInput('clk', 0);
  sim.settle();
  sim.prepare();
  let c = 0, retired = 0;
  while (retired < j.golden.instructions && c < j.max) {
    await tick();
    if (retiring(sim)) retired++;
    clockCycle(sim);
    c++;
  }
  const st = cpuState(sim);
  return { cycles: c, retired, state: { x: st.x, dmem: st.dmem } };
}

const hex = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
function diffState(want: { x: number[]; dmem: number[] }, got: { x: number[]; dmem: number[] }): string {
  const out: string[] = [];
  want.x.forEach((v, i) => { if ((got.x[i] ?? 0) >>> 0 !== v >>> 0) out.push(`${ABI[i]} = ${hex(got.x[i] ?? 0)}, golden ${hex(v)}`); });
  want.dmem.forEach((v, i) => { if ((got.dmem[i] ?? 0) >>> 0 !== v >>> 0) out.push(`mem[${4 * i}] = ${hex(got.dmem[i] ?? 0)}, golden ${hex(v)}`); });
  return out.slice(0, 3).join('; ') + (out.length > 3 ? `; … (${out.length} differences)` : '');
}

function goldenRun(words: number[], imemK: number, dmemK: number, until?: (iss: ISS) => boolean, limit = 200_000) {
  const iss = new ISS(words, { dmemWords: 2 ** dmemK, imemWords: 2 ** imemK });
  while (!iss.halted && iss.steps < limit && !(until?.(iss))) iss.step();
  return iss;
}

/** Lock step on the cycle engine: the first retirement after which the registers or the PC differ from the golden model's. */
export async function firstMismatch(def: ComponentDef, words: number[], tick: () => Promise<void> = slicer(), budget = 30_000): Promise<string | undefined> {
  const sim = new DualSim(flatten(def));
  sim.preferFast = true;
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words);
  let last = 'reset';
  for (let c = 0; c < budget && !iss.halted; c++) {
    await tick();
    if (!retiring(sim)) { clockCycle(sim); continue; }
    const info = iss.step();
    clockCycle(sim);
    const st = cpuState(sim);
    last = `${info.text} at pc ${hex(info.pc)}`;
    if (st.pc >>> 0 !== iss.pc >>> 0) return `after ${last}: PC = ${hex(st.pc)}, golden ${hex(iss.pc)}`;
    const bad = st.x.findIndex((v, i) => v >>> 0 !== iss.x[i] >>> 0);
    if (bad >= 0) return `after ${last}: ${ABI[bad]} = ${hex(st.x[bad])}, golden ${hex(iss.x[bad])}`;
  }
  if (!iss.halted) return `no halt in ${budget} cycles (last: ${last})`;
  const st = cpuState(sim);
  const bad = st.dmem.findIndex((v, i) => v >>> 0 !== (iss.dmem[i] ?? 0) >>> 0);
  return bad >= 0 ? `after ${last}: mem[${4 * bad}] = ${hex(st.dmem[bad])}, golden ${hex(iss.dmem[bad] ?? 0)}` : undefined;
}

export async function checkProgram(p: Microprogram, opts: CheckOptions = {}): Promise<UcodeReport> {
  const t0 = performance.now();
  const tick = slicer(opts.signal), say = (t: string) => opts.onProgress?.(t);
  const problems = validate(p);
  const cycles = cyclesByClass(p);
  const nands = stats(microController(p)).nands;
  const base = { problems, cycles, nands };
  if (problems.some((x) => x.level === 'bad')) return { ...base, tests: [], benches: [], allPass: false, cpi: null, ms: performance.now() - t0 };
  const cpu = (words: number[], imemK: number, dmemK: number) => multicycleCpu(words, { control: 'micro', imemK, dmemK, microcode: p });

  // riscv-tests
  say('Loading the riscv-tests images…');
  const imgs = await rv32uiImages();
  const groups = new Map<number, Job[]>();
  const meta = new Map<Job, { imemK: number }>();
  for (const img of imgs) {
    await tick();
    const l = loadable(img, 6, 5);
    const iss = new ISS(l.words, { dmemWords: 2 ** l.dmemK, imemWords: 2 ** l.imemK });
    while (!iss.halted && iss.steps < 100_000) {
      iss.step();
      if (iss.dmem[l.tohost]) break;
    }
    const job: Job = { name: img.name, label: img.name.slice(7), words: l.words, golden: { instructions: iss.steps, x: [...iss.x], dmem: [...iss.dmem] }, max: Math.ceil(iss.steps * MAX_CPI * 1.25) + 100, tohost: l.tohost };
    meta.set(job, { imemK: l.imemK });
    groups.set(l.dmemK, [...(groups.get(l.dmemK) ?? []), job]);
  }
  const tests: TestResult[] = [];
  const failing: { words: number[]; imemK: number; dmemK: number; size: number }[] = [];
  for (const [dmemK, all] of groups) {
    for (let at = 0; at < all.length; at += LANES) {
      const jobs = all.slice(at, at + LANES), imemK = Math.max(...jobs.map((j) => meta.get(j)!.imemK));
      say(`riscv-tests: ${tests.length + 1}–${tests.length + jobs.length} of ${imgs.length}…`);
      const r = await runLanes(cpu(jobs[0].words, imemK, dmemK), jobs, imemK, tick);
      jobs.forEach((j, l) => {
        const v = verdict(r.verdicts[l], 'bare');
        tests.push({ name: j.label, pass: v.pass, text: v.text, cycles: r.cycles[l], instructions: j.golden.instructions });
        if (!v.pass) failing.push({ words: j.words, imemK, dmemK, size: j.golden.instructions });
      });
    }
  }

  // benchmarks
  say('Benchmarks…');
  const progs = BENCHMARKS.filter((b) => !b.needs?.m && !b.needs?.f);
  const jobs: Job[] = [];
  for (const b of progs) {
    const asm = assemble(b.source);
    if (asm.errors.length) throw new Error(`${b.id}: ${asm.errors[0].message}`);
    const iss = goldenRun(asm.words, BENCH_IMEM_K, BENCH_DMEM_K, undefined, 1_000_000);
    jobs.push({ name: b.name, label: b.id, words: asm.words, golden: { instructions: iss.steps, x: [...iss.x], dmem: [...iss.dmem] }, max: Math.ceil(iss.steps * MAX_CPI * 1.5) + 100 });
  }
  const benches: BenchResult[] = [];
  for (const j of jobs) {
    say(`Benchmark ${j.label}…`);
    const r = await runOnEngine(cpu(j.words, BENCH_IMEM_K, BENCH_DMEM_K), j, tick);
    const done = r.retired >= j.golden.instructions;
    const diff = !done ? `retired ${r.retired} of ${j.golden.instructions} instructions in ${r.cycles} cycles` : diffState(j.golden, r.state);
    if (diff) failing.push({ words: j.words, imemK: BENCH_IMEM_K, dmemK: BENCH_DMEM_K, size: j.golden.instructions });
    benches.push({ id: j.label, name: j.name, ok: !diff, diff, instructions: j.golden.instructions, cycles: r.cycles });
  }

  const allPass = tests.every((t) => t.pass) && benches.every((b) => b.ok);
  const cpi = benches.every((b) => b.ok) ? benches.reduce((a, b) => a + b.cycles, 0) / benches.reduce((a, b) => a + b.instructions, 0) : null;
  let mismatch: string | undefined;
  if (!allPass) {
    say('Replaying the smallest failing program in lock step…');
    const f = failing.sort((a, b) => a.size - b.size)[0];
    mismatch = f ? await firstMismatch(cpu(f.words, f.imemK, f.dmemK), f.words, tick) : undefined;
  }
  return { ...base, tests, benches, allPass, cpi, ...(mismatch ? { firstMismatch: mismatch } : {}), ms: performance.now() - t0 };
}

let book: Promise<UcodeReport> | null = null;
/** The book's microprogram, checked once (the "before" of every comparison). */
export function bookReport(opts?: CheckOptions): Promise<UcodeReport> {
  return (book ??= checkProgram(MC_PROGRAM, opts).catch((e) => { book = null; throw e; }));
}
