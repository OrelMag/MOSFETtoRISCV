// A card reader feeding a computer, as parts (DOM-free, tested). The reader is the chapter's own: cards/reader.ts's leaf,
// stepped edge by edge through its behaviour (init, eval) exactly as a simulation steps it, so what the drawing shows is
// that leaf's state: the card at the station, the cards fed, the word or column on `data`.
//
// (Phase B: a second station that compares, cards that can lie the wrong way, sequence check; see the view.)
//
// Two machines on one bed, cards running along +x from hopper to stacker:
//  'word'   an IBM 711-style reader: the card crosswise, its 9 edge first, a brush over every column. Row 9 stands under the
//           brushes at the station, and a brush that finds a hole touches the contact roll below: row 9 of columns 1–32 is the
//           word (column 1 its most significant bit), which is the reader's word mode.
//  'column' an IBM 2501-style reader: the card lengthwise, column 1 first, a lamp above and twelve photocells below, one per
//           row; each take moves the card one column on: the reader's column mode (bit 0 row 12 … bit 11 row 9).

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { COLUMNS, SEQ_STEP, seqOf, type Deck } from '../cards/card';
import { ROW9 } from '../cards/hollerith';
import { cardReader, readerProgress, type CardReaderState, type ReaderMode } from '../cards/reader';
import type { ComponentDef } from '../sim/types';

// ---------------------------------------------------------------- the reader, stepped as a simulation steps it

/**
 * How a card lies in the hopper, as the machine sees it (a card is fed 9 edge first, face down, column 1 on the left:
 * `rows` false, `cols` false). `rows`: the 12 edge leads instead (a card turned over about its long side, or turned end
 * for end); `cols`: the columns run the other way (turned over about its short side, or end for end). Both: the card
 * turned end for end, still face down.
 */
export interface Orient { rows: boolean; cols: boolean }
export const ORIENTS: readonly Orient[] = [{ rows: false, cols: false }, { rows: true, cols: true }, { rows: true, cols: false }, { rows: false, cols: true }];
export const ORIENT_NAMES = [
  'the right way (9 edge first, face down)',
  'turned end for end (12 edge first, face down)',
  'turned over, 12 edge first (face up)',
  'turned over, 9 edge first (face up, back to front)',
] as const;
export const orientIndex = (o: Orient): number => ORIENTS.findIndex((x) => x.rows === o.rows && x.cols === o.cols);

const rev12 = (m: number): number => { let r = 0; for (let b = 0; b < 12; b++) if ((m >> b) & 1) r |= 1 << (11 - b); return r; };
/** The 80 column masks as the brushes or cells meet them: position p holds the card's column p (or 79 − p), its rows reversed or not. */
export function shownCols(cols: readonly number[], o: Orient): number[] {
  return Array.from({ length: COLUMNS }, (_, p) => { const m = (cols[o.cols ? COLUMNS - 1 - p : p] ?? 0) & 0xfff; return o.rows ? rev12(m) : m; });
}
/** The first station's faulty part (the "dirty" switch): row 9's cell in column mode, the brush over column 32 in row mode. */
export const DIRTY_COL = 31, DIRTY_BIT = ROW9;
const wordFrom = (cols: readonly number[], bits = 32): number => {
  let w = 0;
  for (let b = 0; b < bits; b++) w = w * 2 + ((cols[b] & ROW9) ? 1 : 0);
  return w >>> 0;
};

export interface RunOptions { orient?: Orient[]; dirty?: boolean }

/** The reader leaf driven by hand: one rising clk edge at a time, with `next` as the computer sets it. */
export class ReaderRun {
  readonly def: ComponentDef;
  readonly st: CardReaderState;
  /** The leaf's outputs: data, ready, empty. */
  out: number[];
  /** What the computer took, in order (words, or columns). */
  readonly taken: number[] = [];
  /** The last card to leave the station and the edge it left at (-1: none yet); the edge of the last take. */
  leftCard = -1;
  leftEdge = -1;
  takeEdge = -1;
  /** The edge a fed card reached the station at (-1: none yet). */
  arriveEdge = -1;
  /** How each card lies in the hopper (shared with the view, which turns them), and a dirty brush / cell at the first station. */
  readonly orient: Orient[];
  readonly dirty: boolean;
  /** The checks: the second station's reading against the first's, and the sequence number in columns 73–80 against the count. */
  cmpErrs = 0;
  seqErrs = 0;
  errors = 0;
  alarm: string | null = null;
  /** The sequence number the last whole card read as (null: not digits; undefined: no card yet). */
  lastSeq: number | null | undefined = undefined;
  private readonly seqBase: number;
  private readonly cache = new Map<string, number[]>();

  constructor(readonly deck: Deck, readonly mode: ReaderMode, readonly feed: number, opts: RunOptions = {}) {
    this.orient = opts.orient ?? [];
    while (this.orient.length < deck.cards.length) this.orient.push(ORIENTS[0]);
    this.dirty = !!opts.dirty;
    this.seqBase = seqOf(deck.cards[0]) ?? SEQ_STEP;
    this.def = cardReader({ mode, bits: 32, feed, items: deck.cards.flatMap((_, k) => this.itemsOf(k)), name: deck.name });
    const b = this.def.behavior!;
    this.st = b.init!('zero') as CardReaderState;
    this.out = b.eval([0, 0], this.st);
  }
  get per(): number { return this.st.per; }
  get cards(): number { return this.deck.cards.length; }
  get edges(): number { return this.st.e; }

  /** Card k's columns as laid in the machine; `first`: as the first station reads them (a dirty part misses its hole). */
  cols(k: number, first = false): readonly number[] {
    const key = `${k}${first ? 'f' : 'c'}`;
    let c = this.cache.get(key);
    if (!c) {
      c = shownCols(this.deck.cards[k].cols, this.orient[k]);
      if (first && this.dirty) c = this.mode === 'word' ? c.map((m, i) => (i === DIRTY_COL ? 0 : m)) : c.map((m) => m & ~DIRTY_BIT);
      this.cache.set(key, c);
    }
    return c;
  }
  /** What the first station gives the computer for card k: a word, or its 80 columns. */
  itemsOf(k: number): number[] {
    const c = this.cols(k, true);
    return this.mode === 'word' ? [wordFrom(c)] : c.map((m) => m & 0xfff);
  }
  /** Can card k still be turned? Only a card in the hopper (or the first, before anything has run). */
  canTurn(k: number): boolean {
    const at = readerProgress(this.st).at;
    return k >= 0 && k < this.cards && at !== null && (k > at || (k === 0 && this.st.e === 0 && this.taken.length === 0));
  }
  /** Lay card k as `o`: the leaf is handed the other card's items, as if the learner had put another card in the hopper. */
  turn(k: number, o: Orient): void {
    if (!this.canTurn(k)) return;
    this.orient[k] = o;
    this.cache.delete(`${k}f`); this.cache.delete(`${k}c`);
    this.st.q.splice(k * this.st.per, this.st.per, ...this.itemsOf(k));
    this.out = this.def.behavior!.eval([0, Math.max(0, this.st.c)], this.st);
  }

  /** One rising clk edge with `next` at that level; true when the computer took an item. */
  edge(next: 0 | 1): boolean {
    const b = this.def.behavior!, i = this.st.i, data = this.out[0], wait = this.st.wait;
    b.eval([next, 0], this.st);
    this.out = b.eval([next, 1], this.st);
    if (wait > 0 && this.st.wait === 0) this.arriveEdge = this.st.e;
    if (this.st.i === i) return false;
    this.taken.push(data);
    this.takeEdge = this.st.e;
    if (this.st.i % this.st.per === 0) { this.leftCard = this.st.i / this.st.per - 1; this.leftEdge = this.st.e; }
    this.check(i, data);
    return true;
  }

  /** The two checks, at the take of item j (the data the first station gave): the second station's reading, and a whole card's sequence. */
  private check(j: number, data: number): void {
    const per = this.st.per, k = Math.floor(j / per), idx = j % per, second = this.cols(k);
    const ref = this.mode === 'word' ? wordFrom(second) : second[idx] & 0xfff;
    if (data !== ref) {
      this.cmpErrs++; this.errors++;
      this.alarm = this.mode === 'word' ? `Compare check on card ${k + 1}: the two stations read different words.`
        : `Compare check on card ${k + 1}, column ${idx + 1}: the two stations read different holes.`;
    }
    if ((j + 1) % per === 0) {
      const read = this.mode === 'word' ? this.cols(k, true) : this.taken.slice(-COLUMNS);
      const seq = seqOf({ cols: [...read], print: '' }), want = this.seqBase + k * SEQ_STEP;
      this.lastSeq = seq;
      if (seq !== want) {
        this.seqErrs++; this.errors++;
        this.alarm = `Sequence check on card ${k + 1}: columns 73–80 read ${seq === null ? 'as no number' : String(seq)}, not ${want}.`;
      }
    }
  }
}

// ---------------------------------------------------------------- where everything is

/**
 * 1 unit = 2.5 mm. The card is 7⅜ × 3¼ inches, 0.007 inch thick, its columns 0.087 inch apart, its rows ¼ inch, holes 0.055 × 0.125
 * inch, the upper left corner cut about ¼ inch at 45° (IBM card handbook, ANSI X3.21 / ISO 1681, as the audit quotes them). The
 * numbers are the inches times 2.54 over 2.5; CARD_T is the card drawn 7 times too thick (CARD_T_REAL is the real one), so
 * that a stack of them can be seen at all.
 */
export const CARD_L = 74.93, CARD_S = 33.02, CARD_T = 0.5, CARD_T_REAL = 0.0712, COL_P = 0.884, ROW_P = 2.54, HOLE_C = 0.56, HOLE_R = 1.27, CORNER = 2.54;
export const ROWS = 12;
/** Along the long side from the card's centre: column c (0 = column 1). Along the short side: row r (0 = row 12 … 11 = row 9). */
export const colOff = (c: number): number => (c - (COLUMNS - 1) / 2) * COL_P;
export const rowOff = (r: number): number => (r - (ROWS - 1) / 2) * ROW_P;
/** The bed the cards slide on, and the first station's line across it; the second station sits SEPARATION further on (56 mm, illustrative: no source gives the spacing). */
export const BED = 10, STATION_X = 0, SEPARATION = 22;
export const STATION2_X = STATION_X + SEPARATION;
const R9 = ROWS - 1;

export interface Machine {
  /** Card centre x in the hopper, at the station (word: row 9 under the brushes; column: column `col` under the cells), in the stacker. */
  hopper: number; station: (col: number) => number; stacker: number;
  /** The card's extent along the path and across it. */
  along: number; across: number;
  /** A hole's position on a card at centre cx: x along the path, z across. */
  hole: (cx: number, col: number, row: number) => [number, number];
  /** Feed rolls (x), the computer's panel (z, behind the bed). */
  rolls: number[]; panelZ: number;
}

export const MACHINES: Record<ReaderMode, Machine> = {
  word: {
    hopper: -62, station: () => STATION_X - rowOff(R9), stacker: 52, along: CARD_S, across: CARD_L,
    hole: (cx, c, r) => [cx + rowOff(r), colOff(c)],
    rolls: [-36, 9], panelZ: -54,
  },
  column: {
    hopper: -118, station: (col) => STATION_X + colOff(col), stacker: 120, along: CARD_L, across: CARD_S,
    hole: (cx, c, r) => [cx - colOff(c), rowOff(r)],
    rolls: [-74, 76], panelZ: -40,
  },
};

/** Which corner of the card at centre (cx, 0) is cut, as signs along x and z: the upper left one as the card lies (12 edge, column 1). */
export function cornerSigns(mode: ReaderMode, o: Orient): [number, number] {
  return mode === 'word' ? [o.rows ? 1 : -1, o.cols ? 1 : -1] : [o.cols ? -1 : 1, o.rows ? 1 : -1];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * What a station at x = sx meets on a card whose centre is at cx: word mode, the row under the brushes (0 = row 12) and the
 * columns with a hole in it; column mode, the column under the cells and the rows with a hole. The card is read on the move:
 * whatever row or column is nearest the line is the one being read, so a card sliding past lights them in turn.
 */
export function scanAt(mode: ReaderMode, cols: readonly number[], cx: number, sx: number): { idx: number | null; lit: number[] } {
  const lit: number[] = [];
  if (mode === 'word') {
    const r = Math.round((sx - cx) / ROW_P + (ROWS - 1) / 2);
    if (r < 0 || r >= ROWS) return { idx: null, lit };
    for (let c = 0; c < COLUMNS; c++) if ((cols[c] >> r) & 1) lit.push(c);
    return { idx: r, lit };
  }
  const c = Math.round((cx - sx) / COL_P + (COLUMNS - 1) / 2);
  if (c < 0 || c >= COLUMNS) return { idx: null, lit };
  for (let r = 0; r < ROWS; r++) if ((cols[c] >> r) & 1) lit.push(r);
  return { idx: c, lit };
}

export interface ReaderLayout {
  mode: ReaderMode;
  /** Cards still in the hopper (not picked yet), cards in the stacker. */
  hopper: number; stacker: number;
  /** Cards on the bed with their holes drawn: index and centre x. */
  moving: { k: number; cx: number }[];
  /** The card standing at the station, read now (null: none, or still moving in). */
  station: number | null;
  /** Word: the columns (0-based) whose brush at the first station reaches the contact roll. Column: the rows (0 = row 12) whose cell sees the lamp. */
  lit: number[];
  /** The same at the second station, from the card as it is (the first may be dirty). */
  lit2: number[];
  /** Word: the row (0 = row 12 … 11 = row 9) under the first brushes; column: the column (0-based); null: no card there. */
  under: number | null;
  /** The picker knife's stroke, 0 home … 1 out. */
  knife: number;
}

/**
 * Where the cards are after the last edge, `u` of the way through its motion (1: settled, the leaf's state itself). A card
 * fed in moves over the `feed` edges that bring it; a card leaving moves out during the edge that took it.
 */
export function readerLayout(run: ReaderRun, u = 1): ReaderLayout {
  const m = MACHINES[run.mode], st = run.st, p = readerProgress(st), feed = Math.max(1, run.feed);
  const moving: { k: number; cx: number }[] = [];
  let station: number | null = null, knife = 0, inFlight = 0;
  if (p.at !== null) {
    if (p.feeding) {
      const prog = clamp01((run.feed - st.wait - 1 + u) / feed);
      moving.push({ k: p.at, cx: lerp(m.hopper, m.station(0), ease(prog)) });
      knife = prog < 0.4 ? prog / 0.4 : 1 - (prog - 0.4) / 0.6;
      if (prog <= 0) knife = 0;
    } else {
      // A column taken this edge: the card slides on by one.
      const col = p.column, back = run.takeEdge === st.e && col > 0 ? 1 - u : 0;
      if (run.arriveEdge === st.e && u < 1) moving.push({ k: p.at, cx: lerp(m.hopper, m.station(0), ease((run.feed - 1 + u) / feed)) });
      else { moving.push({ k: p.at, cx: m.station(col - back) }); if (u >= 1) station = p.at; }
    }
  }
  if (run.leftCard >= 0) {
    const out = run.leftEdge === st.e ? clamp01(u) : 1;
    if (out < 1) { moving.push({ k: run.leftCard, cx: lerp(m.station(run.mode === 'word' ? 0 : COLUMNS), m.stacker, ease(out)) }); inFlight = 1; }
  }
  // Both stations read whatever is under them, on the move.
  const lit = new Set<number>(), lit2 = new Set<number>();
  let under: number | null = null;
  for (const q of moving) {
    const a = scanAt(run.mode, run.cols(q.k, true), q.cx, STATION_X), b = scanAt(run.mode, run.cols(q.k), q.cx, STATION2_X);
    a.lit.forEach((x) => lit.add(x)); b.lit.forEach((x) => lit2.add(x));
    if (a.idx !== null && under === null) under = a.idx;
  }
  const sorted = (s: Set<number>) => [...s].sort((x, y) => x - y);
  return { mode: run.mode, hopper: run.cards - p.taken - (p.at === null ? 0 : 1), stacker: p.taken - inFlight, moving, station, lit: sorted(lit), lit2: sorted(lit2), under, knife };
}

/** The word on the brushes' cable: row 9 of columns 1–`bits`, column 1 the most significant bit. */
export function cableWord(lit: readonly number[], bits = 32): number {
  let w = 0;
  for (let c = 0; c < bits; c++) w = w * 2 + (lit.includes(c) ? 1 : 0);
  return bits >= 32 ? w >>> 0 : w;
}

// ---------------------------------------------------------------- the drawing

export interface ReaderPalette { frame: RGB; bed: RGB; card: RGB; hole: RGB; metal: RGB; brass: RGB; live: RGB; lampOff: RGB; panel: RGB; beam: RGBA; rubber: RGB; alarm?: RGB }

const glow = (c: RGB, k = 0.6): RGB => [c[0] * k, c[1] * k, c[2] * k];
const STACK_P = 0.7, STACK_MAX = 24;
/** The lamps on the computer's panel: x of data bit k (0 = the most significant), and of ready / empty / next / compare check / sequence check. */
export const lampX = (k: number, n: number): number => (k - (n - 1) / 2) * 2.6 + (n > 16 ? 0 : -6);
export const LAMP_Y = 40;

/**
 * A card slab with its corner cut: one box and `steps` strips stepping along the diagonal (the cut is a ¼ inch right triangle).
 * x0..x1 and z0..z1 are the card's extent, (sx, sz) the cut corner.
 */
function slab(out: Part[], color: RGB, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, sx: number, sz: number, steps: number): void {
  const k = CORNER, w = k / steps;
  // The main body, without the corner strip along x; then the strip, a step at a time.
  const bx0 = sx < 0 ? x0 + k : x0, bx1 = sx < 0 ? x1 : x1 - k;
  out.push(box(color, bx0, bx1, y0, y1, z0, z1));
  for (let j = 0; j < steps; j++) {
    // strip j counted from the strip's outer end (the card's edge): the cut is deepest there
    const xa = sx < 0 ? x0 + j * w : x1 - (j + 1) * w, xb = xa + w, cut = k - (j + 0.5) * w;
    out.push(box(color, xa, xb, y0, y1, sz < 0 ? z0 + cut : z0, sz < 0 ? z1 : z1 - cut));
  }
}

function cardParts(out: Part[], m: Machine, run: ReaderRun, k: number, cx: number, y: number, P: ReaderPalette): void {
  const a = m.along / 2, c = m.across / 2, [sx, sz] = cornerSigns(run.mode, run.orient[k]);
  slab(out, P.card, cx - a, cx + a, y, y + CARD_T, -c, c, sx, sz, 3);
  const cols = run.cols(k), wide = run.mode === 'word';
  for (let col = 0; col < COLUMNS; col++) for (let r = 0; r < ROWS; r++) {
    if (!((cols[col] >> r) & 1)) continue;
    const [x, z] = m.hole(cx, col, r), hx2 = (wide ? HOLE_R : HOLE_C) / 2, hz2 = (wide ? HOLE_C : HOLE_R) / 2;
    out.push(box(P.hole, x - hx2, x + hx2, y + CARD_T, y + CARD_T + 0.05, z - hz2, z + hz2));
  }
}

export function readerParts(run: ReaderRun, L: ReaderLayout, next: 0 | 1, P: ReaderPalette): Part[] {
  const m = MACHINES[run.mode], out: Part[] = [], a = m.along / 2, c = m.across / 2, x0 = m.hopper - a - 8, x1 = m.stacker + a + 8;
  // The bed, with the stations' slots, and the side plates.
  // The bed sits low, in short tiles, the card riding on two guide rails at its edges: the flat view sorts faces by their
  // middles, and one long slab under the cards would be drawn over them.
  const slot = 3.5, tiles = (xa: number, xb: number, f: (u: number, v: number) => void) => {
    const n = Math.max(1, Math.round((xb - xa) / 12));
    for (let i = 0; i < n; i++) f(xa + ((xb - xa) * i) / n, xa + ((xb - xa) * (i + 1)) / n);
  };
  for (const [xa, xb] of [[x0, STATION_X - slot], [STATION_X + slot, STATION2_X - slot], [STATION2_X + slot, x1]]) tiles(xa, xb, (u, v) => {
    out.push(box(P.bed, u, v, BED - 9, BED - 6, -c - 6, c + 6));
    for (const sz of [-1, 1]) out.push(box(P.frame, u, v, BED - 6, BED, Math.min(sz * (c - 1.2), sz * (c + 0.6)), Math.max(sz * (c - 1.2), sz * (c + 0.6))));
  });
  for (const sx of [STATION_X, STATION2_X]) out.push(box(P.bed, sx - slot, sx + slot, BED - 9, BED - 7, -c - 6, c + 6));
  for (const sz of [-1, 1]) tiles(x0, x1, (u, v) => out.push(box(P.frame, u, v, BED - 9, BED + 1.5, sz * (c + 4) - 1, sz * (c + 4) + 1)));
  // The hopper: corner posts, the cards face down (the bottom one on the bed, under the throat), a weight on top; the picker
  // knife at the bottom card's trailing edge. The throat: a plate across the front wall, a card and a bit above the bed
  // (the real slit is 0.011 inch over a card of 0.007; drawn wider because the cards are).
  const hop = Math.min(L.hopper, STACK_MAX), first = run.cards - L.hopper;
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) out.push(box(P.frame, m.hopper + sx * (a + 1.2) - 0.8, m.hopper + sx * (a + 1.2) + 0.8, BED, BED + 26, sz * (c + 1.2) - 0.8, sz * (c + 1.2) + 0.8));
  out.push(box(P.frame, m.hopper + a, m.hopper + a + 0.5, BED + CARD_T + 0.3, BED + 26, -c - 1, c + 1));
  for (let i = 0; i < hop; i++) {
    const k = first + i, [sx, sz] = cornerSigns(run.mode, run.orient[k]), y = BED + STACK_P * i;
    slab(out, P.card, m.hopper - a, m.hopper + a, y, y + CARD_T * 0.8, -c, c, sx, sz, 1);
  }
  const wy = BED + STACK_P * hop + 0.6;
  out.push(box(P.metal, m.hopper - 4, m.hopper + 4, wy, wy + 3, -c * 0.4, c * 0.4, 0.4));
  const kx = m.hopper - a - 1.4 + L.knife * 14;
  out.push(box(P.metal, kx - 1.2, kx, BED - 0.2, BED + 0.45, -c + 2, c - 2, 0.6), box(P.frame, kx - 6, kx - 1.2, BED - 1.8, BED - 0.2, -c + 6, c - 6));
  // Feed rolls in pairs across the path, rubber below, steel above.
  for (const x of m.rolls) {
    out.push(rod(P.metal, [x, BED + CARD_T + 2, -c - 3], [x, BED + CARD_T + 2, c + 3], 2, 0.5));
    out.push(rod(P.rubber, [x, BED - 1.6, -c - 3], [x, BED - 1.6, c + 3], 1.8));
  }
  // The read stations: the first one's brushes or cells are the ones that feed the computer; the second reads the same
  // holes again further on, and the two are compared.
  const lit = new Set(L.lit), lit2 = new Set(L.lit2);
  const covers = (sx: number) => L.moving.some((q) => Math.abs(sx - q.cx) <= a);
  if (run.mode === 'word') {
    // A contact roll in the slot below, a bar of brushes above, one brush a column; a brush through a hole touches the roll.
    for (const sx of [STATION_X, STATION2_X]) {
      out.push(rod(P.brass, [sx, BED - 2, -c - 3], [sx, BED - 2, c + 3], 2, 0.6));
      out.push(box(P.frame, sx - 2.5, sx + 2.5, BED + 7, BED + 10, -c - 4, c + 4), box(P.frame, sx - 1, sx + 1, BED, BED + 10, -c - 4 - 2, -c - 4), box(P.frame, sx - 1, sx + 1, BED, BED + 10, c + 4, c + 6));
    }
    const card = covers(STATION_X);
    for (let col = 0; col < COLUMNS; col++) {
      const z = colOff(col), on = lit.has(col), bottom = on ? BED - 0.2 : card ? BED + CARD_T : BED;
      const b = box(on ? P.live : P.brass, STATION_X - 0.18, STATION_X + 0.18, bottom, BED + 7, z - 0.3, z + 0.3, 0.5);
      if (on) b.emissive = glow(P.live);
      out.push(b);
    }
    // The second brushes: a holder bar, and only the brushes that find a hole drawn down to the roll.
    out.push(box(P.brass, STATION2_X - 0.18, STATION2_X + 0.18, BED + 4, BED + 7, -c, c, 0.5));
    for (const col of lit2) {
      const z = colOff(col), b = box(P.live, STATION2_X - 0.18, STATION2_X + 0.18, BED - 0.2, BED + 4, z - 0.3, z + 0.3, 0.5);
      b.emissive = glow(P.live);
      out.push(b);
    }
  } else {
    // A lamp above, twelve photocells in the slot below; the light reaches a cell only through a hole.
    for (const [sx, on, l] of [[STATION_X, covers(STATION_X), lit], [STATION2_X, covers(STATION2_X), lit2]] as const) {
      out.push(box(P.frame, sx - 3, sx + 3, BED + 14, BED + 18, -c - 2, c + 2), box(P.frame, sx - 1, sx + 1, BED, BED + 18, -c - 5, -c - 2));
      const lamp = box(P.lampOff, sx - 1.2, sx + 1.2, BED + 12.6, BED + 14, -c + 1, c - 1);
      if (on) { lamp.color = P.live; lamp.emissive = glow(P.live, 0.4); }
      out.push(lamp, box(P.frame, sx - 2.5, sx + 2.5, BED - 3.6, BED - 2.4, -c - 1, c + 1));
      for (let r = 0; r < ROWS; r++) {
        const z = rowOff(r), lt = l.has(r);
        const cell = box(lt ? P.live : P.lampOff, sx - 0.9, sx + 0.9, BED - 2.4, BED - 1.4, z - 0.9, z + 0.9, 0.5);
        if (lt) { cell.emissive = glow(P.live); out.push({ ...rod(P.beam, [sx, BED + 12.6, z], [sx, BED - 1.4, z], 0.35), emissive: glow(P.live, 0.5) }); }
        out.push(cell);
      }
    }
  }
  // The cards on the bed, holes and all.
  for (const q of L.moving) cardParts(out, m, run, q.k, q.cx, BED, P);
  // The stacker: a back plate and the cards read, face down as they came (each as it lay).
  out.push(box(P.frame, m.stacker + a + 1, m.stacker + a + 3, BED, BED + 22, -c - 1, c + 1));
  for (let i = 0; i < Math.min(L.stacker, STACK_MAX); i++) {
    const [sx, sz] = cornerSigns(run.mode, run.orient[i]), y = BED + STACK_P * i + 0.1;
    slab(out, P.card, m.stacker - a, m.stacker + a, y, y + CARD_T * 0.8, -c, c, sx, sz, 1);
  }
  // The computer's panel behind the bed: a lamp per data bit, then ready, empty, next and the two check lights; a cable from the station.
  const bits = run.mode === 'word' ? 32 : ROWS, z = m.panelZ, data = run.out[0];
  out.push(box(P.panel, lampX(0, bits) - 5, lampX(bits + 5, bits) + 3, LAMP_Y - 6, LAMP_Y + 6, z - 2, z));
  out.push(box(P.panel, -4, 4, BED - 4, LAMP_Y - 6, z - 2, z - 0.5));
  const lampAt = (x: number, on: boolean, alarm = false) => {
    const l = cyl(on ? (alarm ? P.alarm ?? P.live : P.live) : P.lampOff, x, z + 0.6, LAMP_Y - 1, LAMP_Y + 1, 0.95, 0.3);
    l.pos = [x, LAMP_Y, z + 0.3]; l.scale = [1.9, 1.9, 1.2]; l.rot = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    if (on) l.emissive = glow(alarm ? P.alarm ?? P.live : P.live, 0.7);
    out.push(l);
  };
  for (let k = 0; k < bits; k++) lampAt(lampX(k, bits), ((data >>> (bits - 1 - k)) & 1) === 1);
  [run.out[1], run.out[2], next].forEach((v, i) => lampAt(lampX(bits + 1 + i, bits) + 2, v === 1));
  [run.cmpErrs, run.seqErrs].forEach((v, i) => lampAt(lampX(bits + 4 + i, bits) + 2, v > 0, true));
  out.push(rod(P.hole, [STATION_X + (run.mode === 'word' ? 0 : 3), BED + (run.mode === 'word' ? 10 : 18), -c - 2], [STATION_X, LAMP_Y - 6, z], 0.9));
  return out;
}

export function readerAnchors(run: ReaderRun, L: ReaderLayout): Anchor[] {
  const m = MACHINES[run.mode], a = m.along / 2, c = m.across / 2, front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0];
  const bits = run.mode === 'word' ? 32 : ROWS;
  return [
    { text: 'hopper', p: [m.hopper - a - 1.2, BED + 24, c + 1.2], side: 'l', n: front },
    { text: 'picker knife', p: [m.hopper - a - 1.4 + L.knife * 14, BED, c - 2], side: 'b', n: front, minor: true },
    { text: 'feed rolls', p: [m.rolls[run.mode === 'word' ? 0 : 1], BED + CARD_T + 4, c + 3], side: 't', n: up },
    run.mode === 'word' ? { text: 'first brushes, one a column', p: [STATION_X, BED + 10, c + 4], side: 'l', n: front } : { text: 'lamp and 12 photocells', p: [STATION_X, BED + 18, c + 2], side: 'l', n: front },
    run.mode === 'word' ? { text: 'second brushes (compare)', p: [STATION2_X, BED + 10, c + 4], side: 'r', n: front } : { text: 'second station (compare)', p: [STATION2_X, BED + 18, c + 2], side: 'r', n: front },
    run.mode === 'word' ? { text: 'contact roll', p: [STATION_X, BED - 2, c + 3], side: 'b', n: front, minor: true } : { text: 'photocells', p: [STATION_X, BED - 2.4, c + 1], side: 'b', n: front, minor: true },
    { text: 'stacker', p: [m.stacker + a + 3, BED + 22, c + 1], side: 'r', n: front },
    { text: `data to the computer (${bits} bits)`, p: run.mode === 'word' ? [lampX(0, bits) - 5, LAMP_Y + 6, m.panelZ] : [lampX(bits / 2, bits), LAMP_Y + 6, m.panelZ], side: run.mode === 'word' ? 'l' : 't', n: front },
    { text: 'ready · empty · next · checks', p: run.mode === 'word' ? [lampX(bits + 3, bits) + 2, LAMP_Y + 6, m.panelZ] : [lampX(bits + 5, bits) + 3, LAMP_Y, m.panelZ], side: run.mode === 'word' ? 't' : 'r', n: front, minor: true },
  ];
}
