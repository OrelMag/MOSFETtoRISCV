// Group C of the Signal processing level's codex entries (IIR and stability, changing the rate, CORDIC): every number they quote equal to the dsp/ models, the library
// or the chapter step that prints it. Completeness and form are tests/content-codexdsp.test.ts's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { codexById } from '../src/campaign/codex';
import { CHECKS } from '../src/campaign/codexcheck';
import { CODEX_C } from '../src/campaign/codexdspc';
import { moreOf } from '../src/campaign/codexmore';
import { chapterById } from '../src/chapters';
import { directUnstable, held, NARROW_POLE, RES, sensitivity, stableFrom, sweepOnce, zeroSweepOnce } from '../src/chapters/ch-dsp-iir';
import { atanTable, cordicStretch } from '../src/dsp/cordic';
import { analogGain, analogPrototype, burstThenSilence, BQ, coefWord, deadBand, findCycle, LIMIT_CYCLE, pairPeak, prewarp, runBiquad, sampledPole, warpedAt } from '../src/dsp/iir';
import { cicAliasDb, cicDcGain, cicGrowth, cicResponse, cicTaps, cicWidth, decimateDirect, halfBand, nonZero, polyphaseCost, polyphaseDecimate, upsample } from '../src/dsp/multirate';
import { polyRoots } from '../src/dsp/zplane';
import { biquad } from '../src/lib/biquad';
import { cordicIterative, cordicPipeline, cordicStage } from '../src/lib/cordic';
import { cicDecimator, POLY_SPEC, polyDecimator } from '../src/lib/multirate';
import { treeMul } from '../src/lib/muldiv';
import { stats } from '../src/sim/stats';
import { biquadCost, dbfs, designRows, firstStableWidth } from '../src/widgets/dspiir';
import { cascade, CIC_IN, CIC_N, CIC_R } from '../src/widgets/dspmultirate';
import { cordicBits } from '../src/widgets/dspcordic';

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
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
const TAU = 2 * Math.PI;
const mul16 = () => nands(treeMul(16, true));
const mul8 = () => nands(treeMul(8, true));
const minus = (x: number, d: number) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`;

describe('group C: summaries stay within the shape', () => {
  for (const e of CODEX_C) it(`${e.id}: 150 to 700 characters`, () => {
    expect(e.body.length).toBeGreaterThanOrEqual(150);
    expect(e.body.length).toBeLessThanOrEqual(700);
  });
});

describe('group C: iir', () => {
  const by = (id: string) => designRows().find((r) => r.id === id)!;
  it('IIR filter: one mask, four designs', () => {
    const pm = by('pm'), bu = by('butter'), ch = by('cheby1'), el = by('ellip');
    expect([pm.mults, bu.mults, ch.mults, el.mults, el.folded]).toEqual([58, 93, 35, 20, 16]);
    expect([pm.size, bu.size, ch.size, el.size]).toEqual(['115 taps', 'order 37, 19 sections', 'order 14, 7 sections', 'order 8, 4 sections']);
    expect((pm.mults / el.mults).toFixed(1)).toBe('2.9');
    expect(el.mults).toBe(4 * 5);
    const r = polyRoots([1, -1.5, 0.7]);
    expect(r[0].re).toBeCloseTo(0.75, 12);
    expect(Math.abs(r[0].im).toFixed(3)).toBe('0.371');
    expect(Math.sqrt(0.7).toFixed(3)).toBe('0.837');
    quotes('iirfilter', 58, 93, 35, 20, 16, 115, '0.125', '2.9', '0.75 ± 0.371j', '0.837', 'order 37, 19 sections', 'order 14, 7 sections', 'order 8, 4 sections', '60 dB', '0.1 dB');
    says('iir', 0, `${el.mults}`);
    says('iir', 0, '0.2 and 0.25');
  });
  it('bilinear transform: where an edge lands', () => {
    expect(warpedAt(TAU * 0.1).toFixed(4)).toBe('0.0969');
    expect(warpedAt(TAU * 0.4).toFixed(3)).toBe('0.286');
    expect(prewarp(0.2).toFixed(3)).toBe('1.453');
    expect((TAU * 0.2).toFixed(3)).toBe('1.257');
    expect(warpedAt(TAU * 0.2).toFixed(3)).toBe('0.179');
    expect(warpedAt(prewarp(0.2))).toBeCloseTo(0.2, 12);
    expect((TAU * 0.1).toFixed(3)).toBe('0.628');
    expect((TAU * 0.4).toFixed(3)).toBe('2.513');
    // z = (2 + s) / (2 − s)
    const z = (re: number, im: number) => { const nr = 2 + re, ni = im, dr = 2 - re, di = -im, d = dr * dr + di * di; return [(nr * dr + ni * di) / d, (ni * dr - nr * di) / d]; };
    expect(z(-2, 0)).toEqual([0, 0]);
    expect(z(-1, 0)[0]).toBeCloseTo(1 / 3, 12);
    expect(z(0, 0)).toEqual([1, 0]);
    expect(z(0, 2)).toEqual([0, 1]);
    quotes('bilinear', '0.0969', '0.286', '1.453', '1.257', '0.179', '0.628', '2.513', '0.2π', 'z = (2 + s) / (2 − s)');
    says('iir', 2, `${warpedAt(TAU * 0.4).toFixed(3)}`);
  });
  it('s-plane: the RC, a pole pair, Butterworth 2 and a sampled pole, from dsp/iir.ts', () => {
    const rc = [{ re: -1e4, im: 0 }], fc = 1 / (TAU * 1e-4), at = (f: number) => (20 * Math.log10(analogGain(rc, [], TAU * f)));
    expect(fc.toFixed(1)).toBe('1591.5'); expect(Math.round(fc / 10)).toBe(159); expect(Math.round(fc * 10)).toBe(15915);
    expect([at(fc / 10).toFixed(3), at(fc).toFixed(2), at(fc * 10).toFixed(2)]).toEqual(['-0.043', '-3.01', '-20.04']);
    expect(Math.exp(-3).toFixed(3)).toBe('0.050');
    const pk = pairPeak(-0.3, 2)!;
    expect(pk.at.toFixed(3)).toBe('1.977'); expect((20 * Math.log10(pk.gain)).toFixed(2)).toBe('10.65');
    const b = analogPrototype('butter', 2).p[0];
    expect([b.re.toFixed(4), Math.abs(b.im).toFixed(4)]).toEqual(['-0.7071', '0.7071']);
    const sp = sampledPole({ re: -0.5, im: 0.5 });
    expect([sp.r.toFixed(3), sp.f.toFixed(4)]).toEqual(['0.607', '0.0796']);
    quotes('splane', 'H(s) = 1 / (1 + sRC)', '−1 / RC', '100 µs', '−3.01 dB', '1591.5 Hz', 'z = e^(sT)', '−10 000 s⁻¹', '−0.043 dB', '−20.04 dB', '15 915 Hz',
      '0.050', '+10.65 dB at 1.977 rad/s', '−0.7071 ± j0.7071', 'radius 0.607, 0.0796 cycles a sample');
    says('iir', 1, 'H(s) = 1 / (1 + sRC)');
  });
  it('biquad: the section in gates', () => {
    const n = nands(biquad()), m = mul16(), c0 = biquadCost();
    expect(n).toBe(c0.nands);
    expect(m).toBe(c0.mul);
    expect(5 * m).toBe(17860);
    expect(n - 5 * m).toBe(2453);
    expect(Math.round((100 * 5 * m) / n)).toBe(88);
    expect(c0.depth).toBe(135);
    expect(BQ.accW).toBe(BQ.prod + 3);
    expect(Math.ceil(Math.log2(5))).toBe(3);
    expect((0.95 ** 2 * 2 ** 14).toFixed(2)).toBe('14786.56'); // rounds to the chapter's word
    expect(coefWord(0.95 ** 2)).toBe(14787);
    expect(LIMIT_CYCLE.words.a2).toBe(14787);
    quotes('biquad', c(n), c(m), '17,860', '2,453', c(c0.depth), '35 bits', '88 %', '14,787', '0.9025', '0.95');
    says('iir', 5, c(n).replace(/,/g, ' '));
  });
  it('coefficient sensitivity: the lattice and the narrow filter', () => {
    const k6 = held(RES, 6), k5 = held(RES, 5), k4 = held(RES, 4);
    expect(k6.radius.toFixed(3)).toBe('0.968');
    expect([k6.a1, k6.a2, k6.step]).toEqual([-1.875, 0.9375, 1 / 16]);
    expect([k5.a1, k5.a2, k5.radius, k5.state]).toEqual([-1.875, 1, 1, 'on the circle']);
    expect([k4.a1, k4.a2, k4.state]).toEqual([-2, 1, 'unstable']);
    expect(k5.asked.a2.toFixed(4)).toBe('0.9409');
    expect(k5.step).toBe(1 / 8);
    expect((Math.atan2(k5.roots[0].im, k5.roots[0].re) / TAU).toFixed(3)).toBe('0.057');
    expect(k4.step).toBe(1 / 4);
    const un = directUnstable();
    expect([un[0], un[un.length - 1], un.length]).toEqual([8, 19, 12]);
    expect(firstStableWidth()).toBe(20);
    expect(stableFrom(NARROW_POLE)).toBe(8);
    const s = sensitivity();
    expect(Math.round(s.direct)).toBe(3021);
    expect(s.sections.toFixed(1)).toBe('6.5');
    expect(Math.round(s.direct / s.sections / 10) * 10).toBe(470);
    expect(3 * 5 - 13).toBe(2);
    quotes('coefsens', '0.057', '0.968', '−1.875', '0.9375', '0.9409', '3,021', '6.5', '470', '8 … 19', 'from 20', '0.97', '0.04', '1/16', '1/8', '1/4');
    says('iir', 3, `radius ${k5.radius.toFixed(3)}`);
    says('iir', 4, `${un[0]} to ${un[un.length - 1]} bits`);
  });
  it('limit cycle: the cycle and the sweeps', () => {
    const w = LIMIT_CYCLE.words, ys = runBiquad(w, burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, 800)), cy = findCycle(ys, 16)!;
    const a2 = w.a2 / 2 ** BQ.cf;
    expect(cy.seq).toEqual([5, 0, -5, 0]);
    expect([cy.start, cy.period, cy.peak, LIMIT_CYCLE.amp, LIMIT_CYCLE.burst]).toEqual([87, 4, 5, 8000, 1]);
    expect(a2.toFixed(4)).toBe('0.9025');
    expect(deadBand(w.a2).toFixed(2)).toBe('5.13');
    expect((0.5 / (1 - 0.9025)).toFixed(2)).toBe('5.13');
    expect((a2 * 5).toFixed(2)).toBe('4.51');
    for (let y = 1; y <= 5; y++) expect(Math.round(a2 * y)).toBe(y);
    expect(Math.round(a2 * 6)).toBe(5);
    expect((a2 * 6).toFixed(1)).toBe('5.4');
    expect(Math.trunc(a2 * 5)).toBe(4);
    expect(Math.trunc(a2 * 4)).toBe(3);
    expect((a2 * 4).toFixed(2)).toBe('3.61');
    expect(Math.round(dbfs(cy.peak))).toBe(-76);
    const sw = sweepOnce();
    expect([sw.runs, ...sw.cycling]).toEqual([176, 176, 59, 0, 22, 0]);
    const zs = zeroSweepOnce(), at = (r: number) => zs.find((x) => x.r === r)!;
    expect(zs[0].runs).toBe(294);
    expect([at(0.98).cycling, at(0.99).cycling, at(0.995).cycling]).toEqual([2, 1, 1]);
    for (const r of [0.9, 0.93, 0.95, 0.97, 0.975]) expect(at(r).cycling).toBe(0);
    quotes('limitcycle', '14,787', '5, 0, −5, 0', '5.13', '8,000', '4.51', '0.9025', '176', '59', '22', '294', '87', '−76 dBFS', '0.975', '0.98', '0.995', '3.61', '5.4');
    says('iir', 6, '5, 0, -5, 0');
    says('iir', 7, '0.975');
  });
});

describe('group C: multirate', () => {
  it('decimation: a fold and a job', () => {
    for (let k = 0; k < 40; k++) {
      const want = Math.cos(TAU * 0.2 * k);
      expect(Math.cos(TAU * 0.3 * 4 * k)).toBeCloseTo(want, 9);
      expect(Math.cos(TAU * 0.45 * 4 * k)).toBeCloseTo(want, 9);
    }
    expect((0.3 * 4).toFixed(1)).toBe('1.2');
    expect(Math.abs(1.2 - Math.round(1.2)).toFixed(1)).toBe('0.2');
    expect((0.45 * 4).toFixed(1)).toBe('1.8');
    const r = cascade();
    expect(r.map((x) => x.mults.toFixed(2))).toEqual(['1037.00', '16.20', '4.03', '1.05']);
    expect(r[0].note).toBe('1037 taps');
    expect(Math.round(r[0].mults / r[3].mults)).toBe(991);
    quotes('decimation', '1,037', '16.2', '4.03', '1.05', '0.3', '1.2', '0.2', '1.8', '0.45', '÷ 64', '50 dB', '40 %', '60 %');
    says('multirate', 0, '1 037');
    says('multirate', 8, r[3].mults.toFixed(2));
    says('radio', 4, 'decimate');
  });
  it('interpolation: the images of a tone up by 4', () => {
    const L = 4, N = 400, f = 0.1, x = Array.from({ length: N }, (_, k) => Math.cos(TAU * f * k)), up = upsample(x, L);
    expect(up.length).toBe(N * L);
    for (let i = 0; i < up.length; i++) expect(up[i]).toBe(i % L === 0 ? x[i / L] : 0);
    const mag = (g: number) => { let re = 0, im = 0; up.forEach((v, n) => { re += v * Math.cos(TAU * g * n); im -= v * Math.sin(TAU * g * n); }); return Math.hypot(re, im) / up.length * 2; };
    const peaks = [f / L, 1 / L - f / L, 1 / L + f / L, 1 / 2 - f / L];
    expect(peaks.map((p) => +p.toFixed(3))).toEqual([0.025, 0.225, 0.275, 0.475]);
    const ref = mag(peaks[0]);
    for (const p of peaks) expect(mag(p)).toBeCloseTo(ref, 6);
    for (const p of [0.1, 0.2, 0.3, 0.4, 0.125]) expect(mag(p), `${p}`).toBeLessThan(ref / 20);
    expect(64 / 4).toBe(16);
    quotes('interpolation', '0.025', '0.225', '0.275', '0.475', '0.125', '16', '256');
    says('multirate', 4, 'resample_poly');
  });
  it('polyphase: the same products, and the gates', () => {
    const h = Array.from({ length: 64 }, (_, i) => ((i * 37) % 23) - 11), x = Array.from({ length: 300 }, (_, i) => ((i * 53) % 41) - 20);
    expect(polyphaseDecimate(h, 8, x)).toEqual(decimateDirect(h, 8, x));
    expect(polyphaseCost(64, 8)).toBe(8);
    const { R, M, w } = POLY_SPEC;
    expect([R, M, w, R * M]).toEqual([4, 4, 8, 16]);
    const m = mul8(), n = nands(polyDecimator(POLY_SPEC));
    expect(m).toBe(972);
    expect(M * m).toBe(3888);
    expect(R * M * m).toBe(15552);
    expect(n).toBe(7809);
    expect(2 * w + Math.round(Math.log2(R * M))).toBe(20);
    quotes('polyphase', 64, 8, 972, '3,888', '15,552', c(n), 20, '16 taps');
    says('multirate', 3, c(n).replace(/,/g, ' '));
    says('multirate', 3, `${2 * w + Math.round(Math.log2(R * M))} bits`);
  });
  it('half-band: the zeros', () => {
    const hb = halfBand(23), mid = 11;
    expect(nonZero(hb)).toBe(13);
    hb.forEach((v, i) => { const d = Math.abs(i - mid); expect(v === 0, `distance ${d}`).toBe(d !== 0 && d % 2 === 0); });
    expect((nonZero(hb) - 1) / 2).toBe(6); // and a shift for the middle tap, exactly ½
    expect(hb[(hb.length - 1) / 2]).toBeCloseTo(0.5, 12);
    expect(1 + 12).toBe(13);
    expect((7 / 23).toFixed(2)).toBe('0.30');
    const r = cascade();
    expect(r[2].mults.toFixed(2)).toBe('4.03');
    expect(r[2].note).toContain('13 taps at the first, 35 at the last');
    quotes('halfband', 23, 13, 7, '0.30', '4.03', '1,037', '13 taps', '35 taps', '12', '±11');
    says('multirate', 4, `${nonZero(hb)} that are not zero`);
  });
  it('CIC: growth, nulls and gates', () => {
    expect([CIC_N, CIC_R, CIC_IN]).toEqual([3, 8, 8]);
    expect(cicWidth(CIC_N, CIC_R, CIC_IN)).toBe(17);
    expect(cicGrowth(CIC_N, CIC_R)).toBe(9);
    expect(cicGrowth(4, 16)).toBe(16);
    expect(cicDcGain(CIC_N, CIC_R)).toBe(512);
    expect(-128 * 512).toBe(-(2 ** 16));
    const t = cicTaps(3, 8);
    expect([t.length, t.reduce((a, b) => a + b, 0)]).toEqual([22, 512]);
    expect(cicResponse(3, 8, 1 / 8)).toBeLessThan(1e-12);
    expect(cicResponse(3, 8, 1 / 16).toFixed(3)).toBe('0.263');
    expect((20 * Math.log10(cicResponse(3, 8, 1 / 16))).toFixed(1)).toBe('-11.6');
    expect(Math.round(-cicAliasDb(3, 16, 0.1))).toBe(57);
    expect((-20 * Math.log10(cicResponse(3, 16, 0.4 / 64))).toFixed(2)).toBe('0.43');
    const n = nands(cicDecimator(CIC_N, CIC_R, CIC_IN));
    expect(n).toBe(3010);
    quotes('cic', 17, 512, c(n), '22 taps', '0.263', '−11.6 dB', '57 dB', '0.43 dB', '65,536', '1981', '16 more bits', '8³');
    says('multirate', 5, '1981');
    says('multirate', 7, c(n).replace(/,/g, ' '));
  });
});

describe('group C: cordic', () => {
  const S = { w: 14, z: 14, n: 12 };
  /** Float CORDIC: rotating steers z to 0, vectoring y to 0. */
  const rot = (x: number, y: number, z: number, n: number) => { const left: number[] = []; for (let i = 0; i < n; i++) { const d = z >= 0 ? 1 : -1; [x, y, z] = [x - d * y * 2 ** -i, y + d * x * 2 ** -i, z - d * Math.atan(2 ** -i)]; left.push((z * 180) / Math.PI); } return { x, y, z, left }; };
  const vec = (x: number, y: number, n: number) => { let z = 0; for (let i = 0; i < n; i++) { const d = y < 0 ? 1 : -1; [x, y, z] = [x - d * y * 2 ** -i, y + d * x * 2 ** -i, z - d * Math.atan(2 ** -i)]; } return { x, y, z: (z * 180) / Math.PI }; };
  const K = 1 / cordicStretch(24);
  it('CORDIC: the rotation, the angles and the costs', () => {
    const a = atanTable({ w: 14, z: 14, n: 4 }).map((v) => (v / 2 ** 14) * 360);
    expect(a.map((v) => v.toFixed(2))).toEqual(['45.00', '26.56', '14.04', '7.12']);
    expect([45, (Math.atan(0.5) * 180) / Math.PI, (Math.atan(0.25) * 180) / Math.PI, (Math.atan(0.125) * 180) / Math.PI].map((v) => v.toFixed(2))).toEqual(['45.00', '26.57', '14.04', '7.13']);
    expect(((Math.atan(0.125) * 180) / Math.PI).toFixed(3)).toBe('7.125');
    expect(((Math.atan(1 / 16) * 180) / Math.PI).toFixed(2)).toBe('3.58');
    let sum = 0;
    for (let i = 0; i < 24; i++) sum += (Math.atan(2 ** -i) * 180) / Math.PI;
    expect(sum.toFixed(1)).toBe('99.9');
    const r = rot(1 / cordicStretch(12), 0, (30 * Math.PI) / 180, 12);
    expect(r.left.slice(0, 6).map((v) => v.toFixed(3))).toEqual(['-15.000', '11.565', '-2.471', '4.654', '1.077', '-0.712']);
    expect(r.x.toFixed(5)).toBe('0.86591');
    expect(r.y.toFixed(5)).toBe('0.50020');
    expect(Math.cos((30 * Math.PI) / 180).toFixed(5)).toBe('0.86603');
    expect(Math.hypot(r.x, r.y).toFixed(4)).toBe('1.0000');
    const v = vec(3, 4, 12);
    expect(v.x.toFixed(4)).toBe('8.2338');
    expect((v.x * K).toFixed(1)).toBe('5.0');
    expect((5 / K).toFixed(4)).toBe('8.2338');
    expect(v.z.toFixed(2)).toBe('53.11');
    expect(((Math.atan2(4, 3) * 180) / Math.PI).toFixed(2)).toBe('53.13');
    const stage = nands(cordicStage(S, 3)), pipe = nands(cordicPipeline(S)), it0 = nands(cordicIterative(S)), m = mul16();
    expect([stage, pipe, it0, m]).toEqual([564, 15537, 2551, 3572]);
    expect(4 * m).toBe(14288);
    expect(cordicBits(S).toFixed(1)).toBe('9.0');
    expect(S.n + 1).toBe(13);
    quotes('cordic', 564, c(pipe), c(it0), c(m), '14,288', '9.0', '13 clocks', '26.57', '14.04', '7.13', '99.9', '1959', '−15.000°', '11.565°', '−2.471°', '4.654°', '1.077°', '−0.712°', '0.86591', '0.50020', '0.86603', '8.2338', '53.11°', '53.13°', '7.125', '3.58', '0.607253', '1.6468');
    says('cordic', 3, c(stage).replace(/,/g, ' '));
    says('cordic', 1, '99.9');
  });
  it('CORDIC gain: the product and the start value', () => {
    expect(cordicStretch(24).toFixed(4)).toBe('1.6468');
    expect(K.toFixed(6)).toBe('0.607253');
    expect([1, 2, 3].map((n) => cordicStretch(n).toFixed(4))).toEqual(['1.4142', '1.5811', '1.6298']);
    expect([0, 1, 2, 3].map((i) => Math.sqrt(1 + 2 ** (-2 * i)).toFixed(4))).toEqual(['1.4142', '1.1180', '1.0308', '1.0078']);
    expect(cordicStretch(12).toFixed(4)).toBe('1.6468');
    expect(Math.hypot(rotLen(1), 0).toFixed(4)).toBe('1.6468');
    expect(Math.hypot(rotLen(1 / cordicStretch(12)), 0).toFixed(4)).toBe('1.0000');
    expect((Math.SQRT2 / K).toFixed(2)).toBe('2.33');
    quotes('cordicgain', '1.6468', '0.607253', '1.4142', '1.5811', '1.6298', '1.118', '1.0308', '1.0078', '2.33', '1.0000');
    says('cordic', 2, (1 / K).toFixed(4));
    says('cordic', 2, K.toFixed(6));
    says('cordic', 2, (Math.SQRT2 / K).toFixed(2));
    function rotLen(x0: number) { const r = rot(x0, 0, (30 * Math.PI) / 180, 12); return Math.hypot(r.x, r.y); }
  });
});

void minus;
