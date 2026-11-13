// EUV lithography (phys/euv.ts, widgets/euv3dkit.ts) held to its sources and to its own geometry.
import { describe, expect, it } from 'vitest';
import { triangles } from '../src/gl/kit/geo';
import { CHAIN, CRA_DEG, OPTICS, R_MIRROR, REFLECTIONS, conesApart, halfAngleDeg, halfPitchNm, maskField, maskHalfDeg, onTargetNeeded, periodUs, powerAtIf, spacingMm, transmission } from '../src/phys/euv';
import { ELL, IF_X, MASK_AT, PATH, RAY_PSI, RIM_DEG, collectorAt, dropletsAt, focalSum, mainAt, normalAt, preY, scannerModel, sourceModel, srcDefault, yTo } from '../src/widgets/euv3dkit';
import { SILICON_EUV, chSilicon } from '../src/chapters/ch-silicon';

describe('the source (Fomenkov et al. 2017)', () => {
  it('75 m/s at 50 kHz is the paper’s 1.5 mm, one droplet every 20 µs', () => {
    expect(spacingMm(75, 50)).toBeCloseTo(1.5, 12);
    expect(periodUs(50)).toBe(20);
  });
  it('5 sr is a cone of about 78° round the axis', () => {
    expect(halfAngleDeg(5)).toBeGreaterThan(77);
    expect(halfAngleDeg(5)).toBeLessThan(79);
    expect(halfAngleDeg(2 * Math.PI)).toBeCloseTo(90, 9);
  });
  it('the power chain: 20 kW, all on target, makes more than 200 W, so the published figure asks for at least half on target', () => {
    expect(powerAtIf(20)).toBeGreaterThan(200);
    const need = onTargetNeeded(20, 200);
    expect(need).toBeGreaterThan(0.3);
    expect(need).toBeLessThan(1);
    expect(powerAtIf(20, { ...CHAIN, onTarget: need })).toBeCloseTo(200, 9);
  });
  it('every drawn ray reflects at the ellipsoid: on it, the focal sums equal 2a, the angles equal', () => {
    for (const ps of [...RAY_PSI, RIM_DEG]) {
      const q = collectorAt(ps);
      expect(focalSum(q)).toBeCloseTo(2 * ELL.a, 6);
      // the normal of the ellipse at q bisects the directions to the two foci
      const a = [-q[0], -q[1]], b = [IF_X - q[0], -q[1]], la = Math.hypot(a[0], a[1]), lb = Math.hypot(b[0], b[1]);
      const n = [(q[0] - ELL.c) / ELL.a ** 2, q[1] / ELL.b ** 2], ln = Math.hypot(n[0], n[1]);
      const ca = -(a[0] * n[0] + a[1] * n[1]) / (la * ln), cb = -(b[0] * n[0] + b[1] * n[1]) / (lb * ln);
      expect(ca).toBeCloseTo(cb, 9);
    }
  });
  it('the target falls from the pre-pulse to the focus by the main pulse; droplets keep their spacing', () => {
    const s = srcDefault(), m = mainAt(s);
    expect(preY(s) - m * spacingMm(s.vMs, s.fKhz)).toBeCloseTo(0, 9);
    const ys = dropletsAt({ ...s, tau: 0.9 }).map((d) => d.p[1]).sort((a, b) => a - b);
    for (let k = 1; k < ys.length; k++) expect(ys[k] - ys[k - 1]).toBeCloseTo(spacingMm(s.vMs, s.fKhz), 9);
  });
});

describe('the scanner', () => {
  it('ten reflections at 67 % leave about 2 %', () => {
    expect(REFLECTIONS).toBe(10);
    const t = transmission(R_MIRROR, REFLECTIONS);
    expect(t).toBeGreaterThan(0.015);
    expect(t).toBeLessThan(0.025);
  });
  it('NA 0.33 prints a 12 nm half-pitch at k1 0.3', () => {
    expect(Math.round(halfPitchNm(0.3, 13.5, 0.33))).toBe(12);
  });
  it('the cones at the mask: apart at 0.33 / 4×, overlapping at 0.55 / 4×, apart at 0.55 / 8×', () => {
    expect(OPTICS.map((o) => conesApart(o.na, o.mScan))).toEqual([true, false, true]);
    expect(maskHalfDeg(0.55, 4)).toBeGreaterThan(CRA_DEG);
  });
  it('every setting images the same mask field (104 × 132 mm on a 152 mm mask)', () => {
    for (const o of OPTICS) expect(maskField(o)).toEqual([104, 132]);
  });
  it('the chief ray meets the mask at 6° each side, and every mirror’s normal bisects the ray in and the ray out', () => {
    const mi = PATH.findIndex((s) => s.kind === 'mask');
    const n = normalAt(mi), inn = PATH[mi - 1].p, out = PATH[mi + 1].p;
    expect(n[0]).toBeCloseTo(0, 9);
    expect(n[1]).toBeCloseTo(-1, 9);
    for (const q of [inn, out]) {
      const d = [q[0] - MASK_AT[0], q[1] - MASK_AT[1]], ang = (Math.acos(-d[1] / Math.hypot(d[0], d[1])) * 180) / Math.PI;
      expect(ang).toBeCloseTo(CRA_DEG, 9);
    }
    for (let i = 1; i < PATH.length - 1; i++) {
      const p = PATH[i].p, m = normalAt(i), u = (v: number[]) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
      const a = u([PATH[i - 1].p[0] - p[0], PATH[i - 1].p[1] - p[1], 0]), b = u([PATH[i + 1].p[0] - p[0], PATH[i + 1].p[1] - p[1], 0]);
      expect(a[0] * m[0] + a[1] * m[1]).toBeCloseTo(b[0] * m[0] + b[1] * m[1], 9);
    }
  });
  it('yTo turns +y onto the normal', () => {
    const [x, y, z, w] = yTo([0.6, 0.8, 0]);
    // +y rotated by the quaternion: the second column of its matrix
    expect(2 * (x * y - w * z)).toBeCloseTo(0.6, 9);
    expect(1 - 2 * (x * x + z * z)).toBeCloseTo(0.8, 9);
    expect(2 * (y * z + w * x)).toBeCloseTo(0, 9);
  });
});

describe('the models and the chapter', () => {
  it('stay within their budgets; beats name known groups', () => {
    const s = srcDefault();
    for (const m of [sourceModel({ ...s, tau: mainAt(s) + 0.02 }), scannerModel({ optics: OPTICS[0], r: R_MIRROR })]) {
      expect(m.items.reduce((t, it) => t + triangles(it.geo), 0)).toBeLessThan(300_000);
      const groups = new Set(m.items.map((it) => it.group));
      for (const b of m.beats ?? []) for (const g of [...(b.frame ?? []), ...(b.show ?? [])]) expect(groups.has(g), `${b.title}: ${g}`).toBe(true);
    }
  });
  it('the step the codex index and the Layers link to is the EUV step', () => {
    expect(chSilicon.steps[SILICON_EUV].title).toBe('The light that draws it');
    expect(chSilicon.steps[SILICON_EUV].deep).toBe(true);
    expect(SILICON_EUV).toBe(chSilicon.steps.length - 1);
  });
});
