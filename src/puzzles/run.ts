// Check for a program puzzle: every test played on the chip's own gates (the sandbox's simulation, its cycle
// engine where it can), from power-on: PUZZLE IN holds the test's words, the clock runs until a halt part
// reads 1 (or the puzzle's cycle limit), and PUZZLE OUT must have recorded exactly the expected words. The
// score: cycles (mean over the tests), the hardware's NANDs (the program ROM left out: the program is scored
// by its size) and the program's words. No DOM.

import type { Compiled } from '../editor/compile';
import type { ChipDoc, PartDoc, PinDoc } from '../editor/model';
import { romImage } from '../editor/memory';
import { loadedIn, type PuzzleInState, puzzleLeaves, type PuzzleOutState } from '../editor/puzzleparts';
import { EditorSim } from '../editor/runtime';
import { type ComponentDef, netlistOf } from '../sim/types';
import { inputOn, outputFrom, type Puzzle, type PuzzleTest } from './puzzles';

export interface TestRun {
  name: string;
  ok: boolean;
  /** Why it failed (first reason). */
  why?: string;
  /** Clock cycles until the halt read 1 (or the limit). */
  cycles: number;
  input: number[];
  expect: number[];
  /** Puzzle words recorded (-1: one with an X bit). */
  got: number[];
  /** The cycle the first wrong (or missing) word showed it, for the player. */
  badAt?: number;
}

export interface PuzzleRun {
  ok: boolean;
  /** Why it could not run at all (no ports, no clock, no halt, a broken circuit). */
  problems: string[];
  results: TestRun[];
  /** Mean cycles over the tests (one decimal). */
  cycles: number;
  /** Bits of the PUZZLE IN / OUT ports found. */
  width: number;
}

const fmt = (ws: number[]) => (ws.length ? ws.map((v) => (v < 0 ? 'X' : String(v))).join(' ') : 'nothing');

/** The cases a run needs from the simulation it plays on (shared with the player). */
export interface PortsFound { inLi: number; outLi: number; inW: number; outW: number }

/** The ports of the simulation, or what is missing. */
export function findPorts(es: EditorSim): PortsFound | string[] {
  const sim = es.sim;
  if (!sim) return es.diags.length ? es.diags.map((d) => d.msg) : ['the circuit cannot be simulated'];
  const { ins, outs } = puzzleLeaves(sim);
  const out: string[] = [];
  if (ins.length !== 1) out.push(ins.length ? `${ins.length} PUZZLE IN parts: keep one` : 'no PUZZLE IN part (Inputs & outputs ▸ Puzzle in): the tests\' words come from it');
  if (outs.length !== 1) out.push(outs.length ? `${outs.length} PUZZLE OUT parts: keep one` : 'no PUZZLE OUT part (Inputs & outputs ▸ Puzzle out): the words written are checked there');
  if (!es.hasClock) out.push('no clock pin: a test runs the clock until the halt part reads 1');
  if (!es.hasHalt) out.push('no halt part (Displays ▸ Halt): a test ends when it reads 1');
  if (out.length) return out;
  return { inLi: ins[0].li, outLi: outs[0].li, inW: ins[0].width, outW: outs[0].width };
}

/** Power on with test `t`'s words in PUZZLE IN (the simulation's clock low). */
export function loadTest(es: EditorSim, ports: PortsFound, p: Puzzle, t: PuzzleTest): void {
  es.reset('zero');
  es.pokeLeaf(ports.inLi, loadedIn(inputOn(p, t, ports.inW), es.sim?.leafState(ports.inLi)));
}

/** Judge the state after a test ran `cycles` cycles. */
export function judge(es: EditorSim, ports: PortsFound, p: Puzzle, t: PuzzleTest, cycles: number): TestRun {
  const sim = es.sim!;
  const ist = sim.leafState(ports.inLi) as PuzzleInState;
  const ost = sim.leafState(ports.outLi) as PuzzleOutState;
  const got = outputFrom(p, ost.out, ports.outW);
  const base = { name: t.name, cycles, input: t.input, expect: t.expect, got };
  const k = Math.max(1, Math.ceil(p.bits / ports.outW));
  const atWord = (i: number) => ost.at[Math.min(ost.at.length - 1, i * k + k - 1)];
  const bad = got.findIndex((v, i) => v !== t.expect[i]);
  if (bad >= 0) {
    const why = bad >= t.expect.length ? `wrote ${got.length} words, expected ${t.expect.length} (extra: ${fmt(got.slice(t.expect.length))})`
      : got[bad] < 0 ? `word ${bad + 1} has unknown (X) bits`
      : `word ${bad + 1} is ${got[bad]}, expected ${t.expect[bad]}`;
    return { ...base, ok: false, why, badAt: atWord(bad) };
  }
  if (ist.over) return { ...base, ok: false, why: `read past the end of the input (${ist.over} time${ist.over === 1 ? '' : 's'})`, badAt: cycles };
  if (!es.halted) return { ...base, ok: false, why: `still running after ${p.maxCycles} cycles (does the halt part ever read 1?)`, badAt: cycles };
  if (got.length < t.expect.length) return { ...base, ok: false, why: `halted after ${got.length} of ${t.expect.length} words`, badAt: cycles };
  return { ...base, ok: true };
}

/**
 * Run every test of puzzle `p` on a compiled chip (`pins`: its pin documents, for the clock and any other
 * input). A fresh simulation of its own: the editor's is never touched.
 */
export function runPuzzle(p: Puzzle, compiled: Compiled, pins: PinDoc[]): PuzzleRun {
  const es = new EditorSim({ debounceMs: 0 });
  try {
    es.setMode('cycle');
    es.update({ ...compiled, def: compiled.def }, pins);
    const ports = findPorts(es);
    if (Array.isArray(ports)) return { ok: false, problems: ports, results: [], cycles: 0, width: 0 };
    const results = p.tests().map((t) => {
      loadTest(es, ports, p, t);
      const n = es.runCycles(p.maxCycles);
      return judge(es, ports, p, t, n);
    });
    const cycles = Math.round((10 * results.reduce((s, r) => s + r.cycles, 0)) / Math.max(1, results.length)) / 10;
    return { ok: results.every((r) => r.ok), problems: [], results, cycles, width: ports.inW };
  } finally {
    es.destroy();
  }
}

// ---- cost -------------------------------------------------------------------------------------

const nandCache = new WeakMap<ComponentDef, number>();

/** A program ROM of the sandbox (the program is scored by its size, not as hardware). */
const isProgramRom = (d: ComponentDef) => /^sb_rom/.test(d.id);

/** NANDs of the hardware: every NAND under `def` except those of program ROMs. */
export function hardwareNands(def: ComponentDef): number {
  const hit = nandCache.get(def);
  if (hit !== undefined) return hit;
  let n = 0;
  if (def.prim === 'nand') n = 1;
  else if (!def.prim && !isProgramRom(def)) for (const inst of netlistOf(def)?.instances ?? []) n += hardwareNands(inst.def);
  nandCache.set(def, n);
  return n;
}

type RomPart = PartDoc & { ref: { rom: unknown } };

/** The program ROMs of a chip and the user chips it places (paths), at most `depth` levels down. */
export function programRoms(doc: ChipDoc, chips: Readonly<Record<string, ChipDoc>>, depth = 3, path = ''): { path: string; part: RomPart }[] {
  const out: { path: string; part: RomPart }[] = [];
  for (const p of doc.parts) {
    if ('rom' in p.ref) out.push({ path: path + p.id, part: p as RomPart });
    else if ('chip' in p.ref && depth > 0 && chips[p.ref.chip]) out.push(...programRoms(chips[p.ref.chip], chips, depth - 1, `${path}${p.id}.`));
  }
  return out;
}

/** Words of the programs in the chip's ROMs (what assembling them gives), or null when none assembles. */
export function programWords(doc: ChipDoc, chips: Readonly<Record<string, ChipDoc>>): number | null {
  const roms = programRoms(doc, chips);
  if (!roms.length) return null;
  let n = 0;
  for (const r of roms) {
    const img = romImage((r.part.ref as { rom: Parameters<typeof romImage>[0] }).rom);
    if (img.error) return null;
    n += img.words.length;
  }
  return n;
}
