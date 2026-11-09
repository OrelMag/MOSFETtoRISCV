// Coverage (DOM-free; the chapter "How do you know it works?"): what a set of tests reached. Two kinds, as CI keeps them
// (tests/verify/coverage.ts): the instructions the golden model executed, and hardware events read off the gate-level
// pipeline's own nets while the programs ran: each forwarding path, the write-back bypass, the load-use stall, the flush
// after a taken branch. Coverage says what was never exercised; it cannot say whether what was exercised was checked
// in every combination that matters.

import { pipelinedCpu } from '../lib/pipeline';
import { decode, INSTRS } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { loadable } from '../riscv/rvimage';
import { findNode } from '../sim/flatten';
import type { BitSim } from '../sim/bitsim';
import { caseOf, fuzzCase, lanesFor, imemKOf, slicer, type Case, type FuzzCpu } from './fuzz';
import { rv32uiImages } from './rvtests';

/** The word-access RV32I instructions the chapters' CPUs implement (lb / sb … are a later CPU's). */
export const RV32I_WORD: string[] = INSTRS.filter((s) => s.hw && !s.fp && !s.custom && !s.simt && !s.mac).map((s) => s.name);

/** Pipeline events, in the order the widget lists them. */
export const EVENTS = [
  { key: 'fwdAM', label: 'forward A from M' }, { key: 'fwdAW', label: 'forward A from W' },
  { key: 'fwdBM', label: 'forward B from M' }, { key: 'fwdBW', label: 'forward B from W' },
  { key: 'bypass', label: 'write-back bypass into D' }, { key: 'stall', label: 'load-use stall' }, { key: 'flush', label: 'flush after a taken branch' },
] as const;
export type EventKey = (typeof EVENTS)[number]['key'];

export interface CoverageReport {
  /** Programs run. */
  programs: number;
  /** Times the golden model executed each instruction (RV32I_WORD names). */
  instrs: Record<string, number>;
  /** Cycles each event happened on the gates (summed over the programs). */
  events: Record<EventKey, number>;
}

const blank = (): CoverageReport => ({ programs: 0, instrs: Object.fromEntries(RV32I_WORD.map((n) => [n, 0])), events: Object.fromEntries(EVENTS.map((e) => [e.key, 0])) as Record<EventKey, number> });

/** The pipeline with ports to read; programs fetched per lane (the fuzz runner's build). */
export const PIPE: FuzzCpu = { cpi: 4, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, dmemK }) };

function countInstrs(rep: CoverageReport, words: number[], imemWords: number, dmemWords: number, until?: (iss: ISS) => boolean): void {
  const iss = new ISS(words, { imemWords, dmemWords });
  while (!iss.halted && iss.steps < 100_000) {
    const s = iss.step();
    const name = decode(s.word).name;
    if (name in rep.instrs) rep.instrs[name]++;
    if (until?.(iss)) break;
  }
}

/** Run cases on the pipeline's gates, counting events per active lane and cycle. */
async function countEvents(rep: CoverageReport, cases: Case[], tick: () => Promise<void>): Promise<void> {
  for (let at = 0; at < cases.length; at += 32) {
    const batch = cases.slice(at, at + 32);
    const lanes = lanesFor(PIPE, imemKOf(batch), batch[0].words);
    const hz = findNode(lanes.design.root, ['hz'])!.ports;
    const bits = (sim: BitSim, nets: number[]) => nets.map((n) => sim.v[n]);
    // a lane counts until it has retired as many instructions as the golden model ran (the fetch reaches the halt
    // early, speculatively, right after a loop's branch)
    const validW = lanes.design.root.ports.validW[0], retired = new Array<number>(32).fill(0);
    await lanes.run(batch, PIPE.cpi, tick, (sim) => {
      let active = 0;
      batch.forEach((c, l) => { if (retired[l] < c.steps) active |= 1 << l; });
      const [a0, a1] = bits(sim, hz.forwardA), [b0, b1] = bits(sim, hz.forwardB);
      const by = sim.v[hz.bypassA[0]] | sim.v[hz.bypassB[0]];
      const pop = (m: number) => { let k = 0; for (let x = m & active; x; x &= x - 1) k++; return k; };
      rep.events.fwdAM += pop(a1 & ~a0); rep.events.fwdAW += pop(a0 & ~a1);
      rep.events.fwdBM += pop(b1 & ~b0); rep.events.fwdBW += pop(b0 & ~b1);
      rep.events.bypass += pop(by); rep.events.stall += pop(~sim.v[hz.enPC[0]]); rep.events.flush += pop(sim.v[hz.flushFD[0]]);
      batch.forEach((_, l) => { retired[l] += (sim.v[validW] >>> l) & 1; });
      return batch.some((c, l) => retired[l] < c.steps);
    });
  }
}

/** A program (assembly source) on the golden model and the gates. */
export async function coverProgram(source: string, signal?: { aborted: boolean }): Promise<CoverageReport> {
  const rep = blank(), c = caseOf(PIPE, 0, source);
  if (!c) throw new Error('the program does not halt');
  rep.programs = 1;
  countInstrs(rep, c.words, 2 ** imemKOf([c]), 32);
  await countEvents(rep, [c], slicer(signal));
  return rep;
}

/** n random programs (seeds 1 … n), as the CI fuzzing draws them for RV32I. */
export async function coverRandom(n: number, signal?: { aborted: boolean }): Promise<CoverageReport> {
  const rep = blank(), cases = Array.from({ length: n }, (_, i) => fuzzCase(PIPE, i + 1));
  rep.programs = n;
  for (const c of cases) countInstrs(rep, c.words, 2 ** imemKOf([c]), 32);
  await countEvents(rep, cases, slicer(signal));
  return rep;
}

/** The rv32ui tests: instructions only (their images run on the golden model; their events need the tohost loader). */
export async function coverRiscvTests(): Promise<CoverageReport> {
  const rep = blank(), imgs = await rv32uiImages();
  rep.programs = imgs.length;
  for (const img of imgs) {
    const l = loadable(img, 6, 5);
    countInstrs(rep, l.words, 2 ** l.imemK, 2 ** l.dmemK, (iss) => !!iss.dmem[l.tohost]);
  }
  return rep;
}

/** Instructions of RV32I_WORD a report reached, and events that happened. */
export const reached = (r: CoverageReport) => ({
  instrs: RV32I_WORD.filter((n) => r.instrs[n] > 0).length,
  events: EVENTS.filter((e) => r.events[e.key] > 0).length,
});

