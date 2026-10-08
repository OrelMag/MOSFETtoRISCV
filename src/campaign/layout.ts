// Where each level sits on the campaign map: one horizontal band per act; inside an act, a
// node's column is the longest chain of same-act requirements before it, and nodes in a column
// are ordered by the rows of what they require (fewer crossings). No DOM.

import { ACTS, NODES } from './nodes';
import type { CampaignNode } from './types';

export const NODE_W = 168, NODE_H = 46, COL_GAP = 40, ROW_GAP = 14, BAND_HEAD = 34, BAND_GAP = 18, MARGIN = 16;

export interface Placed {
  node: CampaignNode;
  x: number;
  y: number;
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
}

let cached: MapLayout | null = null;

export function mapLayout(): MapLayout {
  if (cached) return cached;
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
  let y = MARGIN, w = 0;
  for (const act of ACTS) {
    const ns = NODES.filter((n) => n.act === act.num);
    if (!ns.length) continue;
    const cols: CampaignNode[][] = [];
    for (const n of ns) (cols[colOf(n)] ??= []).push(n);
    // Order each column by the mean row of its requirements already placed (barycentre).
    const rowOf = new Map<string, number>();
    let rows = 0;
    cols.forEach((c) => {
      const key = (n: CampaignNode) => {
        const rs = n.requires.map((r) => rowOf.get(r) ?? (placed.get(r) ? -1 : undefined)).filter((v): v is number => v !== undefined);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
      };
      c.sort((a, b) => key(a) - key(b) || Number(!!a.optional) - Number(!!b.optional));
      c.forEach((n, i) => rowOf.set(n.id, i));
      rows = Math.max(rows, c.length);
    });
    const top = y + BAND_HEAD;
    cols.forEach((c, ci) => c.forEach((n, ri) => {
      const x = MARGIN + ci * (NODE_W + COL_GAP);
      placed.set(n.id, { node: n, x, y: top + ri * (NODE_H + ROW_GAP) });
      w = Math.max(w, x + NODE_W + MARGIN);
    }));
    const h = BAND_HEAD + rows * (NODE_H + ROW_GAP) - ROW_GAP + 12;
    bands.push({ act: act.num, y, h });
    y += h + BAND_GAP;
  }
  cached = { nodes: placed, bands, w, h: y - BAND_GAP + MARGIN };
  return cached;
}
