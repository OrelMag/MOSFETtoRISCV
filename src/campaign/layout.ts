// Where each level sits on the campaign map: one horizontal band per act; inside an act, a
// node's column is the longest chain of same-act requirements before it, and nodes in a column
// are ordered by the rows of what they require (fewer crossings). An act with more columns than
// the map's width holds wraps them onto further lines, like text, as evenly as it can. No DOM.

import { ACTS, NODES } from './nodes';
import type { CampaignNode } from './types';

export const NODE_W = 168, NODE_H = 46, COL_GAP = 32, ROW_GAP = 14, LINE_GAP = 26, BAND_HEAD = 34, BAND_GAP = 18, MARGIN = 16;

export interface Placed {
  node: CampaignNode;
  x: number;
  y: number;
  /** The act's line it sits on (0 unless the act wraps), and the top of that line's first row. */
  line: number;
  lineY: number;
}

export interface Band {
  act: number;
  y: number;
  h: number;
}

export interface MapLayout {
  nodes: Map<string, Placed>;
  bands: Band[];
  w: number;
  h: number;
  /** Columns on a line (the most any act uses). */
  cols: number;
}

/** The map is drawn at least this wide (an act's title on a one-column phone map). */
export const MAP_MIN_W = 340;

/** The map may shrink this much to fit one more column on a line (the page scales it down to its pane). */
export const MAP_MIN_SCALE = 0.9;

/** Columns a pane `width` px wide holds, each with the channel right of it, drawn at MAP_MIN_SCALE or larger; at least one. */
export function mapColsFor(width: number): number {
  return Math.max(1, Math.floor((width / MAP_MIN_SCALE - MARGIN) / (NODE_W + COL_GAP)));
}

const cached = new Map<number, MapLayout>();

/** The map with at most `maxCols` columns on a line (Infinity: every act on one line). */
export function mapLayout(maxCols = Infinity): MapLayout {
  const hit = cached.get(maxCols);
  if (hit) return hit;
  const byId = new Map(NODES.map((n) => [n.id, n]));
  const col = new Map<string, number>();
  const colOf = (n: CampaignNode): number => {
    const c = col.get(n.id);
    if (c !== undefined) return c;
    col.set(n.id, 0); // (cycles are caught by graph.topo's test)
    let v = 0;
    for (const r of n.requires) {
      const m = byId.get(r);
      if (m && m.act === n.act) v = Math.max(v, colOf(m) + 1);
    }
    col.set(n.id, v);
    return v;
  };
  const placed = new Map<string, Placed>();
  const bands: Band[] = [];
  let y = MARGIN, used = 0;
  for (const act of ACTS) {
    const ns = NODES.filter((n) => n.act === act.num);
    if (!ns.length) continue;
    const cols: CampaignNode[][] = [];
    for (const n of ns) (cols[colOf(n)] ??= []).push(n);
    // Order each column by the mean row of its requirements already placed (barycentre).
    const rowOf = new Map<string, number>();
    cols.forEach((c) => {
      const key = (n: CampaignNode) => {
        const rs = n.requires.map((r) => rowOf.get(r) ?? (placed.get(r) ? -1 : undefined)).filter((v): v is number => v !== undefined);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
      };
      c.sort((a, b) => key(a) - key(b) || Number(!!a.optional) - Number(!!b.optional));
      c.forEach((n, i) => rowOf.set(n.id, i));
    });
    // Balanced wrapping: 5 columns in lines of 4 would leave one alone, so 3 + 2 (and 7 in threes: 3 + 2 + 2).
    const lines = Math.max(1, Math.ceil(cols.length / Math.max(1, maxCols)));
    const small = Math.floor(cols.length / lines), big = cols.length % lines;
    used = Math.max(used, small + (big ? 1 : 0));
    let top = y + BAND_HEAD, first = 0;
    for (let l = 0; l < lines; l++) {
      const lc = cols.slice(first, first += small + (l < big ? 1 : 0));
      const rows = Math.max(...lc.map((c) => c.length));
      lc.forEach((c, ci) => c.forEach((n, ri) => {
        placed.set(n.id, { node: n, x: MARGIN + ci * (NODE_W + COL_GAP), y: top + ri * (NODE_H + ROW_GAP), line: l, lineY: top });
      }));
      top += rows * (NODE_H + ROW_GAP) - ROW_GAP + (l < lines - 1 ? LINE_GAP : 0);
    }
    const h = top - y + 12;
    bands.push({ act: act.num, y, h });
    y += h + BAND_GAP;
  }
  // The last column keeps its channel on the right (an edge wrapping onto the next line runs down it).
  const layout = { nodes: placed, bands, w: Math.max(MAP_MIN_W, MARGIN + used * (NODE_W + COL_GAP)), h: y - BAND_GAP + MARGIN, cols: used };
  cached.set(maxCols, layout);
  return layout;
}
