import { describe, expect, it } from 'vitest';
import { chapterById } from '../src/chapters';
import { VDD_VOLTS, VT_VOLTS, weakTag, WEAK_H } from '../src/sim/switchsim';

// Chapter 1 teaches a 1.8 V / 0.45 V device; the switch-level model (and chapter 2's weak levels) use an illustrative
// 1.1 V / 0.3 V. The chapter says so, with the model's own numbers, so the two stories cannot drift apart silently.
describe('chapter 2 weak levels prose', () => {
  it('names the model\'s supply and threshold, and does not promise a 1.8 V swing', () => {
    const ch = chapterById('inverter')!;
    const weak = ch.steps.find((s) => s.title === 'The wrong way round: weak levels')!;
    expect(weak.body).toContain(`${VDD_VOLTS} V supply`);
    expect(weak.body).toContain(`V<sub>t</sub> = ${VT_VOLTS} V`);
    expect(weak.body).toContain(`${(VDD_VOLTS - VT_VOLTS).toFixed(2)} V`);
    expect(weakTag(WEAK_H)).toBe(`H · ${(VDD_VOLTS - VT_VOLTS).toFixed(2)} V`);
    expect(ch.steps.map((s) => s.body).join('')).not.toContain('1.8 V swing');
  });
});
