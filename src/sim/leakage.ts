// Static power from the simulation's own values (the Power chapter): every NAND leaks through whichever of its
// transistors are off with a voltage across them, and which those are depends on its inputs right now.
//   all inputs 1: the output is 0, the parallel PMOS are all off with VDD across each: n off currents;
//   some input 0: the output is 1, the series NMOS chain holds VDD; its off transistors (one per 0 input) are in series,
//                 so the chain leaks seriesOff(k) (phys/cmosv.ts: the nodes between them settle at equal currents).
// An X input counts as both values, half each. Leaves that are not NANDs (a behavioural ROM or memory, an external
// part) are left out and counted. Currents per transistor from phys/cmosv.ts, whose width is the book's NAND's.

import { offCurrent, type Process, seriesOff, V_NOM } from '../phys/cmosv';
import type { FlatDesign, HierNode } from './flatten';
import type { Bit } from './types';

export interface LeakShare { name: string; child?: HierNode; amps: number }

export interface LeakReport {
  /** Supply current that leaks (A) and the power it takes (W) at v. */
  amps: number;
  watts: number;
  v: number;
  /** NANDs counted, by state: all inputs 1 / one input 0 / two or more 0 (the stack). */
  nands: number;
  allOne: number;
  oneZero: number;
  stacked: number;
  /** Leaves that are not NANDs, not counted. */
  skipped: number;
  /** By the child of `node` that holds each NAND. */
  byChild: LeakShare[];
}

/** Leak (A) of an n-input NAND with `zeros` inputs at 0 at supply v. */
export function nandLeak(p: Process, v: number, n: number, zeros: number): number {
  return zeros === 0 ? n * offCurrent(p, v) : seriesOff(p, v, zeros);
}

/** The leakage of the NANDs under `node` of a simulation's design at its current values. */
export function leakageOf(sim: { get(net: number): Bit }, design: FlatDesign, p: Process, v = V_NOM, node: HierNode = design.root): LeakReport {
  const k = node.path.length, at = node.path;
  const by = new Map<string, number>();
  const cache = new Map<string, number>();
  const leak = (n: number, z: number) => {
    const key = `${n}:${z}`;
    let a = cache.get(key);
    if (a === undefined) cache.set(key, (a = nandLeak(p, v, n, z)));
    return a;
  };
  let amps = 0, nands = 0, allOne = 0, oneZero = 0, stacked = 0, skipped = 0;
  for (const l of design.leaves) {
    const path = l.node.path;
    if (path.length < k || at.some((x, j) => path[j] !== x)) continue;
    if (l.def.prim !== 'nand') { skipped++; continue; }
    const ins = l.inputs.flat();
    let zeros = 0, xs = 0;
    for (const f of ins) { const b = sim.get(f); if (b === 0) zeros++; else if (b !== 1) xs++; }
    // an X is either value: average over the 2^xs cases (binomially, by how many of them are 0)
    let a = 0;
    if (!xs) a = leak(ins.length, zeros);
    else { let c = 1; for (let j = 0; j <= xs; j++) { a += c * leak(ins.length, zeros + j); c = (c * (xs - j)) / (j + 1); } a /= 2 ** xs; }
    nands++;
    if (!xs) { if (zeros === 0) allOne++; else if (zeros === 1) oneZero++; else stacked++; }
    amps += a;
    const c = path.length > k ? path[k] : '';
    by.set(c, (by.get(c) ?? 0) + a);
  }
  const byChild = [...by].map(([name, a]): LeakShare => ({ name: name || node.name || 'top', child: name ? node.children?.get(name) : node, amps: a })).sort((x, y) => y.amps - x.amps);
  return { amps, watts: amps * v, v, nands, allOne, oneZero, stacked, skipped, byChild };
}
