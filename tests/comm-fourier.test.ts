// Chapters 45 and 46's Fourier: the harmonic sum through the pole against its closed form in time and against phys/line.ts's own
// waveform, Gibbs, Parseval, the FFT against the plain DFT, and an OFDM block's one complex tap per tone.
import { describe, expect, it } from 'vitest';
import { ADSL } from '../src/comm/modem';
import {
  aOf, blockOf, cx, dft, fft, fftMults, gibbsOvershoot, gibbsPeak, ofdmLink, PATTERNS, periodicStarts, poleAt, poleGain, powerShare, qpskErrors, randomQpsk, seriesOf, sumAt, swing1010, toDb,
  tauOf, throughPole, toneGains, toneOverlap, withPrefix,
} from '../src/comm/fourier';
import { eye, prbs, rng } from '../src/phys/line';
import { chCarriers } from '../src/chapters/ch-comm-carriers';
import { chModem } from '../src/chapters/ch-comm-modem';
import { chSerial } from '../src/chapters/ch-comm-serial';
import { chSignals } from '../src/chapters/ch-comm-signals';

const close = (a: number, b: number, e = 1e-9) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThan(e);
const symbols = randomQpsk;

describe('a pattern as harmonics', () => {
  it('a square wave\'s series is 4 / (π k) on the odd harmonics, nothing on the even', () => {
    const s = seriesOf([1, 0], 21);
    expect(s.dc).toBe(0);
    expect(s.harmonics.map((h) => h.k)).toEqual(Array.from({ length: 11 }, (_, i) => 2 * i + 1));
    for (const h of s.harmonics) close(h.amp, 4 / (Math.PI * h.k), 1e-12);
  });
  it('the sum of many harmonics is the pattern, away from its edges', () => {
    for (const { bits } of PATTERNS) {
      const n = bits.length, s = seriesOf(bits, 4000);
      for (let i = 0; i < n; i++) close(sumAt(s, n, i + 0.5), bits[i] ? 1 : -1, 2e-2);
    }
  });
  it('Parseval: the power of ±1 NRZ is 1, all of it in the DC term and the harmonics', () => {
    for (const { bits } of PATTERNS) {
      const s = seriesOf(bits, 20000);
      close(s.dc ** 2 + s.harmonics.reduce((a, h) => a + h.amp ** 2 / 2, 0), 1, 1e-3);
    }
  });
  it('the fundamental holds 81 % of a square wave\'s power, three harmonics 93 %, and the series sums to 1', () => {
    close(powerShare(1), 8 / Math.PI ** 2);
    expect(powerShare(1)).toBeCloseTo(0.811, 3);
    expect(powerShare(3)).toBeCloseTo(0.933, 3);
    expect(powerShare(100000)).toBeCloseTo(1, 4);
  });
  it('Gibbs: the first peak stays near 1.18 however many harmonics are kept, an overshoot of 8.95 % of the step', () => {
    expect(gibbsOvershoot(1000)).toBeCloseTo(0.0895, 3);
    expect(gibbsPeak(1000)).toBeCloseTo(1.179, 3);
    for (const n of [5, 20, 80]) {
      const s = seriesOf([1, 0], 2 * n), peak = Math.max(...Array.from({ length: 4000 }, (_, i) => sumAt(s, 2, (i / 4000) * 0.5)));
      close(peak, gibbsPeak(n), 1e-4);
      expect(gibbsOvershoot(n)).toBeGreaterThan(0.089);
      expect(gibbsOvershoot(n)).toBeLessThan(0.095);
    }
  });
});

describe('through the pole', () => {
  it('the harmonics scaled and turned one by one equal the closed-form periodic response', () => {
    for (const { bits } of PATTERNS) for (const [r, b] of [[6, 1], [8, 1], [2, 4], [16, 0.5]]) {
      const n = bits.length, s = throughPole(seriesOf(bits, 20000), n, r, b);
      for (let t = 0.03; t < n; t += 0.37) close(sumAt(s, n, t), poleAt(bits, r, b, t), 2e-3);
    }
  });
  it('agrees with phys/line.ts: the eye of the same channel on PRBS-9 opens 2 (1 − 2a), and the 1010 swing is (1 − a) / (1 + a)', () => {
    const r = 6, b = 1, a = aOf(r, b);
    expect(a).toBeCloseTo(Math.exp((-2 * Math.PI * b) / r), 12);
    close(eye(prbs(9, 1022), { rate: r, bandwidth: b }).opening, 2 * (1 - 2 * a), 0.02);
    const ys = periodicStarts([1, 0], a);
    close(ys[0], -swing1010(a), 1e-12);
    close(ys[1], swing1010(a), 1e-12);
  });
  it('the 1010 tone at Nyquist is a first estimate of its swing: 4/π × the pole\'s gain, within 20 % at 4 to 10 Gb/s on 1 GHz', () => {
    for (const r of [4, 6, 8, 10]) {
      const a = aOf(r, 1), est = (4 / Math.PI) * poleGain(r / 2, 1);
      expect(Math.abs(est - swing1010(a)) / swing1010(a)).toBeLessThan(0.2);
    }
  });
  it('one 1 in eight is the eye\'s worst case: its sample is 1 − 2a, to within a⁷', () => {
    const r = 8, b = 1, a = aOf(r, b), bits = [1, 0, 0, 0, 0, 0, 0, 0];
    expect(Math.abs(poleAt(bits, r, b, 1 - 1e-9) - (1 - 2 * a))).toBeLessThan(2 * a ** 7);
    expect(a).toBeCloseTo(0.456, 3);
    expect(1 - 2 * a).toBeCloseTo(0.088, 3);
    expect(swing1010(a)).toBeCloseTo(0.374, 3);
  });
  it('a pole of 1 GHz rises 10 % to 90 % in ln 9 · τ = 350 ps', () => {
    expect(Math.log(9) * tauOf(1)).toBeCloseTo(0.35, 2);
  });
  it('a flat channel keeps every shape; the pole\'s unequal gains are the ISI: a long run reaches full swing, 1010 does not', () => {
    const a = aOf(8, 1);
    expect(swing1010(a)).toBeLessThan(0.5);
    close(poleAt([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0], 8, 1, 8 - 1e-9), 1 - 2 * a ** 8 / (1 + a ** 8), 1e-6);
    expect(poleGain(0.01, 1)).toBeCloseTo(1, 3);
    expect(poleGain(1, 1)).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('the FFT', () => {
  it('equals the plain DFT, forward and inverse, and counts N/2 log2 N butterflies', () => {
    const u = rng(45);
    for (const N of [2, 4, 8, 32, 64, 256]) {
      const x = cx(Array.from({ length: N }, () => u() - 0.5), Array.from({ length: N }, () => u() - 0.5));
      const a = dft(x), b = fft(x);
      expect(b.mults).toBe(fftMults(N));
      for (let k = 0; k < N; k++) { close(a.re[k], b.re[k], 1e-9); close(a.im[k], b.im[k], 1e-9); }
      const back = fft(b, true);
      for (let k = 0; k < N; k++) { close(back.re[k], x.re[k], 1e-10); close(back.im[k], x.im[k], 1e-10); }
    }
    expect(() => fft(cx([1, 2, 3]))).toThrow();
  });
  it('Parseval: Σ|x|² = Σ|X|² / N', () => {
    const u = rng(7), N = 128, x = cx(Array.from({ length: N }, () => u() - 0.5)), X = fft(x);
    close(x.re.reduce((a, v) => a + v * v, 0), X.re.reduce((a, v, i) => a + v * v + X.im[i] ** 2, 0) / N, 1e-9);
  });
  it('a tone over a block overlaps every other tone in zero, itself in N', () => {
    const N = 64;
    for (const [k, m] of [[3, 3], [3, 4], [1, 31], [10, 54]]) {
      const o = toneOverlap(k, m, N);
      close(o.re, k === m ? N : 0, 1e-9);
      close(o.im, 0, 1e-9);
    }
  });
  it('agrees with chapter 45: ADSL\'s 512 points cost 2304 multiplications a symbol against 262 144, 9.2 million a second each way', () => {
    const N = ADSL.tones * 2;
    expect(fftMults(N)).toBe((ADSL.tones * 2) / 2 * Math.log2(ADSL.tones * 2));
    expect(fftMults(N)).toBe(2304);
    expect(N * N).toBe(262144);
    expect(fftMults(N) * ADSL.symbolRate).toBe(9216000);
    expect(N * N / fftMults(N)).toBeCloseTo(113.8, 1);
  });
});

describe('a block of tones', () => {
  const N = 64, TONES = 31, taps = [1, 0, 0, 0, 0, 0.6, 0, 0, -0.3];
  it('N points carry N/2 − 1 tones as a real block; the FFT gives them back', () => {
    const sy = symbols(TONES, 3), b = blockOf(sy, N), X = fft(cx(b));
    sy.forEach(([a, c], i) => { close(X.re[i + 1], a, 1e-10); close(X.im[i + 1], c, 1e-10); });
    close(X.re[0], 0, 1e-10); close(X.re[N / 2], 0, 1e-10);
    expect(() => blockOf(symbols(TONES + 1, 3), N)).toThrow();
  });
  it('a prefix copies the block\'s tail', () => {
    const b = blockOf(symbols(TONES, 5), N), w = withPrefix(b, 8);
    expect(w.length).toBe(N + 8);
    for (let i = 0; i < 8; i++) expect(w[i]).toBe(b[N - 8 + i]);
  });
  it('with a prefix as long as the echo every tone sees one complex tap, exactly: raw = H[k] X[k], and the equalized block has no error', () => {
    for (const cp of [8, 12, 16]) {
      const sy = symbols(TONES, 11), r = ofdmLink(sy, symbols(TONES, 12), N, cp, taps), H = toneGains(taps, N);
      expect(r.evm).toBeLessThan(1e-9);
      sy.forEach(([a, c], i) => {
        const k = i + 1;
        close(r.raw[i][0], H.re[k] * a - H.im[k] * c, 1e-9);
        close(r.raw[i][1], H.re[k] * c + H.im[k] * a, 1e-9);
      });
      expect(qpskErrors(sy, r.equalized)).toBe(0);
    }
  });
  it('a prefix too short leaves the previous block and the lost wrap-around in as interference on every tone', () => {
    const sy = symbols(TONES, 11), prev = symbols(TONES, 12);
    const short = ofdmLink(sy, prev, N, 7, taps), none = ofdmLink(sy, prev, N, 0, taps);
    expect(short.evm).toBeGreaterThan(0.01);
    expect(none.evm).toBeGreaterThan(short.evm);
    expect(none.evm).toBeGreaterThan(0.15);
  });
  it('a flat channel needs no prefix', () => {
    const sy = symbols(TONES, 2);
    expect(ofdmLink(sy, symbols(TONES, 1), N, 0, [0.5]).evm).toBeLessThan(1e-9);
  });
});

describe('the steps the chapters add', () => {
  it('the signals chapter opens on the harmonics, Many carriers on the FFT, each a widget with a challenge', () => {
    const stS = chSignals.steps[0], iM = chCarriers.steps.findIndex((s) => s.title === 'Many tones, one FFT');
    expect(stS.title).toBe('A wave is a sum of sines');
    expect(chCarriers.steps[5].title).toBe('ADSL: many carriers');
    expect(chSerial.steps).toHaveLength(9);
    expect(chModem.steps).toHaveLength(7);
    for (const st of [stS, chCarriers.steps[iM]]) expect(!!st.widget && !!st.challenge).toBe(true);
  });
  it('ADSL\'s spacing, a prefix of 32 in 544 samples and one sync block in 69 give exactly 4000 symbols a second', () => {
    expect((ADSL.spacingHz * 512) / 544 * (68 / 69)).toBeCloseTo(ADSL.symbolRate, 6);
    expect(ADSL.spacingHz * 512).toBe(2208000);
  });
  it('the worked figures of the steps', () => {
    expect(toDb(poleGain(4, 1))).toBeCloseTo(-12.3, 1);
    expect(toDb(poleGain(12, 1))).toBeCloseTo(-21.6, 1);
    const sy = randomQpsk(31, 1), pv = randomQpsk(31, 1001), taps = [1, 0, 0, 0, 0, 0.6];
    expect(ofdmLink(sy, pv, 64, 5, taps).evm).toBeLessThan(1e-9);
    expect(ofdmLink(sy, pv, 64, 4, taps).evm).toBeGreaterThan(1e-3);
    expect(ofdmLink(sy, pv, 64, 0, taps).evm).toBeGreaterThan(0.1);
  });
});
