// Speech: μ-law against G.711's tables and against audioop on every 14-bit sample, IMA ADPCM against audioop on the real voice and on a clipping square wave, LPC against solve_toeplitz.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adpcmDecode, adpcmEncode, lpc, packNibbles, ulawDecision, ulawDecode, ulawEncode, ulawQuantized, sineSnr, uniform } from '../src/dsp/speech';
import { ulawDecoder, ulawEncoder, ulawLine } from '../src/lib/ulaw';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import V from './dsp/vectors/speech.json';

/** A 16-bit mono WAV's samples, as the site's loader reads them. */
export function wavSamples(path: string): { rate: number; x: number[] } {
  const b = readFileSync(path);
  return { rate: b.readUInt32LE(24), x: Array.from({ length: (b.length - 44) / 2 }, (_, i) => b.readInt16LE(44 + 2 * i)) };
}

describe('μ-law, G.711', () => {
  it('the decision and quantized values Tables 2a and 2b print', () => {
    // column 5 at each segment end, and the virtual x₁₂₈
    expect([0, 1, 16, 32, 48, 64, 80, 96, 112, 127, 128].map(ulawDecision)).toEqual([0, 1, 31, 95, 223, 479, 991, 2015, 4063, 7903, 8159]);
    // column 7 beside each printed character signal
    const rows: [string, number][] = [['10000000', 8031], ['10001111', 4191], ['10011111', 2079], ['10101111', 1023], ['10111111', 495], ['11001111', 231], ['11011111', 99], ['11101111', 33], ['11111110', 2], ['11111111', 0],
      ['01111111', 0], ['01111110', -2], ['01101111', -33], ['01011111', -99], ['01001111', -231], ['00111111', -495], ['00101111', -1023], ['00011111', -2079], ['00001111', -4191], ['00000001', -7775], ['00000000', -8031]];
    for (const [bits, y] of rows) expect([bits, ulawDecode(parseInt(bits, 2))]).toEqual([bits, y]);
    for (let n = 1; n < 128; n++) expect(ulawQuantized(n)).toBe(ulawDecode(255 - n));
  });
  it('every sample strictly between two decision values gets the code the tables give, both signs', () => {
    for (let n = 0; n < 128; n++) {
      const lo = ulawDecision(n), hi = n === 127 ? 8159 : ulawDecision(n + 1);
      for (let x = lo + 1; x < hi; x++) { expect(ulawEncode(x)).toBe(255 - n); expect(ulawEncode(-x)).toBe(127 - n); }
    }
  });
  it('equals audioop on all 16 384 samples and all 256 codes', () => {
    for (let x = -8192; x < 8192; x++) if (ulawEncode(x) !== V.ulaw[x + 8192]) expect([x, ulawEncode(x)]).toEqual([x, V.ulaw[x + 8192]]);
    for (let c = 0; c < 256; c++) expect([c, ulawDecode(c)]).toEqual([c, V.ulaw2lin[c]]);
  });
  it('keeps a roughly constant SNR over 40 dB of level, where 8 uniform bits fall away', () => {
    const mu = (v: number) => ulawDecode(ulawEncode(v)), u8 = uniform(8);
    const at = (p: number) => [sineSnr(p, mu), sineSnr(p, u8)];
    const [mLoud, uLoud] = at(8000), [mQuiet, uQuiet] = at(80);
    expect(Math.abs(mLoud - mQuiet)).toBeLessThan(10);
    expect(uLoud - uQuiet).toBeGreaterThan(35);
    expect(mQuiet).toBeGreaterThan(uQuiet + 15);
  });
});

describe('IMA ADPCM', () => {
  it('equals audioop on the voice, codes, nibble order, the state at the split, and the decode', () => {
    const s = { pred: 0, index: 0 }, codes = adpcmEncode(V.adpcm.x.slice(0, 2000), s);
    expect([s.pred, s.index]).toEqual(V.adpcm.state_mid);
    codes.push(...adpcmEncode(V.adpcm.x.slice(2000), s));
    expect([s.pred, s.index]).toEqual(V.adpcm.state_end);
    expect(packNibbles(codes)).toEqual(V.adpcm.bytes);
    const d = { pred: 0, index: 0 };
    expect(adpcmDecode(codes, d)).toEqual(V.adpcm.decoded);
    expect([d.pred, d.index]).toEqual(V.adpcm.decoder_state);
  });
  it('and on a full-scale square wave, which clips the prediction and holds the step at its ceiling', () => {
    const s = { pred: 0, index: 0 }, codes = adpcmEncode(V.square.x, s);
    expect(packNibbles(codes)).toEqual(V.square.bytes);
    expect([s.pred, s.index]).toEqual(V.square.state);
    expect(adpcmDecode(codes)).toEqual(V.square.decoded);
  });
  it('reads the same voice the page plays', () => {
    const w = wavSamples('public/dsp/voice-8k.wav');
    expect(w.rate).toBe(8000);
    expect(w.x.slice(0, V.adpcm.x.length)).toEqual(V.adpcm.x);
  });
});

describe('linear prediction', () => {
  it('Levinson on the voice\'s frames equals solve_toeplitz', () => {
    const w = wavSamples('public/dsp/voice-8k.wav');
    for (const f of V.lpc) lpc(w.x.slice(f.start, f.start + 240), 10).forEach((v, i) => expect(v).toBeCloseTo(f.a[i], 5));
  });
});

describe('μ-law in gates', () => {
  it('the encoder equals the model on all 16 384 samples, and the decoder on all 256 codes', () => {
    const se = new BitSim(flatten(ulawEncoder()));
    for (let x0 = -8192; x0 < 8192; x0 += 32) {
      se.setInput('x', Array.from({ length: 32 }, (_, l) => (x0 + l + 16384) % 16384)); se.settle();
      const g = se.get('code');
      for (let l = 0; l < 32; l++) if (g[l] !== ulawEncode(x0 + l)) expect([x0 + l, g[l]]).toEqual([x0 + l, ulawEncode(x0 + l)]);
    }
    const sd = new BitSim(flatten(ulawDecoder()));
    for (let c0 = 0; c0 < 256; c0 += 32) {
      sd.setInput('code', Array.from({ length: 32 }, (_, l) => c0 + l)); sd.settle();
      const g = sd.get('y');
      for (let l = 0; l < 32; l++) { const y = g[l] >= 8192 ? g[l] - 16384 : g[l]; if (y !== ulawDecode(c0 + l)) expect([c0 + l, y]).toEqual([c0 + l, ulawDecode(c0 + l)]); }
    }
  });
  it('draws with no wire on another, no symbol on another, no label over a part', () => {
    for (const d of [ulawLine(), ulawEncoder(), ulawDecoder(), ...netlistOf(ulawEncoder())!.instances.map((i) => i.def).filter((d) => d.id === 'ulaw_mag')]) {
      const nl = netlistOf(d)!;
      expect([d.id, wireOverlaps(routeNetlist(d, nl).nets)]).toEqual([d.id, []]);
      expect([d.id, labelOverlaps(d, nl)]).toEqual([d.id, []]);
      expect([d.id, symbolOverlaps(nl)]).toEqual([d.id, []]);
    }
  });
});
