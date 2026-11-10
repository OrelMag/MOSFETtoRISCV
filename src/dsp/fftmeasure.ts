// An FFT program of fftpy.ts run on the gate-level pipelined RV32IM (cycle engine) with PipeProfile: what scripts/fft-costs.ts writes to
// src/dsp/fftcosts.json and tests/fft-software.test.ts re-measures. The result lists are read back from the gates' data memory and compared
// with the interpreter's (the golden model of the language), and the error is taken against a float DFT. No DOM.

import { compilePy } from '../lang/compile';
import { runPy } from '../lang/interp';
import { lineTotal, PipeProfile } from '../lang/pipeprof';
import { pipelinedCpu } from '../lib/pipeline';
import { clockCycle, dmemWords } from '../riscv/cosim';
import { DualSim } from '../sim/dualsim';
import { flatten } from '../sim/flatten';
import { dftFloat, sourceHash, type FftCase } from './fftpy';

export interface FftCost {
  hash: string;
  /** Words of program (the list literals are stored by instructions, so they count). */
  words: number;
  /** Clocks on the pipeline to the halt, and how they were spent. */
  cycles: number;
  /** Instructions retired: the single-cycle RV32IM's clocks. */
  instrs: number;
  stall: number;
  flush: number;
  /** The transform alone (its lines, without the data's set-up and the prints): clocks and instructions. */
  kernel: number;
  kernelInstrs: number;
  /** Every kernel line: [line, clocks, instructions]. */
  perLine: [number, number, number][];
  /** The Python lines that cost the most clocks: [line, clocks]. */
  top: [number, number][];
  /** Largest |gates − float DFT| over every bin, real and imaginary, in LSB. */
  maxErr: number;
  /** The gates' result lists equal the interpreter's. */
  agrees: boolean;
}

const haltOf = (labels: Map<string, number>) => labels.get('halt') ?? labels.get('program.halt') ?? 0;

export async function measureFft(c: FftCase, tick: () => Promise<void> = async () => {}): Promise<FftCost> {
  const p = c.program;
  const comp = compilePy(p.source, { dmemWords: 2 ** c.dmemK, m: true });
  if (comp.error) throw new Error(`${p.variant}${p.N}: ${comp.error.message}`);
  if (comp.words.length > 2 ** c.imemK) throw new Error(`${p.variant}${p.N}: ${comp.words.length} words, ROM ${2 ** c.imemK}`);
  const sim = new DualSim(flatten(pipelinedCpu(comp.words, { imemK: c.imemK, dmemK: c.dmemK, m: true })));
  sim.preferFast = true;
  sim.prepare();
  sim.setInput('clk', 0);
  sim.settle();
  const prof = new PipeProfile(comp, haltOf(comp.assembled!.labels));
  let last = Date.now();
  while (!prof.finished && prof.cycles < 2_000_000) {
    prof.sample(sim);
    clockCycle(sim);
    if (Date.now() - last > 200) { await tick(); last = Date.now(); }
  }
  if (!prof.finished) throw new Error(`${p.variant}${p.N}: no halt`);
  // let the last stores reach the memory, then read the lists
  for (let i = 0; i < 4; i++) clockCycle(sim);
  const mem = dmemWords(sim, sim.design.root.children!.get('dm')!);
  const read = (name: string) => { const l = comp.layout!.lists.find((x) => x.name === name)!; return Array.from({ length: l.len }, (_, i) => mem[(l.addr >>> 2) + i] | 0); };
  const yr = read(p.out.re), yi = read(p.out.im);
  const golden = runPy(p.source, { maxSteps: 10_000_000, maxDepth: 400 });
  const lists = golden.lists as unknown as Map<string, number[]>;
  const agrees = JSON.stringify(yr) === JSON.stringify(lists.get(p.out.re)) && JSON.stringify(yi) === JSON.stringify(lists.get(p.out.im));
  const ref = dftFloat(c.re, c.im);
  let maxErr = 0;
  for (let k = 0; k < p.out.bins; k++) maxErr = Math.max(maxErr, Math.abs(yr[k] - ref.re[k]), Math.abs(yi[k] - ref.im[k]));
  const t = prof.total(), f = prof.cost(0);
  const lines = [...new Set(comp.lines.map((l) => l.py).filter((x): x is number => !!x))];
  const [k0, k1] = p.kernel;
  const inK = lines.filter((l) => l >= k0 && l <= k1);
  const kernel = inK.reduce((a, l) => a + lineTotal(prof.cost(l)), 0), kernelInstrs = inK.reduce((a, l) => a + prof.cost(l).instr, 0);
  const top = lines.map((l): [number, number] => [l, lineTotal(prof.cost(l))]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    hash: sourceHash(p.source), words: comp.words.length, cycles: prof.cycles,
    instrs: t.instr + f.instr, kernel, kernelInstrs, perLine: inK.sort((a, b) => a - b).map((l): [number, number, number] => [l, lineTotal(prof.cost(l)), prof.cost(l).instr]), stall: t.stall + f.stall, flush: t.flush + f.flush, top,
    maxErr: Math.round(maxErr * 100) / 100, agrees,
  };
}
