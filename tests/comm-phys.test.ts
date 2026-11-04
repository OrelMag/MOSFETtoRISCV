import { describe, expect, it } from 'vitest';
import { thresholds, mNode, VM, keeperLimit, noisyEdge, receive, transitions, KEEPER, rng } from '../src/phys/schmitt';
import { VDD } from '../src/widgets/mosphys';

describe('Schmitt thresholds from the current balance', () => {
  it('no keeper: both thresholds are the inverter threshold', () => {
    const t = thresholds(0);
    expect(t.up).toBeCloseTo(VM, 2);
    expect(t.down).toBeCloseTo(VM, 2);
  });
  it('with a keeper, down < VM < up', () => {
    const t = thresholds(KEEPER);
    expect(t.down!).toBeLessThan(VM);
    expect(t.up!).toBeGreaterThan(VM);
    expect(t.width!).toBeGreaterThan(0);
  });
  it('widens with keeper strength', () => {
    let prev = -1;
    for (const k of [0, 0.05, 0.1, 0.2, 0.4, 0.8]) {
      const t = thresholds(k);
      expect(t.width, `kappa ${k}`).not.toBeNull();
      expect(t.width!).toBeGreaterThan(prev);
      prev = t.width!;
    }
  });
  it('a matched pair is symmetric about VDD / 2', () => {
    expect(VM).toBeCloseTo(VDD / 2, 3);
    for (const k of [0.1, 0.3, 0.6]) {
      const t = thresholds(k);
      expect(t.up! + t.down!).toBeCloseTo(VDD, 2);
    }
  });
  it('m falls as vin rises, and the keeper shifts it the expected way', () => {
    for (const st of ['hi', 'lo'] as const) {
      let prev = Infinity;
      for (let v = 0; v <= VDD + 1e-9; v += 0.1) { const m = mNode(v, 0.3, st); expect(m).toBeLessThanOrEqual(prev + 1e-9); prev = m; }
    }
    expect(mNode(0.9, 0.3, 'hi')).toBeGreaterThan(mNode(0.9, 0.3, 'lo'));
  });
  it('a keeper past the limit holds the output for good', () => {
    const lim = keeperLimit();
    expect(lim).toBeGreaterThan(0.5);
    const t = thresholds(lim * 1.2);
    expect(t.up === null || t.down === null).toBe(true);
    expect(thresholds(lim * 0.9).width).not.toBeNull();
  });
});

describe('a noisy slow edge', () => {
  it('is seeded: the same seed, the same trace', () => {
    expect(noisyEdge(7, 0.1)).toEqual(noisyEdge(7, 0.1));
    expect(noisyEdge(7, 0.1)).not.toEqual(noisyEdge(8, 0.1));
    const r = rng(1); expect(r()).toBeGreaterThanOrEqual(0);
  });
  it('noise well inside the hysteresis never makes the Schmitt output chatter; the plain receiver does', () => {
    const t = thresholds(KEEPER);
    let plainWorse = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const tr = noisyEdge(seed, t.width! / 10);
      const plain = transitions(receive(tr, VM, VM)), sch = transitions(receive(tr, t.up!, t.down!));
      expect(sch, `seed ${seed}`).toBe(1);
      expect(plain).toBeGreaterThanOrEqual(1);
      if (plain > 1) plainWorse++;
    }
    expect(plainWorse).toBeGreaterThan(20);
  });
  it('zero noise: one transition either way', () => {
    const tr = noisyEdge(1, 0);
    expect(transitions(receive(tr, VM, VM))).toBe(1);
    expect(transitions(receive(tr, 1.1, 0.7))).toBe(1);
  });
});

import { AGE_OF_UNIVERSE_YEARS, fmtDuration, fmtLog10, log10Mtbf, mtbf, pUndecided, resolutionTime, resolveTime, T0_PS, TAU_PS, voltage, windowRate, V_DECIDED } from '../src/phys/metastable';
import { PS_PER_NAND } from '../src/sim/timing';

describe('metastability model', () => {
  it('the constants are tied to the NAND delay', () => {
    expect(TAU_PS).toBe(0.4 * PS_PER_NAND);
    expect(T0_PS).toBe(PS_PER_NAND);
  });
  it('a difference grows by e per tau and is clipped at the decided level', () => {
    expect(voltage(0.001, TAU_PS)).toBeCloseTo(0.001 * Math.E, 9);
    expect(voltage(-0.001, 100 * TAU_PS)).toBe(-V_DECIDED);
    expect(resolveTime(0.9)).toBe(0);
    expect(resolveTime(V_DECIDED * Math.exp(-3))).toBeCloseTo(3 * TAU_PS, 6);
    expect(resolveTime(0)).toBe(Infinity);
    // voltage at the resolve time is the decided level
    const dv = 3.2e-5;
    expect(Math.abs(voltage(dv, resolveTime(dv)))).toBeCloseTo(V_DECIDED, 9);
  });
  it('the undecided chance is e^(-t/tau)', () => {
    expect(pUndecided(0)).toBe(1);
    expect(pUndecided(TAU_PS)).toBeCloseTo(Math.exp(-1), 12);
    expect(pUndecided(-5)).toBe(1);
  });
  it('resolution time: one period less clock-to-q and setup per hop', () => {
    const hop = (3 + 3) * PS_PER_NAND;
    expect(resolutionTime(2, 1000)).toBe(1000 - hop);
    expect(resolutionTime(3, 1000)).toBe(2000 - hop);
    expect(resolutionTime(1, 1000, 100)).toBe(1000 - hop - 100);
    expect(resolutionTime(2, 100)).toBe(0);
  });
  it('MTBF = e^(tr/tau) / (T0 fclk fdata), and an extra stage multiplies it by e^(T/tau)', () => {
    const base = { fclk: 1e9, fdata: 1e8 };
    const m2 = mtbf({ ...base, stages: 2 });
    const tr = 1000 - 6 * PS_PER_NAND;
    expect(m2).toBeCloseTo(Math.exp(tr / TAU_PS) / (T0_PS * 1e-12 * 1e9 * 1e8), -3);
    expect(Math.log(mtbf({ ...base, stages: 3 }) / m2)).toBeCloseTo(1000 / TAU_PS, 6);
    expect(windowRate(1e9, 1e8)).toBeCloseTo(2.5e-11 * 1e17, 0);
  });
  it('MTBF falls with the clock rate and with the data rate', () => {
    const a = log10Mtbf({ stages: 2, fclk: 5e8, fdata: 1e7 });
    expect(log10Mtbf({ stages: 2, fclk: 1e9, fdata: 1e7 })).toBeLessThan(a);
    expect(log10Mtbf({ stages: 2, fclk: 5e8, fdata: 1e8 })).toBeLessThan(a);
    expect(log10Mtbf({ stages: 2, fclk: 5e8, fdata: 1e7 })).toBeCloseTo(Math.log10(mtbf({ stages: 2, fclk: 5e8, fdata: 1e7 })), 9);
  });
  it('durations read in units', () => {
    expect(fmtDuration(3e-7)).toBe('0.3 µs');
    expect(fmtDuration(2.4)).toBe('2.4 s');
    expect(fmtDuration(650e-3)).toBe('650 ms');
    expect(fmtDuration(3600 * 5)).toBe('5.0 h');
    expect(fmtDuration(86400 * 365.25 * 10)).toBe('10 years');
    expect(fmtDuration(86400 * 365.25 * 3e9)).toContain('10^9');
    expect(fmtDuration(Infinity)).toBe('effectively never');
    expect(fmtLog10(400)).toMatch(/^10\^/);
    expect(AGE_OF_UNIVERSE_YEARS).toBeGreaterThan(1e10);
  });
});

import { garbage, meanGarbage, pGarbage, readings, table, worstError } from '../src/comm/graybus';
import { interleave, EdgeSchedule } from '../src/comm/asyncfifo';
import { inWindow, landings, phaseOf, reduce, windowFraction } from '../src/comm/phase';

describe('what a sampler reads mid-change', () => {
  it('binary 0111 → 1000: all sixteen words are possible, and one is 15 away', () => {
    expect(readings(0b0111, 0b1000)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(garbage(0b0111, 0b1000)).toHaveLength(14);
    expect(worstError(0b0111, 0b1000)).toBe(8);
    expect(pGarbage(0b0111, 0b1000)).toBeCloseTo(1 - 2 / 16, 12);
  });
  it('a single-bit change has only the old and the new word', () => {
    expect(readings(5, 4)).toEqual([4, 5]);
    expect(garbage(5, 4)).toEqual([]);
    expect(pGarbage(5, 4)).toBe(0);
  });
  it('Gray: every step of an n-bit counter, wrap included, offers two readings and no garbage', () => {
    for (const n of [2, 3, 4, 5]) {
      for (const r of table(n, 'gray')) { expect(r.flips).toBe(1); expect(r.reads).toBe(2); expect(r.bad).toBe(0); }
      expect(meanGarbage(n, 'gray')).toBe(0);
    }
  });
  it('binary: the step has trailing-ones + 1 changing bits, and garbage is common', () => {
    const t = table(4, 'binary');
    expect(t.map((r) => r.flips)).toEqual([1, 2, 1, 3, 1, 2, 1, 4, 1, 2, 1, 3, 1, 2, 1, 4]);
    expect(t.every((r) => r.reads === 2 ** r.flips)).toBe(true);
    expect(meanGarbage(4, 'binary')).toBeCloseTo(t.reduce((a, r) => a + r.p, 0) / 16, 12);
    expect(meanGarbage(4, 'binary')).toBeGreaterThan(0.25);
  });
});

describe('clock edges landing in a window', () => {
  it('related clocks repeat their phases: 1:1 never meets a window it started outside of', () => {
    const l = landings(1, 1, 1000, 0.05, 0.05, 0.4);
    expect(l.distinct).toBe(1);
    expect(l.hits).toBe(0);
    expect(landings(1, 1, 1000, 0.05, 0.05, 0.99).hits).toBe(1000);
  });
  it('3:2 has two phases', () => expect(landings(3, 2, 600, 0.05, 0.05).distinct).toBe(3));
  it('unrelated clocks fill the period evenly, so the hit rate is the window fraction', () => {
    const fa = Math.PI, l = landings(fa, 1, 20000, 0.01, 0.02);
    expect(l.hits / 20000).toBeCloseTo(windowFraction(0.01, 0.02), 2);
    expect(l.distinct).toBeGreaterThan(19000);
  });
  it('phase and window', () => {
    expect(phaseOf(1, 2, 1)).toBeCloseTo(0.5, 12);
    expect(inWindow(0.97, 0.05, 0.05)).toBe(true);
    expect(inWindow(0.5, 0.05, 0.05)).toBe(false);
    expect(reduce(1.5)).toEqual([3, 2]);
    expect(reduce(1.37)).toEqual([137, 100]);
  });
  it('the edge schedule never has two edges at once and keeps the ratio', () => {
    const e = interleave(3, 2, 5000);
    const w = e.filter((x) => x === 'w').length, r = e.length - w;
    expect(w / r).toBeCloseTo(1.5, 1);
    const s = new EdgeSchedule(1, 1);
    expect([s.next(), s.next(), s.next()]).toEqual(['w', 'r', 'w']);
  });
});
