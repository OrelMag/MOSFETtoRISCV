// A program level run on the learner's own core (the level screen's "Run on" switch). DOM-free.
//
// The program is graded on the golden model, as always; then, when it passes there, every test runs on the chip the
// learner built for a core level (u_ch_cp_<core>), through that level's own bench (corecheck / lanecheck / warpcheck)
// with the test's data in memory, IN and SWITCHES served from the test, and no cycle budget: a slow core is not a
// wrong one. The core agrees when it makes the model's register writes and stores, in order; its cycles are a readout
// (the best per core is kept, campaign/progress.ts `cores`), never a grade. Where they part, the disagreement names the
// instruction, what the model did and what the core did, and the registers both had just before it.

import type { Workspace } from '../editor/model';
import { UserLibrary } from '../editor/library';
import { assemble16 } from '../riscv/rv16/asm16';
import { Iss16 } from '../riscv/rv16/iss16';
import { disasm16 } from '../riscv/rv16/isa16';
import type { ComponentDef } from '../sim/types';
import { addBench, type Bench } from './bench';
import { type CoreDisagree, corePeriod, type CoreTest, drained, runCoreSteps, type RunOptions } from './corecheck';
import { modelOnly, specOf, unfit } from './owncorefit';
import { stats } from '../sim/stats';
import { lanePeriod, runLanesSteps } from './lanecheck';
import { levelChipId } from './levels';
import { nodeById } from './nodes';
import { type ProgramPuzzle, puzzleMachine, runPuzzle } from './puzzles';
import { runWarpsSteps, warpPeriod } from './warpcheck';

export { coreOptions, type CoreOption, modelOnly } from './owncorefit';


/** One test on the core. */
export interface OwnTest {
  name: string;
  ok: boolean;
  /** The core's cycles, and the model's count (instructions; warp instructions or cycles on lanes and warps). */
  cycles: number;
  steps: number;
  why?: CoreDisagree;
  /** A lane or warp core's failure, in words. */
  text?: string;
  /** The register writes the core made that agreed (Step to it). */
  writes: { rd: number; value: number }[];
}

export type OwnRun =
  | { kind: 'error'; error: string }
  /** The program fails on the golden model: fix it there first. */
  | { kind: 'model' }
  | { kind: 'done'; ok: boolean; cycles: number; steps: number; tests: OwnTest[] };

/** Cycles a core may take before it is called stuck: generous (a multicycle core with stalls), so only a hang hits it. */
export const OWN_CAP = (steps: number): number => 20 * steps + 500;

/** The program's tests as a core bench's (its data and the test's memory, IN and switches). */
export function ownTests(p: ProgramPuzzle, src: string): CoreTest[] | { error: string } {
  const a = assemble16(src);
  if (a.errors.length) return { error: `line ${a.errors[0].line}: ${a.errors[0].message}` };
  return p.tests().map((t) => {
    const data = new Map(a.data);
    for (const [k, v] of Object.entries(t.mem ?? {})) data.set(Number(k), v & 0xffff);
    return { name: t.name, words: a.words, data, ...(t.input?.length ? { input: [...t.input] } : {}), ...(t.switches !== undefined ? { switches: t.switches } : {}) };
  });
}

/** The learner's chip for a core level, compiled from the workspace. */
// One library for every call: a workspace snapshot recompiles only the chips that changed, so a core's def stays the same
// object between calls (coreFacts' cache) and a project with every level chip is not compiled again per lookup.
const lib = new UserLibrary();
let libWs: Workspace | null = null;

export function coreDef(ws: Workspace, core: string): ComponentDef | { error: string } {
  const n = nodeById(core);
  if (!n) return { error: `no core level ${core}` };
  if (ws !== libWs) {
    lib.update(ws);
    libWs = ws;
  }
  const c = lib.compiled(levelChipId(n));
  if (!c) return { error: `${n.title} has no chip in this project` };
  const err = c.diags.find((d) => d.level === 'error');
  if (err) return { error: `${n.title}'s chip does not compile` };
  if (c.mode !== 'gate') return { error: `${n.title}'s chip simulates at switch level` };
  return c.def;
}

/** Run a program level's tests on a core level's chip. Never throws. */
export function runOnCore(p: ProgramPuzzle, src: string, core: string, ws: Workspace): OwnRun {
  return drained(runOnCoreSteps(p, src, core, ws));
}

/** runOnCore, yielding every 64 cycles of the core and between tests: the level card drives it a frame at a time. */
export function* runOnCoreSteps(p: ProgramPuzzle, src: string, core: string, ws: Workspace): Generator<void, OwnRun> {
  try {
    const s = specOf(core);
    if (!s) return { kind: 'error', error: `${core} is not a core level` };
    const why = modelOnly(p) ?? unfit(p, s);
    if (why) return { kind: 'error', error: why };
    const model = runPuzzle(p, src);
    if (!model.ok) return { kind: 'model' };
    yield;
    const tests = ownTests(p, src);
    if ('error' in tests) return { kind: 'error', error: tests.error };
    const def = coreDef(ws, core);
    if ('error' in def) return { kind: 'error', error: def.error };
    yield;
    const opts: RunOptions = { own: { maxCycles: OWN_CAP } };
    const out: OwnTest[] = [];
    if (!s.lanes) {
      const r = yield* runCoreSteps(def, 'gate', { ...s, tests: () => tests }, 'auto', opts);
      if (!r.perTest) return { kind: 'error', error: r.failures[0] ?? 'the core did not run' };
      // to the last write or store, then the model's few instructions after it at one cycle each (a single-cycle core: its exact count)
      out.push(...r.perTest.map((t) => ({ name: t.name, ok: t.ok, cycles: t.ok ? t.cycles + t.tail : t.cycles, steps: t.steps, writes: t.writes, ...(t.why ? { why: t.why } : {}) })));
    } else {
      // lanes and warps: one test a run, for each one's cycles; the model's count from runPuzzle
      const run = s.warps ? runWarpsSteps : runLanesSteps;
      for (const [i, t] of tests.entries()) {
        const r = yield* run(def, 'gate', { ...s, tests: () => [t] }, 'auto', opts);
        const steps = model.results[i]?.steps ?? 0;
        if (!r.tested) out.push({ name: t.name, ok: false, cycles: 0, steps, text: r.failures[0], writes: [] });
        else out.push({ name: t.name, ok: !r.failures.length, cycles: r.cycles ?? 0, steps, writes: [], ...(r.failures.length ? { text: r.failures[0].replace(`${t.name}: `, '') } : {}) });
        yield;
      }
    }
    const ok = out.every((t) => t.ok);
    const mean = (f: (t: OwnTest) => number) => Math.ceil(out.reduce((a, t) => a + f(t), 0) / Math.max(1, out.length));
    return { kind: 'done', ok, cycles: mean((t) => t.cycles), steps: mean((t) => t.steps), tests: out };
  } catch (e) {
    return { kind: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}
/**
 * Step to it: both register files at the disagreement, the model's (run to that instruction) and the core's (its agreed writes):
 * just after the instruction when the core wrote a wrong register (so that register differs), else just before it.
 */
export function registersAt(p: ProgramPuzzle, src: string, testIndex: number, t: OwnTest): { model: number[]; core: number[]; pc: number; text: string; after: boolean } | null {
  if (t.why?.step === undefined || p.lanes) return null;
  const a = assemble16(src);
  const pt = p.tests()[testIndex];
  if (a.errors.length || !pt) return null;
  const mc = puzzleMachine(p, a.words, a.data, pt);
  if (!(mc instanceof Iss16)) return null;
  while (mc.steps < t.why.step && !mc.halted) mc.step();
  const pc = mc.pc, text = disasm16(mc.imem[pc] ?? 0, pc);
  const core = new Array(8).fill(0);
  for (const w of t.writes) if (w.rd) core[w.rd] = w.value & 0xffff;
  const wrote = t.why.wrote;
  if (!wrote) return { model: [...mc.x], core, pc, text, after: false };
  mc.step();
  if (wrote.rd) core[wrote.rd] = wrote.value & 0xffff;
  return { model: [...mc.x], core, pc, text, after: true };
}

/** A test's program on the core's debug bench, in the sandbox (scalar tests that read no IN, with data in the bench's 64 words). */
/** Why a test cannot go on the core's debug bench (no IN device, 64 words of RAM), or null. */
export function benchRefusal(t: CoreTest): string | null {
  if (t.input?.length) return 'this test reads IN, which the bench has no device for';
  if ([...(t.data?.keys() ?? [])].some((k) => k >= 64)) return 'this test’s data lies beyond the bench’s 64 words of RAM';
  return null;
}

export function ownBench(ws: Workspace, core: string, t: CoreTest): Bench | { error: string } {
  const no = benchRefusal(t);
  if (no) return { error: no };
  const def = coreDef(ws, core);
  if ('error' in def) return def;
  const n = nodeById(core)!;
  return addBench(ws, def, levelChipId(n), t);
}

const facts = new WeakMap<ComponentDef, { nands: number; period: number | null }>();

/** A core's NANDs and clock period (in NAND delays, with its bench's memories), for the readout; `cached`: only if known already. */
export function coreFacts(ws: Workspace, core: string, cached = false): { nands: number; period: number | null } | null {
  const def = coreDef(ws, core), s = specOf(core);
  if ('error' in def || !s) return null;
  let f = facts.get(def);
  if (!f && cached) return null;
  if (!f) {
    const period = s.warps ? warpPeriod(def, s.lanes) : s.lanes ? lanePeriod(def, s.lanes) : corePeriod(def);
    facts.set(def, (f = { nands: stats(def).nands, period }));
  }
  return f;
}
