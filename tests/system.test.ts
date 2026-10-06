import { describe, expect, it } from 'vitest';
import { systemCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

/** Run the gate-level system CPU and the system ISS in lock-step for n cycles. */
function cosim(source: string, cycles: number, irqAt: number[] = []) {
  const words = assemble(source).words;
  const design = flatten(systemCpu(words));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words, { system: true, imemWords: 128 });
  let console = '';
  const root = design.root;
  for (let c = 0; c < cycles; c++) {
    const irq = irqAt.includes(c) ? 1 : 0;
    sim.setInput('irq', irq);
    iss.irq = !!irq;
    sim.settle();
    if (sim.getBits(root.ports.consoleValid)[0] === 1) console += String.fromCharCode(pack(sim.getBits(root.ports.consoleData)));
    const info = iss.step();
    clockCycle(sim);
    const st = cpuState(sim);
    expect(st.pc, `cycle ${c}: pc after ${info.text}`).toBe(iss.pc);
    expect(st.x, `cycle ${c}: registers after ${info.text}`).toEqual([...iss.x]);
  }
  expect(console).toBe(iss.console);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  expect(pack(sim.getBits(root.ports.leds))).toBe(iss.leds);
  return { iss, console, leaves: design.leaves.length };
}

describe('complete system CPU (gate level) vs golden model', () => {
  for (const p of SYSTEM_PROGRAMS) {
    it(p.id, () => {
      const r = cosim(p.source, p.id === 'timer' ? 260 : p.id === 'irq' ? 120 : 140, p.id === 'irq' ? [60, 90] : []);
      console.log(`${p.id}: ${r.leaves} leaves, console ${JSON.stringify(r.console)}`);
    }, 180000);
  }
  it('runs the user-mode sample programs too', () => {
    for (const id of ['primer', 'gcd']) cosim(PROGRAMS.find((p) => p.id === id)!.source, 120);
  }, 180000);
});
