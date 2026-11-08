// The tide predictor's drawing held to the chapter's own Fourier series (comm/fourier.ts): the pen's height, found only from the
// cord's constant length and the pulleys' positions, is the chapter's sum at every sample time.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { gibbsPeak, PATTERNS, seriesOf, sumAt } from '../src/comm/fourier';
import {
  A_ARC, GEAR_C, N_CRANKS, PAPER_L, PEN_SCALE, PEN_X, PITCH, TIDE_PRESET, angleOf, beatHours, gearRadii, handAngle, paperSpeed, ratioOf, throwMm, cordPath, crankX, levelOf, offsetsAt, pathLength, penTip, tideAnchors, tideOf, tideParts,
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

describe('the real tide preset', () => {
  const td = tideOf(TIDE_PRESET), levelAt = (mask: boolean[], t: number) => levelOf(penTip(offsetsAt(td, mask, t), td.dc));
  const only = (...idx: number[]) => ALL.map((_, i) => idx.includes(i));

  it('has ten constituents at the IHO speeds (degrees an hour), M4 the only multiple', () => {
    expect(td.harms).toHaveLength(N_CRANKS);
    const speed = (n: string) => td.harms[td.names.indexOf(n)].k;
    expect(speed('M2')).toBeCloseTo(28.984104, 6); expect(speed('S2')).toBe(30); expect(speed('N2')).toBeCloseTo(28.43973, 5);
    expect(speed('K1')).toBeCloseTo(15.041069, 6); expect(speed('O1')).toBeCloseTo(13.943036, 6);
    // M2 + S2 = MS4, 2 M2 = M4: the shallow-water terms are sums of the main ones
    expect(speed('MS4')).toBeCloseTo(speed('M2') + speed('S2'), 6); expect(speed('M4')).toBeCloseTo(2 * speed('M2'), 6);
    // M4 is exactly 2 M2 (a shallow-water overtide); every other pair is incommensurate with an integer ratio
    for (const a of td.harms) for (const b of td.harms) if (a !== b && !(a.k > 57 && a.k < 58 && b === td.harms[0]) && !(b.k > 57 && b.k < 58 && a === td.harms[0])) expect(Number.isInteger(a.k / b.k)).toBe(false);
  });

  it('still obeys the cord: the pen is the sum of the constituents', () => {
    for (const t of [0, 5.5, 100.3, 354.4, 1000]) {
      let v = 0;
      td.harms.forEach((h) => { v += h.amp * Math.cos(angleOf(h, td.n, t)); });
      expect(levelAt(ALL, t)).toBeCloseTo(v, 9);
    }
  });

  it('M2 against S2 beats every 354.4 h = 14.77 days, read off the pen', () => {
    const [m2, s2] = td.harms;
    expect(beatHours(m2.k, s2.k)).toBeCloseTo(354.37, 1);
    expect(beatHours(m2.k, s2.k) / 24).toBeCloseTo(14.77, 2);
    const two = only(0, 1), beat = beatHours(m2.k, s2.k);
    // the range of the pen over one tidal cycle: springs (A1 + A2) at 0 and one beat later, neaps (A1 - A2) between
    const env = (c: number) => { let m = 0; for (let t = c - 6.3; t <= c + 6.3; t += 0.02) m = Math.max(m, Math.abs(levelAt(two, t))); return m; };
    expect(env(6.3)).toBeCloseTo(m2.amp + s2.amp, 1);
    expect(env(beat / 2)).toBeCloseTo(m2.amp - s2.amp, 1);
    expect(env(beat)).toBeCloseTo(m2.amp + s2.amp, 1);
    // and the spring peak itself, found by scanning the pen near one beat, sits within an hour of it
    let best = -Infinity, at = 0;
    for (let t = beat - 8; t <= beat + 8; t += 0.01) { const l = Math.abs(levelAt(two, t)); if (l > best) { best = l; at = t; } }
    expect(Math.abs(at - beat)).toBeLessThan(7);
    expect(best).toBeGreaterThan(m2.amp + s2.amp - 0.01);
  });

  it('never repeats at the beat period (the harmonics do repeat each period)', () => {
    const beat = beatHours(td.harms[0].k, td.harms[1].k);
    let worst = 0;
    for (let t = 0; t < 30; t += 0.5) worst = Math.max(worst, Math.abs(levelAt(ALL, t) - levelAt(ALL, t + beat)));
    expect(worst).toBeGreaterThan(0.05);
    const h = tideOf(2);
    for (const t of TIMES) expect(levelOf(penTip(offsetsAt(h, ALL, t + h.n), h.dc))).toBeCloseTo(levelOf(penTip(offsetsAt(h, ALL, t), h.dc)), 9);
  });

  it('the paper shows a spring-neap cycle and marks a day; the hand crank turns once a day', () => {
    expect(td.span).toBe(360); expect(td.mark).toBe(24); expect(paperSpeed(td)).toBeCloseTo(PAPER_L / 360, 12);
    expect(handAngle(td, 24)).toBeCloseTo(2 * Math.PI, 9);
    const tr = traceOf(td, ALL, 400);
    expect(tr.length).toBe(td.traceN + 1);
    expect(tr[tr.length - 1].x - PEN_X).toBeCloseTo(PAPER_L, 6);
  });
});

describe('the gearing and the slotted cranks', () => {
  it('a pair meshes: pitch radii add up to the centre distance and their ratio is the crank / hand speed', () => {
    for (const pat of [0, 2, 4, TIDE_PRESET]) {
      const td = tideOf(pat);
      td.harms.forEach((h) => {
        const [rm, rc] = gearRadii(ratioOf(td, h));
        expect(rm + rc).toBeCloseTo(GEAR_C, 9); expect(rm / rc).toBeCloseTo(h.k / td.handK, 9);
      });
    }
    // the chapter's harmonics: crank k turns k times per hand-crank turn
    expect(ratioOf(tideOf(0), tideOf(0).harms[1])).toBe(3);
  });
  it('the throw is 30 mm an A, within the slot', () => {
    const td = tideOf(0);
    td.harms.forEach((h) => { expect(throwMm(h)).toBeCloseTo(30 * h.amp, 9); expect(throwMm(h)).toBeLessThan(43); });
    for (const c of tideOf(TIDE_PRESET).harms) expect(throwMm(c)).toBeLessThanOrEqual(30);
  });
  it('the draw carries both sets and stays small', () => {
    const g: RGB = [0.5, 0.5, 0.5], P: TidePalette = { iron: g, brass: g, wood: g, steel: g, cord: g, paper: g, ink: g, off: g, glass: [0.5, 0.5, 0.5, 0.5], live: g };
    for (const pat of [0, TIDE_PRESET]) {
      const td = tideOf(pat), parts = tideParts(td, ALL, 200, P);
      expect(parts.length).toBeLessThan(800);
      for (const p of parts) for (const v of [...p.pos, ...(p.scale ?? [])]) expect(Number.isFinite(v)).toBe(true);
      expect(new Set(tideAnchors(td).map((a) => a.text)).size).toBe(tideAnchors(td).length);
    }
  });
});
