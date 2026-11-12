// Group B of the Signal processing level's codex entries (measuring a spectrum, FIR design): every number they quote equal to the dsp/ models and the library,
// or to the chapter step that prints it. Completeness and form are tests/content-codexdsp.test.ts's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { spectrumFacts } from '../src/chapters/ch-dsp-spectrum';
import { figures } from '../src/chapters/ch-dsp-firdesign';
import { binaryDigits, csdAdders, csdOf, csdValue, foldedMults, gainOf, guardForN, linearDelay, macAccWidth } from '../src/dsp/firdesign';
import { binsBreakEven, bestBlock, crossoverTaps, fftRealMults, frameCount, goertzelCoef, olsMults, resolvingSep, SG_LEN, skirtAt, windowFigures } from '../src/dsp/spectrum';
import { PAD_GAP } from '../src/widgets/dspspectrum';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
/** Digit groups spelled with a comma or a space compare equal (4,419 = 4 419). */
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};
const nf = (v: number, d: number) => v.toFixed(d);
const minus = (x: number, d: number) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;
const log2 = Math.log2;

describe('group B: measuring a spectrum', () => {
  it('leakage', () => {
    const f = spectrumFacts();
    expect(f.leak10.above60).toBe(1);
    expect(f.leak10.top).toBeCloseTo(1, 12);
    expect(f.leak105.above60).toBe(33);
    expect(64 / 2 + 1).toBe(33);
    quotes('leakage', nf(f.leak105.top, 3), minus(20 * Math.log10(f.leak105.top), 1), f.leak105.above60, nf(f.leak125.top, 3), minus(f.leakFar.db, 1), minus(f.leakFar.oneSkirt, 1));
    expect(nf(-20 * Math.log10(f.leak105.top), 1)).toBe('3.8');
    says('spectrum', 0, nf(f.leak105.top, 3));
    says('spectrum', 0, minus(f.leakFar.db, 1));
    says('spectrum', 0, minus(f.leakFar.oneSkirt, 1));
    says('spectrum', 0, `all ${f.leak105.above60} bins`);
    // "6 dB per doubling": the skirt of the rectangle at 5 and 10 bins differs by about that
    expect(skirtAt('rect', 5, 64) - skirtAt('rect', 10, 64)).toBeGreaterThan(5);
    expect(skirtAt('rect', 5, 64) - skirtAt('rect', 10, 64)).toBeLessThan(7);
    // the question: 0.65 is the half-bin reading
    expect(f.leak125.top).toBeGreaterThan(0.64);
    expect(f.leak125.top).toBeLessThan(0.65);
  });

  it('windowfn', () => {
    const f = spectrumFacts(), W = [f.rect, f.hann, f.blackman, f.bh];
    expect(W.map((w) => w.mainLobeBins)).toEqual([2, 4, 6, 8]);
    quotes('windowfn', ...W.map((w) => minus(w.sidelobeDb, 1)), ...W.map((w) => nf(w.enbw, 2)), ...W.map((w) => nf(w.scallopDb, 2)),
      minus(f.skirt10.rect, 1), minus(f.skirt10.hann, 1), minus(f.skirt10.blackman, 1), nf(10 * Math.log10(f.hann.enbw), 1));
    expect(f.hann.coherentGain).toBeCloseTo(0.5, 12);
    expect(f.hann.enbw).toBeCloseTo(1.5, 12);
    expect(f.hann.scallopDb).toBeCloseTo(windowFigures('hann', 128).scallopDb, 12);
    says('spectrum', 1, minus(f.bh.sidelobeDb, 1));
    says('spectrum', 1, nf(f.hann.scallopDb, 2));
    says('spectrum', 2, minus(f.skirt10.hann, 1));
    expect(text('windowfn')).toContain('1.8 dB');
  });

  it('zeropad', () => {
    const f = spectrumFacts();
    quotes('zeropad', nf(f.sepRect, 2), nf(f.sepHann, 2), nf(f.sepBlackman, 1), PAD_GAP, f.minRect, f.minHann, nf(PAD_GAP * 32, 2), 8000 / 64, nf(8000 / 4096, 2), Math.round(f.sepHann * 125));
    expect(Math.abs(1.55 / PAD_GAP - f.minRect)).toBeLessThan(1);
    expect(Math.abs(2.45 / PAD_GAP - f.minHann)).toBeLessThan(1);
    expect(f.sepRect).toBe(1.55);
    expect(f.sepHann).toBe(2.45);
    expect(150 / 125).toBeLessThan(f.sepHann);
    expect(150 / 125).toBeCloseTo(1.2, 12);
    says('spectrum', 3, `${f.minRect} samples`);
    says('spectrum', 3, `${f.minHann}`);
    says('spectrum', 3, nf(PAD_GAP * 32, 2));
    expect(resolvingSep(64, 'blackman')).toBe(2.8);
  });

  it('spectrogram', () => {
    const lobe = (N: number) => (4 * 8000) / N, ms = (N: number) => (N / 8000) * 1000;
    expect([lobe(32), lobe(64), lobe(512)]).toEqual([1000, 500, 62.5]);
    expect([ms(32), ms(64), ms(512)]).toEqual([4, 8, 64]);
    const plain = frameCount(SG_LEN, 512, 512), half = frameCount(SG_LEN, 512, 256), dense = frameCount(SG_LEN, 512, 64);
    expect([plain, half, dense]).toEqual([4, 7, 25]);
    quotes('spectrogram', lobe(32), lobe(512), lobe(64), ms(32), ms(512), SG_LEN, half, dense, plain, half / plain, dense / plain, Math.round((0.37 * 512 * 512) / 2048), 512 / 64);
    says('spectrum', 4, `${Math.round((0.37 * 512 * 512) / 2048)} bins`);
    says('spectrum', 4, '1.75 and 6.3');
    expect(nf(dense / plain, 1)).toBe('6.3');
    expect(lobe(64) / lobe(512)).toBe(8);
  });

  it('overlapsave', () => {
    const f = spectrumFacts(), L = (N: number, M: number) => N - M + 1;
    expect([L(512, 128), 512 - L(512, 128), L(256, 128), L(256, 64), 64 - 1]).toEqual([385, 127, 129, 193, 63]);
    expect([bestBlock(33), bestBlock(60)]).toEqual([256, 512]);
    expect(olsMults(33, bestBlock(33))).toBeGreaterThan(33);
    expect(olsMults(60, bestBlock(60))).toBeLessThan(60);
    expect(f.cross).toBe(crossoverTaps());
    expect(olsMults(f.cross, bestBlock(f.cross))).toBeLessThan(f.cross);
    expect(olsMults(f.cross - 1, bestBlock(f.cross - 1))).toBeGreaterThanOrEqual(f.cross - 1);
    quotes('overlapsave', 385, 127, 129, 193, 63, f.cross, nf(olsMults(33, 256), 1), nf(olsMults(60, 512), 1), f.fft256, 128 * f.mul, 2 * f.fft256 + 4 * f.mul, 33, 60);
    says('spectrum', 5, `from ${f.cross} taps`);
    says('spectrum', 5, f.fft256.toLocaleString('en-US').replace(/,/g, ' '));
    says('spectrum', 5, nf(olsMults(33, 256), 1));
    says('spectrum', 5, nf(olsMults(60, 512), 1));
  });

  it('goertzel', () => {
    const f = spectrumFacts();
    expect(f.bits).toBe(16);
    expect(f.best.N).toBe(205);
    expect(f.perKey).toBe(8 * (205 + 1));
    expect(binsBreakEven(256)).toBe(16);
    expect(binsBreakEven(64)).toBe(12);
    expect(fftRealMults(256) / 256).toBe(16);
    expect(f.cellMul).toBeLessThan(f.cell);
    quotes('goertzel', nf(goertzelCoef(697 / 8000), 4), f.best.N, nf(f.best.worst, 3), f.cellMul, f.cell, nf(f.gain, 2), Math.round(128.5 * f.gain), f.perKey, nf(205 / 8, 1), nf(f.perKey / (205 / 8000) / 1000, 1), 16, 12, 8 * f.cell, f.fft256, f.bits, 256 / 2 + 1, Math.round(f.gain), 3);
    expect(Math.round(128.5 * f.gain)).toBeLessThan(2 ** 15);
    expect(Math.round(128.5 * f.gain)).toBeGreaterThan(2 ** 14);
    expect(128.5 * f.gain).toBeLessThan(32767);
    says('spectrum', 6, nf(f.best.worst, 2));
    says('spectrum', 7, `${f.cell.toLocaleString('en-US').replace(/,/g, ' ')} NANDs`);
    says('spectrum', 7, f.cellMul.toLocaleString('en-US').replace(/,/g, ' '));
    says('spectrum', 7, `${f.perKey.toLocaleString('en-US').replace(/,/g, ' ')} clocks`);
    says('spectrum', 7, nf(f.perKey / (205 / 8000) / 1000, 1));
    says('spectrum', 7, nf(205 / 8, 1));
    says('spectrum', 7, nf(f.gain, 1));
    expect(2 * log2(256)).toBe(16);
  });
});

describe('group B: FIR design', () => {
  it('linearphase', () => {
    const F = figures();
    expect([linearDelay(114), linearDelay(115), linearDelay(64), linearDelay(147), linearDelay(51)]).toEqual([56.5, 57, 31.5, 73, 25]);
    expect(nf((linearDelay(64) / 8000) * 1000, 1)).toBe('3.9');
    expect(nf((linearDelay(115) / 48000) * 1000, 1)).toBe('1.2');
    expect([foldedMults(115), foldedMults(114), Math.ceil(114 / 2), Math.ceil(115 / 2)]).toEqual([58, 57, 57, 58]);
    expect(F.ch.n).toBe(114);
    expect(F.ch.hwN).toBe(115);
    expect(F.kaiserOdd).toBe(147);
    expect(F.kaiserAny).toBe(146);
    quotes('linearphase', 56.5, 57, 31.5, 73, 3.9, 114, 115, 58, 147, 146, 1.2, 25, 51);
    // an even-length symmetric filter has a zero at z = -1: no gain at half the sample rate
    expect(gainOf([1, 2, 3, 3, 2, 1], 0.5)).toBeCloseTo(0, 12);
    expect(gainOf([1, 2, 3, 2, 1], 0.5)).toBeGreaterThan(0.01);
    says('firdesign', 0, nf(linearDelay(F.ch.n), 1));
    says('zplane', 6, '(N − 1) / 2 samples');
    // the signals chapter's step that teaches it
    expect(strip(chapterById('signals')!.steps[4].body)).toMatch(/twice the delay/);
  });

  it('windowdesign', () => {
    const F = figures();
    quotes('windowdesign', nf(F.dp, 5), nf(F.dp, 4), F.ds, nf(F.width, 3), minus(F.rect[0], 1), minus(F.rect[1], 1), ...F.ham.map((v) => minus(v, 1)), F.hamming!, F.hann!, F.hannAny!, F.blackman!, F.kaiserOdd!, F.kaiserAny, nf(F.kaiser.beta, 2), nf(F.kaiserRep.passDev, 4), F.ch.n, 0.1, 0.125);
    expect(F.hamming).toBe(489);
    expect(F.hann).toBe(269);
    expect(F.blackman).toBe(201);
    expect(F.ham.length).toBe(4);
    expect(F.ham.map((v) => Math.round(v))).toEqual([-17, -30, -57, -58]);
    expect(F.dp / F.kaiserRep.passDev).toBeGreaterThan(4.9);
    expect(F.dp / F.kaiserRep.passDev).toBeLessThan(5.3);
    expect(F.ham[3]).toBeGreaterThan(-60);
    expect(F.rect[1] - F.rect[0]).toBeLessThan(-17);
    says('firdesign', 1, `${F.rect[0].toFixed(1).replace('-', '−')} dB`);
    says('firdesign', 1, `${F.hamming} taps`);
    says('firdesign', 1, `Blackman ${F.blackman}`);
    says('firdesign', 1, nf(F.kaiser.beta, 3));
    expect(F.width).toBeCloseTo(0.025, 12);
  });

  it('parksmcclellan', () => {
    const F = figures();
    quotes('parksmcclellan', F.ch.n, F.kaiserAny, F.kaiserAny - F.ch.n, Math.round(100 * (F.kaiserAny / F.ch.n - 1)), F.iters, F.est, F.ch.n - F.est, F.ch.fewestOddPm!, F.kaiserOdd!, nf(F.pm114.passDev, 5), nf(F.pm113.passDev, 5), nf(F.dp, 5),
      minus(F.pm114.stopDb, 1), minus(F.pm113.stopDb, 1), nf(F.c114q.stopDb + 60, 2), F.kaiserAny - F.est, F.ch.n - 1);
    expect(F.pm114.ok).toBe(true);
    expect(F.pm113.ok).toBe(false);
    expect(F.pm113.passOk).toBe(false);
    expect(F.pm113.stopOk).toBe(false);
    expect(F.c114q.ok).toBe(false);
    expect(F.hwq.ok).toBe(true);
    expect(F.hw.frac).toBe(17);
    expect(F.hw.taps.length).toBe(115);
    expect(F.iters).toBe(8);
    says('firdesign', 2, `${F.iters} passes`);
    says('firdesign', 2, F.pm113.stopDb.toFixed(1).replace('-', '−'));
    says('firdesign', 2, nf(F.pm113.passDev, 5));
    says('firdesign', 2, `${Math.round(100 * (F.kaiserAny / F.ch.n - 1))} %`);
    says('firdesign', 3, nf(F.c114q.stopDb + 60, 2));
  });

  it('csd', () => {
    const F = figures();
    expect(csdValue(csdOf(13304))).toBe(13304);
    expect(csdOf(13304).map((d) => (d.neg ? -1 : 1) * d.pos)).toEqual([-3, 10, -12, 14]);
    expect([binaryDigits(13304), csdOf(13304).length, csdAdders(13304)]).toEqual([9, 4, 3]);
    expect(csdOf(7).length).toBe(2);
    expect(binaryDigits(7)).toBe(3);
    let widest = 0;
    for (let c = 1; c < 4096; c++) {
      const p = csdOf(c).map((d) => d.pos).sort((a, b) => a - b);
      for (let i = 1; i < p.length; i++) expect(p[i] - p[i - 1], `${c}: no two digits side by side`).toBeGreaterThanOrEqual(2);
      widest = Math.max(widest, p.length);
    }
    expect(widest).toBe(7);
    quotes('csd', 13304, F.csd.distinct, F.csd.bin, F.csd.csd, F.csd.adders, F.csd.nandsCsd, F.csd.nandsTree, F.csd.tree, F.folded.nands, F.foldedCsd.nands, F.ch.hwN, 4095, 7);
    expect(F.csd.nandsTree).toBe(F.csd.distinct * F.csd.tree);
    says('firdesign', 5, `${F.csd.bin} ones and signed digits ${F.csd.csd}`);
    says('firdesign', 5, `${F.csd.adders} adders`);
    says('firdesign', 5, F.csd.nandsCsd.toLocaleString('en-US').replace(/,/g, ' '));
    says('firdesign', 5, F.csd.nandsTree.toLocaleString('en-US').replace(/,/g, ' '));
    says('firdesign', 5, F.foldedCsd.nands.toLocaleString('en-US').replace(/,/g, ' '));
  });

  it('transposed', () => {
    const F = figures(), n = F.ch.hwN;
    expect(F.direct.mults).toBe(115);
    expect(F.folded.mults).toBe(foldedMults(115));
    expect(F.transposed.mults).toBe(58);
    expect(Math.ceil(log2(n))).toBe(7);
    expect(macAccWidth(F.hw)).toBe(34);
    expect(F.hw.w).toBe(16);
    expect(F.transposed.nands).toBeGreaterThan(F.folded.nands);
    quotes('transposed', F.direct.nands, F.folded.nands, F.transposed.nands, F.folded.mults, Math.ceil(log2(n)), macAccWidth(F.hw), F.hw.w, n);
    says('firdesign', 4, F.transposed.nands.toLocaleString('en-US').replace(/,/g, ' '));
    says('firdesign', 4, F.folded.nands.toLocaleString('en-US').replace(/,/g, ' '));
    says('firdesign', 4, F.direct.nands.toLocaleString('en-US').replace(/,/g, ' '));
    says('firdesign', 7, `${Math.ceil(log2(n))} wide adders`);
  });

  it('multacc', () => {
    const F = figures(), n = F.ch.hwN;
    expect(F.shared.cycles).toBe(115);
    expect(Math.round(F.direct.nands / F.shared.nands)).toBe(13);
    expect(F.hw.guard).toBe(2);
    expect(F.guardSum).toBe(2);
    expect(F.guardN).toBe(guardForN(n));
    expect(F.guardN).toBe(7);
    expect(F.scene.cfg.taps.length).toBe(16);
    expect(F.accBits).toBe(33);
    expect(2 * 16 + F.hw.guard).toBe(34);
    expect(Math.round(F.tShared.maxMhz)).toBe(315);
    expect(F.tShared.period).toBe(127);
    quotes('multacc', F.shared.nands, F.direct.nands, n, 2 * 16 + F.hw.guard, nf((n * 48000) / 1e6, 2), Math.round(F.tShared.maxMhz), nf(F.tShared.maxMhz / n, 1), F.tShared.period, nf(F.sumAbs, 2), F.guardN, F.sceneNands, F.csd.tree, F.accBits, nf(F.gains[0.04], 3), nf(F.gains[0.35], 3), Math.round(F.direct.nands / F.shared.nands), (64 * 96000) / 1e6, F.scene.cfg.taps.length);
    says('firdesign', 6, F.sceneNands.toLocaleString('en-US').replace(/,/g, ' '));
    says('firdesign', 6, F.shared.nands.toLocaleString('en-US').replace(/,/g, ' '));
    says('firdesign', 6, nf(F.gains[0.04], 3));
    says('firdesign', 6, nf(F.gains[0.35], 3));
    says('firdesign', 3, nf(F.sumAbs, 3).slice(0, 3));
    says('firdesign', 7, `${nf(F.tShared.maxMhz / n, 1)} million`);
    says('firdesign', 7, nf((n * 48000) / 1e6, 2));
  });
});

describe('group B: audit corrections', () => {
  const ids = ['leakage', 'windowfn', 'zeropad', 'spectrogram', 'overlapsave', 'goertzel', 'linearphase', 'windowdesign', 'parksmcclellan', 'csd', 'transposed', 'multacc'];
  it('Blackman-Harris resolves at 3.25 bins and its lobe is 8 wide; its skirt at 10 bins is quoted', () => {
    const f = spectrumFacts();
    expect(resolvingSep(64, 'blackmanharris')).toBe(3.25);
    expect(f.bh.mainLobeBins).toBe(8);
    expect([f.rect.mainLobeBins, f.hann.mainLobeBins, f.blackman.mainLobeBins, f.bh.mainLobeBins]).toEqual([2, 4, 6, 8]);
    quotes('windowfn', 3.3, '3.25', minus(skirtAt('blackmanharris', 10, 64), 1), 'two bins');
    expect(nf(f.sepBlackman, 2)).toBe('2.80');
    expect(nf(windowFigures('rect', 128).scallopDb, 1)).toBe('3.9');
    quotes('leakage', '3.9 dB', '3.8');
  });
  it('127 is 2^7 - 1', () => {
    expect(2 ** 7 - 1).toBe(127);
    quotes('csd', '127', '2⁷ − 1');
  });
  it('the gate-clock figures are marked illustrative: 127 delays at 25 ps', () => {
    const F = figures();
    expect(F.tShared.period).toBe(127);
    expect(1e6 / (F.tShared.period * 25)).toBeCloseTo(F.tShared.maxMhz, 6);
    for (const t of [codexById('multacc')!.body, moreOf('multacc')!.example!.body, moreOf('multacc')!.mistakes![2]]) expect(t).toContain('illustrative');
    expect(moreOf('multacc')!.example!.body).toContain('25 ps');
  });
  it('csd: 173 adders = 227 - 58 + 4, and the folded multipliers are 17 x 17', () => {
    const F = figures();
    let negOnly = 0;
    for (const t of tapsDistinct(F.hw.taps)) if (csdOf(t).every((d) => d.neg)) negOnly++;
    expect(F.csd.csd - F.csd.distinct + negOnly).toBe(F.csd.adders);
    expect(negOnly).toBe(4);
    expect(F.folded.nands - F.foldedCsd.nands).toBeGreaterThan(F.csd.nandsTree - F.csd.nandsCsd);
    expect(F.folded.nands - F.csd.nandsTree + F.csd.nandsCsd).toBe(122548);
    quotes('csd', '227 − 58 + 4', '17 × 17', 285871, 99048);
    says('firdesign', 4, '17 × 17');
  });
  it('example lines are at most 90 characters', () => {
    for (const id of ids) for (const m of (moreOf(id)!.example!.body.match(/<pre>[\s\S]*?<\/pre>/g) ?? [])) for (const l of m.replace(/<\/?pre>/g, '').split('\n')) expect([...l].length, `${id}: ${l}`).toBeLessThanOrEqual(90);
  });
  it('the right option is never the longest', () => {
    for (const id of ids) for (const q of CHECKS[id]) expect(q.options[0].length, `${id}: ${q.question}`).toBeLessThan(Math.max(...q.options.map((o) => o.length)));
  });
  it('wording fixes', () => {
    quotes('windowdesign', '269 taps odd', '268 if either parity is allowed', '147', '146 if either parity');
    quotes('parksmcclellan', "equiripple length estimate: 109");
    quotes('transposed', 'adders and forks');
    quotes('linearphase', 'Linear phase means every zero is paired', 'antisymmetric');
  });
});

/** The distinct taps of a mirrored design, as the chapter counts them (the rest are mirrors). */
function tapsDistinct(words: readonly number[]): number[] {
  return words.slice(0, Math.ceil(words.length / 2)).map((w) => w);
}
