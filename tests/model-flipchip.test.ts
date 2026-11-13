// The flip-chip package (widgets/flipchip3dkit.ts) held to its drawing (AMD VFVC1596 / VSVA1596) and to phys/flipchip.ts,
// and phys/flipchip.ts held to its formulas and to chapter wire's bond wire.
import { describe, expect, it } from 'vitest';
import { triangles } from '../src/gl/kit/geo';
import { groundBounce, VIL } from '../src/phys/line';
import { BOND, BUMP, STACK, bondNh, bumpNh, layerR, parallelNh, roundL, stackR, wireL } from '../src/phys/flipchip';
import { bondL } from '../src/widgets/package3dparts';
import { padSwing } from '../src/widgets/line';
import { A, A1, BALL_PITCH, BALLS, BODY, BUMPS, BUMP_TOP, CUT, DIE_TOP, DIE_X, DIE_Z, LID, LID_TOP, MATRIX, SUB_LAYERS, SUB_TOP, TIM_TOP, ballPos, ballPresent, bumpLine, fcModel } from '../src/widgets/flipchip3dkit';

describe('phys/flipchip: inductance', () => {
  it('the finite-conductor form tends to the long-wire form as l/r grows', () => {
    for (const r of [0.0125, 0.05]) {
      const l = r * 1e4;
      expect(roundL(l, r) / wireL(l, r)).toBeCloseTo(1, 3);
    }
  });
  it('the bond wire is the SOIC model’s own 3 nH', () => {
    expect(bondNh()).toBeCloseTo(bondL(BOND.l, BOND.r), 12);
    expect(bondNh()).toBeGreaterThan(2.9);
    expect(bondNh()).toBeLessThan(3.1);
  });
  it('a bump is tens of picohenries, hundreds of times less than the wire', () => {
    expect(bumpNh()).toBeGreaterThan(0.005);
    expect(bumpNh()).toBeLessThan(0.05);
    expect(bondNh() / bumpNh()).toBeGreaterThan(100);
  });
  it('eight outputs bounce past nothing on one bump that the wire lifts most of the way to VIL', () => {
    const i = padSwing(), wire = groundBounce(8, i, 1, bondNh()), bump = groundBounce(8, i, 1, bumpNh());
    expect(wire).toBeGreaterThan(0.5 * VIL);
    expect(bump).toBeLessThan(0.02 * VIL);
    expect(groundBounce(64, i, 1, bumpNh())).toBeLessThan(VIL);
    expect(parallelNh(bumpNh(), 4)).toBeCloseTo(bumpNh() / 4, 12);
  });
});

describe('phys/flipchip: the thermal stack', () => {
  it('R = t / (k·A) per layer, summed in series; the TIM dominates', () => {
    const a = DIE_X * DIE_Z, rs = STACK.map((l) => layerR(l, a));
    expect(stackR(STACK, a)).toBeCloseTo(rs.reduce((s, r) => s + r, 0), 12);
    expect(layerR({ name: 'x', tMm: 1, k: 1 }, 1)).toBeCloseTo(1000, 9);
    const tim = rs[STACK.findIndex((l) => l.name.startsWith('thermal'))];
    expect(Math.max(...rs)).toBe(tim);
  });
});

describe('the package to its drawing', () => {
  it('1 560 balls on a 40 × 40 matrix at 0.92 mm, inside the 37.5 mm body', () => {
    expect(BALLS).toBe(1560);
    expect(MATRIX).toBe(40);
    expect(BALL_PITCH).toBe(0.92);
    expect(ballPos(MATRIX - 1) - ballPos(0)).toBeCloseTo(39 * 0.92, 9);
    expect(ballPos(MATRIX - 1) + 0.32).toBeLessThan(BODY / 2);
    expect(ballPresent(0, 0)).toBe(false);
    expect(ballPresent(0, 1)).toBe(true);
  });
  it('heights: 0.50 standoff, 3.55 overall, the die 0.797 over the substrate, the lid 0.2 inside the body', () => {
    expect(A1).toBe(0.5);
    expect(LID_TOP).toBe(A);
    expect(A).toBe(3.55);
    expect(DIE_TOP - SUB_TOP).toBeCloseTo(0.797, 9);
    expect(BUMP_TOP - SUB_TOP).toBeCloseTo(BUMP.h, 9);
    expect(TIM_TOP).toBeGreaterThan(DIE_TOP);
    expect(BODY - LID).toBeCloseTo(0.4, 9);
    expect(SUB_LAYERS[0].y0).toBe(A1);
    expect(SUB_LAYERS[SUB_LAYERS.length - 1].y1).toBeCloseTo(SUB_TOP, 9);
    for (let k = 1; k < SUB_LAYERS.length; k++) expect(SUB_LAYERS[k].y0).toBeCloseTo(SUB_LAYERS[k - 1].y1, 12);
  });
  it('the cut runs through a ball column and a bump column; bumps sit inside the die at their pitch', () => {
    expect(CUT).toBeCloseTo(ballPos(MATRIX / 2), 12);
    for (const half of [DIE_X / 2, DIE_Z / 2]) {
      const line = bumpLine(half);
      expect(line.some((v) => Math.abs(v - CUT) < 1e-9)).toBe(true);
      for (let k = 1; k < line.length; k++) expect(line[k] - line[k - 1]).toBeCloseTo(BUMP.pitch, 9);
      expect(Math.min(...line) - BUMP.r).toBeGreaterThan(-half);
      expect(Math.max(...line) + BUMP.r).toBeLessThan(half);
    }
    expect(BUMPS).toBeGreaterThan(14000);
  });
});

describe('the model', () => {
  it('stays within its triangle budget; the flat drawing far below', () => {
    const tri = (d: 'full' | 'flat') => fcModel({ heat: true }, d).items.reduce((s, it) => s + triangles(it.geo), 0);
    expect(tri('full')).toBeLessThan(400_000);
    expect(tri('flat')).toBeLessThan(40_000);
  });
  it('every beat names a known group; the heat shows only when asked', () => {
    const m = fcModel(), groups = new Set(m.items.map((it) => it.group));
    expect(groups.has('heat')).toBe(false);
    expect(fcModel({ heat: true }).items.some((it) => it.group === 'heat')).toBe(true);
    groups.add('heat');
    for (const b of m.beats ?? []) for (const g of [...(b.frame ?? []), ...(b.show ?? []), ...(b.hide ?? [])]) expect(groups.has(g), `${b.title}: ${g}`).toBe(true);
    for (const a of m.anchors ?? []) if (a.on) expect(groups.has(a.on), a.text).toBe(true);
  });
});
