import { describe, expect, it } from 'vitest';
import { MC_FSM, MC_MICRO, MC_FIELDS, MC_STATES, multicycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';

describe('the two multicycle controllers are equivalent', () => {
  it('produce the same control signals and states for any opcode sequence', () => {
    const a = simulate(MC_FSM), b = simulate(MC_MICRO);
    const outs = [...MC_FIELDS.map(([f]) => f), 'state'];
    const ops = [0x33, 0x13, 0x03, 0x23, 0x63, 0x6f, 0x67, 0x37, 0x17, 0x0f, 0x73, 0x7f];
    let seed = 5;
    for (const s of [a, b]) { s.setInput('clk', 0); s.setInput('op', 0x33); s.settle(); }
    const seen = new Set<number>();
    for (let c = 0; c < 3000; c++) {
      // a new opcode arrives with each fetch (the IR holds it for the rest of the instruction)
      if (pack(a.getBits(a.design.root.ports.state)) === 0) {
        const op = ops[((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) % ops.length];
        for (const s of [a, b]) { s.setInput('op', op); s.settle(); }
      }
      const op = a.getInput('op');
      const va = outs.map((o) => pack(a.getBits(a.design.root.ports[o])));
      const vb = outs.map((o) => pack(b.getBits(b.design.root.ports[o])));
      expect(vb, `cycle ${c}, op ${op.toString(16)}`).toEqual(va);
      seen.add(va[va.length - 1]);
      for (const s of [a, b]) { s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); }
    }
    expect([...seen].sort((x, y) => x - y)).toEqual(MC_STATES.map((_, i) => i));
  });
});

function cosim(source: string, control: 'fsm' | 'micro', cycles = 4000) {
  const asm = assemble(source);
  const design = flatten(multicycleCpu(asm.words, { control }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words);
  let c = 0;
  for (; c < cycles && !iss.halted; c++) {
    if (!retiring(sim)) { clockCycle(sim); continue; }
    const info = iss.step();
    clockCycle(sim);
    const st = cpuState(sim);
    expect(st.pc, `cycle ${c}: pc after ${info.text}`).toBe(iss.pc);
    expect(st.x, `cycle ${c}: registers after ${info.text}`).toEqual([...iss.x]);
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles: c, steps: iss.steps, leaves: design.leaves.length };
}

describe('multicycle CPU (gate level) vs golden model', () => {
  // one test per program: each stays well below Vitest's 60 s worker-RPC window on slow runners
  for (const control of ['fsm', 'micro'] as const) {
    for (const p of PROGRAMS) {
      it(`${control}: ${p.id}`, () => {
        const r = cosim(p.source, control);
        console.log(`${control} ${p.id}: ${r.steps} instructions in ${r.cycles} cycles, CPI ${(r.cycles / r.steps).toFixed(2)}, ${r.leaves} leaves`);
      }, 600000);
    }
  }
});
