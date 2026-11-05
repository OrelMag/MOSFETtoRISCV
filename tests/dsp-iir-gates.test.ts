// lib/biquad.ts against dsp/iir.ts Biquad at every clock, and the limit cycle the chapter shows, pinned on both.
import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { Biquad, BQ, burstThenSilence, cycleSweep, deadBand, dropBits, findCycle, LIMIT_CYCLE, runBiquad, type Words } from '../src/dsp/iir';
import { guardBits, satTo, wrapTo } from '../src/dsp/fixed';
import { biquad, clampWord } from '../src/lib';
import { treeMul } from '../src/lib/muldiv';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { lcg, out, set, tick as clock } from './util';
import { tick } from './yieldtick';

describe('the model', () => {
  it('is BigInt arithmetic: the exact sum, one rounding, one clamp', () => {
    const rnd = lcg(5), pick = (n: number) => rnd(n) - n / 2;
    for (const round of ['half-up', 'zero', 'trunc', 'convergent'] as const) {
      const c: Words = { b0: pick(65536), b1: pick(65536), b2: pick(65536), a1: pick(65536), a2: pick(65536) };
      const m = new Biquad(c, { round });
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < 400; i++) {
        const x = i % 7 === 0 ? (i % 2 ? 32767 : -32768) : pick(65536);
        const acc = BigInt(c.b0) * BigInt(x) + BigInt(c.b1) * BigInt(x1) + BigInt(c.b2) * BigInt(x2) - BigInt(c.a1) * BigInt(y1) - BigInt(c.a2) * BigInt(y2);
        const P = 1n << 14n;
        const fl = acc >= 0n ? acc / P : -((-acc + P - 1n) / P);
        let q: bigint;
        if (round === 'trunc') q = fl;
        else if (round === 'zero') q = acc >= 0n ? acc / P : -(-acc / P);
        else if (round === 'half-up') { const t = acc + (P >> 1n); q = t >= 0n ? t / P : -((-t + P - 1n) / P); }
        else { const r = acc - fl * P, up = r * 2n > P || (r * 2n === P && fl % 2n !== 0n); q = up ? fl + 1n : fl; }
        const y = Number(q > 32767n ? 32767n : q < -32768n ? -32768n : q);
        expect(m.step(x), `${round} step ${i}`).toBe(y);
        x2 = x1; x1 = x; y2 = y1; y1 = y;
      }
    }
  });
  it('the accumulator has a bit to spare: five products of at most 2^30 fit in 34 bits, and the rule of guard bits gives 35', () => {
    const worst = 5 * 2 ** 30;
    expect(BQ.accW).toBe(BQ.prod + guardBits(5));
    expect(worst).toBeLessThan(2 ** (BQ.accW - 2));
    expect(worst).toBeGreaterThan(2 ** (BQ.accW - 3));
  });
  it('dropBits is shiftRound, and toward zero mirrors it', () => {
    for (let v = -40; v <= 40; v++) {
      expect(dropBits(v, 3, 'zero')).toBe(Math.sign(v) * Math.floor(Math.abs(v) / 8) + 0);
      expect(dropBits(v, 3, 'trunc')).toBe(Math.floor(v / 8));
    }
  });
});

describe('the wide clamp', () => {
  it('every word: it fits exactly when the top bits agree', () => {
    for (const [w, n] of [[3, 6], [4, 7], [3, 8]] as const) {
      const sim = simulate(clampWord(w, n));
      for (let x = 0; x < 2 ** n; x++) {
        const v = wrapTo(x, n), [y, sat] = evalOnce(sim, [x]);
        expect(wrapTo(y, w), `${n} to ${w} of ${v}`).toBe(satTo(v, w));
        expect(sat).toBe(satTo(v, w) === v ? 0 : 1);
      }
    }
  });
  it('the default drawing is the old one', () => {
    expect(clampWord(16).id).toBe('fxclamp16');
    expect(clampWord(16, 17)).toBe(clampWord(16));
  });
});

function runGates(round: 'half-up' | 'zero', c: Words, xs: readonly number[], model: Biquad): number[] {
  const sim = new GateSim(flatten(biquad(round)));
  sim.setInput('clk', 0);
  for (const [k, v] of Object.entries(c)) sim.setInput(k, wordOf(v, 16));
  sim.setInput('x', 0); sim.reset('zero'); sim.settle();
  const ys: number[] = [];
  xs.forEach((x, i) => {
    set(sim, { x: wordOf(x, 16) });
    const y = signedOf(out(sim, 'y'), 16), want = model.step(x);
    expect(y, `${round} cycle ${i}`).toBe(want);
    ys.push(y);
    clock(sim);
  });
  return ys;
}

describe('the gates equal the model at every clock', () => {
  for (const round of ['half-up', 'zero'] as const) {
    it(`${round}: random coefficients and inputs, full-scale words, and the clamp`, async () => {
      const rnd = lcg(11 + round.length);
      for (let k = 0; k < 4; k++) {
        const c: Words = k === 0 ? { b0: -32768, b1: -32768, b2: 32767, a1: -32768, a2: 32767 } : { b0: rnd(65536) - 32768, b1: rnd(65536) - 32768, b2: rnd(65536) - 32768, a1: rnd(65536) - 32768, a2: rnd(65536) - 32768 };
        const xs = Array.from({ length: 90 }, (_, i) => (i % 9 === 0 ? (i % 2 ? 32767 : -32768) : rnd(65536) - 32768));
        runGates(round, c, xs, new Biquad(c, { round }));
        await tick();
      }
    });
  }
  it('the sat flag is the clamp\'s', () => {
    const sim = simulate(biquad());
    const c: Words = { b0: 32767, b1: 0, b2: 0, a1: 0, a2: 0 };
    for (const [k, v] of Object.entries(c)) sim.setInput(k, wordOf(v, 16));
    sim.setInput('clk', 0);
    for (const x of [32767, 100, -32768]) {
      sim.setInput('x', wordOf(x, 16)); sim.settle();
      expect(out(sim, 'sat'), `${x}`).toBe(Math.abs(Math.round((x * 32767) / 2 ** 14)) > 32767 ? 1 : 0);
    }
  });
  it('the cost is counted: five multipliers, 35-bit adders, one rounding, one clamp', () => {
    const n = stats(biquad()).nands;
    expect(n).toBeGreaterThan(5 * stats(treeMul(16, true)).nands);
    expect(n).toBe(20313);
    expect(stats(biquad('zero')).nands).toBeGreaterThan(n);
  });
});

describe('a limit cycle on the gates', () => {
  const { words, amp, burst, cycles } = LIMIT_CYCLE;
  const xs = burstThenSilence(amp, burst, cycles);
  it('the model: one input word, then silence, and the output never dies', () => {
    expect(words.a2).toBe(14787);
    const ys = runBiquad(words, burstThenSilence(amp, burst, 800));
    expect(ys.slice(0, 5)).toEqual([500, 0, -451, 0, 407]);
    const cy = findCycle(ys, 16)!;
    expect(cy.period).toBe(4); expect(cy.peak).toBe(5); expect(cy.seq).toEqual([5, 0, -5, 0]);
    expect(cy.start).toBeLessThan(cycles);
  });
  it('why it stops at 5: the rounded product |y| a2 comes back to |y| up to the dead band', () => {
    expect(deadBand(words.a2)).toBeCloseTo(5.13, 2);
    for (let y = 1; y <= 12; y++) expect(Math.floor((y * words.a2) / 2 ** 14 + 0.5) === y, `y = ${y}`).toBe(y <= Math.floor(deadBand(words.a2)));
  });
  it('the gates: same numbers every clock, and the pattern 5 0 -5 0 is still going at the end', () => {
    const ys = runGates('half-up', words, xs, new Biquad(words));
    expect(ys.slice(-8)).toEqual([5, 0, -5, 0, 5, 0, -5, 0]);
    expect(findCycle(ys, 16)!.period).toBe(4);
  });
  it('the same input into the toward-zero gates dies away', () => {
    const ys = runGates('zero', words, xs, new Biquad(words, { round: 'zero' }));
    expect(ys.slice(-8).every((v) => v === 0)).toBe(true);
    expect(ys.some((v) => Math.abs(v) > 100)).toBe(true);
  });
});

describe('what removes it, by a sweep of the model', () => {
  it('the counts the chapter quotes', () => {
    const r = cycleSweep();
    expect(r.runs).toBe(176);
    expect(r.cycling).toEqual([176, 59, 0, 22, 0]);
  });
  it('toward zero is not a cure: a pole at radius 0.998 sustains a cycle of 17 with period 12', () => {
    const c: Words = { b0: 1024, b1: 0, b2: 0, a1: -28873, a2: 16328 };
    const cy = findCycle(runBiquad(c, burstThenSilence(2972, 2, 4000), { round: 'zero' }), 16)!;
    expect(cy.period).toBe(12); expect(cy.peak).toBe(17);
    expect(Math.sqrt(c.a2 / 16384)).toBeGreaterThan(0.998);
  });
});
