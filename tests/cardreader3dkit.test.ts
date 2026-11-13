// The card reader on the studio renderer (widgets/cardreader3dkit.ts) held to the card's standard and to the reader leaf:
// the card at 7⅜ × 3¼ in with its corner cut and every hole cut through (its paper's area is the card's less the corner
// and the holes), the holes where the machine reads them, a brush per column at each station dropping through a hole to
// the roll exactly where readerLayout lights it, the cells and beams of the column reader, a lamp per bit on the panel,
// and the cut through a column whose row 9 is punched.
import { describe, expect, it } from 'vitest';
import { COLUMNS, programDeck } from '../src/cards/card';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { BED, CARD_L, CARD_S, CARD_T, CORNER, HOLE_C, HOLE_R, MACHINES, ORIENTS, ROWS, ReaderRun, readerLayout, rowOff, colOff } from '../src/widgets/cardreader3dparts';
import { CUT_COL_DEFAULT, FRAME_GROUPS, SRC, brushes, cardGeo, cells, cutAt, cutColumn, cutZ, holeRects, panelLamps, readerModel, type ReaderLook, type ReaderRgb } from '../src/widgets/cardreader3dkit';

const SUM = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source);
const DECK = programDeck('sum.s', SUM.lines.map((l) => ({ word: l.word, source: l.text })));
const rgb: ReaderRgb = { live: [1, 0.8, 0.2], brass: [0.8, 0.6, 0.2], cellOff: [0.3, 0.3, 0.3], lampOff: [0.2, 0.2, 0.2], alarm: [1, 0, 0], beam: [1, 1, 0.6] };
const look = (run: ReaderRun, detail: ReaderLook['detail'] = 'full'): ReaderLook => ({ detail, run, L: readerLayout(run), next: 1, rgb });
const pop = (cols: readonly number[]) => cols.reduce((s, m) => s + [...m.toString(2)].filter((b) => b === '1').length, 0);

/** The area of the faces pointing up (+y) of a mesh. */
function upArea(g: ReturnType<typeof cardGeo>): number {
  let A = 0;
  const P = g.positions, I = g.indices;
  for (let k = 0; k < I.length; k += 3) {
    const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2];
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    if (ny > 0) A += ny / 2;
  }
  return A;
}

describe('the card', () => {
  it('is 7⅜ × 3¼ in (2.5 mm a unit), CARD_T thick, and the source says so', () => {
    for (const mode of ['word', 'column'] as const) {
      const g = cardGeo(mode, DECK.cards[0].cols, ORIENTS[0]), m = MACHINES[mode];
      expect(g.max[0] - g.min[0]).toBeCloseTo(m.along, 6);
      expect(g.max[2] - g.min[2]).toBeCloseTo(m.across, 6);
      expect(g.max[1] - g.min[1]).toBeCloseTo(CARD_T, 6);
    }
    expect(CARD_L).toBeCloseTo((7.375 * 25.4) / 2.5, 2);
    expect(CARD_S).toBeCloseTo((3.25 * 25.4) / 2.5, 2);
    expect(SRC.card).toContain('0.087');
  });
  it('its paper is the card less the cut corner and every hole: the holes go right through', () => {
    for (const mode of ['word', 'column'] as const) for (const k of [0, 3]) {
      const cols = DECK.cards[k].cols, g = cardGeo(mode, cols, ORIENTS[k % 4]);
      const want = CARD_L * CARD_S - (CORNER * CORNER) / 2 - pop(cols) * HOLE_C * HOLE_R;
      expect(upArea(g)).toBeCloseTo(want, 3);
      expect(holeRects(mode, cols)).toHaveLength(pop(cols));
    }
  });
  it('the holes stand where the machine reads them: a row across the path in word mode, a column in column mode', () => {
    const cols = DECK.cards[0].cols;
    for (const mode of ['word', 'column'] as const) {
      const centres = holeRects(mode, cols).map(([x0, x1, z0, z1]) => [(x0 + x1) / 2, (z0 + z1) / 2]);
      for (let c = 0; c < COLUMNS; c++) for (let r = 0; r < ROWS; r++) if ((cols[c] >> r) & 1) {
        const [x, z] = MACHINES[mode].hole(0, c, r);
        expect(centres.some(([a, b]) => Math.abs(a - x) < 1e-9 && Math.abs(b - z) < 1e-9)).toBe(true);
      }
    }
  });
});

describe('the brushes, cells and lamps follow the reader leaf', () => {
  it('row by row: 80 brushes a station; the lit ones are readerLayout’s and reach the contact roll, the rest rest on the card', () => {
    const run = new ReaderRun(DECK, 'word', 2);
    for (let e = 0; e < 40 && !run.out[2]; e++) {
      const lk = look(run), b = brushes(lk);
      expect(b).toHaveLength(2 * COLUMNS);
      const first = b.slice(0, COLUMNS), down = first.map((x, c) => (x.emissive ? c : -1)).filter((c) => c >= 0);
      expect(down).toEqual(lk.L.lit);
      for (const c of down) expect(first[c].pos[1] - first[c].scale![1] / 2).toBeCloseTo(BED - 0.2, 9);
      run.edge(1);
    }
  });
  it('the cut leaves the brushes on its far side only', () => {
    const run = new ReaderRun(DECK, 'word', 2), lk = look(run), z = cutZ('word', 7);
    expect(brushes(lk, z).every((b) => b.pos[2] <= z)).toBe(true);
    expect(brushes(lk, z)).toHaveLength(2 * 8);
    expect(cutAt('word', 7, 0)).toBe(Infinity);
    expect(cutAt('word', 7, 1)).toBeCloseTo(z, 9);
  });
  it('column by column: twelve cells a station, a beam only through a hole', () => {
    const run = new ReaderRun(DECK, 'column', 2);
    for (let e = 0; e < 30; e++) run.edge(1);
    const lk = look(run), { cells: cs, beams } = cells(lk);
    expect(cs).toHaveLength(2 * ROWS);
    expect(beams).toHaveLength(lk.L.lit.length + lk.L.lit2.length);
    lk.L.lit.forEach((r, i) => expect(beams[i].pos[2]).toBeCloseTo(rowOff(r), 9));
  });
  it('a lamp per data bit, lit as the bit, then ready, empty, next and the two checks', () => {
    for (const mode of ['word', 'column'] as const) {
      const run = new ReaderRun(DECK, mode, 2);
      for (let e = 0; e < 5; e++) run.edge(1);
      const bits = mode === 'word' ? 32 : ROWS, L = panelLamps(run, 1, rgb);
      expect(L).toHaveLength(bits + 5);
      for (let k = 0; k < bits; k++) expect(!!L[k].emissive).toBe(((run.out[0] >>> (bits - 1 - k)) & 1) === 1);
    }
  });
});

describe('the model', () => {
  it('a cut across the path through a column whose row 9 is punched, so it catches a brush through its hole', () => {
    const run = new ReaderRun(DECK, 'word', 2);
    while (readerLayout(run).station === null) run.edge(0);
    const col = cutColumn(run, readerLayout(run)), cols = run.cols(readerLayout(run).station!, true);
    if (col !== CUT_COL_DEFAULT) expect((cols[col] >> 11) & 1).toBe(1);
    const m = readerModel(look(run), col);
    expect(m.cuts!.planes).toEqual([{ n: [0, 0, 1], d: cutZ('word', col) }]);
    expect(cutZ('word', col)).toBeCloseTo(colOff(col), 2);
  });
  it('the cards on the bed move as groups mv0, mv1; the frames and the five beats are there in both machines', () => {
    for (const mode of ['word', 'column'] as const) {
      const run = new ReaderRun(DECK, mode, 2);
      run.edge(1);
      const m = readerModel(look(run));
      expect(m.items.some((it) => it.group === 'mv0')).toBe(true);
      for (const g of FRAME_GROUPS) expect(m.items.some((it) => it.group === g)).toBe(true);
      expect(m.beats).toHaveLength(5);
    }
  });
  it('the flat drawing has the brushes, cells and lamps as parts (it has no instances)', () => {
    const w = readerModel(look(new ReaderRun(DECK, 'word', 2), 'flat'));
    expect(w.items.filter((it) => it.group === 'brushes')).toHaveLength(2 * COLUMNS);
    const c = readerModel(look(new ReaderRun(DECK, 'column', 2), 'flat'));
    expect(c.items.filter((it) => it.name === 'photocells')).toHaveLength(2 * ROWS);
    expect(readerModel(look(new ReaderRun(DECK, 'word', 2))).items.some((it) => it.group === 'brushes')).toBe(false);
  });
});
