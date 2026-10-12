import { describe, expect, it } from 'vitest';
import { PLA_PRESETS, ROM_PRESETS, cam, fifo, minimize, pla, plaTerms, regfileMP, romArray, stack } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { checkSpec, lcg, out, set, tick } from './util';

describe('ROM and PLA', () => {
  for (const p of Object.keys(ROM_PRESETS)) it(`rom ${p}`, () => checkSpec(romArray(p)));
  for (const p of Object.keys(PLA_PRESETS)) it(`pla ${p}`, () => checkSpec(pla(p)));
  it('Quine–McCluskey finds the textbook covers', () => {
    // majority (the full adder's carry): ab + ac + bc
    expect(minimize([3, 5, 6, 7]).length).toBe(3);
    // XOR of three: no merging possible, four minterms
    expect(minimize([1, 2, 4, 7]).length).toBe(4);
    expect(minimize([0, 1, 2, 3])).toEqual([{ val: 0, mask: 3 }]);
  });
  it('the 7-segment PLA needs far fewer terms than a ROM has words', () => {
    const { terms } = plaTerms(PLA_PRESETS.seg7);
    expect(terms.length).toBeLessThan(16 * 7 / 2);
  });
});

describe('FIFO', () => {
  it('behaves as a queue, refusing push when full and pop when empty', () => {
    const N = 4, s = simulate(fifo(2, 8)), r = lcg(21), q: number[] = [];
    set(s, { push: 0, pop: 0, din: 0, clk: 0 });
    for (let t = 0; t < 200; t++) {
      expect(out(s, 'empty'), `t ${t}`).toBe(q.length === 0 ? 1 : 0);
      expect(out(s, 'full'), `t ${t}`).toBe(q.length === N ? 1 : 0);
      if (q.length) expect(out(s, 'dout'), `t ${t}`).toBe(q[0]);
      const push = r(2), pop = r(2), din = r(256);
      set(s, { push, pop, din });
      tick(s);
      const canPop = pop && q.length > 0, canPush = push && q.length < N;
      if (canPop) q.shift();
      if (canPush) q.push(din);
    }
  });
});

describe('stack', () => {
  it('behaves as a stack', () => {
    const N = 4, s = simulate(stack(2, 8)), r = lcg(5), st: number[] = [];
    set(s, { push: 0, pop: 0, din: 0, clk: 0 });
    for (let t = 0; t < 200; t++) {
      expect(out(s, 'empty'), `t ${t}`).toBe(st.length === 0 ? 1 : 0);
      expect(out(s, 'full'), `t ${t}`).toBe(st.length === N ? 1 : 0);
      if (st.length) expect(out(s, 'top'), `t ${t}`).toBe(st[st.length - 1]);
      const push = r(2), pop = r(2), din = r(256);
      set(s, { push, pop, din });
      tick(s);
      if (push && st.length < N) st.push(din);
      else if (pop && !push && st.length) st.pop();
    }
  });
});

describe('CAM', () => {
  it('finds keys by content, highest matching entry wins', () => {
    const s = simulate(cam(2, 4));
    set(s, { we: 0, waddr: 0, wdata: 0, key: 0, clk: 0 });
    const mem: (number | null)[] = [null, null, null, null];
    const r = lcg(8);
    for (let t = 0; t < 60; t++) {
      if (r(2)) { const a = r(4), d = r(16); set(s, { we: 1, waddr: a, wdata: d }); tick(s); set(s, { we: 0 }); mem[a] = d; }
      const key = r(16);
      set(s, { key });
      let idx = -1;
      mem.forEach((v, i) => { if (v === key) idx = i; });
      expect([out(s, 'hit'), idx >= 0 ? out(s, 'index') : 0], `t ${t}`).toEqual([idx >= 0 ? 1 : 0, Math.max(idx, 0)]);
    }
  });
});

describe('multi-ported register file', () => {
  it('two writes per cycle (port 1 wins), four reads', () => {
    const s = simulate(regfileMP(3, 8, 4, 2)), r = lcg(4), regs = Array(8).fill(0);
    set(s, { clk: 0, we0: 1, we1: 0, wa0: 0, wa1: 0, wd0: 0, wd1: 0 });
    for (let a = 0; a < 8; a++) { set(s, { wa0: a }); tick(s); }
    for (let t = 0; t < 80; t++) {
      const v = { we0: r(2), we1: r(2), wa0: r(8), wa1: r(8), wd0: r(256), wd1: r(256), ra0: r(8), ra1: r(8), ra2: r(8), ra3: r(8) };
      set(s, v);
      for (let p = 0; p < 4; p++) expect(out(s, `rd${p}`)).toBe(regs[v[`ra${p}` as 'ra0']]);
      tick(s);
      if (v.we0) regs[v.wa0] = v.wd0;
      if (v.we1) regs[v.wa1] = v.wd1;
    }
  });
});
