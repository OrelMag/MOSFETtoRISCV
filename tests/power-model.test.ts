// The Power chapter's models: the device law (phys/cmosv.ts) against its citations, the book's calibration and
// chapter 2's square law; leakage from the simulation's values (sim/leakage.ts); the clock gate (lib/clockgate.ts):
// glitch-free for every timing of en, a gated register equal to the plain one, and the gated CPU equal to the golden model.

import { describe, expect, it } from 'vitest';
import { ICG, ICG_HOLD, ICG_SETUP, gatedRegister } from '../src/lib/clockgate';
import { singleCycleCpu } from '../src/lib';
import { AND } from '../src/lib/gates';
import { register } from '../src/lib/sequential';
import { K, VT } from '../src/widgets/mosphys';
import { deviceOf, delayScale, gateDelay, offCurrent, onCurrent, PROCESSES, seriesOff, squareLawLimit, SWING_MV, V_NOM } from '../src/phys/cmosv';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { symbolGeom } from '../src/sim/geometry';
import { leakageOf, nandLeak } from '../src/sim/leakage';
import { PS_PER_NAND } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';
import { tick } from './yieldtick';

describe('device law', () => {
  for (const p of Object.values(PROCESSES)) {
    it(`${p.id}: the cited on and off currents per µm, 25 ps per NAND at 0.9 V`, () => {
      const { w } = deviceOf(p);
      expect(onCurrent(p, V_NOM) / w / p.ion).toBeCloseTo(1, 6);
      expect(offCurrent(p, V_NOM) / w / p.ioff).toBeCloseTo(1, 3);
      expect(gateDelay(p, V_NOM) * 1e12).toBeCloseTo(PS_PER_NAND, 6);
      // slower at lower supply, monotonically; stacks leak less than one device
      let last = 0;
      for (let v = 0.2; v <= 1.1; v += 0.05) { const s = delayScale(p, v); if (last) expect(s).toBeLessThan(last); last = s; }
      expect(seriesOff(p, V_NOM, 2)).toBeLessThan(offCurrent(p, V_NOM));
      expect(seriesOff(p, V_NOM, 3)).toBeLessThan(seriesOff(p, V_NOM, 2));
    });
  }
  it('thresholds solved from the citations: high performance below low leakage', () => {
    expect(deviceOf(PROCESSES.hp).vt).toBeLessThan(deviceOf(PROCESSES.lp).vt);
    expect(SWING_MV).toBeGreaterThan(70);
    expect(SWING_MV).toBeLessThan(100);
  });
  it("far above threshold it is chapter 2's square law (K/2)·Vov²", () => {
    for (const vov of [0.5, 0.9, 1.35]) expect(squareLawLimit(K, VT, VT + vov) / ((K / 2) * vov * vov)).toBeCloseTo(1, 3);
  });
});

describe('leakage by state', () => {
  const p = PROCESSES.hp;
  it('a NAND: two parallel PMOS off at 11, one NMOS at 01, the stack at 00', () => {
    const one = offCurrent(p, V_NOM);
    expect(nandLeak(p, V_NOM, 2, 0)).toBeCloseTo(2 * one, 15);
    expect(nandLeak(p, V_NOM, 2, 1)).toBeCloseTo(one, 15);
    expect(nandLeak(p, V_NOM, 2, 2)).toBeLessThan(one);
  });
  it('summed over a simulated circuit, by the state it is in', () => {
    const sim = new GateSim(flatten(AND));
    const leak = (a: number, b: number) => { sim.setInput('a', a); sim.setInput('b', b); sim.settle(); return leakageOf(sim, sim.design, p); };
    // AND = NAND then NAND as an inverter: at a = b = 1 the first NAND has both inputs 1, the second both 0
    const r = leak(1, 1);
    expect(r.nands).toBe(2);
    expect(r.allOne).toBe(1);
    expect(r.stacked).toBe(1);
    expect(r.amps).toBeCloseTo(nandLeak(p, V_NOM, 2, 0) + nandLeak(p, V_NOM, 2, 2), 15);
    expect(leak(0, 1).amps).not.toBeCloseTo(r.amps, 12);
  });
});

/** Run `def` with `en` changing `at` NAND delays after each rising edge of a clock of half-period `half`; gclk's pulses. */
function pulses(def: ComponentDef, half: number, at: number, cycles = 6): number[] {
  const [clk, en0] = def === AND ? ['a', 'b'] : ['clk', 'en'];
  const sim = new GateSim(flatten(def));
  sim.setInput(clk, 0); sim.setInput(en0, 0);
  sim.reset('zero'); sim.settle();
  const out = sim.design.root.ports[def.ports.find((q) => q.dir === 'out')!.name][0];
  const widths: number[] = [];
  let rose = -1, t = 0;
  const watch = () => {
    const v = sim.get(out);
    if (v === 1 && rose < 0) rose = t;
    if (v === 0 && rose >= 0) { widths.push(t - rose); rose = -1; }
  };
  let en = 0;
  for (let c = 0; c < cycles; c++) {
    for (let k = 0; k < 2 * half; k++) {
      if (k === 0) sim.setInput(clk, 1);
      if (k === half) sim.setInput(clk, 0);
      if (k === (at % (2 * half))) sim.setInput(en0, (en ^= 1));
      sim.step(); t++; watch();
    }
  }
  return widths;
}

describe('clock gate', () => {
  const half = 12;
  // en, like a flip-flop's d, must be steady a setup time before the rising edge (ICG_SETUP NAND delays) and a hold time after
  it('a bare AND makes runt pulses when en changes while clk is high; the ICG never does, outside its setup and hold', () => {
    for (let at = 1; at < half; at++) expect(pulses(AND, half, at).some((w) => w < half), `AND, en at ${at}`).toBe(true);
    for (let at = ICG_HOLD; at <= 2 * half - ICG_SETUP; at++)
      for (const w of pulses(ICG, half, at)) expect(w, `ICG, en at ${at}`).toBe(half);
    // inside the setup window it fails like any storage element
    expect(pulses(ICG, half, 2 * half - 1).some((w) => w < half)).toBe(true);
  });
  it('the gated register has the plain one\'s outline and behaviour, without the enable muxes', () => {
    const G = gatedRegister(8), R = register(8);
    expect(symbolGeom(G)).toEqual(symbolGeom(R));
    const sims = [G, R].map((d) => { const s = new GateSim(flatten(d)); s.setInput('clk', 0); s.setInput('en', 0); s.setInput('d', 0); s.reset('zero'); s.settle(); return s; });
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 8;
    for (let i = 0; i < 60; i++) {
      const d = rnd() & 255, en = rnd() & 1;
      for (const s of sims) { s.setInput('d', d); s.setInput('en', en); s.settle(); s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); }
      expect(sims[0].getBits(sims[0].design.root.ports.q)).toEqual(sims[1].getBits(sims[1].design.root.ports.q));
    }
  });
  it('the clock-gated single-cycle CPU matches the golden model', async () => {
    for (const id of ['sum', 'sort', 'alu']) {
      const words = assemble(PROGRAMS.find((p) => p.id === id)!.source).words;
      const sim = new GateSim(flatten(singleCycleCpu(words, { gatedClocks: true })));
      sim.setInput('clk', 0);
      sim.settle();
      const iss = new ISS(words);
      let n = 0;
      while (!iss.halted && n++ < 1500) {
        iss.step();
        clockCycle(sim);
        expect(cpuState(sim).x, `${id} cycle ${n}`).toEqual([...iss.x]);
      }
      expect(iss.halted).toBe(true);
      expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
      await tick();
    }
  }, 120_000);
});
