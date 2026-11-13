// The image sensor die: its array is the chapter's IMX183 to scale, and what it captures follows the chapter's shutter
// timing: a rolling shutter skews a moving bar by exactly rollingSkew, a global one does not, and the ADC counts the level.
import { describe, expect, it } from 'vitest';
import { IMX183, rollingSkew, rowTime } from '../src/phys/imagesensor';
import {
  AW, AH, CELL, COLS, FRAME, OB_W, RAMP_SHARE, ROWS, T_ROW, pointers, rowZ, captureEnd, captureFrame, cellLight, cellRow, cellValue, covered, defaultScene,
  dieState, readTime, type Scene, type Shutter,
} from '../src/widgets/sensordie3dgeom';
import { DIE, dieInstances, dieModel } from '../src/widgets/sensordie3dkit';

const TOK: Record<string, [number, number, number]> = { '--sd-dark': [0, 0, 0], '--sd-lit': [1, 1, 1], '--sd-idle': [0.2, 0.2, 0.3], '--sd-expose': [0.6, 0.5, 0.9], '--m3-charge': [0.2, 0.8, 0.5], '--m3-si': [0.4, 0.45, 0.6], '--m3-metal': [0.6, 0.6, 0.7] };
const rgb = (t: string): [number, number, number] => TOK[t] ?? [0.5, 0.5, 0.5];

describe('the slow-motion tick reads cached samples', () => {
  it('cellLight equals cellValue exactly, cell by cell, at every stage of a capture, and after switching scenes', () => {
    const cases: [Scene, Shutter, number][] = [
      [defaultScene('prop'), 'rolling', 5e-3], [defaultScene('bar'), 'global', 0.25e-3], [{ ...defaultScene('prop'), rps: 12 }, 'global', 20e-3],
      [defaultScene('prop'), 'rolling', 5e-3], // back to the first: the cache is rebuilt, not stale
    ];
    for (const [s, sh, texp] of cases) {
      const end = captureEnd(sh, texp) + CELL * T_ROW;
      for (const f of [0, 0.013, 0.2, 0.5, 0.77, 1, Infinity]) {
        const now = f * end;
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) expect(cellLight(s, c, r, sh, texp, now)).toBe(cellValue(s, c, r, sh, texp, now));
      }
    }
  });
});

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
    expect(rDiff).toBeGreaterThan(COLS * ROWS * 0.05); // the propeller turns 49° while the frame is read: bent blades
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
    const scene = defaultScene('bar'), texp = 20e-6, r0 = readTime(10, 'global', texp);
    const counters = (ramp: number) => dieInstances({ scene, shutter: 'global', texp, now: r0 + ramp * CELL * T_ROW }).counters.filter((p) => p.scale![1] > 0.05);
    const early = counters(0.2), late = counters(0.95);
    // Bright columns count on; the bar's dark columns stop at once: late, most counters are taller than early.
    expect(late.length).toBeGreaterThanOrEqual(COLS - 8);
    expect(Math.max(...late.map((p) => p.scale![1]))).toBeGreaterThan(Math.max(...early.map((p) => p.scale![1])) * 3);
  });

  it('the default propeller turns slowly enough not to alias: 3 rev/s, as the 2D widget, about a seventh of a turn a frame', () => {
    const s = defaultScene('prop');
    expect(s.rps).toBe(3);
    expect(s.rps * FRAME).toBeLessThan(1 / s.blades); // a blade moves less than the gap to the next one
    expect(s.rps * IMX183.rows * T_ROW * 360).toBeGreaterThan(30); // and still bends visibly
  });

  it('the reset and read pointers run one exposure apart; global resets every row at once', () => {
    const texp = 5e-3, gap = texp / T_ROW;
    expect(gap).toBeGreaterThan(4 * CELL); // the band is several drawn rows deep at the default exposure
    for (const t of [0.006, 0.02, 0.04]) {
      const p = pointers('rolling', texp, t);
      expect(p.reset! - p.read!).toBeCloseTo(gap, 9);
      expect(pointers('global', texp, t).reset).toBeNull();
    }
    expect(pointers('rolling', texp, 0.001).read).toBeNull(); // nothing to read before the first exposure ends
    const m = dieModel({ scene: defaultScene('prop'), shutter: 'rolling', texp, now: 0.02 }, rgb);
    const bars = m.items.filter((i) => i.name === 'reset pointer');
    expect(bars).toHaveLength(1);
    expect(bars[0].geo.max[0] - bars[0].geo.min[0]).toBeGreaterThan(AW);
    expect(bars[0].at![2]).toBeCloseTo(rowZ(0.02 / T_ROW), 9);
    expect(m.items.filter((i) => i.name === 'read pointer')[0].at![2]).toBeCloseTo(rowZ((0.02 - texp) / T_ROW), 9);
  });

  it('optical black: a pixel under metal on every row and a strip along the top, outside the active array', () => {
    const m = dieModel({ scene: defaultScene('prop'), shutter: 'rolling', texp: 5e-3, now: 0 }, rgb), ob = m.items.filter((i) => i.name === 'optical black');
    const cells = m.items.find((i) => i.name === 'pixel array')!.geo, per = cells.positions.length / (ROWS * COLS);
    expect(ob).toHaveLength(2);
    expect(ob[0].geo.positions.length / per).toBe(ROWS); // left: one a row
    expect(ob[0].geo.max[0]).toBeLessThan(-AW / 2);
    expect(ob[1].geo.max[2]).toBeLessThan(-AH / 2); // top: a strip
    expect(ob[1].geo.max[0] - ob[1].geo.min[0]).toBeGreaterThan(AW);
    expect(OB_W).toBeGreaterThan(0);
  });

  it('a drawn row: the ramp, then its counters shifted out to the output', () => {
    const texp = 20e-6, r0 = readTime(5, 'global', texp), at = (f: number) => dieState({ scene: defaultScene('bar'), shutter: 'global', texp, now: r0 + f * CELL * T_ROW });
    expect(at(0.5 * RAMP_SHARE).shift).toBeNull();
    expect(at(0.5 * RAMP_SHARE).ramp).toBeCloseTo(0.5, 9);
    expect(at(RAMP_SHARE + 0.5 * (1 - RAMP_SHARE)).shift).toBeCloseTo(0.5, 9);
    expect(at(RAMP_SHARE + 0.5 * (1 - RAMP_SHARE)).ramp).toBe(1);
  });

  it('the studio die: every cell painted with what it holds, the array to scale inside the die, a tour', () => {
    const scene = defaultScene('bar'), texp = 5e-3, end = captureEnd('rolling', texp) + CELL * T_ROW;
    const m = dieModel({ scene, shutter: 'rolling', texp, now: end }, rgb), cells = m.items.find((i) => i.name === 'pixel array')!.geo;
    expect(cells.max[0] - cells.min[0]).toBeCloseTo(AW, 0);
    expect(cells.max[2] - cells.min[2]).toBeCloseTo(AH, 0);
    expect(DIE.x0).toBeLessThan(cells.min[0]); expect(DIE.x1).toBeGreaterThan(cells.max[0]);
    const per = cells.positions.length / (ROWS * COLS), col = (k: number) => cells.colors![k * per]; // per: floats a cell
    for (const [r, c] of [[0, 0], [10, 30], [ROWS - 1, COLS - 1]]) expect(col(r * COLS + c)).toBeCloseTo(cellLight(scene, c, r, 'rolling', texp), 5); // dark 0 → lit 1
    // before anything starts every cell is idle
    const idle = dieModel({ scene, shutter: 'rolling', texp, now: -1 }, rgb).items.find((i) => i.name === 'pixel array')!.geo;
    expect(idle.colors![0]).toBeCloseTo(0.2, 6);
    expect((m.beats ?? []).length).toBeGreaterThanOrEqual(3);
    expect((m.anchors ?? []).length).toBeGreaterThanOrEqual(5);
    expect(dieInstances({ scene, shutter: 'rolling', texp, now: 0.01 }).image.length).toBeGreaterThan(0);
  });
});
