// The MAC core on GateSim against the golden model, instruction by instruction: pc before, registers and accumulator after, memory at the end.
// The first difference is returned as text (null: none). tests/dsp-mac-cpu.test.ts expects null, tests/dsp-mac-mutants.test.ts expects text.
import { singleCycleCpu } from '../../src/lib';
import '../../src/lib/macunit';
import { clockCycle, cpuState } from '../../src/riscv/cosim';
import { ISS, type IssOptions } from '../../src/riscv/iss';
import { flatten } from '../../src/sim/flatten';
import { GateSim } from '../../src/sim/gatesim';
import { pause } from './run';

export interface Mismatch { step: number; what: string; text: string }

export async function firstMismatch(words: number[], iss: IssOptions = {}, o: { imemK?: number; dmemK?: number; limit?: number; until?: number } = {}): Promise<{ mismatch: Mismatch | null; steps: number; iss: ISS }> {
  const imemK = o.imemK ?? 6, dmemK = o.dmemK ?? 5, limit = o.limit ?? 3000;
  const sim = new GateSim(flatten(singleCycleCpu(words, { mac: true, imemK, dmemK })));
  sim.setInput('clk', 0);
  sim.settle();
  const m = new ISS(words, { mac: true, imemWords: 2 ** imemK, dmemWords: 2 ** dmemK, ...iss });
  let n = 0, text = 'reset';
  const bad = (what: string, got: unknown, want: unknown): Mismatch => ({ step: n, what, text: `${what} differs after "${text}": gates ${String(got)}, model ${String(want)}` });
  while (!m.halted && n < limit && (o.until === undefined || m.pc !== o.until)) {
    if ((n & 127) === 127) await pause();
    const pc = cpuState(sim).pc;
    if (pc !== m.pc) return { mismatch: bad('pc', pc, m.pc), steps: n, iss: m };
    text = m.step().text;
    clockCycle(sim);
    n++;
    const st = cpuState(sim);
    const i = st.x.findIndex((v, k) => v !== m.x[k] >>> 0);
    if (i >= 0) return { mismatch: bad(`x${i}`, st.x[i], m.x[i] >>> 0), steps: n, iss: m };
    if (st.acc !== m.acc) return { mismatch: bad('acc', st.acc, m.acc), steps: n, iss: m };
  }
  const st = cpuState(sim);
  const j = st.dmem.findIndex((v, k) => v !== m.dmem[k]);
  if (j >= 0) return { mismatch: bad(`mem[${j}]`, st.dmem[j], m.dmem[j]), steps: n, iss: m };
  return { mismatch: null, steps: n, iss: m };
}
