// Capacitance per net from its fan-out, shared by the power estimate (power.ts) and the load-dependent
// delay (delay.ts). Illustrative 28 nm-class values, not extracted from a layout.

import type { FlatDesign } from './flatten';

/** One NAND input: the gates of one NMOS and one PMOS (fF). */
export const FF_INPUT = 0.5;
/** The drains a NAND output itself carries (two PMOS in parallel, the top NMOS), or a behavioural output's (fF). */
export const FF_DRIVER = 0.5;
/** Wire per branch of a net (fF): a wire-load model, longer nets for larger fan-outs. */
export const FF_WIRE = 0.3;

const capCache = new WeakMap<FlatDesign, Float64Array>();

/** Capacitance of every net (fF): inputs it drives, its driver, a wire per branch. Root inputs have no driver here. */
export function netCaps(d: FlatDesign): Float64Array {
  const hit = capCache.get(d);
  if (hit) return hit;
  const c = new Float64Array(d.netCount);
  for (const l of d.leaves) {
    for (const p of l.inputs) for (const net of p) c[net] += FF_INPUT + FF_WIRE;
    for (const p of l.outputs) for (const net of p) c[net] += FF_DRIVER;
  }
  capCache.set(d, c);
  return c;
}

/** The leaf driving each net (−1: a root input, or nothing). */
const driverCache = new WeakMap<FlatDesign, Int32Array>();
export function driverOf(d: FlatDesign): Int32Array {
  const hit = driverCache.get(d);
  if (hit) return hit;
  const dr = new Int32Array(d.netCount).fill(-1);
  d.leaves.forEach((l, li) => { for (const p of l.outputs) for (const net of p) dr[net] = li; });
  driverCache.set(d, dr);
  return dr;
}
