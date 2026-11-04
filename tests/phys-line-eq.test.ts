// phys/line.ts, the additions of chapter 46 against closed forms: the pulse response of the single pole, the CTLE that cancels
// it, a decision-feedback tap, transmit de-emphasis as a two-tap filter, and PAM4 (a third of the eye, 20 log 3 dB, the Gray
// symbol error rate 3/2 Q).

import { describe, expect, it } from 'vitest';
import { ctleNoiseGain, eye, eyePam, pam4Ber, PAM4_PENALTY_DB, pam4Symbols, prbs, pulseResponse, qFunc, rng, gaussian } from '../src/phys/line';

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
const ch = { rate: 1, bandwidth: 0.3, spu: 40 };
const a = Math.exp(-1000 / ch.rate / (1000 / (2 * Math.PI * ch.bandwidth)));   // one bit's decay of the pole
const bits = prbs(9, 3000);
/** The eye of the +1 / −1 levels at the last sample of the bit: the sampling instant a single pole prefers. */
const endOpening = (w: Float64Array, spu: number, b: ArrayLike<number>) => {
  let lo = Infinity, hi = -Infinity;
  for (let i = 30; i < b.length; i++) { const x = w[i * spu + spu - 1]; if (b[i]) lo = Math.min(lo, x); else hi = Math.max(hi, x); }
  return lo - hi;
};

describe('pulse response', () => {
  it('a bit through the pole: 1 − a^(t/UI) while it lasts, then a decay by a each bit', () => {
    const p = pulseResponse(ch, 4);
    near(p[39], 1 - a, 1e-9);
    near(p[79], (1 - a) * a, 1e-9);
    near(p[119], (1 - a) * a * a, 1e-9);
  });
  it('transmit de-emphasis is the two-tap filter (1 − de/2, −de/2)', () => {
    const q = pulseResponse({ ...ch, de: 0.4 }, 4), p = pulseResponse(ch, 4);
    for (let j = 0; j < 160; j++) near(q[j], 0.8 * p[j] - 0.2 * (j >= 40 ? p[j - 40] : 0), 1e-9);
  });
});

describe('eye of the single pole', () => {
  it('opening at the end of the bit is 2 (1 − 2a): the ISI of the earlier bits adds up to a', () => {
    const e = eye(bits, ch);
    near(endOpening(e.wave, 40, bits), 2 * (1 - 2 * a), 2e-3);
    near(e.opening, 2 * (1 - 2 * a), 2e-3);
  });
  it('one DFE tap removes the first post-cursor: 2 (1 − a − a²), and two taps 2 (1 − a − a³)', () => {
    near(endOpening(eye(bits, { ...ch, dfe: 1 }).wave, 40, bits), 2 * (1 - a - a * a), 2e-3);
    near(endOpening(eye(bits, { ...ch, dfe: 2 }).wave, 40, bits), 2 * ((1 - a) - a ** 3), 2e-3);
  });
  it('a CTLE with its zero on the channel pole is one pole at m × bandwidth', () => {
    const e1 = eye(bits, { ...ch, ctle: 3 }), e2 = eye(bits, { ...ch, bandwidth: 0.9 });
    near(e1.opening, e2.opening, 1e-9);
    expect(e1.opening).toBeGreaterThan(eye(bits, ch).opening);
  });
  it('the CTLE costs noise: gain at Nyquist is 1 with none, and rises with the peaking', () => {
    near(ctleNoiseGain(ch), 1, 1e-12);
    const g = ctleNoiseGain({ ...ch, ctle: 3 });
    near(g, Math.sqrt(1 + (0.5 / 0.3) ** 2) / Math.sqrt(1 + (0.5 / 0.9) ** 2), 1e-12);
    expect(g).toBeGreaterThan(1.5);
  });
  it('de-emphasis opens an ISI-limited eye', () => {
    const slow = { rate: 1, bandwidth: 0.15, spu: 40 };
    expect(eye(bits, { ...slow, de: 0.3 }).opening).toBeGreaterThan(eye(bits, slow).opening);
  });
});

describe('a cascade of poles', () => {
  it('two poles step like 1 − e^(−x) (1 + x), x = t / τ', () => {
    const tau = 1000 / (2 * Math.PI * 0.5), p = pulseResponse({ rate: 1, bandwidth: 0.5, poles: 2, spu: 100 }, 1);
    for (const j of [20, 50, 99]) { const x = ((j + 1) * 10) / tau; near(p[j], 1 - Math.exp(-x) * (1 + x), 1.5e-2); }
  });
});

describe('PAM4', () => {
  const wide = { rate: 1, bandwidth: 50, spu: 40 };
  const sym = pam4Symbols(bits);
  it('Gray pairs map to four levels, adjacent levels differing in one bit', () => {
    expect([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => pam4Symbols([x, y])[0])).toEqual([-1, -1 / 3, 1 / 3, 1]);
  });
  it('on a channel with no ISI each of the three eyes is a third of the NRZ eye: 2/3 against 2 (−9.54 dB)', () => {
    const p = eyePam(sym, [-1, -1 / 3, 1 / 3, 1], wide), n = eye(bits, wide);
    for (const o of p.openings) near(o, 2 / 3, 1e-3);
    near(n.opening / p.opening, 3, 1e-2);
    near(PAM4_PENALTY_DB, 9.5424, 1e-3);
  });
  it('one pole: both eyes close at the same bandwidth (a = 1/2 for NRZ, a² = 1/4 for PAM4 at half the baud): PAM4 has no edge', () => {
    const slow = 0.12, lv = [-1, -1 / 3, 1 / 3, 1];
    const nrz = eye(bits, { rate: 1, bandwidth: slow }), p = eyePam(sym, lv, { rate: 0.5, bandwidth: slow });
    const aN = Math.exp(-2 * Math.PI * slow), aP = aN * aN;
    near(nrz.opening, 2 * (1 - 2 * aN), 3e-2);
    // the ISI of earlier symbols is up to ±a whatever the spacing: the gap is (1 − a) · 2/3 − 2a
    near(p.opening, 2 / 3 - (8 / 3) * aP, 3e-2);
    for (const bw of [0.09, 0.105, 0.11]) {
      expect(eye(bits, { rate: 1, bandwidth: bw }).opening).toBeLessThan(0.01);
      expect(eyePam(sym, lv, { rate: 0.5, bandwidth: bw }).opening).toBeLessThan(0.01);
    }
  });
  it('two poles in cascade (a lossy trace): PAM4 keeps an eye open where the NRZ eye is shut', () => {
    const lv = [-1, -1 / 3, 1 / 3, 1], bw = 0.25;
    expect(eye(bits, { rate: 1, bandwidth: bw, poles: 2 }).opening).toBeLessThan(0);
    expect(eyePam(sym, lv, { rate: 0.5, bandwidth: bw, poles: 2 }).opening).toBeGreaterThan(0.15);
  });
  it('Gray symbol error rate is 3/2 Q(half / σ) and a bit is wrong in one symbol error: measured on seeded noise', () => {
    const half = 1 / 3, sigma = half / 1.5, u = rng(7), n = 400000;
    let err = 0;
    for (let i = 0; i < n; i++) {
      const lv = Math.floor(u() * 4), x = [-1, -1 / 3, 1 / 3, 1][lv] + sigma * gaussian(u);
      const d = Math.min(3, Math.max(0, Math.round((x + 1) * 1.5)));
      if (d !== lv) err++;
    }
    near(err / n, 1.5 * qFunc(half / sigma), 2e-3);
    near(pam4Ber(2 * half, sigma), 0.75 * qFunc(half / sigma), 1e-12);
  });
});
