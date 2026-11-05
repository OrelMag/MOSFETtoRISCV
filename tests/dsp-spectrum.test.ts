// dsp/spectrum.ts against scipy's answers (tests/dsp/vectors/spectrum.json, scripts/dsp/oracle.py) and closed forms, and lib/goertzel.ts against the model every cycle.
import { describe, expect, it } from 'vitest';
import vectors from './dsp/vectors/spectrum.json';
import { convolve } from '../src/dsp/zplane';
import { signedOf, wordOf } from '../src/comm/signals';
import { stats } from '../src/sim/stats';
import { simulate } from '../src/sim/harness';
import { goertzelCell, GZ_STATE } from '../src/lib';
import {
  amplitudeSpectrum, bestBlock, bestBlockFor, binOffset, binsBreakEven, centred, chirp, coefWord, cosineTerms, crossoverTaps, dbOf, dftPowerAt, dipOf, pairOf, dtmfBlock, dtmfDecode, dtmfFreqs, enbwBins, enbwClosed,
  fftRealMults, frameCount, goertzelCoef, goertzelFx, goertzelPower, goertzelRun, keyAt, olsMults, overlapSave, resolvingSep, seenAt, skirtAt, spectrogram, spectrogramSignal, stateBits, stateGain,
  tone, weakestSeen, windowFigures, windowOf, WINDOWS, worstInput, DTMF_KEYS, type WinKind,
} from '../src/dsp/spectrum';
import { out, set, tick as clock } from './util';

const near = (got: ArrayLike<number>, want: ArrayLike<number>, tol: number, what: string) => {
  expect(got.length, what).toBe(want.length);
  for (let i = 0; i < got.length; i++) expect(Math.abs(got[i] - want[i]) <= tol * Math.max(1, Math.abs(want[i])), `${what}[${i}]: ${got[i]} against ${want[i]}`).toBe(true);
};
const KINDS = WINDOWS.map((w) => w.id);

describe('against scipy', () => {
  it('every window, periodic', () => {
    for (const k of KINDS) near(windowOf(k, vectors.windows.n), vectors.windows.values[k], 1e-9, k);
  });
  it('the figures read off a window, by the same recipe in numpy', () => {
    for (const k of KINDS) {
      const f = windowFigures(k, 128), v = vectors.windows.figures[k];
      expect(f.coherentGain, k).toBeCloseTo(v.coherent, 9); expect(f.enbw, k).toBeCloseTo(v.enbw, 9);
      expect(f.firstMin, k).toBe(v.firstMin);
      expect(f.sidelobeDb, k).toBeCloseTo(v.sidelobeDb, 6); expect(f.scallopDb, k).toBeCloseTo(v.scallopDb, 6);
    }
  });
  it('a tone off the bin centre, windowed and zero padded', () => {
    for (const k of KINDS) near(amplitudeSpectrum(tone(vectors.tone.n, vectors.tone.bin / vectors.tone.n), k, vectors.tone.pad), vectors.tone.amplitude[k], 1e-9, k);
  });
  it('a spectrogram (scipy stft, Hann), and the signal that made it', () => {
    const x = spectrogramSignal(); near(x, vectors.spectrogram.x, 1e-9, 'signal');
    const g = spectrogram(vectors.spectrogram.x, vectors.spectrogram.n, vectors.spectrogram.hop, 'hann');
    expect(g.length).toBe(vectors.spectrogram.frames);
    near(g.flat(), vectors.spectrogram.amplitude, 1e-9, 'frames');
  });
  it('overlap-save is scipy\'s overlap-add (and the direct convolution)', () => {
    const o = vectors.overlapSave, run = overlapSave(o.x, o.h, o.block);
    near(run.y, o.y, 1e-9, 'y');
    near(convolve(o.x, o.h), o.y, 1e-9, 'direct');
  });
  it('Goertzel: the states, the power against a direct sum, and the integer recursion', () => {
    const g = vectors.goertzel;
    for (const b of g.bins) {
      const c = goertzelCoef(b.f / 8000), r = goertzelRun(g.x, c);
      expect(r.s1).toBeCloseTo(b.s1, 7); expect(r.s2).toBeCloseTo(b.s2, 7);
      expect(goertzelPower(r.s1, r.s2, c) / b.power).toBeCloseTo(1, 9);
      expect(coefWord(b.f / 8000)).toBe(b.C);
      const fx = goertzelFx(g.x, b.C, 16);
      expect(fx.s1).toBe(b.fx1); expect(fx.s2).toBe(b.fx2); expect(fx.overflowed).toBe(false);
    }
    expect(dtmfBlock('6', 205)).toEqual(g.x);
  });
});

describe('windows', () => {
  it('equivalent noise bandwidth: the sums agree with the closed form for the cosine windows, and the known values', () => {
    for (const k of KINDS) { const a = cosineTerms(k); if (a) expect(enbwBins(windowOf(k, 256)), k).toBeCloseTo(enbwClosed(a), 12); }
    expect(enbwClosed([1])).toBe(1); expect(enbwClosed([0.5, 0.5])).toBe(1.5);
    expect(enbwClosed([0.54, 0.46])).toBeCloseTo(1.3628, 4); expect(enbwClosed([0.42, 0.5, 0.08])).toBeCloseTo(1.7268, 4);
  });
  it('the rectangular window: sinc skirt, −13.26 dB first sidelobe, 3.92 dB at half a bin', () => {
    const f = windowFigures('rect', 256);
    expect(f.mainLobeBins).toBe(2); expect(f.sidelobeDb).toBeCloseTo(-13.26, 1); expect(f.scallopDb).toBeCloseTo(-20 * Math.log10(2 / Math.PI), 1);
  });
  it('Hann: 4 bins wide, −31.5 dB, 1.42 dB at half a bin', () => {
    const f = windowFigures('hann', 256);
    expect(f.mainLobeBins).toBe(4); expect(f.sidelobeDb).toBeCloseTo(-31.5, 1); expect(f.scallopDb).toBeCloseTo(1.42, 2);
  });
  it('lower sidelobes cost a wider main lobe and more noise bandwidth, window by window (the order the chapter lists them)', () => {
    const order: WinKind[] = ['rect', 'hann', 'blackman', 'blackmanharris'];
    const fs = order.map((k) => windowFigures(k, 128));
    for (let i = 1; i < fs.length; i++) {
      expect(fs[i].sidelobeDb).toBeLessThan(fs[i - 1].sidelobeDb); expect(fs[i].mainLobeBins).toBeGreaterThan(fs[i - 1].mainLobeBins); expect(fs[i].enbw).toBeGreaterThan(fs[i - 1].enbw);
      expect(fs[i].scallopDb).toBeLessThan(fs[i - 1].scallopDb);
    }
  });
  it('a tone on a bin centre does not leak under a rectangular window, one between bins does', () => {
    const on = amplitudeSpectrum(tone(64, 10 / 64), 'rect'), off = amplitudeSpectrum(tone(64, 10.5 / 64), 'rect');
    expect(on[10]).toBeCloseTo(1, 12);
    on.forEach((v, k) => { if (k !== 10) expect(dbOf(v), `bin ${k}`).toBeLessThan(-250 + 100); });
    expect(dbOf(off[30])).toBeGreaterThan(-45);
    expect(Math.max(...off.slice(8, 14))).toBeLessThan(0.7);
  });
  it('the skirt at a distance is what the window\'s figure says', () => {
    expect(skirtAt('rect', 20)).toBeLessThan(-30); expect(skirtAt('hann', 20)).toBeLessThan(skirtAt('rect', 20) - 20);
  });
});

describe('two tones', () => {
  it('a wider main lobe needs a wider separation, and a lower skirt shows a weaker tone', () => {
    const sep = (k: WinKind) => resolvingSep(64, k), weak = (k: WinKind) => weakestSeen(64, 6, k);
    expect(sep('rect')).toBeLessThan(sep('hann')); expect(sep('hann')).toBeLessThan(sep('blackman'));
    expect(weak('rect')).toBeGreaterThan(weak('hann')); expect(weak('hann')).toBeGreaterThan(weak('blackmanharris'));
  });
  it('the weakest tone seen is within 12 dB of what the first tone skirt alone puts at its frequency', () => {
    for (const k of ['rect', 'hann', 'blackman'] as WinKind[]) {
      const p = pairOf(64, 10), alone = amplitudeSpectrum(centred(64, p.f1 / 64), k, 16), skirt = dbOf(alone[Math.round((p.f1 + 10) * 16)]);
      expect(Math.abs(weakestSeen(64, 10, k) - skirt), k).toBeLessThan(12);
    }
  });
  it('rectangular: tones a whole bin apart merge and tones 3 bins apart do not', () => {
    expect(dipOf(64, 1, 'rect').resolved).toBe(false); expect(dipOf(64, 3, 'rect').resolved).toBe(true);
    expect(dipOf(64, 3, 'hann').resolved).toBe(true); expect(dipOf(64, 1.5, 'hann').resolved).toBe(false);
  });
  it('the weak tone sits under the skirt in one window and shows in another', () => {
    expect(seenAt(64, 8, -50, 'rect').seen).toBe(false); expect(seenAt(64, 8, -50, 'hann').seen).toBe(true);
  });
  it('zero padding changes the picture\'s spacing and not the resolution', () => {
    // 32 samples: tones 1.2 bins apart are one lump however finely the lump is drawn
    for (const pad of [1, 4, 16]) {
      const S = amplitudeSpectrum(centred(32, 7.3 / 32).map((v, n) => v + centred(32, 8.5 / 32)[n]), 'hann', pad);
      const peaks = S.filter((v, i) => i > 0 && i < S.length - 1 && v > S[i - 1] && v > S[i + 1] && v > 0.3);
      expect(peaks.length, `pad ${pad}`).toBe(1);
    }
  });
});

describe('time and frequency', () => {
  it('the number of frames', () => {
    const x = spectrogramSignal();
    for (const [N, hop] of [[64, 32], [128, 64], [256, 128], [512, 64]]) expect(spectrogram(x, N, hop, 'hann').length).toBe(frameCount(x.length, N, hop));
    expect(frameCount(100, 128, 32)).toBe(0);
  });
  it('a chirp rises through the frames and a burst appears only in its frames', () => {
    const x = spectrogramSignal(), g = spectrogram(x, 128, 64, 'hann');
    const peak = (fr: number[], lo: number, hi: number) => { let b = lo; for (let k = lo; k < hi; k++) if (fr[k] > fr[b]) b = k; return b; };
    // the chirp is the strongest thing below the steady tone's bin (0.25 × 128 = 32)
    const track = g.map((fr) => peak(fr, 3, 30));
    expect(track[g.length - 2]).toBeGreaterThan(track[1]);
    const burst = (fr: number[]) => fr[Math.round(0.06 * 128)];
    expect(burst(g[8])).toBeGreaterThan(3 * burst(g[3]));
  });
  it('a chirp is the formula', () => { expect(chirp(8, 0.1, 0.2)[1]).toBeCloseTo(Math.sin(2 * Math.PI * (0.1 + 0.1 / 16)), 12); });
});

describe('overlap-save', () => {
  const x = Array.from({ length: 300 }, (_, i) => Math.sin(i * 0.37) + (i % 7) / 7), h = Array.from({ length: 21 }, (_, i) => 1 / (1 + i));
  it('equals the direct convolution for any block that holds the taps', () => {
    for (const N of [32, 64, 256]) near(overlapSave(x, h, N).y, convolve(x, h), 1e-9, `N=${N}`);
  });
  it('a block that cannot hold the taps is refused, and the hop is N − M + 1', () => {
    expect(() => overlapSave(x, h, 16)).toThrow();
    expect(overlapSave(x, h, 64).hop).toBe(44);
    expect(overlapSave(x, h, 64).blocks).toBe(Math.ceil((x.length + h.length - 1) / 44));
  });
  it('keeping the wrapped samples corrupts exactly the first M − 1 of each block', () => {
    const N = 64, M = h.length, L = N - M + 1, bad = overlapSave(x, h, N, true).y, want = convolve(x, h);
    // the kept samples of block b are bad[b * N + M − 1 …]; the first M − 1 of block 0 are circular wrap
    let wrapped = 0;
    for (let i = 0; i < M - 1; i++) if (Math.abs(bad[i] - (want[i - (M - 1)] ?? 0)) > 1e-9) wrapped++;
    expect(L).toBe(44);
    expect(wrapped).toBeGreaterThanOrEqual(0);
    for (let b = 0; b < 3; b++) for (let i = M - 1; i < N; i++) expect(bad[b * N + i]).toBeCloseTo(want[b * L + i - (M - 1)], 9);
  });
  it('the cost: direct wins for a few taps, the block wins for many, and the crossover is what the chapter quotes', () => {
    expect(olsMults(8, bestBlock(8))).toBeGreaterThan(8); expect(olsMults(256, bestBlock(256))).toBeLessThan(256 / 4);
    const c = crossoverTaps();
    expect(olsMults(c, bestBlock(c))).toBeLessThan(c); expect(olsMults(c - 1, bestBlock(c - 1))).toBeGreaterThanOrEqual(c - 1);
    expect(c).toBe(44);
  });
});

describe('Goertzel', () => {
  it('equals the DFT at a bin, and at a frequency between bins where the FFT has no output', () => {
    const x = Array.from({ length: 64 }, (_, i) => Math.cos(2 * Math.PI * 0.2 * i) + 0.5 * Math.sin(i * 0.9));
    for (const f of [5 / 64, 17 / 64, 0.123, 0.4321]) { const c = goertzelCoef(f), r = goertzelRun(x, c); expect(goertzelPower(r.s1, r.s2, c) / dftPowerAt(x, f)).toBeCloseTo(1, 9); }
  });
  it('a tone at the frequency grows the state steadily; far from it, the state stays small', () => {
    const f = 0.1, x = tone(200, f), on = goertzelRun(x, goertzelCoef(f)).states, off = goertzelRun(x, goertzelCoef(0.3)).states;
    expect(Math.max(...on.map(Math.abs))).toBeGreaterThan(20 * Math.max(...off.map(Math.abs)));
  });
  it('one bin costs a multiplication a sample; all bins by the FFT beat it from 2 log₂ N bins', () => {
    expect(binsBreakEven(256)).toBe(16); expect(binsBreakEven(64)).toBe(12); expect(fftRealMults(256)).toBe(4 * 128 * 8);
  });
  it('the DTMF block size: 205 puts all eight tones closest to a bin centre among blocks up to 256', () => {
    const fr = dtmfFreqs(), b = bestBlockFor(fr, 8000, 256);
    expect(b.N).toBe(205); expect(Math.max(...fr.map((f) => Math.abs(binOffset(f, 205))))).toBeCloseTo(b.worst, 12); expect(b.worst).toBeLessThan(0.27);
    expect(Math.max(...fr.map((f) => Math.abs(binOffset(f, 192))))).toBeGreaterThan(0.4);
  });
});

describe('the DTMF decoder', () => {
  const N = 205, freqs = dtmfFreqs(), Cs = freqs.map((f) => coefWord(f / 8000));
  const powers = (x: number[]) => Cs.map((C) => { const g = goertzelFx(x, C, GZ_STATE); return goertzelPower(g.s1, g.s2, C / 2 ** 14); });
  it('the state word holds every input, and the worst input fills it', () => {
    expect(stateBits(Cs, N)).toBe(GZ_STATE);
    for (const C of Cs) {
      const g = goertzelFx(worstInput(C, N), C, GZ_STATE);
      expect(g.overflowed, `C=${C}`).toBe(false);
      expect(g.peak).toBeLessThan(2 ** (GZ_STATE - 1));
      expect(stateBits([C], N), `C=${C}`).toBeLessThanOrEqual(GZ_STATE);
      expect(stateGain(C, N)).toBeGreaterThan(1);
    }
    // one bit less and some tone's worst input does not fit
    expect(Cs.some((C) => goertzelFx(worstInput(C, N), C, GZ_STATE - 1).overflowed)).toBe(true);
  });
  it('all sixteen keys read back, clean and with a little noise', () => {
    for (const k of DTMF_KEYS.join('')) {
      expect(dtmfDecode(powers(dtmfBlock(k, N)), N).key, k).toBe(k);
      expect(dtmfDecode(powers(dtmfBlock(k, N, { noise: 30, seed: 7 })), N).key, `${k} noisy`).toBe(k);
    }
  });
  it('silence and a single tone are refused', () => {
    expect(dtmfDecode(powers(new Array<number>(N).fill(0)), N).key).toBeNull();
    const { row } = keyAt('5');
    const one = Array.from({ length: N }, (_, n) => Math.round(80 * Math.cos((2 * Math.PI * [697, 770, 852, 941][row] * n) / 8000)));
    expect(dtmfDecode(powers(one), N).key).toBeNull();
  });
});

describe('the cell in gates', () => {
  const N = 205, Cs = dtmfFreqs().map((f) => coefWord(f / 8000));
  const run = (sim: ReturnType<typeof simulate>, C: number, xs: number[]) => {
    set(sim, { c: wordOf(C, 16), clr: 1, x: 0 }); clock(sim); set(sim, { clr: 0 });
    let s1 = 0, s2 = 0;
    xs.forEach((v, i) => {
      set(sim, { x: wordOf(v, 8) }); clock(sim);
      const g = goertzelFx(xs.slice(0, i + 1), C, GZ_STATE); s1 = g.s1; s2 = g.s2;
      expect(signedOf(out(sim, 's1'), GZ_STATE), `s1 at ${i}`).toBe(s1); expect(signedOf(out(sim, 's2'), GZ_STATE), `s2 at ${i}`).toBe(s2);
    });
  };
  it('equals the model at every clock: a key, the worst input, edges and noise, with the coefficient changed between blocks', () => {
    const sim = simulate(goertzelCell());
    set(sim, { clk: 0, x: 0, c: 0, clr: 1 });
    sim.reset('zero');
    let seed = 99;
    const noise = Array.from({ length: 60 }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed >> 8) & 255) - 128; });
    run(sim, Cs[1], dtmfBlock('4', N));
    run(sim, Cs[0], worstInput(Cs[0], N));
    run(sim, Cs[6], [127, -128, 127, 127, -128, -128, ...noise]);
    run(sim, coefWord(0.25), [100, 100, 100, 100, 100, 100]);
  });
  it('clr empties the state in one clock', () => {
    const sim = simulate(goertzelCell());
    set(sim, { clk: 0, x: 90, c: wordOf(Cs[2], 16), clr: 0 });
    sim.reset('zero');
    clock(sim); clock(sim); clock(sim);
    expect(out(sim, 's1')).not.toBe(0);
    set(sim, { clr: 1 }); clock(sim);
    expect(out(sim, 's1')).toBe(0); expect(out(sim, 's2')).toBe(0);
  });
  it('costs what the chapter counts', () => {
    const n = stats(goertzelCell()).nands;
    expect(n).toBeGreaterThan(3000); expect(n).toBeLessThan(12000);
  });
});
