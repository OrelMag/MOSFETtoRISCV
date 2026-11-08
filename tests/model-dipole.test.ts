// The half-wave dipole model held to the radio chapter: its frequency, its stated length, the current's shape and the pattern formula.
import { describe, expect, it } from 'vitest';
import { chRadio } from '../src/chapters/ch-comm-radio';
import { C_M_S, dipoleField, wavelengthM } from '../src/phys/radio';
import { ANTENNA_GHZ } from '../src/widgets/radio';
import { CUT, DipoleRun, GAP, HALF_LEN, LAMBDA, LOOP_LIFE, PATTERN_R, currentAt, dipoleAnchors, dipoleParts, envelope, frontAt, loopBirth, loopsAt, loopOutline, patternAt, patternRing, type DipolePalette } from '../src/widgets/dipole3dparts';

const c = (i: number): [number, number, number] => [i / 10, 0.5, 0.5];
const P: DipolePalette = { rod: c(1), ins: c(2), pos: c(3), neg: c(4), e1: c(5), e2: c(6), pat: c(7), src: c(8), ghost: [0.5, 0.5, 0.5, 0.5] };

describe('length', () => {
  it('lambda / 2 is the length the chapter states, at the chapter frequency', () => {
    const body = chRadio.steps[0].body as string;
    const cm = (wavelengthM(ANTENNA_GHZ) * 50).toFixed(1);
    expect(body).toContain(`${cm} cm at ${ANTENNA_GHZ.toFixed(1)} GHz`);
    expect(2 * HALF_LEN).toBeCloseTo(wavelengthM(ANTENNA_GHZ) * 50, 9);
    expect(LAMBDA).toBeCloseTo((C_M_S / (ANTENNA_GHZ * 1e9)) * 100, 9);
  });
  it('the drawn rods span the stated length tip to tip', () => {
    const run = new DipoleRun();
    const ys = dipoleParts(run, false, P).filter((p) => p.kind === 'cyl' && p.scale![0] > 0.3).flatMap((p) => [p.pos![1] - p.scale![1] / 2, p.pos![1] + p.scale![1] / 2]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * HALF_LEN, 6);
    expect(GAP).toBeLessThan(HALF_LEN / 10);
  });
});

describe('current', () => {
  it('is zero at the tips and maximal at the feed at every phase', () => {
    for (const t of [0, 0.125, 0.3, 0.5, 0.7]) {
      const ph = 2 * Math.PI * t;
      expect(Math.abs(currentAt(HALF_LEN, ph))).toBeLessThan(1e-9);
      expect(Math.abs(currentAt(-HALF_LEN, ph))).toBeLessThan(1e-9);
      for (let i = 1; i < 40; i++) expect(Math.abs(currentAt((HALF_LEN * i) / 40, ph))).toBeLessThanOrEqual(Math.abs(currentAt(0, ph)) + 1e-12);
    }
    expect(envelope(0)).toBe(1);
    expect(envelope(HALF_LEN)).toBe(0);
  });
  it('is cos(kz) in space and oscillates at the period of the chapter frequency', () => {
    for (let i = 0; i <= 10; i++) { const z = (HALF_LEN * i) / 10; expect(currentAt(z, 0)).toBeCloseTo(Math.cos((2 * Math.PI * z) / LAMBDA), 12); }
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
  it('the drawn rings lie at radius R f(theta) from the origin, polar angle from the y axis', () => {
    for (const az of [CUT, 2, 3.5]) {
      const pts = patternRing(az, PATTERN_R, 36);
      pts.forEach((p, i) => {
        const th = (Math.PI * i) / 36;
        expect(Math.hypot(...p)).toBeCloseTo(PATTERN_R * patternAt(th), 9);
        if (i === 0 || i === 36) expect(Math.hypot(...p)).toBeLessThan(1e-9);
      });
      const eq = pts[18];
      expect(Math.abs(eq[1])).toBeLessThan(1e-9);
      expect(Math.hypot(eq[0], eq[2])).toBeCloseTo(PATTERN_R, 9);
    }
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
  it('draws something in every phase, with and without the pattern, and labels stay few', () => {
    const run = new DipoleRun();
    for (let k = 0; k < 8; k++) {
      expect(dipoleParts(run, true, P).length).toBeGreaterThan(dipoleParts(run, false, P).length);
      expect(dipoleAnchors(run, true).length).toBeGreaterThan(dipoleAnchors(run, false).length - 1);
      run.step();
    }
  });
});
