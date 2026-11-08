// Group E of the Signal processing level's codex entries (the DSP core, speech, music, the software radio): every number they quote equal to the dsp/ models, the library and the
// golden model, or to the chapter step that prints it. Completeness and form are tests/content-codexdsp.test.ts's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import figures from '../src/bench/dspcore.json';
import { assemble24 } from '../src/dsp/asm24';
import { MEM24_WORDS, REGNAMES24 } from '../src/dsp/isa24';
import { aguStep, Iss24 } from '../src/dsp/iss24';
import { BENCH24 } from '../src/dsp/programs24';
import { addressRun, dspPerProduct, rvPerProduct } from '../src/widgets/dspcore';
import { adpcmOnRv } from '../src/dsp/adpcmrv';
import { MUSIC_FIGS, SPEECH_FIGS } from '../src/dsp/soundfigs';
import {
  adpcmDecodeOne, adpcmEncodeOne, autocorr, durbin, IMA_INDEX, IMA_STEPS, lpc, lpcEnvelopeDb, PRE, sineSnr, uniform, ulawDecision, ulawDecode, ulawEncode, ulawFields, ulawQuantized, ULAW_BITS, ULAW_CLIP,
  VOC, VOC_BITS, vocBitRate, vocBitsPerFrame,
} from '../src/dsp/speech';
import { bands, bark, bandPowersDb, imdct, MASK, maskDb, mdct, MDCT_M, mdctRoundTrip, quietDb, sineWindow } from '../src/dsp/music';
import {
  ALPHA, AUD, carson, deEmphasis, DEV, discriminate, FS, FS_CIC, preEmphasis, preLiftDb, analogueLiftDb, MixModel, mixerSfdr, modIndex, NCO_AMP, NCO_BITS, NCO_K, NCO_SHIFT, STATIONS, TAU, trailingZeros, tuningWord, wordHz,
  W_IN, W_MIX,
} from '../src/dsp/sdr';
import { ulawDecoder, ulawEncoder } from '../src/lib/ulaw';
import { stats } from '../src/sim/stats';
import { nandsOf, tableRow } from '../src/widgets/dspsdr';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
/** Everything an entry says: summary, fuller text, questions. */
function text(id: string): string {
  const m = moreOf(id)!;
  const qs = CHECKS[id] ?? [];
  return strip([codexById(id)!.body, m.idea, m.example?.title, m.example?.body, ...(m.mistakes ?? []),
    ...qs.flatMap((q) => [q.question, q.explain, ...q.options, ...(q.why ?? [])])].join(' '));
}
const flat = (s: string) => s.replace(/(\d)[, ](?=\d{3}(?!\d))/g, '$1');
const quotes = (id: string, ...s: (string | number)[]) => { const t = flat(text(id)); for (const x of s) expect(t, `${id}: ${x}`).toContain(flat(String(x))); };
const says = (ch: string, step: number, s: string) => {
  const st = chapterById(ch)!.steps[step];
  expect(flat(strip([st.body, ...Object.values(st.more ?? {})].map(String).join(' '))), `${ch} ${step}: ${s}`).toContain(flat(s));
};
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const run = (id: string) => { const b = BENCH24.find((x) => x.id === id)!; const iss = new Iss24(assemble24(b.src).words, b.x, b.y); iss.run(); return { iss, b }; };
const rev = (i: number, bits: number) => { let r = 0; for (let k = 0; k < bits; k++) if (i & (1 << k)) r |= 1 << (bits - 1 - k); return r; };

describe('group E: the DSP core', () => {
  it('address generator: the pointers, the cost, the modes, one pointer in every mode', () => {
    expect(REGNAMES24.slice(8, 16)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(MEM24_WORDS).toBe(256);
    expect(figures.nands.agu).toBe(1920);
    expect(figures.nands.aguStep).toBe(639);
    expect(figures.nands.core).toBe(21974);
    expect(2 * figures.nands.agu).toBe(3840);
    const dot = BENCH24.find((b) => b.id === 'dot')!.src;
    expect(dot).toContain('mac   x(p0)+, y(p4)+');
    expect(f2(dspPerProduct('fir64'))).toBe('1.11');
    expect(f2(rvPerProduct('rv32im', 'fir64'))).toBe('7.18');
    expect(f2(rvPerProduct('mac', 'fir64'))).toBe('6.15');
    // the modes as the example prints them (window 4 … 9, m = 32)
    expect(addressRun(9, 1, 4, 6, 32, 3)).toEqual([9, 10, 11]);
    expect(addressRun(9, 2, 4, 6, 32, 3)).toEqual([9, 8, 7]);
    expect(addressRun(9, 3, 4, 6, 32, 3)).toEqual([9, 41, 73]);
    expect(addressRun(9, 7, 4, 6, 32, 3)).toEqual([9, 233, 201]);
    expect(addressRun(9, 4, 4, 6, 32, 3)).toEqual([9, 4, 5]);
    expect(addressRun(4, 5, 4, 6, 32, 3)).toEqual([4, 9, 8]);
    expect(addressRun(0, 6, 4, 6, 32, 4)).toEqual([0, 32, 16, 48]);
    expect(aguStep(255, 1, 0, 0, 0)).toBe(0);
    quotes('agu', 1920, 639, '3,840', '21,974', '1.11', '7.18', '6.15', 'p0–p3', 'p4–p7', 233, 201, 256);
  });
  it('circular buffer: the ring, outside the window, 71 clocks a sample', () => {
    expect(addressRun(9, 4, 4, 6, 0, 8)).toEqual([9, 4, 5, 6, 7, 8, 9, 4]);
    expect(addressRun(4, 5, 4, 6, 0, 7)).toEqual([4, 9, 8, 7, 6, 5, 4]);
    expect(addressRun(12, 4, 4, 6, 0, 3)).toEqual([12, 13, 14]);
    // N reads round a window of N bring the pointer back
    expect(addressRun(7, 4, 4, 6, 0, 7)[6]).toBe(7);
    const { iss, b } = run('fir64');
    expect(iss.steps).toBe(4550);
    expect(b.outs).toBe(64);
    expect((iss.steps - 6) / b.outs).toBe(64 + 7);
    quotes('circbuf', 4550, 63, 71, '(4,550 − 6) / 64');
  });
  it('bit-reversed: the orders, every place once, the base bits, the wrong modifier, the FFT', () => {
    expect(addressRun(0, 6, 0, 0, 4, 8)).toEqual([0, 4, 2, 6, 1, 5, 3, 7]);
    expect(addressRun(0, 6, 0, 0, 32, 8)).toEqual([0, 32, 16, 48, 8, 40, 24, 56]);
    const all = addressRun(0, 6, 0, 0, 32, 65);
    expect(all.slice(0, 64)).toEqual(Array.from({ length: 64 }, (_, i) => rev(i, 6)));
    expect(all[64]).toBe(0);
    expect(addressRun(128, 6, 0, 0, 32, 4)).toEqual([128, 160, 144, 176]);
    expect(addressRun(0, 6, 0, 0, 128, 8)).toEqual([0, 128, 64, 192, 32, 160, 96, 224]);
    // a base that is not a multiple of N: no longer N distinct places of the table
    const off = addressRun(4, 6, 0, 0, 32, 64);
    expect(new Set(off).size === 64 && Math.min(...off) === 4 && Math.max(...off) === 67).toBe(false);
    expect(rev(1, 3)).toBe(4);
    expect(rev(3, 3)).toBe(6);
    const { iss, b } = run('fft');
    expect(iss.steps).toBe(4512);
    expect(b.macs).toBe(768);
    quotes('bitrev', 4512, 768, '0, 4, 2, 6, 1, 5, 3, 7', '0, 32, 16, 48, 8, 40, 24, 56');
  });
  it('zero-overhead loop: the unit, the dot product, the overhead, the comparison', () => {
    expect(figures.nands.loop).toBe(886);
    const { iss, b } = run('dot');
    expect(iss.steps).toBe(135);
    expect(b.macs).toBe(128);
    expect(b.src).toContain('loop  128, dot');
    expect(f2(dspPerProduct('fir16'))).toBe('1.45');
    expect(f2(dspPerProduct('fir64'))).toBe('1.11');
    expect(Math.round((100 * 7) / 71)).toBe(10);
    expect(Math.round((100 * 7) / 23)).toBe(30);
    expect((run('fir16').iss.steps - 6) / 32).toBe(16 + 7);
    quotes('hwloop', 886, 135, 128, '1.45', '1.11', '6.15', '7.18', '10 % of a 64-tap', '30 % of a 16-tap');
  });
});

describe('group E: speech', () => {
  it('μ-law: the curve, the table, the code, the formula, the SNRs, the gates', () => {
    const F = (x: number) => Math.log(1 + 255 * x) / Math.log(256);
    expect(Math.round(100 * F(0.01))).toBe(23);
    expect(Math.round(100 * F(0.1))).toBe(59);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((s) => ulawDecision(16 * s))).toEqual([31, 95, 223, 479, 991, 2015, 4063, 8159]);
    expect(ULAW_CLIP).toBe(8159);
    expect(ULAW_BITS).toBe(14);
    // the step 2 wide in the first segment, doubling to 256 in the eighth (decoded values of neighbouring codes)
    for (let s = 1; s <= 8; s++) expect(ulawDecode(255 - 16 * (s - 1) - 1) - ulawDecode(255 - 16 * (s - 1)), `segment ${s}`).toBe(2 ** s);
    // the code, the encoder's rule (+33, top bit, four bits below) and the decoder's formula, over everything
    for (let m = 0; m < ULAW_CLIP; m++) {
      const v = m + 33, e = Math.floor(Math.log2(v)) - 5, step = (v >> (e + 1)) & 15;
      expect(255 - ulawEncode(m), `encode ${m}`).toBe(e * 16 + step);
    }
    for (let n = 0; n < 128; n++) expect(ulawDecode(255 - n), `decode ${n}`).toBe(((33 + 2 * (n & 15)) << (n >> 4)) - 33);
    expect(ulawEncode(0)).toBe(0xff);
    expect([0, 1, 100, 1000, 8000].map((n) => ulawEncode(n).toString(16).toUpperCase())).toEqual(['FF', 'FE', 'DF', 'AF', '80']);
    expect([0, 1, 100, 1000, 8000].map((n) => ulawDecode(ulawEncode(n)))).toEqual([0, 2, 99, 1023, 8031]);
    expect(ulawFields(ulawEncode(1))).toMatchObject({ segment: 1, step: 1 });
    expect(ulawFields(ulawEncode(100))).toMatchObject({ segment: 3, step: 0 });
    expect(ulawFields(ulawEncode(1000))).toMatchObject({ segment: 6, step: 0 });
    expect(ulawFields(ulawEncode(8000))).toMatchObject({ segment: 8, step: 15 });
    expect(127 - (ulawEncode(82) & 127)).toBe(28);
    expect(f1(127 * F(0.01))).toBe('29.0');
    expect(2 ** (ULAW_BITS - 8)).toBe(64);
    const mu = (v: number) => ulawDecode(ulawEncode(Math.round(v))), snr = (db: number, c: (v: number) => number) => f1(sineSnr(ULAW_CLIP * 10 ** (db / 20), c));
    expect([snr(-40, mu), snr(-40, uniform(8))]).toEqual(['34.4', '11.1']);
    expect([snr(-20, mu), snr(-20, uniform(8))]).toEqual(['38.0', '29.6']);
    expect([snr(-6, mu), snr(-6, uniform(8))]).toEqual(['36.7', '43.9']);
    expect(ulawQuantized(1)).toBeGreaterThan(0);
    expect([stats(ulawEncoder()).nands, stats(ulawDecoder()).nands]).toEqual([442, 652]);
    says('speech', 2, 'Decoding is ((33 + 2m) ≪ e) − 33');
    quotes('mulaw', '23 %', '59 %', 255, '0xFF', '34.4', '11.1', '36.7', '43.9', 442, 652, '8,031', '8,159', '2,015', '4,063', '1,023', '38.0', '29.6', '29.0', '28 of 127');
  });
  it('ADPCM: the table, the index, the code, a step response, the rates', () => {
    expect(IMA_STEPS.length).toBe(89);
    expect([IMA_STEPS[0], IMA_STEPS[88]]).toEqual([7, 32767]);
    expect(IMA_INDEX).toEqual([-1, -1, -1, -1, 2, 4, 6, 8]);
    expect(f2((IMA_STEPS[88] / IMA_STEPS[0]) ** (1 / 88))).toBe('1.10');
    // a code m stands for (m + ½) quarter-steps (step 16 is index 8)
    for (let m = 0; m < 8; m++) expect(adpcmDecodeOne(m, { pred: 0, index: 8 }), `code ${m}`).toBe(((2 * m + 1) * 16) / 8);
    const s = { pred: 0, index: 0 }, rows: string[] = [];
    for (let i = 1; i <= 10; i++) { const c = adpcmEncodeOne(1000, s); rows.push(`${i} ${c} ${s.pred} ${s.index} ${IMA_STEPS[s.index]}`); }
    expect(rows).toEqual(['1 7 11 8 16', '2 7 41 16 34', '3 7 104 24 73', '4 7 240 32 157', '5 7 533 40 337', '6 5 996 44 494', '7 0 1057 43 449', '8 8 1001 42 408', '9 8 950 41 371', '10 0 996 40 337']);
    expect(4 * 8000).toBe(32000);
    expect(SPEECH_FIGS.adpcmSnr).toBe(18);
    expect(SPEECH_FIGS.muSnr).toBe(37.3);
    expect(SPEECH_FIGS.rvPerSample).toBe(39.2);
    expect(adpcmOnRv([0, 100, 200, 300, 400]).perSample).toBeGreaterThan(30);
    says('speech', 4, 'the table of 89 steps about 10 % apart that the Interactive Multimedia Association (IMA) set out');
    says('speech', 4, '32 kb/s');
    quotes('adpcm', 89, 7, '32,767', 18, 37.3, 39.2, '32 kb/s', '1,057', '1,001', '996', 494, 337, 'quarter-steps');
  });
  it('linear prediction: the example solved, the frame, the gain', () => {
    const d = durbin([1, 8 / 9, 0.6222222222222222], 2);
    expect(d.a.map(f1)).toEqual(['1.6', '-0.8']);
    expect([f2(d.k[0]), f1(d.k[1])]).toEqual(['0.89', '-0.8']);
    expect(f1(100 * d.err)).toBe('7.6');
    expect(f1(10 * Math.log10(1 / d.err))).toBe('11.2');
    expect(f2(Math.sqrt(0.8))).toBe('0.89');
    expect(Math.round((Math.acos(1.6 / (2 * Math.sqrt(0.8))) / (2 * Math.PI)) * 8000)).toBe(590);
    let pk = -Infinity, at = 0;
    for (let f = 0.001; f < 0.5; f += 0.0005) { const v = lpcEnvelopeDb(d.a, f); if (v > pk) { pk = v; at = f; } }
    expect(Math.round(at * 8000)).toBe(576);
    expect(VOC.win / 8).toBe(30);
    expect(VOC.order).toBe(10);
    expect(PRE).toBe(0.9375);
    expect(SPEECH_FIGS.predGain).toBe(6.6);
    // reflection coefficients inside ±1 for a real frame (seeded noise through the same Levinson)
    let seed = 7;
    const noise = Array.from({ length: VOC.win }, () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x40000000 - 1; });
    const k = durbin(autocorr(noise, 10), 10).k;
    expect(k.length).toBe(10);
    for (const v of k) expect(Math.abs(v)).toBeLessThan(1);
    expect(lpc(noise, 10).length).toBe(10);
    says('speech', 6, '1 − 0.9375 z');
    quotes('lpc', '0.9375', '6.6', '576 Hz', '590 Hz', '7.6 %', '11.2 dB', '1.6', '−0.8', '0.8889', '0.6222', '240 samples', '30 ms');
  });
  it('vocoder: the bit budget, the rates, the voiced share and pitch', () => {
    expect(VOC_BITS.k).toEqual([5, 5, 5, 5, 4, 4, 4, 4, 3, 2]);
    expect(VOC_BITS.k.reduce((a, b) => a + b, 0)).toBe(41);
    expect([VOC_BITS.pitch, VOC_BITS.gain, VOC_BITS.sync]).toEqual([7, 5, 1]);
    expect(vocBitsPerFrame()).toBe(54);
    expect(VOC.hop).toBe(180);
    expect((1000 * VOC.hop) / 8000).toBe(22.5);
    expect(vocBitRate()).toBe(2400);
    expect(Math.round(64000 / vocBitRate())).toBe(27);
    expect(Math.round(32000 / vocBitRate())).toBe(13);
    expect([SPEECH_FIGS.voicedPct, SPEECH_FIGS.pitchHz]).toEqual([59, 127]);
    says('speech', 7, '54 bits a frame');
    quotes('vocoder', 41, 54, '2,400', 27, 13, '22.5 ms', 59, 127, '64,000', '32,000', 180);
  });
});

describe('group E: music', () => {
  it('MDCT: the window, the alias of one frame, the cancellation, the sizes', () => {
    const M = MDCT_M, w = sineWindow(M);
    expect(M).toBe(256);
    for (let n = 0; n < M; n++) expect(Math.abs(w[n] ** 2 + w[n + M] ** 2 - 1)).toBeLessThan(1e-15);
    const x = Array.from({ length: 2 * M }, (_, i) => Math.sin(i * 0.07) + 0.4 * Math.cos(i * 0.9) + ((i * 37) % 11) / 11);
    const y = imdct(mdct(x));
    for (let n = 0; n < M; n++) expect(y[n]).toBeCloseTo(w[n] * (w[n] * x[n] - w[M - 1 - n] * x[M - 1 - n]), 10);
    for (let n = M; n < 2 * M; n++) expect(y[n]).toBeCloseTo(w[n] * (w[n] * x[n] + w[3 * M - 1 - n] * x[3 * M - 1 - n]), 10);
    expect(Math.max(...y.map((v, i) => Math.abs(v - x[i])))).toBeGreaterThan(0.01);
    const long = Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.31)), back = mdctRoundTrip(long);
    expect(Math.max(...back.map((v, i) => Math.abs(v - long[i])))).toBeLessThan(1e-12);
    expect(mdct(x).length).toBe(M);
    expect([2 * M, 1000 * M / 16000, 16000 / 2 / M]).toEqual([512, 16, 31.25]);
    expect(2 * M * M).toBe(131072);
    quotes('mdct', 131072, '31.25', '512', '16 ms', 256, '10−12');
  });
  it('masking: the model\'s constants, the closed form against maskDb, the floor, the codec table', () => {
    expect(MASK).toEqual({ down: 25, up: 10, offset: 14, fullScaleSpl: 96 });
    const bs = bands(16000), L = -20, lev = bs.map((_, i) => (i === 10 ? L : -100));
    const mask = maskDb(lev, bs, 16000);
    for (const j of [9, 11]) {
      const dz = bs[j].bark - bs[10].bark, expected = L + (dz >= 0 ? -MASK.up * dz : MASK.down * dz) - MASK.offset;
      expect(mask[j], `band ${j}`).toBeCloseTo(expected, 1);
    }
    expect(L - MASK.up - MASK.offset).toBe(-44);
    expect(L - MASK.down - MASK.offset).toBe(-59);
    expect([f1(quietDb(1000)), f1(quietDb(100))]).toEqual(['3.4', '23.0']);
    expect(MUSIC_FIGS).toMatchObject({
      mask64Rate: 49.4, mask64Audible: 1, mask64Snr: 21.4, signal64Rate: 63.9, signal64Audible: 11.3, signal64Snr: 49.4,
      mask32Rate: 31.7, mask32Audible: 17.3, mask32Snr: 21.3, signal32Rate: 31.9, signal32Audible: 28.4, signal32Snr: 35,
      mask16Rate: 15.9, mask16Audible: 49.3, mask16Snr: 13, signal16Rate: 15.9, signal16Audible: 58.4, signal16Snr: 17.5,
    });
    expect(bandPowersDb(new Float64Array(MDCT_M), bs).length).toBe(bs.length);
    says('music', 3, `${MUSIC_FIGS.mask64Rate} kb/s`);
    quotes('masking', 25, 10, 14, 96, '−44', '−59', '3.4 dB', '23.0', '49.4', '63.9', '11.3', '21.4', '1.0 %', '31.7', '17.3', '28.4', '49.3', '58.4', '15.9', '13.0', '17.5', '35.0', '21.3', '31.9', '6 dB');
  });
  it('Bark: Zwicker\'s values, Hz a Bark, the bands of a frame', () => {
    expect([100, 500, 1000, 4000, 8000, 16000].map((f) => f2(bark(f)))).toEqual(['0.99', '4.74', '8.51', '17.26', '21.28', '24.09']);
    expect(f1(bark(20000))).toBe('24.6');
    expect(Math.round(400 / (bark(500) - bark(100)))).toBe(107);
    expect(f2(bark(500) - bark(100))).toBe('3.75');
    expect(f2(bark(8000) - bark(4000))).toBe('4.02');
    expect(Math.round(4000 / (bark(8000) - bark(4000)) / 100) * 100).toBe(1000);
    const bs = bands(16000), widths = bs.map((b) => b.hi - b.lo);
    expect(bs.length).toBe(20);
    expect(widths[0]).toBe(4);
    expect(widths[19]).toBe(28);
    expect([Math.min(...widths), Math.max(...widths)]).toEqual([4, 36]);
    expect(widths[0] * 31.25).toBe(125);
    expect(widths[19] * 31.25).toBe(875);
    quotes('barkscale', '0.99', '4.74', '8.51', '17.26', '21.28', '24.09', '24.6', 107, '3.75', '4.02', 20, 125, 875, 28, 4, 36);
  });
});

describe('group E: the software radio', () => {
  it('oscillator: the step, the tuning word, the spurs, the cost, the modem\'s register', () => {
    expect(FS).toBe(960000);
    expect(NCO_BITS).toBe(16);
    expect(f2(FS / 2 ** NCO_BITS)).toBe('14.65');
    expect(tuningWord(-300000)).toBe(45056);
    expect(tuningWord(-300000).toString(16)).toBe('b000');
    expect(wordHz(45056)).toBe(-300000);
    expect(trailingZeros(45056)).toBe(12);
    expect(2 ** (NCO_BITS - 12)).toBe(16);
    expect([4, 6, 8, 9, 10].map((k) => f1(mixerSfdr(k)))).toEqual(['23.5', '36.0', '48.1', '52.8', '52.8']);
    expect([4, 6, 8, 9].map((k) => tableRow(k).nands)).toEqual([902, 3146, 13658, 29176]);
    expect(NCO_K).toBe(6);
    says('modem', 2, '13-bit register');
    quotes('nco', '14.65', '45,056', '0xB000', 12, 16, '23.5', '36.0', '48.1', '52.8', 902, '3,146', '13,658', '960,000', '65,536');
  });
  it('complex mixer: the product, the gain, the wrap, the gates, a station at zero', () => {
    const m = nandsOf();
    expect([m.mixer, m.nco]).toEqual([9554, 3146]);
    expect(f3(NCO_AMP / 2 ** NCO_SHIFT)).toBe('0.992');
    expect([W_IN, W_MIX, NCO_SHIFT]).toEqual([10, 11, 7]);
    const f = STATIONS[0].f;
    expect(f).toBe(-300000);
    expect(STATIONS[3].f - f).toBe(640000);
    expect(STATIONS[3].f - f - FS).toBe(-320000);
    expect(FS / 2).toBe(480000);
    // the station tuned to is mixed to a constant: the oscillator\'s 16 phase points all sit on the table
    const mix = new MixModel(tuningWord(f), 6), outs: number[] = [];
    for (let n = 0; n < 64; n++) {
      const th = (2 * Math.PI * f * n) / FS;
      outs.push(mix.edge(Math.round(100 * Math.cos(th)), Math.round(100 * Math.sin(th))).yr);
    }
    expect(Math.max(...outs) - Math.min(...outs)).toBeLessThanOrEqual(2);
    says('sdr', 3, 'The whole mixer is 9 554 NANDs'.replace('9 554', '9554'));
    quotes('complexmixer', '9,554', '3,146', '127 / 128', '0.992', '−300 kHz', '+340 kHz', '+640 kHz', '−320 kHz', '±480 kHz', '±127', 11);
  });
  it('discriminator: the readings, the range, Carson', () => {
    expect([FS_CIC, DEV]).toEqual([240000, 50000]);
    const read = (f: number, a: number) => {
      const N = 400, re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) { re[i] = a * Math.cos((2 * Math.PI * f * i) / FS_CIC); im[i] = a * Math.sin((2 * Math.PI * f * i) / FS_CIC); }
      return discriminate(re, im)[200].toFixed(3);
    };
    expect([read(50000, 1), read(25000, 1), read(-50000, 1), read(25000, 0.1)]).toEqual(['1.000', '0.500', '-1.000', '0.500']);
    expect(FS_CIC / 2).toBe(120000);
    expect(Math.round((100 * DEV) / (FS_CIC / 2))).toBe(42);
    expect(carson(50000, 15000)).toBe(130000);
    expect(f2(modIndex(50000, 15000))).toBe('3.33');
    says('sdr', 6, 'angle of z');
    quotes('fmdiscriminator', '1.000', '0.500', '−1.000', 240, 120, '42 %', 130, '3.33', 50, 15, '0.1');
  });
  it('emphasis: α, the corner, the lifts, the exact inverse, unity at the top', () => {
    expect([AUD, TAU]).toEqual([24000, 75e-6]);
    expect(f2(ALPHA)).toBe('0.57');
    expect(ALPHA.toFixed(3)).toBe('0.574');
    expect(Math.round(1 / (2 * Math.PI * TAU))).toBe(2122);
    const corner = 1 / (2 * Math.PI * TAU);
    expect([1000, corner, 5000, 10000].map((f) => f2(analogueLiftDb(f)))).toEqual(['0.87', '3.01', '8.16', '13.66']);
    expect([1000, corner, 5000, 10000].map((f) => f2(preLiftDb(f)))).toEqual(['0.85', '2.90', '7.54', '11.07']);
    const m = new Float64Array(2000).map((_, i) => Math.sin(i * 0.3) + 0.5 * Math.sin(i * 1.7));
    const back = deEmphasis(preEmphasis(m));
    for (let i = 0; i < m.length; i++) expect(Math.abs(back[i] - m[i])).toBeLessThan(1e-4);
    const alt = new Float64Array(200).map((_, i) => (i % 2 ? -1 : 1)), pre = preEmphasis(alt);
    expect(Math.abs(pre[199])).toBeCloseTo(1, 6);
    says('sdr', 7, 'α = 0.574');
    quotes('emphasis', '2,122', '13.66', '11.07', '0.574', '3.01', '8.16', '7.54', '0.87', '0.85', '2.90', '75 µs', '24 kHz');
  });
});

const f3 = (x: number) => x.toFixed(3);
