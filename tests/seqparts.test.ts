import { describe, expect, it } from 'vitest';
import { D_LATCH_R, DFF_R, JKFF, LFSR_TAPS, NAND3, TFF, clockDivider, lfsr, lfsrNext, ringCounter, shiftRegister, upDownCounter } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { checkSpec, lcg, out, set, tick } from './util';

describe('NAND3', () => {
  it('matches its spec', () => checkSpec(NAND3));
});

describe('asynchronous reset', () => {
  it('the latch clears while rst_n = 0, whatever d and e', () => {
    const s = simulate(D_LATCH_R);
    set(s, { d: 1, e: 1, rst_n: 1 });
    expect(out(s, 'q')).toBe(1);
    set(s, { rst_n: 0 });
    expect([out(s, 'q'), out(s, 'q_n')]).toEqual([0, 1]);
    set(s, { e: 0 });
    set(s, { rst_n: 1 }); // release reset while closed (releasing both at once is a race)
    expect(out(s, 'q')).toBe(0); // holds the cleared value
  });
  it('the flip-flop clears without a clock edge, and otherwise acts as a DFF', () => {
    const s = simulate(DFF_R);
    set(s, { d: 1, clk: 0, rst_n: 1 });
    tick(s);
    expect(out(s, 'q')).toBe(1);
    set(s, { rst_n: 0 });
    expect(out(s, 'q')).toBe(0);
    set(s, { rst_n: 1 });
    expect(out(s, 'q')).toBe(0);
    for (const d of [1, 0, 1, 1, 0]) { set(s, { d }); tick(s); expect(out(s, 'q')).toBe(d); }
  });
});

describe('T and JK flip-flops', () => {
  it('T toggles while t = 1', () => {
    const s = simulate(TFF);
    set(s, { t: 1, clk: 0, rst_n: 0 });
    set(s, { rst_n: 1 });
    const seen = [];
    for (let i = 0; i < 4; i++) { tick(s); seen.push(out(s, 'q')); }
    expect(seen).toEqual([1, 0, 1, 0]);
    set(s, { t: 0 });
    tick(s);
    expect(out(s, 'q')).toBe(0);
  });
  it('JK: hold, reset, set, toggle', () => {
    const s = simulate(JKFF);
    set(s, { j: 0, k: 0, clk: 0, rst_n: 0 });
    set(s, { rst_n: 1 });
    const step = (j: number, k: number) => { set(s, { j, k }); tick(s); return out(s, 'q'); };
    expect([step(1, 0), step(0, 0), step(0, 1), step(1, 1), step(1, 1), step(0, 0)]).toEqual([1, 1, 0, 1, 0, 0]);
  });
});

describe('counters and shift registers', () => {
  it('up/down counter with load', () => {
    const s = simulate(upDownCounter(4));
    set(s, { up: 1, en: 0, load: 1, d: 14, clk: 0 });
    tick(s);
    expect(out(s, 'q')).toBe(14);
    set(s, { load: 0, en: 1 });
    const seen = [];
    for (let i = 0; i < 3; i++) { tick(s); seen.push(out(s, 'q')); }
    set(s, { up: 0 });
    for (let i = 0; i < 4; i++) { tick(s); seen.push(out(s, 'q')); }
    set(s, { en: 0 });
    tick(s);
    seen.push(out(s, 'q'));
    expect(seen).toEqual([15, 0, 1, 0, 15, 14, 13, 13]);
  });
  it('universal shift register against a model', () => {
    const n = 6, M = 2 ** n - 1, s = simulate(shiftRegister(n)), r = lcg(9);
    set(s, { mode: 3, d: 0, sr: 0, sl: 0, clk: 0 });
    tick(s);
    let q = 0;
    for (let t = 0; t < 120; t++) {
      const mode = r(4), d = r(M + 1), sr = r(2), sl = r(2);
      set(s, { mode, d, sr, sl });
      tick(s);
      q = mode === 1 ? (q >> 1) | (sr << (n - 1)) : mode === 2 ? ((q << 1) & M) | sl : mode === 3 ? d : q;
      expect(out(s, 'q'), `step ${t} mode ${mode}`).toBe(q);
    }
  });
  it('ring and Johnson counters', () => {
    const ring = simulate(ringCounter(4)), john = simulate(ringCounter(4, true));
    for (const s of [ring, john]) { set(s, { init: 1, clk: 0 }); tick(s); set(s, { init: 0 }); }
    const rs = [out(ring, 'q')], js = [out(john, 'q')];
    for (let i = 0; i < 8; i++) { tick(ring); tick(john); rs.push(out(ring, 'q')); js.push(out(john, 'q')); }
    expect(rs).toEqual([1, 2, 4, 8, 1, 2, 4, 8, 1]);
    expect(js).toEqual([0, 1, 3, 7, 15, 14, 12, 8, 0]);
  });
});

describe('LFSR', () => {
  for (const n of [3, 4, 5, 8]) {
    it(`${n} bits: maximal period ${2 ** n - 1}, as the model`, () => {
      const s = simulate(lfsr(n));
      set(s, { load: 1, seed: 1, clk: 0 });
      tick(s);
      set(s, { load: 0 });
      const seen = new Set<number>();
      let q = 1;
      for (let i = 0; i < 2 ** n - 1; i++) {
        expect(out(s, 'q')).toBe(q);
        seen.add(q);
        tick(s);
        q = lfsrNext(q, n);
      }
      expect(seen.size).toBe(2 ** n - 1);
      expect(out(s, 'q')).toBe(1);
    });
  }
  it('16-bit taps are maximal (model)', () => {
    let q = 1, period = 0;
    do { q = lfsrNext(q, 16); period++; } while (q !== 1);
    expect(period).toBe(65535);
    expect(LFSR_TAPS[16]).toEqual([16, 15, 13, 4]);
  });
});

describe('ripple clock divider', () => {
  it('output i has period 2^(i+1) clocks', () => {
    const k = 3, s = simulate(clockDivider(k));
    set(s, { clk: 0, rst_n: 0 });
    set(s, { rst_n: 1 });
    const hist: number[] = [];
    for (let i = 0; i < 16; i++) { tick(s); hist.push(out(s, 'q')); }
    for (let b = 0; b < k; b++) {
      const bits = hist.map((v) => (v >> b) & 1);
      let changes = 0;
      for (let i = 1; i < bits.length; i++) if (bits[i] !== bits[i - 1]) changes++;
      expect(changes, `bit ${b}`).toBe(Math.floor(15 / 2 ** b));
    }
  });
});
