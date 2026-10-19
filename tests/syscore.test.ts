// The system core with ports (systemCore, Appendix B's Doom computer): on a bench of library parts
// (its program ROM, a byte-banked data memory, and an I/O unit outside for the console, LEDs and
// switches at bit 31) it must run every system program like the golden model, cycle for cycle.

import { describe, expect, it } from 'vitest';
import { coreBench } from './syscorebench';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, dmemWords, retiring } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

function cosim(source: string, cycles: number, m: boolean, irqAt: number[] = []) {
  const prog = assemble(source);
  expect(prog.errors).toEqual([]);
  const design = flatten(coreBench(prog.words, m));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(prog.words, { system: true, m, imemWords: 128 });
  const root = design.root, core = root.children!.get('cpu')!;
  let console = '';
  for (let c = 0; c < cycles; c++) {
    const irq = irqAt.includes(c) ? 1 : 0;
    sim.setInput('irq', irq);
    iss.irq = !!irq;
    sim.settle();
    if (sim.getBits(root.ports.consoleValid)[0] === 1) console += String.fromCharCode(pack(sim.getBits(root.ports.consoleData)));
    // the golden model steps when the core retires (a divide stalls it, interrupt entries included)
    const step = !m || retiring(sim, root);
    const info = step ? iss.step() : null;
    clockCycle(sim);
    const st = cpuState(sim, core);
    if (!step) continue;
    expect(st.pc, `cycle ${c}: pc after ${info!.text}`).toBe(iss.pc);
    expect(st.x, `cycle ${c}: registers after ${info!.text}`).toEqual([...iss.x]);
  }
  expect(console).toBe(iss.console);
  expect(dmemWords(sim, root.children!.get('dm')!)).toEqual([...iss.dmem]);
  expect(pack(sim.getBits(root.ports.leds))).toBe(iss.leds);
  return console;
}

describe('system core with ports (gate level) vs golden model', () => {
  for (const p of SYSTEM_PROGRAMS) {
    it(`${p.id} (RV32I)`, () => {
      cosim(p.source, p.id === 'timer' ? 260 : p.id === 'irq' ? 120 : 140, false, p.id === 'irq' ? [60, 90] : []);
    }, 180_000);
  }
  for (const p of M_PROGRAMS) {
    it(`${p.id} (RV32IM)`, () => {
      cosim(p.source, 700, true);
    }, 180_000);
  }
  it('runs the user-mode sample programs too', () => {
    for (const id of ['primer', 'gcd']) cosim(PROGRAMS.find((p) => p.id === id)!.source, 120, true);
  }, 180_000);
});
