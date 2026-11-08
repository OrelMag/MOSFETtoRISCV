// EDSAC's mercury tank: delay = length / speed, capacity = delay x rate, held to the 1948 report's figures; the circulating
// store must hand back what was written, only when the word comes round, and forget when the loop is cut.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import {
  CARRIER_HZ, CUT_LENGTH_M, LENGTH_M, REPORT, ROW_HIT_S, SLOTS, SLOTS_PER_WORD, SOUND_M_S, TANK_C, Tank, WINDOW_TOL, WORDS, bandOf, bitsInTank, carrierCycles,
  circulationHz, delayS, dramRatio, histogram, inWindow, initialWord, mercuryAnchors, mercuryParts, meanWaitS, offsetSlots, pulseLengthM, randomWaits, rateHz,
  reportTubeDelayS, slotPitchM, slotS, soundAt, storeLongWords, storeShortWords, toleranceK, tubeDelayAt, valueOfSlots, wordSlots,
  type MercuryPalette,
} from '../src/widgets/mercury3dparts';

const c = (i: number): RGB => [i / 20, 0.5, 0.5], ca = (i: number): RGBA => [i / 20, 0.5, 0.5, 0.4];
const P: MercuryPalette = {
  steel: c(1), steelClear: ca(2), mercury: c(3), quartz: ca(4), brass: c(5), housing: ca(6), pulse: [0.1, 0.9, 0.2], pulseOff: c(8), bandA: ca(9), bandB: ca(10), bandSel: ca(11),
  panel: c(12), lamp: c(13), live: c(14), wire: c(15), cut: c(16),
};
const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b) / b).toBeLessThan(tol);

describe('the figures', () => {
  it('the clock fixes the timing: 500 kHz, 2 µs, 576 slots, 1.152 ms, 868 a second, mean wait 576 µs', () => {
    expect(LENGTH_M).toBeCloseTo(1.6256, 4);
    expect(rateHz()).toBeCloseTo(500e3, 3);
    expect(slotS()).toBe(2e-6);
    expect(delayS()).toBeCloseTo(1.152e-3, 12);
    expect(delayS()).toBeCloseTo(SLOTS * slotS(), 15);
    near(delayS(), REPORT.delayS, 0.005);
    near(circulationHz(), REPORT.circHz, 0.005);
    expect(meanWaitS()).toBeCloseTo(576e-6, 12);
  });
  it('sound in mercury: 1451 m/s at 20 °C, -0.46 m/s per K (Karl Deutsch table), 1442 m/s at the tanks’ 40 °C', () => {
    expect(soundAt(20)).toBe(1451);
    expect(TANK_C).toBe(40);
    expect(SOUND_M_S).toBeCloseTo(1441.8, 6);
    expect(soundAt(50) - soundAt(30)).toBeCloseTo(-9.2, 9);
  });
  it('the tube is cut to the clock at 40 °C: 1.66 m, 2.2 % past the report’s end-block length, whose own L / v is 2.2 % short', () => {
    expect(CUT_LENGTH_M / SOUND_M_S).toBeCloseTo(delayS(), 12);
    expect(tubeDelayAt(TANK_C)).toBeCloseTo(delayS(), 12);
    expect(CUT_LENGTH_M).toBeCloseTo(1.6611, 3);
    expect(CUT_LENGTH_M / LENGTH_M - 1).toBeGreaterThan(0.02);
    expect(CUT_LENGTH_M / LENGTH_M - 1).toBeLessThan(0.023);
    expect(reportTubeDelayS()).toBeCloseTo(1.1274e-3, 6);
  });
  it('bits in the tube = delay x rate = 16 x 36 = 576', () => {
    expect(bitsInTank()).toBeCloseTo(delayS() * rateHz(), 9);
    expect(Math.round(bitsInTank())).toBe(576);
    expect(SLOTS).toBe(WORDS * SLOTS_PER_WORD);
  });
  it('pulses are 0.45 of a slot long, about 2.9 mm apart, and a pulse holds about a dozen carrier cycles', () => {
    expect(pulseLengthM()).toBeLessThan(slotPitchM());
    expect(slotPitchM()).toBeCloseTo(SOUND_M_S * slotS(), 9);
    expect(slotPitchM() * 1000).toBeGreaterThan(2.8);
    expect(slotPitchM() * 1000).toBeLessThan(3.0);
    expect(carrierCycles()).toBeCloseTo(0.9e-6 * CARRIER_HZ, 9);
  });
  it('the store is 32 tanks, 512 long numbers, 1024 short ones', () => {
    expect(storeLongWords()).toBe(512);
    expect(storeShortWords()).toBe(1024);
  });
});

describe('temperature', () => {
  it('pulses slide 0.18 slot a kelvin; late when warmer, early when cooler; the window is ±0.275 slot', () => {
    expect(offsetSlots(TANK_C)).toBeCloseTo(0, 9);
    expect(offsetSlots(41)).toBeGreaterThan(0);
    expect(offsetSlots(39)).toBeLessThan(0);
    expect(offsetSlots(41)).toBeCloseTo(0.1838, 3);
    expect(WINDOW_TOL).toBeCloseTo(0.275, 9);
    expect(toleranceK()).toBeCloseTo(1.5, 1);
  });
  it('the window holds within ±1.5 K of 40 °C and the slider’s ends miss by about two slots', () => {
    expect(inWindow(40)).toBe(true);
    expect(inWindow(41.4)).toBe(true);
    expect(inWindow(41.6)).toBe(false);
    expect(inWindow(38.6)).toBe(true);
    expect(inWindow(38.4)).toBe(false);
    expect(inWindow(30)).toBe(false);
    expect(Math.abs(offsetSlots(50))).toBeGreaterThan(1.5);
    expect(Math.abs(offsetSlots(50))).toBeLessThan(2);
  });
  it('in the window a read is exact; outside it every pulse is missed, the read fails and the tank empties in one circulation', () => {
    const ok = new Tank();
    ok.offset = offsetSlots(41);
    ok.request('read', 4); ok.advance(SLOTS * 2);
    expect(valueOfSlots(ok.last!.got)).toBe(initialWord(4));
    expect(ok.last!.lost).toBe(0);
    const bad = new Tank();
    bad.offset = offsetSlots(45);
    bad.request('read', 4); bad.advance(SLOTS * 2);
    expect(bad.last!.lost).toBeGreaterThan(0);
    expect(valueOfSlots(bad.last!.got)).toBe(0);
    expect(bad.bits.every((b) => b === 0)).toBe(true);
    bad.offset = 0; bad.advance(SLOTS);
    expect(bad.word(4)).toBe(0);
  });
  it('the drawing shifts pulses along with the offset, fully at the receiver', () => {
    const a = new Tank(), b = new Tank();
    b.offset = offsetSlots(48);
    const xs = (t: Tank) => mercuryParts(t, 2, P).filter((p) => p.spec === 0.1).map((p) => p.pos[0]);
    const xa = xs(a), xb = xs(b);
    expect(xb).toHaveLength(xa.length);
    expect(xb.some((x, i) => Math.abs(x - xa[i]) > 0.2)).toBe(true);
  });
});

describe('random reads and the DRAM comparison', () => {
  const seeded = () => { let x = 12345; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; };
  it('waits are flat over one circulation, the mean near half of it', () => {
    const w = randomWaits(4000, seeded());
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...w)).toBeLessThan(SLOTS);
    near((w.reduce((a, b) => a + b, 0) / w.length) * slotS(), meanWaitS(), 0.05);
    const h = histogram(w, 8);
    for (const n of h) expect(Math.abs(n - 500)).toBeLessThan(90);
    expect(h.reduce((a, b) => a + b, 0)).toBe(4000);
  });
  it('twenty reads fill the histogram and stay in range', () => {
    const w = randomWaits(20, seeded());
    expect(w).toHaveLength(20);
    expect(histogram(w, 8).reduce((a, b) => a + b, 0)).toBe(20);
  });
  it('a DDR4-3200 row hit is tCAS 13.75 ns from dram/timing.ts, tens of thousands of times quicker than the mean wait', () => {
    expect(ROW_HIT_S).toBeCloseTo(13.75e-9, 15);
    expect(dramRatio()).toBeCloseTo(576e-6 / 13.75e-9, 3);
    expect(dramRatio()).toBeGreaterThan(40000);
    expect(dramRatio()).toBeLessThan(43000);
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
    expect(mercuryAnchors(t, 2).some((a) => a.text.startsWith('backing'))).toBe(true);
    expect(mercuryAnchors(t, 2, true).map((a) => a.text).sort()).toEqual(['gate', 'sending crystal']);
  });
  it('pulses are one slot pitch apart in the drawing', () => {
    const t = new Tank();
    expect(Math.abs(t.pos(5) - t.pos(6))).toBeCloseTo(1, 9);
  });
});
