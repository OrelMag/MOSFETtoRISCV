// The Power chapter's numbers, computed (DOM-free): the single-cycle CPU with and without clock gating on `sum`, measured
// on GateSim (sim/power.ts, glitches included; sim/leakage.ts averaged over every cycle's settled state), and the
// device law's curve of energy per instruction against supply voltage from the benchmark runs' switched capacitance
// (results.json) and the CPU's static-timing period. scripts/power-costs.ts --write saves them to powercosts.json;
// tests/power-costs.test.ts recomputes and compares, so the prose cannot drift from the circuits.

import { singleCycleCpu } from '../lib/cpu';
import { delayScale, deviceOf, offCurrent, type Process, PROCESSES, V_NOM } from '../phys/cmosv';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { leakageOf } from '../sim/leakage';
import { energyFj, PowerMeter, VDD } from '../sim/power';
import { stats } from '../sim/stats';
import { analyzeTiming, PS_PER_NAND } from '../sim/timing';
import results from './results.json';

export const POWER_PROGRAM = 'sum';
/** Cycles measured from reset: `sum` halts in its self-loop after 37 instructions, so this ends well inside the loop. */
export const POWER_CYCLES = 60;

export interface CpuPower {
  nands: number;
  period: number;
  /** pJ per cycle at VDD, and the share that glitches (toggles that end where they started). */
  pj: number;
  glitch: number;
  /** pJ per cycle by top-level block (the clock net apart), largest first. */
  blocks: [string, number][];
  /** The clock net: its capacitance (fF), the NAND inputs on it, and how many of them each block holds. */
  clockFf: number;
  clockInputs: number;
  clockBy: [string, number][];
  /** Leakage (µW), averaged over the cycles' settled states, per process. */
  leakUw: Record<Process['id'], number>;
}

/** Four significant digits: the numbers span from µW of leakage to pF of clock. */
const r3 = (x: number) => (x === 0 ? 0 : Number(x.toPrecision(4)));

export function measureCpu(gated: boolean): CpuPower {
  const words = assemble(PROGRAMS.find((p) => p.id === POWER_PROGRAM)!.source).words;
  const def = singleCycleCpu(words, { gatedClocks: gated });
  const d = flatten(def, { mode: 'gate' });
  const sim = new GateSim(d);
  sim.setInput('clk', 0);
  sim.reset('zero');
  sim.settle();
  const m = new PowerMeter(sim);
  const leak = { hp: 0, lp: 0 };
  for (let k = 0; k < POWER_CYCLES; k++) {
    sim.setInput('clk', 1); sim.settle(); m.mark();
    sim.setInput('clk', 0); sim.settle(); m.mark();
    for (const id of ['hp', 'lp'] as const) leak[id] += leakageOf(sim, d, PROCESSES[id]).watts;
  }
  const t = m.totals();
  const clk = d.root.ports.clk[0];
  const by = new Map<string, number>();
  let inputs = 0;
  for (const l of d.leaves) for (const ins of l.inputs) for (const f of ins) if (f === clk) {
    let n = l.node; while (n.parent?.parent) n = n.parent;
    by.set(n.name, (by.get(n.name) ?? 0) + 1); inputs++;
  }
  return {
    nands: stats(def).nands,
    period: analyzeTiming(d)!.period,
    pj: r3(energyFj(t.switched) / POWER_CYCLES / 1e3),
    glitch: r3(1 - t.functional / t.switched),
    blocks: m.breakdown().map((r): [string, number] => [r.name, r3(energyFj(r.switched) / POWER_CYCLES / 1e3)]),
    clockFf: r3(m.caps[clk]),
    clockInputs: inputs,
    clockBy: [...by].sort((a, b) => b[1] - a[1]),
    leakUw: { hp: r3((leak.hp / POWER_CYCLES) * 1e6), lp: r3((leak.lp / POWER_CYCLES) * 1e6) },
  };
}

/** The benchmark runs of a CPU (results.json): switched fF per instruction, cycles per instruction, period. */
export function benchOf(id: string): { ffPerInstr: number; cpi: number; period: number; glitch: number } {
  const c = (results as { cpus: { id: string; period: number; runs: { instructions: number; cycles: number; switched?: number; functional?: number }[] }[] }).cpus.find((x) => x.id === id)!;
  let sw = 0, fn = 0, ins = 0, cyc = 0;
  for (const r of c.runs) if (r.switched) { sw += r.switched; fn += r.functional!; ins += r.instructions; cyc += r.cycles; }
  return { ffPerInstr: sw / ins, cpi: cyc / ins, period: c.period, glitch: 1 - fn / sw };
}

export interface VPoint { v: number; mhz: number; dynPj: number; leakPj: number }

/**
 * Energy per instruction at supply v: dynamic ½ C V² from the benchmarks' switched C, leakage = the CPU's NANDs leaking
 * like one off transistor each (the average of their states, measured: `leakPerNand`) × v × the instruction's time,
 * the period stretched by the device law.
 */
export function vPoint(p: Process, v: number, b: ReturnType<typeof benchOf>, nands: number, leakPerNand: number): VPoint {
  const tInstr = b.cpi * b.period * PS_PER_NAND * 1e-12 * delayScale(p, v);
  const dyn = 0.5 * b.ffPerInstr * 1e-15 * v * v;
  const lk = nands * leakPerNand * (offAt(p, v) / offAt(p, V_NOM)) * v * tInstr;
  return { v, mhz: 1 / (b.cpi * b.period * PS_PER_NAND * 1e-12 * delayScale(p, v)) / 1e6, dynPj: dyn * 1e12, leakPj: lk * 1e12 };
}

const offAt = (p: Process, v: number) => offCurrent(p, v);

export interface PowerCosts {
  program: string;
  cycles: number;
  vdd: number;
  plain: CpuPower;
  gated: CpuPower;
  device: Record<Process['id'], { vt: number; wNm: number }>;
  /** The minimum-energy point of the single-cycle CPU per process. */
  minimum: Record<Process['id'], VPoint>;
  /** Energy per instruction at VDD per process (pJ), and its leakage share. */
  atVdd: Record<Process['id'], VPoint>;
}

/** Each NAND's average leak (A at V_NOM) in the plain CPU's states on `sum`, per process. */
export const leakPerNandOf = (plain: CpuPower, id: Process['id']) => (id === 'hp' ? plain.leakUw.hp * 1e-6 : plain.leakUw.lp * 1e-6) / VDD / plain.nands;

export function powerCosts(): PowerCosts {
  const plain = measureCpu(false), gated = measureCpu(true);
  const b = benchOf('sc');
  const minimum = {} as PowerCosts['minimum'], atVdd = {} as PowerCosts['atVdd'], device = {} as PowerCosts['device'];
  for (const id of ['hp', 'lp'] as const) {
    const p = PROCESSES[id], per = leakPerNandOf(plain, id);
    let best: VPoint | null = null;
    for (let mv = 150; mv <= 1100; mv += 5) {
      const pt = vPoint(p, mv / 1000, b, plain.nands, per);
      if (!best || pt.dynPj + pt.leakPj < best.dynPj + best.leakPj) best = pt;
    }
    const round = (q: VPoint): VPoint => ({ v: q.v, mhz: r3(q.mhz), dynPj: r3(q.dynPj), leakPj: r3(q.leakPj) });
    minimum[id] = round(best!);
    atVdd[id] = round(vPoint(p, V_NOM, b, plain.nands, per));
    const dv = deviceOf(p);
    device[id] = { vt: r3(dv.vt), wNm: r3(dv.w * 1000) };
  }
  return { program: POWER_PROGRAM, cycles: POWER_CYCLES, vdd: VDD, plain, gated, device, minimum, atVdd };
}
