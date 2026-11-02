// Tier 4's design brief (DOM-free): "the cheapest core that runs the benchmarks". Any RV16 core on the core bench's pins that
// makes the golden model's register writes and stores on a fixed workload is a point on a cost / speed chart: cost = NANDs
// (the cores hold no program memory), speed = total time = cycles × clock period over the workload. Three reference cores
// (single-cycle, multicycle, pipelined) are measured and checked in (briefrefs.json: scripts/briefrefs.ts --write, pinned
// by tests/brief.test.ts), so the chart is drawn without running them. Grades: ★ every program right; ★★ no reference is
// both at least as cheap and at least as fast; ★★★ cheaper and faster than one of them.

import type { ComponentDef } from '../sim/types';
import { rv16Core } from '../lib/rv16/cpu';
import { RV16_MULTI } from '../lib/rv16/multi';
import { rv16Pipe } from '../lib/rv16/pipe';
import { stats } from '../sim/stats';
import { corePeriod, type CoreSpec, runCore } from './corecheck';
import { coreTests } from './coretests';
import REFS from './briefrefs.json';

/** The programs of the workload: the core bench's full set (arithmetic, memory, branches, calls, gcd, random code). */
export const briefTests = () => coreTests(3);

/** Cycles allowed: generous (a multicycle core needs up to 4 per instruction), the time is what is graded. */
export const BRIEF_BUDGET = { cpi: 8, extra: 16 };

export const briefSpec = (): CoreSpec => ({ rv16i: true, tests: briefTests, budget: BRIEF_BUDGET });

export interface BriefPoint { nand: number; period: number; cycles: number }

export interface BriefRef { id: string; name: string; note: string; def: () => ComponentDef }

export const BRIEF_REFS: BriefRef[] = [
  { id: 'single', name: 'single-cycle', note: 'Core III: one instruction per cycle, a long period', def: () => rv16Core(true) },
  { id: 'multi', name: 'multicycle', note: 'a state machine: F, E, (M,) W; a short period, 3 or 4 cycles per instruction', def: () => RV16_MULTI },
  { id: 'pipe', name: 'pipelined', note: 'five stages with forwarding, the load-use stall and the branch flush', def: () => rv16Pipe({ fwd: true, stall: true, flush: true }) },
];

/** Total time over the workload, in gate delays. */
export const timeOf = (p: { period: number; cycles: number }): number => p.period * p.cycles;

export interface BriefRefPoint extends BriefPoint { id: string; name: string; time: number }

/** The references with their checked-in numbers. */
export function briefRefs(): BriefRefPoint[] {
  const table = REFS as Record<string, BriefPoint>;
  return BRIEF_REFS.map((r) => ({ id: r.id, name: r.name, ...table[r.id], time: timeOf(table[r.id]) }));
}

/** Measure a core on the workload (the slow part: a full check), or null when it fails. */
export function measureCore(def: ComponentDef): BriefPoint | null {
  const r = runCore(def, 'gate', briefSpec());
  const period = corePeriod(def);
  if (r.failures.length || period === null || r.cycles === undefined) return null;
  return { nand: stats(def).nands, period, cycles: r.cycles };
}

/** The references on the front: no other is both at most as costly and at most as slow (and better in one). Ordered by cost. */
export function briefFront<T extends { nand: number; time: number }>(refs: T[]): T[] {
  return refs.filter((r) => !refs.some((q) => q !== r && q.nand <= r.nand && q.time <= r.time && (q.nand < r.nand || q.time < r.time))).sort((a, b) => a.nand - b.nand);
}

export type BriefStars = 1 | 2 | 3;

/** ★ it passes; ★★ no reference is at least as cheap and at least as fast; ★★★ it is cheaper and faster than one of them. */
export function briefStars(p: BriefPoint, refs: { nand: number; time: number }[] = briefRefs()): BriefStars {
  const t = timeOf(p);
  if (refs.some((r) => r.nand <= p.nand && r.time <= t)) return 1;
  return refs.some((r) => p.nand < r.nand && t < r.time) ? 3 : 2;
}
