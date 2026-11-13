// The cut-away fibre (widgets/fibre3dparts.ts) held to the chapter's model (phys/fibre.ts, the numbers of ch-comm-glass.ts).
import { describe, expect, it } from 'vitest';
import { acceptanceDeg, criticalDeg, gradedDelayPsKm, MMF_50, modesLarge, n2Of, naOf, rayOf, SMF_G652, stepDelayPsKm, vNumber } from '../src/phys/fibre';
import { endTau, facts,  fanAngles, fibreAnchors, FIBRES, lagFactor, pulseView, rayDelayNs, rayPath, rayPathGraded, rayDelayGradedNs, turnFraction, lagFactorGraded, UM, MFD_UM, coreR, R_CLAD, R_COAT, SIGMA_NS, X0, X1 } from '../src/widgets/fibre3dparts';
import { MATS, fibreModel, packetsAt } from '../src/widgets/fibre3dkit';


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
    expect(facts('multi', 0, 'step').modes).toBe(modesLarge(m.v));
    expect(m.modes).toBe(modesLarge(m.v) / 2); // graded (the default): V²/4
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
    const count = (kind: 'multi' | 'single', tau: number, deg = 4) => packetsAt({ kind, deg, tau }).length;
    expect(count('multi', -1)).toBe(0); expect(count('multi', 0.5)).toBe(5);
    expect(count('single', 0.5)).toBe(1); expect(count('single', 0.5, 20)).toBe(0);
  });
  it('the slow rays are behind at the same moment, and all have arrived by the end', () => {
    const f = MMF_50, ang = fanAngles(f, 5), lag = ang.map((d) => lagFactor(rayPath(d, f).stretch));
    for (let i = 1; i < lag.length; i++) expect(lag[i]).toBeLessThan(lag[i - 1]);
    const ps = packetsAt({ kind: 'multi', deg: 4, tau: endTau('multi') });
    expect(ps).toHaveLength(5);
    for (const q of ps) expect(q[0]).toBeGreaterThan(X1 - 1.5);
  });
  it('labels the three layers with the true sizes and says what the ray does', () => {
    const t = fibreAnchors({ kind: 'multi', deg: 4, tau: -1, profile: 'step' }).map((a) => a.text).join('|');
    expect(t).toContain('50 µm'); expect(t).toContain('125 µm'); expect(t).toContain('250 µm'); expect(t).toContain('total internal reflection');
    expect(fibreAnchors({ kind: 'multi', deg: 20, tau: -1, profile: 'step' }).map((a) => a.text).join('|')).toContain('leaks');
  });
});

describe('graded index (what every 50/125 fibre has: ITU-T G.651.1)', () => {
  const f = MMF_50, n2 = n2Of(f), na = naOf(f.n1, n2), acc = acceptanceDeg(na);
  it('the drawn stretch is 1 mm of real fibre: 80 units of 12.5 µm', () => {
    expect(UM).toBe(12.5);
    expect(((X1 - -40) * UM) / 1000).toBe(1);
  });
  it('a guided ray is a sinusoid of period 2π a n1 cosθ / NA and turns back at sin(launch) / NA of the core radius', () => {
    const r = coreR(f);
    for (const d of [2, 5, acc * 0.9]) {
      const p = rayPathGraded(d, f, -40, 40, 0.5), rho = Math.sin((d * Math.PI) / 180) / na;
      expect(turnFraction(d, f)).toBeCloseTo(rho, 12);
      const ymax = Math.max(...p.pts.map(([, y]) => Math.abs(y)));
      expect(p.guided).toBe(true);
      expect(ymax).toBeLessThanOrEqual(rho * r + 1e-9);
      expect(ymax).toBeGreaterThan(rho * r * 0.97);
      const beta = f.n1 * Math.cos((p.coreDeg * Math.PI) / 180), k = na / (beta * r);
      for (const [x, y] of p.pts) expect(y).toBeCloseTo(rho * r * Math.sin(k * (x + 40)), 9);
    }
    // the period at the paraxial limit: 2π a / sqrt(2 delta) = 1.1 mm for a = 25 µm, delta = 1 %
    const k0 = na / (f.n1 * r);
    expect(((2 * Math.PI) / k0) * UM / 1000).toBeGreaterThan(1.05);
    expect(((2 * Math.PI) / k0) * UM / 1000).toBeLessThan(1.15);
  });
  it('guided exactly inside the acceptance cone, as in a step core; the leaking ray reaches the wall and heads out', () => {
    for (let d = 0; d <= 25; d += 0.5) {
      const p = rayPathGraded(d, f);
      expect(p.guided).toBe(rayOf(d, f.n1, n2).guided);
      if (!p.guided) {
        const last = p.pts[p.pts.length - 1];
        expect(last[1]).toBeGreaterThan(coreR(f)); expect(last[1]).toBeLessThanOrEqual(R_COAT + 1e-9); expect(p.leaveDeg).toBeGreaterThan(0);
      } else for (const [, y] of p.pts) expect(Math.abs(y)).toBeLessThanOrEqual(coreR(f) + 1e-9);
    }
  });
  it('the spread is the chapter\'s n1 Δ²/8c (61 ps/km), the extreme ray carries it, the fourth power in between', () => {
    expect(gradedDelayPsKm(f)).toBeCloseTo(61.0, 0);
    const p = pulseView('multi', 1, 41, 240, 'graded');
    expect(p.spreadNs).toBeCloseTo(gradedDelayPsKm(f) / 1000, 12);
    expect(p.fanMaxNs / p.spreadNs).toBeGreaterThan(0.99);
    expect(rayDelayGradedNs(acc / 2, f) / rayDelayGradedNs(acc, f)).toBeCloseTo((Math.sin(acc * Math.PI / 360) / Math.sin(acc * Math.PI / 180)) ** 4, 9);
    expect(p.spreadNs).toBeLessThan(pulseView('multi', 1, 41, 240, 'step').spreadNs / 700);
    expect(pulseView('multi', 2, 41, 240, 'graded').spreadNs / p.spreadNs).toBeCloseTo(2, 9);
  });
  it('about V²/4 modes, half the step count; the packets stay together (lag factor within 0.1 % of 1)', () => {
    expect(facts('multi', 0, 'graded').modes).toBeCloseTo(facts('multi', 0, 'step').modes / 2, 9);
    expect(facts('multi', 0, 'graded').profile).toBe('graded');
    expect(1 - lagFactorGraded(acc * 0.999, f)).toBeLessThan(1e-3);
    expect(lagFactorGraded(0, f)).toBe(1);
    expect(endTau('multi', 'graded')).toBeLessThan(1.05);
  });
  it('draws the rays as light in the ray plane, the cone only when asked, and the packets as one item', () => {
    const m = fibreModel({ kind: 'multi', deg: 6, tau: 0.5 }), names = m.items.map((i) => i.name);
    for (const n of ['core', 'cladding', 'coating', 'this ray', 'guided rays', 'acceptance cone', 'pulse']) expect(names, n).toContain(n);
    for (const i of m.items.filter((x) => x.group === 'light')) { expect(i.mat.beam).toBe(true); expect(i.cut).toBe('none'); }
    const ray = m.items.find((i) => i.name === 'this ray')!;
    expect(Math.max(Math.abs(ray.geo.min[2]), Math.abs(ray.geo.max[2]))).toBeLessThan(0.21);
    expect(fibreModel({ kind: 'multi', deg: 6, tau: 0.5, cone: false }).items.map((i) => i.name)).not.toContain('acceptance cone');
    expect(fibreModel({ kind: 'multi', deg: 20, tau: -1, profile: 'step' }).items.map((i) => i.name)).toContain('this ray, leaking');
    expect(fibreModel({ kind: 'single', deg: 4, tau: -1 }).items.filter((i) => i.name === 'mode field')).toHaveLength(3);
  });
  it('the layers are in true ratio: core, cladding and coating radii', () => {
    const m = fibreModel({ kind: 'multi', deg: 4, tau: -1 }), rOf = (n: string) => m.items.find((i) => i.name === n)!.geo.max[1];
    expect(rOf('core')).toBeCloseTo(coreR(MMF_50), 3);
    expect(rOf('cladding')).toBeCloseTo(R_CLAD, 3);
    expect(rOf('coating')).toBeCloseTo(R_COAT, 3);
    expect(R_COAT * UM * 2).toBe(250); expect(R_CLAD * UM * 2).toBe(125);
    const core = m.items.find((i) => i.name === 'core')!;
    expect(core.geo.min[0]).toBeLessThan(X0); expect(core.geo.max[0]).toBeGreaterThan(X1);
    expect(MATS.core.transmit).toBeGreaterThan(0);
  });
  it('every beat names groups the model has', () => {
    const m = fibreModel({ kind: 'multi', deg: 6, tau: 0.5 }), g = new Set(m.items.flatMap((i) => [i.group, i.name]));
    for (const b of m.beats ?? []) for (const x of [...(b.frame ?? []), ...(b.show ?? []), ...(b.hide ?? [])]) expect(g.has(x), x).toBe(true);
  });
});

describe('single-mode field and scale', () => {
  it('the Gaussian mode: 1/e² radius MFD/2 = 5.2 µm, about 31 % of the power outside the 4 µm core', () => {
    const k = facts('single', 0);
    expect(MFD_UM / 2).toBe(5.2);
    expect(k.outsideCore).toBeCloseTo(Math.exp((-2 * 16) / (5.2 * 5.2)), 12);
    expect(k.outsideCore).toBeGreaterThan(0.29); expect(k.outsideCore).toBeLessThan(0.33);
  });
  it('its core is 0.64 units across: under two phone pixels at the whole-fibre view, hence Look in', () => {
    expect(coreR(SMF_G652) * 2).toBeCloseTo(0.64, 12);
  });
  it('the scale label says what the stretch is', () => {
    const t = fibreAnchors({ kind: 'multi', deg: 4, tau: -1 }).map((a) => a.text).join('|');
    expect(t).toContain('1 mm');
  });
});
