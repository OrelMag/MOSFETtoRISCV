// Grading: a passing solution earns one star, two when every graded metric is within 1.5 × par,
// three when every one is at or under par. Lower is better on every metric. No DOM.

import type { Score } from '../editor/challenges';
import type { Metric, Par } from './types';

/** A result on the metrics a level may be graded on (absent: not measured). */
export type Measured = Partial<Record<Metric, number>>;

export const METRIC: Record<Metric, { label: string; unit: string; hint: string }> = {
  nand: { label: 'NANDs', unit: 'NAND', hint: 'NAND gates in the whole hierarchy (area)' },
  transistors: { label: 'Transistors', unit: 'transistors', hint: 'Transistors in the whole hierarchy' },
  depth: { label: 'Depth', unit: 'NAND delays', hint: 'Longest input → output path, in NAND delays (speed)' },
  period: { label: 'Clock period', unit: 'NAND delays', hint: 'clk-to-q + longest logic path + setup (static timing)' },
  cycles: { label: 'Cycles', unit: 'cycles', hint: 'Clock cycles to run the tests' },
  size: { label: 'Size', unit: 'words', hint: 'Program size in instruction words' },
  mistakes: { label: 'Mistakes', unit: 'mistakes', hint: 'Wrong answers and answers shown, before the drill was complete' },
  relays: { label: 'Relays', unit: 'relays', hint: 'Relays in the whole hierarchy (a coil and its contacts each)' },
  tubes: { label: 'Tube sections', unit: 'sections', hint: 'Triode and diode sections (a 6SN7 bulb holds two triodes, a 6AL5 two diodes)' },
  steps: { label: 'Relay steps', unit: 'steps', hint: 'Most relay steps (about 8 ms each) one input change takes to come to rest' },
  idle: { label: 'Idle lanes', unit: '%', hint: 'Lane-steps with the lane switched off, as a share of all lane-steps (100 % − lane utilization), mean over the tests' },
};

/** A challenge score as measured metrics. */
export function measured(s: Score): Measured {
  const m: Measured = { nand: s.nand, transistors: s.transistors };
  if (s.depth !== null) m.depth = s.depth;
  if (s.period !== undefined && s.period !== null) m.period = s.period;
  if (s.cycles !== undefined) m.cycles = s.cycles;
  if (s.relays !== undefined) m.relays = s.relays;
  if (s.tubes !== undefined) m.tubes = s.tubes;
  if (s.steps !== undefined) m.steps = s.steps;
  return m;
}

/** Stars for a passing result: 1, 2 or 3. A metric par grades but the result lacks counts as over. */
export function stars(m: Measured, par: Par | undefined): 1 | 2 | 3 {
  const keys = Object.keys(par ?? {}) as Metric[];
  if (!keys.length) return 3;
  let worst = 0;
  for (const k of keys) {
    const v = m[k], p = par![k]!;
    worst = Math.max(worst, v === undefined ? Infinity : p > 0 ? v / p : v > 0 ? Infinity : 0);
  }
  return worst <= 1 ? 3 : worst <= 1.5 ? 2 : 1;
}

/** Keep the better of two results: more stars, then lower on the graded metrics in order. */
export function better(a: { stars: number; m: Measured }, b: { stars: number; m: Measured } | undefined, par: Par | undefined): boolean {
  if (!b) return true;
  if (a.stars !== b.stars) return a.stars > b.stars;
  for (const k of Object.keys(par ?? {}) as Metric[]) {
    const x = a.m[k] ?? Infinity, y = b.m[k] ?? Infinity;
    if (x !== y) return x < y;
  }
  return false;
}

/** The metrics the after-pass card draws area bars in. */
export type AreaUnit = 'nand' | 'transistors' | 'relays' | 'tubes';

/**
 * The after-pass card's area bars: yours, par (when it differs from yours) and the level case's alternatives, in the
 * level's area metric: relays or tube sections on a relay / tube level, transistors on a transistor level (it has no
 * NANDs), else NANDs. Null when there is nothing to compare: a single bar, or every value 0.
 */
export function areaBars(m: Measured, par: Par, alts: readonly { name: string; cost: Partial<Record<AreaUnit, number>> }[]): { unit: AreaUnit; bars: [string, number, boolean][] } | null {
  const unit: AreaUnit = par.relays !== undefined ? 'relays' : par.tubes !== undefined ? 'tubes'
    : par.transistors !== undefined && par.nand === undefined ? 'transistors' : 'nand';
  const bars: [string, number, boolean][] = [];
  if (m[unit] !== undefined) bars.push(['Yours', m[unit]!, true]);
  if (par[unit] !== undefined && par[unit] !== m[unit]) bars.push(['Par', par[unit]!, false]);
  for (const a of alts) { const v = a.cost[unit]; if (v !== undefined) bars.push([a.name, v, false]); }
  return bars.length > 1 && bars.some((b) => b[1] > 0) ? { unit, bars } : null;
}
