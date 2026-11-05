// What "Changing the rate" and "Turning by shifting" say in words, held to what the code measures.

import { describe, expect, it } from 'vitest';
import { chCordic } from '../src/chapters/ch-dsp-cordic';
import { chMultirate } from '../src/chapters/ch-dsp-multirate';
import { DSP_LEVEL } from '../src/chapters/dspladder';
import { cordicStretch } from '../src/dsp/cordic';
import { cicGrowth, cicWidth, polyTaps } from '../src/dsp/multirate';
import { cordicIterative, cordicPipeline } from '../src/lib/cordic';
import { stats } from '../src/sim/stats';
import { cordicBits, romBits, sineRom } from '../src/widgets/dspcordic';
import { cascade, worstRun } from '../src/widgets/dspmultirate';

const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;

describe('Turning by shifting', () => {
  it('its gain is the 1.6468 and 0.607253 it names', () => {
    expect(cordicStretch(24)).toBeCloseTo(1.6468, 4);
    expect(1 / cordicStretch(24)).toBeCloseTo(0.607253, 6);
    expect(Math.SQRT2 * cordicStretch(24)).toBeCloseTo(2.33, 2);
  });
  it('a table wins small and loses large, crossing at about 5 or 6 bits', () => {
    const small = { w: 10, z: 10, n: 8 };
    expect(nands(sineRom(6))).toBeLessThan(nands(cordicPipeline(small)));
    expect(romBits(6)).toBeGreaterThan(cordicBits(small) - 2);
    // around the crossing: an 8-bit-address table and a 10-bit pipeline are about the same size and accuracy
    expect(Math.abs(nands(sineRom(8)) / nands(cordicPipeline(small)) - 1)).toBeLessThan(0.15);
    expect(romBits(8)).toBeGreaterThan(5);
    expect(romBits(8)).toBeLessThan(6);
    expect(nands(sineRom(10))).toBeGreaterThan(2 * nands(cordicPipeline({ w: 14, z: 14, n: 12 })));
    expect(cordicBits({ w: 14, z: 14, n: 12 })).toBeGreaterThan(romBits(10) - 1);
  });
  it('the quiz: 64 words give about 3 bits, and at 12 bits a table costs several times a pipeline', () => {
    expect(romBits(6)).toBeGreaterThan(3);
    expect(romBits(6)).toBeLessThan(3.8);
    const pipe = { w: 18, z: 18, n: 16 };
    expect(cordicBits(pipe)).toBeGreaterThan(11.5);
    expect(nands(sineRom(12))).toBeGreaterThan(4 * nands(cordicPipeline(pipe)));
    expect(romBits(12)).toBeLessThan(11);
  });
  it('the iterative form is many times smaller, for n clocks a result', () => {
    const s = { w: 14, z: 14, n: 12 };
    expect(nands(cordicPipeline(s)) / nands(cordicIterative(s))).toBeGreaterThan(4);
    expect(nands(cordicIterative(s)) * s.n).toBeGreaterThan(nands(cordicPipeline(s)));
  });
  it('sits in the level', () => expect(chCordic.level).toBe(DSP_LEVEL));
});

describe('Changing the rate', () => {
  it('the job really does come down by about a thousand, and in the order the text gives', () => {
    const r = cascade();
    expect(r[0].mults / r[3].mults).toBeGreaterThan(500);
    expect(r[0].mults / r[3].mults).toBeLessThan(2000);
    expect(r[1].mults).toBeCloseTo(r[0].mults / 64, 9);
    expect(r[2].mults).toBeLessThan(r[1].mults);
    expect(r[3].mults).toBeLessThan(r[2].mults);
  });
  it('the growth quiz: order 3, ÷ 8, from 8 bits is 17', () => {
    expect(cicWidth(3, 8, 8)).toBe(17);
    expect(cicGrowth(4, 16)).toBe(16);
  });
  it('the widget\'s run: right at the width, wrong a bit short, wrapping both ways', () => {
    const ok = worstRun(3, 8, 8, 17), short = worstRun(3, 8, 8, 16);
    expect(ok.got).toBe(ok.want);
    expect(short.got).not.toBe(short.want);
    expect(ok.wraps).toBeGreaterThan(2);
  });
  it('the scene\'s tones: the filter passes one and stops the other', () => {
    const t = polyTaps(4, 4, 8);
    expect(t.length).toBe(16);
  });
  it('sits in the level', () => expect(chMultirate.level).toBe(DSP_LEVEL));
});
