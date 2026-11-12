// The half-wave dipole model held to the radio chapter: its frequency, its stated length, the current's shape and the pattern formula.
import { describe, expect, it } from 'vitest';
import { chRadio } from '../src/chapters/ch-comm-radio';
import { C_M_S, dipoleField, wavelengthM } from '../src/phys/radio';
import { ANTENNA_GHZ } from '../src/widgets/radio';
import { DEFICIT, DipoleRun, GAP, HALF_LEN, cutLength, cutHalf, feedDrive, feedResistance, gainDbi, halfPower, mismatch, powerAt, radiationResistance, surfaceAt, voltageAt, LAMBDA, LOOP_LIFE, PATTERN_R, currentAt, envelope, frontAt, loopBirth, loopsAt, loopOutline, patternAt } from '../src/widgets/dipole3dparts';
import { dipoleModel, patternProfile, type DipoleLook } from '../src/widgets/dipole3dkit';
import { boundsOfNamed } from '../src/gl/kit/scene';

const look = (o: Partial<DipoleLook> = {}): DipoleLook => ({ detail: 'flat', mode: 'power', feed: 'balanced', pattern: true, hi: false, rgb: { cu: [0.8, 0.5, 0.3], pos: [1, 0, 0], neg: [0, 0, 1] }, ...o });
/** The kit is in mm, the parts in cm. */
const MM = 10;

describe('length', () => {
  it('lambda / 2 is the length the chapter states, at the chapter frequency', () => {
    const body = chRadio.steps[0].body as string;
    const cm = (wavelengthM(ANTENNA_GHZ) * 50).toFixed(1);
    expect(body).toContain(`${cm} cm at ${ANTENNA_GHZ.toFixed(1)} GHz`);
    expect(2 * HALF_LEN).toBeCloseTo(wavelengthM(ANTENNA_GHZ) * 50, 9);
    expect(LAMBDA).toBeCloseTo((C_M_S / (ANTENNA_GHZ * 1e9)) * 100, 9);
  });
  it('the drawn rods span the CUT length (end effect 0.95 of the electrical half wave)', () => {
    const run = new DipoleRun();
    const b = boundsOfNamed(dipoleModel(run, look()), ['arms']);
    expect(b.max[1] - b.min[1]).toBeCloseTo(cutLength(0.5) * MM, 3);
    expect(cutLength(0.5) / (2 * HALF_LEN)).toBeCloseTo(0.95, 9);
    expect(DEFICIT).toBeCloseTo(0.05 * 2 * HALF_LEN, 9);
    expect(cutLength(0.5)).toBeGreaterThan(5.8);
    expect(cutLength(0.5)).toBeLessThan(6.0);
    expect(GAP).toBeLessThan(HALF_LEN / 10);
  });
});

describe('current', () => {
  it('is zero at the tips and maximal at the feed at every phase', () => {
    for (const t of [0, 0.125, 0.3, 0.5, 0.7]) {
      const ph = 2 * Math.PI * t;
      expect(Math.abs(currentAt(cutHalf(0.5), ph))).toBeLessThan(1e-9);
      expect(Math.abs(currentAt(-cutHalf(0.5), ph))).toBeLessThan(1e-9);
      for (let i = 1; i < 40; i++) expect(Math.abs(currentAt((HALF_LEN * i) / 40, ph))).toBeLessThanOrEqual(Math.abs(currentAt(0, ph)) + 1e-12);
    }
    expect(envelope(0)).toBe(1);
    expect(envelope(cutHalf(0.5))).toBeLessThan(1e-9);
  });
  it('is cos(kz) in space and oscillates at the period of the chapter frequency', () => {
    for (let i = 0; i <= 10; i++) { const z = (cutHalf(0.5) * i) / 10; expect(currentAt(z, 0)).toBeCloseTo(Math.cos((2 * Math.PI * z * HALF_LEN) / cutHalf(0.5) / LAMBDA), 12); }
    expect(currentAt(0, 2 * Math.PI)).toBeCloseTo(1, 12);
    expect(currentAt(0, Math.PI)).toBeCloseTo(-1, 12);
    const r = new DipoleRun(); r.step(); r.step();
    expect(r.degrees).toBe(90);
    expect(Math.abs(r.feed)).toBeLessThan(1e-12);
  });
});

describe('pattern', () => {
  it('samples match cos(pi/2 cos t) / sin t, null on the axis, maximum broadside', () => {
    for (let i = 1; i < 180; i++) {
      const t = (i * Math.PI) / 180;
      expect(patternAt(t)).toBeCloseTo(Math.cos((Math.PI / 2) * Math.cos(t)) / Math.sin(t), 12);
      expect(patternAt(t)).toBeCloseTo(Math.abs(dipoleField(t)), 12);
      expect(patternAt(t)).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(patternAt(0)).toBe(0);
    expect(patternAt(Math.PI)).toBe(0);
    expect(patternAt(Math.PI / 2)).toBeCloseTo(1, 12);
  });
  it('the drawn surface lies at radius R f(theta) from the origin, polar angle from the y axis', () => {
    const pts = patternProfile(0.5, 'field', 36);
    pts.forEach(([r, y], i) => {
      const th = Math.PI * (1 - i / 36);
      expect(Math.hypot(r, y)).toBeCloseTo(PATTERN_R * MM * patternAt(th), 4);
      if (i === 0 || i === 36) expect(Math.hypot(r, y)).toBeLessThan(1e-9);
    });
    expect(Math.abs(pts[18][1])).toBeLessThan(1e-9);
    expect(pts[18][0]).toBeCloseTo(PATTERN_R * MM, 9);
  });
});

describe('near field', () => {
  it('a loop is born when the current is zero and its front moves at c (a wavelength a period)', () => {
    for (let n = -3; n < 6; n++) expect(Math.abs(currentAt(0, 2 * Math.PI * loopBirth(n)))).toBeLessThan(1e-9);
    expect(frontAt(1)).toBeCloseTo(LAMBDA, 9);
    const dx = frontAt(0.5) - frontAt(0.25), dt = 0.25 / (ANTENNA_GHZ * 1e9);
    expect(dx / 100 / dt).toBeCloseTo(C_M_S, 0);
  });
  it('loops form attached, detach at half a wavelength wide, alternate in sense and fade out', () => {
    const ls = loopsAt(1.0);
    expect(ls.length).toBeGreaterThanOrEqual(2);
    for (const l of ls) {
      if (l.age < 0.5) expect(l.xIn).toBe(0); else expect(l.xOut - l.xIn).toBeCloseTo(LAMBDA / 2, 9);
      expect(l.age).toBeLessThanOrEqual(LOOP_LIFE);
    }
    const s = ls.map((l) => l.sign);
    s.forEach((v, i) => i && expect(v).toBe(-s[i - 1]));
    const o = loopOutline(ls[0], -1);
    expect(o[0][0]).toBeLessThanOrEqual(0);
  });
});

describe('the drawing', () => {
  it('draws something in every phase, with and without the pattern, and its labels keep their names (the gutters key on them)', () => {
    const run = new DipoleRun();
    const names = (o: Partial<DipoleLook>) => (dipoleModel(run, look(o)).anchors ?? []).filter((a) => !a.minor).map((a) => a.text).join('|');
    const first = names({});
    for (let k = 0; k < 8; k++) {
      expect(dipoleModel(run, look()).items.length).toBeGreaterThan(dipoleModel(run, look({ pattern: false })).items.length);
      for (const feed of ['balanced', 'coax', 'balun'] as const) expect(names({ feed })).toBe(first);
      run.step();
    }
    run.lwl = 1.5;
    expect(names({})).toBe(first);
  });
});

describe('power against field', () => {
  it('the power is the field squared, 0.5 at the half-power angles (78 degrees wide), and the field there is 0.707', () => {
    for (let i = 1; i < 180; i++) { const t = (i * Math.PI) / 180; expect(powerAt(t)).toBeCloseTo(patternAt(t) ** 2, 12); }
    expect(powerAt(Math.PI / 4)).toBeCloseTo(patternAt(Math.PI / 4) ** 2, 12);
    const hp = halfPower(0.5);
    expect((hp.width * 180) / Math.PI).toBeCloseTo(78.1, 0);
    expect(powerAt(hp.lo)).toBeCloseTo(0.5, 6);
    expect(powerAt(hp.hi)).toBeCloseTo(0.5, 6);
    expect(patternAt(hp.hi)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(surfaceAt(hp.hi, 0.5, 'power')).toBeCloseTo(0.5, 6);
    expect(surfaceAt(hp.hi, 0.5, 'field')).toBeCloseTo(Math.SQRT1_2, 6);
  });
  it('the drawn power ring is thinner than the field ring 45 degrees off broadside', () => {
    const pw = patternProfile(0.5, 'power', 36), fd = patternProfile(0.5, 'field', 36);
    expect(Math.hypot(...pw[9])).toBeLessThan(Math.hypot(...fd[9]));
    expect(Math.hypot(...pw[18])).toBeCloseTo(PATTERN_R * MM, 9);
    expect(surfaceAt(Math.PI / 4, 0.5, 'power')).toBeLessThan(surfaceAt(Math.PI / 4, 0.5, 'field'));
  });
});

describe('the length slider (Balanis ch. 4, sinusoidal current)', () => {
  it('gain 2.15 dBi at the half wave, 3.82 at the full wave, 5.16 at 1.25 lambda, 3.48 at 1.5 lambda', () => {
    expect(gainDbi(0.5)).toBeCloseTo(2.15, 2);
    expect(gainDbi(1)).toBeCloseTo(3.82, 2);
    expect(gainDbi(1.25)).toBeCloseTo(5.16, 2);
    expect(gainDbi(1.5)).toBeCloseTo(3.48, 2);
  });
  it('narrows toward the full wave (47.8 degrees) and splits into lobes at 1.5 lambda', () => {
    expect((halfPower(1).width * 180) / Math.PI).toBeCloseTo(47.8, 0);
    const lobes = (L: number) => { let n = 0; for (let i = 2; i < 179; i++) { const a = patternAt(((i - 1) * Math.PI) / 180, L), b = patternAt((i * Math.PI) / 180, L), c = patternAt(((i + 1) * Math.PI) / 180, L); if (b > a && b >= c && b > 0.05) n++; } return n; };
    expect(lobes(0.5)).toBe(1);
    expect(lobes(1)).toBe(1);
    expect(lobes(1.5)).toBe(3);
    expect(patternAt(0, 1.5)).toBe(0);
  });
  it('feed resistance: 73 ohm at the half wave, infinite at the full wave, Rr 199 ohm there', () => {
    expect(radiationResistance(0.5)).toBeCloseTo(73.1, 0);
    expect(feedResistance(0.5)).toBeCloseTo(73.1, 0);
    expect(radiationResistance(1)).toBeCloseTo(199, 0);
    expect(feedResistance(1)).toBe(Infinity);
  });
  it('1 W into 73 ohm is 0.165 A and 12 V peak; SWR 1.46 on 50 ohm, return loss 14.5 dB', () => {
    const d = feedDrive(73.1);
    expect(d.amps).toBeCloseTo(0.1654, 3);
    expect(d.volts).toBeCloseTo(12.1, 1);
    const m = mismatch(73.1);
    expect(m.swr).toBeCloseTo(1.46, 2);
    expect(m.returnLoss).toBeCloseTo(14.5, 1);
  });
  it('the voltage is odd about the feed, zero there, largest at the tips and in quadrature with the current', () => {
    const t = 0.25 * 2 * Math.PI;
    expect(voltageAt(0.001, t)).toBeCloseTo(0, 2);
    expect(voltageAt(cutHalf(0.5) - 0.001, t)).toBeCloseTo(1, 3);
    expect(voltageAt(-cutHalf(0.5) + 0.001, t)).toBeCloseTo(-1, 3);
    expect(voltageAt(1, 0)).toBeCloseTo(0, 12);
    expect(currentAt(1, t)).toBeCloseTo(0, 12);
  });
  it('the arms follow the slider: cut half length, current zero at the electrical tip, parts stay few', () => {
    const run = new DipoleRun();
    run.lwl = 1.5;
    expect(cutHalf(1.5)).toBeCloseTo((1.5 * LAMBDA - DEFICIT) / 2, 9);
    expect(currentAt(cutHalf(1.5), 0, 1.5)).toBeCloseTo(0, 9);
    for (let L = 0.25; L <= 1.5001; L += 0.05) for (const ph of [0, 0.7, 2, 4]) {
      expect(Math.abs(currentAt(cutHalf(L), ph, L))).toBeLessThan(1e-9);
      expect(Math.abs(currentAt(-cutHalf(L), ph, L))).toBeLessThan(1e-9);
      const r = new DipoleRun(); r.lwl = L; r.t = ph / (2 * Math.PI); expect(Math.abs(r.tip)).toBeLessThan(1e-9);
    }
    expect(Math.abs(voltageAt(cutHalf(0.5), Math.PI / 2))).toBeCloseTo(1, 9);
    const base = new DipoleRun();
    for (const feed of ['balanced', 'coax', 'balun'] as const) for (const mode of ['power', 'field'] as const) for (const r of [run, base]) {
      const m = dipoleModel(r, look({ feed, mode }));
      expect(m.items.length).toBeLessThan(60);
      const b = boundsOfNamed(m, ['arms']);
      expect(b.max[1]).toBeCloseTo(cutHalf(r.lwl) * MM, 3);
    }
  });
});
