// The DSP core's ISA, assembler and golden model: the five benchmarks against the oracle's answers (exact integers, and scipy within a few LSB).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assemble24 } from '../src/dsp/asm24';
import { Iss24 } from '../src/dsp/iss24';
import { BENCH24 } from '../src/dsp/programs24';

const V = JSON.parse(readFileSync('tests/dsp/vectors/dspcore.json', 'utf8'));
const build = (id: string) => {
  const b = BENCH24.find((x) => x.id === id)!;
  const a = assemble24(b.src);
  expect(a.errors, id).toEqual([]);
  const iss = new Iss24(a.words, b.x, b.y);
  iss.run();
  return { b, a, iss };
};
const s16 = (v: number) => (v << 16) >> 16;

describe('the benchmarks on the golden model', () => {
  for (const id of ['fir16', 'fir64']) {
    it(`${id}: exact integers, scipy within 1 LSB`, () => {
      const { iss } = build(id);
      expect(iss.halted).toBe(true);
      expect(iss.out.map(s16)).toEqual(V[id].y);
      iss.out.forEach((v, i) => expect(Math.abs(s16(v) - V[id].scipy[i])).toBeLessThanOrEqual(1));
    });
  }
  it('biquad cascade: exact, scipy within 24 LSB', () => {
    const { iss } = build('biquad');
    expect(iss.out.map(s16)).toEqual(V.biquad.y);
    iss.out.forEach((v, i) => expect(Math.abs(s16(v) - V.biquad.scipy[i])).toBeLessThanOrEqual(24));
  });
  it('dot product: the 40-bit accumulator, then two roundings', () => {
    const { iss } = build('dot');
    expect(Number(iss.acc)).toBe(V.dot.acc);
    expect(iss.out.map(s16)).toEqual([V.dot.out15, V.dot.out13]);
    expect(V.dot.scipy).toBe(V.dot.acc);
  });
  it('FFT: bit for bit as the fixed-point reference, scipy within 8 LSB', () => {
    const { iss } = build('fft');
    const o = iss.out.map(s16);
    expect(o.slice(0, 64)).toEqual(V.fft.yre);
    expect(o.slice(64)).toEqual(V.fft.yim);
    o.forEach((v, i) => expect(Math.abs(v - (i < 64 ? V.fft.scipyRe[i] : V.fft.scipyIm[i - 64]))).toBeLessThanOrEqual(8));
  });
});
