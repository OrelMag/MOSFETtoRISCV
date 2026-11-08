// The CCD model, held to phys/imagesensor.ts: the clock is its clockHigh (a packet half a gate a step, a pixel in six),
// a lone packet keeps what ccdRetained says, charge is conserved through a whole readout, and the drawing follows.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { afterTransfers, CCD42_40, clockHigh } from '../src/phys/imagesensor';
import {
  ccdAnchors, ccdParts, CcdRun, CG_UV, COLS, CTE_DATASHEET, FULL_WELL, gateOf, GATE, highAt, phaseOf, PITCH, radiusOf, ROWS, scene, STEPS, transfer, type CcdPalette,
} from '../src/widgets/ccd3dparts';

const c = (v: number): RGB => [v, v, v], a = (v: number): RGBA => [v, v, v, 0.4];
const P: CcdPalette = { si: a(0.6), p: c(0.5), n: c(0.7), chan: a(0.7), poly: c(0.8), oxide: a(0.9), metal: c(0.6), well: a(0.3), charge: [0, 1, 0], hot: [1, 0.6, 0] };

function readAll(run: CcdRun): number {
  let n = 0;
  while (!run.done()) { run.step(); if (++n > 10_000) throw new Error('readout never ends'); }
  return n;
}

describe('the clocks', () => {
  it('the CCD42-40\'s pitch in three gates; six steps a pixel', () => {
    expect(PITCH).toBe(13.5);
    expect(GATE * 3).toBeCloseTo(PITCH, 12);
    expect(STEPS).toBe(6);
  });
  it('a packet always sits under the gates the clock holds high', () => {
    for (let s = 0; s < STEPS; s++) {
      expect(highAt(s)).toEqual(clockHigh(3, s));
      for (let k = 0; k < ROWS; k++) {
        const g = gateOf(k, s), under = Number.isInteger(g) ? [g] : [Math.ceil(g), Math.floor(g)];
        expect(under.map(phaseOf).sort()).toEqual([...highAt(s)].sort());
      }
    }
  });
  it('a step moves a packet half a gate toward the register end; six move it a pixel', () => {
    for (let s = 0; s < STEPS; s++) expect(gateOf(2, s + 1)).toBeCloseTo(gateOf(2, s) - 0.5, 12);
    expect(gateOf(2, STEPS)).toBe(gateOf(1, 0));
  });
});

describe('transfer', () => {
  it('conserves charge and leaves 1 − CTE behind', () => {
    const t = transfer([1000, 0, 0], 0.9);
    expect(t.q[0]).toBeCloseTo(900);
    expect(t.q[1]).toBeCloseTo(100);
    expect(t.q.reduce((s, x) => s + x, 0) + t.tail).toBeCloseTo(1000);
  });
  it('after n transfers a lone packet keeps CTE^n', () => {
    let q = [5000, 0, 0, 0, 0, 0];
    for (let n = 1; n <= 9; n++) { q = transfer(q, 0.97).q; expect(q[0]).toBeCloseTo(5000 * afterTransfers(n, 0.97), 6); }
  });
});

describe('a readout', () => {
  it('reads every pixel once, row 0 first and the output-end column first, and conserves charge', () => {
    const run = new CcdRun({ v: 1, h: 1 });
    run.expose(1);
    const before = run.total();
    expect(readAll(run)).toBe(ROWS * (STEPS + STEPS * COLS));
    expect(run.samples).toHaveLength(ROWS * COLS);
    run.samples.forEach((s, i) => {
      expect(s.row).toBe(Math.floor(i / COLS));
      expect(s.col).toBe(i % COLS);
      expect(s.e).toBe(Math.min(FULL_WELL, Math.round(scene(s.row, s.col) * FULL_WELL)));
      expect(s.uv).toBeCloseTo(s.e * CG_UV, 6);
    });
    expect(run.total()).toBeCloseTo(before, 6);
    expect(run.level).toBe(1); // the plot compares the samples with this exposure, not the slider's later value
  });
  it('a lone packet reaches the output with r + 1 parallel and c + 1 serial transfers (imagesensor.ts ccdRetained)', () => {
    const cte = { v: 0.9, h: 0.8 };
    for (const [r, col] of [[0, 0], [2, 1], [3, 2]]) {
      const run = new CcdRun(cte);
      run.expose(0);
      run.v[col][r] = 100_000;
      readAll(run);
      const got = run.samples.find((s) => s.row === r && s.col === col)!;
      expect(got.e).toBeCloseTo(100_000 * afterTransfers(r + 1, cte.v) * afterTransfers(col + 1, cte.h), 4);
    }
    expect(CTE_DATASHEET).toEqual({ v: CCD42_40.cteParallel, h: CCD42_40.cteSerial });
  });
  it('a poor CTE smears charge into the pixels read after the bright one, and still conserves it', () => {
    const run = new CcdRun({ v: 0.95, h: 0.95 });
    run.expose(1);
    const before = run.total();
    readAll(run);
    expect(run.total()).toBeCloseTo(before, 6);
    const bright = run.samples.find((s) => s.row === 2 && s.col === 1)!, after = run.samples.find((s) => s.row === 2 && s.col === 2)!;
    expect(bright.e).toBeLessThan(0.9 * FULL_WELL);
    expect(after.e).toBeGreaterThan(0.03 * FULL_WELL * 1.5);
  });
});

describe('the drawing', () => {
  it('a packet\'s volume follows its charge', () => {
    expect(radiusOf(FULL_WELL)).toBeCloseTo(3);
    expect(radiusOf(FULL_WELL / 8)).toBeCloseTo(1.5);
    expect(radiusOf(0)).toBe(0);
  });
  it('draws a cloud per non-empty bucket and moves them with the clock', () => {
    const run = new CcdRun({ v: 1, h: 1 });
    run.expose(1);
    const clouds = (parts: ReturnType<typeof ccdParts>) => parts.filter((p) => p.color === P.charge);
    expect(clouds(ccdParts({ run, t: 1, moving: 'idle' }, P)).length).toBe(3 * ROWS * COLS);
    const z0 = clouds(ccdParts({ run, t: 1, moving: 'idle' }, P))[0].pos[2];
    run.step();
    const mid = clouds(ccdParts({ run, t: 0, moving: 'vertical' }, P))[0].pos[2], z1 = clouds(ccdParts({ run, t: 1, moving: 'vertical' }, P))[0].pos[2];
    expect(mid).toBeCloseTo(z0, 6);
    expect(z1 - z0).toBeCloseTo(-GATE / 2, 6);
    expect(ccdAnchors().length).toBeGreaterThan(6);
  });
  it('lights the gates of the high phases only', () => {
    const run = new CcdRun();
    run.expose(1);
    run.step();
    const hot = ccdParts({ run, t: 1, moving: 'vertical' }, P).filter((p) => p.color === P.poly && p.emissive && p.scale![0] >= 2 * PITCH);
    expect(hot).toHaveLength(2 * ROWS); // φ1 and φ2 both high at step 1, one of each per pixel
  });
});
