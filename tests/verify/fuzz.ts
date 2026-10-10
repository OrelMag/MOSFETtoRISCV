// Random-program fuzzing of the gate-level CPUs against the golden model. Programs (src/riscv/randprog32.ts)
// are drawn for what each CPU implements, run 32 at a time (one per BitSim lane) to their final jump-to-self,
// and every lane's final registers, FP state and data memory are compared with the golden model's. A mismatch
// is then replayed alone, in lock-step on the event-driven simulator, to find the first instruction whose
// result differs: the failure keeps the seed, the program, the cycle and that first differing state.

import { assemble } from '../../src/riscv/asm';
import { clockCycle, cpuState, dmemWords, retiring } from '../../src/riscv/cosim';
import { ABI, disasm, FABI } from '../../src/riscv/isa';
import { ISS } from '../../src/riscv/iss';
import { MultiISS } from '../../src/riscv/multi';
import { randomProgram32, type Rand32Options } from '../../src/riscv/randprog32';
import { BitSim, LANES } from '../../src/sim/bitsim';
import { flatten, type FlatDesign, type HierNode } from '../../src/sim/flatten';
import { GateSim } from '../../src/sim/gatesim';
import type { Sim } from '../../src/sim/sim';
import { type Bit, inPorts } from '../../src/sim/types';
import type { IsaCoverage, LaneProbe } from './coverage';
import { issOptions, type CpuConfig } from './cpus';
import { pause } from './run';

/** What a program leaves behind: registers per hart, FP registers and fcsr (F CPUs), data memory. */
export interface ArchState { x: number[][]; f?: number[]; fcsr?: number; dmem: number[] }

export interface FuzzCase {
  seed: number;
  source: string;
  words: number[];
  golden: ArchState;
  /** Golden-model steps (cycles of the multi-core model) to the halt. */
  steps: number;
  /** Address of the final jump-to-self. */
  halt: number;
}

export interface FuzzResult { seed: number; ok: boolean; diff: string; cycles: number }

const log2up = (n: number) => Math.ceil(Math.log2(Math.max(2, n)));
const hex = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

export const fuzzDmemK = (cfg: CpuConfig) => cfg.fixedDmemK ?? 5;

export function fuzzOptions(cfg: CpuConfig, n: number): Rand32Options {
  const { sub, m, f, system, mp } = cfg.isa;
  return { n, sub, m, f, system, mp, dmemWords: 2 ** fuzzDmemK(cfg) };
}

/** A program for `cfg` from `seed`, run on the golden model to its halt. */
export function fuzzCase(cfg: CpuConfig, seed: number, n = 60, cov?: IsaCoverage): FuzzCase {
  const source = randomProgram32(seed, fuzzOptions(cfg, n));
  const asm = assemble(source);
  if (asm.errors.length) throw new Error(`seed ${seed}: line ${asm.errors[0].line}: ${asm.errors[0].message}\n${source}`);
  const words = asm.words, halt = asm.labels.get('halt')!, dmemWords = 2 ** fuzzDmemK(cfg), imemWords = 2 ** log2up(words.length);
  if (cfg.isa.mp) {
    const m = new MultiISS(words, 2, dmemWords, imemWords);
    while (!m.halted && m.cycles < 50_000) { m.step(); if (cov) for (const s of m.last) if (s) cov.step(s); }
    if (!m.halted) throw new Error(`seed ${seed}: the golden model does not halt\n${source}`);
    return { seed, source, words, halt, steps: m.cycles, golden: { x: m.harts.map((h) => [...h.x]), dmem: [...m.dmem] } };
  }
  const iss = new ISS(words, { ...issOptions(cfg.isa), dmemWords, imemWords });
  while (!iss.halted && iss.steps < 50_000) { const s = iss.step(); cov?.step(s); }
  if (!iss.halted) throw new Error(`seed ${seed}: the golden model does not halt\n${source}`);
  return {
    seed, source, words, halt, steps: iss.steps,
    golden: { x: [[...iss.x]], dmem: [...iss.dmem], ...(cfg.isa.f ? { f: [...iss.f], fcsr: (iss.frm << 5) | iss.fflags } : {}) },
  };
}

/** The architectural state of the CPU in `root` (a lone CPU, or the multi-core with core0 / core1 and a shared dm). */
function readState(sim: Pick<Sim, 'getBits' | 'design'>, root: HierNode, f: boolean): ArchState {
  const kids = root.children!;
  if (kids.has('core0')) {
    return { x: ['core0', 'core1'].map((c) => cpuState(sim, kids.get(c)!).x), dmem: dmemWords(sim, kids.get('dm')!) };
  }
  const s = cpuState(sim, root);
  return { x: [s.x], dmem: s.dmem, ...(f ? { f: s.f, fcsr: s.fcsr } : {}) };
}

/** What differs between two states, golden first ('' when equal). */
export function diffState(want: ArchState, got: ArchState): string {
  const out: string[] = [];
  want.x.forEach((xs, h) => xs.forEach((v, i) => {
    if ((got.x[h]?.[i] ?? 0) >>> 0 !== v >>> 0) out.push(`${want.x.length > 1 ? `hart ${h} ` : ''}${ABI[i]} = ${hex(got.x[h]?.[i] ?? 0)}, golden ${hex(v)}`);
  }));
  want.f?.forEach((v, i) => { if ((got.f?.[i] ?? 0) >>> 0 !== v >>> 0) out.push(`${FABI[i]} = ${hex(got.f?.[i] ?? 0)}, golden ${hex(v)}`); });
  if (want.fcsr !== undefined && got.fcsr !== want.fcsr) out.push(`fcsr = 0x${(got.fcsr ?? 0).toString(16)}, golden 0x${want.fcsr.toString(16)}`);
  want.dmem.forEach((v, i) => { if ((got.dmem[i] ?? 0) >>> 0 !== v >>> 0) out.push(`mem[${4 * i}] = ${hex(got.dmem[i] ?? 0)}, golden ${hex(v)}`); });
  return out.slice(0, 6).join('; ') + (out.length > 6 ? `; … (${out.length} differences)` : '');
}

/** Cycles a lane keeps running after its fetch reached the halt (longer than any stall: divide 34, miss 12). */
const DRAIN = 64;

/** Cycle budget of a case on cfg. */
const budget = (cfg: CpuConfig, c: FuzzCase) => Math.ceil(c.steps * cfg.cpi * 1.25) + 100;

/** Up to 32 cases on one build of cfg (one per lane), final states compared with the golden model's. */
export async function fuzzLanes(cfg: CpuConfig, cases: FuzzCase[], probe?: (design: FlatDesign) => LaneProbe): Promise<FuzzResult[]> {
  if (cases.length > LANES) throw new Error('fuzzLanes: at most 32 cases');
  const imemK = Math.max(cfg.imemK ?? 6, ...cases.map((c) => log2up(c.words.length)));
  const design = flatten(cfg.build(cases[0].words, imemK, fuzzDmemK(cfg)));
  const sim = new BitSim(design);
  const N = 2 ** imemK;
  const progs = Array.from({ length: LANES }, (_, l) => cases[l % cases.length].words);
  design.leaves.forEach((leaf, i) => {
    if (leaf.kind !== 'behavior' || leaf.inputs.length === 0) return;
    if (!leaf.def.id.startsWith('rom_')) throw new Error(`${cfg.id}: behavioural leaf ${leaf.node.path.join('.')} is not a ROM`);
    if (leaf.node.path.includes('imem')) sim.setLaneBehavior(i, ([a], lane) => [progs[lane][Math.floor(a / 4) % N] ?? 0x13]);
    else sim.setLaneBehavior(i, (ins) => leaf.def.behavior!.eval(ins, undefined));
  });
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const max = Math.max(...cases.map((c) => budget(cfg, c)));
  const pr = probe?.(design);
  // A lane is done once its fetch (every hart's) reaches the halt: all paths lead there, forward. It still runs
  // DRAIN cycles for what is in flight (a divide, an FP iteration, a cache miss); coverage counts 4 of them.
  const root = design.root.ports, pcs = root.pc0 ? [root.pc0, root.pc1] : [root.pcF ?? root.pcOut].filter(Boolean);
  const reached = cases.map(() => Infinity);
  let c = 0;
  for (; c < max && (!pcs.length || reached.some((r) => c < r + DRAIN)); c++) {
    if ((c & 63) === 63) await pause();
    sim.cycle();
    let active = 0;
    cases.forEach((cs, l) => {
      if (reached[l] === Infinity && pcs.every((p) => p.reduce((a, n, i) => a + ((sim.v[n] >>> l) & 1) * 2 ** i, 0) === cs.halt)) reached[l] = c;
      if (c < reached[l] + 4) active |= 1 << l;
    });
    pr?.cycle(sim, active);
  }
  const cycles = c;
  return cases.map((c, l) => {
    const view = { design, getBits: (nets: readonly number[]) => nets.map((n) => ((sim.v[n] >>> l) & 1) as Bit) };
    const diff = diffState(c.golden, readState(view, design.root, !!cfg.isa.f));
    return { seed: c.seed, ok: !diff, diff, cycles };
  });
}

/**
 * Replay one case in lock-step on the event-driven simulator: the golden model steps whenever the CPU retires,
 * and the registers are compared after every retirement. Describes the first difference (cycle, instruction,
 * registers), or the memory difference at the end. Single-core CPUs only.
 */
export async function firstDivergence(cfg: CpuConfig, c: FuzzCase): Promise<string> {
  if (cfg.isa.mp) return 'final state only (multi-core)';
  const imemK = Math.max(cfg.imemK ?? 6, log2up(c.words.length));
  const design = flatten(cfg.build(c.words, imemK, fuzzDmemK(cfg)));
  const sim = new GateSim(design);
  for (const p of inPorts(design.root.def)) sim.setInput(p.name, 0);
  sim.settle();
  const iss = new ISS(c.words, { ...issOptions(cfg.isa), dmemWords: 2 ** fuzzDmemK(cfg), imemWords: 2 ** imemK });
  const f = !!cfg.isa.f, pcW = design.root.ports.pcW;
  for (let cyc = 1; cyc <= budget(cfg, c) && !iss.halted; cyc++) {
    if ((cyc & 15) === 0) await pause();
    const ret = retiring(sim);
    // a pipeline says which instruction retires: it must be the golden model's next
    const at = ret && pcW ? sim.getBits(pcW).reduce<number>((a, b, i) => a + b * 2 ** i, 0) : iss.pc;
    if (at !== iss.pc) return `cycle ${cyc}: retiring ${hex(at)}, golden ${hex(iss.pc)} ${disasm(iss.fetch(iss.pc), iss.pc)} (control flow went astray)`;
    clockCycle(sim);
    if (!ret) continue;
    const info = iss.step();
    const want: ArchState = { x: [[...iss.x]], dmem: [], ...(f ? { f: [...iss.f], fcsr: (iss.frm << 5) | iss.fflags } : {}) };
    const got = readState(sim, design.root, f);
    const d = diffState(want, { ...got, dmem: [] });
    if (d) return `cycle ${cyc}, retiring ${hex(info.pc)} ${info.text}${info.trap ? ` (trap ${info.trap.cause})` : ''}: ${d}`;
  }
  const d = diffState({ x: [], dmem: [...iss.dmem] }, { x: [], dmem: readState(sim, design.root, false).dmem });
  return d ? `at the halt: ${d}` : iss.halted ? 'no difference in lock-step (the lanes disagree with the event-driven run)' : 'the golden model did not halt in the budget';
}
