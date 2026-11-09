// GateSim's unit-delay behaviour, pinned (docs/PLAN-FINEDELAY.md, stage 1): every change the engine reports (net, value,
// time) with every net watched, over a fixed set of circuits and stimuli, hashed; and the times a learner steps through
// (stepEdge with and without a period, the bar's Step through an input change). Taken on main before the fine-delay engine:
// the unit model must stay byte-identical. Regenerate only on purpose: npx vite-node scripts/gatesim-fp.ts --write.

import '../src/lib';
import { rca } from '../src/lib/combinational';
import { singleCycleCpu } from '../src/lib/cpu';
import { ringOsc } from '../src/lib/cmosgates';
import { pipelinedCpu } from '../src/lib/pipeline';
import { DFF_EDGE6, skewPair } from '../src/lib/seqdeep';
import { clockDivider, DFF_R } from '../src/lib/seqparts';
import { DFF, SR_LATCH } from '../src/lib/sequential';
import { assemble } from '../src/riscv/asm';
import { completeEdge, riseEdge, stepEdge } from '../src/sim/edge';
import { applyFaults } from '../src/sim/faults';
import { flatten, type FlatDesign } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';

export interface Print { hash: string; events: number; evaluations: number; time: number; unstable: boolean }

/** FNV-1a over 32-bit words. */
class Fnv {
  h = 0x811c9dc5;
  n(x: number): void {
    let v = Math.round(x * 10) | 0; // tenths: an integer time hashes as before, a later fractional one still exactly
    for (let i = 0; i < 4; i++) { this.h ^= v & 0xff; this.h = Math.imul(this.h, 0x01000193) >>> 0; v >>>= 8; }
  }
  get hex(): string { return this.h.toString(16).padStart(8, '0'); }
}

const PROGRAM = `
  addi x1, x0, 5
  addi x2, x0, 0
loop:
  add  x2, x2, x1
  sw   x2, 0(x0)
  lw   x3, 0(x0)
  addi x1, x1, -1
  bne  x1, x0, loop
  addi x4, x3, 7
  j loop`;

/** A GateSim on `def` (gate level) with every net watched, hashing each change. */
function traced(d: FlatDesign): { sim: GateSim; f: Fnv; count: () => number } {
  const sim = new GateSim(d);
  const f = new Fnv();
  let events = 0;
  sim.onTrace = (net, v, t) => { events++; f.n(net); f.n(v); f.n(t); };
  sim.watch(Array.from({ length: d.netCount }, (_, i) => i));
  return { sim, f, count: () => events };
}

const flat = (def: ComponentDef) => flatten(def, { mode: 'gate' });

function print(d: FlatDesign, drive: (sim: GateSim) => void): Print {
  const { sim, f, count } = traced(d);
  let unstable = false;
  const s = sim.settle.bind(sim);
  sim.settle = () => { s(); unstable ||= sim.unstable; };
  drive(sim);
  return { hash: f.hex, events: count(), evaluations: sim.evaluations, time: sim.time, unstable };
}

const cycles = (n: number) => (sim: GateSim) => {
  for (let i = 0; i < n; i++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
};

/** d changes `o` delays before (o < 0) or after the rising edge, for o in −6 … 6, toggling each time. */
const sweep = (sim: GateSim) => {
  sim.setInput('clk', 0); sim.settle();
  let d = 0;
  for (let o = -6; o <= 6; o++) {
    d ^= 1;
    const base = sim.time;
    if (o < 0) { sim.setInput('d', d); sim.runUntil(base - o); sim.setInput('clk', 1); }
    else { sim.setInput('clk', 1); sim.runUntil(base + o); sim.setInput('d', d); }
    sim.runUntil(sim.time + 20);
    sim.setInput('clk', 0); sim.settle();
  }
};

/** The engine's trace on every case. */
export function traceFingerprints(): Record<string, Print> {
  const words = assemble(PROGRAM).words;
  const out: Record<string, Print> = {};
  out.cpu = print(flat(singleCycleCpu(words)), cycles(300));
  out.pipe = print(flat(pipelinedCpu(words)), cycles(300));
  out.dff = print(flat(DFF), sweep);
  out.dff6 = print(flat(DFF_EDGE6), sweep);
  out.dffr = print(flat(DFF_R), (sim) => { sim.setInput('rst_n', 1); sweep(sim); sim.setInput('rst_n', 0); sim.settle(); });
  out.skew = print(flat(skewPair(2)), sweep);
  out.sr = print(flat(SR_LATCH), (sim) => {
    for (const [s, r] of [[0, 1], [1, 1], [1, 0], [1, 1], [0, 0], [1, 1]] as const) { sim.setInput('s_n', s); sim.setInput('r_n', r); sim.settle(); }
  });
  out.ring = print(flat(ringOsc(5)), (sim) => { sim.setInput('en', 0); sim.settle(); sim.setInput('en', 1); sim.runUntil(sim.time + 200); });
  out.divider = print(flat(clockDivider(4)), (sim) => { sim.setInput('rst_n', 0); sim.settle(); sim.setInput('rst_n', 1); cycles(40)(sim); });
  // a slow fault (+5 delays) on the 8-bit adder's middle carry: the engine's per-leaf delay path
  const add = flat(rca(8));
  const mid = add.leaves.findIndex((l) => l.node.path.join('.').startsWith('fa3'));
  const slowed = applyFaults(add, [{ kind: 'slow', nets: [add.leaves[mid].outputs[0][0]], delay: 5 }]).design;
  out.slow = print(slowed, (sim) => {
    let x = 0x12345;
    for (let i = 0; i < 60; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      sim.setInput('a', x & 255); sim.setInput('b', (x >>> 8) & 255); sim.setInput('cin', (x >>> 16) & 1); sim.settle();
    }
  });
  return out;
}

/** The times a learner steps through: stepEdge on the CPU's edges (no period, then a 15-delay period), Step on the adder. */
export function stepFingerprints(): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const cpu = new GateSim(flat(singleCycleCpu(assemble(PROGRAM).words)));
  for (const [name, period] of [['edge', null], ['period', 15]] as const) {
    const times: number[] = [];
    for (let k = 0; k < 3; k++) {
      const e = riseEdge(cpu, 'clk', period === null ? null : cpu.time + period);
      times.push(cpu.time);
      while (stepEdge(cpu, e)) times.push(cpu.time);
      times.push(cpu.time);
      completeEdge(cpu, e);
      cpu.setInput('clk', 0); cpu.settle();
      times.push(cpu.time);
    }
    out[name] = times;
  }
  const add = new GateSim(flat(rca(8)));
  const times: number[] = [];
  for (const [a, b] of [[255, 1], [0, 0], [170, 85], [1, 255]]) {
    add.setInput('a', a); add.setInput('b', b);
    while (add.step()) times.push(add.time);
    times.push(-1);
  }
  out.step = times;
  return out;
}
