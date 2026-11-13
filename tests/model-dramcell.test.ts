// The real 1T1C cell beside the DRAM array (phys/dramcell.ts, widgets/dram3dkit.ts realCellItems): its dimensions pinned to
// their sources, its capacitance to the quoted range, and the drawing to its dimensions at its stated scale.
import { describe, expect, it } from 'vitest';
import { BITLINE_FF, CAP, CELL_AREA_UM2, H, QUOTED_FF, capFF, featureNm, hexPitchNm, pillarFF } from '../src/phys/dramcell';
import { NM, REAL_AT, dramModel, realCellItems } from '../src/widgets/dram3dkit';
import { DramBench, RATIO } from '../src/widgets/dram3dbench';
import { CELL_C } from '../src/lib/dram';

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe('the real cell’s numbers', () => {
  it('a 6F² cell of 0.0023 µm² (Samsung 1y) has F ≈ 19.6 nm', () => {
    expect(CELL_AREA_UM2).toBe(0.0023);
    expect(featureNm()).toBeCloseTo(19.58, 2);
    expect(6 * featureNm() ** 2).toBeCloseTo(2300, 6);
  });
  it('the capacitor fits its hexagonal pitch and is about 30 times taller than wide', () => {
    expect(CAP.dNm).toBeLessThan(hexPitchNm());
    expect(hexPitchNm() - CAP.dNm).toBeGreaterThan(10);
    expect(CAP.hNm / CAP.dNm).toBeGreaterThan(25);
    expect(CAP.hNm).toBe(1000);
  });
  it('C = κε₀A / EOT on its wall is near the quoted 6–7 fF, and far below the chapter’s teaching 25 fF', () => {
    const ff = capFF();
    expect(ff).toBeGreaterThan(QUOTED_FF[0]);
    expect(ff).toBeLessThan(QUOTED_FF[1] * 1.3);
    expect(pillarFF(CAP.dNm, 2 * CAP.hNm, CAP.eotNm)).toBeCloseTo(2 * ff, 9);
    expect(CELL_C).toBe(25);
    expect(ff).toBeLessThan(CELL_C / 2);
  });
  it('the bit line to cell ratio is several, as the chapter’s model keeps it', () => {
    expect(BITLINE_FF / capFF()).toBeGreaterThan(RATIO - 1);
    expect(BITLINE_FF / capFF()).toBeLessThan(10);
  });
});

describe('the drawing', () => {
  const items = realCellItems(24), by = (n: string) => items.find((i) => i.name === n)!;
  it('stands on the floor, beside the array, every part in its group', () => {
    for (const it of items) expect(it.group).toBe('realcell');
    const si = by('silicon');
    expect(si.geo.min[1]).toBeCloseTo(-1.2, 4);
    const array = dramModel(new DramBench(RATIO).snap()).items.filter((i) => i.group !== 'realcell');
    const arrayMaxX = Math.max(...array.map((i) => i.geo.max[0]));
    expect(Math.min(...items.map((i) => i.geo.min[0]))).toBeGreaterThan(arrayMaxX);
  });
  it('the capacitor is drawn at its dimensions at 1 unit = 25 nm', () => {
    const c = by('storage capacitor').geo;
    expect(NM).toBe(25);
    expect(near((c.max[1] - c.min[1]) * NM, CAP.hNm, 1e-3)).toBe(true);
    expect(c.min[1]).toBeCloseTo(REAL_AT[1] + H.padTop / NM, 4);
    // two pillars side by side: each CAP.dNm across, 5F apart
    expect((c.max[0] - c.min[0]) * NM).toBeCloseTo(5 * featureNm() + CAP.dNm, 4);
  });
  it('the word lines are buried: under the silicon’s top, at their typical depth', () => {
    const w = by('buried word line').geo;
    expect(w.max[1]).toBeCloseTo(REAL_AT[1] + H.wlTop / NM, 4);
    expect(w.min[1]).toBeCloseTo(REAL_AT[1] + H.wlBot / NM, 4);
    expect(w.max[1]).toBeLessThan(REAL_AT[1]);
  });
  it('the last beat shows it, the others leave it hidden', () => {
    const m = dramModel(new DramBench(RATIO).snap()), last = m.beats![m.beats!.length - 1];
    expect(last.frame).toEqual(['realcell']);
    expect(last.hide).toEqual([]);
    expect(last.text).toContain(`${CELL_C} fF`);
    for (const b of m.beats!.slice(0, -1)) expect(b.hide).toBeUndefined();
  });
});
