// The Vectors chapter's numbers, computed (DOM-free): the lanes chapter's kernel y = 3·x + y on 16 elements on four
// machines, each built in gates and timed by its golden model, which the gates match cycle for cycle: the single-cycle
// CPU (a scalar loop), four of its cores (multiCore, each taking every fourth element), the CPU with the vector unit
// (the strip-mined loop, riscv/vecmodel.ts vecRun) and the four-lane core (laneCore). NANDs leave the program ROMs out
// (as the benchmarks do); period is static timing in NAND delays. Also the vector unit's blocks and the strip-mined
// loop at each LMUL. scripts/vector-costs.ts --write saves them to vectorcosts.json; tests/vectors-chapter.test.ts
// recomputes and compares, so the prose cannot drift from the circuits.

import { singleCycleCpu } from '../lib/cpu';
import { laneCore } from '../lib/lanes';
import { multiCore } from '../lib/multicore';
import { V0_SHADOW, VEC_ACC, VEC_CFG, VEC_DECODE, VEC_LANE, VEC_SEQ, VECTOR_UNIT, vecMemory } from '../lib/vector';
import { dataMemory } from '../lib/cpu';
import { regfile } from '../lib/regfile';
import { alu } from '../lib/alu';
import { assemble } from '../riscv/asm';
import { MultiISS } from '../riscv/multi';
import { SimtISS } from '../riscv/simt';
import { SAXPY_CORES, SIMT_PROGRAMS } from '../riscv/simtprograms';
import { ISS } from '../riscv/iss';
import { vecRun } from '../riscv/vecmodel';
import { SCALAR_SAXPY, vectorSaxpy } from '../riscv/vecprograms';
import { flatten } from '../sim/flatten';
import { stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';

export interface Machine { id: 'scalar' | 'cores' | 'vector' | 'lanes'; name: string; nands: number; period: number; cycles: number; instrs: number }

export interface VectorCosts {
  machines: Machine[];
  /** The strip-mined kernel at each LMUL on the vector CPU: instructions retired and cycles. */
  byLmul: { lmul: number; instrs: number; cycles: number }[];
  /** The vector unit's blocks (NANDs). */
  unit: { total: number; lane: number; slice: number; alu: number; decode: number; cfg: number; seq: number; acc: number; v0: number; banks: number; memory: number };
}

/** NANDs without the program ROM(s): `imem` at the top or in each core `core<i>`. */
export function nandsWithoutRom(def: ComponentDef): number {
  const rom = (d: ComponentDef): number => (d.netlist?.().instances ?? []).reduce((s, i) =>
    s + (i.name === 'imem' && i.def.id.startsWith('rom_') ? stats(i.def).nands : /^core\d$/.test(i.name) ? rom(i.def) : 0), 0);
  return stats(def).nands - rom(def);
}

const periodOf = (def: ComponentDef) => analyzeTiming(flatten(def, { mode: 'gate' }))!.period;

export function vectorCosts(): VectorCosts {
  const words = (src: string) => assemble(src).words;
  const ws = words(SCALAR_SAXPY), wv = words(vectorSaxpy(4)), wc = words(SAXPY_CORES), wl = words(SIMT_PROGRAMS.find((p) => p.id === 'saxpy')!.source);
  const sIss = new ISS(ws, { dmemWords: 32, imemWords: 64 });
  sIss.run(20_000);
  const mm = new MultiISS(wc, 4);
  for (let c = 0; c < 20_000 && !mm.halted; c++) mm.step();
  const sm = new SimtISS(wl, { lanes: 4 });
  sm.run(20_000);
  const vr = vecRun(wv, { dmemWords: 32, imemWords: 64 });
  const m = (id: Machine['id'], name: string, def: ComponentDef, cycles: number, instrs: number): Machine => ({ id, name, nands: nandsWithoutRom(def), period: periodOf(def), cycles, instrs });
  const machines = [
    m('scalar', 'One core', singleCycleCpu(ws), sIss.steps, sIss.steps),
    m('cores', 'Four cores', multiCore(wc, 4), mm.cycles, mm.harts.reduce((a, h) => a + h.steps, 0)),
    m('vector', 'One core + vector unit', singleCycleCpu(wv, { vector: { lanes: 4, vlen: 128 } }), vr.cycles, vr.instrs),
    m('lanes', 'One core, four lanes', laneCore(wl, 4), sm.cycles, sm.retired),
  ];
  const byLmul = ([1, 2, 4, 8] as const).map((lmul) => { const r = vecRun(words(vectorSaxpy(lmul)), { dmemWords: 32, imemWords: 64 }); return { lmul, instrs: r.instrs, cycles: r.cycles }; });
  const n = (d: ComponentDef) => stats(d).nands;
  return {
    machines, byLmul,
    unit: { total: n(VECTOR_UNIT), lane: n(VEC_LANE), slice: n(regfile(5, 32, false)), alu: n(alu(32)), decode: n(VEC_DECODE), cfg: n(VEC_CFG), seq: n(VEC_SEQ), acc: n(VEC_ACC), v0: n(V0_SHADOW), banks: n(vecMemory(5)) - n(dataMemory(5)), memory: n(vecMemory(5)) },
  };
}
