// Where each level sits on the campaign map: one horizontal band per act; inside an act, a
// node's column is the longest chain of same-act requirements before it, and nodes in a column
// are ordered by the rows of what they require (fewer crossings). An act with more columns than
// the map's width holds wraps them onto further lines, like text, as evenly as it can. No DOM.

import type { ProgressView } from './graph';
import { ACTS, NODES, nodeById } from './nodes';
import type { CampaignNode } from './types';

export const NODE_W = 168, NODE_H = 46, COL_GAP = 32, ROW_GAP = 14, LINE_GAP = 26, BAND_HEAD = 34, BAND_GAP = 18, MARGIN = 16;
/** A folded act's band: its title and a line saying what it holds. */
export const FOLDED_H = 54;

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
  /** Drawn as a header only: none of its levels is placed. */
  folded?: boolean;
  /** The act's blurb as subtitle lines under its title (plain text). */
  sub?: string[];
  /** A finished act's end card at the band's foot (thread.ts ActEnd): its top and each half's lines. */
  foot?: { y: number; can: string[]; cannot: string[] };
}

/** Subtitle and footer text: line height, the most lines of each, and an estimate of a character's width (11–12 px text). */
export const SUB_LINE = 14, SUB_LINES = 2, FOOT_LINES = 3, CHAR_W = 6.2, FOOT_LABEL_W = 96;

/** `text` (markup stripped) in lines of at most `width` px; the last ends in … when it does not fit in `max`. */
export function wrapText(text: string, width: number, max: number): string[] {
  const words = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().split(' ');
  const per = Math.max(12, Math.floor(width / CHAR_W));
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > per) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  if (lines.length <= max) return lines;
  const out = lines.slice(0, max);
  out[max - 1] = `${out[max - 1].slice(0, per - 1).replace(/[\s,;:.]+\S*$/, '')}…`;
  return out;
}

/** What a band shows besides its levels: an act's blurb, and the end card of a finished act. */
export interface BandText {
  blurb: (act: number) => string | undefined;
  end: (act: number) => { can: string; cannot: string } | undefined;
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

/**
 * The map with at most `maxCols` columns on a line (Infinity: every act on one line); the acts in `folded` as headers only.
 * With `text`, an open band carries its act's blurb under the title and an act in `ended` its end card at its foot.
 */
export function mapLayout(maxCols = Infinity, folded: ReadonlySet<number> = new Set(), text?: BandText, ended: ReadonlySet<number> = new Set()): MapLayout {
  const key = `${maxCols}|${[...folded].sort((a, b) => a - b).join(',')}|${text ? 't' : ''}|${[...ended].sort((a, b) => a - b).join(',')}`;
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
  // The band texts wrap to the map's width, which the widest act sets: found first.
  let textW = 0;
  if (text) {
    for (const act of ACTS) {
      const ns = NODES.filter((n) => n.act === act.num);
      if (!ns.length || folded.has(act.num)) continue;
      const c = Math.max(...ns.map(colOf)) + 1, lines = Math.max(1, Math.ceil(c / Math.max(1, maxCols)));
      textW = Math.max(textW, Math.ceil(c / lines));
    }
    textW = Math.max(MAP_MIN_W, MARGIN + textW * (NODE_W + COL_GAP)) - 2 * MARGIN - 8;
  }
  for (const act of ACTS) {
    const ns = NODES.filter((n) => n.act === act.num);
    if (!ns.length) continue;
    if (folded.has(act.num)) {
      bands.push({ act: act.num, y, h: FOLDED_H, folded: true });
      y += FOLDED_H + BAND_GAP;
      continue;
    }
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
    const blurb = text?.blurb(act.num);
    const sub = blurb ? wrapText(blurb, textW, SUB_LINES) : undefined;
    let top = y + BAND_HEAD + (sub ? sub.length * SUB_LINE + 4 : 0), first = 0;
    for (let l = 0; l < lines; l++) {
      const lc = cols.slice(first, first += small + (l < big ? 1 : 0));
      const rows = Math.max(...lc.map((c) => c.length));
      lc.forEach((c, ci) => c.forEach((n, ri) => {
        placed.set(n.id, { node: n, x: MARGIN + ci * (NODE_W + COL_GAP), y: top + ri * (NODE_H + ROW_GAP), line: l, lineY: top });
      }));
      top += rows * (NODE_H + ROW_GAP) - ROW_GAP + (l < lines - 1 ? LINE_GAP : 0);
    }
    const end = ended.has(act.num) ? text?.end(act.num) : undefined;
    let foot: Band['foot'];
    if (end) {
      // label column ("Can now", "Still can't") then the text
      foot = { y: top + 36, can: wrapText(end.can, textW - FOOT_LABEL_W, FOOT_LINES), cannot: wrapText(end.cannot, textW - FOOT_LABEL_W, FOOT_LINES) };
      top = foot.y + (foot.can.length + foot.cannot.length - 1) * SUB_LINE + 6;
    }
    const h = top - y + 12;
    bands.push({ act: act.num, y, h, ...(sub ? { sub } : {}), ...(foot ? { foot } : {}) });
    y += h + BAND_GAP;
  }
  // The last column keeps its channel on the right (an edge wrapping onto the next line runs down it).
  const layout = { nodes: placed, bands, w: Math.max(MAP_MIN_W, MARGIN + used * (NODE_W + COL_GAP)), h: y - BAND_GAP + MARGIN, cols: used };
  cached.set(key, layout);
  return layout;
}
