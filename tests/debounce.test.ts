import { describe, expect, it } from 'vitest';
import { BUTTON3, debouncer, debounceSamples } from '../src/lib/debounce';
import { simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';
import type { Sim } from '../src/sim/sim';

const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const out = (sim: Sim, p: string) => pack(sim.getBits(sim.design.root.ports[p]));
const tick = (sim: Sim) => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };

/** The rule in software: count while d ≠ q, clear when they agree, flip at 2^n − 1. */
function model(n: number, ds: number[]): { q: number; count: number }[] {
  let q = 0, c = 0;
  return ds.map((d) => {
    if (d === q) c = 0;
    else if (c === 2 ** n - 1) { q = d; c = 0; } else c++;
    return { q, count: c };
  });
}

describe('the counter debouncer (lib/debounce.ts)', () => {
  for (const n of [2, 3, 4]) {
    it(`${n} bits: equal to the rule on random input, every cycle`, () => {
      const sim = simulate(debouncer(n));
      sim.reset('zero');
      const r = rng(7 + n);
      // slow random input (runs of 1…2^(n+1) samples) so that both bounces and settled levels occur
      const ds: number[] = [];
      let lvl = 0;
      while (ds.length < 600) { const run = 1 + Math.floor(r() * 2 ** (n + 1)); for (let i = 0; i < run; i++) ds.push(lvl); lvl ^= 1; }
      const want = model(n, ds);
      ds.forEach((d, i) => {
        sim.setInput('d', d); sim.settle(); tick(sim);
        expect([out(sim, 'q'), out(sim, 'count')], `n=${n} cycle ${i}`).toEqual([want[i].q, want[i].count]);
      });
    });
  }

  it('a bounce shorter than 2^n samples never reaches q; a level held for 2^n samples does, on the next edge', () => {
    const n = 3, N = debounceSamples(n);
    const sim = simulate(debouncer(n));
    sim.reset('zero');
    const step = (d: number) => { sim.setInput('d', d); sim.settle(); tick(sim); return out(sim, 'q'); };
    // a bounce: up for N − 1 samples, down, up … never long enough
    for (let k = 0; k < 5; k++) { for (let i = 0; i < N - 1; i++) expect(step(1)).toBe(0); expect(step(0)).toBe(0); }
    // held: q follows at the edge that takes the N-th sample
    for (let i = 0; i < N - 1; i++) expect(step(1)).toBe(0);
    expect(step(1)).toBe(1);
    expect(step(1)).toBe(1);
  });

  it('the button input stage: two cycles of synchronizer on top, bounces swallowed', () => {
    const sim = simulate(BUTTON3);
    sim.reset('zero');
    const step = (raw: number) => { sim.setInput('raw', raw); sim.settle(); tick(sim); return [out(sim, 'sync'), out(sim, 'q')]; };
    expect(step(1)).toEqual([0, 0]);
    expect(step(1)).toEqual([1, 0]);
    // bounce: synchronized level follows raw two cycles late, q ignores it
    for (const raw of [0, 1, 0, 1, 1, 0, 1]) expect(step(raw)[1]).toBe(0);
    let q = 0;
    for (let i = 0; i < 20 && !q; i++) q = step(1)[1];
    expect(q).toBe(1);
  });
});
