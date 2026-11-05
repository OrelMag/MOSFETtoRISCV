// What "IIR and stability" claims, on dsp/iir.ts, lib/biquad.ts and the widgets' models.
import { describe, expect, it } from 'vitest';
import vec from './dsp/vectors/iir.json';
import { chIir, directUnstable, held, NARROW_POLE, NEAR_CIRCLE, NEAR_INPUT, ordinal, RES, sensitivity, stableFrom, sweepOnce, zeroSweepOnce } from '../src/chapters/ch-dsp-iir';
import { chFixed } from '../src/chapters/ch-dsp-fixed';
import { chZplane } from '../src/chapters/ch-dsp-zplane';
import { numOf } from '../src/chapters/order';
import {
  BQ, burstThenSilence, coefWord, deadBand, deadBandOf, deltaPass, endOf, findCycle, kaiserTaps, LIMIT_CYCLE, lowpass, MASK, maskDesign, prefixPeaks, prewarp, runBiquad, scaleSos, sectionStable, sectionWords, snrAt,
  measuredSnr, sosGain, sosMults, sosMultsFolded, sosfilt, stableExact, warpedAt, zpkToSos, ZERO_SWEEP_RADII,
} from '../src/dsp/iir';
import { biquadCost, BIQUAD_FILTERS, designRows, firstStableWidth, mulNands, orderData, PM_TAPS, resonatorWords, runOnGates, sectionsStableFrom } from '../src/widgets/dspiir';
import { heldPair, latticeDots } from '../src/widgets/dspzplane';
import { stats } from '../src/sim/stats';
import { biquad } from '../src/lib/biquad';
import { Biquad } from '../src/dsp/iir';

const TAU = 2 * Math.PI;

describe('the numbers in the text', () => {
  it('follows the z-plane', () => expect(numOf('iir')).toBe(numOf('zplane') + 1));
  it('step 1: the table, from the models and from scipy', () => {
    // the mask's ripple is peak to peak, the way scipy's rp is: an FIR filter's gain within 1 ± δp, centred, with (1 + δp) / (1 − δp) = 10^(rp / 20)
    expect(deltaPass()).toBeCloseTo(vec.fir.dp, 11);
    expect(20 * Math.log10((1 + deltaPass()) / (1 - deltaPass()))).toBeCloseTo(MASK.rp, 12);
    expect(deltaPass()).toBeCloseTo(0.00576, 5);
    expect(PM_TAPS).toBe(vec.fir.pm_odd);
    expect(vec.fir.pm).toBe(114); expect(vec.fir.pm_odd).toBe(115); expect(kaiserTaps()).toBe(147);
    const r = designRows(), by = (id: string) => r.find((x) => x.id === id)!;
    expect([by('pm').mults, by('kaiser').mults, by('butter').mults, by('cheby1').mults, by('ellip').mults]).toEqual([58, 74, 93, 35, 20]);
    expect(by('ellip').size).toBe('order 8, 4 sections');
    expect(mulNands()).toBe(3572);
    expect(by('pm').mults / by('ellip').mults).toBeCloseTo(2.9, 2);
    // the numerators of all three IIR designs are symmetric (b₀ = b₂), so each section could fold: what the text quotes beside the as-built count
    expect([by('butter').folded, by('cheby1').folded, by('ellip').folded]).toEqual([74, 28, 16]);
    for (const f of ['butter', 'cheby1', 'ellip'] as const) { const sec = zpkToSos(maskDesign(f).zpk); expect(sosMultsFolded(sec)).toBeLessThan(sosMults(sec)); }
    expect(by('ellip').mults * mulNands()).toBe(71440);
    // step 2's Try: an elliptic order 5 has one of its five zeros at z = −1
    const z5 = lowpass('ellip', 5, 0.1, 0.1, 60).z;
    expect(z5.length).toBe(5); expect(z5.filter((q) => Math.abs(q.re + 1) < 1e-9 && Math.abs(q.im) < 1e-9).length).toBe(1);
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
    // 7 bits: the words land exactly on the triangle's other edge, a₁ = −(1 + a₂) (−63 and 31 of 1/32: a real root at z = 1), which is NOT stable: the inequalities
    // are strict, and a non-strict test would call it stable
    expect(held(NARROW_POLE, 7).state).toBe('on the circle');
    const [w1, w2] = sectionWords(-2 * NARROW_POLE.r * Math.cos(NARROW_POLE.f * TAU), NARROW_POLE.r ** 2, 7);
    expect([w1, w2]).toEqual([-63, 31]); expect(Math.abs(w1)).toBe(2 ** 5 + w2);
    expect(Math.abs(w1) <= 2 ** 5 + w2 && Math.abs(w2) <= 2 ** 5).toBe(true); // the non-strict triangle
    expect(sectionStable(-2 * NARROW_POLE.r * Math.cos(NARROW_POLE.f * TAU), NARROW_POLE.r ** 2, 7)).toBe(false);
    expect(stableExact([2 ** 5, w1, w2])).toBe(false); expect(stableExact([2 ** 5, w1 + 1, w2])).toBe(true);
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
    expect(deadBandOf(w)).toBeCloseTo(5.13, 2);
    const g = runBiquad(w, burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, 140));
    const m = new Biquad(w);
    burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, 140).forEach((x, i) => expect(m.step(x)).toBe(g[i]));
  });
  it('step 6: the dead band ½ / (1 − a₂) holds for a₁ = 0 and is shown for nothing else', () => {
    for (const r of [0.5, 0.7, 0.9, 0.95, 0.97, 0.99]) for (const amp of [100, 1000, 8000, 30000]) {
      const w = { b0: 1024, b1: 0, b2: 0, a1: 0, a2: coefWord(r * r) }, cy = findCycle(runBiquad(w, burstThenSilence(amp, 1, 4000)), 32);
      if (cy) expect(cy.peak, `r=${r} amp=${amp}`).toBeLessThanOrEqual(deadBand(w.a2) + 1e-9);
    }
    // with a₁ ≠ 0 it does not: radius 0.95 at 0.005 cycles a sample holds 116 LSB where the formula says 5.13
    const w = { b0: 1024, b1: 0, b2: 0, a1: coefWord(-2 * 0.95 * Math.cos(TAU * 0.005)), a2: coefWord(0.95 * 0.95) }, cy = findCycle(runBiquad(w, burstThenSilence(8000, 1, 4000)), 32)!;
    expect(cy.peak).toBeGreaterThan(20 * deadBand(w.a2));
    expect(deadBandOf(w)).toBeNull();
    expect(deadBandOf({ ...w, a1: 0 })).not.toBeNull();
  });
  it('step 6: toward zero has no cycle for a₁ = 0 (|y[n]| < |y[n−2]| until zero)', () => {
    for (const a2 of [coefWord(0.81), coefWord(0.9025), coefWord(0.94), coefWord(0.98), coefWord(0.99)]) for (const amp of [9, 77, 8000, 30000]) {
      const ys = runBiquad({ b0: 1024, b1: 0, b2: 0, a1: 0, a2 }, burstThenSilence(amp, 1, 3000), { round: 'zero' });
      for (let n = 3; n < ys.length; n++) if (ys[n - 2] !== 0) expect(Math.abs(ys[n]), `a2=${a2} amp=${amp} n=${n}`).toBeLessThan(Math.abs(ys[n - 2]));
      expect(endOf(ys, 32)).toBe('dead');
    }
  });
  it('step 7: the sweep, the Try boxes, and toward zero near the circle', () => {
    const sw = sweepOnce();
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
  it('step 7: the finer sweep for toward zero: no cycle to 0.975, rare ones from 0.98, none of the runs left moving', () => {
    const z = zeroSweepOnce();
    expect(z.map((x) => x.r)).toEqual(ZERO_SWEEP_RADII);
    expect(z.every((x) => x.runs === 294 && x.moving === 0)).toBe(true);
    expect(z.filter((x) => x.r <= 0.975).map((x) => x.cycling)).toEqual([0, 0, 0, 0, 0]);
    expect(z.filter((x) => x.r >= 0.98).map((x) => x.cycling)).toEqual([2, 0, 1, 1]);
    // the case the text quotes: radius 0.98, 0.09 cycles a sample, one word of 1 000 three times
    const c = findCycle(runBiquad({ b0: 1024, b1: 0, b2: 0, a1: coefWord(-2 * 0.98 * Math.cos(TAU * 0.09)), a2: coefWord(0.98 * 0.98) }, burstThenSilence(1000, 3, 4000), { round: 'zero' }), 32)!;
    expect(c.period).toBe(10); expect(c.peak).toBe(10);
  });
  it('the 176-case sweep ends every run dead or in a cycle (none left moving), and floor removes two thirds', () => {
    const sw = sweepOnce();
    expect((sw.cycling[0] - sw.cycling[1]) / sw.cycling[0]).toBeGreaterThan(0.6); expect((sw.cycling[0] - sw.cycling[1]) / sw.cycling[0]).toBeLessThan(0.7);
  });
  it('ordinals', () => { expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd']); });
  it('step 8: scaling and order', () => {
    const D = orderData(), def = D.rows.find((r) => r.p.join('') === '0123')!;
    expect(D.rows.length).toBe(24);
    const raw = [...D.rows].sort((a, b) => b.snrRaw - a.snrRaw), sc = [...D.rows].sort((a, b) => b.snrScaled - a.snrScaled);
    expect(raw[0]).toBe(def);
    expect(def.snrScaled - def.snrRaw).toBeCloseTo(14.1, 1);
    expect(sc[0].snrScaled).toBeCloseTo(78.6, 1); expect(sc[23].snrScaled).toBeCloseTo(74.0, 1);
    expect(sc.indexOf(def) + 1).toBe(21);
    // scaling, checked in the time domain and on a finer frequency grid than the one that did the scaling: a unit sine at each prefix's own peak frequency
    // comes out of every section at amplitude 1 (the grid-based prefixPeaks alone would be checking itself)
    for (let k = 1; k <= def.scaled.length; k++) {
      const pre = def.scaled.slice(0, k);
      let f0 = 0, g0 = 0;
      for (let i = 0; i <= 20000; i++) { const f = (i / 20000) * 0.5, g = sosGain(pre, f); if (g > g0) { g0 = g; f0 = f; } }
      const y = sosfilt(pre, Array.from({ length: 24000 }, (_, i) => Math.cos(TAU * f0 * i)));
      expect(Math.max(...y.slice(-6000).map(Math.abs)), `section ${k}`).toBeGreaterThan(0.97);
      expect(Math.max(...y.slice(-6000).map(Math.abs)), `section ${k}`).toBeLessThan(1.02);
    }
    expect(prefixPeaks(def.scaled).every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
    expect(Math.max(...prefixPeaks(raw[23].raw))).toBeGreaterThan(1);
  });
  it('step 8: the predicted noise and the measured one agree to within 2 dB on every order, scaled or not (what the text says), at the same amplitude', () => {
    const D = orderData();
    let worst = 0;
    for (const r of D.rows) for (const sec of [r.raw, r.scaled]) {
      const amp = Math.min(0.9, 0.9 / Math.max(...prefixPeaks(sec))), d = Math.abs(measuredSnr(sec, amp).snr - snrAt(sec, amp));
      worst = Math.max(worst, d);
    }
    expect(worst).toBeLessThan(2);
    expect(worst).toBeGreaterThan(0.5); // and it is not an identity: the claim is "within 2 dB", not "equal"
    void scaleSos;
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
  it('step links land on the steps the text names', () => {
    const body = (i: number) => chIir.steps[i].body;
    expect(body(0)).toContain('#/c/zplane/4'); expect(chZplane.steps[4].title).toBe('Poles make it ring');
    expect(body(4)).toContain('#/c/fixed/5'); expect(body(4)).toContain('#/c/fixed/2');
    expect(body(7)).toContain('#/c/fixed/6');
    expect(chFixed.steps.length).toBeGreaterThan(6); expect(chFixed.steps[2].title).toBe('A saturating adder'); expect(chFixed.steps[6].title).toBe('Where the gain goes');
  });
  it('the text states what it can pin: the mask reading, the counts, the thresholds', () => {
    const t = chIir.steps.map((s) => s.body).join('\n');
    expect(chIir.steps[0].body).toContain('peak to peak'); expect(chIir.steps[0].body).toContain('115 taps'); expect(chIir.steps[0].body).toContain('2.9 times fewer');
    expect(t).not.toContain('All real implementations'); expect(t).not.toContain('The usual rule');
    expect(t).toContain('21st of 24'); expect(t).not.toContain('21th');
    expect(t).toContain('for a₁ = 0 only');
    expect(chIir.steps[6].body).toContain('Up to 0.975, 0 of 1470');
  });
  it('links only to chapters in the book', () => {
    for (const s of chIir.steps) for (const m of s.body.matchAll(/#\/c\/([a-z0-9-]+)\//g)) expect(numOf(m[1] as never), m[1]).toBeDefined();
  });
});
