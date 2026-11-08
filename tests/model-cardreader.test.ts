// The card reader in 3D: driven by the chapter's reader leaf edge by edge, it shows that leaf's state. The card at the
// station is the one readerProgress names, the stacker holds the cards taken, what the brushes or photocells touch is the
// leaf's data, the panel's lamps are its outputs, and the deck takes the edges the chapter states.
import { describe, expect, it } from 'vitest';
import { COLUMNS, programDeck, wordOf } from '../src/cards/card';
import { readerProgress, type ReaderMode } from '../src/cards/reader';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import {
  CARD_L, CARD_S, CARD_T, CARD_T_REAL, COL_P, CORNER, HOLE_C, HOLE_R, LAMP_Y, MACHINES, ORIENTS, ROW_P, ReaderRun, SEPARATION, STATION2_X,
  cableWord, cornerSigns, readerLayout, readerParts, scanAt, shownCols, type ReaderPalette,
} from '../src/widgets/cardreader3dparts';

const SUM = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source);
const DECK = programDeck('sum.s', SUM.lines.map((l) => ({ word: l.word, source: l.text })));
const FEED = 2, N = DECK.cards.length;
const SEQ_LAST = (n: number) => 10 * n;
const col = (i: number): [number, number, number] => [i / 20, 0.5, 0.5];
const P: ReaderPalette = { frame: col(1), bed: col(2), card: col(3), hole: col(4), metal: col(5), brass: col(6), live: col(7), lampOff: col(8), panel: col(9), beam: [1, 1, 0, 0.5], rubber: col(10) };

/** Run the whole deck with next held at 1, checking every settled pose and a few mid-motion ones. */
function sweep(mode: ReaderMode, check: (run: ReaderRun) => void): ReaderRun {
  const run = new ReaderRun(DECK, mode, FEED);
  check(run);
  for (let k = 0; k < 10_000 && !run.out[2]; k++) { run.edge(1); check(run); }
  return run;
}

describe('the card reader model against the reader leaf', () => {
  it('row by row: the card at the station, the hopper and stacker counts follow the leaf at every edge', () => {
    sweep('word', (run) => {
      const p = readerProgress(run.st), L = readerLayout(run);
      expect(L.station).toBe(p.feeding ? null : p.at);
      expect(L.station !== null).toBe(run.out[1] === 1);
      expect(L.hopper + L.stacker + L.moving.length).toBe(N);
      expect(L.stacker).toBe(p.taken);
      for (const u of [0, 0.3, 0.7]) {
        const M = readerLayout(run, u);
        expect(M.hopper + M.stacker + M.moving.length).toBe(N);
        for (const q of M.moving) expect(q.cx).toBeGreaterThanOrEqual(MACHINES.word.hopper - 1e-9), expect(q.cx).toBeLessThanOrEqual(MACHINES.word.stacker + 1e-9);
      }
    });
  });

  it('row by row: the brushes over columns 1–32 that reach the roll carry exactly the word on data, and none between cards', () => {
    let seen = 0;
    sweep('word', (run) => {
      const L = readerLayout(run), [data, ready] = run.out;
      expect(cableWord(L.lit)).toBe(data >>> 0);
      if (!ready) expect(L.lit).toEqual([]);
      else { expect(data >>> 0).toBe(wordOf(DECK.cards[L.station!])); seen++; }
    });
    expect(seen).toBeGreaterThan(0);
  });

  it('row by row: the computer takes every word in order, and the deck takes the chapter\'s edge count', () => {
    const run = sweep('word', () => undefined);
    expect(run.taken).toEqual(SUM.lines.map((l) => l.word >>> 0));
    expect(run.edges).toBe((FEED + 1) * (N - 1) + 1);
    expect(readerLayout(run).stacker).toBe(N);
  });

  it('column by column: the lit photocells are the column on data, the card stands on that column, and row 9 of columns 1–32 is the word', () => {
    const m = MACHINES.column;
    const run = sweep('column', (run) => {
      const p = readerProgress(run.st), L = readerLayout(run), [data, ready] = run.out;
      expect(L.lit.reduce((w, r) => w | (1 << r), 0)).toBe(ready ? data : 0);
      if (ready) {
        expect(data).toBe(DECK.cards[p.at!].cols[p.column] & 0xfff);
        const q = L.moving.find((c) => c.k === p.at)!;
        expect(m.hole(q.cx, p.column, 0)[0]).toBeCloseTo(0, 9); // that column is under the cells
      }
    });
    expect(run.edges).toBe(COLUMNS * N + FEED * (N - 1));
    expect(run.taken).toHaveLength(COLUMNS * N);
    for (let k = 0; k < N; k++) {
      let w = 0;
      for (const c of run.taken.slice(k * COLUMNS, k * COLUMNS + 32)) w = w * 2 + ((c >> 11) & 1);
      expect(w >>> 0).toBe(SUM.lines[k].word >>> 0);
    }
  });

  it('next = 0 takes nothing: the card waits at the station and the clock still counts', () => {
    const run = new ReaderRun(DECK, 'word', FEED);
    for (let k = 0; k < 5; k++) run.edge(0);
    expect(run.edges).toBe(5);
    expect(run.taken).toEqual([]);
    expect(readerLayout(run).station).toBe(0);
  });

  it('the drawing lights a brush per hole in row 9 and a panel lamp per output bit', () => {
    const run = new ReaderRun(DECK, 'word', FEED), L = readerLayout(run);
    const parts = readerParts(run, L, 1, P), lit = parts.filter((x) => x.color === P.live);
    const lamps = lit.filter((x) => Math.abs(x.pos[1] - LAMP_Y) < 1e-9).length, brushes = lit.length - lamps;
    const ones = (run.out[0] >>> 0).toString(2).split('').filter((b) => b === '1').length;
    expect(brushes).toBe(L.lit.length);
    expect(lamps).toBe(ones + run.out[1] + run.out[2] + 1);
    const idle = readerParts(run, L, 0, P).filter((x) => x.color === P.live && Math.abs(x.pos[1] - LAMP_Y) < 1e-9).length;
    expect(idle).toBe(lamps - 1);
  });

  it('the card is the standard one: inches times 2.54 over 2.5 mm a unit, drawn 7 times too thick on purpose', () => {
    const mm = 2.5, inch = 25.4;
    expect(CARD_L * mm / inch).toBeCloseTo(7.375, 2);
    expect(CARD_S * mm / inch).toBeCloseTo(3.25, 2);
    expect(COL_P * mm / inch).toBeCloseTo(0.087, 3);
    expect(ROW_P * mm / inch).toBeCloseTo(0.25, 3);
    expect(HOLE_C * mm / inch).toBeCloseTo(0.055, 3);
    expect(HOLE_R * mm / inch).toBeCloseTo(0.125, 3);
    expect(CORNER * mm / inch).toBeCloseTo(0.25, 3);
    expect(CARD_T_REAL * mm / inch).toBeCloseTo(0.007, 3);
    expect(CARD_T / CARD_T_REAL).toBeGreaterThan(6.9);
    expect(CARD_T / CARD_T_REAL).toBeLessThan(7.1);
    // 80 columns fit with the same margin at both ends
    expect(COL_P * 79).toBeLessThan(CARD_L - 2 * 2.5);
  });

  it('the corner is clipped on the upper left (12 edge, column 1) and moves with the way the card lies', () => {
    expect(cornerSigns('word', ORIENTS[0])).toEqual([-1, -1]);
    expect(cornerSigns('column', ORIENTS[0])).toEqual([1, -1]);
    for (const mode of ['word', 'column'] as const) {
      const m = MACHINES[mode];
      // the clipped corner is the one nearest row 12 and column 1
      const [r12c1x, r12c1z] = m.hole(0, 0, 0), [sx, sz] = cornerSigns(mode, ORIENTS[0]);
      expect(Math.sign(r12c1x)).toBe(sx); expect(Math.sign(r12c1z)).toBe(sz);
      // the drawn slab of the card at the station leaves that corner empty and covers the opposite one
      for (let o = 0; o < ORIENTS.length; o++) {
        const run = new ReaderRun(DECK, mode, FEED);
        run.orient[0] = ORIENTS[o];
        const L = readerLayout(run), cx = L.moving[0].cx, [kx, kz] = cornerSigns(mode, ORIENTS[o]);
        const ex = m.along / 2, ez = m.across / 2, cards = readerParts(run, L, 1, P).filter((x) => x.color === P.card && Math.abs(x.pos[1] - (10 + CARD_T / 2)) < 1e-6);
        const covered = (x: number, z: number) => cards.some((b) => Math.abs(x - b.pos[0]) <= (b.scale?.[0] ?? 0) / 2 && Math.abs(z - b.pos[2]) <= (b.scale?.[2] ?? 0) / 2);
        expect(covered(cx + kx * (ex - 0.2), kz * (ez - 0.2))).toBe(false);
        expect(covered(cx - kx * (ex - 0.2), -kz * (ez - 0.2))).toBe(true);
        expect(covered(cx + kx * (ex - CORNER - 0.2), kz * (ez - 0.2))).toBe(true);
      }
    }
  });

  it('the cards are read on the move: row 9 first, then 8 … 0, 11, 12 pass the first brushes as the card leaves', () => {
    const run = new ReaderRun(DECK, 'word', FEED);
    // reach the card, take it, and follow the exit
    run.edge(1);
    const seen: number[] = [];
    for (let i = 0; i <= 200; i++) {
      const L = readerLayout(run, i / 200), a = L.under;
      if (a !== null && seen[seen.length - 1] !== a) seen.push(a);
    }
    expect(seen[0]).toBe(11); // row 9 under the brushes
    expect(seen).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    // and every brush found a hole in its time: the union over the pass is each column with any hole in rows 0–9 / 11 / 12
    const holes = new Set<number>();
    for (let i = 0; i <= 200; i++) readerLayout(run, i / 200).lit.forEach((c) => holes.add(c));
    expect([...holes].sort((x, y) => x - y)).toEqual(DECK.cards[0].cols.map((m, c) => (m ? c : -1)).filter((c) => c >= 0));
  });

  it('the second station sits 22 units on and reads the same holes with the card at its place', () => {
    expect(SEPARATION).toBe(22);
    const cols = DECK.cards[0].cols;
    for (const mode of ['word', 'column'] as const) {
      const m = MACHINES[mode], cx = mode === 'word' ? m.station(0) + SEPARATION : m.station(0) + SEPARATION;
      const a = scanAt(mode, cols, m.station(mode === 'word' ? 0 : 5), 0), b = scanAt(mode, cols, cx, STATION2_X);
      if (mode === 'word') { expect(b.idx).toBe(a.idx); expect(b.lit).toEqual(a.lit); }
      else expect(b.idx).not.toBeNull();
    }
  });

  it('a card turned the wrong way is read as it lies; the second station agrees, the sequence check stops it', () => {
    for (const mode of ['word', 'column'] as const) {
      const good = new ReaderRun(DECK, mode, FEED);
      expect(good.errors).toBe(0);
      for (let k = 0; k < 10_000 && !good.out[2]; k++) good.edge(1);
      expect(good.errors).toBe(0);
      expect(good.lastSeq).toBe(SEQ_LAST(N));
      for (let o = 1; o < ORIENTS.length; o++) {
        const run = new ReaderRun(DECK, mode, FEED);
        expect(run.canTurn(2)).toBe(true);
        run.turn(2, ORIENTS[o]);
        for (let k = 0; k < 10_000 && !run.out[2] && run.seqErrs === 0; k++) run.edge(1);
        expect(run.seqErrs).toBe(1);
        expect(run.cmpErrs).toBe(0); // both stations read the same wrong holes
        expect(run.alarm).toMatch(/Sequence check on card 3/);
        // what the computer took is what the brushes saw
        if (mode === 'word') expect(run.taken[2]).not.toBe(SUM.lines[2].word >>> 0);
      }
    }
  });

  it('shownCols: turning twice is the identity, and the right way leaves the card alone', () => {
    const cols = DECK.cards[1].cols;
    expect(shownCols(cols, ORIENTS[0])).toEqual(cols.map((m) => m & 0xfff));
    for (const o of ORIENTS) expect(shownCols(shownCols(cols, o), o)).toEqual(cols.map((m) => m & 0xfff));
  });

  it('a dirty first station is caught by the compare, and a card in the hopper only can be turned', () => {
    for (const mode of ['word', 'column'] as const) {
      const run = new ReaderRun(DECK, mode, FEED, { dirty: true });
      for (let k = 0; k < 10_000 && !run.out[2] && run.cmpErrs === 0; k++) run.edge(1);
      expect(run.cmpErrs).toBe(1);
      expect(run.alarm).toMatch(/Compare check/);
    }
    const run = new ReaderRun(DECK, 'word', FEED);
    run.edge(1); run.edge(1); run.edge(1); // card 1 taken, card 2 at the station or arriving
    expect(run.canTurn(0)).toBe(false);
    expect(run.canTurn(N - 1)).toBe(true);
  });
});
