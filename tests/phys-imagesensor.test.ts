import { describe, expect, it } from 'vitest';
import {
  absorptionDepth, afterTransfers, alphaSi, bayerAt, C_FD_FF, CCD42_40, ccdReadTime, ccdRetained, cdsSequence, CG_4T, clockHigh, darkCurrent,
  demosaic, dynamicRangeDb, exposureWindow, ICX285, IMX183, ktcNoise, mosaic, normal, outputVolts, packetGate, photonEv, poisson, qe,
  rng, rollingSkew, rowTime, SI_CUTOFF_NM, singleSlope, singleSlopeTime, snr, STACK_BSI, STACK_CCD42, STACK_FSI, stepsPerPixel,
} from '../src/phys/imagesensor';

describe('light into charge', () => {
  it('reads Green 2008 at its table points and interpolates between them', () => {
    expect(alphaSi(400)).toBe(9.52e4);
    expect(alphaSi(1000)).toBe(64);
    expect(alphaSi(525)).toBeGreaterThan(6.39e3);
    expect(alphaSi(525)).toBeLessThan(1.11e4);
  });
  it('stops blue in a tenth of a micrometre and lets near infrared go tens of micrometres deep', () => {
    expect(absorptionDepth(450)).toBeCloseTo(0.39, 2);
    expect(absorptionDepth(650)).toBeCloseTo(3.56, 1);
    expect(absorptionDepth(900)).toBeGreaterThan(30);
  });
  it('absorbs nothing past the band gap (≈ 1107 nm, 1.12 eV)', () => {
    expect(SI_CUTOFF_NM).toBeCloseTo(1107, 0);
    expect(photonEv(550)).toBeCloseTo(2.25, 2);
    expect(qe(1150)).toBe(0);
  });
  it('fits the measured QE of each part to a few points', () => {
    expect(qe(525, STACK_BSI)).toBeCloseTo(IMX183.peakQe, 1); // EMVA 79 %
    expect(qe(650, STACK_CCD42)).toBeGreaterThanOrEqual(0.8); // datasheet minimum 80 %
    expect(qe(900, STACK_CCD42)).toBeGreaterThanOrEqual(0.5); // minimum 50 %
    expect(qe(500, STACK_CCD42)).toBeGreaterThanOrEqual(0.75);
    expect(qe(525, STACK_FSI)).toBeLessThan(qe(525, STACK_BSI)); // light through the metal stack first
  });
});

describe('noise', () => {
  it('gives each part its dynamic range', () => {
    expect(dynamicRangeDb(CCD42_40)).toBeCloseTo(94, 0);
    expect(dynamicRangeDb(IMX183)).toBeCloseTo(73, 0); // EMVA says 71.84 dB (it uses the saturation it measured)
  });
  it('is shot-noise limited in bright light, read-noise limited in the dark', () => {
    expect(snr(10_000, 0, 3.3)).toBeCloseTo(100, 0);
    expect(snr(4, 0, 3.3)).toBeLessThan(1.1);
  });
  it('follows the CCD42-40 dark law: 20 000 e⁻/s at 293 K, nearly nothing when cooled', () => {
    expect(darkCurrent(293)).toBeCloseTo(20_000, -2);
    expect(darkCurrent(293 - 8.2) / darkCurrent(293)).toBeCloseTo(0.5, 1); // halves about every 8 K
    expect(darkCurrent(173) * 3600).toBeLessThan(10);
  });
  it('draws seeded Poisson and normal samples with the right mean', () => {
    const r = rng(1);
    let s = 0, n = 0;
    for (let i = 0; i < 4000; i++) { s += poisson(9, r); n += normal(r); }
    expect(s / 4000).toBeCloseTo(9, 0);
    expect(Math.abs(n / 4000)).toBeLessThan(0.08);
  });
});

describe('CCD transfer', () => {
  it('steps three-phase one gate, then two overlapping, and moves a pixel in six steps', () => {
    expect([0, 1, 2, 3, 4, 5].map((s) => clockHigh(3, s))).toEqual([[1], [1, 2], [2], [2, 3], [3], [3, 1]]);
    expect(packetGate(3, stepsPerPixel(3))).toBe(3);
    expect(clockHigh(3, 6)).toEqual([1]);
  });
  it('steps four-phase (the ICX285 vertical register) two gates high at a time', () => {
    expect([0, 1, 2, 3].map((s) => clockHigh(4, s))).toEqual([[1, 2], [2, 3], [3, 4], [4, 1]]);
    expect(packetGate(4, stepsPerPixel(4))).toBe(4);
    expect(ICX285.phasesV).toBe(4);
  });
  it('loses 1.6 % of the far corner pixel after 4096 transfers', () => {
    expect(CCD42_40.gateLength).toBe(4.5);
    expect(ccdRetained(0, 0)).toBeGreaterThan(0.99998);
    expect(ccdRetained(2047, 2047)).toBeCloseTo(0.984, 3);
    expect(afterTransfers(1000, 0.99)).toBeLessThan(1e-4); // why CTE needs five nines and more
  });
  it('reads a frame in 1.4 s at 3 MHz, 3.5 min at 20 kHz', () => {
    expect(ccdReadTime(3e6)).toBeCloseTo(1.4, 1);
    expect(ccdReadTime(20e3) / 60).toBeCloseTo(3.5, 1);
    expect(outputVolts(CCD42_40.fullWell, CCD42_40.cg)).toBeCloseTo(CCD42_40.peakOutputV, 3);
  });
});

describe('4T pixel and CDS', () => {
  it('derives C_FD = q / CG and the kTC noise it would leave without CDS', () => {
    expect(C_FD_FF).toBeCloseTo(2.67, 2);
    expect(ktcNoise(C_FD_FF)).toBeCloseTo(20.8, 0);
  });
  it('steps RST, SHR, TX, SHS, and the difference of the samples is the charge, whatever the reset error', () => {
    const a = cdsSequence(5000), b = cdsSequence(5000, { offset: 0.003 });
    expect(a.phases.map((p) => p.name)).toEqual(['RST', 'SHR', 'TX', 'SHS']);
    expect(a.phases[2].fd).toBeCloseTo(2.8 - 5000 * CG_4T * 1e-6, 6);
    expect(a.cdsE).toBeCloseTo(5000, 6);
    expect(b.cdsE).toBeCloseTo(5000, 6);
    expect(cdsSequence(1e6).cdsE).toBeCloseTo(IMX183.fullWell, 6);
  });
  it('converts with a single slope: 4096 counts for 12 bits', () => {
    expect(singleSlope(0.5, 12, 1)).toBe(2048);
    expect(singleSlope(2, 12, 1)).toBe(4095);
    expect(singleSlopeTime(12, 400e6) * 1e6).toBeCloseTo(10.24, 2);
  });
});

describe('shutters', () => {
  it('derives the IMX183 row time from 21.98 frame/s over 3694 rows', () => {
    expect(rowTime() * 1e6).toBeCloseTo(12.3, 1);
    expect(exposureWindow(100, 0.01, 'rolling')[0]).toBeCloseTo(100 * rowTime(), 12);
    expect(exposureWindow(100, 0.01, 'global')).toEqual([0, 0.01]);
  });
  it('skews a moving edge by v × frame readout time', () => {
    expect(rollingSkew(1000, IMX183.rows)).toBeCloseTo(1000 / IMX183.fps, 6);
  });
});

describe('colour', () => {
  it('lays RGGB with half the pixels green', () => {
    expect([bayerAt(0, 0), bayerAt(1, 0), bayerAt(0, 1), bayerAt(1, 1)]).toEqual(['R', 'G', 'G', 'B']);
  });
  it('demosaics a flat colour back exactly', () => {
    const w = 6, h = 4, rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) rgb.set([0.8, 0.5, 0.2], 3 * i);
    const back = demosaic(mosaic(rgb, w, h), w, h);
    for (let i = 0; i < back.length; i++) expect(back[i]).toBeCloseTo(rgb[i], 6);
  });
});
