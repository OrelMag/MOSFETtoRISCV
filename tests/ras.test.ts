// The return-address stack (lib/ras.ts) against the model's rules (riscv/ooomodel.ts: a list of at most 4
// entries; push drops the oldest when full, pop on empty does nothing, restore copies the committed list).

import { describe, expect, it } from 'vitest';
import { ras, ras2, rasNext } from '../src/lib/ras';
import { simulate } from '../src/sim/harness';
import { lcg, out, set, tick } from './util';

describe('return-address stack', () => {
  it('speculative and committed copies, restore, every cycle against the model', () => {
    const s = simulate(ras(4, 8)), r = lcg(17);
    let spec: number[] = [], cmt: number[] = [];
    set(s, { clk: 0, pushF: 0, popF: 0, valF: 0, pushC: 0, popC: 0, valC: 0, restore: 0 });
    // power-on: empty (every valid bit 0)
    expect(out(s, 'any')).toBe(0);
    for (let t = 0; t < 400; t++) {
      const opF = r(3), opC = r(3), restore = r(8) === 0 ? 1 : 0;
      const v = { pushF: opF === 1 ? 1 : 0, popF: opF === 2 ? 1 : 0, valF: r(256), pushC: opC === 1 ? 1 : 0, popC: opC === 2 ? 1 : 0, valC: r(256), restore };
      set(s, v);
      expect([out(s, 'any'), spec.length ? out(s, 'top') : 0], `t ${t}`).toEqual([spec.length ? 1 : 0, spec.length ? spec[spec.length - 1] : 0]);
      tick(s);
      cmt = v.pushC ? rasNext(cmt, v.valC) : v.popC ? rasNext(cmt, null) : cmt;
      spec = restore ? cmt.slice() : v.pushF ? rasNext(spec, v.valF) : v.popF ? rasNext(spec, null) : spec;
    }
  });
});

describe('return-address stack, two operations a cycle (the out-of-order core)', () => {
  it('each copy applies two pushes / pops in order; slot 1 sees slot 0\'s; restore takes the committed copy after its two', () => {
    const s = simulate(ras2(4, 8)), r = lcg(23);
    let spec: number[] = [], cmt: number[] = [];
    const op = (st: number[], push: number, pop: number, v: number) => (pop ? rasNext(st, null) : push ? rasNext(st, v) : st);
    const zero = { push0: 0, pop0: 0, v0: 0, push1: 0, pop1: 0, v1: 0, pushC0: 0, popC0: 0, vC0: 0, pushC1: 0, popC1: 0, vC1: 0, restore: 0 };
    set(s, { clk: 0, ...zero });
    const top = (st: number[]) => [st.length ? 1 : 0, st.length ? st[st.length - 1] : 0];
    for (let t = 0; t < 600; t++) {
      const o = () => { const k = r(4); return { push: k === 1 ? 1 : 0, pop: k === 2 ? 1 : 0 }; };
      const f0 = o(), f1 = o(), c0 = o(), c1 = o();
      const v = { push0: f0.push, pop0: f0.pop, v0: r(256), push1: f1.push, pop1: f1.pop, v1: r(256),
        pushC0: c0.push, popC0: c0.pop, vC0: r(256), pushC1: c1.push, popC1: c1.pop, vC1: r(256), restore: r(10) === 0 ? 1 : 0 };
      set(s, v);
      const after0 = op(spec, v.push0, v.pop0, v.v0);
      expect([out(s, 'any0'), spec.length ? out(s, 'top0') : 0], `t ${t} slot 0`).toEqual(top(spec));
      expect([out(s, 'any1'), after0.length ? out(s, 'top1') : 0], `t ${t} slot 1`).toEqual(top(after0));
      tick(s);
      cmt = op(op(cmt, v.pushC0, v.popC0, v.vC0), v.pushC1, v.popC1, v.vC1);
      spec = v.restore ? cmt.slice() : op(after0, v.push1, v.pop1, v.v1);
    }
  });
});
