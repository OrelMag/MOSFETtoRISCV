// The image sensor's optical stack: the trace obeys Snell's law and the chapter's absorption, the microlens focuses
// where it is designed to, BSI keeps oblique light that FSI loses to its metal, and the drawing shows the trace.
import { describe, expect, it } from 'vitest';
import { absorptionDepth, bayerAt } from '../src/phys/imagesensor';
import { angleCurve, BAYER, DIODE_DEPTH, diodeSpan, FATES, K, lensHeight, tenths, lensRadius, PITCHES, PPLUS, refract, siReflectance, spotSize, stackHeight, stackSpec as specOf, traceStack, type Fate, type Illum } from '../src/widgets/sensorstack3dgeom';
import { stackModel } from '../src/widgets/sensorstack3dkit';
import { IMX183, STACK_BSI } from '../src/phys/imagesensor';
import { STACK_OPTICS as O, filterT, nSi } from '../src/widgets/sensorstackoptics';

const sum = (t: Record<Fate, number>) => t.own + t.cross + t.metal + t.filter + t.reflected + t.through;
/** The 1.0 µm pixel unless a pitch is given: the tests written for the FSI limit. */
const stackSpec = (il: Illum, pitch = 1.0, ar = true) => specOf(il, { pitch, ar });
const ALL = PITCHES.flatMap((p) => (['fsi', 'bsi'] as const).flatMap((il) => [true, false].map((ar) => stackSpec(il, p, ar))));
const sinOf = (d: [number, number]) => Math.abs(d[0]) / Math.hypot(d[0], d[1]);

describe('the optical stack', () => {
  it('refracts by Snell’s law and reflects past the critical angle', () => {
    for (const a of [0.1, 0.4, 0.8]) for (const [n1, n2] of [[1, 1.6], [1.6, 1.46], [1.46, 4]]) {
      const d: [number, number] = [Math.sin(a), -Math.cos(a)], r = refract(d, [0, 1], n1, n2)!;
      expect(n2 * sinOf(r)).toBeCloseTo(n1 * Math.sin(a), 9);
      expect(Math.hypot(...r)).toBeCloseTo(1, 9);
    }
    expect(refract([Math.sin(1.2), -Math.cos(1.2)], [0, 1], 4, 1.46)).toBeNull();
  });

  it('uses the chapter’s Bayer mosaic and silicon', () => {
    expect(BAYER).toEqual([[bayerAt(0, 0), bayerAt(1, 0)], [bayerAt(0, 1), bayerAt(1, 1)]]);
    for (const nm of [450, 550, 650, 850]) expect(traceStack(stackSpec('bsi'), O, nm, 0, 0).depth).toBe(absorptionDepth(nm));
    expect(nSi(500)).toBeCloseTo(4.29, 2);
    expect(filterT('G', 525)).toBeGreaterThan(filterT('G', 640) * 5);
    expect(filterT('R', 900)).toBeGreaterThan(0.8);
  });

  it('every ray’s power is accounted for', () => {
    for (const s of ALL) for (const nm of [450, 550, 650, 900]) for (const a of [-25, 0, 12, 30]) for (const row of [0, 1] as const) {
      const r = traceStack(s, O, nm, a, row, 7);
      expect(sum(r.total)).toBeCloseTo(1, 9);
      for (const ray of r.rays) { expect(sum(ray.share)).toBeCloseTo(1, 9); for (const v of Object.values(ray.share)) expect(v).toBeGreaterThanOrEqual(-1e-12); }
    }
  });

  it('the microlens focuses at its design depth (paraxial)', () => {
    for (const p of PITCHES) for (const il of ['fsi', 'bsi'] as const) {
      const s = stackSpec(il, p), n = O.nSi(550), rc = lensRadius(s, n);
      expect(lensHeight(s, rc)).toBeGreaterThan(0);
      expect(rc).toBeGreaterThan(s.pitch / 2 + 0.02); // a cap that can focus there, not clamped to a hemisphere
      // A ray close to a pixel's axis, at normal incidence: where it crosses the axis.
      const r = traceStack({ ...s, metal: [], dti: false }, { ...O, nSi: () => n, filterT: () => 1, depthUm: () => 100 }, 550, 0, 0, 200);
      const axis = -s.pitch / 2, ray = r.rays.reduce((a, b) => (Math.abs(b.paths[0][0][0] - axis + 0.03) < Math.abs(a.paths[0][0][0] - axis + 0.03) ? b : a));
      const path = ray.paths.flat();
      let cross = NaN;
      for (let k = 1; k < path.length; k++) {
        const [a, b] = [path[k - 1], path[k]];
        if ((a[0] - axis) * (b[0] - axis) <= 0 && a[0] !== b[0]) { cross = a[1] + ((axis - a[0]) / (b[0] - a[0])) * (b[1] - a[1]); break; }
      }
      expect(cross).toBeCloseTo(-s.focus, 1);
    }
  });

  it('at normal incidence the lenses bring the light through: no crosstalk, the metal’s apertures clear', () => {
    for (const p of PITCHES) for (const nm of [460, 530, 630]) for (const row of [0, 1] as const) {
      const b = traceStack(stackSpec('bsi', p), O, nm, 0, row).total, f = traceStack(stackSpec('fsi', p), O, nm, 0, row).total;
      expect(b.cross).toBe(0);
      expect(b.metal).toBe(0);
      expect(f.cross).toBe(0);
      expect(f.metal / (1 - f.filter)).toBeLessThan(0.05);
    }
  });

  it('oblique light: FSI’s metal vignettes it, BSI keeps more in its own pixel', () => {
    for (const nm of [460, 530, 630]) for (const a of [10, -10, 15, 20]) {
      const b = traceStack(stackSpec('bsi'), O, nm, a, 0).total, f = traceStack(stackSpec('fsi'), O, nm, a, 0).total;
      const f0 = traceStack(stackSpec('fsi'), O, nm, 0, 0).total;
      expect(f.metal).toBeGreaterThan(f0.metal);
      expect(f.metal / (1 - f.filter)).toBeGreaterThan(b.metal / (1 - b.filter) + 0.25);
      expect(b.own).toBeGreaterThan(2 * f.own);
    }
  });

  it('blue is absorbed near the surface, near infrared mostly passes the thin silicon', () => {
    const blue = traceStack(stackSpec('bsi'), O, 450, 0, 1).total, ir = traceStack(stackSpec('bsi'), O, 900, 0, 0).total;
    expect(blue.through).toBeLessThan(0.002);
    expect(ir.through / (1 - ir.filter - ir.metal - ir.reflected)).toBeGreaterThan(0.85);
    // At normal incidence through the cap a ray's path in silicon is barely longer than the silicon: what passes is e^(−L/d).
    const s = stackSpec('bsi'), d = absorptionDepth(650), t = traceStack(s, O, 650, 0, 0).total;
    const rest = t.own + t.cross + t.through;
    expect(t.through / rest).toBeLessThanOrEqual(Math.exp(-s.si / d) + 1e-9);
    expect(t.through / rest).toBeGreaterThan(Math.exp(-1.1 * s.si / d));
  });

  it('a ray ends at its absorption point, inside the silicon of the pixel that counts it', () => {
    for (const s of ALL) {
      const r = traceStack(s, O, 550, 10, 0);
      for (const ray of r.rays.filter((x) => x.absorbPx !== null)) {
        expect(ray.end[1]).toBeLessThanOrEqual(1e-9);
        expect(ray.end[1]).toBeGreaterThanOrEqual(-s.si - 1e-9);
        expect(ray.end[1]).toBeGreaterThanOrEqual(-r.depth - 1e-9);
        expect(ray.absorbPx).toBe(ray.end[0] < 0 ? 0 : 1);
      }
    }
  });

  it('draws the filters in the mosaic’s colours, the metal where the light meets it, and the absorption depth', () => {
    for (const p of PITCHES) for (const il of ['fsi', 'bsi'] as const) for (const row of [0, 1] as const) {
      const spec = stackSpec(il, p), trace = traceStack(spec, O, 600, 0, row), m = stackModel({ spec, nm: 600, angle: 0, row, trace });
      const filters = m.items.filter((i) => i.name === 'colour filter');
      expect(filters).toHaveLength(4);
      expect(filters.filter((i) => i.mat.label === 'green filter (dyed resist)')).toHaveLength(2);
      // the front (cut) row's two filters are the mosaic's row, in order
      const front = filters.filter((i) => i.at![2] > 0).sort((a, b) => a.at![0] - b.at![0]).map((i) => i.mat.label![0].toUpperCase());
      expect(front).toEqual([...BAYER[row]]);
      const metalAbove = m.items.filter((i) => i.name === 'metal' && i.at![1] > 0);
      expect(metalAbove.length > 0).toBe(true);
      if (il === 'bsi') for (const x of metalAbove) expect(x.at![1]).toBeLessThan(stackHeight(spec) * K);
      const line = m.items.find((i) => i.name === 'absorption depth')!;
      expect(line.at![1]).toBeCloseTo(-Math.min(absorptionDepth(600), spec.si) * K, 6);
      expect(line.geo.max[0] - line.geo.min[0]).toBeCloseTo(2 * spec.pitch * K, 6);
      expect(m.items.some((i) => i.name === 'deep trench isolation')).toBe(il === 'bsi');
      expect(m.items.filter((i) => i.name === 'microlens')).toHaveLength(4);
    }
  });

  it('the readouts name every share and add up to exactly 100.0 %', () => {
    expect(FATES.map((f) => f.k).sort()).toEqual(['cross', 'filter', 'metal', 'own', 'reflected', 'through']);
    for (const s of ALL) for (let nm = 400; nm <= 1000; nm += 100) for (let a = -30; a <= 30; a += 10) for (const row of [0, 1] as const) {
      const t = tenths(traceStack(s, O, nm, a, row, 5).total);
      expect(Object.values(t).reduce((x, y) => x + y, 0)).toBe(1000);
      for (const v of Object.values(t)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('FSI at a 1.0 µm pitch: the focal spot walks onto the edge metal by 15°, its stack being far taller than the pixel is wide', () => {
    const s = stackSpec('fsi'), passed = (a: number) => { const t = traceStack(s, O, 540, a, 0, 25).total; return { own: t.own / (1 - t.filter), metal: t.metal / (1 - t.filter) }; };
    expect(passed(0).own).toBeGreaterThan(0.8);
    expect(passed(10).own).toBeLessThan(passed(5).own);
    expect(passed(15).own).toBeLessThan(0.02);
    expect(passed(20).metal).toBeGreaterThan(0.98);
    // the walk: the beam's angle in oxide times the depth from the lens to its focus passes the top metal's aperture
    // (the edge line's inner side, measured from the pixel's centre) at 15°
    const inOx = Math.asin(Math.sin((15 * Math.PI) / 180) / 1.46), top = s.metal.reduce((a, m) => (m.y1 > a.y1 && m.x0 < 0 && m.x1 > 0 ? m : a));
    expect((stackHeight(s) + s.focus) * Math.tan(inOx)).toBeGreaterThan(s.pitch / 2 - (top.x1 - top.x0) / 2);
  });

  it('two pitches: the chapter’s IMX183 over its 3 µm of silicon by default, 1.0 µm over 2.7 µm; the metal the same in µm', () => {
    expect(PITCHES[0]).toBe(IMX183.pitch);
    const d = specOf('bsi');
    expect(d.pitch).toBe(IMX183.pitch);
    expect(d.si).toBe(STACK_BSI.collect);
    expect(stackSpec('bsi', 1.0).si).toBe(2.7);
    const w = (p: number) => stackSpec('fsi', p).metal.map((m) => +(m.x1 - m.x0).toFixed(9));
    expect(w(2.4)).toEqual(w(1.0));
  });

  it('reflection at the silicon: Fresnel bare, a quarter-wave film near zero at its design wavelength, and the trace takes that share', () => {
    const n = O.nSi(550), bare = ((1.46 - n) / (1.46 + n)) ** 2;
    expect(siReflectance(1.46, n, 550, null)).toBeCloseTo(bare, 12);
    expect(bare).toBeGreaterThan(0.2);
    const s = stackSpec('bsi', 2.4), arc = s.arc!;
    expect(arc.n * arc.d * 1000).toBeCloseTo(550 / 4, 9);
    // the ideal film's residual: ((n0 nSi − na²) / (n0 nSi + na²))²
    expect(siReflectance(1.46, n, 550, arc)).toBeCloseTo(((1.46 * n - arc.n ** 2) / (1.46 * n + arc.n ** 2)) ** 2, 9);
    expect(siReflectance(1.46, n, 550, arc)).toBeLessThan(0.03);
    for (const ar of [true, false]) {
      const sp = stackSpec('bsi', 2.4, ar), R = siReflectance(1.46, O.nSi(550), 550, sp.arc);
      for (const ray of traceStack(sp, O, 550, 0, 0).rays) {
        const past = ray.share.reflected + ray.share.own + ray.share.cross + ray.share.through;
        expect(ray.share.reflected).toBeCloseTo(R * past, 12);
      }
    }
    expect(traceStack(stackSpec('bsi', 2.4, false), O, 550, 0, 0).total.own).toBeLessThan(traceStack(stackSpec('bsi', 2.4, true), O, 550, 0, 0).total.own);
  });

  it('the photodiode fills two thirds of the silicon on the metal side, under its p+ layer', () => {
    for (const s of ALL) {
      const [d0, d1] = diodeSpan(s);
      expect(d1 - d0).toBeCloseTo(DIODE_DEPTH * s.si, 12);
      if (s.illum === 'fsi') expect(d1).toBeCloseTo(-PPLUS, 12); // metal above: the diode at the top
      else expect(d0).toBeCloseTo(-s.si + PPLUS, 12); // metal below: the diode at the bottom
      const items = stackModel({ spec: s, nm: 550, angle: 0, row: 0, trace: traceStack(s, O, 550, 0, 0) }).items;
      const diodes = items.filter((i) => i.name === 'photodiode');
      expect(diodes).toHaveLength(4);
      for (const p of diodes) { expect(p.geo.max[1] - p.geo.min[1]).toBeCloseTo(DIODE_DEPTH * s.si * K, 4); expect(p.at![1]).toBeCloseTo(((d0 + d1) / 2) * K, 9); }
      expect(items.filter((i) => i.name === 'p+ pinning layer')).toHaveLength(4);
      expect(items.filter((i) => i.name === 'anti-reflection film')).toHaveLength(s.arc ? 4 : 0);
    }
  });

  it('the diffraction-limited spot: 2.44 λ N, wider than a 1.0 µm FSI pixel, narrower than the IMX183’s', () => {
    for (const s of ALL) {
      const rc = lensRadius(s, O.nSi(550));
      expect(spotSize(s, rc, 550)).toBeCloseTo((2.44 * 0.55 * (rc / (s.nLens - 1))) / s.pitch, 12);
    }
    const at = (il: Illum, p: number) => { const s = stackSpec(il, p); return spotSize(s, lensRadius(s, O.nSi(550)), 550) / s.pitch; };
    expect(at('fsi', 1.0)).toBeGreaterThan(1);
    expect(at('bsi', 2.4)).toBeLessThan(0.5);
    expect(at('fsi', 2.4)).toBeLessThan(0.6);
  });

  it('the angular response: at 1.0 µm BSI keeps what FSI loses, FSI gone by 16°; at 2.4 µm both hold to 10°, FSI falling first', () => {
    const A = Array.from({ length: 16 }, (_, i) => i * 2);
    const f1 = angleCurve(stackSpec('fsi', 1.0), O, 540, A), b1 = angleCurve(stackSpec('bsi', 1.0), O, 540, A);
    A.forEach((a, i) => { if (a >= 6) expect(b1[i]).toBeGreaterThan(f1[i]); });
    const f2 = angleCurve(stackSpec('fsi', 2.4), O, 540, A), b2 = angleCurve(stackSpec('bsi', 2.4), O, 540, A);
    A.forEach((a, i) => { if (a <= 10) { expect(f2[i]).toBeGreaterThan(0.6); expect(b2[i]).toBeGreaterThan(0.6); } });
    expect(f2[A.length - 1]).toBeLessThan(b2[A.length - 1]);
    expect(f2[A.length - 1]).toBeLessThan(f2[0] / 2);
    expect(f1[8]).toBe(0);
    expect(f1[0]).toBeGreaterThan(0.75);
  });
});
