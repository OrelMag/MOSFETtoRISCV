// Reading the coherent dual-core's state out of a simulation, and running it in lock step with riscv/cohmodel.ts.
import { coherentDualCore } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { CohModel, SETS } from '../src/riscv/cohmodel';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { HierNode } from '../src/sim/flatten';
import { readArray, readCache, readMem, type HwCache } from '../src/lib/cohread';

export { type HwCache, readArray, readCache, readMem };

export interface Run { sim: GateSim; root: HierNode; model: CohModel; K: number; cycle: number; leaves: number }

export function open(source: string, opts: { coherent?: boolean; K?: number } = {}): Run {
  const K = opts.K ?? 5, asm = assemble(source);
  if (asm.errors.length) throw new Error(asm.errors.map((e) => e.message).join('; '));
  const design = flatten(coherentDualCore(asm.words, { dmemK: K, coherent: opts.coherent }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  return { sim, root: design.root, model: new CohModel(asm.words, { coherent: opts.coherent, dmemWords: 2 ** K }), K, cycle: 0, leaves: design.leaves.length };
}

export function hwRetire(r: Run): boolean[] { return [0, 1].map((i) => r.sim.getBits(r.root.ports[`retire${i}`])[0] === 1); }

/** One lock-step cycle: the model steps, the hardware clocks; returns a description of the first difference. */
export function lockStep(r: Run): string | null {
  const want = hwRetire(r), got = r.model.step();
  if (want[0] !== got[0] || want[1] !== got[1]) return `cycle ${r.cycle}: retire ${want} but the model says ${got}`;
  clockCycle(r.sim);
  r.cycle++;
  const s = r.model.s;
  for (let i = 0; i < 2; i++) {
    const st = cpuState(r.sim, r.root.children!.get(`core${i}`)!), h = r.model.m.harts[i];
    if (st.pc !== h.pc) return `cycle ${r.cycle}: core ${i} pc ${st.pc} vs ${h.pc}`;
    const d = st.x.findIndex((v, k) => v !== h.x[k]);
    if (d >= 0) return `cycle ${r.cycle}: core ${i} x${d} ${st.x[d]} vs ${h.x[d]}`;
    const hw = readCache(r.sim, r.root, i, r.K), m = s.caches[i];
    if (hw.st.join() !== m.st.join()) return `cycle ${r.cycle}: cache ${i} states ${hw.st} vs ${m.st}`;
    if (hw.snoopSt.join() !== hw.st.join() || hw.snoopTag.join() !== hw.tag.join()) return `cycle ${r.cycle}: cache ${i} snoop tags differ from the core's`;
    for (let k = 0; k < SETS; k++) if (m.st[k] && hw.tag[k] !== m.tag[k]) return `cycle ${r.cycle}: cache ${i} tag of set ${k}`;
    if (hw.data.join() !== m.data.join()) return `cycle ${r.cycle}: cache ${i} data ${hw.data} vs ${m.data}`;
    if (hw.resV !== (h.resValid ? 1 : 0)) return `cycle ${r.cycle}: cache ${i} reservation ${hw.resV} vs ${h.resValid}`;
  }
  if (r.sim.getBits(r.root.ports.busy)[0] !== (s.busy ? 1 : 0)) return `cycle ${r.cycle}: busy`;
  if (readMem(r.sim, r.root, r.K).join() !== s.mem.join()) return `cycle ${r.cycle}: memory ${readMem(r.sim, r.root, r.K)} vs ${s.mem}`;
  const inv = r.model.invariants();
  return inv ? `cycle ${r.cycle}: ${inv}` : null;
}

/** A plain shared-memory replay of a retirement order: the sequentially consistent reference. */
export function replayCheck(model: CohModel, ref: import('../src/riscv/multi').MultiISS, retired: boolean[], pre: [boolean, number][]): string | null {
  // the reservations are the caches' business (snooped invalidations, evictions): take them from the model
  retired.forEach((r, i) => { if (r) { ref.harts[i].resValid = pre[i][0]; ref.harts[i].resLine = pre[i][1]; ref.harts[i].step(); } });
  for (let i = 0; i < 2; i++) {
    const a = ref.harts[i], b = model.m.harts[i];
    if (a.pc !== b.pc) return `SC replay: core ${i} pc ${a.pc} vs ${b.pc}`;
    const d = a.x.findIndex((v, k) => v !== b.x[k]);
    if (d >= 0) return `SC replay: core ${i} x${d} ${a.x[d]} vs ${b.x[d]}`;
  }
  return null;
}
