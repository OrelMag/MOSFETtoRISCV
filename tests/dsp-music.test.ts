// Music: the MDCT against scipy's DCT-IV through the folding identity, perfect reconstruction, and what the teaching codec does with its bits on the nocturne.

import { describe, expect, it } from 'vitest';
import { audibleShare, bands, bark, encodeMusic, mdct, MDCT_M, mdctRoundTrip, meanNmrDb, quietDb, sineWindow } from '../src/dsp/music';
import { snrDb } from '../src/dsp/speech';
import { wavSamples } from './dsp/wav';
import V from './dsp/vectors/music.json';

const music = () => wavSamples('public/dsp/nocturne-16k.wav').x.map((v) => v / 32768);

describe('the MDCT', () => {
  it('equals scipy\'s DCT-IV of the folded, windowed frame', () => {
    const x = wavSamples('public/dsp/nocturne-16k.wav').x;
    for (const f of V.frames) {
      const X = mdct(x.slice(f.start, f.start + 2 * V.M).map((v) => v / 32768), V.M);
      X.forEach((v, k) => expect(v).toBeCloseTo(f.X[k], 9));
    }
  });
  it('the sine window meets Princen–Bradley, and overlap-add gives the signal back to rounding', () => {
    const w = sineWindow(MDCT_M);
    for (let n = 0; n < MDCT_M; n++) expect(w[n] ** 2 + w[n + MDCT_M] ** 2).toBeCloseTo(1, 12);
    const x = music().slice(0, 20000), y = mdctRoundTrip(x);
    expect(Math.max(...y.map((v, i) => Math.abs(v - x[i])))).toBeLessThan(1e-12);
  });
  it('a frame of 2M samples gives M numbers, critically sampled', () => {
    expect(mdct(new Array(2 * MDCT_M).fill(0.1)).length).toBe(MDCT_M);
  });
});

describe('the masking model (simplified)', () => {
  it('Bark and the threshold in quiet behave as their formulas should', () => {
    expect(bark(1000)).toBeGreaterThan(8); expect(bark(1000)).toBeLessThan(9);
    expect(quietDb(3500)).toBeLessThan(quietDb(1000));
    expect(quietDb(100)).toBeGreaterThan(20);
  });
  it('at 16 kHz the 256 coefficients make about 20 bands, one critical band each', () => {
    const bs = bands(16000);
    expect(bs.length).toBeGreaterThanOrEqual(18); expect(bs.length).toBeLessThanOrEqual(22);
    expect(bs[0].lo).toBe(0); expect(bs.at(-1)!.hi).toBe(MDCT_M);
  });
});

describe('the codec (ours)', () => {
  const x = music().slice(0, 48000), budget = (kbps: number) => Math.round((kbps * 1000 * MDCT_M) / 16000);
  it('given 64 kb/s, by mask it stops early and leaves almost no band audible; by signal it spends it all and leaves many', () => {
    const m = encodeMusic(x, { fs: 16000, bitsPerFrame: budget(64), by: 'mask' }), s = encodeMusic(x, { fs: 16000, bitsPerFrame: budget(64), by: 'signal' });
    expect(m.bitRate).toBeLessThan(56000);
    expect(s.bitRate).toBeGreaterThan(60000);
    expect(audibleShare(m.frames)).toBeLessThan(0.02);
    expect(audibleShare(s.frames)).toBeGreaterThan(0.2);
    expect(snrDb(x, s.y)).toBeGreaterThan(snrDb(x, m.y) + 6);
    expect(meanNmrDb(m.frames)).toBeLessThan(0);
  });
  it('at 32 kb/s the mask still leaves fewer bands audible than the signal does', () => {
    const m = encodeMusic(x, { fs: 16000, bitsPerFrame: budget(32), by: 'mask' }), s = encodeMusic(x, { fs: 16000, bitsPerFrame: budget(32), by: 'signal' });
    expect(audibleShare(m.frames)).toBeLessThan(audibleShare(s.frames));
  });
});
