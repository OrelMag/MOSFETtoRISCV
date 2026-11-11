import { describe, expect, it } from 'vitest';
import { adderBench, cornerVectors, exhaustiveCount, exhaustiveVectors, randomVectors, reference, yearsAt } from '../src/widgets/adderproof';

describe('chapter 6: how do you know an adder is right', () => {
  it('the reference is the language’s +, wrapped to n bits', () => {
    expect(reference(4, [9, 7, 0])).toEqual({ s: 0, cout: 1 });
    expect(reference(32, [0xffffffff, 1, 0])).toEqual({ s: 0, cout: 1 });
    expect(reference(8, [100, 27, 1])).toEqual({ s: 128, cout: 0 });
  });
  it('counts the step quotes', () => {
    expect([4, 8, 16, 32].map(exhaustiveCount)).toEqual([512, 131072, 8589934592, 2 ** 65]);
    expect(Math.round(yearsAt(32))).toBe(1169); // at a billion vectors a second
    expect(cornerVectors(32).length).toBe(98);
  });
  it('exhaustive: 4 bits and 8 bits are right, every case', () => {
    expect(adderBench(4).run(exhaustiveVectors(4))).toEqual({ checked: 512 });
    expect(adderBench(8).run(exhaustiveVectors(8))).toEqual({ checked: 131072 });
  });
  it('32 bits: the corner cases and 100 000 random vectors agree with +', () => {
    const b = adderBench(32);
    expect(b.run(cornerVectors(32))).toEqual({ checked: 98 });
    expect(b.run(randomVectors(32, 100000))).toEqual({ checked: 100000 });
  });
  it('the corner cases hold a carry through every column and a signed overflow', () => {
    const vs = cornerVectors(32);
    expect(vs.some(([a, b, c]) => c === 1 && (a ^ b) >>> 0 === 0xffffffff)).toBe(true);
    expect(vs.some(([a, b]) => a === 2 ** 31 - 1 && b === 1)).toBe(true);
  });
  it('a stuck carry is caught, in the numbers the step quotes', () => {
    const quote: Record<string, number | undefined> = {};
    for (const [name, k] of [['low', 2], ['top', 31]] as const) {
      const b = adderBench(32, k);
      const c = b.run(cornerVectors(32)), r = b.run(randomVectors(32, 100000));
      expect(c.bad && r.bad).toBeTruthy();
      quote[`${name}-corner`] = c.checked;
      quote[`${name}-random`] = r.checked;
    }
    expect(quote).toEqual({ 'low-corner': 5, 'low-random': 1, 'top-corner': 5, 'top-random': 6 });
  });
});

import { CATCH } from '../src/widgets/adderproof';
it('the try-it box quotes these', () => { expect(CATCH).toEqual({ corner: 6, random: 7 }); });
