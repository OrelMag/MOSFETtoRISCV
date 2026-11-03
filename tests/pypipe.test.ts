// Chapter 15 on the pipeline: the Python panel's per-line cycles come from the gate-level pipelined CPU's own signals
// (stage valid bits, the hazard unit, the divider), and must add up to the clock and agree with the golden model.
import { describe, expect, it } from 'vitest';
import { compilePy } from '../src/lang/compile';
import { lineTotal, PipeProfile } from '../src/lang/pipeprof';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { pipelinedCpu } from '../src/lib';
import { clockCycle, cpuState, retireCount } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { PY_DMEM_K, PY_IMEM_K } from '../src/widgets/python';
import { tick } from './yieldtick';

const src = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!.source;

async function run(id: string, m: boolean, lockStep: boolean) {
  const c = compilePy(src(id), { dmemWords: 2 ** PY_DMEM_K, m });
  expect(c.error).toBeNull();
  const def = pipelinedCpu(c.words, { imemK: PY_IMEM_K, dmemK: PY_DMEM_K, m });
  const sim = new GateSim(flatten(def));
  sim.setInput('clk', 0);
  sim.settle();
  const haltPc = c.assembled!.labels.get('halt') ?? c.assembled!.labels.get('program.halt') ?? 0;
  const prof = new PipeProfile(c, haltPc);
  const iss = new ISS(c.words, { dmemWords: 2 ** PY_DMEM_K, imemWords: 2 ** PY_IMEM_K });
  let n = 0;
  while (!prof.finished && n < 30_000) {
    const willRetire = retireCount(sim);
    prof.sample(sim);
    clockCycle(sim);
    n++;
    for (let k = 0; k < willRetire && !iss.halted; k++) iss.step();
    if (lockStep && willRetire) expect(cpuState(sim).x, `cycle ${n}`).toEqual([...iss.x]);
    if (n % 400 === 0) await tick();
  }
  return { c, prof, cycles: n, steps: iss.steps };
}

describe('Python on the pipeline: per-line cycles from the gates', () => {
  for (const [id, m] of [['sum', false], ['fibloop', false], ['gcd', false], ['gcd', true], ['digits', true]] as const) {
    it(`${id} ${m ? 'RV32IM' : 'RV32I'}: lines add up to the clock, instructions to the golden model`, async () => {
      const { c, prof, cycles, steps } = await run(id, m, true);
      expect(prof.finished).toBe(true);
      expect(prof.cycles).toBe(cycles);
      let all = prof.fill, instr = 0, stall = 0, flush = 0, divide = 0;
      for (const [line, v] of prof.lines) { all += lineTotal(v); instr += v.instr; stall += v.stall; flush += v.flush; divide += v.divide; if (line > 0) expect(c.pcsOfPy(line).length).toBeGreaterThan(0); }
      expect(all).toBe(cycles);
      expect(instr).toBe(steps);
      expect(divide > 0).toBe(m && /\/\/|%/.test(src(id)) && id !== 'sum');
      console.log(`${id} ${m ? 'RV32IM' : 'RV32I '}: ${cycles} cycles, ${steps} instr, CPI ${(cycles / steps).toFixed(2)}, stall ${stall}, flush ${flush}, divide ${divide}, fill ${prof.fill}`);
    }, 120000);
  }
});
