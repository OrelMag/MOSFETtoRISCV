// The cut-away fibre (widgets/fibre3dparts.ts) held to the chapter's model (phys/fibre.ts, the numbers of ch-comm-glass.ts).
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { acceptanceDeg, criticalDeg, MMF_50, modesLarge, n2Of, naOf, rayOf, SMF_G652, stepDelayPsKm, vNumber } from '../src/phys/fibre';
import { endTau, facts, fanAngles, fibreAnchors, fibreParts, FIBRES, lagFactor, pulseView, rayDelayNs, rayPath, coreR, R_CLAD, R_COAT, SIGMA_NS, X1, type FibrePalette } from '../src/widgets/fibre3dparts';

const G: RGB = [0.5, 0.5, 0.5], C: RGBA = [0.5, 0.5, 0.5, 0.3];
const P: FibrePalette = { glass: C, coat: C, core: G, coreEnd: G, ray: [1, 0, 0], fan: [0, 0, 1], leak: [1, 0.5, 0], pulse: [0, 1, 0], glow: C, air: G, cut: G };

describe('critical angle and guiding', () => {
  for (const kind of ['multi', 'single'] as const) {
    const f = FIBRES[kind], n2 = n2Of(f), crit = criticalDeg(f.n1, n2), acc = acceptanceDeg(naOf(f.n1, n2));
    it(`${kind}: the facts are the chapter's`, () => {
      const k = facts(kind, 5);
      expect(k.criticalDeg).toBe(crit);
      expect(k.na).toBe(naOf(f.n1, n2));
      expect(k.acceptDeg).toBe(acc);
      expect(k.v).toBe(vNumber(f.aUm, naOf(f.n1, n2), kind === 'multi' ? 0.85 : 1.55));
    });
    it(`${kind}: a ray is guided exactly when rayOf says so, and when its incidence is beyond the critical angle`, () => {
      for (let d = 0; d <= 25; d += 0.5) {
        const p = rayPath(d, f), g = rayOf(d, f.n1, n2);
        expect(p.guided).toBe(g.guided);
        expect(p.incidenceDeg >= crit).toBe(g.guided);
        if (d < acc - 1e-6) expect(p.guided).toBe(true);
        if (d > acc + 1e-6) expect(p.guided).toBe(false);
      }
    });
    it(`${kind}: the drawn path stays in the core when guided and ends in the cladding when it leaks`, () => {
      const r = coreR(f);
      for (const d of [0, 2, acc * 0.9, acc * 1.2, 25]) {
        const p = rayPath(d, f);
        if (p.guided) for (const [, y] of p.pts) expect(Math.abs(y)).toBeLessThanOrEqual(r + 1e-9);
        else { const last = p.pts[p.pts.length - 1]; expect(last[1]).toBeGreaterThan(r); expect(last[1]).toBeLessThanOrEqual(R_COAT + 1e-9); expect(p.leaveDeg).toBeGreaterThan(0); }
      }
    });
  }
  it('the fibres are the chapter\'s: 50 and 8 µm cores in a 125 µm cladding and a 250 µm coating, ratios true', () => {
    expect(FIBRES.multi).toBe(MMF_50); expect(FIBRES.single).toBe(SMF_G652);
    expect(R_COAT / R_CLAD).toBe(2);
    expect(coreR(MMF_50) / R_CLAD).toBeCloseTo(50 / 125, 12);
    expect(coreR(SMF_G652) / R_CLAD).toBeCloseTo(8 / 125, 12);
  });
  it('a single-mode core has V under 2.405 (one mode) and the multimode one about V²/2 modes', () => {
    expect(facts('single', 0).singleMode).toBe(true);
    const m = facts('multi', 0);
    expect(m.singleMode).toBe(false);
    expect(m.modes).toBe(modesLarge(m.v));
  });
});

describe('the pulse spread', () => {
  it('multimode: the steepest guided ray lags by the chapter\'s n1 * delta / c per km, within the delta/(1-delta) of its derivation', () => {
    const p = pulseView('multi', 1);
    expect(p.spreadNs).toBeCloseTo(stepDelayPsKm(MMF_50) / 1000, 9);
    expect(p.fanMaxNs / p.spreadNs).toBeGreaterThan(0.99);
    expect(p.fanMaxNs / p.spreadNs).toBeLessThan(1.015);
    expect(p.delays[0]).toBe(0);
    for (let i = 1; i < p.delays.length; i++) expect(p.delays[i]).toBeGreaterThan(p.delays[i - 1]);
  });
  it('the spread scales with length and the output is wider and lower with equal energy', () => {
    const a = pulseView('multi', 1), b = pulseView('multi', 2);
    expect(b.spreadNs / a.spreadNs).toBeCloseTo(2, 9);
    const dt = (q: typeof a) => q.t[1] - q.t[0];
    const area = (v: number[], q: typeof a) => v.reduce((s, x) => s + x, 0) * dt(q);
    expect(area(a.output, a)).toBeCloseTo(area(a.input, a), 1);
    expect(Math.max(...a.output)).toBeLessThan(Math.max(...a.input));
    expect(a.rmsOutNs).toBeGreaterThan(SIGMA_NS);
  });
  it('single-mode: one delay, no spread, the output is the input', () => {
    const p = pulseView('single');
    expect(p.delays).toEqual([0]); expect(p.spreadNs).toBe(0);
    p.input.forEach((v, i) => expect(p.output[i]).toBeCloseTo(v, 12));
    expect(p.rmsOutNs).toBeCloseTo(SIGMA_NS, 12);
  });
  it('a ray\'s delay is (stretch - 1) n1 L / c from rayOf', () => {
    expect(rayDelayNs(0, MMF_50)).toBe(0);
    const d = 8, g = rayOf(d, MMF_50.n1, n2Of(MMF_50));
    expect(rayDelayNs(d, MMF_50, 1)).toBeCloseTo(((g.stretch - 1) * MMF_50.n1 * 1e12) / 299792.458 / 1000, 12);
  });
});

describe('the drawing', () => {
  it('draws a packet per fan ray in multimode and one on the axis in single-mode, none before a pulse is sent', () => {
    const count = (kind: 'multi' | 'single', tau: number, deg = 4) => fibreParts({ kind, deg, tau }, P).filter((p) => p.color === P.pulse).length;
    expect(count('multi', -1)).toBe(0); expect(count('multi', 0.5)).toBe(5);
    expect(count('single', 0.5)).toBe(1); expect(count('single', 0.5, 20)).toBe(0);
  });
  it('the slow rays are behind at the same moment, and all have arrived by the end', () => {
    const f = MMF_50, ang = fanAngles(f, 5), lag = ang.map((d) => lagFactor(rayPath(d, f).stretch));
    for (let i = 1; i < lag.length; i++) expect(lag[i]).toBeLessThan(lag[i - 1]);
    const parts = fibreParts({ kind: 'multi', deg: 4, tau: endTau('multi') }, P).filter((p) => p.color === P.pulse);
    for (const q of parts) expect(q.pos[0]).toBeGreaterThan(X1 - 1.5);
  });
  it('labels the three layers with the true sizes and says what the ray does', () => {
    const t = fibreAnchors({ kind: 'multi', deg: 4, tau: -1 }).map((a) => a.text).join('|');
    expect(t).toContain('50 µm'); expect(t).toContain('125 µm'); expect(t).toContain('250 µm'); expect(t).toContain('total internal reflection');
    expect(fibreAnchors({ kind: 'multi', deg: 20, tau: -1 }).map((a) => a.text).join('|')).toContain('leaks');
  });
});
