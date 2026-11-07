// The echo figures "Filters that learn" quotes, recomputed from the voice.

import { describe, expect, it } from 'vitest';
import { peakEnergy, runEcho } from '../src/dsp/adaptive';
import { ECHO_FIGS as F, ECHO_RUN, ROOM_NOISE, TALK, voiceEcho } from '../src/dsp/echofigs';
import { wavSamples } from './dsp/wav';

describe('the echo canceller on the voice', () => {
  const { x, near } = voiceEcho(wavSamples('public/dsp/voice-8k.wav').x);
  const run = (o: object) => runEcho({ n: ECHO_RUN, seed: 3, taps: 128, mu: 0.5, normalized: true, x, near, noise: ROOM_NOISE, ...o } as Parameters<typeof runEcho>[0]).erle;
  const ok = (v: number) => (Number.isFinite(v) ? v : -Infinity);
  it('what NLMS reaches, and with a filter too short for the path', () => {
    expect(run({})).toBeCloseTo(F.erle, 1);
    expect(run({ taps: 32 })).toBeCloseTo(F.erle32, 1);
  });
  it('near-end talk, learning on and held', () => {
    expect(run({ talkFrom: TALK.from, talkTo: TALK.to })).toBeCloseTo(F.talkOn, 1);
    expect(run({ talkFrom: TALK.from, talkTo: TALK.to, freeze: true })).toBeCloseTo(F.talkHeld, 1);
  });
  it('plain LMS\'s limits, and where it actually breaks', () => {
    const mean = x.reduce((a, v) => a + v * v, 0) / x.length, top = 2 / peakEnergy(x, 128);
    expect(2 / (128 * mean)).toBeCloseTo(F.avgAllows, 2);
    expect(top).toBeCloseTo(F.loudestAllows, 3);
    expect(ok(run({ mu: F.stillConverges * top, normalized: false }))).toBeGreaterThan(20);
    expect(ok(run({ mu: F.diverges * top, normalized: false }))).toBeLessThan(-3);
  });
  it('the widget\'s default plain step holds at loudness 1.5 and diverges at 2, where NLMS still cancels', () => {
    const plain = 0.15 * 10 ** -0.3, at = (L: number, o: { mu: number; normalized: boolean }) => ok(runEcho({ n: ECHO_RUN, seed: 3, taps: 128, x: x.map((v) => v * L), near, noise: ROOM_NOISE, ...o }).erle);
    expect(at(1.5, { mu: plain, normalized: false })).toBeGreaterThan(20);
    expect(at(F.loudDiverges, { mu: plain, normalized: false })).toBeLessThan(-3);
    expect(at(F.loudDiverges, { mu: 0.5, normalized: true })).toBeGreaterThan(30);
  });
});
