// Stepping back: a saved simulation / golden-model state put back makes the run repeat exactly.

import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { SRAM_CELL } from '../src/lib/cells';
import { counter } from '../src/lib/sequential';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { MultiISS } from '../src/riscv/multi';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { SwitchSim } from '../src/sim/switchsim';
import { pack } from '../src/sim/values';

const q = (s: GateSim | SwitchSim, port: string) => pack(s.getBits(s.design.root.ports[port]));

describe('Sim.saveState / restoreState', () => {
  it('a counter goes back to the saved count and time, and counts on identically', () => {
    const s = new GateSim(flatten(counter(4)));
    s.setInput('en', 1);
    const tick = () => { s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); };
    for (let i = 0; i < 3; i++) tick();
    const saved = s.saveState();
    const t = s.time, at = q(s, 'q');
    for (let i = 0; i < 5; i++) tick();
    const later = q(s, 'q');
    expect(later).toBe((at + 5) % 16);
    s.restoreState(saved);
    expect(q(s, 'q')).toBe(at);
    expect(s.time).toBe(t);
    for (let i = 0; i < 5; i++) tick();
    expect(q(s, 'q')).toBe(later);
    // the same state twice: restoring does not consume it
    s.restoreState(saved);
    expect(q(s, 'q')).toBe(at);
  });

  it('pending events come back: a half-propagated edge finishes the same way', () => {
    const s = new GateSim(flatten(counter(4)));
    s.setInput('en', 1);
    s.setInput('clk', 1);
    s.step();
    s.step();
    const saved = s.saveState();
    s.settle();
    const done = q(s, 'q'), tDone = s.time;
    s.restoreState(saved);
    expect(s.busy()).toBe(true);
    s.settle();
    expect(q(s, 'q')).toBe(done);
    expect(s.time).toBe(tDone);
  });

  it('switch level: an SRAM cell gets its old bit back', () => {
    const s = new SwitchSim(flatten(SRAM_CELL, { mode: 'switch' }));
    const ins = SRAM_CELL.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    expect(ins.length).toBeGreaterThan(0);
    const before = s.design.root.def.ports.map((p) => q(s, p.name));
    const saved = s.saveState();
    for (const p of ins) s.setInput(p, 1);
    s.settle();
    s.restoreState(saved);
    expect(s.design.root.def.ports.map((p) => q(s, p.name))).toEqual(before);
  });
});

describe('golden models save / restore', () => {
  it('ISS: registers, PC and memory return, and the run repeats', () => {
    const words = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source).words;
    const iss = new ISS(words);
    for (let i = 0; i < 6; i++) iss.step();
    const saved = iss.save();
    const x = [...iss.x], pc = iss.pc, steps = iss.steps;
    while (!iss.halted) iss.step();
    const end = [...iss.x];
    iss.restore(saved);
    expect([...iss.x]).toEqual(x);
    expect(iss.pc).toBe(pc);
    expect(iss.steps).toBe(steps);
    expect(iss.halted).toBe(false);
    while (!iss.halted) iss.step();
    expect([...iss.x]).toEqual(end);
  });

  it('MultiISS: the harts keep sharing one memory after a restore', () => {
    const m = new MultiISS(assemble('li t0, 5\nsw t0, 0(zero)\nhalt: j halt').words);
    const saved = m.save();
    m.step(); m.step(); m.step();
    expect(m.dmem[0]).toBe(5);
    m.restore(saved);
    expect(m.dmem[0]).toBe(0);
    expect(m.harts.every((h) => h.dmem === m.dmem && h.pc === 0)).toBe(true);
  });

  it('the CPU and its model step back together and agree again', () => {
    const words = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source).words;
    const sim = new GateSim(flatten(singleCycleCpu(words)));
    sim.setInput('clk', 0);
    sim.settle();
    const iss = new ISS(words);
    for (let i = 0; i < 4; i++) { clockCycle(sim); iss.step(); }
    const hw = sim.saveState(), sw = iss.save();
    for (let i = 0; i < 4; i++) { clockCycle(sim); iss.step(); }
    sim.restoreState(hw);
    iss.restore(sw);
    for (let i = 0; i < 6; i++) {
      clockCycle(sim);
      iss.step();
      expect(cpuState(sim).x).toEqual([...iss.x]);
      expect(cpuState(sim).pc).toBe(iss.pc);
    }
  });
});
