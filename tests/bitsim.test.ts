import { describe, expect, it } from 'vitest';
import { counter, fpAdd, seqDivider } from '../src/lib';
import { BitSim, evalMany } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { evalOnce, simulate } from '../src/sim/harness';
import { inPorts } from '../src/sim/types';
import type { Sim } from '../src/sim/sim';
import { pack } from '../src/sim/values';

let seed = 7;
const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
const tick = (s: Sim) => { s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle(); };
const out = (s: Sim, p: string) => pack(s.getBits(s.design.root.ports[p]));

describe('bit-parallel simulator agrees with GateSim', () => {
  it('combinational: a small floating-point adder', () => {
    const def = fpAdd({ E: 3, M: 2 });
    const bs = new BitSim(flatten(def)), gs = simulate(def);
    expect(bs.acyclic).toBe(true);
    const vecs = Array.from({ length: 300 }, () => inPorts(def).map((p) => rnd(2 ** p.width)));
    const got = evalMany(bs, vecs);
    vecs.forEach((v, i) => expect(got[i], `${v}`).toEqual(evalOnce(gs, v)));
  });

  it('sequential: a counter and an iterative divider, 32 lanes in lock-step', () => {
    const c = new BitSim(flatten(counter(4)));
    expect(c.acyclic).toBe(false);
    const en = Array.from({ length: 32 }, (_, l) => l & 1);
    c.setInput('en', en);
    for (let k = 0; k < 5; k++) c.cycle();
    expect(c.get('q')).toEqual(en.map((e) => (e ? 5 : 0)));

    const def = seqDivider(8);
    const bs = new BitSim(flatten(def)), gs = simulate(def);
    const a = Array.from({ length: 32 }, () => rnd(256)), b = Array.from({ length: 32 }, () => 1 + rnd(255));
    bs.setInput('a', a); bs.setInput('b', b); bs.setInput('start', 1); bs.settle();
    gs.setInput('a', a[3]); gs.setInput('b', b[3]); gs.setInput('start', 1); gs.settle();
    for (let k = 0; k < 9; k++) {
      bs.cycle(); tick(gs);
      expect(bs.get('busy')[3], `cycle ${k}`).toBe(out(gs, 'busy'));
      expect(bs.get('q')[3], `cycle ${k}`).toBe(out(gs, 'q'));
    }
    expect(bs.get('done')).toEqual(new Array(32).fill(1));
    expect(bs.get('q')).toEqual(a.map((x, i) => Math.floor(x / b[i])));
    expect(bs.get('r')).toEqual(a.map((x, i) => x % b[i]));
  });
});
