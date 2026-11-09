// Chapter 42's typed numbers: the figures the prose and the quizzes state by hand are pinned here to the models and
// circuits they describe (the computed ones come from the code and need no pin).

import { numOf } from '../src/chapters/order';
import { describe, expect, it } from 'vitest';
import { RATIOS } from '../src/comm/asyncfifo';
import { readings, worstError } from '../src/comm/graybus';
import { chClocks } from '../src/chapters/ch-comm-clocks';
import { chapterById } from '../src/chapters';
import { asyncFifo, INV_CMOS, SCHMITT, syncN } from '../src/lib';
import { metrics } from '../src/phys/inverter';
import { KEEPER, thresholds } from '../src/phys/schmitt';
import { TAU_PS } from '../src/phys/metastable';
import { stats } from '../src/sim/stats';

describe('chapter 42 typed numbers', () => {
  it('follows the wire chapter, nine steps, and builds on earlier chapters', () => {
    expect(chClocks.num).toBe(numOf('clocks'));
    expect(chClocks.steps).toHaveLength(9);
    expect(chapterById('clocks')).toBe(chClocks);
    for (const id of chClocks.builds ?? []) expect(chapterById(id)!.num).toBeLessThan(chClocks.num);
    expect(chapterById('latches')!.num).toBe(8);
    expect(chapterById('wire')!.num).toBe(numOf('clocks') - 1);
  });
  it('step 1: the 0.5 V spike is inside the noise margin', () => {
    const m = metrics(1);
    expect(0.5).toBeLessThan(m.nmH);
    expect(m.voh - 0.5).toBeGreaterThan(m.vih);
  });
  it('step 2: six transistors, two more than a buffer of two inverters; the keeper is strength 2 against 3', () => {
    expect(stats(SCHMITT).transistors).toBe(6);
    expect(2 * stats(INV_CMOS).transistors).toBe(4);
    const inst = Object.fromEntries(SCHMITT.netlist!().instances.map((i) => [i.name, i.def]));
    expect(inst.pk.strength).toBe(2);
    expect(inst.nk.strength).toBe(2);
  });
  it('step 3: 0.4 V of noise is larger than the hysteresis at the default keeper', () => {
    expect(0.4).toBeGreaterThan(thresholds(KEEPER).width!);
  });
  it('step 4: two 200 MHz crystals 40 ppm apart slip a period in 125 microseconds', () => {
    expect(1 / (40e-6 * 200e6)).toBeCloseTo(125e-6, 12);
  });
  it('step 5: a period is e-foldings of tau: the third flop multiplies by 10^43 at 1 GHz', () => {
    expect(Math.round(1e3 / TAU_PS / Math.LN10)).toBe(43);
  });
  it('step 6: the synchronizer is two flops and delivers after two edges (tests/comm-sync.test.ts)', () => {
    expect(syncN(2).netlist!().instances.filter((i) => i.name.startsWith('f'))).toHaveLength(2);
  });
  it('step 8: 0111 to 1000 can read sixteen words, one of them 1111, 7 away from the nearest meant value', () => {
    expect(readings(0b0111, 0b1000)).toHaveLength(16);
    expect(readings(0b0111, 0b1000)).toContain(0b1111);
    expect(0b1111 - 0b1000).toBe(7);
    expect(worstError(0b0111, 0b1000)).toBe(8);
  });
  it('step 9: four words, 3-bit pointers, seven clock ratios', () => {
    const nl = asyncFifo(2, 8).netlist!();
    expect(nl.instances.filter((i) => /^w\d$/.test(i.name))).toHaveLength(4);
    expect(nl.instances.find((i) => i.name === 'rs')!.def.ports.find((p) => p.name === 'q')!.width).toBe(3);
    expect(RATIOS).toHaveLength(7);
  });
  it('every step has either a scene or a widget, and four have a challenge that is a reach goal or a quiz', () => {
    for (const s of chClocks.steps) expect(!!s.scene !== !!s.widget).toBe(true);
    expect(chClocks.steps.every((s) => s.challenge)).toBe(true);
    expect(chClocks.recap!.check).toHaveLength(3);
  });
});
