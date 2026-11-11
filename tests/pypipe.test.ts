// Chapter 15 on the pipeline: the Python panel's per-line cycles come from the gate-level pipelined CPU's own signals
// (stage valid bits, the hazard unit, the divider), and must add up to the clock and agree with the golden model.
import { describe, expect, it } from 'vitest';
import { chMulDiv } from '../src/chapters/ch-muldiv';
import { chPipeline } from '../src/chapters/ch-pipe';
import { compilePy } from '../src/lang/compile';
import { lineTotal, PipeProfile } from '../src/lang/pipeprof';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { pipelinedCpu, singleCycleCpu } from '../src/lib';
import { stats } from '../src/sim/stats';
import { clockCycle, cpuState, retireCount } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { mUnitCost, PY_DMEM_K, PY_IMEM_K, pyCompile } from '../src/widgets/python';
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
      expect(divide > 0).toBe(m && /\/\/|%/.test(src(id)));
      console.log(`${id} ${m ? 'RV32IM' : 'RV32I '}: ${cycles} cycles, ${steps} instr, CPI ${(cycles / steps).toFixed(2)}, stall ${stall}, flush ${flush}, divide ${divide}, fill ${prof.fill}`);
    }, 120000);
  }
});

// ---- the numbers the chapter's pipeline steps quote ----
const strip = (t: string) => t.replace(/[\s    ]+/g, '');
const prose = strip([chPipeline, chMulDiv].map((c) => c.steps.map((st) => st.body + Object.values(st.more ?? {}).join('') + (st.challenge?.kind === 'quiz' ? st.challenge.question : '')).join(' ') + c.recap!.keep.join(' ')).join(' '));
const quoted = (t: string) => expect(prose).toContain(strip(t));

const totals = (prof: PipeProfile) => {
  const t = { cycles: prof.cycles, instr: 0, stall: 0, flush: 0, divide: 0, fill: prof.fill };
  for (const v of prof.lines.values()) { t.instr += v.instr; t.stall += v.stall; t.flush += v.flush; t.divide += v.divide; }
  return t;
};

describe('chapter 15 on the pipeline: the numbers in the text', () => {
  it('prefix: 219 cycles = 166 instructions + 15 stalls + 36 flushes + 2 fill', async () => {
    const t = totals((await run('prefix', false, false)).prof);
    expect(t).toMatchObject({ cycles: 219, instr: 166, stall: 15, flush: 36, fill: 2 });
    expect(t.cycles).toBe(t.instr + t.stall + t.flush + t.fill);
    quoted('219 cycles for 166 instructions');
  }, 60000);

  it('gcd: 2409 cycles with the routines, 225 with RV32IM; six rem, 19 Execute cycles each', async () => {
    const a = totals((await run('gcd', false, false)).prof), b = await run('gcd', true, false);
    expect(a).toMatchObject({ cycles: 2409, instr: 1545, flush: 860 });
    expect(totals(b.prof)).toMatchObject({ cycles: 225, instr: 77, divide: 108 });
    // six rem instructions run: 108 / 6 = 18 extra cycles each, 19 in Execute
    const iss = new ISS(b.c.words, { dmemWords: 2 ** PY_DMEM_K, imemWords: 2 ** PY_IMEM_K });
    let rems = 0;
    while (!iss.halted) { const w = b.c.words[iss.pc >>> 2]; if ((w & 0x7f) === 0x33 && (w >>> 25) === 1 && ((w >>> 12) & 7) === 6) rems++; iss.step(); }
    expect(rems).toBe(6);
    quoted('2409 cycles with the routines, 225 with RV32IM');
  }, 120000);

  it('speed-ups of RV32IM on the pipeline: gcd, digits, isprime, matmul', async () => {
    const want: Record<string, [number, number]> = { gcd: [2409, 225], digits: [3922, 422], isprime: [12359, 1106], matmul: [1682, 890] };
    for (const [id, [i, m]] of Object.entries(want)) {
      expect((await run(id, false, false)).cycles, id).toBe(i);
      expect((await run(id, true, false)).cycles, id).toBe(m);
      quoted(`${id} ${(i / m).toFixed(1)}×`);
    }
  }, 240000);

  it('gates: 100 979 single-cycle, 113 438 pipelined, +32 038 for the M unit', () => {
    const c = pyCompile(src('sum'));
    expect(stats(singleCycleCpu(c.words, { imemK: PY_IMEM_K, dmemK: PY_DMEM_K })).nands).toBe(100979);
    expect(mUnitCost(c.words)).toEqual({ base: 113438, withM: 145476 });
    quoted('113438 → 145476, +28.2 %');
    quoted('+12.3 %');
    // The memories both totals include, and the processors alone (ch 15 and 17 quote them).
    const parts = (d: ReturnType<typeof singleCycleCpu>) => Object.fromEntries(d.netlist!().instances.filter((i) => i.name === 'imem' || i.name === 'dm').map((i) => [i.name, stats(i.def).nands]));
    expect(parts(singleCycleCpu(c.words, { imemK: PY_IMEM_K, dmemK: PY_DMEM_K }))).toEqual({ imem: 32640, dm: 39558 });
    expect(parts(pipelinedCpu(c.words, { imemK: PY_IMEM_K, dmemK: PY_DMEM_K }))).toEqual({ imem: 32640, dm: 39558 });
    quoted('+43.3 %');
  });

  it('a floor division compiles to nine instructions, a modulo to nine', () => {
    for (const op of ['//', '%']) {
      const c = compilePy(`a = 7\nb = -2\nprint(a ${op} b)\n`, { m: true });
      const ops = c.lines.map((l) => l.text.trim()).filter((t) => t && !t.startsWith('#') && !t.endsWith(':'));
      const first = ops.findIndex((t) => t.startsWith('rem'));
      const end = ops.findIndex((t, i) => i > first && (op === '//' ? t.startsWith('div') && ops[i - 1].startsWith('j') : t.startsWith('mv')));
      expect(end - first + 1, op).toBe(9);
    }
  });
});
