// Where each level sits on the campaign map: one horizontal band per act; inside an act, a
// node's column is the longest chain of same-act requirements before it, and nodes in a column
// are ordered by the rows of what they require (fewer crossings). An act with more columns than
// the map's width holds wraps them onto further lines, like text, as evenly as it can. An act with
// labelled rows (ACT_ROWS) does all that per row, the rows one under the other. No DOM.

import type { ProgressView } from './graph';
import { ACTS, NODES, nodeById } from './nodes';
import type { CampaignNode } from './types';

export const NODE_W = 168, NODE_H = 46, COL_GAP = 32, ROW_GAP = 14, LINE_GAP = 26, BAND_HEAD = 34, BAND_GAP = 18, MARGIN = 16;
/** A folded act's band: its title and a line saying what it holds. */
export const FOLDED_H = 54;
/** A labelled row's header line. */
export const ROW_HEAD = 22;

/**
 * Acts drawn as labelled rows, each laid out like an act of its own: the side quests by subject, the GPU by
 * what it adds. Every level of such an act is in exactly one row; no level requires one in a later row.
 */
export const ACT_ROWS: Readonly<Record<number, readonly { label: string; ids: readonly string[] }[]>> = {
  8: [
    { label: 'Multiply & divide', ids: ['o_lesson', 'o_mulseq', 'o_mularr', 'o_mcore', 'o_div', 'o_dcore'] },
    { label: 'Floating point', ids: ['n_float', 'o_fpunpack', 'o_fpround', 'o_fpsticky', 'o_fplzc', 'o_fpnorm', 'o_fpadd', 'o_fpmul', 'o_fpcmp', 'o_fpcvt'] },
  ],
  9: [
    { label: 'Lanes', ids: ['k_lesson', 'k_lanes', 'k_vrf', 'k_mask', 'k_simd', 'k_stack', 'k_simt', 'p_saxpy', 'p_reduce'] },
    { label: 'Warps', ids: ['k_coal', 'k_warps', 'p_hist'] },
    { label: 'Pixels', ids: ['k_edge', 'k_tile', 'k_raster', 'k_frame', 'p_spin'] },
  ],
};

export interface Placed {
  node: CampaignNode;
  x: number;
  y: number;
  /** The act's line it sits on (0 unless the act wraps; numbered on through an act's labelled rows), and the top of that line's first row. */
  line: number;
  lineY: number;
  /** The channel above its line that edges from the act's earlier lines run along. */
  chanY: number;
  /** Its labelled row in the act (ACT_ROWS), 0 in an act without rows. */
  row: number;
}

export interface Band {
  act: number;
  y: number;
  h: number;
  /** Drawn as a header only: none of its levels is placed. */
  folded?: boolean;
  /** Labelled rows (ACT_ROWS): each label's baseline. */
  rows?: { label: string; y: number }[];
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

/** Acts whose every level is optional (Act P, the side quests, the GPU, memory): the map can fold each to a header. */
export const OPTIONAL_ACTS: ReadonlySet<number> = new Set(ACTS.map((a) => a.num).filter((num) => {
  const ns = NODES.filter((n) => n.act === num);
  return ns.length > 0 && ns.every((n) => n.optional);
}));

/**
 * The optional acts the map shows folded: as the learner last left each (`open`), else folded until
 * one of its levels is opened. The selected level's act is always open. Act P sits between act 0 and
 * act 1: folded, the main path starts near the top of the map, on a phone too.
 */
export function foldedActs(view: ProgressView, open: (act: number) => boolean | undefined, selected?: string): Set<number> {
  const selAct = selected ? nodeById(selected)?.act : undefined;
  const touched = (act: number) => NODES.some((n) => n.act === act && view(n.id) !== undefined);
  return new Set([...OPTIONAL_ACTS].filter((act) => act !== selAct && !(open(act) ?? touched(act))));
}

const cached = new Map<string, MapLayout>();

/** The map with at most `maxCols` columns on a line (Infinity: every act on one line); the acts in `folded` as headers only. */
export function mapLayout(maxCols = Infinity, folded: ReadonlySet<number> = new Set()): MapLayout {
  const key = `${maxCols}|${[...folded].sort((a, b) => a - b).join(',')}`;
  const hit = cached.get(key);
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
    if (folded.has(act.num)) {
      bands.push({ act: act.num, y, h: FOLDED_H, folded: true });
      y += FOLDED_H + BAND_GAP;
      continue;
    }
    // An act with labelled rows lays each row out as an act of its own (columns from the row's chains), one under the other.
    const groups = ACT_ROWS[act.num]?.map((r) => ({ label: r.label as string | undefined, ns: ns.filter((n) => r.ids.includes(n.id)) }))
      ?? [{ label: undefined, ns }];
    const rowOfId = new Map(groups.flatMap((g, gi) => g.ns.map((n) => [n.id, gi] as const)));
    const rowLabels: { label: string; y: number }[] = [];
    let top = y + BAND_HEAD, line = 0;
    groups.forEach((g, gi) => {
      const cols: CampaignNode[][] = [];
      const colIn = (n: CampaignNode): number => (ACT_ROWS[act.num] ? rowCol(n) : colOf(n));
      const rc = new Map<string, number>();
      const rowCol = (n: CampaignNode): number => {
        const c = rc.get(n.id);
        if (c !== undefined) return c;
        rc.set(n.id, 0);
        let v = 0;
        for (const r of n.requires) if (rowOfId.get(r) === gi && byId.get(r)?.act === n.act) v = Math.max(v, rowCol(byId.get(r)!) + 1);
        rc.set(n.id, v);
        return v;
      };
      for (const n of g.ns) (cols[colIn(n)] ??= []).push(n);
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
      // The row's label, with the channel for edges from the rows above it between the two.
      let chan = top - LINE_GAP / 2;
      if (g.label) {
        if (gi > 0) {
          chan = top + LINE_GAP / 2;
          top += LINE_GAP;
        }
        rowLabels.push({ label: g.label, y: top + ROW_HEAD - 8 });
        top += ROW_HEAD;
      }
      // Balanced wrapping: 5 columns in lines of 4 would leave one alone, so 3 + 2 (and 7 in threes: 3 + 2 + 2).
      const lines = Math.max(1, Math.ceil(cols.length / Math.max(1, maxCols)));
      const small = Math.floor(cols.length / lines), big = cols.length % lines;
      used = Math.max(used, small + (big ? 1 : 0));
      let first = 0;
      for (let l = 0; l < lines; l++, line++) {
        const lc = cols.slice(first, first += small + (l < big ? 1 : 0));
        const rows = Math.max(...lc.map((c) => c.length));
        const chanY = l ? top - LINE_GAP / 2 : chan;
        lc.forEach((c, ci) => c.forEach((n, ri) => {
          placed.set(n.id, { node: n, x: MARGIN + ci * (NODE_W + COL_GAP), y: top + ri * (NODE_H + ROW_GAP), line, lineY: top, chanY, row: gi });
        }));
        top += rows * (NODE_H + ROW_GAP) - ROW_GAP + (l < lines - 1 ? LINE_GAP : 0);
      }
    });
    const h = top - y + 12;
    bands.push({ act: act.num, y, h, ...(rowLabels.length ? { rows: rowLabels } : {}) });
    y += h + BAND_GAP;
  }
  // The last column keeps its channel on the right (an edge wrapping onto the next line runs down it).
  const layout = { nodes: placed, bands, w: Math.max(MAP_MIN_W, MARGIN + used * (NODE_W + COL_GAP)), h: y - BAND_GAP + MARGIN, cols: used };
  cached.set(key, layout);
  return layout;
}
