import { describe, expect, it } from 'vitest';
import { pipelinedFpCpu, singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { FDIV_CYCLES, FSQRT_CYCLES, ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { analyzeTiming } from '../src/sim/timing';
import { breathe } from './fptest';

/** Co-simulate the pipelined RV32IF CPU: the golden model steps whenever a valid instruction leaves W. */
export async function cosimPipe(source: string, maxCycles = 4000, engine: 'bit' | 'gate' = 'bit') {
  const asm = assemble(source);
  expect(asm.errors).toEqual([]);
  const design = flatten(pipelinedFpCpu(asm.words));
  const sim = engine === 'gate' ? new GateSim(design) : new BitSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words);
  let cycles = 0;
  while (!iss.halted && cycles < maxCycles) {
    if (cycles % 50 === 49) await breathe();
    const ret = retiring(sim);
    clockCycle(sim);
    cycles++;
    if (!ret) continue;
    const info = iss.step();
    const st = cpuState(sim);
    const at = `cycle ${cycles}, after ${info.text}`;
    expect(st.x, `x ${at}`).toEqual([...iss.x]);
    expect(st.f, `f ${at}`).toEqual([...iss.f]);
    expect(st.fcsr, `fcsr ${at}`).toBe((iss.frm << 5) | iss.fflags);
  }
  expect(iss.halted, 'halted').toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles, retired: iss.steps, leaves: design.leaves.length };
}

const measured = new Map<string, { cycles: number; retired: number }>();
describe('pipelined RV32IF CPU vs golden model', () => {
  for (const p of F_PROGRAMS) {
    it(p.id, async () => {
      const r = await cosimPipe(p.source);
      measured.set(p.id, r);
      console.log(`${p.id}: ${r.retired} instructions in ${r.cycles} cycles (CPI ${(r.cycles / r.retired).toFixed(2)})`);
    }, 120000);
  }
});

const STRESS = `# every kind of FP hazard, back to back
        li   t0, 3
        fcvt.s.w ft0, t0        # x → f (x forwarded into E)
        fadd.s ft1, ft0, ft0    # waits for ft0
        fmul.s ft2, ft1, ft1    # chain
        fmadd.s ft3, ft2, ft1, ft0   # rs3 too
        fsw  ft3, 0(zero)       # store data from the FP pipe
        flw  ft4, 0(zero)
        fadd.s ft5, ft4, ft4    # FP load-use
        feq.s t1, ft5, ft5      # f → x
        beqz t1, bad            # a branch on it
        fcvt.w.s t2, ft5
        addi t3, t2, 1          # integer use of an FP result
        fmv.w.x ft6, t3         # and back
        fdiv.s ft7, ft6, ft0    # forwarded operand into the iterative unit
        fadd.s ft8, ft7, ft7    # waits for the division
        csrrwi t4, frm, 1       # waits for every FP instruction; RTZ from now on
        fadd.s ft9, ft8, ft1    # waits for the CSR write (rm = dyn)
        frflags t5
        fsqrt.s ft10, ft9
        fsw  ft10, 4(zero)
        lw   t6, 4(zero)
        fmv.x.w a0, ft10
        sub  a1, a0, t6         # 0
        li   a2, 5
loop:   fadd.s ft11, ft11, ft0  # a loop: the taken branch flushes FP instructions in F and D
        addi a2, a2, -1
        bnez a2, loop
        fsub.s fs0, ft11, ft0
        fcvt.w.s a3, fs0
        csrrw a4, fcsr, zero
        fmin.s fs1, fs0, ft11
        fsgnjn.s fs2, fs1, fs1
        fclass.s a5, fs2
        j    halt
bad:    li   a0, -1
halt:   j    halt`;

describe('pipelined RV32IF CPU: hazards and integer code', () => {
  it('a hazard stress test', async () => {
    const r = await cosimPipe(STRESS);
    console.log(`stress: ${r.retired} instructions in ${r.cycles} cycles (CPI ${(r.cycles / r.retired).toFixed(2)})`);
  }, 120000);
  it('integer programs (forwarding from M, X and W, load-use, flushes)', async () => {
    for (const id of ['primer', 'sort', 'gcd']) await cosimPipe(PROGRAMS.find((p) => p.id === id)!.source, 6000);
  }, 120000);
  // found by the random-program fuzzer: an FP producer in M, a taken branch in E and its dependent in D (stalled
  // on the FP interlock); the flush kills D, and the branch must still redirect the PC that the stall holds
  it('a taken branch while D waits on an FP result', async () => {
    await cosimPipe(`        li   t0, 3
        fcvt.s.w ft0, t0
        beq  zero, zero, next   # taken to the very next instruction
next:   fadd.s ft1, ft0, ft0
        fcvt.s.w ft2, t0
        beq  zero, zero, far    # taken past the instruction in F
        fadd.s ft3, ft2, ft2
        li   a1, 7
far:    fadd.s ft4, ft2, ft1
        li   a0, 1
halt:   j    halt`);
  }, 120000);
  it('the event-driven simulator agrees (stress test)', async () => {
    await cosimPipe(STRESS, 4000, 'gate');
  }, 120000);
  it('clock period, CPI and time against the single-cycle FPU CPU', async () => {
    const words = assemble(F_PROGRAMS[0].source).words;
    const t1 = analyzeTiming(flatten(singleCycleCpu(words, { fpu: true, adder: 'ks' })))!;
    const t2 = analyzeTiming(flatten(pipelinedFpCpu(words)))!;
    console.log(`single-cycle ${t1.period}, pipelined ${t2.period}: ${t2.byCapture.slice(0, 6).map((c) => `${c.inst}:${c.period}`).join(' ')} | ${t2.stages.map((s) => `${s.inst}@${s.arrival}`).join(' ')}`);
    expect(t2.period * 2).toBeLessThan(t1.period);
    // cycles on the single-cycle CPU: one per instruction, plus the iterative units' extra cycles
    const singleCycles = (src: string) => {
      const iss = new ISS(assemble(src).words);
      let c = 0;
      while (!iss.halted && c < 5000) { const n = iss.step().text.split(' ')[0]; c += n === 'fdiv.s' ? FDIV_CYCLES : n === 'fsqrt.s' ? FSQRT_CYCLES : 1; }
      return { cycles: c, n: iss.steps };
    };
    const rows: string[] = [];
    for (const p of F_PROGRAMS) {
      const s1 = singleCycles(p.source), r = measured.get(p.id) ?? await cosimPipe(p.source);
      rows.push(`${p.id.padEnd(8)} ${String(s1.n).padStart(3)} instr | single ${String(s1.cycles).padStart(4)} cy × ${t1.period} = ${String(s1.cycles * t1.period).padStart(6)} | pipe ${String(r.cycles).padStart(4)} cy (CPI ${(r.cycles / r.retired).toFixed(2)}) × ${t2.period} = ${String(r.cycles * t2.period).padStart(6)} | ${(s1.cycles * t1.period / (r.cycles * t2.period)).toFixed(2)}×`);
    }
    for (const [name, src] of [['chain1', F_PROGRAMS.find((p) => p.id === 'fpchain')!.source.split('# three')[0] + 'halt: j halt'], ['chain3', F_PROGRAMS.find((p) => p.id === 'fpchain')!.source.replace(/fadd\.s fa0, fa0, ft0\n\s*/g, '')]] as const) {
      const r = await cosimPipe(src);
      rows.push(`${name}: ${r.retired} instructions in ${r.cycles} cycles`);
    }
    console.log(rows.join('\n'));
  }, 120000);
});
