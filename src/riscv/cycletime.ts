// What sets the single-cycle CPU's clock (chapter 14), DOM-free: the settle time after each rising edge, measured on the
// gate-level simulator and attributed to the class of the instruction the edge loaded. A random program mixes every
// class with fresh data, so the maximum per class is an honest lower bound of that class's path; the static critical
// path (sim/timing.ts) is the upper bound the clock must cover. Data decides what a ripple carry does: a measured time
// is the longest change that actually happened.

import { singleCycleCpu } from '../lib/cpu';
import { assemble } from './asm';
import { randomProgram32 } from './randprog32';
import { onTick, riseEdge } from '../sim/edge';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { analyzeTiming } from '../sim/timing';

export const CLASSES = [
  { cls: 'R', label: 'add, sub, slt …', op: 0x33 },
  { cls: 'I', label: 'addi, slli …', op: 0x13 },
  { cls: 'LOAD', label: 'lw', op: 0x03 },
  { cls: 'STORE', label: 'sw', op: 0x23 },
  { cls: 'BRANCH', label: 'beq, bne …', op: 0x63 },
  { cls: 'JAL', label: 'jal', op: 0x6f },
  { cls: 'JALR', label: 'jalr', op: 0x67 },
  { cls: 'LUI', label: 'lui', op: 0x37 },
  { cls: 'AUIPC', label: 'auipc', op: 0x17 },
] as const;

export interface ClassTime { cls: string; label: string; n: number; max: number; mean: number }
export interface CycleTimes {
  adder: 'rca' | 'ks';
  classes: ClassTime[];
  /** The longest settle time seen, over all classes. */
  worst: number;
  /** Static timing: the clock period (clk-to-q + logic + setup) and the top-level blocks the critical path crosses. */
  period: number;
  stages: { inst: string; arrival: number }[];
  cycles: number;
  /** The delay model both measurements used: 'load' times every NAND by what it drives, in tenths of a unit. */
  model: 'unit' | 'load';
}

/**
 * Run random programs (seeds) of n units on the CPU and time every cycle. `tick` lets a caller yield between programs.
 * `model` 'load' runs the simulation and the static timing on load-dependent delay (sim/delay.ts).
 */
export async function measureClasses(adder: 'rca' | 'ks', seeds: number[] = [1, 2, 3], n = 60, tick?: () => Promise<void>, model: 'unit' | 'load' = 'unit'): Promise<CycleTimes> {
  const acc = new Map<string, number[]>();
  let cycles = 0;
  let period = 0, stages: { inst: string; arrival: number }[] = [];
  for (const seed of seeds) {
    const words = assemble(randomProgram32(seed, { n })).words;
    const cpu = singleCycleCpu(words, { adder });
    const design = flatten(cpu, { mode: 'gate' });
    if (!period) {
      const rep = analyzeTiming(design, { delay: model });
      if (rep) { period = rep.period; stages = rep.stages; }
    }
    const sim = new GateSim(design, { delay: model });
    sim.setInput('clk', 0);
    sim.settle();
    const pcPort = sim.design.root.ports.pcOut;
    const pcOf = () => sim.getBits(pcPort).reduce<number>((s, b, k) => s + (b === 1 ? 2 ** k : 0), 0);
    let pc = pcOf(), prev = -1;
    for (let i = 0; i < 40 * n && prev !== pc; i++) {
      prev = pc;
      const t0 = sim.time;
      riseEdge(sim, 'clk');
      sim.settle();
      const d = onTick(sim, sim.time - t0);
      sim.setInput('clk', 0);
      sim.settle();
      pc = pcOf();
      const w = words[pc >> 2];
      if (w === undefined || (pc === prev && false)) break;
      const c = CLASSES.find((k) => k.op === (w & 0x7f));
      if (c && pc !== prev) { (acc.get(c.cls) ?? acc.set(c.cls, []).get(c.cls)!).push(d); cycles++; }
    }
    if (tick) await tick();
  }
  const classes = CLASSES.map((c) => {
    const v = acc.get(c.cls) ?? [];
    return { cls: c.cls, label: c.label, n: v.length, max: v.length ? Math.max(...v) : 0, mean: v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0 };
  });
  return { adder, classes, worst: Math.max(...classes.map((c) => c.max)), period, stages, cycles, model };
}
