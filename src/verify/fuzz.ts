// Random-program testing in the browser (DOM-free; the chapter "How do you know it works?", docs/PLAN-VERIFY.md). The
// same method as tests/verify/fuzz.ts, which runs in CI on every CPU: a program drawn from a seed (riscv/randprog32.ts) runs
// on the golden model to its halt, then on the gates, up to 32 programs at once (one per BitSim lane), and the final
// registers, FP state and data memory are compared. tests/verify-browser.test.ts holds this runner's verdicts equal to the
// CI harness's on the same seeds. Plus what a failure is worth: the first instruction whose result differs (a lock-step
// replay on the event-driven simulator), and the program made small (delta debugging, 32 candidates a pass, one per lane).

import { assemble } from '../riscv/asm';
import { clockCycle, cpuState, retireCount, retirePc } from '../riscv/cosim';
import { ABI, FABI } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { randomProgram32 } from '../riscv/randprog32';
import { BitSim, LANES } from '../sim/bitsim';
import { flatten, type FlatDesign } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { nextTask } from '../sim/tasks';
import { inPorts, type Bit, type ComponentDef } from '../sim/types';

export interface FuzzCpu {
  /** The CPU with this program (2^imemK instruction words, 2^dmemK data words). */
  build(words: number[], imemK: number, dmemK: number): ComponentDef;
  /** Its instruction set: F and M on top of RV32I (word accesses only). */
  f?: boolean;
  m?: boolean;
  /** Worst cycles per instruction, for the cycle budget. */
  cpi: number;
}

export interface ArchState { x: number[]; f?: number[]; fcsr?: number; dmem: number[] }

export interface Case {
  seed: number;
  source: string;
  words: number[];
  golden: ArchState;
  steps: number;
  halt: number;
}

export interface Verdict { seed: number; ok: boolean; diff: string }

const DMEM_K = 5;
const DRAIN = 64;
const log2up = (n: number) => Math.ceil(Math.log2(Math.max(2, n)));
const hex = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** A program's source run on the golden model to its halt, or null when it does not assemble or halt (a shrunk candidate). */
export function caseOf(cpu: FuzzCpu, seed: number, source: string): Case | null {
  const asm = assemble(source);
  const halt = asm.labels.get('halt');
  if (asm.errors.length || halt === undefined) return null;
  const words = asm.words;
  const iss = new ISS(words, { f: !!cpu.f, m: !!cpu.m, dmemWords: 2 ** DMEM_K, imemWords: 2 ** log2up(words.length) });
  while (!iss.halted && iss.steps < 20_000) iss.step();
  if (!iss.halted) return null;
  return {
    seed, source, words, halt, steps: iss.steps,
    golden: { x: [...iss.x], dmem: [...iss.dmem], ...(cpu.f ? { f: [...iss.f], fcsr: (iss.frm << 5) | iss.fflags } : {}) },
  };
}

/** The random program of a seed, as CI draws it for this instruction set. */
export function fuzzCase(cpu: FuzzCpu, seed: number): Case {
  const c = caseOf(cpu, seed, randomProgram32(seed, { n: 60, m: cpu.m, f: cpu.f, dmemWords: 2 ** DMEM_K }));
  if (!c) throw new Error(`seed ${seed}: the program does not halt`);
  return c;
}

/** What differs, golden first ('' when equal). */
export function diffState(want: ArchState, got: ArchState): string {
  const out: string[] = [];
  want.x.forEach((v, i) => { if ((got.x[i] ?? 0) >>> 0 !== v >>> 0) out.push(`${ABI[i]} = ${hex(got.x[i] ?? 0)}, golden ${hex(v)}`); });
  want.f?.forEach((v, i) => { if ((got.f?.[i] ?? 0) >>> 0 !== v >>> 0) out.push(`${FABI[i]} = ${hex(got.f?.[i] ?? 0)}, golden ${hex(v)}`); });
  if (want.fcsr !== undefined && got.fcsr !== want.fcsr) out.push(`fcsr = 0x${(got.fcsr ?? 0).toString(16)}, golden 0x${want.fcsr.toString(16)}`);
  want.dmem.forEach((v, i) => { if ((got.dmem[i] ?? 0) >>> 0 !== v >>> 0) out.push(`mem[${4 * i}] = ${hex(got.dmem[i] ?? 0)}, golden ${hex(v)}`); });
  return out.slice(0, 4).join('; ') + (out.length > 4 ? `; … (${out.length} differences)` : '');
}

/** One build of a CPU on BitSim, each lane fetching its own program: reused for every batch of the same sizes. */
export class Lanes {
  readonly design: FlatDesign;
  readonly sim: BitSim;
  private progs: number[][] = [];
  /** The power-on state (BitSim has no reset: each batch starts from a copy). */
  private readonly v0: Int32Array;
  constructor(def: ComponentDef, readonly N: number) {
    this.design = flatten(def);
    this.sim = new BitSim(this.design);
    this.design.leaves.forEach((leaf, i) => {
      if (leaf.kind !== 'behavior' || leaf.inputs.length === 0) return;
      const b = leaf.def.behavior!;
      if (leaf.node.path.includes('imem')) this.sim.setLaneBehavior(i, ([a], lane) => [this.progs[lane]?.[Math.floor(a / 4) % N] ?? 0x13]);
      else if (leaf.def.id.startsWith('rom_')) this.sim.setLaneBehavior(i, (ins) => b.eval(ins, undefined));
      else throw new Error(`behavioural leaf ${leaf.node.path.join('.')} (${leaf.def.id}) is neither a ROM nor a table`);
    });
    this.v0 = this.sim.v.slice();
  }
  /** Run up to 32 cases from power-on to their halts (plus a drain), each lane's final state compared with its golden one. */
  async run(cases: Case[], cpi: number, tick: () => Promise<void>, probe?: (sim: BitSim, active: number) => boolean | void): Promise<string[]> {
    const { sim, design } = this;
    this.progs = Array.from({ length: LANES }, (_, l) => cases[l % cases.length].words);
    sim.v.set(this.v0);
    for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
    sim.settle();
    const max = Math.max(...cases.map((c) => Math.ceil(c.steps * cpi * 1.25) + 100));
    const root = design.root.ports, pc = root.pcF ?? root.pcOut;
    const reached = cases.map(() => Infinity);
    let c = 0, more = false;
    // a probe that still has lanes to watch keeps the run going past the halts (a loop fetches its halt early)
    for (; c < max && (more || reached.some((r) => c < r + DRAIN)); c++) {
      if ((c & 31) === 31) await tick();
      sim.cycle();
      let active = 0;
      cases.forEach((cs, l) => {
        if (reached[l] === Infinity && pc.reduce((a, n, i) => a + ((sim.v[n] >>> l) & 1) * 2 ** i, 0) === cs.halt) reached[l] = c;
        if (reached[l] === Infinity) active |= 1 << l;
      });
      more = probe?.(sim, active) === true;
    }
    return cases.map((cs, l) => {
      const view = { design, getBits: (nets: readonly number[]): Bit[] => nets.map((n) => ((sim.v[n] >>> l) & 1) as Bit) };
      const s = cpuState(view, design.root);
      return diffState(cs.golden, { x: s.x, dmem: s.dmem, ...(cs.golden.f ? { f: s.f, fcsr: s.fcsr } : {}) });
    });
  }
}

/** A cooperative pause: every ~12 ms the page gets a frame (nothing in the browser waits on a long run). */
export function slicer(signal?: { aborted: boolean }): () => Promise<void> {
  let t = performance.now();
  return async () => {
    if (signal?.aborted) throw new Error('aborted');
    if (performance.now() - t < 12) return;
    await nextTask();
    t = performance.now();
  };
}

const lanesCache = new WeakMap<FuzzCpu, Map<number, Lanes>>();
export function lanesFor(cpu: FuzzCpu, imemK: number, words: number[]): Lanes {
  let m = lanesCache.get(cpu);
  if (!m) lanesCache.set(cpu, (m = new Map()));
  let l = m.get(imemK);
  if (!l) m.set(imemK, (l = new Lanes(cpu.build(words, imemK, DMEM_K), 2 ** imemK)));
  return l;
}

/** Instruction-memory size every case fits (a power of two, at least 2^6 words). */
export const imemKOf = (cases: Case[]) => Math.max(6, ...cases.map((c) => log2up(c.words.length)));

/** Up to 32 seeds at once on the gates: each one's verdict. */
export async function fuzzBatch(cpu: FuzzCpu, seeds: number[], tick: () => Promise<void> = slicer()): Promise<Verdict[]> {
  const cases = seeds.map((s) => fuzzCase(cpu, s));
  const k = imemKOf(cases);
  const diffs = await lanesFor(cpu, k, cases[0].words).run(cases, cpu.cpi, tick);
  return cases.map((c, i) => ({ seed: c.seed, ok: !diffs[i], diff: diffs[i] }));
}

/**
 * Replay one case alone, in lock step on the event-driven simulator: the golden model steps whenever the CPU retires
 * and the registers are compared after every retirement. The first difference, in words, or '' if none shows.
 */
export async function firstDivergence(cpu: FuzzCpu, c: Case, tick: () => Promise<void> = slicer()): Promise<{ text: string; cycle: number; pc: number } | null> {
  const imemK = imemKOf([c]);
  const design = flatten(cpu.build(c.words, imemK, DMEM_K));
  const sim = new GateSim(design);
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const iss = new ISS(c.words, { f: !!cpu.f, m: !!cpu.m, dmemWords: 2 ** DMEM_K, imemWords: 2 ** imemK });
  const max = Math.ceil(c.steps * cpu.cpi * 1.25) + 100;
  for (let cyc = 1; cyc <= max && !iss.halted; cyc++) {
    if ((cyc & 7) === 0) await tick();
    const ret = retireCount(sim);
    const at = (ret ? retirePc(sim, design.root) : null) ?? iss.pc;
    if (at !== iss.pc) return { text: `cycle ${cyc}: the CPU retires the instruction at ${hex(at)}, the golden model's next is at ${hex(iss.pc)}: control flow went astray`, cycle: cyc, pc: iss.pc };
    clockCycle(sim);
    if (!ret) continue;
    const info = iss.step();
    const s = cpuState(sim, design.root);
    const d = diffState({ x: [...iss.x], dmem: [], ...(cpu.f ? { f: [...iss.f], fcsr: (iss.frm << 5) | iss.fflags } : {}) }, { x: s.x, dmem: [], ...(cpu.f ? { f: s.f, fcsr: s.fcsr } : {}) });
    if (d) return { text: `cycle ${cyc}, after ${hex(info.pc)} ${info.text}: ${d}`, cycle: cyc, pc: info.pc };
  }
  return null;
}

/** The instruction lines of a program (not labels, directives or blank lines): what shrinking may delete. */
const isInstr = (line: string) => /^\s+[a-z]/.test(line) && !/^\s+\./.test(line) && !/^\s+j\s+halt\b/.test(line);

export interface ShrinkResult {
  source: string;
  /** Instructions in the program before and after. */
  before: number;
  after: number;
  /** Candidates run on the gates. */
  tried: number;
  /** Every pass: instructions kept. */
  passes: number[];
}

/**
 * Delta debugging (Zeller): delete chunks of the failing program's instructions, halves first, then smaller, keeping any
 * deletion after which the program still assembles, halts on the golden model and still fails on the gates. Each pass
 * runs up to 32 candidates at once, one per lane. Ends when no single instruction can go.
 */
export async function shrink(cpu: FuzzCpu, c: Case, tick: () => Promise<void> = slicer(), onPass?: (kept: number) => void): Promise<ShrinkResult> {
  let lines = c.source.split('\n');
  const count = () => lines.filter(isInstr).length;
  const before = count(), passes = [before];
  let tried = 0, chunk = Math.max(1, Math.floor(before / 2));
  const k = imemKOf([c]);
  const lanes = lanesFor(cpu, k, c.words);
  while (chunk >= 1) {
    const idx = lines.map((l, i) => (isInstr(l) ? i : -1)).filter((i) => i >= 0);
    // candidates: each chunk of `chunk` instructions removed
    const cands: { lines: string[]; c: Case }[] = [];
    for (let s = 0; s < idx.length; s += chunk) {
      const drop = new Set(idx.slice(s, s + chunk));
      const next = lines.filter((_, i) => !drop.has(i));
      const nc = caseOf(cpu, c.seed, next.join('\n'));
      if (nc && log2up(nc.words.length) <= k) cands.push({ lines: next, c: nc });
    }
    let kept = false;
    for (let b = 0; b < cands.length && !kept; b += LANES) {
      const batch = cands.slice(b, b + LANES);
      tried += batch.length;
      const diffs = await lanes.run(batch.map((x) => x.c), cpu.cpi, tick);
      const hit = diffs.findIndex((d) => d);
      if (hit >= 0) { lines = batch[hit].lines; kept = true; }
    }
    if (kept) { passes.push(count()); onPass?.(count()); continue; }
    if (chunk === 1) break;
    chunk = Math.max(1, Math.floor(chunk / 2));
  }
  return { source: lines.join('\n'), before, after: count(), tried, passes };
}
