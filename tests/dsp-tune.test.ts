// "Tune it" (dsp/tune.ts): the parts of the capstone that are not a whole grade. The gates' blocks at the learner's sizes against the model, the
// decoder on a clean keyed tone, the chain's rules, the prices, finding the practice station, and hints that never give a setting.

import { describe, expect, it } from 'vitest';
import { signedOf, wordOf } from '../src/comm/signals';
import { CicModel, cicWidth } from '../src/dsp/multirate';
import { W_MIX } from '../src/dsp/sdr';
import {
  BAND_EDGE, BLOCK_NAME, chainCost, checkChain, cicRun, decodeMorse, DEFAULT_CHAIN, findSpectrum, findStation, hintsFor, keyingOf, makeBand, MESSAGES, MORSE_CODE, PRACTICE_SEED, REFERENCE_CHAIN,
  sampleBand, unitOwners, UNIT_S, type Cause, type Chain, type GatePrices,
} from '../src/dsp/tune';
import { cicDecimator } from '../src/lib/multirate';
import { complexMixer } from '../src/lib/sdr';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { tick } from './yieldtick';

const lcg = (seed: number) => { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; };
const randWord = (r: () => number, w: number) => Math.floor(r() * 2 ** w) - 2 ** (w - 1);
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
  it('name blocks, never a number', () => {
    const worst = { station: 1, offKhz: 0, db: 0, foldedTo: 1, block: 'CIC ÷ R', spurDb: 9, breaks: true };
    const causes: Cause[] = [
      { kind: 'tune-fixed', hz: 1 }, { kind: 'tune-none', marginDb: 1 }, { kind: 'tune-wrong', hz: 1, offKhz: 1 }, { kind: 'tone-cut', lossDb: 1 }, { kind: 'too-narrow', lossDb: 1 },
      { kind: 'disc-rate', rate: 1 }, { kind: 'cordic', stages: 1 }, { kind: 'noise', cnDb: 1 }, { kind: 'decoder' },
      { kind: 'interference', ciDb: 1, worst, together: false }, { kind: 'interference', ciDb: 1, worst: { ...worst, block: null, spurDb: 0 }, together: true },
      { kind: 'interference', ciDb: 1, worst: { ...worst, block: 'Half-band ÷ 2' }, together: false },
    ];
    // a block's own name may hold a figure ("÷ 2"); nothing else may
    for (const c of causes) for (const h of hintsFor(c, DEFAULT_CHAIN)) expect(Object.values(BLOCK_NAME).reduce((s, n) => s.split(n.toLowerCase()).join(''), h)).not.toMatch(/\d/);
  });
});
