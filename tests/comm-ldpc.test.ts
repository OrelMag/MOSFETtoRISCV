// LDPC and the concatenated code on their models (comm/ldpc.ts): belief propagation against brute force, finite codes against density evolution, thresholds two ways.
import { describe, expect, it } from 'vitest';
import { convSoftBound, shannonBinaryDb, sigmaOf, uncodedBer } from '../src/comm/ber';
import {
  awgnThreshold, becThreshold, becThresholdMin, Bp, bpDecode, channelLlr, concatRate, concatTrial, deAwgn, deBecBits, designRate, ebn0OfSigma, encoderOf, erasures, fourCycles, ldpcTrial, mapMarginals, peel, regularCode, rsWordFailure,
  syndromeOk, tannerOf,
} from '../src/comm/ldpc';
import { qFunc, rng } from '../src/phys/line';
import { tick } from './yieldtick';

// A tree: seven variables, three checks, no cycle anywhere.
const TREE = tannerOf(7, [[0, 1, 2], [2, 3, 4], [4, 5, 6]]);

describe('belief propagation', () => {
  it('reproduces the exact marginals on a graph without cycles', () => {
    const u = rng(5);
    for (let trial = 0; trial < 40; trial++) {
      const ch = Array.from({ length: 7 }, () => (u() - 0.5) * 8), exact = mapMarginals(TREE, ch), d = new Bp(TREE, ch);
      for (let i = 0; i < 6; i++) d.iterate();
      for (let v = 0; v < 7; v++) expect(d.post[v], `trial ${trial} v${v}`).toBeCloseTo(exact[v], 9);
    }
  });
  it('a single check gives the tanh rule, and a repeat adds LLRs', () => {
    const one = new Bp(tannerOf(3, [[0, 1, 2]]), [1.5, -0.7, 2]);
    one.iterate();
    expect(one.post[0]).toBeCloseTo(1.5 + 2 * Math.atanh(Math.tanh(-0.35) * Math.tanh(1)), 12);
    const rep = new Bp(tannerOf(3, [[0, 1], [1, 2]]), [1, 2, 3]);
    rep.iterate(); rep.iterate();
    expect(Array.from(rep.post).every((x) => Math.abs(x - 6) < 1e-9)).toBe(true);
  });
  it('min-sum with no normalization is the tanh rule\'s limit for large messages', () => {
    const big = tannerOf(3, [[0, 1, 2]]), ch = [20, -30, 25];
    const a = new Bp(big, ch), b = new Bp(big, ch, { kind: 'min-sum', alpha: 1 });
    a.iterate(); b.iterate();
    expect(b.post[0]).toBeCloseTo(a.post[0], 1);
  });
  it('does not care which code word was sent: decisions map exactly, for both decoders', () => {
    const t = regularCode(204, 3, 6, 9), enc = encoderOf(t), u = rng(3);
    expect(enc.k).toBeGreaterThanOrEqual(102);
    for (const kind of ['sum-product', 'min-sum'] as const) for (let trial = 0; trial < 4; trial++) {
      const c = enc.encode(Array.from({ length: enc.k }, () => (u() < 0.5 ? 1 : 0)));
      expect(syndromeOk(t, c)).toBe(true);
      const zero = channelLlr(new Uint8Array(t.n), 1.5, 0.5, u), flipped = zero.map((x, i) => (c[i] ? -x : x));
      const a = bpDecode(t, zero, { kind, maxIter: 30 }), b = bpDecode(t, flipped, { kind, maxIter: 30 });
      expect(b.iterations).toBe(a.iterations);
      for (let i = 0; i < t.n; i++) expect(b.hard[i] ^ c[i], `bit ${i}`).toBe(a.hard[i]);
    }
  });
});

describe('the code', () => {
  it('is regular, reproducible from its seed, and free of 4-cycles', () => {
    const t = regularCode(1008, 3, 6, 1), again = regularCode(1008, 3, 6, 1), other = regularCode(1008, 3, 6, 2);
    expect(designRate(t)).toBe(0.5);
    expect(fourCycles(t)).toBe(0);
    expect(Array.from(again.edgeVar)).toEqual(Array.from(t.edgeVar));
    expect(Array.from(other.edgeVar)).not.toEqual(Array.from(t.edgeVar));
    for (let v = 0; v < t.n; v++) expect(t.varOff[v + 1] - t.varOff[v]).toBe(3);
    for (let c = 0; c < t.m; c++) expect(t.chkOff[c + 1] - t.chkOff[c]).toBe(6);
  });
  it('rejects a size that does not divide', () => expect(() => regularCode(1001)).toThrow());
});

describe('the erasure channel', () => {
  it('the threshold comes out the same both ways, and is the published value', () => {
    const a = becThreshold(), b = becThresholdMin();
    expect(a).toBeCloseTo(b, 6);
    // arXiv:1102.5087 (Uchikawa, Kasai, Sakaniwa), section on regular codes: "the BP threshold of the (3,6)-regular LDPC code 0.4294"
    expect(a.toFixed(4)).toBe('0.4294');
    expect(a).toBeLessThan(0.5); // capacity at rate ½
  });
  it('the decoder follows the recursion round by round on a long code', () => {
    const t = regularCode(20000), n = t.n;
    for (const eps of [0.4, 0.45]) {
      const r = peel(t, erasures(n, eps, 3)), de = deBecBits(eps, 6);
      for (let l = 0; l <= 6; l++) expect(Math.abs(r.erased[l] / n - de[l]), `ε ${eps} round ${l}`).toBeLessThan(0.015);
    }
  });
  it('decodes everything below the threshold and stalls where the recursion stalls above it', () => {
    const t = regularCode(20000);
    expect(peel(t, erasures(t.n, 0.41, 7)).left).toBe(0);
    const stall = deBecBits(0.45, 5000), r = peel(t, erasures(t.n, 0.45, 7));
    expect(r.left / t.n).toBeCloseTo(stall[stall.length - 1], 1);
    expect(r.left).toBeGreaterThan(0.25 * t.n);
  });
});

describe('the Gaussian channel', () => {
  it('density evolution starts at the channel and brackets its threshold', () => {
    const sigma = 0.88;
    expect(deAwgn(sigma, 3, 6, { rounds: 1 }).p[0]).toBeCloseTo(qFunc(1 / sigma), 2);
    expect(deAwgn(0.875, 3, 6, { rounds: 3000 }).converged).toBe(true);
    expect(deAwgn(0.89, 3, 6, { rounds: 3000 }).converged).toBe(false);
  }, 60000);
  it('a threshold about 0.9 dB above the binary-input Shannon limit', () => {
    const s = awgnThreshold(0.875, 0.89, 3, 6, { bits: 3 }), db = ebn0OfSigma(s), lim = shannonBinaryDb(0.5);
    expect(s).toBeGreaterThan(0.875); expect(s).toBeLessThan(0.89);
    expect(db - lim).toBeGreaterThan(0.8); expect(db - lim).toBeLessThan(1.05);
  }, 60000);
  it('the messages of a long code follow density evolution round by round', async () => {
    const t = regularCode(20000, 3, 6, 4), sigma = 1 / Math.sqrt(2 * 0.5 * 10 ** (1.5 / 10)), de = deAwgn(sigma, 3, 6, { step: 0.0625, rounds: 6 });
    expect(sigma).toBeCloseTo(sigmaOf(1.5, 0.5), 12);
    const u = rng(11), d = new Bp(t, channelLlr(new Uint8Array(t.n), 1.5, 0.5, u));
    for (let l = 0; l <= 4; l++) {
      let wrong = 0;
      for (let e = 0; e < t.edgeVar.length; e++) if (d.post[t.edgeVar[e]] - d.c2v[e] < 0) wrong++;
      const got = wrong / t.edgeVar.length;
      expect(Math.abs(got - de.p[l]) / de.p[l], `round ${l}: ${got} against ${de.p[l]}`).toBeLessThan(0.06);
      d.iterate();
      await tick();
    }
  });
  it('a long code has a waterfall at the threshold, and beats K = 7 soft and Shannon\'s neighbourhood', async () => {
    const t = regularCode(10000, 3, 6, 2), below = ldpcTrial(t, 0.8, 3), above = ldpcTrial(t, 1.8, 6);
    expect(below.ber).toBeGreaterThan(0.02);
    expect(above.errors).toBe(0);
    await tick();
    // at 1.8 dB: well past the union bound of the K = 7 soft decoder and the raw channel
    expect(convSoftBound({ K: 7, g: [0o133, 0o171], name: '' }, 1.8)).toBeGreaterThan(1e-3);
    expect(uncodedBer(1.8)).toBeGreaterThan(0.03);
    // a short one pays for its length with a shallower, later fall
    const short = regularCode(504, 3, 6, 2), s18 = ldpcTrial(short, 1.8, 120), s32 = ldpcTrial(short, 3.2, 120);
    expect(s18.frameErrors).toBeGreaterThan(10);
    expect(s32.ber).toBeLessThan(s18.ber / 8);
  }, 60000);
  it('normalized min-sum gives up little, plain min-sum more', async () => {
    const t = regularCode(2000, 3, 6, 6), db = 1.9;
    const sp = ldpcTrial(t, db, 60, { seed: 3 }); await tick();
    const ms8 = ldpcTrial(t, db, 60, { seed: 3, kind: 'min-sum', alpha: 0.8 }); await tick();
    const ms1 = ldpcTrial(t, db, 60, { seed: 3, kind: 'min-sum', alpha: 1 });
    expect(sp.ber).toBeLessThanOrEqual(ms8.ber);
    expect(ms8.ber).toBeLessThan(ms1.ber);
  }, 60000);
});

describe('the concatenated code', () => {
  it('counts its rate, and a clean-enough channel leaves nothing', () => {
    expect(concatRate()).toBeCloseTo((0.5 * 223) / 255, 12);
    const r = concatTrial(3.2, { depth: 2, frames: 1, seed: 4 });
    expect(r.words).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.dataBitErrors).toBe(0);
    expect(r.innerBits).toBe(2 * 255 * 8);
  });
  it('with the bytes spread, its word failures follow the binomial tail of the byte errors', async () => {
    let words = 0, failed = 0, bytes = 0, byteErrors = 0;
    for (let f = 0; f < 10; f++) { const r = concatTrial(2.2, { depth: 8, frames: 1, seed: 100 + f }); words += r.words; failed += r.failed; bytes += r.bytes; byteErrors += r.byteErrors; await tick(); }
    const P = byteErrors / bytes, pred = rsWordFailure(255, 16, P);
    expect(P).toBeGreaterThan(0.02);
    expect(Math.abs(failed / words - pred), `failed ${failed} of ${words}, P ${P}, closed form ${pred}`).toBeLessThan(0.1);
  }, 60000);
  it('the closed form is the binomial tail', () => {
    expect(rsWordFailure(3, 0, 0.5)).toBeCloseTo(7 / 8, 12);
    expect(rsWordFailure(3, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(rsWordFailure(255, 16, 0)).toBe(0);
  });
  it('without interleaving, a run past the inner decoder costs a word more often', async () => {
    // the inner decoder'''s errors come in runs, so bytes wrong together reach t more often in the same word
    let plain = 0, spread = 0, words = 0;
    for (let f = 0; f < 8; f++) {
      const a = concatTrial(2.3, { depth: 1, frames: 16, seed: 300 + f }), b = concatTrial(2.3, { depth: 8, frames: 2, seed: 300 + f });
      plain += a.failed; spread += b.failed; words += a.words;
      await tick();
    }
    expect(words).toBe(128);
    expect(plain, `${plain} against ${spread}`).toBeGreaterThan(2 * spread + 4);
  }, 60000);
});
