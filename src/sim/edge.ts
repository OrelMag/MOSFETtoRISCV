// A rising clock edge played one gate delay at a time (slow mode). Same semantics as a whole
// cycle: with no fixed period the high phase lasts until the logic is quiet; with a period it
// ends at `end` whether the logic is done or not.

import type { Sim } from './sim';

export interface Edge {
  clk: string;
  /** Time of the rising edge. */
  start: number;
  /** End of the high phase (fixed period), or null: wait until the logic has settled. */
  end: number | null;
}

/** Edges longer than this are oscillating: hand them to settle(), which resolves races. */
const LIMIT = 10000;

/** Raise the clock; nothing propagates until stepEdge / completeEdge. */
export function riseEdge(sim: Sim, clk: string, end: number | null = null): Edge {
  sim.setInput(clk, 1);
  return { clk, start: sim.time, end };
}

export function edgeDone(sim: Sim, e: Edge): boolean {
  return e.end === null ? !sim.busy() : sim.time >= e.end;
}

/** Advance one gate delay. Returns true while the edge is still propagating. */
export function stepEdge(sim: Sim, e: Edge): boolean {
  if (edgeDone(sim, e)) return false;
  if (!sim.runUntil) sim.settle();
  else if (e.end === null && sim.time - e.start >= LIMIT) sim.settle();
  else sim.runUntil(sim.time + 1);
  return !edgeDone(sim, e);
}

/** Finish the high phase at once. */
export function completeEdge(sim: Sim, e: Edge): void {
  if (e.end === null || !sim.runUntil) sim.settle();
  else sim.runUntil(e.end);
}
