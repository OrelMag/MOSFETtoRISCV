// Reading the coherent dual-core's state out of a simulation, and running it in lock step with riscv/cohmodel.ts.
import { coherentDualCore } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { CohModel, SETS } from '../src/riscv/cohmodel';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { HierNode } from '../src/sim/flatten';
import { pack } from '../src/sim/values';

export interface HwCache { st: number[]; tag: number[]; data: number[]; resV: number; resLine: number; snoopSt: number[]; snoopTag: number[] }
type S = Pick<GateSim, 'getBits'>;

const word = (sim: S, n: HierNode | undefined, port = 'q') => (n ? pack(sim.getBits(n.ports[port])) >>> 0 : 0);

/** regfileMP's registers are u1 … uN (u0 is the write decoder). */
export function readArray(sim: S, arr: HierNode, n: number): number[] {
  return Array.from({ length: n }, (_, i) => word(sim, arr.children!.get(`u${1 + i}`)));
}

export function readCache(sim: S, root: HierNode, i: number, K: number): HwCache {
  const c = root.children!.get(`cache${i}`)!, t = K - 4;
  const dec = (a: number[]) => ({ st: a.map((x) => (((x >>> (t + 1)) & 1) ? 2 : ((x >>> t) & 1) ? 1 : 0)), tag: a.map((x) => x & (2 ** t - 1)) });
  const ct = dec(readArray(sim, c.children!.get('ctags')!, SETS)), stg = dec(readArray(sim, c.children!.get('stags')!, SETS));
  const res = c.children!.get('res')!;
  return { st: ct.st, tag: ct.tag, data: readArray(sim, c.children!.get('data')!, 16), resV: word(sim, res.children!.get('rv')), resLine: word(sim, res.children!.get('rl')), snoopSt: stg.st, snoopTag: stg.tag };
}

export function readMem(sim: S, root: HierNode, K: number): number[] {
  const ram = root.children!.get('dm')!.children!.get('ram')!;
  return Array.from({ length: 2 ** K }, (_, i) => word(sim, ram.children!.get(`w${i}`)));
}

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
