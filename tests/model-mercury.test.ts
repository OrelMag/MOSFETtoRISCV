// EDSAC's mercury tank: delay = length / speed, capacity = delay x rate, held to the 1948 report's figures; the circulating
// store must hand back what was written, only when the word comes round, and forget when the loop is cut.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import {
  CARRIER_HZ, LENGTH_M, REPORT, SLOTS, SLOTS_PER_WORD, SOUND_M_S, Tank, WORDS, bandOf, bitsInTank, carrierCycles, circulationHz, delayS,
  initialWord, mercuryAnchors, mercuryParts, pulseLengthM, rateHz, slotPitchM, slotS, storeLongWords, storeShortWords, valueOfSlots, wordSlots,
  type MercuryPalette,
} from '../src/widgets/mercury3dparts';

const c = (i: number): RGB => [i / 20, 0.5, 0.5], ca = (i: number): RGBA => [i / 20, 0.5, 0.5, 0.4];
const P: MercuryPalette = {
  steel: c(1), steelClear: ca(2), mercury: c(3), quartz: ca(4), brass: c(5), housing: ca(6), pulse: [0.1, 0.9, 0.2], pulseOff: c(8), bandA: ca(9), bandB: ca(10), bandSel: ca(11),
  panel: c(12), lamp: c(13), live: c(14), wire: c(15), cut: c(16),
};
const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b) / b).toBeLessThan(tol);

describe('the figures', () => {
  it('delay is length over speed, and the report’s 5 ft 4 in is about a millisecond', () => {
    expect(LENGTH_M).toBeCloseTo(1.6256, 4);
    expect(delayS()).toBe(LENGTH_M / SOUND_M_S);
    near(delayS(), REPORT.delayS, 0.03);
  });
  it('bits in the tube = delay x rate = 16 x 36 = 576', () => {
    expect(bitsInTank()).toBeCloseTo(delayS() * rateHz(), 9);
    expect(Math.round(bitsInTank())).toBe(576);
    expect(SLOTS).toBe(WORDS * SLOTS_PER_WORD);
  });
  it('the rate, the slot and the circulation are the report’s to a few per cent', () => {
    near(rateHz(), 1 / REPORT.slotS, 0.03);
    near(slotS(), REPORT.slotS, 0.03);
    near(circulationHz(), REPORT.circHz, 0.03);
  });
  it('pulses are a fraction of a slot long, a few millimetres apart, and a pulse holds about a dozen carrier cycles', () => {
    expect(pulseLengthM()).toBeLessThan(slotPitchM());
    expect(slotPitchM()).toBeCloseTo(SOUND_M_S * slotS(), 9);
    expect(slotPitchM() * 1000).toBeGreaterThan(2.5);
    expect(slotPitchM() * 1000).toBeLessThan(3.1);
    expect(carrierCycles()).toBeCloseTo(0.9e-6 * CARRIER_HZ, 9);
  });
  it('the store is 32 tanks, 512 long numbers, 1024 short ones', () => {
    expect(storeLongWords()).toBe(512);
    expect(storeShortWords()).toBe(1024);
  });
});

describe('the circulating tank', () => {
  it('words round-trip through their 36 slots, P0 blank', () => {
    for (const v of [0, 1, 2 ** 34, 2 ** 35 - 1, 123456789]) {
      const s = wordSlots(v);
      expect(s).toHaveLength(36);
      expect(s[0]).toBe(0);
      expect(valueOfSlots(s)).toBe(v);
    }
  });
  it('a full circulation brings every pulse back where it was', () => {
    const t = new Tank();
    const before = Array.from(t.bits), pos = Array.from({ length: SLOTS }, (_, L) => t.pos(L));
    t.advance(SLOTS);
    expect(Array.from(t.bits)).toEqual(before);
    for (let L = 0; L < SLOTS; L += 37) expect(t.pos(L)).toBeCloseTo(pos[L], 9);
  });
  it('a read returns the word, after waiting for it to come round', () => {
    const t = new Tank();
    t.advance(100);
    const w = 3, wait = t.waitFor(w);
    t.request('read', w);
    t.advance(SLOTS * 2);
    const a = t.last!;
    expect(a.done).toBe(true);
    expect(valueOfSlots(a.got)).toBe(initialWord(w));
    expect(a.got).toHaveLength(36);
    expect(a.waitSlots).toBe(wait);
    expect(a.waitSlots).toBeLessThan(SLOTS);
    expect(t.word(w)).toBe(initialWord(w));
  });
  it('no wait if the word is just starting, nearly a whole circulation if it just went by', () => {
    const t = new Tank();
    expect(t.waitFor(0)).toBe(0);
    t.advance(1);
    expect(t.waitFor(0)).toBe(SLOTS - 1);
  });
  it('a write replaces one word only, and a later read finds it', () => {
    const t = new Tank();
    const others = Array.from({ length: WORDS }, (_, w) => t.word(w));
    t.request('write', 7, 0x5a5a5a5a);
    t.advance(SLOTS + 40);
    expect(t.word(7)).toBe(0x5a5a5a5a);
    for (let w = 0; w < WORDS; w++) if (w !== 7) expect(t.word(w)).toBe(others[w]);
    t.request('read', 7);
    t.advance(SLOTS + 40);
    expect(valueOfSlots(t.last!.got)).toBe(0x5a5a5a5a);
  });
  it('with the loop cut the store is empty after one circulation, not before', () => {
    const t = new Tank();
    t.loop = false;
    t.advance(SLOTS / 2);
    expect(t.bits.some((b) => b)).toBe(true);
    expect(t.bits.slice(0, SLOTS / 2).every((b) => b === 0)).toBe(true);
    expect(t.bits.slice(SLOTS / 2).some((b) => b)).toBe(true);
    t.advance(SLOTS / 2 + 1);
    expect(t.bits.every((b) => b === 0)).toBe(true);
  });
  it('the mean wait is half a circulation', () => {
    const t = new Tank();
    let sum = 0;
    for (let k = 0; k < SLOTS; k++) { sum += t.waitFor(5); t.advance(1); }
    near(sum / SLOTS * slotS(), delayS() / 2, 0.02);
  });
});

describe('the drawing', () => {
  it('one pulse per 1 in the tank, all inside the tube, and the words tile the tube', () => {
    const t = new Tank();
    t.advance(123.4);
    const pulses = mercuryParts(t, 2, P).filter((p) => p.spec === 0.1);
    expect(pulses).toHaveLength(t.bits.reduce((a, b) => a + b, 0));
    for (const p of pulses) { expect(p.pos[0]).toBeGreaterThan(-121); expect(p.pos[0]).toBeLessThan(121); }
    let tiled = 0;
    for (let w = 0; w < WORDS; w++) tiled += bandOf(t, w).reduce((a, [x, y]) => a + (y - x), 0);
    expect(tiled).toBeCloseTo(SLOTS, 9);
    expect(mercuryAnchors(t, 2).length).toBeGreaterThan(5);
  });
  it('pulses are one slot pitch apart in the drawing', () => {
    const t = new Tank();
    expect(Math.abs(t.pos(5) - t.pos(6))).toBeCloseTo(1, 9);
  });
});
