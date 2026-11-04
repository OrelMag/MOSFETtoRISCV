// Chapter 47's stronger codes, the models: published vectors, distances computed from the generators, and the closed-form curves against
// seeded runs of the real encoders and decoders.
//
// Sources, fetched 2026-11-04 (not recalled):
// - Convolutional: IEEE 802.11-99/077a, proposed Annex E (the OFDM worked example), tables 7 and 8: the SIGNAL field and its rate 1/2 coding.
//   Read from the document 2026-11-04: its table 7 lists bit 0 = LENGTH LSB and the rate in bits 12-15. The FINAL standard puts the rate in
//   bits 0-3 (reserved 4, length 5-16, parity 17, tail 18-23), so this vector is the draft's, not the final Annex G's; nothing claims the latter.
// - Reed-Solomon: Wikiversity, "Reed-Solomon codes for coders" (a QR sample, 0x11D, first root α^0) and Thonky's QR tutorial (HELLO WORLD 1-M).
// - d_free = 10 with 11 paths at that weight for the K = 7 code: US patent 7636397's statement of the best rate 1/2, K = 7 code.
import { describe, expect, it } from 'vitest';
import { berlekampMassey, gfMul, gfPow, GF_EXP, GF_LOG, rsBer, rsDecode, rsEncode, rsGenerator, rsStep, rsSyndromes } from '../src/comm/rs';
import { CONV_K3, CONV_K7, Viterbi, bmMax, convEncode, convStep, metricWidth, spectrum, statesOf, viterbiDecode } from '../src/comm/conv';
import { biAwgnCapacity, trialSeed, channelP, codingGain, convHardBound, convSoftBound, convTrial, ebn0For, quantize, rsCurve, secdedBer, secdedTrial, shannonBinaryDb, shannonDb, sigmaOf, uncodedBer } from '../src/comm/ber';
import { burstChannel, burstRate, burstTolerance, deinterleave, interleave, placeOf, secdedOverBursts, worstPerWord } from '../src/comm/interleave';
import { rng } from '../src/phys/line';
import { ADSL } from '../src/comm/modem';
import { blockOf, PATTERNS, smallestSample, swing1010 } from '../src/comm/fourier';
import { burstOutcome, burstVerdict } from '../src/widgets/codes';
import { tick } from './yieldtick';

const near = (x: number, y: number, rel: number) => expect(Math.abs(x - y) / y, `${x} vs ${y}`).toBeLessThan(rel);

describe('convolutional encoder', () => {
  it('the 802.11 task group\'s 1999 proposed annex (99/077a, tables 7 and 8): its SIGNAL field, 24 bits in that draft\'s order (length first), codes to its 48', () => {
    const signal = [0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    const coded = [0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0];
    expect(convEncode(CONV_K7, signal)).toEqual(coded);
  });
  it('the impulse response of each output is its generator, most significant bit first', () => {
    for (const s of [CONV_K3, CONV_K7]) {
      const out = convEncode(s, [1, ...new Array<number>(s.K - 1).fill(0)]);
      const a = out.filter((_, i) => i % 2 === 0), b = out.filter((_, i) => i % 2 === 1);
      expect(parseInt(a.join(''), 2)).toBe(s.g[0]);
      expect(parseInt(b.join(''), 2)).toBe(s.g[1]);
    }
  });
  it('free distances from the generators: 5 for (7, 5), 10 with 11 paths for (133, 171)', () => {
    const k3 = spectrum(CONV_K3, 8), k7 = spectrum(CONV_K7, 16);
    expect(k3.dfree).toBe(5);
    expect(k3.A.slice(5, 9)).toEqual([1, 2, 4, 8]);
    expect(k3.B.slice(5, 9)).toEqual([1, 4, 12, 32]); // the transfer function D^5 L / (1 - 2 D L)
    expect(k7.dfree).toBe(10);
    expect(k7.A[10]).toBe(11);
    expect(k7.A.slice(11, 16).filter((_, i) => i % 2 === 0)).toEqual([0, 0, 0]);
  });
});

describe('Viterbi model', () => {
  it('metric width: 4 bits for K = 3 hard, 5 for K = 7 hard, 8 for K = 7 with 3-bit levels', () => {
    expect(metricWidth(3, 1)).toBe(4);
    expect(metricWidth(7, 1)).toBe(5);
    expect(metricWidth(7, 3)).toBe(8);
  });
  it('recovers a clean stream, delayed by the depth', () => {
    for (const s of [CONV_K3, CONV_K7]) {
      const u = rng(3), D = 10 * s.K, bits = Array.from({ length: 400 }, () => (u() < 0.5 ? 1 : 0));
      const dec = viterbiDecode(s, convEncode(s, bits));
      for (let i = 0; i + D - 1 < bits.length; i++) expect(dec[i + D - 1]).toBe(bits[i]);
    }
  });
  it('corrects any two flipped channel bits in a K = 3 stream when they are far apart, and every (d_free - 1) / 2 = 2 flips however close', () => {
    const u = rng(9), bits = Array.from({ length: 80 }, () => (u() < 0.5 ? 1 : 0)), D = 30, coded = convEncode(CONV_K3, bits);
    for (let a = 30; a < 60; a++) for (let b = a + 1; b < 60; b++) {
      const rx = coded.slice(); rx[a] ^= 1; rx[b] ^= 1;
      const dec = viterbiDecode(CONV_K3, rx);
      for (let i = 0; i + D - 1 < bits.length; i++) expect(dec[i + D - 1], `flips ${a}, ${b}, bit ${i}`).toBe(bits[i]);
    }
  });
  it('metrics never spread to half their range, even on adversarial levels, and the wrap orders them as exact integers would', () => {
    for (const [s, q] of [[CONV_K3, 1], [CONV_K7, 1], [CONV_K7, 3]] as const) {
      const v = new Viterbi(s, { q, depth: 4 }), u = rng(5), n = statesOf(s), L = 2 ** q;
      const exact = new Float64Array(n), lim = (s.K - 1) * bmMax(q);
      for (let t = 0; t < 2000; t++) {
        const pick = () => (u() < 0.5 ? (u() < 0.5 ? 0 : L - 1) : Math.floor(u() * L));
        const r0 = pick(), r1 = pick();
        v.step(r0, r1);
        const nx = new Float64Array(n);
        for (let ns = 0; ns < n; ns++) {
          const un = ns >>> (s.K - 2), p0 = (ns << 1) & (n - 1), p1 = p0 | 1, c = [p0, p1].map((p) => { const e = convStep(s, p, un); const max = L - 1; return exact[p] + (e.a ? max - r0 : r0) + (e.b ? max - r1 : r1); });
          nx[ns] = c[1] < c[0] ? c[1] : c[0];
          expect(v.sel[ns], `t ${t} ns ${ns}`).toBe(c[1] < c[0] ? 1 : 0);
        }
        exact.set(nx);
        expect(v.spread()).toBeLessThanOrEqual(lim);
        const lo = Math.min(...exact);
        expect(Math.max(...exact) - lo).toBeLessThanOrEqual(lim);
      }
    }
  });
});

describe('Reed-Solomon model', () => {
  it('the field: α has order 255, multiplication agrees with shift-and-reduce', () => {
    expect(new Set(Array.from(GF_EXP.subarray(0, 255))).size).toBe(255);
    const slow = (a: number, b: number) => { let r = 0, x = a; for (let i = 0; i < 8; i++) { if ((b >> i) & 1) r ^= x; x <<= 1; if (x & 256) x ^= 0x11d; } return r; };
    for (let a = 0; a < 256; a += 3) for (let b = 0; b < 256; b += 5) expect(gfMul(a, b)).toBe(slow(a, b));
    expect(GF_LOG[2]).toBe(1);
  });
  it('published QR vectors: 10 check bytes on 16 data bytes', () => {
    expect(rsEncode([0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec], 10)).toEqual([0xbc, 0x2a, 0x90, 0x13, 0x6b, 0xaf, 0xef, 0xfd, 0x4b, 0xe0]);
    expect(rsEncode([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
  it('every code word vanishes at every root; the generator has them as roots', () => {
    const u = rng(2);
    for (const nsym of [4, 10, 32]) {
      const msg = Array.from({ length: 40 }, () => Math.floor(u() * 256));
      expect(rsSyndromes([...msg, ...rsEncode(msg, nsym)], nsym).every((x) => x === 0)).toBe(true);
      const g = rsGenerator(nsym);
      for (let i = 0; i < nsym; i++) { let v = 0; for (const c of g) v = gfMul(v, gfPow(i)) ^ c; expect(v).toBe(0); }
    }
  });
  it('the LFSR step is one byte of polynomial division', () => {
    const g = rsGenerator(4); let st = [0, 0, 0, 0];
    for (const b of [1, 2, 3, 4, 5]) st = rsStep(g, st, b);
    expect(st).toEqual(rsEncode([1, 2, 3, 4, 5], 4));
  });
  it('corrects any t byte errors, on every size tried', () => {
    const u = rng(4);
    for (const [k, nsym] of [[16, 10], [223, 32], [239, 16], [20, 4]] as const) for (let trial = 0; trial < 60; trial++) {
      const msg = Array.from({ length: k }, () => Math.floor(u() * 256)), cw = [...msg, ...rsEncode(msg, nsym)], rx = cw.slice();
      const t = Math.floor(u() * (nsym / 2 + 1)), at = new Set<number>();
      while (at.size < t) at.add(Math.floor(u() * cw.length));
      for (const p of at) rx[p] ^= 1 + Math.floor(u() * 255);
      const d = rsDecode(rx, nsym);
      expect(d.word).toEqual(cw);
      expect(d.fixed).toEqual([...at].sort((a, b) => a - b));
      expect(berlekampMassey(rsSyndromes(rx, nsym)).length - 1).toBe(t);
    }
  });
  it('t + 1 errors are refused or land on another code word, never returned as the sent word', () => {
    const u = rng(6);
    let refused = 0;
    for (let trial = 0; trial < 400; trial++) {
      const msg = Array.from({ length: 16 }, () => Math.floor(u() * 256)), cw = [...msg, ...rsEncode(msg, 10)], rx = cw.slice(), at = new Set<number>();
      while (at.size < 6) at.add(Math.floor(u() * cw.length));
      for (const p of at) rx[p] ^= 1 + Math.floor(u() * 255);
      const d = rsDecode(rx, 10);
      if (!d.word) { refused++; continue; }
      expect(d.word).not.toEqual(cw);
      expect(rsSyndromes(d.word, 10).every((x) => x === 0)).toBe(true);
    }
    expect(refused).toBeGreaterThan(380); // RS(26, 16): a miscorrection is rare
  });
  it('the closed form against the decoder on independent bit errors', () => {
    const u = rng(8), p = 0.03, n = 26, nsym = 10, words = 1500;
    let wrong = 0, bits = 0;
    for (let w = 0; w < words; w++) {
      const msg = Array.from({ length: 16 }, () => Math.floor(u() * 256)), cw = [...msg, ...rsEncode(msg, nsym)], rx = cw.map((b) => { let x = b; for (let i = 0; i < 8; i++) if (u() < p) x ^= 1 << i; return x; });
      const d = rsDecode(rx, nsym), got = d.word ?? rx;
      for (let i = 0; i < n; i++) { let x = got[i] ^ cw[i]; while (x) { wrong += x & 1; x >>>= 1; } bits += 8; }
    }
    near(wrong / bits, rsBer(n, 16, p), 0.25);
  });
});

describe('BER against Eb/N0', () => {
  it('rate scaling: a rate 1/2 code\'s channel bits see 3 dB less', () => {
    expect(channelP(6, 0.5)).toBeCloseTo(channelP(6 - 10 * Math.log10(2), 1), 12);
    expect(sigmaOf(0, 1)).toBeCloseTo(Math.SQRT1_2, 12);
    near(ebn0For(uncodedBer, 1e-5), 9.59, 0.002); // the textbook BPSK figure
  });
  it('Shannon: 0 dB at rate 1/2 unconstrained, -1.59 dB as the rate falls, about 0.19 dB with binary input', () => {
    expect(shannonDb(0.5)).toBeCloseTo(0, 9);
    expect(shannonDb(1e-6)).toBeCloseTo(-1.59, 2);
    expect(shannonBinaryDb(0.5)).toBeCloseTo(0.187, 2);
    expect(biAwgnCapacity(0.05)).toBeCloseTo(1, 6);
  });
  it('SEC-DED: the closed form against the real decoder', () => {
    const r = secdedTrial(6, 60000, 3);
    near(r.ber, secdedBer(6), 0.15);
  });
  it('Viterbi against the union bound: K = 7 soft and hard, K = 3 hard; the gain from three-bit levels is about 2 dB', async () => {
    const soft = convTrial(CONV_K7, 4, 300000, { q: 3, seed: 2 }); await tick();
    near(soft.ber, convSoftBound(CONV_K7, 3.75), 0.35); // three-bit levels lose the textbook quarter of a dB
    const shallow = convTrial(CONV_K7, 4, 300000, { q: 3, depth: 35, seed: 2 }); await tick();
    expect(shallow.ber).toBeGreaterThan(5 * soft.ber); // five constraint lengths are enough only when reading the best state
    const mid = convTrial(CONV_K7, 4, 300000, { q: 3, depth: 50, seed: 2 }); await tick();
    expect(mid.ber).toBeLessThan(2 * soft.ber); // seven are within a factor of two of the ten the model uses (measured 14 errors against 12)
    const hard = convTrial(CONV_K7, 5, 300000, { q: 1, seed: 3 }); await tick();
    expect(hard.ber).toBeLessThan(convHardBound(CONV_K7, 5) * 1.2);
    expect(hard.ber).toBeGreaterThan(convHardBound(CONV_K7, 5) * 0.1);
    const k3 = convTrial(CONV_K3, 5, 300000, { q: 1, seed: 4 }); await tick();
    expect(k3.ber).toBeLessThan(convHardBound(CONV_K3, 5) * 1.2);
    expect(k3.ber).toBeGreaterThan(convHardBound(CONV_K3, 5) * 0.1);
    const gain = ebn0For((d) => convHardBound(CONV_K7, d), 1e-5) - ebn0For((d) => convSoftBound(CONV_K7, d), 1e-5);
    expect(gain).toBeGreaterThan(1.7);
    expect(gain).toBeLessThan(2.6);
  }, 120000);
  it('coding gain at 1e-5: K = 7 soft about 5 dB, RS(255, 223) about 3-4 dB, SEC-DED about 1-2 dB', () => {
    const k7 = codingGain((d) => convSoftBound(CONV_K7, d), 1e-5);
    expect(k7).toBeGreaterThan(4.6); expect(k7).toBeLessThan(5.6);
    const rs = codingGain((d) => rsCurve(d, 255, 223), 1e-5);
    expect(rs).toBeGreaterThan(2.8); expect(rs).toBeLessThan(4.5);
    const se = codingGain((d) => secdedBer(d), 1e-5);
    expect(se).toBeGreaterThan(0.8); expect(se).toBeLessThan(2.2);
  });
  it('quantizing: eight levels across ±1.25, q = 1 the sign', () => {
    expect([quantize(-5, 3), quantize(-1.25, 3), quantize(0.001, 3), quantize(1.25, 3), quantize(9, 3)]).toEqual([0, 0, 4, 7, 7]);
    expect([quantize(-0.1, 1), quantize(0.1, 1)]).toEqual([0, 1]);
  });
});

describe('interleaving', () => {
  it('round trips, and a burst lands at most ⌈b / D⌉ in any word', () => {
    const u = rng(1), words = Array.from({ length: 5 }, () => Array.from({ length: 12 }, () => (u() < 0.5 ? 1 : 0)));
    const st = interleave(words);
    expect(deinterleave(st, 5)).toEqual(words);
    expect(placeOf(7, 5)).toEqual([2, 1]);
    for (const b of [1, 3, 5, 6, 11, 17]) for (let at = 0; at + b <= st.length; at++) {
      const count = new Array<number>(5).fill(0);
      for (let c = at; c < at + b; c++) count[placeOf(c, 5)[0]]++;
      expect(Math.max(...count)).toBe(worstPerWord(b, 5));
    }
    expect(burstTolerance(8, 1)).toBe(8);
  });
  it('the burst channel\'s rate; SEC-DED fails on bursts unless interleaved, on the same channel', () => {
    const ch = burstChannel(3, 1e-3, 0.1); let e = 0; const N = 2000000;
    for (let i = 0; i < N; i++) e += ch();
    near(e / N, burstRate(1e-3, 0.1), 0.1);
    const alone = secdedOverBursts(1, 32000, 5e-5, 0.2, 5), wide = secdedOverBursts(32, 1000, 5e-5, 0.2, 5);
    expect(alone.failed).toBeGreaterThan(20);
    expect(wide.rate).toBeLessThan(alone.rate / 5);
  });
});

describe('audit follow-ups (chapters 45-47)', () => {
  it('the live run\'s seeds are decorrelated: distinct, and not a progression', () => {
    const s = Array.from({ length: 2000 }, (_, i) => trialSeed(i, 3));
    expect(new Set(s).size).toBe(2000);
    const d = new Set(s.slice(1).map((v, i) => (v - s[i]) >>> 0));
    expect(d.size).toBeGreaterThan(1990); // consecutive differences all different: no constant stride
    expect(trialSeed(5, 1)).not.toBe(trialSeed(5, 3));
  });
  it('the smallest end-of-bit sample: 1010 is its closed form, 1100 is below it and above the lone bit (chapter 46\'s quiz explanation)', () => {
    const R = 8, B = 1, a = Math.exp((-2 * Math.PI * B) / R), p = (n: string) => PATTERNS.find((x) => x.name.startsWith(n))!.bits;
    near(smallestSample(p('1010'), R, B), swing1010(a), 1e-6);
    const s1100 = smallestSample(p('1100'), R, B), lone = smallestSample(p('One 1'), R, B);
    expect(s1100).toBeLessThan(swing1010(a));
    expect(s1100).toBeGreaterThan(lone);
    near(lone, 1 - 2 * a, 0.05); // one 1 in eight: the run of zeros is long, not endless
  });
  it('ADSL\'s 512 points carry 255 tones, not 256: DC and N / 2 stay empty', () => {
    const syms = (n: number) => Array.from({ length: n }, () => [1, 0] as [number, number]);
    expect(() => blockOf(syms(ADSL.tones - 1), ADSL.tones * 2)).not.toThrow();
    expect(() => blockOf(syms(ADSL.tones), ADSL.tones * 2)).toThrow();
  });
  it('the interleave verdict follows what the words saw: two hits on check bits that still decode are not "at most one error"', () => {
    const r = burstOutcome(1, 2, 0); // the two flipped bits are the word\'s check bits: data intact, two errors in the word
    expect(r.failed).toBe(0);
    expect(Math.max(...r.errs)).toBe(2);
    const v = burstVerdict(1, 2, r);
    expect(v.text).not.toContain('at most one error');
    expect(v.text).toContain('check bits');
    expect(burstVerdict(8, 6, burstOutcome(8, 6, 4)).text).toContain('at most one error');
    expect(burstVerdict(1, 6, burstOutcome(1, 6, 4)).cls).toBe('bad');
    // every case the verdict claims "at most one" for really has at most one error a word
    for (let D = 1; D <= 12; D++) for (let b = 1; b <= 30; b++) for (let at = 0; at <= 60; at += 7) {
      const o = burstOutcome(D, b, at);
      if (burstVerdict(D, b, o).text.includes('at most one error')) expect(Math.max(...o.errs)).toBeLessThanOrEqual(1);
    }
  });
});
