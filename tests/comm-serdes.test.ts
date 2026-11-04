// Chapter 46's gates against their golden models: the 8b/10b encoder and decoder over every code and both disparities, the sender,
// the line and the receiver cycle by cycle (every output after every edge), the scrambler, and the whole link under a frequency offset.

import { describe, expect, it } from 'vitest';
import {
  A7_AT_NEG, classOf, dec4, dec6, decode8b10bTracking, Descrambler, encode4, encode6, encode8b10b, K_CODES, POLY_7, type Rd, Scrambler,
} from '../src/comm/linecode';
import { LineModel, NCO_BITS, NOMINAL_INC, RxModel, TxModel, FILTER_LIMIT, GATE_MBPS, GATE_BIT_NS } from '../src/comm/serdes';
import {
  CDR_CTL, DEC34, DEC56, DEC8B10B, descrambler, ENC34, ENC56, ENC8B10B, MANCH_DEC, MANCH_ENC, scrambler, SERDES_LINK, serialLine, SER_RX, SER_TX,
} from '../src/lib';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { checkSpec, lcg, out, set, tick } from './util';
import { tick as yieldTick } from './yieldtick';

const syms: { v: number; k: boolean }[] = [];
for (let v = 0; v < 256; v++) syms.push({ v, k: false });
for (const v of K_CODES) syms.push({ v, k: true });

describe('blocks with a full spec', () => {
  for (const d of [CDR_CTL, MANCH_ENC, MANCH_DEC]) it(d.name, () => checkSpec(d));
});

describe('8b/10b gates against the golden model', () => {
  it('the 5b/6b and 3b/4b encoders, on every row that means something', () => {
    const s6 = simulate(ENC56), s4 = simulate(ENC34);
    for (let x = 0; x < 32; x++) for (const k of [0, 1]) for (const rd of [0, 1]) {
      if (k && ![23, 27, 28, 29, 30].includes(x)) continue;
      set(s6, { x, k, rd });
      const six = encode6(x, !!k, rd as Rd), c = classOf(x);
      expect([out(s6, 'six'), out(s6, 'a0'), out(s6, 'a1')]).toEqual([six, c.xa0, c.xa1]);
    }
    for (let y = 0; y < 8; y++) for (const k of [0, 1]) for (const rd of [0, 1]) for (const [a0, a1] of [[0, 0], [1, 0], [0, 1]]) {
      if (k && (a0 || a1)) continue;
      set(s4, { y, k, rd, a0, a1 });
      expect(out(s4, 'four')).toBe(encode4(y, !!k, rd as Rd, a0 ? A7_AT_NEG[0] : a1 ? 11 : 0));
    }
  });
  it('the decoder halves: bad always exact; the rest where the code is legal', () => {
    const s6 = simulate(DEC56), s4 = simulate(DEC34);
    for (let six = 0; six < 64; six++) for (const rd of [0, 1] as Rd[]) {
      set(s6, { six, rd });
      const r = dec6(six, rd);
      expect([out(s6, 'bad'), out(s6, 'rd1')]).toEqual([r.bad, r.rd1]);
      if (!r.bad) expect([out(s6, 'x'), out(s6, 'k28'), out(s6, 'xk'), out(s6, 'a0'), out(s6, 'a1')]).toEqual([r.x, r.k28, r.xk, r.xa0, r.xa1]);
    }
    for (let four = 0; four < 16; four++) for (const rd of [0, 1] as Rd[]) for (const [k28, xk, a0, a1] of [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
      set(s4, { four, rd, k28, xk, a0, a1 });
      const r = dec4(four, rd, k28, xk, a0, a1);
      expect([out(s4, 'bad'), out(s4, 'flip')]).toEqual([r.bad, r.flip]);
      if (!r.bad) expect([out(s4, 'y'), out(s4, 'kseven')]).toEqual([r.y, r.kseven]);
    }
  });
  it('the encoder gives the model\'s code and disparity for all 268 symbols at both disparities', () => {
    const sim = simulate(ENC8B10B);
    for (const rd of [0, 1] as Rd[]) for (const s of syms) {
      set(sim, { d: s.v, k: s.k ? 1 : 0, rd });
      const e = encode8b10b(s.v, s.k, rd);
      expect([out(sim, 'code'), out(sim, 'rdout')], `${s.v} ${s.k} ${rd}`).toEqual([e.code, e.rd]);
    }
  });
  it('the decoder agrees with the model on all 1024 codes at both disparities: the error flag always; byte, k and disparity where there is none', () => {
    const sim = simulate(DEC8B10B);
    let legal = 0;
    for (const rd of [0, 1] as Rd[]) for (let code = 0; code < 1024; code++) {
      set(sim, { code, rd });
      const m = decode8b10bTracking(code, rd), err = out(sim, 'err');
      expect(err, `${code} ${rd}`).toBe(m.err ? 1 : 0);
      if (!m.err) { legal++; expect([out(sim, 'd'), out(sim, 'k'), out(sim, 'rdout')]).toEqual([m.v, m.k ? 1 : 0, m.rd]); }
    }
    expect(legal).toBeGreaterThan(500);
  });
  it('encoder then decoder is the identity over a long stream, a comma setting the receiver\'s disparity', () => {
    const e = simulate(ENC8B10B), d = simulate(DEC8B10B), rng = lcg(3);
    let rdt = 0, rdr = 1;                                  // the receiver starts out wrong
    for (let i = 0; i < 600; i++) {
      const s = i % 8 === 0 ? { v: 0xbc, k: true } : { v: rng(256), k: false };
      set(e, { d: s.v, k: s.k ? 1 : 0, rd: rdt });
      const code = out(e, 'code');
      rdt = out(e, 'rdout');
      set(d, { code, rd: rdr });
      if (i >= 1) { expect(out(d, 'err')).toBe(0); expect([out(d, 'd'), out(d, 'k')]).toEqual([s.v, s.k ? 1 : 0]); }
      rdr = out(d, 'rdout');
    }
  });
});

describe('costs (NAND counts)', () => {
  it('are small enough to draw', () => {
    const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
    const c = { enc: n(ENC8B10B), dec: n(DEC8B10B), tx: n(SER_TX), rx: n(SER_RX), link: n(SERDES_LINK), scr: n(scrambler(POLY_7)), dscr: n(descrambler(POLY_7)), man: n(MANCH_ENC) };
    console.log('NANDs', JSON.stringify(c));
    expect(c.man).toBe(5);
  });
});

/** One cycle on the gate simulator: the rising edge and back. */
const cycle = (sim: Parameters<typeof tick>[0]): void => tick(sim);

describe('sender, line, receiver cycle by cycle', () => {
  it('the sender: txd and wload every cycle, at the nominal rate and offset by a few percent, with a new word every cycle', async () => {
    for (const inc of [NOMINAL_INC, NOMINAL_INC + 37, NOMINAL_INC - 29, 4095]) {
      const sim = simulate(SER_TX), m = new TxModel(), rng = lcg(inc);
      let loads = 0;
      for (let t = 0; t < 1500; t++) {
        const word = rng(1024);
        set(sim, { inc, word });
        expect([out(sim, 'txd'), out(sim, 'wload')], `inc ${inc} t ${t}`).toEqual([m.txd(), m.wload(inc)]);
        loads += m.wload(inc);
        cycle(sim); m.step(inc, word);
        if (t % 500 === 0) await yieldTick();
      }
      expect(loads).toBeGreaterThan(0);
    }
  });
  it('the line leaf: out(t) = in(t - d), flipped where err was 1', () => {
    const sim = simulate(serialLine(3)), m = new LineModel(3), rng = lcg(5);
    for (let t = 0; t < 400; t++) {
      const inp = rng(2), err = rng(5) === 0 ? 1 : 0;
      set(sim, { in: inp, err });
      expect(out(sim, 'out')).toBe(m.out());
      cycle(sim); m.step(inp, err);
    }
  });
  it('the receiver, on a random line and on a real one: every output every cycle', async () => {
    const rng = lcg(11);
    for (const mode of ['noise', 'link']) {
      const sim = simulate(SER_RX), m = new RxModel(), tx = new TxModel(), line = new LineModel(3);
      let words = 0;
      const stream = (() => { let rd: Rd = 0; return () => { const s = rng(6) === 0 ? { v: 0xbc, k: true } : { v: rng(256), k: false }; const e = encode8b10b(s.v, s.k, rd); rd = e.rd; return e.code; }; })();
      let next = stream();
      for (let t = 0; t < 3000; t++) {
        const rxd = mode === 'noise' ? (rng(3) === 0 ? 1 : rng(2)) : line.out();
        set(sim, { rxd });
        const x = m.x, early = (x[0] ^ x[4]) & (1 ^ x[2] ^ x[4]), late = (x[0] ^ x[4]) & (x[2] ^ x[4]);
        expect({ word: out(sim, 'word'), wv: out(sim, 'wv'), count: out(sim, 'count'), strobe: out(sim, 'strobe'), phase: out(sim, 'phase'), vote: out(sim, 'vote'), early: out(sim, 'early'), late: out(sim, 'late') }, `${mode} t ${t}`)
          .toEqual({ word: m.word, wv: m.wv, count: m.bc, strobe: m.strobe(), phase: m.c, vote: m.f & 7, early, late });
        words += m.wv;
        const w = next, load = tx.wload(NOMINAL_INC);
        cycle(sim); m.step(rxd); line.step(tx.txd(), 0); tx.step(NOMINAL_INC, w);
        if (load) next = stream();
        if (t % 500 === 0) await yieldTick();
      }
      expect(words).toBeGreaterThan(50);
    }
  });
});

describe('the scrambler gates', () => {
  it('match the model bit for bit, and the pair is the identity', () => {
    const s = simulate(scrambler(POLY_7)), d = simulate(descrambler(POLY_7)), ms = new Scrambler(POLY_7), md = new Descrambler(POLY_7), rng = lcg(9);
    for (let t = 0; t < 500; t++) {
      const bit = rng(2);
      set(s, { d: bit, en: 1 });
      const o = out(s, 'q');
      expect(o).toBe(ms.step(bit));
      cycle(s);
      set(d, { d: o, en: 1 });
      const r = md.step(o);
      expect(out(d, 'q')).toBe(r);
      if (t > 8) expect(r).toBe(bit);
      cycle(d);
    }
  });
});

describe('the whole link', () => {
  /** Run the gate-level link; the sender's byte at every word taken, and the decoder's bytes with its error flag. */
  async function run(inc: number, cycles: number, flipAt: number[] = []) {
    const sim = simulate(SERDES_LINK), tx = new TxModel(), line = new LineModel(3), rx = new RxModel();
    const sent: [number, number][] = [], got: [number, number, number][] = [];
    for (let t = 0; t < cycles; t++) {
      const flip = flipAt.includes(t) ? 1 : 0;
      set(sim, { inc, manual: 0, din: 0, kin: 0, flip });
      const word = out(sim, 'tword'), txd = out(sim, 'txd'), rxd = out(sim, 'rxd');
      // the models, fed what the gates see, say the same about every output of the three blocks
      expect([txd, out(sim, 'wload'), rxd, out(sim, 'rword'), out(sim, 'wv'), out(sim, 'strobe')], `inc ${inc} t ${t}`)
        .toEqual([tx.txd(), tx.wload(inc), line.out(), rx.word, rx.wv, rx.strobe()]);
      if (out(sim, 'wload')) sent.push([out(sim, 'sbyte'), out(sim, 'sk')]);
      if (out(sim, 'wv')) got.push([out(sim, 'rbyte'), out(sim, 'rk'), out(sim, 'err')]);
      cycle(sim); rx.step(rxd); line.step(txd, flip); tx.step(inc, word);
      if (t % 400 === 0) await yieldTick();
    }
    return { sent, got };
  }
  /** Fewest wrong bytes over the alignments of got against sent (the receiver's first words are partial). */
  const errorsOf = ({ sent, got }: { sent: [number, number][]; got: [number, number, number][] }, from = 12): number => {
    let best = Infinity;
    for (let off = 0; off < 6; off++) {
      let e = 0;
      for (let i = from; i < got.length; i++) { const s = sent[i + off - 4]; if (s && (got[i][0] !== s[0] || got[i][1] !== s[1] || got[i][2])) e++; }
      best = Math.min(best, e);
    }
    return best;
  };
  it('carries bytes and commas at the nominal rate, every output equal to the golden models every cycle', async () => {
    const r = await run(NOMINAL_INC, 6000);
    expect(r.got.length).toBeGreaterThan(100);
    expect(errorsOf(r)).toBe(0);
  }, 120_000);
  it('keeps lock with the sender 1.5 % fast and 1.5 % slow, and loses it at 6 %', async () => {
    for (const d of [NOMINAL_INC * 0.015, -NOMINAL_INC * 0.015]) expect(errorsOf(await run(NOMINAL_INC + Math.round(d), 7000))).toBe(0);
    expect(errorsOf(await run(NOMINAL_INC + Math.round(NOMINAL_INC * 0.06), 7000))).toBeGreaterThan(5);
  }, 240_000);
  it('a bit flipped on the line is flagged: a code or disparity error, at the word it fell in', async () => {
    const r = await run(NOMINAL_INC, 4000, [2001]);
    expect(r.got.filter((g) => g[2]).length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('the clock-recovery loop: lock range from the model', () => {
  type Pattern = (n: number, rnd: () => number) => { v: number; k: boolean };
  /** Words wrong after the first 20, for a given offset of the sender's accumulator step, on a given pattern of bytes. */
  function wrong(pattern: Pattern, inc: number): number {
    let rd: Rd = 0, s = 1;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
    const tx = new TxModel(), line = new LineModel(3), rx = new RxModel();
    const sent: number[] = [], got: number[] = [];
    let n = 0;
    const make = () => { const b = pattern(n++, rnd), e = encode8b10b(b.v, b.k, rd); rd = e.rd; return e.code; };
    let next = make();
    for (let t = 0; t < 24000; t++) {
      if (rx.wv) got.push(rx.word);
      const load = tx.wload(inc);
      if (load) sent.push(next);
      const word = next;
      rx.step(line.out()); line.step(tx.txd(), 0); tx.step(inc, word);
      if (load) next = make();
    }
    let best = Infinity;
    for (let off = 0; off < 8; off++) { let e = 0; for (let i = 20; i < got.length; i++) { const sv = sent[i + off - 4]; if (sv !== undefined && sv !== got[i]) e++; } best = Math.min(best, e); }
    return best;
  }
  /** The largest |offset| in accumulator counts (the worse sign) at which the loop still has no error. */
  function lockRange(pattern: Pattern): number {
    const side = (sign: number) => { let lo = 0, hi = 200; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (wrong(pattern, NOMINAL_INC + sign * m) === 0) lo = m; else hi = m; } return lo; };
    return Math.min(side(1), side(-1));
  }
  /** Transition density of a pattern: the fraction of bit periods that have an edge to vote on. */
  function density(pattern: Pattern): number {
    let rd: Rd = 0, s = 1, tr = 0, bits = 0, last = 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
    for (let i = 0; i < 400; i++) {
      const b = pattern(i, rnd), e = encode8b10b(b.v, b.k, rd); rd = e.rd;
      for (let j = 9; j >= 0; j--) { const bit = (e.code >> j) & 1; if (bits && bit !== last) tr++; last = bit; bits++; }
    }
    return tr / (bits - 1);
  }
  it('is the pattern\'s transition density over (4 samples a bit x F votes a slip): checked on three patterns', async () => {
    const pats: [string, Pattern][] = [
      ['K28.5', () => ({ v: 0xbc, k: true })],
      ['D30.3', (n) => (n < 2 ? { v: 0xbc, k: true } : { v: 30 + 3 * 32, k: false })],
      ['random', (n, r) => (n % 8 === 0 ? { v: 0xbc, k: true } : { v: r(), k: false })],
    ];
    const res = [];
    for (const [name, p] of pats) {
      const rho = density(p);
      res.push({ name, rho, theory: rho / (4 * FILTER_LIMIT), measured: lockRange(p) / NOMINAL_INC });
      await yieldTick();
    }
    console.log('lock range', JSON.stringify(res));
    for (const r of res) {
      expect(r.measured).toBeLessThanOrEqual(r.theory * 1.1);
      expect(r.measured).toBeGreaterThanOrEqual(r.theory * (r.name === 'random' ? 0.45 : 0.85));
    }
    // the worst the code guarantees (one transition in five bits) gives the floor
    expect(0.2 / (4 * FILTER_LIMIT)).toBeCloseTo(0.0125, 6);
  }, 240_000);
  it('link speed convention: 4 cycles a bit at 3.95 ns is 63 Mb/s', () => {
    expect(GATE_BIT_NS).toBeCloseTo(15.8, 6);
    expect(Math.round(GATE_MBPS)).toBe(63);
    expect(NCO_BITS).toBe(12);
  });
});
