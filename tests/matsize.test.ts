// Chapter 22's mat-size explorer: the model behind the panel.
import { describe, expect, it } from 'vitest';
import { MAT_MAX_LOG, MAT_MIN_LOG, MAT_REF, MB_BITS, matShape } from '../src/widgets/matsize';

describe('mat shapes of a megabyte', () => {
  it('the reference mat is 1× on every delay and 128 mats with a 7 / 8 / 5 address', () => {
    const s = matShape(Math.log2(MAT_REF), Math.log2(MAT_REF));
    expect(s).toMatchObject({ mats: 128, matBits: 7, rowBits: 8, colBits: 5, wordLine: 1, bitLine: 1, charge: 1 });
  });

  it('every shape that fits addresses all 2^20 bytes, and a larger mat is refused', () => {
    for (let r = MAT_MIN_LOG; r <= MAT_MAX_LOG; r++) for (let c = MAT_MIN_LOG; c <= MAT_MAX_LOG; c++) {
      const s = matShape(r, c);
      if (s.rows * s.cols > MB_BITS) { expect(s.mats).toBe(0); continue; }
      expect(s.mats * s.rows * s.cols).toBe(MB_BITS);
      expect(s.matBits + s.rowBits + s.colBits).toBe(20);
      expect(s.cellShare).toBeGreaterThan(0);
      expect(s.cellShare).toBeLessThan(1);
    }
  });

  it('a word line goes with the square of its columns, a bit line with its rows', () => {
    expect(matShape(8, 9).wordLine).toBe(4);
    expect(matShape(9, 8).wordLine).toBe(1);
    expect(matShape(9, 8).bitLine).toBe(2);
    // bigger mats keep more of the area for cells
    expect(matShape(6, 6).cellShare).toBeLessThan(matShape(8, 8).cellShare);
    expect(matShape(8, 8).cellShare).toBeLessThan(matShape(10, 10).cellShare);
  });
});
