// Hollerith's press: a pin reaches its mercury exactly where the card has a hole, a full stroke counts what the census
// widget counts, a partial one closes nothing, and the drawing shows the same circuits.
import { describe, expect, it } from 'vitest';
import { FIELDS, STACK, censusPeople, newCounts, relayDial, relayInputs, tallyCard } from '../src/cards/census';
import { CARD_TOP, HG_TOP, N, PIN_LEN, POSITIONS, RELAY_POS, closedOf, handAngles, headY, holesOf, pinTip, pinTop, reaches, springLen, type PressPose } from '../src/widgets/press3dgeom';
import { pressModel } from '../src/widgets/press3dkit';

const people = censusPeople();
const pose = (s: number, holes: boolean[], wiring: 'and' | 'or' = 'and'): PressPose => ({ s, holes, counts: POSITIONS.map(() => 0), wiring, relayCount: 0 });
/** The lit parts of the drawing (a material with its own light), outside the relays and inside them. */
const litOf = (p: PressPose) => pressModel(p).items.filter((i) => i.mat.emit);

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
  it('the drawing lights nothing before the bottom, and at the bottom a cup, a pin, a dial and its magnet per closed circuit', () => {
    // per closed position: its mercury, its pin, its dial's face and its magnet's coil
    const lit = (s: number, holes: boolean[], wiring: 'and' | 'or' = 'and') => litOf(pose(s, holes, wiring)).filter((i) => i.group !== 'relays').length;
    // A card that energizes neither relay: exactly the four parts per closed position.
    const plain = people.find((p) => !relayInputs(p).some(Boolean))!;
    expect(lit(1, holesOf(plain))).toBe(4 * FIELDS.length);
    expect(lit(1, holesOf(plain), 'or')).toBe(4 * FIELDS.length);
    for (const p of people.slice(0, 12)) expect(lit(0.85, holesOf(p))).toBe(0);
    expect(lit(1, POSITIONS.map(() => false))).toBe(0);
  });
});

describe('the spring pins', () => {
  it('every pin is the same length; a pin the card stops rides up and its spring is shorter by exactly as much', () => {
    for (let s = 0; s <= 1; s += 0.05) for (const h of [false, true]) {
      expect(pinTop(s, h) - pinTip(s, h)).toBeCloseTo(PIN_LEN, 9);
      const rise = pinTip(s, h) - (headY(s) - 14);
      expect(springLen(s, false) - springLen(s, h) - (pinTip(s, h) - pinTip(s, false))).toBeCloseTo(0, 9);
      expect(rise).toBeGreaterThanOrEqual(0);
      expect(springLen(s, h)).toBeGreaterThan(2);
    }
    // At the bottom a blocked pin's spring is compressed by the card's height over the mercury.
    expect(springLen(1, true) - springLen(1, false)).toBe(CARD_TOP - HG_TOP);
  });
});

describe('the counters', () => {
  it('two hands: the long one a turn per 100 counts, the short one a turn per 10 000', () => {
    expect(handAngles(25)[0]).toBeCloseTo(Math.PI / 2, 9);
    expect(handAngles(100)[0]).toBeCloseTo(2 * Math.PI, 9);
    expect(handAngles(2500)[1]).toBeCloseTo(Math.PI / 2, 9);
    // The census stack never wraps the long hand.
    expect(handAngles(STACK)[0]).toBeLessThan(2 * Math.PI);
  });
});

describe('the relays: AND in series, OR in parallel', () => {
  it('their cups are married: yes and born: abroad, and each energizes only when its pin reaches the mercury', () => {
    expect(POSITIONS[RELAY_POS[0]]).toMatchObject({ field: 2, opt: 0 });
    expect(POSITIONS[RELAY_POS[1]]).toMatchObject({ field: 3, opt: 1 });
    for (const p of people) {
      const c = closedOf(1, holesOf(p));
      expect([c[RELAY_POS[0]], c[RELAY_POS[1]]]).toEqual(relayInputs(p));
    }
  });
  it('the eleventh dial steps for AND / OR exactly as the contacts conduct, lit only when it does', () => {
    for (const p of people) for (const w of ['and', 'or'] as const) {
      const [a, b] = relayInputs(p);
      expect(relayDial(p, w)).toBe(w === 'and' ? a && b : a || b);
      const lit = litOf(pose(1, holesOf(p), w)), relays = lit.filter((i) => i.group === 'relays');
      if (!a && !b) expect(relays).toHaveLength(0);
      // each energized relay lights its feed wire and its coil; the contact circuit and the eleventh dial light only when it conducts
      expect(relays.filter((i) => i.name === 'wire from its cup' || i.name?.startsWith('relay:')).length).toBe((a ? 2 : 0) + (b ? 2 : 0));
      expect(relays.some((i) => i.name?.startsWith('contacts in'))).toBe(relayDial(p, w));
      expect(lit.some((i) => i.name?.endsWith('abroad dial'))).toBe(relayDial(p, w));
    }
  });
  it('adding two dials double-counts what the parallel contacts count once', () => {
    const both = people.filter((p) => relayInputs(p).every(Boolean)).length;
    const or = people.filter((p) => relayDial(p, 'or')).length, sum = people.filter((p) => relayInputs(p)[0]).length + people.filter((p) => relayInputs(p)[1]).length;
    expect(both).toBeGreaterThan(0);
    expect(sum - or).toBe(both);
  });
});

describe('the studio drawing', () => {
  const p = people[0], m = pressModel(pose(0, holesOf(p)));
  it('the card is open at every punched position and solid at every other', () => {
    const card = m.items.find((i) => i.name === 'card')!.geo, P = card.positions, I = card.indices;
    const covered = (x: number, z: number) => {
      for (let t = 0; t < I.length; t += 3) {
        const a = [P[3 * I[t]], P[3 * I[t] + 2]], b = [P[3 * I[t + 1]], P[3 * I[t + 1] + 2]], c = [P[3 * I[t + 2]], P[3 * I[t + 2] + 2]];
        const s = (u: number[], v: number[]) => (v[0] - u[0]) * (z - u[1]) - (v[1] - u[1]) * (x - u[0]);
        const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
        if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) if (Math.abs(d1) + Math.abs(d2) + Math.abs(d3) > 1e-9) return true;
      }
      return false;
    };
    holesOf(p).forEach((hole, k) => expect(covered(POSITIONS[k].x, POSITIONS[k].z)).toBe(!hole));
  });
  it('every counter is a face of 100 divisions with two hands', () => {
    const ticks = m.items.filter((i) => i.name === 'counter dial' && i.geo.name === 'ticks*');
    expect(ticks).toHaveLength(N);
    const one = ticks[0].geo.indices.length, box = one / 100;
    expect(Number.isInteger(box)).toBe(true);
  });
});
