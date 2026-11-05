// FIR design: dsp/firdesign.ts against scipy (tests/dsp/vectors/firdesign.json, scripts/dsp/oracle.py) and against the mask each design is built for;
// then lib/firmac.ts, the time-shared FIR in gates, against dsp/firdesign.ts's MacModel every cycle.
import { describe, expect, it } from 'vitest';
import vec from './dsp/vectors/firdesign.json';
import {
  binaryDigits, csdAdders, csdMul, csdOf, csdValue, deltaPass, deltaStop, dB, directFir, fewestFrac, fewestTaps, firwinLowpass, foldedFir, foldedMults, isSymmetric,
  kaiserDesign, kaiserLengthEstimate, kaiserord, magnitudeGrid, MASK, maskReport, remez, remezLowpass, tapValues, tapWords, transposedFir, windowOf, widestFrac,
  type WindowKind,
} from '../src/dsp/firdesign';
import { gainAt } from '../src/dsp/zplane';

const maxDiff = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe('Parks–McClellan against scipy.signal.remez', () => {
  for (const c of vec.remez) {
    it(c.name, () => {
      const r = remez(c.numtaps, c.edges, c.desired, c.weight);
      expect(r.converged).toBe(true);
      expect(r.taps.length).toBe(c.numtaps);
      expect(maxDiff(r.taps, c.taps) / Math.max(...c.taps.map(Math.abs))).toBeLessThan(1e-9);
      expect(isSymmetric(r.taps), 'symmetric to the last bit').toBe(true);
    });
  }
  it('the mask designs, at 114 and 115 taps', () => {
    for (const [n, ref] of [[114, vec.mask114], [115, vec.mask115]] as const) {
      const r = remezLowpass(n);
      expect(maxDiff(r.taps, ref.taps)).toBeLessThan(1e-10);
      const m = maskReport(r.taps);
      expect(m.passDev).toBeCloseTo(ref.passDev, 10); expect(m.stopPeak).toBeCloseTo(ref.stopPeak, 10);
    }
  });
  it('equiripple: the converged error is the same size at every extremal frequency, and delta is the weighted ripple', () => {
    const r = remezLowpass(115), dp = deltaPass(MASK);
    expect(r.extremal.length).toBe(59);
    // the passband ripple is delta / weight = delta · δp, to the grid's resolution (the exchange's grid is coarser than the check's)
    expect(Math.abs(maskReport(r.taps).passDev / (r.delta * dp) - 1)).toBeLessThan(0.01);
  });
});

describe('the mask', () => {
  it('is 0.20 and 0.25 of Nyquist, in cycles a sample', () => { expect(MASK.pass).toBeCloseTo(0.1, 12); expect(MASK.stop).toBeCloseTo(0.125, 12); });
  it('0.1 dB peak to peak is δp = 0.00576, and 60 dB is δs = 0.001', () => {
    expect(deltaPass(MASK)).toBeCloseTo(vec.mask.deltaPass, 12); expect(deltaPass(MASK)).toBeCloseTo(0.005756, 6);
    expect(deltaStop(MASK)).toBeCloseTo(0.001, 12);
    expect(dB((1 + deltaPass(MASK)) / (1 - deltaPass(MASK)))).toBeCloseTo(0.1, 12);
  });
  it('the fewest taps are 114, an even length; 113 does not meet it and 115 does', () => {
    const f = fewestTaps((n) => remezLowpass(n).taps, MASK, 60, 140)!;
    expect(f.n).toBe(vec.fewest.remez); expect(f.n).toBe(114);
    expect(maskReport(remezLowpass(113).taps).ok).toBe(false);
    expect(maskReport(remezLowpass(113).taps).stopPeak).toBeCloseTo(vec.fewest.remezOneFewer.stopPeak, 10);
    expect(maskReport(remezLowpass(115).taps).ok).toBe(true);
  });
  it('the mask check and scipy read the same grid: magnitudes at the same frequencies', () => {
    const mag = magnitudeGrid(vec.mask115.taps);
    vec.freqz.f.forEach((f, i) => expect(gainAt(vec.mask115.taps, [1], f)).toBeCloseTo(vec.freqz.gain115[i], 9));
    expect(mag[0]).toBeCloseTo(vec.freqz.gain115[0], 9);
  });
});

describe('the window method against scipy.signal.firwin', () => {
  for (const w of vec.windows) it(w.kind, () => expect(maxDiff(firwinLowpass(31, 0.2, w.kind as WindowKind, w.beta), w.taps)).toBeLessThan(1e-11));
  it('kaiserord: 147 taps and β = 5.65326 for 60 dB over 0.025 cycles', () => {
    const k = kaiserord(60, (MASK.stop - MASK.pass) / 0.5);
    expect(k.numtaps).toBe(vec.fewest.kaiserord); expect(k.numtaps).toBe(147);
    expect(k.beta).toBeCloseTo(vec.fewest.beta, 9);
  });
  it('the Kaiser design meets the mask at 147 taps; the fewest found by search is 146', () => {
    const k = kaiserDesign();
    expect(k.numtaps).toBe(147);
    expect(maxDiff(k.taps, vec.kaiser.taps)).toBeLessThan(1e-11);
    expect(maskReport(k.taps).ok).toBe(true);
    const f = fewestTaps((n) => kaiserDesign(MASK).numtaps === n ? k.taps : (() => { const { beta } = kaiserDesign(MASK); return firwinLowpass(n, (MASK.pass + MASK.stop) / 2, 'kaiser', beta); })(), MASK, 120, 160)!;
    expect(f.n).toBe(vec.fewest.kaiser);
  });
  it('the window cannot spend the passband it is allowed: both bands get about the same ripple', () => {
    const m = maskReport(kaiserDesign().taps);
    expect(m.passDev / m.stopPeak).toBeGreaterThan(0.8); expect(m.passDev / m.stopPeak).toBeLessThan(1.6);
    expect(m.passDev, 'far under the 0.00576 it is allowed').toBeLessThan(deltaPass(MASK) / 4);
    const p = maskReport(remezLowpass(115).taps);
    expect(p.passDev / p.stopPeak, 'Parks–McClellan spends it').toBeGreaterThan(5);
  });
  it('windows are symmetric and peak at the middle', () => {
    for (const k of ['hann', 'hamming', 'blackman', 'kaiser'] as const) {
      const w = windowOf(k, 31, 6);
      expect(isSymmetric(w, 1e-12)).toBe(true); expect(w[15]).toBeCloseTo(1, 12);
    }
  });
  it('Kaiser\'s length formula is an estimate: under the true 114', () => {
    const est = kaiserLengthEstimate(deltaPass(MASK), deltaStop(MASK), MASK.stop - MASK.pass);
    expect(est).toBeLessThan(114); expect(est).toBeGreaterThan(100);
  });
});

describe('tap words', () => {
  it('rounding to Q1.15 breaks the 60 dB, and two spare bits repair it', () => {
    const h = remezLowpass(115).taps;
    for (const [frac, ref] of Object.entries(vec.quantized115)) {
      const m = maskReport(tapValues(tapWords(h, Number(frac), 40), Number(frac)));
      expect(m.stopPeak, `${frac} bits`).toBeCloseTo(ref.stopPeak, 9);
    }
    expect(maskReport(tapValues(tapWords(h, 15, 16), 15)).stopOk).toBe(false);
    expect(maskReport(tapValues(tapWords(h, 17, 16), 17)).ok).toBe(true);
    expect(fewestFrac(h)!.frac).toBe(vec.fewest.fewestFrac); expect(fewestFrac(h)!.bits).toBe(16);
    expect(widestFrac(h, 16), 'the largest tap leaves two bits to spare').toBe(17);
  });
});

describe('three structures, one filter', () => {
  const taps = vec.lfilter.taps.map(Math.round), x = vec.lfilter.x;
  it('direct form is scipy.signal.lfilter on integers', () => { expect(directFir(taps, x)).toEqual(vec.lfilter.y); });
  it('folding adds the pair first and gives the same sums, in half the multiplications', () => {
    expect(isSymmetric(taps, 1)).toBe(true);
    const sym = taps.map((_, i) => taps[Math.min(i, taps.length - 1 - i)]);
    expect(foldedFir(sym, x)).toEqual(directFir(sym, x));
    expect(foldedMults(115)).toBe(58); expect(foldedMults(114)).toBe(57);
  });
  it('transposed form gives the same sums', () => { expect(transposedFir(taps, x)).toEqual(directFir(taps, x)); });
});

describe('canonical signed digits', () => {
  it('every integer from −2000 to 2000: the digits add up, none sit side by side, never more than binary', () => {
    for (let c = -2000; c <= 2000; c++) {
      const t = csdOf(c);
      expect(csdValue(t), String(c)).toBe(c);
      for (let i = 1; i < t.length; i++) expect(t[i].pos - t[i - 1].pos, String(c)).toBeGreaterThanOrEqual(2);
      expect(t.length, String(c)).toBeLessThanOrEqual(binaryDigits(c));
      expect(csdMul(c, 37)).toBe(c * 37);
    }
  });
  it('255 is 256 − 1: two digits for eight', () => { expect(csdOf(255).length).toBe(2); expect(binaryDigits(255)).toBe(8); expect(csdAdders(255)).toBe(1); });
  it('zero has no digits, and a lone negative digit still needs a negation', () => { expect(csdOf(0)).toEqual([]); expect(csdAdders(0)).toBe(0); expect(csdAdders(-8)).toBe(1); expect(csdAdders(8)).toBe(0); });
});
