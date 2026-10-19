// The return-address stack (lib/ras.ts) against the model's rules (riscv/ooomodel.ts: a list of at most 4
// entries; push drops the oldest when full, pop on empty does nothing, restore copies the committed list).

import { describe, expect, it } from 'vitest';
import { ras, rasNext } from '../src/lib/ras';
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
