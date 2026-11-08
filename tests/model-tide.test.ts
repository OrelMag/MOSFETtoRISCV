// The tide predictor's drawing held to the chapter's own Fourier series (comm/fourier.ts): the pen's height, found only from the
// cord's constant length and the pulleys' positions, is the chapter's sum at every sample time.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { gibbsPeak, PATTERNS, seriesOf, sumAt } from '../src/comm/fourier';
import {
  A_ARC, N_CRANKS, PEN_SCALE, PEN_X, PITCH, angleOf, cordPath, crankX, levelOf, offsetsAt, pathLength, penTip, tideAnchors, tideOf, tideParts,
  traceOf, type TidePalette,
} from '../src/widgets/tide3dparts';

const ALL = Array(N_CRANKS).fill(true) as boolean[];
const prefix = (c: number) => ALL.map((_, i) => i < c);
const TIMES = [0, 0.13, 0.5, 0.77, 1, 1.9, 3.14, 5.5, 8.25, 21.7];

describe('the pen against the chapter\'s sum of harmonics', () => {
  it('has the chapter\'s harmonics on its cranks, in order', () => {
    PATTERNS.forEach((p, pat) => {
      const td = tideOf(pat), s = seriesOf(p.bits, 200);
      expect(td.harms).toEqual(s.harmonics.slice(0, N_CRANKS));
      expect(td.dc).toBe(s.dc);
      expect(td.harms).toHaveLength(N_CRANKS);
    });
  });

  it('the tip, from the cord\'s length alone, is PEN_SCALE times sumAt for the first c harmonics, every pattern', () => {
    PATTERNS.forEach((p, pat) => {
      const td = tideOf(pat), s = seriesOf(p.bits, 200);
      for (let c = 0; c <= N_CRANKS; c++) for (const t of TIMES) {
        const tip = penTip(offsetsAt(td, prefix(c), t), td.dc);
        expect(levelOf(tip)).toBeCloseTo(sumAt(s, td.n, t, c), 9);
      }
    });
  });

  it('any subset of cranks sums just its harmonics', () => {
    const td = tideOf(4), mask = ALL.map((_, i) => i % 3 !== 1);
    for (const t of TIMES) {
      let v = td.dc;
      td.harms.forEach((h, i) => { if (mask[i]) v += h.amp * Math.cos(angleOf(h, td.n, t)); });
      expect(levelOf(penTip(offsetsAt(td, mask, t), td.dc))).toBeCloseTo(v, 9);
    }
  });

  it('each movable pulley doubles its slide: moving one by d moves the tip by 2d', () => {
    const z = Array(N_CRANKS).fill(0);
    for (let i = 0; i < N_CRANKS; i++) {
      const d = z.slice(); d[i] = 1.3;
      expect(penTip(d, 0) - penTip(z, 0)).toBeCloseTo(2.6, 12);
    }
  });

  it('the drawn cord keeps its length however the pulleys move, and ends on the pen', () => {
    const td = tideOf(0), len0 = pathLength(cordPath(offsetsAt(td, ALL, 0), td.dc)), tipFor = (t: number) => penTip(offsetsAt(td, ALL, t), td.dc);
    // The arcs are fixed, so the polyline's length differs from the cord's by the pen leg only: it moves with the tip.
    for (const t of TIMES) {
      const d = offsetsAt(td, ALL, t), p = cordPath(d, td.dc), end = p[p.length - 1];
      expect(end[0]).toBe(PEN_X);
      expect(end[1] - 3).toBeCloseTo(tipFor(t), 9);
      expect(pathLength(p)).toBeCloseTo(len0, 6);
    }
  });

  it('the cord\'s legs are vertical: movable and fixed pulleys line up', () => {
    const p = cordPath(Array(N_CRANKS).fill(0), 0), xs = new Set(p.map((q) => +q[0].toFixed(6)));
    for (let i = 0; i < N_CRANKS; i++) {
      expect(xs.has(+(crankX(i) - A_ARC).toFixed(6))).toBe(true);
      expect(xs.has(+(crankX(i) + A_ARC).toFixed(6))).toBe(true);
    }
    expect(crankX(1) - crankX(0)).toBe(PITCH);
  });

  it('the trace is the pen\'s earlier heights, older further along the paper, and starts at time 0', () => {
    const td = tideOf(2), t = 3.7, tr = traceOf(td, ALL, t), s = seriesOf(td.bits, 200), span = 2 * td.n;
    expect(tr[0].x).toBe(PEN_X);
    tr.forEach((q, j) => {
      const tj = t - (span * j) / 120;
      expect(levelOf(q.y)).toBeCloseTo(sumAt(s, td.n, tj, N_CRANKS), 9);
      if (j > 0) expect(q.x).toBeGreaterThan(tr[j - 1].x);
    });
    expect(traceOf(td, ALL, 0)).toHaveLength(1);
  });

  it('the first c harmonics of 1010 peak at the chapter\'s Gibbs value', () => {
    const td = tideOf(0);
    for (const c of [1, 2, 3, 5, 8]) {
      let m = -Infinity;
      for (let i = 0; i <= 20000; i++) m = Math.max(m, levelOf(penTip(offsetsAt(td, prefix(c), (i / 20000) * td.n), td.dc)));
      expect(m).toBeCloseTo(gibbsPeak(c), 5);
    }
  });

  it('an engaged crank\'s pin sits where its slider is; a switched-off one does not move its pulley', () => {
    const td = tideOf(0), off = prefix(3);
    const d = offsetsAt(td, off, 0.4);
    d.forEach((v, i) => { if (i >= 3) expect(v).toBe(0); });
    expect(PEN_SCALE / 2 * td.harms[0].amp).toBeCloseTo(d[0] / Math.cos(angleOf(td.harms[0], td.n, 0.4)), 9);
  });
});

describe('the drawing', () => {
  const g: RGB = [0.5, 0.5, 0.5], P: TidePalette = { iron: g, brass: g, wood: g, steel: g, cord: g, paper: g, ink: g, off: g, glass: [0.5, 0.5, 0.5, 0.5], live: g };
  it('draws a pulley and a crank per harmonic and labels without duplicates', () => {
    const td = tideOf(0), parts = tideParts(td, ALL, 1.2, P);
    expect(parts.length).toBeGreaterThan(300);
    for (const p of parts) for (const v of [...p.pos, ...(p.scale ?? [])]) expect(Number.isFinite(v)).toBe(true);
    const a = tideAnchors(td);
    expect(new Set(a.map((x) => x.text)).size).toBe(a.length);
  });
});
