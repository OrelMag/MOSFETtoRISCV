// The fibre models against independent statements: Snell by construction, the Bessel zeros of the LP cutoffs, an FFT propagation against the closed form, the OSNR rule against
// its derivation, a simulated coherent receiver against Q(√SNR), and the optimum of the Kerr model against a brute-force search.
import { describe, expect, it } from 'vitest';
import {
  acceptanceDeg, aseSpanMw, bandwidthMHzKm, besselJ, bestPower, beta2Of, cdTaps, coherentLink, criticalDeg, cutoffUm, dispersionD, dispersionLength, disperse, FEC_BER, gaussianWidth, gradedDelayPsKm, gridChannels, gridNm, infraredDb, LP_MODES, lossDb, maxSpans, minLoss, MMF_50,
  modesAt, modesLarge, n2Of, naOf, nmOf, osnrBySum, osnrDb, photonFloorDbm, QAMS, qFn, rayleighDb, rayOf, reachNarrowKm, reachWideKm, requiredSnrDb, rmsWidth, SMF_G652, snrFromOsnr, snrWithNli, spacingNm, stepDelayPsKm, thzOf, vNumber,
} from '../src/phys/fibre';
import { cx } from '../src/comm/fourier';
import { dbToRatio } from '../src/comm/limits';
import { MMF, SMF } from '../src/widgets/serial';
import { tick as yieldTick } from './yieldtick';

describe('loss', () => {
  it('Rayleigh falls as λ⁻⁴: half the wavelength, sixteen times the loss', () => {
    expect(rayleighDb(0.8) / rayleighDb(1.6)).toBeCloseTo(16, 6);
  });
  it('silica has a minimum near 1.55 µm, under 0.2 dB/km, between scattering and the infrared edge', () => {
    const m = minLoss();
    expect(m.um).toBeGreaterThan(1.5); expect(m.um).toBeLessThan(1.62);
    expect(m.db).toBeGreaterThan(0.14); expect(m.db).toBeLessThan(0.2);
    expect(infraredDb(1.8)).toBeGreaterThan(rayleighDb(1.8));
    expect(infraredDb(1.3)).toBeLessThan(rayleighDb(1.3) / 10);
  });
  it('agrees with the constants the fast serial links chapter used', () => {
    expect(lossDb(1.31, 0)).toBeLessThan(SMF.dbPerKm + 0.1);
    expect(lossDb(1.55)).toBeLessThan(0.2);
    expect(lossDb(0.85)).toBeGreaterThan(MMF.dbPerKm * 0.45);   // a multimode core's heavier doping scatters more than this silica line
    expect(lossDb(0.85)).toBeLessThan(MMF.dbPerKm * 1.1);
  });
});

describe('a ray in a core', () => {
  const n1 = SMF_G652.n1, n2 = n2Of(SMF_G652), na = naOf(n1, n2);
  it('the numerical aperture of a G.652-like fibre', () => {
    expect(na).toBeGreaterThan(0.11); expect(na).toBeLessThan(0.15);
    expect(na).toBeCloseTo(n1 * Math.sqrt(2 * SMF_G652.delta), 2);
  });
  it('a ray at the acceptance angle is just at the critical angle at the wall, by Snell', () => {
    const edge = acceptanceDeg(na);
    expect(rayOf(edge * 0.999, n1, n2).guided).toBe(true);
    expect(rayOf(edge * 1.001, n1, n2).guided).toBe(false);
    const c = rayOf(edge, n1, n2).coreDeg;
    expect(90 - c).toBeCloseTo(criticalDeg(n1, n2), 5);
  });
  it('the slowest guided ray of a step core is the delay spread n₁Δ/c', () => {
    const f = MMF_50, n = n2Of(f), ang = acceptanceDeg(naOf(f.n1, n)), r = rayOf(ang, f.n1, n);
    const spread = ((r.stretch - 1) * f.n1 * 1e12) / 299792.458; // ps/km
    expect(spread / stepDelayPsKm(f)).toBeCloseTo(1, 1);
  });
});

describe('modes', () => {
  it('the cutoffs are the zeros of the Bessel functions they are named after', () => {
    expect(Math.abs(besselJ(0, 2.4048))).toBeLessThan(1e-3);
    expect(Math.abs(besselJ(1, 3.8317))).toBeLessThan(1e-3);
    expect(Math.abs(besselJ(2, 5.1356))).toBeLessThan(1e-3);
    expect(Math.abs(besselJ(0, 5.5201))).toBeLessThan(1e-3);
    expect(LP_MODES[0].cutoff).toBe(0);
  });
  it('G.652 is single mode at 1310 and 1550, cut off near 1260 or below', () => {
    const na = naOf(SMF_G652.n1, n2Of(SMF_G652));
    expect(modesAt(vNumber(SMF_G652.aUm, na, 1.31)).length).toBe(1);
    expect(modesAt(vNumber(SMF_G652.aUm, na, 1.55)).length).toBe(1);
    const c = cutoffUm(SMF_G652.aUm, na);
    expect(c).toBeGreaterThan(1.1); expect(c).toBeLessThan(1.3);
  });
  it('a 50 µm core at 850 nm has hundreds of modes, and V²/2 counts them: the exact list agrees where it reaches', () => {
    const na = naOf(MMF_50.n1, n2Of(MMF_50)), v = vNumber(MMF_50.aUm, na, 0.85);
    expect(modesLarge(v)).toBeGreaterThan(300);
    const v7 = 7.1, listed = modesAt(v7).reduce((s, m) => s + m.count, 0);
    expect(listed / modesLarge(v7)).toBeGreaterThan(0.75);
    expect(listed / modesLarge(v7)).toBeLessThan(1.3);
  });
  it('the parabolic core cuts modal delay by Δ/8, and lands near OM4\'s bandwidth', () => {
    expect(stepDelayPsKm(MMF_50) / gradedDelayPsKm(MMF_50)).toBeCloseTo(8 / MMF_50.delta, 5);
    const b = bandwidthMHzKm(gradedDelayPsKm(MMF_50));
    expect(b).toBeGreaterThan(MMF.modalMHzKm * 0.8); expect(b).toBeLessThan(MMF.modalMHzKm * 2);
  });
});

describe('chromatic dispersion', () => {
  it('zero at 1310, about 17 ps/(nm·km) at 1550, β₂ about −22 ps²/km', () => {
    expect(dispersionD(1310)).toBeCloseTo(0, 6);
    const d = dispersionD(1550);
    expect(d).toBeGreaterThan(16.5); expect(d).toBeLessThan(18.5);
    const b2 = beta2Of(d, 1550);
    expect(b2).toBeLessThan(-20); expect(b2).toBeGreaterThan(-25);
  });
  it('an FFT propagation of a Gaussian pulse equals the closed form', () => {
    const N = 4096, dt = 0.25, t0 = 10, re = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = Math.exp(-(((i - N / 2) * dt) ** 2) / (2 * t0 * t0));
    const x = cx(re, new Float64Array(N)), b2 = -21.7;
    expect(rmsWidth(x, dt)).toBeCloseTo(t0, 2);
    for (const km of [1, 5, 20]) {
      const out = disperse(x, dt, b2 * km);
      expect(rmsWidth(out, dt) / gaussianWidth(t0, b2, km)).toBeCloseTo(1, 2);
    }
    expect(dispersionLength(t0, b2)).toBeCloseTo(100 / 21.7, 5);
    // all-pass: energy is kept, and the same phase with the opposite sign undoes it
    const back = disperse(disperse(x, dt, b2 * 20), dt, -b2 * 20);
    expect(rmsWidth(back, dt)).toBeCloseTo(t0, 2);
  });
  it('the rule of a quarter of a bit: at 10 Gb/s a clean laser goes tens of km, a Fabry-Pérot only a few', () => {
    const b2 = beta2Of(dispersionD(1550), 1550);
    const n = reachNarrowKm(10, b2);
    expect(n).toBeGreaterThan(20); expect(n).toBeLessThan(40);
    expect(reachNarrowKm(40, b2)).toBeCloseTo(n / 16, 4);
    expect(reachWideKm(10, dispersionD(1550), 1)).toBeLessThan(2);
  });
});

describe('wavelengths', () => {
  it('193.1 THz is about 1552.5 nm, and frequencies and wavelengths invert', () => {
    expect(nmOf(193.1)).toBeCloseTo(1552.52, 1);
    expect(nmOf(thzOf(1530))).toBeCloseTo(1530, 8);
    expect(gridNm(0, 50)).toBeCloseTo(1552.52, 1);
  });
  it('C band holds about 4.4 THz: 88 channels at 50 GHz', () => {
    expect(gridChannels(50)).toBeGreaterThanOrEqual(86); expect(gridChannels(50)).toBeLessThanOrEqual(90);
    expect(gridChannels(100)).toBeCloseTo(gridChannels(50) / 2, -0.5);
    expect(spacingNm(100, 1550)).toBeCloseTo(0.8, 1);
    expect(spacingNm(12.5, 1550)).toBeCloseTo(0.1, 1);
  });
});

describe('amplifier chains', () => {
  it('hν in 12.5 GHz at 1550 nm is −58 dBm, from h and c', () => {
    expect(photonFloorDbm(1550)).toBeCloseTo(-58, 0);
  });
  it('the rule of thumb equals the sum of the amplifiers\' noise', () => {
    for (const [p, nf, sp, n] of [[0, 5, 20, 10], [2, 4.5, 16, 100], [-1, 6, 25, 3]]) expect(osnrDb(p, nf, sp, n)).toBeCloseTo(osnrBySum(p, nf, sp, n), 6);
  });
  it('doubling the spans costs 3 dB, 3 dB more span loss costs 3 dB, whichever it comes from', () => {
    expect(osnrDb(0, 5, 20, 10) - osnrDb(0, 5, 20, 20)).toBeCloseTo(3.01, 2);
    expect(osnrDb(0, 5, 20, 10) - osnrDb(0, 5, 23, 10)).toBeCloseTo(3, 6);
  });
  it('SNR and OSNR at a known point', () => {
    expect(snrFromOsnr(20, 12.5)).toBeCloseTo(20, 6);
    expect(snrFromOsnr(20, 25)).toBeCloseTo(17, 0);
  });
});

describe('what a receiver needs', () => {
  it('Q(x) matches its tabulated values', () => {
    expect(qFn(0)).toBeCloseTo(0.5, 5); expect(qFn(1)).toBeCloseTo(0.158655, 5); expect(qFn(3)).toBeCloseTo(0.00134990, 6); expect(qFn(-1)).toBeCloseTo(0.841345, 5);
  });
  it('each QAM needs more: 16-QAM about 7 dB past QPSK, 64-QAM about 6 past that at this BER', () => {
    const r = QAMS.map((q) => requiredSnrDb(q));
    expect(r[1] - r[0]).toBeGreaterThan(5.5); expect(r[1] - r[0]).toBeLessThan(8);
    expect(r[2] - r[1]).toBeGreaterThan(4.5); expect(r[2] - r[1]).toBeLessThan(7);
    QAMS.forEach((q, i) => expect(q.ber(dbToRatio(r[i]))).toBeCloseTo(FEC_BER, 5));
  });
});

describe('the Kerr limit', () => {
  it('the closed-form optimum power beats its neighbours, and sits where NLI is half the ASE', () => {
    const b = bestPower(100, 5, 16, 32);
    for (let p = b.pDbm - 4; p <= b.pDbm + 4; p += 0.1) expect(snrWithNli(p, 100, 5, 16, 32)).toBeLessThanOrEqual(b.snrDb + 1e-9);
    const a = aseSpanMw(5, 16, 32), P = dbToRatio(b.pDbm);
    expect(a / (P ** 3 * 10 ** (-33 / 10))).toBeCloseTo(2, 5);
  });
  it('more launch power does not help past the optimum: it falls by 2 dB a dB', () => {
    const b = bestPower(100, 5, 16, 32);
    expect(snrWithNli(b.pDbm + 8, 100, 5, 16, 32) - snrWithNli(b.pDbm + 9, 100, 5, 16, 32)).toBeCloseTo(2, 0);
  });
  it('the design point: QPSK crosses an ocean, 64-QAM does not', () => {
    const span = 16, nf = 4.5, gbd = 32, km = 60;
    const reach = (q: number) => maxSpans(requiredSnrDb(QAMS[q]), nf, span, gbd) * km;
    expect(reach(0)).toBeGreaterThan(6600);
    expect(reach(2)).toBeLessThan(2500);
    expect(reach(1)).toBeLessThan(reach(0)); expect(reach(1)).toBeGreaterThan(reach(2));
  });
  it('taps a dispersion compensator would need across an ocean', () => {
    const t = cdTaps(beta2Of(dispersionD(1550), 1550), 6000, 32);
    expect(t).toBeGreaterThan(1000); expect(t).toBeLessThan(5000);
  });
});

describe('a coherent receiver', () => {
  const base = { symbols: 16384, gbd: 32, km: 0, beta2: -21.7, snrDb: 7, compensate: false, linewidthMHz: 0, seed: 3, track: false };
  const within = (ber: number, theory: number, f = 1.25) => { expect(ber).toBeGreaterThan(theory / f); expect(ber).toBeLessThan(theory * f); };
  it('with no fibre, the BER is Q(√SNR)', async () => {
    for (const s of [5, 7, 9]) {
      const r = coherentLink({ ...base, snrDb: s, seed: s });
      within(r.ber, r.theory);
      await yieldTick();
    }
  });
  it('a thousand km of dispersion destroys it; the compensator gives it back exactly', async () => {
    const bad = coherentLink({ ...base, km: 1000 });
    expect(bad.ber).toBeGreaterThan(0.2);
    await yieldTick();
    const good = coherentLink({ ...base, km: 1000, compensate: true });
    within(good.ber, good.theory);
  });
  it('laser phase noise: without tracking the constellation smears, with it the penalty is small', async () => {
    const bad = coherentLink({ ...base, linewidthMHz: 1, snrDb: 10 });
    await yieldTick();
    const good = coherentLink({ ...base, linewidthMHz: 1, snrDb: 10, track: true });
    expect(bad.ber).toBeGreaterThan(5 * good.theory);
    expect(good.ber).toBeLessThan(5 * good.theory);
  });
});
