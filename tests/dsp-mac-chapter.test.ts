// What "A MAC on the RV32" says in words, held to what the gates and the model measure.
import { describe, expect, it } from 'vitest';
import { chMac } from '../src/chapters/ch-dsp-mac';
import { DSP_LEVEL } from '../src/chapters/dspladder';
import { ACC_BITS, raccOf } from '../src/dsp/mac';
import { assemble } from '../src/riscv/asm';
import { alignRows, benchFig, FILTER_Y, filterSource, macDelta, machineCost, perProduct, timePerProduct, unitNands } from '../src/widgets/dspmac';
import { firstMismatch } from './verify/maclock';

describe('A MAC on the RV32', () => {
  it('sits in the level, with a why for every wrong option', () => {
    expect(chMac.level).toBe(DSP_LEVEL);
    const qs = [...chMac.recap!.check, ...chMac.steps.map((s) => s.challenge).filter((c) => c?.kind === 'quiz')] as { options: string[]; answer: number; why: string[] }[];
    for (const q of qs) { expect(q.why.length).toBe(q.options.length); q.why.forEach((w, i) => expect(w === '').toBe(i === q.answer)); }
  });
  it('step 1: software multiplication is about a hundred clocks a product, and RV32IM many times faster', () => {
    expect(perProduct('rv32i', 'fir64')).toBeGreaterThan(100);
    expect(perProduct('rv32i', 'fir64') / perProduct('rv32im', 'fir64')).toBeGreaterThan(10);
    // "the ratio hardly moves" between the 64-tap filter and the dot product
    const r = (b: 'fir64' | 'dot') => perProduct('rv32i', b) / perProduct('rv32im', b);
    expect(Math.abs(r('fir64') / r('dot') - 1)).toBeLessThan(0.15);
    expect(benchFig('rv32i', 'fir64').products).toBe(512);
  });
  it('step 2: the unit is about ten thousand NANDs, the core gains about that, and the clock only a little', () => {
    expect(unitNands()).toBeGreaterThan(9500); expect(unitNands()).toBeLessThan(10500);
    expect(macDelta().nands).toBeGreaterThan(unitNands()); expect(macDelta().nands).toBeLessThan(unitNands() * 1.15);
    expect(macDelta().period).toBeGreaterThan(0); expect(macDelta().period).toBeLessThan(8);
    expect(macDelta().period).toBe(machineCost('mac').period - machineCost('rv32i').period);
  });
  it('step 2\'s Try: 64 mac2 of full-scale operands, and 256 wrap 40 bits', () => {
    expect(ACC_BITS).toBe(40);
    expect(256n * 2n ** 31n).toBe(2n ** 39n);
  });
  it('step 4: the tie rounds up, and the 40-bit range', () => {
    expect(raccOf(-5n, 1).y).toBe(-2);
    expect(raccOf(2n ** 38n, 0).sat).toBe(true);
    expect(raccOf(-(2n ** 39n), 63).y).toBe(0);
  });
  it('step 5: the filter on the panel gives its answer on the gates, in lock step', async () => {
    const w = assemble(filterSource(), [], { mac: true }).words;
    const r = await firstMismatch(w);
    expect(r.mismatch).toBeNull();
    expect(r.iss.x[10] | 0).toBe(FILTER_Y);
    expect(FILTER_Y).not.toBe(0);
  }, 60000);
  it('step 6: mac is about RV32IM\'s mul, and mac2 is nearly twice as fast again', () => {
    const m = perProduct('mac', 'fir64'), im = perProduct('rv32im', 'fir64'), m2 = perProduct('mac2', 'fir64');
    expect(Math.abs(m / im - 1)).toBeLessThan(0.2);
    expect(m / m2).toBeGreaterThan(1.7); expect(m / m2).toBeLessThan(2.1);
  });
  it('step 7: unrolling helps, and the biquad is the exception', () => {
    expect(perProduct('mac2u', 'fir64')).toBeLessThan(perProduct('mac2', 'fir64'));
    expect(perProduct('mac2', 'biquad')).toBeGreaterThan(perProduct('mac', 'biquad'));
    // an even output leaves a half word empty only at the edges, an odd one at both ends
    const odd = alignRows(8, 1), even = alignRows(8, 0);
    expect(odd.filter((r) => r.taps[0] === null || r.taps[1] === null).length).toBe(2);
    expect(even.filter((r) => r.taps[0] === null || r.taps[1] === null).length).toBe(0);
  });
  it('step 8: mac2 unrolled is the quickest in NAND delays on the long filters', () => {
    for (const b of ['fir16', 'fir64', 'dot'] as const) for (const m of ['rv32i', 'rv32im', 'mac', 'mac2'] as const) expect(timePerProduct('mac2u', b), `${b} vs ${m}`).toBeLessThan(timePerProduct(m, b));
  });
});
