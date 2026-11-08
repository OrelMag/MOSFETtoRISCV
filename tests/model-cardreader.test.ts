// The card reader in 3D: driven by the chapter's reader leaf edge by edge, it shows that leaf's state. The card at the
// station is the one readerProgress names, the stacker holds the cards taken, what the brushes or photocells touch is the
// leaf's data, the panel's lamps are its outputs, and the deck takes the edges the chapter states.
import { describe, expect, it } from 'vitest';
import { COLUMNS, programDeck, wordOf } from '../src/cards/card';
import { readerProgress, type ReaderMode } from '../src/cards/reader';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { LAMP_Y, MACHINES, ReaderRun, cableWord, readerLayout, readerParts, type ReaderPalette } from '../src/widgets/cardreader3dparts';

const SUM = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source);
const DECK = programDeck('sum.s', SUM.lines.map((l) => ({ word: l.word, source: l.text })));
const FEED = 2, N = DECK.cards.length;
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
      for (const u of [0, 0.5]) if (run.edges > 0) expect(readerLayout(run, u).lit.length === 0 || u >= 1).toBe(true);
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
});
