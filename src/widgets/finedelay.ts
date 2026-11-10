// What the chapters say about load-dependent delay (docs/PLAN-FINEDELAY.md, stage 5), DOM-free: each measurement is a
// function run on the gates, and its result a constant the prose quotes (FINE), pinned by tests/finedelay-chapters.test.ts,
// so the chapter modules need no simulation at load. Under 'load' every NAND is timed by what it drives, in tenths of a unit.

import { rca } from '../lib/combinational';
import { MUX2 } from '../lib/gates';
import { skewPair } from '../lib/seqdeep';
import { nandDelay } from '../sim/delay';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { FF_INPUT, FF_WIRE } from '../sim/netcap';
import { energyFj, PowerMeter } from '../sim/power';

type Model = 'unit' | 'load';

/** The adders chapter's sequence: 200 seeded random (a, b, cin) for the 8-bit ripple adder. */
export function rippleVectors(n = 200, seed = 7): number[][] {
  let x = seed;
  const r = () => (x = (x * 1103515245 + 12345) >>> 0) >>> 8;
  return Array.from({ length: n }, () => [r() & 255, r() & 255, r() & 1]);
}

export interface Glitches {
  /** Per input change: every 0 ↔ 1 transition, the settled ones (the net ends on another value), the rest (glitches). */
  toggles: number; settled: number; glitches: number;
  /** ½ C V² per change, all toggles and the settled ones only (fJ). */
  energy: number; settledEnergy: number;
}

/** The ripple adder over rippleVectors(), each applied once the last has settled: toggles and energy per change. */
export function rippleGlitches(model: Model): Glitches {
  const vs = rippleVectors();
  const sim = new GateSim(flatten(rca(8), { mode: 'gate' }), { delay: model });
  const apply = (v: number[]) => { sim.setInput('a', v[0]); sim.setInput('b', v[1]); sim.setInput('cin', v[2]); };
  apply(vs[0]); sim.settle();
  const pm = new PowerMeter(sim);
  for (let i = 1; i < vs.length; i++) { apply(vs[i]); sim.settle(); pm.mark(); }
  const t = pm.totals(), n = vs.length - 1;
  let settled = 0;
  for (let i = 0; i < sim.design.netCount; i++) settled += pm.settled(i);
  return { toggles: t.toggles / n, settled: settled / n, glitches: (t.toggles - settled) / n, energy: energyFj(t.switched / n), settledEnergy: energyFj(t.functional / n) };
}

/** The skew pair after one rising edge with d = 1: when ff2's clock arrives after clk, when q1 changes, and what q2 settles to. */
export function skewTimes(k: number, model: Model): { late: number; cq: number; q2: 0 | 1 | 'x' } {
  const d = flatten(skewPair(k), { mode: 'gate' });
  const sim = new GateSim(d, { delay: model });
  sim.setInput('d', 1); sim.setInput('clk', 0); sim.reset('zero'); sim.setInput('d', 1); sim.setInput('clk', 0); sim.settle();
  const q1 = d.root.ports.q1[0], q2 = d.root.ports.q2[0], c2 = d.root.children!.get('ff2')!.ports.clk[0];
  let late = 0, cq = -1;
  const t0 = sim.time;
  sim.onTrace = (net, _b, t) => { if (net === c2) late = t - t0; else if (net === q1 && cq < 0) cq = t - t0; };
  sim.watch([q1, c2]);
  sim.setInput('clk', 1);
  sim.settle();
  const v = sim.get(q2);
  return { late: tenth(late), cq: tenth(cq), q2: sim.unstable ? 'x' : v === 1 ? 1 : v === 0 ? 0 : 'x' };
}

const tenth = (x: number) => Math.round(x * 10) / 10;

/**
 * The 2:1 mux's static-1 hazard when s falls with a = b = 1: y dips for d(¬s) + d(the a gate) − d(the b gate). In the drawn
 * mux each gate drives one input, so all are one unit and the dip is one unit wide under either model. If one inverter made
 * ¬s for n muxes (a bus sharing it), it would drive n inputs: the dip is that inverter's delay (load model, in tenths).
 */
export const sharedNotWidth = (n: number) => tenth(nandDelay(n * (FF_INPUT + FF_WIRE)));

/** The MUX2's dip on y when s falls with a = b = 1, measured: how long y sits at 0. */
export function muxDip(model: Model): number {
  const d = flatten(MUX2, { mode: 'gate' });
  const sim = new GateSim(d, { delay: model });
  sim.setInput('a', 1); sim.setInput('b', 1); sim.setInput('s', 1); sim.settle();
  const y = d.root.ports.y[0];
  let fell = -1, width = 0;
  sim.onTrace = (net, b, t) => { if (net !== y) return; if (b === 0) fell = t; else if (fell >= 0) width = t - fell; };
  sim.watch([y]);
  sim.setInput('s', 0); sim.settle();
  return tenth(width);
}

/** The numbers the chapters quote (each the function above, or measureClasses / analyzeTiming for the CPU), pinned by tests. */
export const FINE = {
  ripple: {
    unit: { toggles: 38.11, settled: 25.72, glitches: 12.39, energy: 23.72, settledEnergy: 17.04 },
    load: { toggles: 40.23, settled: 25.72, glitches: 14.51, energy: 24.96, settledEnergy: 17.04 },
  },
  /** skewTimes(k) for k = 0 … 3. */
  skew: {
    unit: [{ late: 0, cq: 2, q2: 0 }, { late: 2, cq: 2, q2: 'x' }, { late: 4, cq: 2, q2: 1 }, { late: 6, cq: 2, q2: 1 }],
    load: [{ late: 0, cq: 3.6, q2: 0 }, { late: 4, cq: 3.6, q2: 'x' }, { late: 7, cq: 3.6, q2: 1 }, { late: 10, cq: 3.6, q2: 1 }],
  },
  /** muxDip(model). */
  muxDip: { unit: 1, load: 1 },
  /** sharedNotWidth(n). */
  muxShared: { 1: 1, 8: 2.8, 32: 3.9 } as Record<number, number>,
  /**
   * Chapter 8's sweeps (widgets/edgesweep.ts sweepOf, offsets −8 … 8): setup, hold, clock-to-q rising / falling, and the
   * band of offsets whose run never settles (first and last; [] for none).
   */
  sweep: {
    ms: {
      rise: { unit: { setup: 1, hold: 1, cq: [2, 3], band: [0, 0] }, load: { setup: 2, hold: 1.5, cq: [2.5, 3.5], band: [-1.9, 1.4] } },
      fall: { unit: { setup: 2, hold: 0, cq: [2, 3], band: [-1, -1] }, load: { setup: 3, hold: 0.5, cq: [2.5, 3.5], band: [-2.9, 0.4] } },
    },
    e6: {
      rise: { unit: { setup: -1, hold: 3, cq: [2, 5], band: [2, 2] }, load: { setup: -3.5, hold: 4, cq: [3.5, 7], band: [3.6, 3.9] } },
      fall: { unit: { setup: 2, hold: 0, cq: [2, 5], band: [-1, -1] }, load: { setup: 2.5, hold: 0.5, cq: [3.5, 7], band: [-2.4, 0.4] } },
    },
  },
};

/** The numbers FINE.sweep keeps, read off a sweep. */
export function sweepNumbers(sw: { setup: number; hold: number; cqRise: number; cqFall: number; offsets: number[]; outcome: string[] }) {
  const xs = sw.offsets.filter((_, i) => sw.outcome[i] === 'x');
  return { setup: sw.setup, hold: sw.hold, cq: [sw.cqRise, sw.cqFall], band: xs.length ? [xs[0], xs[xs.length - 1]] : [] };
}
