// Custom instructions on the pipelined CPU (step 5b): the control unit decodes the rows and the hazard logic
// treats each by its signals (result = mem: load-use stall; rs1 / rs2: forwarding by register number; next PC
// ≠ +4: redirect from E; memWrite: a store). Checked three ways: nothing changes without rows, targeted programs
// in lock step with the golden model through retiring(), and random programs containing the instructions.

import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import type { PipeOptions } from '../src/lib/pipeline';
import { CONTROL } from '../src/lib/cpu';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retireCount, retirePc } from '../src/riscv/cosim';
import { CUSTOM_PRESETS, type CustomRow } from '../src/riscv/custom';
import { ISS } from '../src/riscv/iss';
import { randomProgram32 } from '../src/riscv/randprog32';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { tick } from './yieldtick';
import { CPUS, type CpuConfig } from './verify/cpus';
import { firstDivergence, fuzzCase, fuzzLanes } from './verify/fuzz';

const P = Object.fromEntries(CUSTOM_PRESETS.map((r) => [r.name, r]));
const row = (o: Partial<CustomRow> & Pick<CustomRow, 'name' | 'slot' | 'fmt'>): CustomRow =>
  ({ funct3: 0, regWrite: true, srcA: 'rs1', srcB: 'rs2', alu: 'add', memWrite: false, result: 'alu', next: 'pc4', ...o });

const BNX = row({ name: 'bnx', slot: 1, fmt: 'B', funct3: 1, regWrite: false, alu: 'sub', next: 'branch' });
const JLX = row({ name: 'jlx', slot: 2, fmt: 'I', srcB: 'imm', result: 'pc4', next: 'jalr' });
const OPX = row({ name: 'opx', slot: 3, fmt: 'I', funct3: 4, srcB: 'imm', alu: 'funct3' });
const JMP = row({ name: 'jmpl', slot: 1, fmt: 'I', srcB: 'imm', result: 'pc4', next: 'jump' });
const LPC = row({ name: 'lpc', slot: 2, fmt: 'I', srcA: 'pc', srcB: 'imm', result: 'mem' });
const SX = row({ name: 'sx', slot: 3, fmt: 'S', regWrite: false, srcB: 'imm', memWrite: true });
const SETS: { id: string; rows: CustomRow[] }[] = [
  { id: 'lwx swx subi', rows: [P.lwx, P.subi, P.swx] },
  { id: 'bnx jlx opx', rows: [BNX, JLX, OPX] },
  { id: 'jmpl lpc sx', rows: [JMP, LPC, SX] },
];

const OPTS: Record<string, PipeOptions> = {
  pipe: {}, 'pipe-ks': { adder: 'ks' }, 'pipe-bal': { adder: 'ks', balanced: true }, 'pipe-bp': { predictor: true },
  'pipe-bal-bp': { adder: 'ks', balanced: true, predictor: true }, 'pipe-wt-bal-bp': { adder: 'ks', dcache: 'wt', predictor: true, balanced: true },
  'pipe-m': { adder: 'ks', m: true },
};
const CPU_IDS = Object.keys(OPTS);
const cpuOf = (id: string, custom: CustomRow[]): CpuConfig => {
  const c = CPUS.find((x) => x.id === id)!;
  return { ...c, isa: { ...c.isa, custom }, build: (w, imemK, dmemK) => pipelinedCpu(w, { imemK, ...(c.fixedDmemK ? {} : { dmemK }), ...OPTS[id], custom }) };
};

/** Each case: the rows, a program using them (hazards between the new instructions and their neighbours). */
const PROGRAMS: { id: string; set: number; src: string; check?: (iss: ISS) => void }[] = [
  {
    id: 'lwx feeds the next instruction (load-use stall), in a loop', set: 0,
    src: `li a0, 64
      li t0, 3
      sw t0, 0(a0)
      li t0, 5
      sw t0, 4(a0)
      li t0, 7
      sw t0, 8(a0)
      li t0, 9
      sw t0, 12(a0)
      li t0, 0
      li t1, 0
      li t2, 16
loop: lwx t3, a0, t0
      add t1, t1, t3
      addi t0, t0, 4
      bne t0, t2, loop
done: j done`,
    check: (iss) => expect(iss.x[6]).toBe(24),
  },
  {
    id: 'subi chain: forwarding from E, M and W; a lwx base from the instruction before', set: 0,
    src: `li a0, 100
      subi a1, a0, 1
      subi a2, a1, 1
      subi a3, a2, 1
      add a4, a3, a1
      sw a4, 8(zero)
      lwx a5, zero, a1
      subi a6, a5, 3
      sw a6, 12(zero)
halt: j halt`,
  },
  {
    id: 'swx stores the register written just before (data and address forwarding)', set: 0,
    src: 'li a0, 8\nli a1, 12\nsubi a1, a1, -4\nswx a1, a0, a1\nlwx a2, a0, a1\nadd a3, a2, a2\nhalt: j halt',
  },
  {
    id: 'bnx: flushes the two instructions behind a taken branch, loop of 3', set: 1,
    src: 'li a0, 3\nli a1, 0\nloop: addi a1, a1, 1\naddi a0, a0, -1\nbnx a0, zero, loop\nli a2, 7\nhalt: j halt',
    check: (iss) => expect(iss.x[11]).toBe(3),
  },
  {
    id: 'jlx: a jalr-like jump with link, target from the register just written', set: 1,
    src: 'li t0, 16\naddi t0, t0, 4\njlx ra, t0, 0\nli a0, 1\nhalt: j halt\nli a0, 2\nj halt',
    check: (iss) => expect(iss.x[10]).toBe(2),
  },
  {
    id: 'opx (funct3 xor) after a branch, operands forwarded', set: 1,
    src: 'li a0, 0x0f0\nopx a1, a0, 0x0ff\nopx a2, a1, 0x3\nbnx a1, zero, over\nli a2, 9\nover: opx a3, a2, 1\nhalt: j halt',
  },
  {
    id: 'jmpl: a jump to pc + imm with link skips one instruction', set: 2,
    src: 'li a0, 1\njmpl ra, zero, 8\nli a0, 2\nli a1, 3\nhalt: j halt',
    check: (iss) => expect([iss.x[10], iss.x[11]]).toEqual([1, 3]),
  },
  {
    id: 'lpc, sx: a pc-relative load after a store the instruction before (memory in order)', set: 2,
    src: 'li t0, 77\nsx t0, 32(zero)\nsx t0, 36(zero)\nlpc a0, zero, 24\nadd a1, a0, a0\nhalt: j halt',
  },
];

/** Lock step through retiring(): the PC about to retire is the golden model's, registers match after each. */
function lockstep(id: string, rows: CustomRow[], src: string, check?: (iss: ISS) => void): void {
  const asm = assemble(src, rows);
  expect(asm.errors).toEqual([]);
  const cfg = cpuOf(id, rows);
  const sim = new GateSim(flatten(cfg.build(asm.words, 6, 5)));
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words, { custom: rows, dmemWords: 2 ** (cfg.fixedDmemK ?? 5), imemWords: 64 });
  for (let cyc = 1; cyc < 1500 && !iss.halted; cyc++) {
    const ret = retireCount(sim);
    if (ret) expect(retirePc(sim, sim.design.root), `${id} cycle ${cyc}: retiring pc`).toBe(iss.pc);
    clockCycle(sim);
    if (!ret) continue;
    iss.step();
    expect(cpuState(sim).x, `${id} cycle ${cyc} after ${iss.steps} instructions`).toEqual([...iss.x].map((v) => v >>> 0));
  }
  expect(iss.halted, `${id} halts`).toBe(true);
  for (let k = 0; k < 8; k++) clockCycle(sim);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem].map((v) => v >>> 0));
  check?.(iss);
}

describe('custom instructions on the pipeline: nothing changes without rows', () => {
  it('no rows: the same component, the same counts', () => {
    const prog = [0x6f];
    for (const o of [{}, { adder: 'ks' as const, balanced: true, predictor: true }, { m: true, adder: 'ks' as const }]) {
      expect(pipelinedCpu(prog, { ...o, custom: [] })).toBe(pipelinedCpu(prog, o));
      expect(stats(pipelinedCpu(prog, { ...o, custom: [] })).nands).toBe(stats(pipelinedCpu(prog, o)).nands);
    }
    expect(stats(CONTROL).nands).toBe(152);
  });

  it('rows add exactly the control unit\'s growth', () => {
    for (const s of SETS) {
      const plain = stats(pipelinedCpu([0x6f], {})).nands, cx = stats(pipelinedCpu([0x6f], { custom: s.rows })).nands;
      expect(cx - plain, s.id).toBeGreaterThan(0);
      expect(cx - plain, s.id).toBeLessThan(120);
    }
  });
});

describe('custom instructions on the pipeline: lock step with the golden model', () => {
  for (const id of CPU_IDS) {
    for (const p of PROGRAMS) {
      it(`${id}: ${p.id}`, () => lockstep(id, SETS[p.set].rows, p.src, p.check), 120_000);
    }
  }
});

describe('custom instructions on the pipeline: random programs', () => {
  it('programs draw the rows and stay well-formed', () => {
    for (const s of SETS) {
      const src = randomProgram32(5, { n: 80, custom: s.rows });
      for (const r of s.rows) expect(src, r.name).toContain(`${r.name} `);
      const asm = assemble(src, s.rows);
      expect(asm.errors).toEqual([]);
      const iss = new ISS(asm.words, { custom: s.rows, dmemWords: 32, imemWords: 512 });
      while (!iss.halted && iss.steps < 50_000) iss.step();
      expect(iss.halted).toBe(true);
    }
    // without rows the programs are the old ones
    expect(randomProgram32(5, { n: 80, custom: [] })).toBe(randomProgram32(5, { n: 80 }));
  });

  for (const id of CPU_IDS) {
    for (const s of SETS) {
      it(`${id} with ${s.id}: 32 random programs end in the golden model's state`, async () => {
        const cfg = cpuOf(id, s.rows);
        const cases = Array.from({ length: 32 }, (_, i) => fuzzCase(cfg, i + 1, 60));
        const failed: string[] = [];
        for (const r of (await fuzzLanes(cfg, cases)).filter((x) => !x.ok)) {
          const c = cases.find((x) => x.seed === r.seed)!;
          failed.push(`seed ${r.seed}: ${r.diff}\nfirst difference: ${await firstDivergence(cfg, c)}\n${c.source}`);
        }
        expect(failed).toEqual([]);
        await tick();
      }, 300_000);
    }
  }
});

describe('custom instructions on the pipeline: the drawing', () => {
  it('no overlaps with rows in the control unit', () => {
    const d = pipelinedCpu([0x6f], { custom: SETS[1].rows });
    const nl = netlistOf(d)!;
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(wireOverlaps(routeNetlist(d, nl).nets).length).toBe(0);
  }, 120_000);
});
