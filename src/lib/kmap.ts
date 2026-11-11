// The Karnaugh map's geometry (DOM-free): rows and columns in Gray order, the table row each cell holds, and the rectangles that
// draw a product term's loop (two or four when a loop wraps over an edge). The sandbox's truth-table chips (editor/tableui.ts)
// and the logic chapter's map (widgets/kmap.ts) both draw from it, so a loop is the same loop in both.

import { covers, type Term } from './sop';

/** Gray-code order of 0, 1 or 2 bits: the K-map's rows and columns. */
export const GRAY: Record<number, number[]> = { 0: [0], 1: [0, 1], 2: [0, 1, 3, 2] };

export interface KLayout {
  /** Inputs; the first n >> 1 run down the side, the rest across. */
  n: number;
  rb: number;
  cb: number;
  rowsG: number[];
  colsG: number[];
  /** The table row (first input most significant) at grid row ri, column ci. */
  rowOf(ri: number, ci: number): number;
}

export function kLayout(n: number): KLayout {
  const rb = n >> 1, cb = n - rb;
  const rowsG = GRAY[rb], colsG = GRAY[cb];
  return { n, rb, cb, rowsG, colsG, rowOf: (ri, ci) => (rowsG[ri] << cb) | colsG[ci] };
}

/** A label of a row or column: its Gray code, w bits wide ('' for none). */
export const grayLabel = (v: number, w: number): string => (w ? v.toString(2).padStart(w, '0') : '');

/** Maximal runs [first, last] of the indices below `count` for which `inTerm` holds. */
export function runs(count: number, inTerm: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) if (inTerm(i) && (i === 0 || !inTerm(i - 1))) {
    let e = i;
    while (e + 1 < count && inTerm(e + 1)) e++;
    out.push([i, e]);
  }
  return out;
}

/** A loop's rectangle in grid cells, inclusive. */
export interface LoopRect { r0: number; r1: number; c0: number; c1: number }

/**
 * A term's loop as rectangles: its cells form runs along each axis (two when it wraps over an edge), one rectangle per pair of
 * runs. (A term covers a whole rectangle of cells, never a scatter: the cells it fixes are a subcube of the Gray grid.)
 */
export function loopRects(lay: KLayout, p: Term): LoopRect[] {
  const { rowsG, colsG, rowOf } = lay;
  const rr = runs(rowsG.length, (ri) => colsG.some((_, ci) => covers(p, rowOf(ri, ci))));
  const cr = runs(colsG.length, (ci) => rowsG.some((_, ri) => covers(p, rowOf(ri, ci))));
  const out: LoopRect[] = [];
  for (const [r0, r1] of rr) for (const [c0, c1] of cr) out.push({ r0, r1, c0, c1 });
  return out;
}

/** Does the loop run off an edge (more than one rectangle)? */
export const wraps = (lay: KLayout, p: Term): boolean => loopRects(lay, p).length > 1;
