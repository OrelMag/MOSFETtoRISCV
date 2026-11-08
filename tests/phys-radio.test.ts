// Radio's models against closed forms and each other: a dipole integrated numerically, Friis against the dB form, a mixer's spectrum against sum and difference, a simulated
// Rayleigh channel against its BER and level-crossing formulas.
import { describe, expect, it } from 'vitest';
import {
  apertureM2, arrayDbi, arrayFactor, bpskAwgn, bpskMrc, bpskRayleigh, channelAt, Clarke, coherenceMHz, coherenceTime, delaySpread, DIPOLE_DBI, dipoleField, directivityOf, dopplerHz, fadeDuration, fadeMarginDb, fadingTrial, friisRatio, fsplDb, imageOf, imageRejectionDb, KT_DBM_HZ, levelCrossing, linkBudget, logDistanceDb,
  mixed, mixSpectrum, noiseFloorDbm, notchSpacingMHz, sdrReceive, sincGain, wavelengthM, widebandLimitMbps,
} from '../src/phys/radio';
import { ratioToDb, shannon, dbToRatio } from '../src/comm/limits';
import { tick as yieldTick } from './yieldtick';

describe('antennas', () => {
  it('a half-wave dipole integrates to 1.64, 2.15 dBi', () => {
    const d = directivityOf((t) => dipoleField(t) ** 2);
    expect(d).toBeCloseTo(1.64, 2);
    expect(ratioToDb(d)).toBeCloseTo(DIPOLE_DBI, 1);
  });
  it('a short dipole, sin²θ, integrates to 1.5; an isotropic one to 1', () => {
    expect(directivityOf((t) => Math.sin(t) ** 2)).toBeCloseTo(1.5, 3);
    expect(directivityOf(() => 1)).toBeCloseTo(1, 6);
  });
  it('2.4 GHz is 12.5 cm; a dipole is 6 cm; its aperture is G λ² / 4π', () => {
    expect(wavelengthM(2.4)).toBeCloseTo(0.1249, 3);
    expect(apertureM2(0, 1)).toBeCloseTo(0.2998 ** 2 / (4 * Math.PI), 4);
  });
  it('the plotted array pattern: integrated gains, a null where the panel says, below 10 log n + 2.15 for dipoles in line', () => {
    expect(arrayDbi(1, 0)).toBeCloseTo(2.15, 1);
    for (const n of [2, 4, 8, 16]) {
      expect(arrayDbi(n, 0)).toBeLessThan(10 * Math.log10(n) + 2.15);
      expect(arrayFactor(n, 0.5, 0, (Math.asin(Math.min(1, 2 / n)) * 180) / Math.PI)).toBeLessThan(1e-6);
    }
    expect(arrayDbi(8, 0)).toBeGreaterThan(8.5); expect(arrayDbi(8, 0)).toBeLessThan(9.8);
  });
  it('an array steers: full gain at the steering angle, nulls at 1/(nd)', () => {
    expect(arrayFactor(8, 0.5, 30, 30)).toBeCloseTo(1, 6);
    expect(arrayFactor(8, 0.5, 0, (Math.asin(1 / 4) * 180) / Math.PI)).toBeLessThan(1e-6);
    expect(arrayFactor(8, 0.5, 0, 60)).toBeLessThan(0.3);
  });
});

describe('path loss', () => {
  it('the dB form is Friis', () => {
    for (const [km, ghz] of [[1, 1], [0.05, 2.4], [0.05, 5.5], [36000, 12]]) expect(fsplDb(km, ghz)).toBeCloseTo(-ratioToDb(friisRatio(km * 1000, ghz)), 1);
  });
  it('doubling the distance or the frequency costs 6 dB; a dish fixed in size wins it back', () => {
    expect(fsplDb(2, 1) - fsplDb(1, 1)).toBeCloseTo(6.02, 2);
    expect(fsplDb(1, 2) - fsplDb(1, 1)).toBeCloseTo(6.02, 2);
    // two fixed apertures: gain grows as f², twice over, so the link gets better with frequency
    const a = 1, G = (ghz: number) => (4 * Math.PI * a) / wavelengthM(ghz) ** 2;
    expect(ratioToDb(friisRatio(1000, 2, G(2), G(2))) - ratioToDb(friisRatio(1000, 1, G(1), G(1)))).toBeCloseTo(6.02, 2);
  });
  it('a log-distance exponent agrees with free space at n = 2', () => {
    expect(logDistanceDb(100, 2.4, 2)).toBeCloseTo(fsplDb(0.1, 2.4), 6);
    expect(logDistanceDb(100, 2.4, 3.5)).toBeGreaterThan(fsplDb(0.1, 2.4));
  });
});

describe('the link budget', () => {
  it('kT at 290 K is −174 dBm/Hz', () => {
    expect(KT_DBM_HZ).toBeCloseTo(-173.98, 1);
    expect(noiseFloorDbm(1)).toBeCloseTo(-114, 0);
    expect(noiseFloorDbm(20, 6)).toBeCloseTo(-95, 0);
  });
  it('the sum adds up, and the capacity is Shannon at that SNR', () => {
    const b = linkBudget({ txDbm: 20, gtDbi: 2, grDbi: 2, km: 0.05, ghz: 2.4, extraDb: 24, mhz: 20, nfDb: 6 });
    expect(b.rx).toBeCloseTo(20 + 2 + 2 - fsplDb(0.05, 2.4) - 24, 6);
    expect(b.snr).toBeCloseTo(b.rx - noiseFloorDbm(20, 6), 6);
    expect(b.capacityMbps).toBeCloseTo(shannon(20, dbToRatio(b.snr)), 6);
  });
  it('more bandwidth helps less and less: capacity tends to the wideband limit', () => {
    const rx = -80, nf = 6;
    const at = (mhz: number) => linkBudget({ txDbm: rx, gtDbi: 0, grDbi: 0, km: 1 / 1000, ghz: 1, extraDb: -fsplDb(1 / 1000, 1), mhz, nfDb: nf }).capacityMbps;
    const lim = widebandLimitMbps(rx, nf);
    expect(at(10)).toBeLessThan(at(100));
    expect(at(1e5)).toBeLessThan(lim);
    expect(at(1e6) / lim).toBeGreaterThan(0.98);
  });
});

describe('mixing', () => {
  it('a sampled mixer produces exactly the sum and the difference', () => {
    const fs = 1024, spec = mixSpectrum([100], 300, fs);
    const big = spec.flatMap((v, k) => (v > 0.1 ? [k] : []));
    expect(big).toEqual([...mixed(100, 300)].sort((a, b) => a - b));
  });
  it('image rejection: the chapter half a percent and a third of a degree (each alone, and together) follow (e² + φ²) / 4', () => {
    const e = 0.005, p = 1 / 3, ph = (p * Math.PI) / 180;
    expect(imageRejectionDb(e, 0)).toBeCloseTo(10 * Math.log10((e * e) / 4), 0);
    expect(imageRejectionDb(0, p)).toBeCloseTo(10 * Math.log10((ph * ph) / 4), 0);
    expect(imageRejectionDb(e, p)).toBeCloseTo(10 * Math.log10((e * e + ph * ph) / 4), 0);
    expect(imageRejectionDb(0, 0)).toBe(-Infinity);
  });
  it('two inputs a difference apart reach the same IF: the image', () => {
    const lo = 300, f = 340;
    expect(mixed(imageOf(f, lo), lo)[0]).toBe(mixed(f, lo)[0]);
    const spec = mixSpectrum([f, imageOf(f, lo)], lo, 1024);
    expect(spec[40]).toBeCloseTo(2 * spec[384], 5);   // both inputs land on 40; their sums alias to 384 and 464
  });
});

describe('a software radio', () => {
  const stations = [{ offset: -3, amp: 1, seed: 1 }, { offset: 1, amp: 1, seed: 2 }, { offset: 4, amp: 3, seed: 3 }];
  it('tunes to each station by arithmetic alone; whole offsets are orthogonal over a symbol', () => {
    for (const st of stations) {
      const r = sdrReceive(stations, st.offset, { symbols: 800, decim: 8, sps: 2, snrDb: 30, seed: 9 });
      expect(r.ber).toBe(0);
    }
    expect(sincGain(1)).toBeLessThan(1e-9);
    expect(sincGain(0.5)).toBeCloseTo(2 / Math.PI, 6);
  });
  it('at low SNR the BER is the closed form, with the other stations ignored', async () => {
    for (const snr of [1, 3]) {
      const r = sdrReceive(stations, 1, { symbols: 8000, decim: 8, sps: 2, snrDb: snr, seed: 3 + snr });
      const t = bpskAwgn(dbToRatio(snr));
      expect(r.ber).toBeGreaterThan(t / 1.3); expect(r.ber).toBeLessThan(t * 1.3);
      await yieldTick();
    }
  });
  it('tuned between two stations, it gets neither', () => {
    const r = sdrReceive(stations, -1, { symbols: 2000, decim: 8, sps: 2, snrDb: 30, seed: 3 });
    expect(r.ber).toBeGreaterThan(0.3);
  });
});

describe('multipath', () => {
  it('two equal rays: a null every 1 / Δτ, a doubling between', () => {
    const r = [{ ns: 0, amp: 1, phase: 0 }, { ns: 100, amp: 1, phase: 0 }], sp = notchSpacingMHz(100);
    expect(sp).toBe(10);
    expect(Math.hypot(channelAt(r, 0).re, channelAt(r, 0).im)).toBeCloseTo(2, 6);
    expect(Math.hypot(channelAt(r, 5).re, channelAt(r, 5).im)).toBeLessThan(1e-9);
    expect(Math.hypot(channelAt(r, 15).re, channelAt(r, 15).im)).toBeLessThan(1e-9);
  });
  it('delay spread and coherence bandwidth', () => {
    expect(delaySpread([{ ns: 0, amp: 1, phase: 0 }, { ns: 100, amp: 1, phase: 0 }])).toBeCloseTo(50, 6);
    expect(delaySpread([{ ns: 40, amp: 1, phase: 0 }])).toBe(0);
    expect(coherenceMHz(50)).toBeCloseTo(4, 6);
  });
});

describe('fading', () => {
  it('Doppler: 100 km/h at 2 GHz is about 185 Hz', () => {
    expect(dopplerHz(100, 2)).toBeCloseTo(185, 0);
    expect(coherenceTime(185)).toBeCloseTo(0.00229, 4);
    // the 0.24 the text quotes: J₀ falls to a half there
    let j = 0;
    for (let k = 0; k < 2000; k++) j += Math.cos(2 * Math.PI * 0.242 * Math.cos(((k + 0.5) / 2000) * Math.PI)) / 2000;
    expect(j).toBeCloseTo(0.5, 1);
  });
  it('Clarke: power 1, an exponential power law, crossings as the formula says', async () => {
    const fd = 100, g = new Clarke(fd, 5, 64), dt = 1 / (fd * 40), n = 200000;
    let p = 0, below = 0, crossings = 0, last = 1;
    for (let i = 0; i < n; i++) {
      const c = g.at(i * dt), a = Math.hypot(c.re, c.im);
      p += a * a;
      if (a < 0.5) below++;
      if (last >= 0.5 && a < 0.5) crossings++;
      last = a;
      if (i % 50000 === 0) await yieldTick();
    }
    expect(p / n).toBeGreaterThan(0.8); expect(p / n).toBeLessThan(1.2);
    const P = 1 - Math.exp(-0.25);
    expect(below / n / P).toBeGreaterThan(0.8); expect(below / n / P).toBeLessThan(1.2);
    const lcr = crossings / (n * dt);
    expect(lcr / levelCrossing(0.5, fd)).toBeGreaterThan(0.75); expect(lcr / levelCrossing(0.5, fd)).toBeLessThan(1.25);
    expect(fadeDuration(0.5, fd)).toBeGreaterThan(0);
    expect(g.fd).toBe(fd);
  });
  it('Rayleigh BPSK: closed form against a simulation, and the 1/SNR law far from AWGN\'s waterfall', async () => {
    for (const db of [0, 10, 20]) {
      const s = dbToRatio(db), r = fadingTrial(db, 1, 200000, db + 1), t = bpskRayleigh(s);
      expect(r / t).toBeGreaterThan(0.85); expect(r / t).toBeLessThan(1.15);
      await yieldTick();
    }
    expect(bpskRayleigh(dbToRatio(30)) * dbToRatio(30)).toBeCloseTo(0.25, 2);
    expect(bpskAwgn(dbToRatio(10))).toBeLessThan(bpskRayleigh(dbToRatio(10)) / 1000);
  });
  it('maximal-ratio combining: closed form against a simulation; two antennas give the 1/SNR² slope', async () => {
    expect(bpskMrc(10, 1)).toBeCloseTo(bpskRayleigh(10), 9);
    for (const [L, db] of [[2, 5], [4, 0]]) {
      const r = fadingTrial(db, L, 200000, L * 7), t = bpskMrc(dbToRatio(db), L);
      expect(r / t).toBeGreaterThan(0.85); expect(r / t).toBeLessThan(1.15);
      await yieldTick();
    }
    const slope = Math.log10(bpskMrc(dbToRatio(20), 2) / bpskMrc(dbToRatio(30), 2));
    expect(slope).toBeGreaterThan(1.9); expect(slope).toBeLessThan(2.1);
  });
  it('margin for 1 % outage is 20 dB', () => {
    expect(fadeMarginDb(0.01)).toBeCloseTo(20, 0);
  });
});
