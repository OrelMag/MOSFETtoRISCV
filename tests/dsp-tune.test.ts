// "Tune it" (dsp/tune.ts): the parts of the capstone that are not a whole grade. The gates' blocks at the learner's sizes against the model, the
// decoder on a clean keyed tone, the chain's rules, the prices, finding the practice station, and hints that never give a setting.

import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { CicModel, cicWidth } from '../src/dsp/multirate';
import { W_MIX } from '../src/dsp/sdr';
import {
  BAND_EDGE, BLOCK_NAME, blockCosts, chainCost, checkChain, cicRun, decodeMorse, DEFAULT_CHAIN, discCordic, discPhase, findSpectrum, findStation, fmtKhz, foldPath, halfBandTaps, hintsFor,
  keyingOf, makeBand, MESSAGES, MORSE_CODE, PRACTICE_SEED, REFERENCE_CHAIN, sampleBand, unitOwners, UNIT_S, type Block, type Cause, type Chain, type GatePrices,
} from '../src/dsp/tune';
import { cicDecimator } from '../src/lib/multirate';
import { complexMixer } from '../src/lib/sdr';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { tick } from './yieldtick';

const lcg = (seed: number) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
const randWord = (r: () => number, w: number) => Math.floor(r() * 2 ** w) - 2 ** (w - 1);
/** The practice band, pinned: the seed's draws alone make a band, the same in every engine. */
const PRACTICE_PIN = ['SOS', 750, [[171_000, 'morse', -38], [356_000, 1, 0], [61_000, 0, -3], [-308_000, 2, -6]]];
const prices: GatePrices = { mixer: (k) => stats(complexMixer(k)).nands, cic: (N, R, w) => stats(cicDecimator(N, R, w)).nands };

describe('the CICs at the learner\'s sizes', () => {
  it('cicRun equals CicModel word for word, wrapping and all', () => {
    const r = lcg(3);
    for (const [N, R] of [[1, 2], [3, 8], [5, 16], [5, 4], [2, 4]]) {
      const w = cicWidth(N, R, W_MIX), x = Int32Array.from({ length: 3000 }, () => randWord(r, W_MIX)), m = new CicModel(N, R, w), out: number[] = [];
      for (const v of x) { m.edge(v); if (m.valid) out.push(m.y); }
      expect(Array.from(cicRun(x, N, R, w))).toEqual(out);
    }
  });
  it('and equals the gates (lib/multirate.ts) on every output, for sizes the chapter never draws', async () => {
    const r = lcg(8);
    for (const [N, R] of [[3, 8], [5, 2], [1, 16]]) {
      const w = cicWidth(N, R, W_MIX), sim = new BitSim(flatten(cicDecimator(N, R, W_MIX))), x = Int32Array.from({ length: 1200 }, () => randWord(r, W_MIX)), got: number[] = [];
      for (const v of x) {
        sim.setInput('x', [wordOf(v, W_MIX)]);
        sim.cycle();
        if (sim.get('valid', 1)[0]) got.push(signedOf(sim.get('y', 1)[0], w));
      }
      expect(got).toEqual(Array.from(cicRun(x, N, R, w)));
      await tick();
    }
  }, 120_000);
});

describe('Morse', () => {
  it('keys the code: a dot a unit, a dash three, gaps of one, three and seven', () => {
    expect(keyingOf('SOS')).toBe('10101' + '000' + '11101110111' + '000' + '10101');
    expect(keyingOf('E E')).toBe('1' + '0000000' + '1');
    for (const m of MESSAGES) { expect(unitOwners(m).length).toBe(keyingOf(m).length); for (const c of m.replace(/ /g, '')) expect(MORSE_CODE[c]).toBeDefined(); }
  });
  it('the decoder reads a clean keyed tone exactly, at any rate', () => {
    for (const rate of [24_000, 8_000, 3_000]) for (const msg of ['SOS', 'CQ DE', '73 GL']) {
      const k = keyingOf(msg), lead = 0.15, n = Math.round((lead + k.length * UNIT_S + 0.25) * rate), x = new Float64Array(n);
      for (let i = 0; i < n; i++) { const u = Math.floor((i / rate - lead) / UNIT_S); if (u >= 0 && u < k.length && k[u] === '1') x[i] = Math.sin((2 * Math.PI * 700 * i) / rate); }
      expect(decodeMorse(x, rate, 'auto').text).toBe(msg);
    }
  });
});

describe('a chain', () => {
  it('the default and the reference run', () => {
    expect(checkChain(DEFAULT_CHAIN).problem).toBeNull();
    expect(checkChain(REFERENCE_CHAIN).problem).toBeNull();
    expect(checkChain(DEFAULT_CHAIN).rates.at(-1)!.outRate).toBe(24_000);
  });
  it('refuses what cannot run, saying why', () => {
    const d = DEFAULT_CHAIN, bad: [Chain, RegExp][] = [
      [d.slice(1), /starts with the mixer/],
      [[d[0], d[2], d[1], ...d.slice(3)], /CIC is gates/],
      [[d[0], d[1], d[3], d[2], ...d.slice(4)], /before the discriminator/],
      [d.slice(0, -1), /Morse decoder/],
      [[d[0], d[1], d[2], d[4], d[3], d[5]], /after the discriminator/],
      [[d[0], d[1], d[2], d[3], { kind: 'audio', taps: 81, cutoff: 10_000, M: 7 }, d[5]], /do not divide by 7/],
      [[d[0], d[1], { kind: 'channel', taps: 40, cutoff: 50_000 }, ...d.slice(3)], /odd number of taps/],
      [[d[0], d[1], { kind: 'channel', taps: 41, cutoff: 200_000 }, ...d.slice(3)], /cutoff/],
      [[d[0], d[1], d[2], d[3], { kind: 'audio', taps: 81, cutoff: 600, M: 240 }, d[5]], /too few/],
    ];
    for (const [c, why] of bad) expect(checkChain(c).problem).toMatch(why);
  });
  it('costs what the gates count, and the mockup\'s 18 190 NANDs for the chapter\'s front end', () => {
    expect(chainCost(DEFAULT_CHAIN, prices).nands).toBe(stats(complexMixer(6)).nands + 2 * stats(cicDecimator(4, 4, W_MIX)).nands);
    expect(chainCost(DEFAULT_CHAIN, prices).nands).toBe(18_190);
    // the chapter's channel and audio filters: 2 × 41 × 240 k and 81 × 24 k, and the discriminator's four products a sample
    expect(chainCost(DEFAULT_CHAIN, prices).mults).toBe(2 * 41 * 240_000 + 4 * 240_000 + 81 * 24_000);
    const two: Chain = [DEFAULT_CHAIN[0], { kind: 'cic', N: 3, R: 4 }, { kind: 'cic', N: 2, R: 2 }, ...DEFAULT_CHAIN.slice(2)];
    expect(chainCost(two, prices).nands).toBe(stats(complexMixer(6)).nands + 2 * stats(cicDecimator(3, 4, W_MIX)).nands + 2 * stats(cicDecimator(2, 2, cicWidth(3, 4, W_MIX))).nands);
  });
});

describe('the bands', () => {
  it('are the same for a seed, and keep every station inside the band and apart', () => {
    for (let s = 0; s < 40; s++) {
      const b = makeBand(s);
      expect(makeBand(s)).toEqual(b);
      for (const st of b.stations) expect(Math.abs(st.f)).toBeLessThanOrEqual(BAND_EDGE);
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(Math.abs(b.stations[i].f - b.stations[j].f)).toBeGreaterThanOrEqual(104_000);
      // the three traps: a loud station where a CIC ÷ 4 folds it in, one close beside, one elsewhere
      const off = b.stations.slice(1).map((st) => Math.abs(st.f - b.stations[0].f));
      expect(off[0]).toBeGreaterThanOrEqual(175_000); expect(off[0]).toBeLessThanOrEqual(205_000); expect(b.stations[1].a).toBe(1);
      expect(off[1]).toBeGreaterThanOrEqual(108_000); expect(off[1]).toBeLessThanOrEqual(124_000);
    }
  });
  it('"find it" at the reference\'s margin finds the practice station to a fraction of a bin', () => {
    const b = makeBand(PRACTICE_SEED), { xr, xi } = sampleBand(b), f = findStation(findSpectrum(xr, xi), 15);
    expect(Math.abs(f.hz! - b.stations[b.weak].f)).toBeLessThan(300);
  });
});

describe('hints', () => {
  it('give a direction, never a number, and only a change the chain can still make', () => {
    const worst = { station: 1, offKhz: 0, db: 0, foldedTo: 1, block: 'cic' as const, whole: true, atGates: 1, spurDb: 9, breaks: true };
    const causes: Cause[] = [
      { kind: 'tune-fixed', hz: 1 }, { kind: 'tune-none', marginDb: 1 }, { kind: 'tune-wrong', hz: 1, offKhz: 1 }, { kind: 'tone-cut', lossDb: 1 }, { kind: 'too-narrow', lossDb: 1 },
      { kind: 'disc-rate', rate: 1 }, { kind: 'cordic', stages: 1 }, { kind: 'noise', cnDb: 1, stationsToo: false }, { kind: 'decoder' }, { kind: 'unknown' },
      { kind: 'interference', ciDb: 1, worst, together: false }, { kind: 'interference', ciDb: 1, worst: { ...worst, block: null, spurDb: 0 }, together: true },
      { kind: 'interference', ciDb: 1, worst: { ...worst, block: 'halfband' as const }, together: false },
    ];
    // a block's own name may hold a figure ("÷ 2"); nothing else may
    for (const c of causes) for (const h of hintsFor(c, DEFAULT_CHAIN)) expect(Object.values(BLOCK_NAME).reduce((s, n) => s.split(n.toLowerCase()).join(''), h)).not.toMatch(/\d/);
    // a fifth-order CIC ÷ 2 behind a ten-bit table: nothing left to raise or lower there
    const top: Chain = [{ ...REFERENCE_CHAIN[0], bits: 10 } as Block, { kind: 'cic', N: 5, R: 2 }, ...REFERENCE_CHAIN.slice(2)];
    expect(hintsFor({ kind: 'interference', ciDb: 1, worst, together: false }, top).join(' | ')).not.toMatch(/higher CIC order|smaller CIC ratio|finer oscillator/);
  });
});

describe('the parts the grade reasons with', () => {
  it('a band is the same in every engine: the practice band, pinned', () => {
    const b = makeBand(PRACTICE_SEED);
    expect([b.message, b.toneHz, b.stations.map((s) => [s.f, s.prog, Math.round(20 * Math.log10(s.a))])]).toEqual(PRACTICE_PIN);
  });
  it('a station folds where the arithmetic says, whole or in part', () => {
    const c = DEFAULT_CHAIN; // CIC ÷ 4: 240 kHz out, Nyquist 120 kHz
    expect(foldPath(c, 199_000)).toMatchObject({ block: 'cic', whole: true });
    expect(foldPath(c, 199_000).foldedTo).toBeCloseTo(-41_000);
    expect(foldPath(c, -199_000).foldedTo).toBeCloseTo(41_000);
    expect(foldPath(c, 120_000)).toMatchObject({ block: 'cic', whole: false });
    expect(foldPath(c, 30_000)).toMatchObject({ block: null, foldedTo: null, atGates: 30_000 });
    // past 240 kHz at a CIC ÷ 2: folds there to −180 kHz (where the plot after the gates shows it), then again at the half-band
    const two: Chain = [c[0], { kind: 'cic', N: 4, R: 2 }, { kind: 'halfband', taps: 23 }, ...c.slice(2)];
    const p = foldPath(two, 300_000);
    expect(p.block).toBe('cic'); expect(p.foldedTo).toBeCloseTo(-180_000); expect(p.atGates).toBeCloseTo(-180_000);
  });
  it('the CORDIC discriminator agrees with the phase step to its stated angle error, at any level', () => {
    const n = 4000, rate = 240_000, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { const ph = 2 * Math.PI * ((30_000 * i) / rate + 0.3 * Math.sin(i / 37)), g = 0.01 * (1 + 0.9 * Math.sin(i / 11)); re[i] = g * Math.cos(ph); im[i] = g * Math.sin(ph); }
    const a = discPhase(re, im, rate);
    for (const st of [6, 12]) {
      const b = discCordic(re, im, rate, st), bound = ((Math.atan(2 ** -(st - 1)) + 2 ** -11) / (2 * Math.PI)) * (rate / 50_000);
      let worst = 0;
      for (let i = 1; i < n; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      expect(worst).toBeLessThanOrEqual(bound);
    }
  });
  it('refuses CICs wider than the gates hold', () => {
    const c: Chain = [DEFAULT_CHAIN[0], { kind: 'cic', N: 5, R: 16 }, { kind: 'cic', N: 5, R: 2 }, { kind: 'channel', taps: 41, cutoff: 10_000 }, DEFAULT_CHAIN[3], { kind: 'morse', threshold: 'auto' }];
    expect(checkChain(c).problem).toMatch(/at most 32/);
  });
  it('prices each kind of block', () => {
    const c: Chain = [DEFAULT_CHAIN[0], { kind: 'cic', N: 4, R: 2 }, { kind: 'halfband', taps: 23 }, { kind: 'poly', taps: 31, R: 2 }, { kind: 'channel', taps: 41, cutoff: 50_000 },
      { kind: 'disc', method: 'cordic', stages: 10 }, { kind: 'deemph' }, { kind: 'audio', taps: 63, cutoff: 3000, M: 5 }, { kind: 'morse', threshold: 'auto' }];
    const k = blockCosts(c, prices);
    expect(k[2].mults).toBe(2 * halfBandTaps(23).filter((v) => v !== 0).length * 240_000);
    expect(k[3].mults).toBe(2 * 31 * 120_000);
    expect(k[4].mults).toBe(2 * 41 * 120_000);
    expect(k[5]).toEqual({ nands: 0, mults: 4 * 120_000, angles: 10 * 120_000 });
    expect(k[6].mults).toBe(2 * 120_000);
    expect(k[7].mults).toBe(63 * 24_000);
  });
  it('never writes −0', () => {
    expect(fmtKhz(-200)).toBe('0 kHz');
    expect(fmtKhz(-1_600)).toBe('−2 kHz');
    expect(fmtKhz(41_000)).toBe('+41 kHz');
  });
});
