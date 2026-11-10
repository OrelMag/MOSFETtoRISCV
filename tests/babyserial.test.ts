import { describe, expect, it } from 'vitest';
import { BABY_ACC } from '../src/lib/baby';
import { BABY_SERIAL, SERIAL_DIGITS, SERIAL_STAGE } from '../src/lib/babyserial';
import { addSub } from '../src/lib/combinational';
import { GateSim } from '../src/sim/gatesim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { evalOnce, simulate } from '../src/sim/harness';
import { deadInstances } from '../src/sim/dead';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const M = 2 ** 32;
const rnd = (() => { let s = 12345; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0); })();

function serialSub(a: number, b: number): { r: number; carry: number } {
  const sim = new GateSim(flatten(BABY_SERIAL));
  sim.reset('zero');
  const edge = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
  sim.setInput('clk', 0); sim.setInput('load', 1); sim.setInput('run', 0); sim.setInput('a', a); sim.setInput('b', b); sim.settle();
  edge();
  sim.setInput('load', 0); sim.setInput('run', 1); sim.settle();
  for (let i = 0; i < SERIAL_DIGITS; i++) edge();
  sim.setInput('run', 0); sim.settle();
  const out = sim.design.root.ports;
  const read = (n: string) => out[n].reduce((v, net, i) => v + (sim.get(net) === 1 ? 2 ** i : 0), 0);
  return { r: read('r'), carry: read('carry') };
}

describe('the serial subtractor (1948)', () => {
  it('equals addSub(32) a − b on random words and the edge cases', () => {
    const ASIM = simulate(addSub(32));
    const cases: [number, number][] = [[0, 5], [0, 0], [0, 2 ** 31], [2 ** 31, 1], [2 ** 31, 2 ** 31], [1, 2 ** 31], [M - 1, M - 1], [0, M - 1], [M - 1, 0], [5, 5], [7, 9]];
    for (let i = 0; i < 12; i++) cases.push([rnd(), rnd()]);
    for (const [a, b] of cases) {
      const ref = evalOnce(ASIM, [a, b, 1])[0];
      const got = serialSub(a, b);
      expect(got.r, `${a} − ${b}`).toBe(ref);
      expect(got.r).toBe((((a - b) % M) + M) % M);
    }
  });

  it('can pause between digits: the carry waits', () => {
    const sim = new GateSim(flatten(BABY_SERIAL));
    sim.reset('zero');
    const edge = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
    sim.setInput('clk', 0); sim.setInput('load', 1); sim.setInput('run', 0); sim.setInput('a', 1000); sim.setInput('b', 1); sim.settle();
    edge(); sim.setInput('load', 0); sim.settle();
    for (let i = 0; i < 5; i++) edge(); // idle: nothing moves, `first` waits
    sim.setInput('run', 1); sim.settle();
    for (let i = 0; i < SERIAL_DIGITS; i++) { edge(); if (i % 7 === 3) { sim.setInput('run', 0); sim.settle(); edge(); edge(); sim.setInput('run', 1); sim.settle(); } }
    sim.setInput('run', 0); sim.settle();
    expect(sim.design.root.ports.r.reduce((v, net, i) => v + (sim.get(net) === 1 ? 2 ** i : 0), 0)).toBe(999);
  });

  it('costs: the stage against addSub(32), and the whole unit with its registers (NANDs)', () => {
    const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
    const costs = { stage: n(SERIAL_STAGE), addSub32: n(addSub(32)), serial: n(BABY_SERIAL), acc: n(BABY_ACC) };
    expect(costs.acc).toBe(1068);
    expect(costs).toEqual({ stage: 28, addSub32: 420, serial: 2000, acc: 1068 }); // the stage is 15× smaller than the parallel subtractor
  });

  it.each([SERIAL_STAGE, BABY_SERIAL].map((d) => [d.id, d] as const))('%s: layout is clean', (_, d) => {
    const nl = netlistOf(d)!;
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(backwardEnds(d, nl)).toEqual([]);
    expect(wireOverlaps(routeNetlist(d, nl).nets)).toEqual([]);
    expect(deadInstances(nl, d.ports)).toEqual([]);
  });
});
