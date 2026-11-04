// Hollerith's press: a pin reaches its mercury exactly where the card has a hole, a full stroke counts what the census
// widget counts, a partial one closes nothing, and the drawing shows the same circuits.
import { describe, expect, it } from 'vitest';
import { FIELDS, STACK, censusPeople, newCounts, tallyCard } from '../src/cards/census';
import { CARD_TOP, HG_TOP, N, POSITIONS, closedOf, holesOf, pinTip, pressParts, reaches, type PressPalette } from '../src/widgets/press3dparts';

const people = censusPeople();
const col = (i: number): [number, number, number] => [i / 20, 0.5, 0.5];
const P: PressPalette = { frame: col(1), metal: col(2), card: col(3), hg: col(4), live: col(5), cup: col(6), face: col(7), hand: col(8), brass: col(9), pad: col(10) };

describe('the pin press against the census', () => {
  it('has a position for every option of the census card', () => {
    expect(N).toBe(FIELDS.reduce((n, f) => n + f.opts.length, 0));
  });
  it('a pin reaches its mercury at the bottom exactly when the card has a hole there, on every card', () => {
    for (const p of people) {
      const holes = holesOf(p);
      expect(holes.filter(Boolean)).toHaveLength(FIELDS.length);
      POSITIONS.forEach((q, k) => {
        expect(holes[k]).toBe(p[q.field] === q.opt);
        expect(reaches(1, holes[k])).toBe(holes[k]);
        expect(pinTip(1, holes[k])).toBe(holes[k] ? HG_TOP : CARD_TOP);
      });
    }
  });
  it('a partial stroke closes no circuit, and a pin at a hole goes further down than a blocked one', () => {
    for (const p of people.slice(0, 10)) for (let s = 0; s < 1; s += 0.01) {
      expect(closedOf(s, holesOf(p)).some(Boolean)).toBe(false);
      holesOf(p).forEach((h) => { if (!h) expect(pinTip(s, false)).toBeGreaterThanOrEqual(CARD_TOP); else expect(pinTip(s, true)).toBeLessThanOrEqual(pinTip(s, false)); });
    }
    expect(pinTip(0.85, true)).toBeLessThan(pinTip(0.85, false));
  });
  it('a full press on each card raises exactly the matching counters by one, as the census widget tallies', () => {
    const counts = newCounts();
    for (const p of people) {
      const before = counts.map((c) => c.slice());
      tallyCard(counts, p);
      const closed = closedOf(1, holesOf(p));
      POSITIONS.forEach((q, k) => expect(counts[q.field][q.opt] - before[q.field][q.opt]).toBe(closed[k] ? 1 : 0));
    }
    expect(counts.map((c) => c.reduce((a, b) => a + b))).toEqual(FIELDS.map(() => STACK));
  });
  it('the drawing lights a cup, a pin and a dial for each closed circuit and nothing before the bottom', () => {
    const lit = (s: number, holes: boolean[]) => pressParts({ s, holes, counts: POSITIONS.map(() => 0) }, P).filter((x) => x.color === P.live).length;
    const holes = holesOf(people[8]);
    expect(lit(1, holes)).toBe(3 * FIELDS.length);
    expect(lit(0.85, holes)).toBe(0);
    expect(lit(1, holes.map(() => false))).toBe(0);
  });
});
