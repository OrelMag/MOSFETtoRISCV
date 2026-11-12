// Group A of the extension's codex entries (message, signals, noise): every number they quote equal to the comm/ models and the library,
// or to the chapter step that prints it. Completeness and form are tests/content-codexcomm2.test.ts's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CODEX_A } from '../src/campaign/codexcomm2a';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { MIN_FRAME } from '../src/comm/ethframe';
import { ebn0For, shannonBinaryDb, uncodedBer } from '../src/comm/ber';
import { arrow, product } from '../src/comm/arrows';
import { gibbsOvershoot, poleGain, powerShare, swing1010, tauOf, toDb } from '../src/comm/fourier';
import { dbToRatio, EBN0_MIN, ratioToDb } from '../src/comm/limits';
import { layerCost, onTheLine, travelTime, WIRE_OVERHEAD } from '../src/comm/message';
import { cascadeNfDb, johnsonVolts, noiseDensityDbm, noiseFloorDbm, PULSES, RECEIVERS, snrAfter, T0 } from '../src/comm/noise';
import { aliasOf, binomialGain, FIR_IN, FIR_OUT, FIR_TAPS, mixed, mixedBySum, sqnrDb } from '../src/comm/signals';
import { arrayMul, FIR5, FIR_SETTLE, register } from '../src/lib';
import { resolveComponent } from '../src/lib/resolve';
import { stats } from '../src/sim/stats';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
const c = (n: number) => n.toLocaleString('en-US');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};
const minus = (x: number, d: number) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;

describe('group A: message', () => {
  it('bandwidth-delay product: the line\'s volume and the window', () => {
    const lon = onTheLine(1e10, 5.6e6);
    expect(lon).toBe(35e6);
    expect(Math.round(travelTime(5.6e6) * 1e3)).toBe(28);
    expect(onTheLine(1e8, 3e6)).toBe(187500);
    const rtt100 = (1e9 * 0.1) / 8, rtt40 = (1e9 * 0.04) / 8;
    expect(rtt100).toBe(12.5e6);
    expect(rtt40).toBe(5e6);
    expect(500e3 / rtt40).toBeCloseTo(0.1, 12);
    const pkts = rtt100 / 1500;
    quotes('bdp', '35 MB', '28 ms', '187.5 kB', '12.5 MB', c(Math.round(pkts)), '5 MB', '500 kB');
    says('message', 2, `${35} MB`);
    says('queues', 3, c(Math.round(pkts)));
    says('queues', 3, c(Math.round(pkts / 2)));
    quotes('bdp', c(Math.round(pkts / 2)));
    expect(Math.round(((pkts / 2) * 0.1) / 60)).toBe(7);
    says('queues', 3, '7 minutes');
    says('errors', 7, 'bandwidth-delay product');
  });

  it('protocol layers: what an envelope costs', () => {
    const full = layerCost(1460), one = layerCost(1);
    expect(WIRE_OVERHEAD + 40).toBe(78);
    expect(full.total).toBe(1538);
    expect((100 * full.share).toFixed(1)).toBe('94.9');
    expect(one.total).toBe(84);
    expect(one.pad).toBe(5);
    expect(1 + 20 + 20 + 14 + 4).toBe(59);
    expect(1 + 20 + 20 + 14 + 4 + one.pad).toBe(MIN_FRAME);
    expect(one.total - (MIN_FRAME + 20)).toBe(0);
    expect((100 * one.share).toFixed(1)).toBe('1.2');
    quotes('layers', '78 bytes', c(full.total), '94.9 %', '84', '1.2 %', '59', '64-byte', '1,460');
    says('message', 4, '78 bytes');
    says('message', 4, `${(100 * (1 - full.share)).toFixed(1)} %`);
  });

  it('decibels: sums, ratios and levels', () => {
    expect(dbToRatio(3).toFixed(3)).toBe('1.995');
    expect(dbToRatio(20 - 60 + 30)).toBeCloseTo(0.1, 12);
    expect(dbToRatio(-90)).toBeCloseTo(1e-9, 20);
    expect(10 ** ((20 - 90) / 10)).toBeCloseTo(1e-7, 18);
    expect(ratioToDb(2).toFixed(2)).toBe('3.01');
    expect(Math.round(ratioToDb(1e6))).toBe(60);
    const g4 = poleGain(4, 1);
    expect(toDb(g4).toFixed(1)).toBe('-12.3');
    expect(g4).toBeCloseTo(1 / Math.sqrt(17), 12);
    expect(ratioToDb(g4 * g4)).toBeCloseTo(toDb(g4), 12);
    quotes('decibel', '1.995', '−10 dB', '−70 dBm', '60 dB', '−12.3 dB', '0.24', '10⁻⁷');
    says('signals', 0, `${minus(toDb(g4), 1)} dB`);
    says('message', 5, '30 dBm is 1 W');
  });
});

describe('group A: signals', () => {
  const A8 = Math.exp((-2 * Math.PI * 1) / 8);

  it('Fourier: the square wave and a pole', () => {
    expect((100 * powerShare(1)).toFixed(0)).toBe('81');
    expect((100 * powerShare(3)).toFixed(0)).toBe('93');
    expect((100 * gibbsOvershoot(1000)).toFixed(2)).toBe('8.95');
    expect(gibbsOvershoot(25)).toBeGreaterThan(gibbsOvershoot(1000) - 0.005);
    expect(toDb(poleGain(12, 1)).toFixed(1)).toBe('-21.6');
    expect(Math.round(Math.log(9) * tauOf(1) * 1000)).toBe(350);
    expect(1000 / 8).toBe(125);
    expect(A8.toFixed(3)).toBe('0.456');
    expect(swing1010(A8).toFixed(3)).toBe('0.374');
    expect(((1 - A8) / (1 + A8)).toFixed(3)).toBe(swing1010(A8).toFixed(3));
    expect((1 - 2 * A8).toFixed(3)).toBe('0.088');
    expect(((2 * Math.PI) / Math.LN2).toFixed(1)).toBe('9.1');
    quotes('fourier', '81 %', '93 %', '8.95 %', '−12.3 dB', '−21.6 dB', '350 ps', '125 ps', '0.456', '±0.374', '0.088', '9.1 × B', 'N / 2 + 1');
    says('signals', 0, '8.95 %');
    says('signals', 0, `${(100 * powerShare(1)).toFixed(0)} % of the power`);
    says('signals', 0, `${toDb(poleGain(12, 1)).toFixed(1).replace('-', '−')} dB`);
    says('signals', 0, '350 ps');
    says('signals', 0, `${(1 - 2 * A8).toFixed(3)}`);
    says('signals', 0, '9.1 × B');
    says('signals', 2, 'N / 2 + 1');
  });

  it('complex numbers: the arrows the entry quotes', () => {
    const r = product(arrow(2, 1), arrow(1, 1));
    quotes('complex', '1 + 3j', r.lengths[0].toFixed(2), r.lengths[1].toFixed(2), r.lengths[2].toFixed(2), r.angles[0].toFixed(1), r.angles[2].toFixed(1), '163', '55', 'N / 2');
    says('signals', 1, '1 + 3j');
    says('signals', 1, r.lengths[2].toFixed(2));
    says('signals', 1, r.angles[2].toFixed(1));
    expect(moreOf('complex')!.chapters!.every((l) => chapterById(l.chapter!)!.steps[l.step!]?.title === l.label)).toBe(true);
  });

  it('FIR filter: taps 1 4 6 4 1 in gates', () => {
    const mul8 = nands(arrayMul(8)), reg8 = nands(register(8));
    expect(nands(FIR5)).toBe(1140);
    expect(5 * reg8).toBe(600);
    expect(mul8).toBe(632);
    expect(3 * mul8).toBe(1896);
    expect(nands(FIR5) + 3 * mul8).toBeGreaterThan(2 * nands(FIR5));
    expect(FIR_SETTLE).toBe(40);
    expect(FIR_TAPS.reduce((a, b) => a + b, 0)).toBe(16);
    expect(FIR_TAPS.reduce((a, b, i) => a + (i % 2 ? -b : b), 0)).toBe(0);
    expect(-128 * 16).toBe(-(2 ** (FIR_OUT - 1)));
    expect(FIR_OUT - FIR_IN).toBe(4);
    expect(binomialGain(0.25).toFixed(3)).toBe('0.250');
    expect(binomialGain(0.5)).toBeCloseTo(0, 12);
    expect(resolveComponent(moreOf('firfilter')!.lib!)).toBeTruthy();
    quotes('firfilter', c(nands(FIR5)), c(5 * reg8), c(mul8), c(3 * mul8), FIR_SETTLE, '0.250', '−2048', '16', '3.3 / n', '1 − 4 + 6 − 4 + 1 = 0');
    says('signals', 5, c(nands(FIR5)));
    says('signals', 5, c(5 * reg8));
    says('signals', 5, c(mul8));
    says('signals', 5, `${FIR_SETTLE} delays`);
    says('signals', 5, binomialGain(0.25).toFixed(3));
    says('signals', 4, '3.3 / n');
  });

  it('sampling and aliasing: where a tone folds', () => {
    expect(aliasOf(7, 10)).toBe(3);
    expect(aliasOf(30, 48)).toBe(18);
    expect(aliasOf(5, 8)).toBe(3);
    // the two tones give the same samples
    for (let k = 0; k < 20; k++) expect(Math.cos((2 * Math.PI * 3 * k) / 8)).toBeCloseTo(Math.cos((2 * Math.PI * 5 * k) / 8), 12);
    expect(sqnrDb(8).toFixed(1)).toBe('49.9');
    expect(sqnrDb(16).toFixed(1)).toBe('98.1');
    expect(((42 - 1.76) / 6.02).toFixed(1)).toBe('6.7');
    quotes('aliasing', '3 kHz', '18 kHz', '49.9 dB', '98.1 dB', '6.02 b + 1.76 dB', '3.4 kHz', '8 kHz', '44.1 kHz', '6.7 by the formula');
    says('signals', 6, '3.4 kHz');
    says('signals', 6, '8 kHz');
    says('signals', 6, '44.1 kHz');
    says('signals', 7, `${sqnrDb(8).toFixed(1)} dB`);
    says('signals', 7, `${sqnrDb(16).toFixed(1)} dB`);
    says('signals', 7, '6.02 b + 1.76 dB');
  });

  it('mixer: the product, the sidebands, the image', () => {
    for (const t of [0, 0.013, 0.071, 0.4]) expect(mixed(5, 60, t)).toBeCloseTo(mixedBySum(5, 60, t), 12);
    expect([100 - 4, 100 + 4]).toEqual([96, 104]);
    expect(+(2 * 2.4 - 2.41).toFixed(3)).toBe(2.39);
    expect(+(2 * 1.0 - 1.02).toFixed(3)).toBe(0.98);
    expect(Math.abs(2.41 - 2.4)).toBeCloseTo(0.01, 12);
    expect(Math.cos(Math.PI / 2)).toBeCloseTo(0, 12);
    quotes('mixer', '96 to 104 kHz', '2.390 GHz', '0.980 GHz', '10 MHz', '20 MHz', '−50 dB', 'cos φ', 'a third of a degree');
    says('signals', 8, 'cos a · cos b = ½ cos(a − b) + ½ cos(a + b)');
    const q = chapterById('signals')!.steps[8].challenge;
    expect(q?.kind === 'quiz' && q.options[0], 'the chapter quiz').toContain('96 to 104 kHz');
    says('radio', 3, '−50 dB');
    says('radio', 3, 'a third of a degree');
    says('radio', 3, 'superheterodyne');
  });
});

describe('group A: noise', () => {
  const GAIN = (p: readonly number[], r: number) => 10 * Math.log10(snrAfter(p, RECEIVERS[r].weights(p), 1));
  const RECT = PULSES[0].shape, SINE = PULSES[1].shape;

  it('thermal noise: the density, a floor, a chain', () => {
    expect(minus(noiseDensityDbm(), 1)).toBe('−174.0');
    expect(T0).toBe(290);
    expect(minus(noiseFloorDbm(20e6, 6), 1)).toBe('−95.0');
    expect((10 * Math.log10(2e7)).toFixed(1)).toBe('73.0');
    expect((johnsonVolts(1000, 1) * 1e9).toFixed(1)).toBe('4.0');
    expect(Math.round((dbToRatio(6) - 1) * T0)).toBe(865);
    expect(minus(noiseFloorDbm(1e6, 3), 0)).toBe('−111');
    expect(10 * Math.log10(100)).toBe(20);
    const good = cascadeNfDb([{ name: 'amplifier', gainDb: 20, nfDb: 1 }, { name: 'cable', gainDb: -10, nfDb: 10 }]);
    const bad = cascadeNfDb([{ name: 'cable', gainDb: -10, nfDb: 10 }, { name: 'amplifier', gainDb: 20, nfDb: 1 }]);
    expect(good.toFixed(2)).toBe('1.30');
    expect(bad.toFixed(2)).toBe('11.00');
    expect((bad - good).toFixed(1)).toBe('9.7');
    expect((10 ** ((bad - good) / 10)).toFixed(0)).toBe('9');
    quotes('thermalnoise', '−174', '4.0 nV', '−95.0 dBm', '73.0', '865 K', '−111 dBm', '20 dB', '1.30 dB', '11.00 dB', '9.7 dB', 'about 9 times');
    says('noise', 0, `${minus(noiseDensityDbm(), 1)} dBm`);
    says('noise', 0, `${minus(noiseFloorDbm(20e6, 6), 1)} dBm`);
    says('noise', 0, '865 K');
    says('noise', 1, '1.30 dB');
    says('noise', 1, '11.00 dB');
    says('noise', 1, '9.7 dB');
  });

  it('matched filter: E / σ² and the gain of averaging', () => {
    expect(RECT.length).toBe(16);
    expect(GAIN(RECT, 2) - GAIN(RECT, 0)).toBeCloseTo(10 * Math.log10(16), 9);
    expect((GAIN(RECT, 2) - GAIN(RECT, 0)).toFixed(1)).toBe('12.0');
    expect(GAIN(RECT, 1)).toBeCloseTo(GAIN(RECT, 2), 9);
    expect((GAIN(SINE, 2) - GAIN(SINE, 1)).toFixed(2)).toBe('0.90');
    expect((10 * Math.log10(64)).toFixed(1)).toBe('18.1');
    // matched: SNR = Σ p² / σ², whatever the shape
    for (const p of PULSES) expect(snrAfter(p.shape, RECEIVERS[2].weights(p.shape), 1)).toBeCloseTo(p.shape.reduce((m, v) => m + v * v, 0), 9);
    quotes('matchedfilter', '12.0 dB', '0.90 dB', '18.1 dB', '16 samples', 'E / σ²');
    says('noise', 4, '12.0 dB');
    says('noise', 4, '0.90 dB');
    says('noise', 4, 'E / σ²');
  });

  it('Eb/N0: the curve, the limit and the gap', () => {
    const e5 = ebn0For(uncodedBer, 1e-5), e9 = ebn0For(uncodedBer, 1e-9), wall = ratioToDb(EBN0_MIN);
    expect(e5.toFixed(2)).toBe('9.59');
    expect(e9.toFixed(1)).toBe('12.5');
    expect(wall.toFixed(2)).toBe('-1.59');
    expect((e5 - wall).toFixed(1)).toBe('11.2');
    expect((10 ** ((e5 - wall) / 10)).toFixed(0)).toBe('13');
    expect(shannonBinaryDb(0.5).toFixed(2)).toBe('0.19');
    expect(Math.round(10 * Math.log10(1e9 / 1e3))).toBe(60);
    expect(ebn0For(uncodedBer, 1e-2).toFixed(1)).toBe('4.3');
    quotes('ebn0', '9.59 dB', '9.6 dB', '12.5 dB', '−1.59 dB', '11.2 dB', 'factor of 13', '0.19 dB', '60 dB');
    says('noise', 5, `${e5.toFixed(1)} dB`);
    says('noise', 5, `${e9.toFixed(1)} dB`);
    says('noise', 5, `${minus(wall, 2)} dB`);
    says('noise', 5, `${(e5 - wall).toFixed(1)} dB`);
    const q = chapterById('noise')!.steps[5].challenge;
    expect(q?.kind === 'quiz' && q.explain, 'the chapter quiz').toContain('60 dB more power');
    says('noise', 7, `${shannonBinaryDb(0.5).toFixed(2)} dB`);
  });
});

describe('group A: shape', () => {
  it('has the twelve entries, each linked from its teaching chapter', () => {
    expect(CODEX_A.map((e) => e.id)).toEqual(['bdp', 'layers', 'decibel', 'fourier', 'complex', 'firfilter', 'aliasing', 'mixer', 'thermalnoise', 'gaussian', 'matchedfilter', 'ebn0']);
  });
});
