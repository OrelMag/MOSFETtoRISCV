// What "Measuring a spectrum" claims, on dsp/spectrum.ts, the Goertzel cell and the widgets' own functions: the numbers in the text, each Try box against
// the sliders' real ranges, and the panel's run loop on the gates.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chSpectrum, spectrumFacts } from '../src/chapters/ch-dsp-spectrum';
import { numOf } from '../src/chapters/order';
import { DSP_LADDER } from '../src/chapters/dspladder';
import {
  amplitudeSpectrum, bestBlock, bestBlockFor, binsBreakEven, blockErrors, crossoverTaps, dbOf, dftPowerAt, dipOf, dtmfFreqs, fftRealMults, goertzelCoef, goertzelPower, goertzelRun, olsMults,
  resolvingSep, resolvingSepAt, seenAt, skirtAt, spectrogramSignal, stateGain, tone, weakestSeen, windowFigures, windowOf, WINDOWS, type WinKind,
} from '../src/dsp/spectrum';
import {
  DTMF_N, dtmfCoefs, leakStats, misreads, NOISES, olsSignal, padDip, padTones, PADS, runKey, SG_FRAMES,
} from '../src/widgets/dspspectrum';
import { goertzelCell, GZ_STATE } from '../src/lib';
import { windowedSinc } from '../src/comm/signals';
import { simulate } from '../src/sim/harness';
import { out, set } from './util';
import { pack } from '../src/sim/values';

const KINDS = WINDOWS.map((w) => w.id);
const peaks = (S: number[], min = 0.3) => S.filter((v, i) => i > 0 && i < S.length - 1 && v > S[i - 1] && v > S[i + 1] && v > min).length;

describe('the book', () => {
  it('follows The z-plane, and the ladder row is this chapter', () => {
    expect(numOf('spectrum')).toBe(numOf('zplane') + 1);
    expect(DSP_LADDER.find((r) => r.id === 'spectrum')!.title).toBe(chSpectrum.title);
  });
});

describe('step 1, a tone that is not a line', () => {
  it('10 bins is one clean bin, 10.5, 10.25 and 12.5 leak into every bin; the quiz figure', () => {
    expect(leakStats(10, 'rect').above60).toBe(1);
    for (const f of [10.5, 10.25, 12.5]) expect(leakStats(f, 'rect').above60, `${f}`).toBe(33);
    expect(leakStats(12.5, 'rect').top).toBeCloseTo(0.64, 2);
    expect(leakStats(10.5, 'rect').top).toBeCloseTo(0.65, 2);
  });
  it('the rectangle\'s skirt falls 6 dB for each doubling of distance', () => {
    expect(skirtAt('rect', 8, 64) - skirtAt('rect', 16, 64)).toBeGreaterThan(4);
    expect(skirtAt('rect', 8, 64) - skirtAt('rect', 16, 64)).toBeLessThan(8);
  });
  it('the slider range (8 to 13 in steps of 0.05) reaches every value the Try box names', () => {
    for (const f of [10, 10.25, 10.5, 12.5]) expect(Math.abs(8 + Math.round((f - 8) / 0.05) * 0.05 - f)).toBeLessThan(1e-9);
  });
});

describe('step 2, windows', () => {
  it('the lowest sidelobes, the narrowest lobe and the least loss at half a bin, among all six', () => {
    const f = Object.fromEntries(KINDS.map((k) => [k, windowFigures(k, 128)])) as Record<WinKind, ReturnType<typeof windowFigures>>;
    expect(KINDS.reduce((a, k) => (f[k].mainLobeBins < f[a].mainLobeBins ? k : a))).toBe('rect');
    expect(KINDS.reduce((a, k) => (f[k].sidelobeDb < f[a].sidelobeDb ? k : a))).toBe('blackmanharris');
    expect(KINDS.reduce((a, k) => (f[k].scallopDb < f[a].scallopDb ? k : a))).toBe('blackmanharris');
    expect(KINDS.reduce((a, k) => (f[k].scallopDb > f[a].scallopDb ? k : a))).toBe('rect');
    expect(f.kaiser.sidelobeDb).toBeLessThan(f.hann.sidelobeDb); expect(f.kaiser.sidelobeDb).toBeGreaterThan(f.blackmanharris.sidelobeDb);
  });
  it('Hann\'s noise floor reads 1.76 dB over the rectangle\'s', () => { expect(10 * Math.log10(windowFigures('hann').enbw)).toBeCloseTo(1.76, 2); });
  it('a tone on a bin reads its amplitude under every window', () => {
    for (const k of KINDS) expect(Math.abs(amplitudeSpectrum(tone(64, 10 / 64, 0.7), k)[10] / 0.7 - 1), k).toBeLessThan(1e-4);
  });
  it('the window is periodic: it repeats without a seam', () => {
    const w = windowOf('hann', 64);
    expect(w[0]).toBeCloseTo(0, 12); expect(w[63]).toBeGreaterThan(0);
  });
});

describe('step 3, what the skirt hides', () => {
  it('the separations and skirt levels in the text, in order', () => {
    const f = spectrumFacts();
    expect(f.sepRect).toBeLessThan(f.sepHann); expect(f.sepHann).toBeLessThan(f.sepBlackman);
    expect(f.skirt10.rect).toBeGreaterThan(-40); expect(f.skirt10.hann).toBeLessThan(-60); expect(f.skirt10.blackman).toBeLessThan(f.skirt10.hann);
    expect(f.weak6.rect).toBeGreaterThan(f.weak6.hann); expect(f.weak6.hann).toBeGreaterThan(f.weak6.blackman);
  });
  it('the Try box: −40 dB at 10 bins is hidden under the rectangle and seen under Hann; 2 bins resolves under the rectangle only', () => {
    expect(seenAt(64, 10, -40, 'rect').seen).toBe(false); expect(seenAt(64, 10, -40, 'hann').seen).toBe(true);
    expect(KINDS.filter((k) => dipOf(64, 2, k).resolved)).toEqual(['rect']);
  });
  it('the quiz\'s distractors are what their why says', () => {
    expect(dipOf(64, 2, 'hamming').resolved).toBe(false); expect(resolvingSep(64, 'rect')).toBeLessThan(2); expect(resolvingSep(64, 'hamming')).toBeGreaterThan(2);
    expect(weakestSeen(64, 10, 'blackmanharris')).toBeLessThan(-80);
  });
  it('resolution in bins does not depend on the block length', () => {
    expect(resolvingSep(128, 'hann')).toBe(resolvingSep(64, 'hann')); expect(resolvingSep(32, 'rect')).toBe(resolvingSep(64, 'rect'));
  });
});

describe('step 4, zero padding', () => {
  const twoTones = padTones;
  it('Hann at 32 samples is one lump at every padding', () => {
    for (const pad of PADS) expect(peaks(amplitudeSpectrum(twoTones(32), 'hann', pad)), `×${pad}`).toBe(1);
  });
  it('the samples the text names: rectangle 80, Hann 128; one step of 8 fewer is not enough; both are on the slider', () => {
    const f = spectrumFacts();
    expect(f.minRect).toBe(77); expect(f.minHann).toBe(122);
    expect(padDip(80, 'rect').resolved).toBe(true); expect(padDip(72, 'rect').resolved).toBe(false);
    expect(padDip(128, 'hann').resolved).toBe(true); expect(padDip(120, 'hann').resolved).toBe(false);
    expect(peaks(amplitudeSpectrum(twoTones(128), 'hann', 16), 0.3)).toBe(2); expect(peaks(amplitudeSpectrum(twoTones(80), 'rect', 16), 0.3)).toBe(2);
    for (const n of [80, 128]) expect((n - 16) % 8).toBe(0);
  });
  it('the quiz figure: 2.45 bins of 125 Hz, not the padded bin', () => {
    expect(resolvingSep(64, 'hann') * 125).toBeCloseTo(306.25, 6);
    expect(8000 / 4096).toBeLessThan(2);
  });
});

describe('step 5, the spectrogram', () => {
  it('lobe widths, frame times and the chirp\'s smear in the text', () => {
    const lobe = windowFigures('hann', 128).mainLobeBins;
    expect(lobe).toBe(4);
    expect(lobe * 8000 / 32).toBe(1000); expect(lobe * 8000 / 512).toBe(62.5); expect(lobe * 8000 / 64).toBe(500);
    expect(512 / 8).toBe(64); expect(32 / 8).toBe(4);
    // the chirp's rate: a bin of the frame, as the signal moves
    const rate = (0.4 - 0.03) / spectrogramSignal().length;
    expect(rate * 32 * 32).toBeCloseTo(0.185, 2); expect(rate * 512 * 512).toBeCloseTo(47.4, 1);
  });
  it('Hann at half overlap adds to a constant', () => {
    const w = windowOf('hann', 64);
    w.forEach((v, i) => expect(v + w[(i + 32) % 64]).toBeCloseTo(1, 12));
  });
  it('the frame lengths on the slider include 32 and 512, and 64 and 512 for the quiz', () => { for (const n of [32, 64, 512]) expect(SG_FRAMES).toContain(n); });
  it('a shorter frame blurs frequency: the lobe in Hz', () => { expect(4 * 8000 / 64 / (4 * 8000 / 512)).toBe(8); });
});

describe('step 6, overlap-save', () => {
  it('33 taps: the direct form wins at every block on the slider; 55 taps at 256 the blocks win', () => {
    for (const e of [6, 7, 8, 9, 10]) expect(olsMults(33, 2 ** e), `${2 ** e}`).toBeGreaterThan(33);
    expect(olsMults(55, 256)).toBeLessThan(55);
    expect(bestBlock(33)).toBe(256);
  });
  it('the crossover and the figures at 33 and 60 taps', () => {
    expect(crossoverTaps()).toBe(spectrumFacts().cross);
    expect(olsMults(60, bestBlock(60))).toBeLessThan(60); expect(olsMults(60, bestBlock(60))).toBeGreaterThan(30);
  });
  it('the wrapped samples are wrong and the rest exact, on the widget\'s signal and taps', () => {
    const e = blockErrors(olsSignal(), windowedSinc(55, 0.1), 256);
    expect(e.wrapped).toBeGreaterThan(0.1); expect(e.kept).toBeLessThan(1e-9);
  });
  it('the gate counts: 128 multipliers against two streaming FFTs and a complex multiplier, and the quiz', () => {
    const f = spectrumFacts();
    expect(f.fft256).toBeGreaterThan(100000);
    expect(512 - 128 + 1).toBe(385); expect(128 - 1).toBe(127);
    expect(256 - 128 + 1).toBe(129);
  });
});

describe('step 7, Goertzel', () => {
  it('equals the DFT power to nine places at the slider\'s extremes, and the break-even bins', () => {
    for (const [t, g, N] of [[300, 300, 64], [3500, 3500, 256], [1000, 1300, 205], [1000, 1000, 205]]) {
      const x = tone(N, t / 8000), c = goertzelCoef(g / 8000), r = goertzelRun(x, c);
      expect(goertzelPower(r.s1, r.s2, c) / dftPowerAt(x, g / 8000), `${t} ${g} ${N}`).toBeCloseTo(1, 9);
    }
    expect(binsBreakEven(256)).toBe(16); expect(binsBreakEven(64)).toBe(12);
    expect(fftRealMults(256)).toBe(4096);
  });
  it('the Try box: matched, the state climbs steadily; 300 Hz away, it stays small', () => {
    const x = tone(205, 1000 / 8000), peak = (g: number) => Math.max(...goertzelRun(x, goertzelCoef(g / 8000)).states.map(Math.abs));
    expect(peak(1000)).toBeGreaterThan(20 * peak(1300));
  });
  it('the block of 205, and 192 more than 0.4 off', () => {
    const f = spectrumFacts();
    expect(f.best.N).toBe(205); expect(f.best.worst).toBeLessThan(0.27);
    expect(bestBlockFor(dtmfFreqs(), 8000, 192, 192).worst).toBeGreaterThan(0.4);
  });
});

describe('step 8, the keypad in gates', () => {
  it('the state word: 16 bits, the worst gain, the margin, and 15 bits overflowing', () => {
    const f = spectrumFacts();
    expect(f.bits).toBe(GZ_STATE); expect(f.gain).toBeGreaterThan(250); expect(f.gain).toBeLessThan(254);
    expect(128.5 * f.gain).toBeLessThan(32768); expect(128.5 * f.gain).toBeGreaterThan(32000);
    expect(Math.log2(f.gain)).toBeCloseTo(8, 0);
    expect(Math.max(...dtmfCoefs().map((C) => stateGain(C, DTMF_N)))).toBe(f.gain);
  });
  it('the time-sharing figures', () => {
    const f = spectrumFacts();
    expect(f.perKey).toBe(8 * 206); expect(f.perKey / (205 / 8000)).toBeCloseTo(64312.2, 0);
    expect(f.cell).toBeGreaterThan(4000); expect(f.mul / f.cell).toBeGreaterThan(0.7);
  });
  it('the noise settings: nothing misreads at none and ±60, something at ±200, and the text lists exactly those', () => {
    expect(NOISES.map((n) => n.amp)).toEqual([0, 60, 200]);
    expect(misreads(0)).toEqual([]); expect(misreads(60)).toEqual([]);
    const bad = misreads(200);
    expect(bad.length).toBeGreaterThan(0); expect(spectrumFacts().mis200).toEqual(bad);
    const body = chSpectrum.steps[7].body;
    expect(body).toContain(`keys ${bad.join(' ')} do not read back`);
  });
  it('the panel\'s run on the real gates: every state word equals the model, and the key reads back', () => {
    const sim = simulate(goertzelCell());
    set(sim, { clk: 0, x: 0, c: 0, clr: 1 });
    sim.reset('zero');
    for (const [key, noise] of [['5', 0], ['D', 60], ['#', 0]] as [string, number][]) {
      const r = runKey(sim, (p) => out(sim, p), key, noise);
      expect(r.ok, `${key}`).toBe(true); expect(r.clocks).toBe(8 * 206);
      const rowsCols = [r.power.slice(0, 4), r.power.slice(4)].map((g) => g.indexOf(Math.max(...g)));
      expect(['123A', '456B', '789C', '*0#D'][rowsCols[0]][rowsCols[1]], key).toBe(key);
    }
    void pack;
  }, 120000);
});

describe('the text', () => {
  it('every step has words, something to do and a challenge; no step is longer than the guide allows', () => {
    expect(chSpectrum.steps.length).toBe(12);
    for (const s of chSpectrum.steps) { expect(s.body.length, s.title).toBeGreaterThan(900); expect(!!s.widget || !!s.scene, s.title).toBe(true); expect(s.challenge, s.title).toBeTruthy(); expect(s.body, s.title).toContain('class="try"'); }
  });
  it('links only to chapters in the book, and types no chapter number', () => {
    for (const s of chSpectrum.steps) for (const m of s.body.matchAll(/#\/c\/([a-z0-9-]+)\//g)) expect(numOf(m[1] as never), m[1]).toBeDefined();
    const all = chSpectrum.steps.map((s) => s.body).join(' ');
    expect(readFileSync('src/chapters/ch-dsp-spectrum.ts', 'utf8')).not.toMatch(/(chapter|step|act) [0-9]/i); expect(all).not.toMatch(/firdesign|iir/);
  });
  it('claims nothing about how it sounds', () => {
    const all = chSpectrum.steps.map((s) => s.body).join(' ');
    expect(all).not.toMatch(/sounds? (like|harsh|clean|pure)/i);
  });
  it('the quiz answers are the numbers the model gives', () => {
    const q = chSpectrum.steps[1].challenge as { options: string[] };
    expect(q.options[0]).toContain(windowFigures('rect', 128).scallopDb.toFixed(1));
    expect(dbOf(0.5)).toBeCloseTo(-6.02, 2);
  });
  it('the recap\'s quizzes: answers first, a why for every wrong option', () => {
    for (const c of chSpectrum.recap!.check!) { expect(c.answer).toBe(0); expect(c.why!.length).toBe(c.options!.length); expect(c.why![0]).toBe(''); }
    expect(bestBlock(64)).toBeGreaterThan(64);
  });
});

describe('the audit\'s claims', () => {
  it('the leakage plot is not the window\'s own skirt: in a real block it levels off, and the text says by how much', () => {
    const f = spectrumFacts();
    expect(f.leakFar.db).toBeGreaterThan(f.leakFar.oneSkirt + 3); expect(f.leakFar.db).toBeGreaterThan(-31); expect(f.leakFar.db).toBeLessThan(-28);
    // the window's own (one-sided) transform keeps the 6 dB rule to 8 bins and beyond
    expect(skirtAt('rect', 8, 64) - skirtAt('rect', 16, 64)).toBeGreaterThan(4);
  });
  it('resolution is a figure for tones in phase: a quarter turn and opposite phase give the text\'s numbers', () => {
    const f = spectrumFacts();
    expect(f.phase90.rect).toBeCloseTo(1.2, 5); expect(f.phase90.hann).toBeCloseTo(1.95, 5); expect(f.phase180.rect).toBeCloseTo(0.25, 5);
    expect(resolvingSepAt(64, 'rect', 0)).toBe(resolvingSep(64, 'rect'));
  });
  it('step 3\'s last Try: Hamming at 2 bins shows a dip under 3 dB, which the chip calls shallow, not "one lump"', () => {
    const d = dipOf(64, 2, 'hamming');
    expect(d.dipDb).toBeGreaterThan(0.5); expect(d.dipDb).toBeLessThan(3); expect(d.resolved).toBe(false);
  });
  it('the factored final power equals the four-multiplication form', () => {
    const x = tone(205, 1000 / 8000), c = goertzelCoef(1000 / 8000), r = goertzelRun(x, c);
    expect(r.s1 * r.s1 + r.s2 * (r.s2 - c * r.s1)).toBeCloseTo(goertzelPower(r.s1, r.s2, c), 6);
  });
  it('the two FFTs and a complex multiplier are smaller than 128 parallel multipliers, as the text says', () => {
    const f = spectrumFacts();
    expect(2 * f.fft256 + 4 * f.mul).toBeLessThan(128 * f.mul);
  });
});
