// Setup, hold and clock-to-q read off a flip-flop circuit (DOM-free): d is flipped t gate delays before / after the
// rising clock edge, on GateSim, for every t in a range, and the value q settles to says which side of the edge caught
// it. The window between "new value captured" and "old value kept" is the aperture; its edges are setup and hold.

import { flatten } from './flatten';
import { GateSim } from './gatesim';
import type { ComponentDef } from './types';

export type Capture = 'old' | 'new' | 'x';

export interface EdgeSweep {
  /** Offsets of d's change from the clock edge in delays (negative: before it). */
  offsets: number[];
  /** What q settled to for each offset: the value d had before the change, the value after, or neither (X / oscillation). */
  outcome: Capture[];
  /** d must change at least this many delays before the edge to be captured (larger: more setup). */
  setup: number;
  /** d must stay put this many delays after the edge (0 or less: no hold requirement). */
  hold: number;
  /** Delays from the edge to q's change, for q rising / falling (d stable). */
  cqRise: number;
  cqFall: number;
}


/** One trial: d goes from `from` to `to` at offset t from the clock's rising edge. */
export function captureAt(def: ComponentDef, from: 0 | 1, to: 0 | 1, t: number, pins = { d: 'd', clk: 'clk', q: 'q' }): Capture {
  const fd = flatten(def, { mode: 'gate' });
  const sim = new GateSim(fd);
  sim.setInput(pins.d, from);
  sim.setInput(pins.clk, 0);
  sim.reset('zero');
  sim.setInput(pins.d, from);
  sim.setInput(pins.clk, 0);
  // load `from` into q through a first edge, so the trial starts from q = from, clock low
  sim.settle();
  sim.setInput(pins.clk, 1);
  sim.settle();
  sim.setInput(pins.clk, 0);
  sim.settle();
  const t0 = sim.time;
  if (t < 0) {
    sim.setInput(pins.d, to);
    sim.runUntil(t0 - t);
    sim.setInput(pins.clk, 1);
  } else {
    sim.setInput(pins.clk, 1);
    sim.runUntil(t0 + t);
    sim.setInput(pins.d, to);
  }
  sim.settle();
  if (sim.unstable) return 'x';
  const q = sim.getBits(fd.root.ports[pins.q])[0];
  return q === to ? 'new' : q === from ? 'old' : 'x';
}

/** Clock-to-q: delays from the edge until q settles on its new value (d stable). */
export function clkToQ(def: ComponentDef, to: 0 | 1, pins = { d: 'd', clk: 'clk', q: 'q' }): number {
  const fd = flatten(def, { mode: 'gate' });
  const sim = new GateSim(fd);
  const from = (1 - to) as 0 | 1;
  sim.setInput(pins.d, from); sim.setInput(pins.clk, 0); sim.reset('zero');
  sim.setInput(pins.d, from); sim.settle();
  sim.setInput(pins.clk, 1); sim.settle(); sim.setInput(pins.clk, 0); sim.settle();
  sim.setInput(pins.d, to); sim.settle();
  const q = fd.root.ports[pins.q][0];
  let last = -1;
  sim.onTrace = (net, _b, time) => { if (net === q) last = time; };
  sim.watch([q]);
  const t0 = sim.time;
  sim.setInput(pins.clk, 1);
  sim.settle();
  return last < 0 ? -1 : last - t0;
}

/** Sweep d's change over the offsets lo … hi for a rising (0 → 1) or falling (1 → 0) d. */
export function sweepEdge(def: ComponentDef, dir: 'rise' | 'fall', lo = -10, hi = 10, pins = { d: 'd', clk: 'clk', q: 'q' }): EdgeSweep {
  const from = dir === 'rise' ? 0 : 1, to = (1 - from) as 0 | 1;
  const offsets: number[] = [], outcome: Capture[] = [];
  for (let t = lo; t <= hi; t++) { offsets.push(t); outcome.push(captureAt(def, from, to, t, pins)); }
  let i = 0;
  while (i < offsets.length && outcome[i] === 'new') i++;
  const setup = i === 0 ? -lo + 1 : -offsets[i - 1];
  let j = offsets.length;
  while (j > 0 && outcome[j - 1] === 'old') j--;
  return { offsets, outcome, setup, hold: j === offsets.length ? hi + 1 : offsets[j], cqRise: clkToQ(def, 1, pins), cqFall: clkToQ(def, 0, pins) };
}

/** q's changes for one trial, as [delays from the edge, value] pairs, up to `span` delays after the edge (a race never ends). */
export function qTrace(def: ComponentDef, from: 0 | 1, to: 0 | 1, t: number, span = 14, pins = { d: 'd', clk: 'clk', q: 'q' }): { start: number; changes: [number, 0 | 1][] } {
  const fd = flatten(def, { mode: 'gate' });
  const sim = new GateSim(fd);
  sim.setInput(pins.d, from); sim.setInput(pins.clk, 0); sim.reset('zero');
  sim.setInput(pins.d, from); sim.settle();
  sim.setInput(pins.clk, 1); sim.settle(); sim.setInput(pins.clk, 0); sim.settle();
  const q = fd.root.ports[pins.q][0];
  const t0 = sim.time, changes: [number, 0 | 1][] = [];
  const start = sim.get(q) === 1 ? 1 : 0;
  const edge = t0 + Math.max(0, -t);
  sim.onTrace = (net, b, time) => { if (net === q) changes.push([time - edge, b === 1 ? 1 : 0]); };
  sim.watch([q]);
  if (t < 0) { sim.setInput(pins.d, to); sim.runUntil(edge); sim.setInput(pins.clk, 1); }
  else { sim.setInput(pins.clk, 1); sim.runUntil(t0 + t); sim.setInput(pins.d, to); }
  sim.runUntil(edge + span);
  return { start, changes };
}
