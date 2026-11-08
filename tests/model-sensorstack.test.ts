// The image sensor's optical stack: the trace obeys Snell's law and the chapter's absorption, the microlens focuses
// where it is designed to, BSI keeps oblique light that FSI loses to its metal, and the drawing shows the trace.
import { describe, expect, it } from 'vitest';
import { absorptionDepth, bayerAt } from '../src/phys/imagesensor';
import { BAYER, FATES, K, lensHeight, tenths, lensRadius, refract, stackHeight, stackParts, stackSpec, traceStack, type Fate, type StackPalette } from '../src/widgets/sensorstack3dparts';
import { STACK_OPTICS as O, filterT, nSi } from '../src/widgets/sensorstackoptics';

const sum = (t: Record<Fate, number>) => t.own + t.cross + t.metal + t.filter + t.through;
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
    for (const il of ['fsi', 'bsi'] as const) for (const nm of [450, 550, 650, 900]) for (const a of [-25, 0, 12, 30]) for (const row of [0, 1] as const) {
      const r = traceStack(stackSpec(il), O, nm, a, row, 7);
      expect(sum(r.total)).toBeCloseTo(1, 9);
      for (const ray of r.rays) { expect(sum(ray.share)).toBeCloseTo(1, 9); for (const v of Object.values(ray.share)) expect(v).toBeGreaterThanOrEqual(-1e-12); }
    }
  });

  it('the microlens focuses at its design depth (paraxial)', () => {
    for (const il of ['fsi', 'bsi'] as const) {
      const s = stackSpec(il), n = O.nSi(550), rc = lensRadius(s, n);
      expect(lensHeight(s, rc)).toBeGreaterThan(0);
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
    for (const nm of [460, 530, 630]) for (const row of [0, 1] as const) {
      const b = traceStack(stackSpec('bsi'), O, nm, 0, row).total, f = traceStack(stackSpec('fsi'), O, nm, 0, row).total;
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
    expect(ir.through / (1 - ir.filter - ir.metal)).toBeGreaterThan(0.85);
    // At normal incidence through the cap a ray's path in silicon is barely longer than the silicon: what passes is e^(−L/d).
    const s = stackSpec('bsi'), d = absorptionDepth(650), t = traceStack(s, O, 650, 0, 0).total;
    const rest = t.own + t.cross + t.through;
    expect(t.through / rest).toBeLessThanOrEqual(Math.exp(-s.si / d) + 1e-9);
    expect(t.through / rest).toBeGreaterThan(Math.exp(-1.1 * s.si / d));
  });

  it('a ray ends at its absorption point, inside the silicon of the pixel that counts it', () => {
    for (const il of ['fsi', 'bsi'] as const) {
      const s = stackSpec(il), r = traceStack(s, O, 550, 10, 0);
      for (const ray of r.rays.filter((x) => x.absorbPx !== null)) {
        expect(ray.end[1]).toBeLessThanOrEqual(1e-9);
        expect(ray.end[1]).toBeGreaterThanOrEqual(-s.si - 1e-9);
        expect(ray.end[1]).toBeGreaterThanOrEqual(-r.depth - 1e-9);
        expect(ray.absorbPx).toBe(ray.end[0] < 0 ? 0 : 1);
      }
    }
  });

  it('draws the filters in the mosaic’s colours, the metal where the light meets it, and the absorption depth', () => {
    const col = (i: number): [number, number, number, number] => [i / 20, 0.3, 0.3, 1];
    const P: StackPalette = { lens: col(1), R: col(2), G: col(3), B: col(4), oxide: col(5), metal: [0.6, 0.1, 0.1], si: [0.1, 0.6, 0.1], diode: [0.1, 0.1, 0.6], dti: [0.9, 0.9, 0.9], beol: col(6), warn: [1, 0.5, 0], dim: [0.4, 0.4, 0.4] };
    for (const il of ['fsi', 'bsi'] as const) for (const row of [0, 1] as const) {
      const spec = stackSpec(il), trace = traceStack(spec, O, 600, 0, row), parts = stackParts({ spec, nm: 600, angle: 0, row, trace }, P);
      const filters = parts.filter((p) => p.color === P.R || p.color === P.G || p.color === P.B);
      expect(filters).toHaveLength(4);
      expect(filters.filter((p) => p.color === P.G)).toHaveLength(2);
      const metalAbove = parts.filter((p) => p.color === P.metal && p.pos[1] > 0);
      expect(metalAbove.length > 0).toBe(true);
      if (il === 'bsi') for (const m of metalAbove) expect(m.pos[1]).toBeLessThan(stackHeight(spec) * K);
      const line = parts.find((p) => p.kind === 'box' && (p.color as number[]).length === 4 && p.scale![0] === 2 * spec.pitch * K && p.scale![1] < 0.5);
      expect(line!.pos[1]).toBeCloseTo(-Math.min(absorptionDepth(600), spec.si) * K, 6);
      expect(parts.filter((p) => p.color === P.dti).length > 0).toBe(il === 'bsi');
    }
  });

  it('the readouts name every share and add up to exactly 100.0 %', () => {
    expect(FATES.map((f) => f.k).sort()).toEqual(['cross', 'filter', 'metal', 'own', 'through']);
    for (const il of ['fsi', 'bsi'] as const) for (let nm = 400; nm <= 1000; nm += 50) for (let a = -30; a <= 30; a += 5) for (const row of [0, 1] as const) {
      const t = tenths(traceStack(stackSpec(il), O, nm, a, row, 5).total);
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
});
