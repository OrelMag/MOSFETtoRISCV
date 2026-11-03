import { describe, expect, it } from 'vitest';
import { BILINEAR8, INTC4, IntcModel, LERP8, VECTOR_TARGET, bilinearRef, vectorTargetOf } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { checkSpec, lcg, out, set, tick } from './util';

describe('vectored trap target', () => {
  it('matches its spec', () => checkSpec(VECTOR_TARGET, 600, [[0x1001, 0x80000007], [0x1000, 0x80000007], [0x1041, 0x7], [0x1041, 0x8000000b]]));
  it('interrupt n goes to BASE + 4n, exceptions and direct mode to BASE', () => {
    expect(vectorTargetOf(0x1001, 0x80000007)).toBe(0x101c);
    expect(vectorTargetOf(0x1001, 0x8000000b)).toBe(0x102c);
    expect(vectorTargetOf(0x1001, 11)).toBe(0x1000);
    expect(vectorTargetOf(0x1000, 0x80000007)).toBe(0x1000);
  });
});

describe('interrupt controller', () => {
  it('matches its reference model cycle by cycle on random traffic, and latches a pulse', () => {
    const s = simulate(INTC4);
    const m = new IntcModel(4);
    const rnd = lcg(5);
    set(s, { src: 0, en: 15, claim: 0, clk: 0 });
    for (let t = 0; t < 300; t++) {
      const src = rnd(4) === 0 ? rnd(16) : 0, en = rnd(8) === 0 ? rnd(16) : 15, claim = rnd(3) === 0 ? 1 : 0;
      set(s, { src, en, claim });
      const top = m.top(en);
      expect([out(s, 'irq'), top.v ? out(s, 'id') : 0], `t=${t}`).toEqual([top.v, top.id]);
      tick(s);
      m.edge(src, en, claim);
      expect(out(s, 'pend'), `pend t=${t}`).toBe(m.pend);
    }
  });
  it('a one-cycle request is held until claimed; the highest source is served first', () => {
    const s = simulate(INTC4);
    set(s, { src: 0, en: 15, claim: 0, clk: 0 });
    set(s, { src: 0b0110 }); tick(s); set(s, { src: 0 });
    expect([out(s, 'irq'), out(s, 'id'), out(s, 'pend')]).toEqual([1, 2, 0b0110]);
    set(s, { claim: 1 }); tick(s);
    expect([out(s, 'irq'), out(s, 'id'), out(s, 'pend')]).toEqual([1, 1, 0b0010]);
    tick(s); set(s, { claim: 0 });
    expect([out(s, 'irq'), out(s, 'pend')]).toEqual([0, 0]);
  });
});

describe('bilinear filter', () => {
  it('LERP8 matches its spec', () => checkSpec(LERP8, 300, [[255, 255, 15], [0, 255, 15], [200, 10, 0]]));
  it('BILINEAR8 matches its spec and is exact at the corners', () => {
    checkSpec(BILINEAR8, 60, [[255, 0, 0, 0, 0, 0], [10, 20, 30, 40, 15, 15]]);
    expect(bilinearRef(10, 20, 30, 40, 0, 0)).toBe(10);
    expect(bilinearRef(200, 200, 200, 200, 7, 9)).toBe(200);
  });
  it('NAND counts', () => { expect(stats(LERP8).nands).toBeGreaterThan(0); expect(stats(BILINEAR8).nands).toBe(3 * stats(LERP8).nands); });
});
