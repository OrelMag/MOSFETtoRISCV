// Reset on a program panel (the stage's powerCycle: sim.reset + a settle, the golden model started again): the circuit
// is in the state a fresh load has, whatever ran before. The panels' own buttons and hooks are DOM; this is the part
// they stand on.

import { describe, expect, it } from 'vitest';
import { dualCore, pipelinedCpu, singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { MultiISS } from '../src/riscv/multi';
import { PROGRAMS } from '../src/riscv/programs';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';

const fresh = (def: ComponentDef): GateSim => { const sim = new GateSim(flatten(def)); sim.setInput('clk', 0); sim.settle(); return sim; };
/** What the stage's Reset does to the circuit (Stage.powerCycle). */
const powerCycle = (sim: GateSim): void => { sim.reset('zero'); sim.settle(); };
const words = (id: string) => assemble(PROGRAMS.find((p) => p.id === id)!.source).words;

describe('Reset: the circuit and the golden model are where a fresh load puts them', () => {
  it('single-cycle CPU: registers, PC, data memory, time; the golden model restarts', () => {
    const w = words('fib'), sim = fresh(singleCycleCpu(w)), ref = fresh(singleCycleCpu(w));
    let iss = new ISS(w);
    for (let i = 0; i < 40; i++) { iss.step(); clockCycle(sim); }
    expect(cpuState(sim).pc).not.toBe(cpuState(ref).pc);
    powerCycle(sim); iss = new ISS(w);
    expect(cpuState(sim)).toEqual(cpuState(ref));
    expect(sim.time).toBe(ref.time);
    expect(iss.steps).toBe(0);
    expect(cpuState(sim).x).toEqual([...iss.x]);
    // and it runs the program again, in lock step
    for (let i = 0; i < 25; i++) { iss.step(); clockCycle(sim); expect(cpuState(sim).x).toEqual([...iss.x]); }
  }, 120000);

  it('pipelined CPU: the pipeline registers empty again', () => {
    const w = words('sum'), sim = fresh(pipelinedCpu(w)), ref = fresh(pipelinedCpu(w));
    for (let i = 0; i < 30; i++) clockCycle(sim);
    powerCycle(sim);
    expect(cpuState(sim)).toEqual(cpuState(ref));
    for (let i = 0; i < 12; i++) { clockCycle(sim); clockCycle(ref); expect(cpuState(sim)).toEqual(cpuState(ref)); }
  }, 120000);

  it('dual core: both cores, the shared memory and the multi-hart model', () => {
    const w = words('sum'), sim = fresh(dualCore(w)), ref = fresh(dualCore(w));
    let m = new MultiISS(w);
    const cores = (s: GateSim) => [0, 1].map((i) => cpuState(s, s.design.root.children!.get(`core${i}`)!));
    for (let i = 0; i < 30; i++) { clockCycle(sim); m.step(); }
    expect(cores(sim)).not.toEqual(cores(ref));
    powerCycle(sim); m = new MultiISS(w);
    expect(cores(sim)).toEqual(cores(ref));
    expect(m.cycles).toBe(0);
    for (let i = 0; i < 12; i++) { clockCycle(sim); clockCycle(ref); expect(cores(sim)).toEqual(cores(ref)); }
  }, 120000);
});
