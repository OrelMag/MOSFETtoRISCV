// A card reader feeding a computer, as parts (DOM-free, tested). The reader is the chapter's own: cards/reader.ts's leaf,
// stepped edge by edge through its behaviour (init, eval) exactly as a simulation steps it, so what the drawing shows is
// that leaf's state: the card at the station, the cards fed, the word or column on `data`.
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
import { COLUMNS, type Deck } from '../cards/card';
import { ROW9 } from '../cards/hollerith';
import { deckReader, readerProgress, type CardReaderState, type ReaderMode } from '../cards/reader';
import type { ComponentDef } from '../sim/types';

// ---------------------------------------------------------------- the reader, stepped as a simulation steps it

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

  constructor(readonly deck: Deck, readonly mode: ReaderMode, readonly feed: number) {
    this.def = deckReader(deck, mode, { feed });
    const b = this.def.behavior!;
    this.st = b.init!('zero') as CardReaderState;
    this.out = b.eval([0, 0], this.st);
  }
  get per(): number { return this.st.per; }
  get cards(): number { return this.deck.cards.length; }
  get edges(): number { return this.st.e; }
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
    return true;
  }
}

// ---------------------------------------------------------------- where everything is

/** 1 unit = 2.5 mm: the card is 7⅜ × 3¼ inches, its columns 0.087 inch apart, its rows ¼ inch. */
export const CARD_L = 74, CARD_S = 32.5, CARD_T = 0.5, COL_P = 0.875, ROW_P = 2.5, HOLE_C = 0.55, HOLE_R = 1.25;
export const ROWS = 12;
/** Along the long side from the card's centre: column c (0 = column 1). Along the short side: row r (0 = row 12 … 11 = row 9). */
export const colOff = (c: number): number => (c - (COLUMNS - 1) / 2) * COL_P;
export const rowOff = (r: number): number => (r - (ROWS - 1) / 2) * ROW_P;
/** The bed the cards slide on, and the station's line across it. */
export const BED = 10, STATION_X = 0;
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

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

export interface ReaderLayout {
  mode: ReaderMode;
  /** Cards still in the hopper (not picked yet), cards in the stacker. */
  hopper: number; stacker: number;
  /** Cards on the bed with their holes drawn: index and centre x. */
  moving: { k: number; cx: number }[];
  /** The card standing at the station, read now (null: none, or still moving in). */
  station: number | null;
  /** Word: the columns (0-based) whose brush reaches the contact roll. Column: the rows (0 = row 12) whose cell sees the lamp. */
  lit: number[];
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
  const lit: number[] = [];
  if (station !== null && run.out[1] === 1) {
    const card = run.deck.cards[station];
    if (run.mode === 'word') { for (let c = 0; c < COLUMNS; c++) if (card.cols[c] & ROW9) lit.push(c); }
    else { const col = card.cols[p.column] & 0xfff; for (let r = 0; r < ROWS; r++) if ((col >> r) & 1) lit.push(r); }
  }
  return { mode: run.mode, hopper: run.cards - p.taken - (p.at === null ? 0 : 1), stacker: p.taken - inFlight, moving, station, lit, knife };
}

/** The word on the brushes' cable: row 9 of columns 1–`bits`, column 1 the most significant bit. */
export function cableWord(lit: readonly number[], bits = 32): number {
  let w = 0;
  for (let c = 0; c < bits; c++) w = w * 2 + (lit.includes(c) ? 1 : 0);
  return bits >= 32 ? w >>> 0 : w;
}

// ---------------------------------------------------------------- the drawing

export interface ReaderPalette { frame: RGB; bed: RGB; card: RGB; hole: RGB; metal: RGB; brass: RGB; live: RGB; lampOff: RGB; panel: RGB; beam: RGBA; rubber: RGB }

const glow = (c: RGB, k = 0.6): RGB => [c[0] * k, c[1] * k, c[2] * k];
const STACK_P = 0.7, STACK_MAX = 24;
/** The lamps on the computer's panel: x of data bit k (0 = the most significant), and of ready / empty / next. */
export const lampX = (k: number, n: number): number => (k - (n - 1) / 2) * 2.6 + (n > 16 ? 0 : -6);
export const LAMP_Y = 40;

function cardParts(out: Part[], m: Machine, run: ReaderRun, k: number, cx: number, y: number, P: ReaderPalette): void {
  const a = m.along / 2, c = m.across / 2;
  out.push(box(P.card, cx - a, cx + a, y, y + CARD_T, -c, c));
  const cols = run.deck.cards[k].cols, wide = run.mode === 'word';
  for (let col = 0; col < COLUMNS; col++) for (let r = 0; r < ROWS; r++) {
    if (!((cols[col] >> r) & 1)) continue;
    const [x, z] = m.hole(cx, col, r), hx2 = (wide ? HOLE_R : HOLE_C) / 2, hz2 = (wide ? HOLE_C : HOLE_R) / 2;
    out.push(box(P.hole, x - hx2, x + hx2, y + CARD_T, y + CARD_T + 0.05, z - hz2, z + hz2));
  }
}

export function readerParts(run: ReaderRun, L: ReaderLayout, next: 0 | 1, P: ReaderPalette): Part[] {
  const m = MACHINES[run.mode], out: Part[] = [], a = m.along / 2, c = m.across / 2, x0 = m.hopper - a - 8, x1 = m.stacker + a + 8;
  // The bed, with the station's slot, and the side plates.
  // The bed sits low, in short tiles, the card riding on two guide rails at its edges: the flat view sorts faces by their
  // middles, and one long slab under the cards would be drawn over them.
  const slot = 3.5, tiles = (xa: number, xb: number, f: (u: number, v: number) => void) => {
    const n = Math.max(1, Math.round((xb - xa) / 12));
    for (let i = 0; i < n; i++) f(xa + ((xb - xa) * i) / n, xa + ((xb - xa) * (i + 1)) / n);
  };
  for (const [xa, xb] of [[x0, STATION_X - slot], [STATION_X + slot, x1]]) tiles(xa, xb, (u, v) => {
    out.push(box(P.bed, u, v, BED - 9, BED - 6, -c - 6, c + 6));
    for (const sz of [-1, 1]) out.push(box(P.frame, u, v, BED - 6, BED, Math.min(sz * (c - 1.2), sz * (c + 0.6)), Math.max(sz * (c - 1.2), sz * (c + 0.6))));
  });
  out.push(box(P.bed, STATION_X - slot, STATION_X + slot, BED - 9, BED - 7, -c - 6, c + 6));
  for (const sz of [-1, 1]) tiles(x0, x1, (u, v) => out.push(box(P.frame, u, v, BED - 9, BED + 1.5, sz * (c + 4) - 1, sz * (c + 4) + 1)));
  // The hopper: corner posts, the cards face down, a weight on top; the picker knife at the bottom card's trailing edge.
  const hop = Math.min(L.hopper, STACK_MAX);
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) out.push(box(P.frame, m.hopper + sx * (a + 1.2) - 0.8, m.hopper + sx * (a + 1.2) + 0.8, BED, BED + 26, sz * (c + 1.2) - 0.8, sz * (c + 1.2) + 0.8));
  for (let i = 0; i < hop; i++) out.push(box(P.card, m.hopper - a, m.hopper + a, BED + STACK_P * (i + 1), BED + STACK_P * (i + 1) + CARD_T * 0.8, -c, c));
  const wy = BED + STACK_P * (hop + 1) + 0.6;
  out.push(box(P.metal, m.hopper - 4, m.hopper + 4, wy, wy + 3, -c * 0.4, c * 0.4, 0.4));
  const kx = m.hopper - a - 1.4 + L.knife * 14;
  out.push(box(P.metal, kx - 1.2, kx, BED - 0.2, BED + 0.45, -c + 2, c - 2, 0.6), box(P.frame, kx - 6, kx - 1.2, BED - 1.8, BED - 0.2, -c + 6, c - 6));
  // Feed rolls in pairs across the path, rubber below, steel above.
  for (const x of m.rolls) {
    out.push(rod(P.metal, [x, BED + CARD_T + 2, -c - 3], [x, BED + CARD_T + 2, c + 3], 2, 0.5));
    out.push(rod(P.rubber, [x, BED - 1.6, -c - 3], [x, BED - 1.6, c + 3], 1.8));
  }
  // The read station.
  const lit = new Set(L.lit);
  if (run.mode === 'word') {
    // A contact roll in the slot below, a bar of brushes above, one brush a column; a brush through a hole touches the roll.
    out.push(rod(P.brass, [STATION_X, BED - 2, -c - 3], [STATION_X, BED - 2, c + 3], 2, 0.6));
    out.push(box(P.frame, STATION_X - 2.5, STATION_X + 2.5, BED + 7, BED + 10, -c - 4, c + 4), box(P.frame, STATION_X - 1, STATION_X + 1, BED, BED + 10, -c - 6, -c - 4), box(P.frame, STATION_X - 1, STATION_X + 1, BED, BED + 10, c + 4, c + 6));
    const card = L.station !== null || L.moving.some((q) => Math.abs(q.cx - m.station(0)) < a + 1);
    for (let col = 0; col < COLUMNS; col++) {
      const z = colOff(col), on = lit.has(col), bottom = on ? BED - 0.2 : card ? BED + CARD_T : BED;
      const b = box(on ? P.live : P.brass, STATION_X - 0.18, STATION_X + 0.18, bottom, BED + 7, z - 0.3, z + 0.3, 0.5);
      if (on) b.emissive = glow(P.live);
      out.push(b);
    }
  } else {
    // A lamp above, twelve photocells in the slot below; the light reaches a cell only through a hole.
    out.push(box(P.frame, STATION_X - 3, STATION_X + 3, BED + 14, BED + 18, -c - 2, c + 2), box(P.frame, STATION_X - 1, STATION_X + 1, BED, BED + 18, -c - 5, -c - 2));
    const lamp = box(P.lampOff, STATION_X - 1.2, STATION_X + 1.2, BED + 12.6, BED + 14, -c + 1, c - 1);
    if (L.station !== null) { lamp.color = P.live; lamp.emissive = glow(P.live, 0.4); }
    out.push(lamp, box(P.frame, STATION_X - 2.5, STATION_X + 2.5, BED - 3.6, BED - 2.4, -c - 1, c + 1));
    for (let r = 0; r < ROWS; r++) {
      const z = rowOff(r), on = lit.has(r);
      const cell = box(on ? P.live : P.lampOff, STATION_X - 0.9, STATION_X + 0.9, BED - 2.4, BED - 1.4, z - 0.9, z + 0.9, 0.5);
      if (on) { cell.emissive = glow(P.live); out.push({ ...rod(P.beam, [STATION_X, BED + 12.6, z], [STATION_X, BED - 1.4, z], 0.35), emissive: glow(P.live, 0.5) }); }
      out.push(cell);
    }
  }
  // The cards on the bed, holes and all.
  for (const q of L.moving) cardParts(out, m, run, q.k, q.cx, BED, P);
  // The stacker: a back plate and the cards read, face down as they came.
  out.push(box(P.frame, m.stacker + a + 1, m.stacker + a + 3, BED, BED + 22, -c - 1, c + 1));
  for (let i = 0; i < Math.min(L.stacker, STACK_MAX); i++) out.push(box(P.card, m.stacker - a, m.stacker + a, BED + STACK_P * i + 0.1, BED + STACK_P * i + 0.1 + CARD_T * 0.8, -c, c));
  // The computer's panel behind the bed: a lamp per data bit, then ready, empty and next; a cable from the station.
  const bits = run.mode === 'word' ? 32 : ROWS, z = m.panelZ, data = run.out[0];
  out.push(box(P.panel, lampX(0, bits) - 5, lampX(bits + 3, bits) + 3, LAMP_Y - 6, LAMP_Y + 6, z - 2, z));
  out.push(box(P.panel, -4, 4, BED - 4, LAMP_Y - 6, z - 2, z - 0.5));
  const lampAt = (x: number, on: boolean) => {
    const l = cyl(on ? P.live : P.lampOff, x, z + 0.6, LAMP_Y - 1, LAMP_Y + 1, 0.95, 0.3);
    l.pos = [x, LAMP_Y, z + 0.3]; l.scale = [1.9, 1.9, 1.2]; l.rot = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
    if (on) l.emissive = glow(P.live, 0.7);
    out.push(l);
  };
  for (let k = 0; k < bits; k++) lampAt(lampX(k, bits), ((data >>> (bits - 1 - k)) & 1) === 1);
  [run.out[1], run.out[2], next].forEach((v, i) => lampAt(lampX(bits + 1 + i, bits) + 2, v === 1));
  out.push(rod(P.hole, [STATION_X + (run.mode === 'word' ? 0 : 3), BED + (run.mode === 'word' ? 10 : 18), -c - 2], [STATION_X, LAMP_Y - 6, z], 0.9));
  return out;
}

export function readerAnchors(run: ReaderRun, L: ReaderLayout): Anchor[] {
  const m = MACHINES[run.mode], a = m.along / 2, c = m.across / 2, front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0];
  const bits = run.mode === 'word' ? 32 : ROWS;
  return [
    { text: 'hopper', p: [m.hopper - a - 1.2, BED + 24, c + 1.2], side: 'l', n: front },
    { text: 'picker knife', p: [m.hopper - a - 1.4 + L.knife * 14, BED, c - 2], side: 'b', n: front, minor: true },
    { text: 'feed rolls', p: [m.rolls[0], BED + CARD_T + 4, c + 3], side: 't', n: up },
    run.mode === 'word' ? { text: 'brushes, one a column', p: [STATION_X, BED + 10, c + 4], side: 'r', n: front } : { text: 'lamp and 12 photocells', p: [STATION_X, BED + 18, c + 2], side: 'r', n: front },
    run.mode === 'word' ? { text: 'contact roll', p: [STATION_X, BED - 2, c + 3], side: 'b', n: front, minor: true } : { text: 'photocells', p: [STATION_X, BED - 2.4, c + 1], side: 'b', n: front, minor: true },
    { text: 'stacker', p: [m.stacker + a + 3, BED + 22, c + 1], side: 'r', n: front },
    { text: `data to the computer (${bits} bits)`, p: [lampX(0, bits) - 5, LAMP_Y + 6, m.panelZ], side: 'l', n: front },
    { text: 'ready · empty · next', p: [lampX(bits + 3, bits) + 2, LAMP_Y + 2, m.panelZ], side: 'r', n: front, minor: true },
  ];
}
