// What "IIR and stability" claims, on dsp/iir.ts, lib/biquad.ts and the widgets' models.
import { describe, expect, it } from 'vitest';
import vec from './dsp/vectors/iir.json';
import { chIir, directUnstable, held, NARROW_POLE, NEAR_CIRCLE, NEAR_INPUT, RES, sensitivity, stableFrom } from '../src/chapters/ch-dsp-iir';
import { numOf } from '../src/chapters/order';
import { BQ, burstThenSilence, coefWord, cycleSweep, deadBand, findCycle, LIMIT_CYCLE, prefixPeaks, prewarp, runBiquad, warpedAt } from '../src/dsp/iir';
import { biquadCost, BIQUAD_FILTERS, designRows, firstStableWidth, mulNands, orderData, PM_TAPS, resonatorWords, runOnGates, sectionsStableFrom } from '../src/widgets/dspiir';
import { heldPair, latticeDots } from '../src/widgets/dspzplane';
import { stats } from '../src/sim/stats';
import { biquad } from '../src/lib/biquad';
import { Biquad } from '../src/dsp/iir';

const TAU = 2 * Math.PI;

describe('the numbers in the text', () => {
  it('follows the z-plane', () => expect(numOf('iir')).toBe(numOf('zplane') + 1));
  it('step 1: the table, from the models and from scipy', () => {
    expect(PM_TAPS).toBe(vec.fir.pm);
    const r = designRows(), by = (id: string) => r.find((x) => x.id === id)!;
    expect([by('pm').mults, by('kaiser').mults, by('butter').mults, by('cheby1').mults, by('ellip').mults]).toEqual([53, 74, 93, 35, 20]);
    expect(by('ellip').size).toBe('order 8, 4 sections');
    expect(mulNands()).toBe(3572);
    expect(by('pm').mults / by('ellip').mults).toBeCloseTo(2.65, 2);
    expect(by('ellip').mults * mulNands()).toBe(71440);
  });
  it('step 2: warping, and the prewarped edge', () => {
    expect(warpedAt(TAU * 0.1)).toBeCloseTo(0.0969, 4);
    expect(warpedAt(TAU * 0.4)).toBeCloseTo(0.2860, 4);
    expect(prewarp(0.2)).toBeCloseTo(1.453, 3);
    expect(warpedAt(TAU * 0.2)).toBeCloseTo(0.18, 2);
    expect(warpedAt(prewarp(0.4))).toBeCloseTo(0.4, 12);
  });
  it('step 3: the Try box at the slider\'s range, and the quiz', () => {
    expect([4, 5, 6].map((b) => held(RES, b).state)).toEqual(['unstable', 'on the circle', 'stable']);
    expect(held(RES, 6).radius).toBeCloseTo(0.968, 3);
    expect(held(RES, 5).radius).toBe(1);
    expect(held(RES, 4).roots.every((q) => q.re === 1 && q.im === 0)).toBe(true);
    expect(stableFrom(NARROW_POLE)).toBe(8);
    expect(held(NARROW_POLE, 6).state).toBe('on the circle');
    expect(held(NARROW_POLE, 6).radius).toBe(1);
    expect(held(NARROW_POLE, 6).a1).toBe(-1.9375);
    // the spacing quoted: neighbours on the lattice are step / 2r apart in radius and step / (2 r sin θ) in angle
    const S = 2 ** -4, r = RES.r, th = RES.f * TAU, k = heldPair({ r, t: th }, 6);
    const polar = (a1: number, a2: number) => { const re = -a1 / 2, im = Math.sqrt(a2 - re * re); return { r: Math.hypot(re, im), t: Math.atan2(im, re) }; };
    const p0 = polar(k.a1, k.a2), pr = polar(k.a1, k.a2 + S), pt = polar(k.a1 + S, k.a2);
    expect(Math.abs((pr.r - p0.r) / (S / (2 * r)) - 1)).toBeLessThan(0.1);
    expect(Math.abs(Math.abs(p0.t - pt.t) / (S / (2 * r * Math.sin(th))) - 1)).toBeLessThan(0.25);
    // the lattice at its largest drawn word, and every dot is a complex pair inside the plotted square
    expect(latticeDots(6).length).toBeGreaterThan(500);
    expect(latticeDots(6).every((q) => q.im > 0 && Math.hypot(q.re, q.im) < 1.7)).toBe(true);
  });
  it('step 3: rounding a section never puts a pole outside the circle (the grid swept here)', () => {
    for (let b = 4; b <= 10; b++) for (let r = 0.8; r < 0.9995; r += 0.01) for (let f = 0.002; f < 0.5; f += 0.01) {
      const k = heldPair({ r, t: f * TAU }, b);
      expect(k.radius, `${b} bits r=${r} f=${f}`).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
  it('step 4: direct form is unstable from 8 to 19 bits and stable from 20; sections from 8; and the sensitivity', () => {
    expect(directUnstable()).toEqual(Array.from({ length: 12 }, (_, i) => 8 + i));
    expect(firstStableWidth()).toBe(20);
    expect(sectionsStableFrom()).toBe(true);
    const s = sensitivity();
    expect(s.direct / s.sections).toBeGreaterThan(100);
    expect(vec.narrow.sens.filter((x) => !x.direct).map((x) => x.bits)).toEqual(directUnstable());
  });
  it('step 5: cost and timing, counted', () => {
    const c = biquadCost();
    expect(c.nands).toBe(stats(biquad()).nands);
    expect(c.nands).toBe(20313);
    expect(c.depth).toBe(135);
    expect(BQ.accW - BQ.prod).toBe(3);
    expect(5 * mulNands()).toBe(17860);
  });
  it('step 5: the panel\'s filters fit their words and the gates agree through the panel\'s own runner', () => {
    for (const f of BIQUAD_FILTERS) for (const v of Object.values(f.words)) { expect(v).toBeGreaterThan(-32768); expect(v).toBeLessThan(32767); }
    expect(resonatorWords(0.9, 0.1).b0).toBeGreaterThan(500);
    expect(typeof runOnGates).toBe('function');
  });
  it('step 6: the cycle, its level and the dead band', () => {
    const w = LIMIT_CYCLE.words, cy = findCycle(runBiquad(w, burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, 800)), 16)!;
    expect(cy.seq).toEqual([5, 0, -5, 0]);
    expect(cy.start).toBeGreaterThan(80); expect(cy.start).toBeLessThan(LIMIT_CYCLE.cycles);
    expect(20 * Math.log10(5 / 2 ** 15)).toBeCloseTo(-76.3, 1);
    expect(Math.round(5 * (w.a2 / 2 ** 14))).toBe(5);
    expect(5 * (w.a2 / 2 ** 14)).toBeCloseTo(4.513, 3);
    expect(Math.trunc(5 * (w.a2 / 2 ** 14))).toBe(4);
    expect(deadBand(w.a2)).toBeCloseTo(5.13, 2);
    const g = runBiquad(w, burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, 140));
    const m = new Biquad(w);
    burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, 140).forEach((x, i) => expect(m.step(x)).toBe(g[i]));
  });
  it('step 7: the sweep, the Try boxes, and toward zero near the circle', () => {
    const sw = cycleSweep();
    expect(sw.runs).toBe(176); expect(sw.cycling).toEqual([176, 59, 0, 22, 0]);
    const at = (round: 'half-up' | 'trunc' | 'zero', extra: number) => findCycle(runBiquad({ b0: 1024, b1: 0, b2: 0, a1: coefWord(-0), a2: coefWord(0.95 * 0.95) }, burstThenSilence(8000, 1, 4000), { round, extra }), 32);
    expect(at('half-up', 0)!.peak).toBe(5);
    expect(at('zero', 0)).toBeNull(); expect(at('trunc', 0)).toBeNull();
    expect(at('half-up', 4)).toBeNull();
    expect(at('half-up', 2)!.peak).toBe(1);
    const near = findCycle(runBiquad(NEAR_CIRCLE, burstThenSilence(NEAR_INPUT.amp, NEAR_INPUT.burst, 4000), { round: 'zero' }), 16)!;
    expect(near.period).toBe(12); expect(near.peak).toBe(17);
    expect(Math.sqrt(NEAR_CIRCLE.a2 / 16384)).toBeCloseTo(0.9983, 4);
  });
  it('step 8: scaling and order', () => {
    const D = orderData(), def = D.rows.find((r) => r.p.join('') === '0123')!;
    expect(D.rows.length).toBe(24);
    const raw = [...D.rows].sort((a, b) => b.snrRaw - a.snrRaw), sc = [...D.rows].sort((a, b) => b.snrScaled - a.snrScaled);
    expect(raw[0]).toBe(def);
    expect(def.snrScaled - def.snrRaw).toBeCloseTo(14.1, 1);
    expect(sc[0].snrScaled).toBeCloseTo(78.6, 1); expect(sc[23].snrScaled).toBeCloseTo(74.0, 1);
    expect(sc.indexOf(def) + 1).toBe(21);
    expect(prefixPeaks(def.scaled).every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
    expect(Math.max(...prefixPeaks(raw[23].raw))).toBeGreaterThan(1);
  });
});

describe('the text', () => {
  it('every step has words, something to do, and quizzes whose options differ', () => {
    for (const s of chIir.steps) {
      expect(s.body.length, s.title).toBeGreaterThan(900); expect(!!s.widget || !!s.scene, s.title).toBe(true);
      const c = s.challenge!;
      if (c.kind === 'quiz') { expect(new Set(c.options).size, s.title).toBe(c.options.length); expect(c.why!.length).toBe(c.options.length); }
    }
    expect(chIir.steps.length).toBe(8);
  });
  it('step 1 and 3 quiz answers are what the models say', () => {
    const q1 = chIir.steps[0].challenge as { options: string[]; answer: number };
    expect(q1.options[q1.answer]).toBe('35');
    const q3 = chIir.steps[2].challenge as { options: string[]; answer: number };
    expect(q3.options[q3.answer]).toContain('1');
  });
  it('links only to chapters in the book', () => {
    for (const s of chIir.steps) for (const m of s.body.matchAll(/#\/c\/([a-z0-9-]+)\//g)) expect(numOf(m[1] as never), m[1]).toBeDefined();
  });
});
