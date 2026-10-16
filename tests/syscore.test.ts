// The system core with ports (systemCore, Appendix B's Doom computer): on a bench of library parts
// (its program ROM, a byte-banked data memory, and an I/O unit outside for the console, LEDs and
// switches at bit 31) it must run every system program like the golden model, cycle for cycle.

import { describe, expect, it } from 'vitest';
import { IO_UNIT, systemCore } from '../src/lib/system';
import { rom } from '../src/lib/cpu';
import { bankedMemory } from '../src/lib/lsu';
import { busMux2 } from '../src/lib/combinational';
import { AND, NOT } from '../src/lib/gates';
import { splitter } from '../src/lib/define';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, dmemWords, retiring } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import type { ComponentDef } from '../src/sim/types';

const bit = (name: string, dir: 'in' | 'out') => ({ name, dir, width: 1 });
const bus = (name: string, width: number, dir: 'in' | 'out') => ({ name, dir, width });

/** The core with a 2^7-word ROM, 2^5 words of data memory and the I/O unit outside (not registered). */
function bench(words: number[], m: boolean): ComponentDef {
  return {
    id: `syscore_bench_${m}`, name: 'system core bench', category: 'cpu',
    ports: [bit('clk', 'in'), bit('irq', 'in'), bus('switches', 8, 'in'), bus('pcOut', 32, 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), ...(m ? [bit('retire', 'out')] : [])],
    symbol: { kind: 'box', label: 'BENCH' },
    netlist: () => ({
      pins: {},
      instances: [
        { name: 'cpu', def: systemCore({ m }) }, { name: 'imem', def: rom(words, 7) }, { name: 'dm', def: bankedMemory(5) }, { name: 'io', def: IO_UNIT },
        { name: 'a31', def: splitter([31, 1]) }, { name: 'n31', def: NOT }, { name: 'dmWe', def: AND }, { name: 'ioWe', def: AND }, { name: 'rsel', def: busMux2(32) },
      ],
      nets: [
        { name: 'clk', ends: ['clk', 'cpu.clk', 'dm.clk', 'io.clk'] },
        { name: 'irq', ends: ['irq', 'cpu.irq'] },
        { name: 'pc', ends: ['cpu.pcOut', 'imem.addr', 'pcOut'] },
        { name: 'instr', ends: ['imem.data', 'cpu.instr'] },
        { name: 'addr', ends: ['cpu.memAddr', 'dm.addr', 'io.addr', 'a31.in'] },
        { name: 'wdata', ends: ['cpu.memWData', 'dm.wdata', 'io.wdata'] },
        { name: 'be', ends: ['cpu.memBE', 'dm.be'] },
        { name: 'we', ends: ['cpu.memWE', 'dmWe.a', 'ioWe.a'] },
        { name: 'isDev', ends: ['a31.o1', 'n31.a', 'ioWe.b', 'rsel.s'] },
        { name: 'isMem', ends: ['n31.y', 'dmWe.b'] },
        { name: 'dmWe', ends: ['dmWe.y', 'dm.we'] },
        { name: 'ioWe', ends: ['ioWe.y', 'io.we'] },
        { name: 'memR', ends: ['dm.rdata', 'rsel.a'] },
        { name: 'ioR', ends: ['io.rdata', 'rsel.b'] },
        { name: 'rdata', ends: ['rsel.y', 'cpu.memRData'] },
        { name: 'switches', ends: ['switches', 'io.switches'] },
        { name: 'consoleData', ends: ['io.consoleData', 'consoleData'] },
        { name: 'consoleValid', ends: ['io.consoleValid', 'consoleValid'] },
        { name: 'leds', ends: ['io.leds', 'leds'] },
        ...(m ? [{ name: 'retire', ends: ['cpu.retire', 'retire'] }] : []),
      ],
    }),
  } as ComponentDef;
}

function cosim(source: string, cycles: number, m: boolean, irqAt: number[] = []) {
  const prog = assemble(source);
  expect(prog.errors).toEqual([]);
  const design = flatten(bench(prog.words, m));
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
