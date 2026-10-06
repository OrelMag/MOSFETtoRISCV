// Shared helpers for the floating-point tests: a CI-friendly operand set for the 8-bit formats
// (FPU_EXHAUSTIVE=1 restores every pair), and a bit-parallel spec check that yields to the test
// runner regularly so a long loop never starves its RPC.

import { expect } from 'vitest';
import { BitSim, LANES } from '../src/sim/bitsim';
import type { FpFormat } from '../src/sim/fpref';
import { flatten } from '../src/sim/flatten';
import { type ComponentDef, inPorts, outPorts } from '../src/sim/types';

// Every pair of every 8-bit format in every mode is slow on a CI runner; FPU_EXHAUSTIVE=1 restores it.
export const EXHAUSTIVE = typeof process !== 'undefined' && process.env.FPU_EXHAUSTIVE === '1';

/** Let the test runner breathe (call every few thousand iterations of a long loop). */
export const breathe = () => new Promise((res) => (typeof setImmediate === 'function' ? setImmediate(res) : setTimeout(res)));

/**
 * Operand pairs: all pairs for tiny formats (or when exhaustive); otherwise every boundary value
 * (zeros, subnormals, the smallest and largest normals, infinities, NaNs) against every operand,
 * plus a random sample.
 */
export function operandPairs(f: FpFormat, sample = 3000): [number, number][] {
  const N = 1 + f.E + f.M, all = [...Array(2 ** N).keys()];
  if (EXHAUSTIVE || N <= 6) return all.flatMap((a) => all.map((b): [number, number] => [a, b]));
  const field = (x: number) => Math.floor(x / 2 ** f.M) % 2 ** f.E;
  const frac = (x: number) => x % 2 ** f.M, top = 2 ** f.E - 1, ones = 2 ** f.M - 1;
  const edge = all.filter((x) => field(x) === 0 || field(x) === top || ((field(x) === 1 || field(x) === top - 1) && (frac(x) === 0 || frac(x) === ones)));
  const pairs = edge.flatMap((a) => all.map((b): [number, number] => [a, b]));
  let seed = 17;
  for (let k = 0; k < sample; k++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    pairs.push([(seed >>> 8) % 2 ** N, (seed >>> 20) % 2 ** N]);
  }
  return pairs;
}
export const isExhaustive = (f: FpFormat) => EXHAUSTIVE || 1 + f.E + f.M <= 6;

/**
 * Stream operand vectors (packed per input port) through the gate-level structure, 32 per pass,
 * and compare every output with `want` (default: the component's spec).
 */
export async function check(def: ComponentDef, vectors: number[][] | { count: number; gen: (i: number) => number[] }, want: (v: number[]) => number[] = def.spec!): Promise<void> {
  const sim = new BitSim(flatten(def));
  const ins = inPorts(def).map((p) => p.name), outs = outPorts(def).map((p) => p.name);
  const count = Array.isArray(vectors) ? vectors.length : vectors.count;
  const gen = Array.isArray(vectors) ? (i: number) => vectors[i] : vectors.gen;
  for (let at = 0, batches = 0; at < count; at += LANES, batches++) {
    if (batches % 64 === 63) await breathe();
    const batch: number[][] = [];
    for (let i = at; i < Math.min(count, at + LANES); i++) batch.push(gen(i));
    ins.forEach((p, k) => sim.setInput(p, batch.map((v) => v[k])));
    sim.settle();
    const got = outs.map((p) => sim.get(p, batch.length));
    batch.forEach((v, l) => {
      const w = want(v);
      if (got.some((g, k) => g[l] !== w[k])) expect(got.map((g) => g[l]), `${def.id}(${v.map((x) => x.toString(16))})`).toEqual(w);
    });
  }
}
