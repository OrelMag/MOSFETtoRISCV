// The campaign's storage cells (the parts s_dlatch … s_reg16 unlock, at the learner's cost):
// they behave like the library's, cost what the levels' pars count, and the PC built from them
// still counts, loads and resets.

import { describe, expect, it } from 'vitest';
import { DFF, register } from '../src/lib/sequential';
import { PC16, RV16_DFF, RV16_DFFE, RV16_DLATCH, RV16_DREG16, RV16_REG16, RV16_REG4 } from '../src/lib/rv16/logic';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { lcg, out, set, tick } from './util';

describe('campaign storage cells', () => {
  it('cost 4, 9, 13, 52, 208 and 144 NANDs', () => {
    expect([RV16_DLATCH, RV16_DFF, RV16_DFFE, RV16_REG4, RV16_REG16, RV16_DREG16].map((d) => stats(d).nands)).toEqual([4, 9, 13, 52, 208, 144]);
  });

  it('the latch is transparent while e = 1 and holds while e = 0', () => {
    const s = simulate(RV16_DLATCH);
    const seq: [number, number, number][] = [[1, 1, 1], [0, 1, 0], [1, 1, 1], [1, 0, 1], [0, 0, 1], [0, 1, 0], [1, 0, 0]];
    for (const [d, e, q] of seq) { set(s, { d, e }); expect(out(s, 'q')).toBe(q); }
  });

  it('the flip-flop takes d at the rising edge only, like the library DFF', () => {
    const a = simulate(RV16_DFF), b = simulate(DFF);
    const r = lcg(3);
    for (let i = 0; i < 40; i++) {
      const v = { d: r(2), clk: r(2) };
      set(a, v); set(b, v);
      expect(out(a, 'q'), `step ${i}`).toBe(out(b, 'q'));
    }
  });

  it('the 16-bit registers load (with en) and hold like the library register', () => {
    const a = simulate(RV16_REG16), b = simulate(register(16)), c = simulate(RV16_DREG16);
    const r = lcg(16);
    for (let i = 0; i < 60; i++) {
      const v = { d: r(0x10000), en: r(4) ? 1 : 0 };
      set(a, v); set(b, v); set(c, { d: v.d });
      tick(a); tick(b); tick(c);
      expect(out(a, 'q'), `step ${i}`).toBe(out(b, 'q'));
      expect(out(c, 'q')).toBe(v.d);
    }
  });

  it('the PC resets, counts, loads and wraps', () => {
    const s = simulate(PC16);
    set(s, { rst: 1, ld: 0, d: 0, clk: 0 });
    tick(s);
    expect(out(s, 'pc')).toBe(0);
    set(s, { rst: 0 });
    tick(s); tick(s);
    expect(out(s, 'pc')).toBe(2);
    set(s, { ld: 1, d: 0xffff });
    tick(s);
    set(s, { ld: 0 });
    expect(out(s, 'pc')).toBe(0xffff);
    tick(s);
    expect(out(s, 'pc')).toBe(0);
    set(s, { rst: 1, ld: 1, d: 0x1234 });
    tick(s);
    expect(out(s, 'pc')).toBe(0);
  });
});
