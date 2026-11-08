// The image sensor die: its array is the chapter's IMX183 to scale, and what it captures follows the chapter's shutter
// timing: a rolling shutter skews a moving bar by exactly rollingSkew, a global one does not, and the ADC counts the level.
import { describe, expect, it } from 'vitest';
import { IMX183, rollingSkew, rowTime } from '../src/phys/imagesensor';
import {
  AW, AH, CELL, COLS, FRAME, ROWS, T_ROW, captureEnd, captureFrame, cellRow, covered, defaultScene, dieParts, dieState,
  readTime, type DiePalette,
} from '../src/widgets/sensordie3dparts';

/** The left edge of the dark bar in each captured cell row, in pixels (NaN: no dark cell). */
const edges = (f: number[][]) => f.map((row) => { const c = row.findIndex((v) => v < 0.5); return c < 0 ? NaN : c * CELL; });

describe('the sensor die', () => {
  it('is the chapter’s IMX183, the array to scale', () => {
    expect(COLS * CELL).toBeGreaterThanOrEqual(IMX183.cols);
    expect((COLS - 1) * CELL).toBeLessThan(IMX183.cols);
    expect(ROWS * CELL).toBeGreaterThanOrEqual(IMX183.rows);
    expect(AW).toBeCloseTo(133.056, 3); // 5544 × 2.4 µm = 13.31 mm, 10 units a mm
    expect(AH).toBeCloseTo(88.656, 3);
    expect(T_ROW).toBe(rowTime());
    expect(T_ROW * 1e6).toBeCloseTo(12.3, 1);
    expect(FRAME).toBeCloseTo(1 / 21.98, 9);
  });

  it('a rolling shutter skews a moving bar by rollingSkew; a global one keeps it upright', () => {
    const s = defaultScene('bar'), texp = 20e-6;
    const roll = edges(captureFrame(s, 'rolling', texp)), glob = edges(captureFrame(s, 'global', texp));
    // From the first cell row to the last the bar moved v × (rows between them) × row time.
    const dRows = cellRow(ROWS - 1) - cellRow(0), want = rollingSkew(s.v, dRows);
    expect(roll[ROWS - 1] - roll[0]).toBeGreaterThan(want - 2 * CELL);
    expect(roll[ROWS - 1] - roll[0]).toBeLessThan(want + 2 * CELL);
    expect(want).toBeGreaterThan(IMX183.cols / 3); // a bar crossing in 0.1 s leans by over a third of the frame
    for (const e of glob) expect(e).toBe(glob[0]);
  });

  it('the global capture is the image at one instant; the rolling one is each row’s own instant', () => {
    const s = defaultScene('prop'), texp = 20e-6;
    const g = captureFrame(s, 'global', texp), r = captureFrame(s, 'rolling', texp);
    let gDiff = 0, rDiff = 0, rSelf = 0;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const px = Math.min(IMX183.cols, (x + 0.5) * CELL), py = cellRow(y);
      gDiff += Number((g[y][x] < 0.5) !== covered(s, px, py, texp / 2));
      rDiff += Number((r[y][x] < 0.5) !== covered(s, px, py, texp / 2));
      rSelf += Number((r[y][x] < 0.5) !== covered(s, px, py, cellRow(y) * T_ROW + texp / 2));
    }
    expect(gDiff).toBeLessThanOrEqual(2); // a cell on a blade's edge may fall either way
    expect(rSelf).toBeLessThanOrEqual(2);
    expect(rDiff).toBeGreaterThan(COLS * ROWS * 0.05); // the propeller turns 1.1 times during a frame: bent blades
  });

  it('reads one drawn row at a time, every row once, in order', () => {
    for (const sh of ['rolling', 'global'] as const) {
      const texp = 1e-3, seen: number[] = [];
      for (let t = 0; t < captureEnd(sh, texp) + CELL * T_ROW; t += (CELL * T_ROW) / 4) {
        const { reading } = dieState({ scene: defaultScene('bar'), shutter: sh, texp, now: t });
        if (reading !== null && seen[seen.length - 1] !== reading) seen.push(reading);
      }
      expect(seen).toEqual(Array.from({ length: ROWS }, (_, i) => i));
      expect(readTime(0, sh, texp)).toBeCloseTo(sh === 'rolling' ? texp + cellRow(0) * T_ROW : texp + cellRow(0) * T_ROW, 12);
    }
  });

  it('a column’s counter stops where the ramp passes its pixel’s level', () => {
    const P: DiePalette = { die: [0, 0, 0.1], pad: [0, 0, 0.2], logic: [0, 0, 0.3], dark: [0, 0, 0], lit: [1, 1, 1], idle: [0, 0, 0.4], expose: [0, 0, 0.5], read: [0.9, 0.1, 0.1], img: [0, 0, 0.6, 0.5], metal: [0, 0, 0.7] };
    const scene = defaultScene('bar'), texp = 20e-6, r0 = readTime(10, 'global', texp);
    const counters = (ramp: number) => dieParts({ scene, shutter: 'global', texp, now: r0 + ramp * CELL * T_ROW }, P)
      .filter((p) => p.color === P.read && p.kind === 'box' && p.scale![1] > 0.05 && p.pos[1] > 1);
    const early = counters(0.2), late = counters(0.95);
    // Bright columns count on; the bar's dark columns stop at once: late, most counters are taller than early.
    expect(late.length).toBeGreaterThanOrEqual(COLS - 8);
    expect(Math.max(...late.map((p) => p.scale![1]))).toBeGreaterThan(Math.max(...early.map((p) => p.scale![1])) * 3);
  });
});
