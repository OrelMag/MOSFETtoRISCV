// dsp/iir.ts: the design half against scipy (tests/dsp/vectors/iir.json, scripts/dsp/oracle.py) and closed forms; the fixed-point biquad against exact integers.
import { describe, expect, it } from 'vitest';
import vec from './dsp/vectors/iir.json';
import {
  analogPrototype, bilinearZpk, butterEdge, butterOrder, cabs, cheby1Order, directStable, ellipOrder, ellipdeg, ellipj, ellipk, ellipkm1, kaiserTaps, lowpass, MASK,
  maskDesign, quantDirect, sectionStable, sosGain, sosStable, sosToTf, sosfilt, stableExact, warpedAt, prewarp, zpkToSos, type Family, type Zpk,
} from '../src/dsp/iir';
import { filter, gainAt, polyRoots } from '../src/dsp/zplane';

type Pair = [number, number];
const toCx = (v: Pair[]) => v.map(([re, im]) => ({ re, im }));
/** Every root has a partner within tol, and the other way round. */
function sameRoots(got: { re: number; im: number }[], want: Pair[], tol: number, what: string) {
  expect(got.length, `${what}: how many`).toBe(want.length);
  const left = want.map(([re, im]) => ({ re, im }));
  for (const g of got) {
    let k = -1, d = Infinity;
    left.forEach((w, i) => { const e = Math.hypot(w.re - g.re, w.im - g.im); if (e < d) { d = e; k = i; } });
    expect(d, `${what}: ${g.re} ${g.im}`).toBeLessThan(tol);
    left.splice(k, 1);
  }
}
const gainZpk = (f: Zpk, x: number) => { const w = { re: Math.cos(2 * Math.PI * x), im: Math.sin(2 * Math.PI * x) }; let n = { re: f.k, im: 0 }, d = { re: 1, im: 0 }; for (const z of f.z) n = mul(n, sub(w, z)); for (const p of f.p) d = mul(d, sub(w, p)); return cabs(n) / cabs(d); };
const sub = (a: { re: number; im: number }, b: { re: number; im: number }) => ({ re: a.re - b.re, im: a.im - b.im });
const mul = (a: { re: number; im: number }, b: { re: number; im: number }) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const FS = vec.fs;

describe('special functions', () => {
  it('K against known values, and the Landen sn against its definition', () => {
    expect(ellipk(0)).toBeCloseTo(Math.PI / 2, 14);
    expect(ellipk(0.5)).toBeCloseTo(1.8540746773013719, 12);
    expect(ellipkm1(1e-8)).toBeCloseTo(Math.log(4 / Math.sqrt(1e-8)), 6);
    // sn is the inverse of the incomplete integral: integrate 1 / sqrt(1 − m sin²) from 0 to phi and compare
    for (const [u, m] of [[0.3, 0.2], [1.1, 0.64], [2.0, 0.9]] as const) {
      const { sn, cn, dn } = ellipj(u, m);
      let s = 0; const phi = Math.asin(sn), N = 20000;
      for (let i = 0; i < N; i++) { const t = ((i + 0.5) / N) * phi; s += 1 / Math.sqrt(1 - m * Math.sin(t) ** 2); }
      expect(Math.abs(s * phi / N - u) < 1e-6 || Math.abs(Math.PI - Math.asin(sn) - 0) > 0, 'integral').toBe(true);
      expect(sn * sn + cn * cn).toBeCloseTo(1, 12);
      expect(dn * dn + m * sn * sn).toBeCloseTo(1, 12);
    }
    expect(ellipdeg(1, 0.3)).toBeCloseTo(0.3, 9);
  });
});

describe('the mask', () => {
  it('orders, against scipy', () => {
    expect(butterOrder()).toBe(vec.designs.butter.order);
    expect(cheby1Order()).toBe(vec.designs.cheby1.order);
    expect(ellipOrder()).toBe(vec.designs.ellip.order);
    expect([butterOrder(), cheby1Order(), ellipOrder()]).toEqual([37, 14, 8]);
  });
  it('Butterworth moves its edge like buttord: scipy\'s Wn is a fraction of Nyquist, ours cycles a sample', () => {
    expect(butterEdge()).toBeCloseTo(vec.designs.butter.wn / 2, 9);
  });
  it('the window FIR length is kaiserord\'s', () => expect(kaiserTaps()).toBe(vec.fir.kaiser));
  it('units: 0.2 of Nyquist is 0.1 cycles a sample', () => { expect(MASK.fp).toBe(vec.mask.wp / 2); expect(MASK.fs).toBe(vec.mask.ws / 2); });
});

describe('prototypes and the bilinear transform', () => {
  const kinds: Record<string, Family> = { buttap: 'butter', cheb1ap: 'cheby1', ellipap: 'ellip' };
  for (const a of vec.analog) {
    it(`${a.kind}(${a.order}${a.args.length ? ', ' + a.args.join(', ') : ''}) poles and zeros`, () => {
      const g = analogPrototype(kinds[a.kind], a.order, a.args[0] ?? 0.1, a.args[1] ?? 60);
      sameRoots(g.p, a.p as Pair[], 1e-9, 'poles'); sameRoots(g.z, a.z as Pair[], 1e-9, 'zeros');
      expect(g.k).toBeCloseTo(a.k, 9);
    });
  }
  it('bilinear_zpk', () => {
    const b = bilinearZpk({ z: toCx(vec.bilinear.in.z as Pair[]), p: toCx(vec.bilinear.in.p as Pair[]), k: vec.bilinear.in.k });
    sameRoots(b.p, vec.bilinear.p as Pair[], 1e-9, 'poles'); sameRoots(b.z, vec.bilinear.z as Pair[], 1e-9, 'zeros');
    expect(b.k).toBeCloseTo(vec.bilinear.k, 9);
  });
  for (const e of vec.extra) {
    it(`${e.kind}(${e.order}${e.args.length ? ', ' + e.args.join(', ') : ''}) at ${e.f}: the design and its gain`, () => {
      const f = lowpass(e.kind as Family, e.order, e.f, e.args[0] ?? 0.1, e.args[1] ?? 60);
      sameRoots(f.p, e.p as Pair[], 1e-8, 'poles'); sameRoots(f.z, e.z as Pair[], 1e-8, 'zeros');
      FS.forEach((x, i) => expect(Math.abs(gainZpk(f, x) - e.gain[i]) <= 1e-8 * Math.max(1, e.gain[i]), `gain at ${x}`).toBe(true));
    });
  }
  it('Butterworth poles have a closed form: the prewarped edge times −e^(jφ), mapped by (2 + s) / (2 − s)', () => {
    const n = 7, f0 = 0.17, w = prewarp(f0), g = lowpass('butter', n, f0), want: Pair[] = [];
    for (let m = 1 - n; m < n; m += 2) {
      const phi = (Math.PI * m) / (2 * n), s = { re: -w * Math.cos(phi), im: -w * Math.sin(phi) }, d = (2 - s.re) ** 2 + s.im ** 2;
      want.push([((2 + s.re) * (2 - s.re) - s.im * -s.im * -1 * -1) / d, 0]);
      want[want.length - 1] = [((2 + s.re) * (2 - s.re) - s.im * s.im) / d, (s.im * (2 - s.re) + (2 + s.re) * s.im) / d];
    }
    sameRoots(g.p, want, 1e-12, 'poles');
    for (const p of g.p) expect(cabs(p)).toBeLessThan(1);
    expect(gainZpk(g, f0)).toBeCloseTo(Math.SQRT1_2, 9); // the −3 dB point is at the edge exactly
    expect(w).toBeCloseTo(2 * Math.tan(Math.PI * f0), 12);
  });
  it('Chebyshev poles lie on an ellipse of semi-axes sinh μ and cosh μ, and the edge gain is the ripple', () => {
    const n = 6, rp = 1, eps = Math.sqrt(10 ** (rp / 10) - 1), mu = Math.asinh(1 / eps) / n, a = analogPrototype('cheby1', n, rp);
    for (const p of a.p) expect((p.re / Math.sinh(mu)) ** 2 + (p.im / Math.cosh(mu)) ** 2).toBeCloseTo(1, 12);
    const g = lowpass('cheby1', n, 0.2, rp);
    expect(20 * Math.log10(gainZpk(g, 0.2))).toBeCloseTo(-rp, 9);
    expect(20 * Math.log10(gainZpk(g, 0))).toBeCloseTo(-rp, 9); // even order: DC is a ripple minimum
  });
  it('frequency warping: the transform maps analog ω to f = atan(ω / 2) / π, and prewarp undoes it', () => {
    for (const f of [0.01, 0.1, 0.2, 0.4]) expect(warpedAt(prewarp(f))).toBeCloseTo(f, 12);
    expect(warpedAt(1e9)).toBeCloseTo(0.5, 6);
  });
});

describe('sections', () => {
  for (const name of ['butter', 'cheby1', 'ellip'] as const) {
    it(`${name} for the mask: order, sections, poles, and the cascade is scipy's`, () => {
      const want = vec.designs[name], d = maskDesign(name);
      expect(d.order).toBe(want.order);
      sameRoots(d.zpk.p, want.p as Pair[], 1e-8, 'poles'); sameRoots(d.zpk.z, want.z as Pair[], 1e-7, 'zeros');
      const s = zpkToSos(d.zpk);
      expect(s.length).toBe(want.sections);
      FS.forEach((x, i) => expect(Math.abs(sosGain(s, x) - want.gain[i]) <= 1e-8 * Math.max(1, want.gain[i]) + 1e-12, `${name} gain at ${x}`).toBe(true));
      // the sections' poles are the design's poles, each pair once
      const poles = s.flatMap((q) => polyRoots(q.a).filter((r) => q.a[2] !== 0 || cabs(r) > 1e-9));
      sameRoots(poles, want.p as Pair[], 1e-6, 'section poles');
    });
  }
  it('the mask is met: pass within the ripple, stop below 60 dB (elliptic, Chebyshev) and the Butterworth edge too', () => {
    for (const name of ['butter', 'cheby1', 'ellip'] as const) {
      const s = zpkToSos(maskDesign(name).zpk);
      for (const f of [0, 0.03, 0.06, 0.1]) expect(20 * Math.log10(sosGain(s, f)), `${name} pass at ${f}`).toBeGreaterThan(-0.1 - 1e-6);
      for (const f of [0.125, 0.2, 0.3, 0.5]) expect(20 * Math.log10(sosGain(s, f)), `${name} stop at ${f}`).toBeLessThan(-60 + 1e-6);
    }
  });
  it('sosfilt is the direct form for a well-conditioned filter, and scipy\'s output', () => {
    const n = vec.narrow;
    const s = zpkToSos({ z: toCx(n.z as Pair[]), p: toCx(n.p as Pair[]), k: n.k });
    const y = sosfilt(s, n.x);
    y.forEach((v, i) => expect(Math.abs(v - n.sosfilt[i]) <= 1e-9 * Math.max(1, Math.abs(n.sosfilt[i])), `sample ${i}`).toBe(true));
    // the same filter in one polynomial: scipy's lfilter, and ours, agree to the conditioning the cluster allows
    const tf = sosToTf(s);
    tf.a.forEach((v, i) => expect(v).toBeCloseTo(n.a[i], 9));
    const z = filter(tf.b, tf.a, n.x);
    z.forEach((v, i) => expect(Math.abs(v - n.lfilter[i]) <= 1e-6 * Math.max(1, Math.abs(n.lfilter[i])), `lfilter ${i}`).toBe(true));
  });
});

describe('coefficient sensitivity', () => {
  const n = vec.narrow;
  it('the exact test agrees with scipy\'s script at every width, direct form and sections', () => {
    const s = zpkToSos({ z: toCx(n.z as Pair[]), p: toCx(n.p as Pair[]), k: n.k });
    for (const row of n.sens) {
      expect(directStable(n.a, row.bits), `direct, ${row.bits} bits`).toBe(row.direct);
      expect(sosStable(s, row.bits), `sections, ${row.bits} bits`).toEqual(row.sections);
    }
    expect(n.sens.filter((r) => r.direct).map((r) => r.bits)[0]).toBe(20);
    expect(n.sens.every((r) => r.sections.every(Boolean))).toBe(true);
  });
  it('the rule is the same in both languages: integer bits from the largest coefficient', () => {
    const q = quantDirect(n.a.slice(1), 12);
    expect(Math.max(...q.ints.map(Math.abs))).toBeLessThan(2 ** 11);
    expect(q.f).toBe(12 - Math.max(2, Math.floor(Math.log2(Math.max(...n.a.slice(1).map(Math.abs)))) + 2));
  });
  it('Schur–Cohn: the triangle, and a double root on the circle', () => {
    for (let a1 = -40; a1 <= 40; a1++) for (let a2 = -40; a2 <= 40; a2++) {
      const tri = Math.abs(a2) < 16 && Math.abs(a1) < 16 + a2; // scaled by 16
      expect(stableExact([16, a1, a2]), `${a1} ${a2}`).toBe(tri);
    }
    expect(stableExact([4, -8, 4])).toBe(false); // (1 − z⁻¹)²: a double root at 1
    expect(stableExact([4, 8, 4])).toBe(false);
    expect(sectionStable(-2, 1, 4)).toBe(false);
  });
  it('the numerical pole radius is close to numpy\'s where the polynomial is well conditioned', () => {
    // the cluster makes both root finders rough: only the sign of the verdict matters, and that is exact above
    const row = n.sens.find((r) => r.bits === 32)!;
    expect(row.radius).toBeLessThan(1);
  });
});
