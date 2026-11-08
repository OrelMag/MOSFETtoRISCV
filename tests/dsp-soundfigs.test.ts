// The figures "Speech" and "Music" quote, recomputed from the recordings.

import { describe, expect, it } from 'vitest';
import { adpcmOnRv } from '../src/dsp/adpcmrv';
import { audibleShare, encodeMusic, MDCT_M, meanNmrDb } from '../src/dsp/music';
import { LPC_OPEN_FRAME, MUSIC_FIGS, SPEECH_FIGS } from '../src/dsp/soundfigs';
import { adpcmDecode, adpcmEncode, lpc, predictionGainDb, snrDb, ulawDecode, ulawEncode, uniform, vocode } from '../src/dsp/speech';
import { wavSamples } from './dsp/wav';

describe('what the chapters quote', () => {
  it('speech', () => {
    const x = wavSamples('public/dsp/voice-8k.wav').x, s14 = x.map((v) => v >> 2), q = s14.map((v) => Math.round(v * 10 ** (-30 / 20)));
    const mu = (v: number) => ulawDecode(ulawEncode(v));
    expect(snrDb(s14, s14.map(mu))).toBeCloseTo(SPEECH_FIGS.muSnr, 1);
    expect(snrDb(s14, s14.map(uniform(8)))).toBeCloseTo(SPEECH_FIGS.uniform8Snr, 1);
    expect(snrDb(q, q.map(mu))).toBeCloseTo(SPEECH_FIGS.quietMuSnr, 1);
    expect(snrDb(q, q.map(uniform(8)))).toBeCloseTo(SPEECH_FIGS.quietUniform8Snr, 1);
    expect(snrDb(x, adpcmDecode(adpcmEncode(x)))).toBeCloseTo(SPEECH_FIGS.adpcmSnr, 1);
    expect(adpcmOnRv(x.slice(0, 8000)).perSample).toBeCloseTo(SPEECH_FIGS.rvPerSample, 1);
    let g = 0, n = 0;
    for (let at = 0; at + 240 <= x.length; at += 180) { const f = x.slice(at, at + 240).map((v, i, a) => v - 0.9375 * (a[i - 1] ?? 0)); if (f.reduce((s, v) => s + v * v, 0) > 240 * 300 ** 2) { g += predictionGainDb(f, lpc(f, 10)); n++; } }
    expect(g / n).toBeCloseTo(SPEECH_FIGS.predGain, 1);
    const o = x.slice(LPC_OPEN_FRAME * 180, LPC_OPEN_FRAME * 180 + 240).map((v, i, a) => v - 0.9375 * (a[i - 1] ?? 0));
    expect(predictionGainDb(o, lpc(o, 10))).toBeCloseTo(SPEECH_FIGS.openGain, 1);
    const v = vocode(x), lags = v.frames.filter((f) => f.voiced).map((f) => f.lag).sort((a, b) => a - b);
    expect(Math.round((100 * v.voiced) / v.frames.length)).toBe(SPEECH_FIGS.voicedPct);
    expect(Math.round(8000 / lags[lags.length >> 1])).toBe(SPEECH_FIGS.pitchHz);
  });
  it('music', () => {
    const m = wavSamples('public/dsp/nocturne-16k.wav').x.map((v) => v / 32768), F = MUSIC_FIGS as Record<string, number>;
    for (const k of [64, 32, 16]) for (const by of ['mask', 'signal'] as const) {
      const r = encodeMusic(m, { fs: 16000, bitsPerFrame: Math.round((k * 1000 * MDCT_M) / 16000), by });
      expect([by, k, Math.round(r.bitRate / 100) / 10]).toEqual([by, k, F[`${by}${k}Rate`]]);
      expect([by, k, Math.round(1000 * audibleShare(r.frames)) / 10]).toEqual([by, k, F[`${by}${k}Audible`]]);
      expect(snrDb(m, r.y)).toBeCloseTo(F[`${by}${k}Snr`], 1);
      expect(meanNmrDb(r.frames)).toBeCloseTo(F[`${by}${k}Nmr`], 1);
    }
  }, 120_000);
});
