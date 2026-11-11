// lib/kmap.ts is the geometry the sandbox's truth-table chips drew inline (editor/tableui.ts, before it moved): the same Gray orders and
// the same rectangles for every term of two, three and four inputs. The old algorithm is kept here as the reference.

import { describe, expect, it } from 'vitest';
import { GRAY, kLayout, loopRects } from '../src/lib/kmap';
import { covers, type Term } from '../src/lib/sop';

function oldRects(n: number, p: Term): { r0: number; r1: number; c0: number; c1: number }[] {
  const rb = n >> 1, cb = n - rb;
  const rowsG = GRAY[rb], colsG = GRAY[cb];
  const rowOf = (ri: number, ci: number) => (rowsG[ri] << cb) | colsG[ci];
  const runs = (count: number, inTerm: (i: number) => boolean) => {
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) if (inTerm(i) && (i === 0 || !inTerm(i - 1))) {
      let e = i;
      while (e + 1 < count && inTerm(e + 1)) e++;
      out.push([i, e]);
    }
    return out;
  };
  const rr = runs(rowsG.length, (ri) => colsG.some((_, ci) => covers(p, rowOf(ri, ci))));
  const cr = runs(colsG.length, (ci) => rowsG.some((_, ri) => covers(p, rowOf(ri, ci))));
  const out: { r0: number; r1: number; c0: number; c1: number }[] = [];
  for (const [r0, r1] of rr) for (const [c0, c1] of cr) out.push({ r0, r1, c0, c1 });
  return out;
}

describe('K-map geometry', () => {
  it('every term of 2, 3 and 4 inputs gets the rectangles the old inline code drew', () => {
    for (const n of [2, 3, 4]) {
      const lay = kLayout(n);
      for (let mask = 0; mask < 1 << n; mask++) for (let val = 0; val < 1 << n; val++) {
        if (val & mask) continue;
        const p: Term = { val, mask };
        expect(loopRects(lay, p), `n ${n} val ${val} mask ${mask}`).toEqual(oldRects(n, p));
      }
    }
  });
  it('a loop is a rectangle of the cells the term covers, and every cell is in one rectangle of a term covering it', () => {
    const lay = kLayout(4);
    for (let mask = 0; mask < 16; mask++) for (let val = 0; val < 16; val++) {
      if (val & mask) continue;
      const p: Term = { val, mask };
      const cells = new Set<number>();
      for (const r of loopRects(lay, p)) for (let ri = r.r0; ri <= r.r1; ri++) for (let ci = r.c0; ci <= r.c1; ci++) cells.add(lay.rowOf(ri, ci));
      const want = [...Array(16).keys()].filter((m) => covers(p, m));
      expect([...cells].sort((x, y) => x - y)).toEqual(want);
    }
  });
  it('rows and columns are in Gray order and neighbours differ in one bit, edges included', () => {
    const lay = kLayout(4);
    for (const g of [lay.rowsG, lay.colsG]) for (let i = 0; i < g.length; i++) {
      const d = g[i] ^ g[(i + 1) % g.length];
      expect(d && !(d & (d - 1))).toBeTruthy();
    }
  });
});
