// Chapter 51's typed numbers, pinned to what they describe; the computed ones come from the code.

import { describe, expect, it } from 'vitest';
import { chRouter } from '../src/chapters/ch-comm-router';
import { numOf } from '../src/chapters/order';
import { engineCycles, portsServed, wireCycles } from '../src/widgets/router';

describe('chapter 51 typed numbers', () => {
  it('comes after the chapter on computers on a network', () => { expect(chRouter.num).toBe(numOf('network') + 1); });
  it('a minimum frame at 400 Gb/s, with preamble and gap, every 1.68 ns', () => {
    expect(((60 + 4 + 8 + 12) * 8) / 400).toBeCloseTo(1.68, 2);
  });
  it('the header\'s share: 1.3 % of 1500 bytes, and 20 of a minimum frame\'s 46', () => {
    expect((20 / 1500) * 100).toBeCloseTo(1.33, 1);
  });
  it('the engine: cycles and ports', () => {
    expect(engineCycles(60, 33)).toBe(60 + 1 + 33 + 1 + 60);
    expect(wireCycles(60)).toBe(84 * 32);
    expect(portsServed(60, 33)).toBe(17);
    // ports fall as the frame grows: the step's try says so
    let last = Infinity;
    for (let n = 60; n <= 1514; n += 2) { const p = portsServed(n, 25); expect(p).toBeLessThanOrEqual(last); last = p; }
  });
  it('the slow path is port 3 in the prose', () => {
    const text = chRouter.steps.map((s) => s.body).join(' ');
    expect(text).toContain('port 3');
  });
});
