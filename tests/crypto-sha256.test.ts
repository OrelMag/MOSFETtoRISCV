// SHA-256: the golden model (crypto/sha256.ts) against FIPS 180-4's constants, the NIST example document's round tables and node:crypto;
// then the gates (lib/sha256.ts) against the model: each part, the schedule register word by word, a round, and the core every clock on
// the NIST example (whose two-block message chains one block's output into the next block's input).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { H0, K, PRIMES, blocksOf, compress, compressTrace, roundStep, schedule, sha256, sha256Words, utf8 } from '../src/crypto/sha256';
import { bigSig0, bigSig1, maj1, rotr, shaCh, shaCore, shaK, shaMaj, shaRound, shaSchedule, shaWnext, smallSig0, smallSig1 } from '../src/lib/sha256';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { logicDepth, stats } from '../src/sim/stats';
import { checkSpec, lcg } from './util';
import { tick as yieldTick } from './yieldtick';
import vectors from './crypto/vectors.json';

const V = (vectors as unknown as {
  sha: { K: number[]; H0: number[]; messages: { text: string; digest: string; blocks: { w: number[]; rounds: number[][]; in: number[]; out: number[] }[] }[] };
}).sha;
const hex8 = (w: number[]) => w.map((x) => x.toString(16).padStart(8, '0')).join('');

describe('golden model', () => {
  it('K and H0, computed from roots of primes, equal FIPS 180-4 §4.2.2 / §5.3.3', () => {
    expect(PRIMES).toHaveLength(64);
    expect([...K]).toEqual(V.K);
    expect([...H0]).toEqual(V.H0);
  });
  it('the NIST example: padding, every round of every block, the chaining, the digest', () => {
    for (const m of V.messages) {
      const blocks = blocksOf(utf8(m.text));
      expect(blocks, m.text).toHaveLength(m.blocks.length);
      let h = [...H0];
      blocks.forEach((blk, bi) => {
        const f = m.blocks[bi];
        expect(blk, `block ${bi} words`).toEqual(f.w);
        expect(h, `block ${bi} input`).toEqual(f.in);
        const t = compressTrace(h, blk);
        f.rounds.forEach((r, i) => expect(t.rounds[i].vars, `${m.text.slice(0, 8)} block ${bi} t=${i}`).toEqual(r));
        expect(t.out).toEqual(f.out);
        h = t.out;
      });
      expect(hex8(h)).toBe(m.digest);
      expect(sha256(utf8(m.text))).toBe(m.digest);
    }
  });
  it('matches node:crypto on seeded random messages around the padding boundaries', () => {
    const r = lcg(77);
    for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 200, 1000]) {
      const msg = Array.from({ length: n }, () => r(256));
      expect(sha256(msg), `${n} bytes`).toBe(createHash('sha256').update(Buffer.from(msg)).digest('hex'));
    }
    for (let i = 0; i < 60; i++) {
      const msg = Array.from({ length: r(300) }, () => r(256));
      expect(sha256(msg)).toBe(createHash('sha256').update(Buffer.from(msg)).digest('hex'));
    }
  });
});

// ---- gates ----
const bitsOf = (ws: number[]): number[] => ws.flatMap((w) => Array.from({ length: 32 }, (_, i) => (w >>> i) & 1));
const wordsFrom = (bits: ArrayLike<number>): number[] => Array.from({ length: bits.length / 32 }, (_, i) => { let v = 0; for (let j = 0; j < 32; j++) v += (bits[32 * i + j] & 1) * 2 ** j; return v >>> 0; });
const put = (sim: Sim, port: string, ws: number[]) => sim.setInputBits(port, bitsOf(ws));
const read = (sim: Sim, nets: readonly number[]): number[] => {
  const bits = sim.getBits(nets);
  expect(Array.from(bits).every((x) => x === 0 || x === 1), 'X or Z on a bus').toBe(true);
  return wordsFrom(bits);
};
const get = (sim: Sim, port: string) => read(sim, sim.design.root.ports[port]);
const child = (sim: Sim, ...path: string[]) => { let n = sim.design.root; for (const p of path) n = n.children!.get(p)!; return n; };
const reg = (sim: Sim, name: string) => read(sim, child(sim, name).ports.q);
const rnd32 = (r: (n: number) => number) => ((r(65536) << 16) | r(65536)) >>> 0;
const pulse = (sim: Sim) => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };

describe('parts match their specs', () => {
  it('the rotations are wiring: zero NANDs', () => {
    for (const k of [2, 13, 22, 6, 11, 25, 7, 18, 17, 19]) expect(stats(rotr(k)).nands, `ROTR ${k}`).toBe(0);
  });
  it('rotations, sigma functions, Ch, Maj, the schedule step', () => {
    for (const k of [2, 13, 22, 6, 11, 25, 7, 18, 17, 19]) checkSpec(rotr(k), 40);
    for (const d of [bigSig0(), bigSig1(), smallSig0(), smallSig1()]) checkSpec(d, 200);
    checkSpec(maj1());
    checkSpec(shaCh(), 200); checkSpec(shaMaj(), 200); checkSpec(shaWnext(), 100);
  });
  it('the constants in gates: all 64 lines', () => {
    checkSpec(shaK());
  });
});

describe('wide parts against the model', () => {
  it('a round, on random working variables', async () => {
    const sim = simulate(shaRound()), r = lcg(5);
    for (let i = 0; i < 16; i++) {
      const v = Array.from({ length: 8 }, () => rnd32(r)), k = rnd32(r), w = rnd32(r);
      put(sim, 'v', v); put(sim, 'k', [k]); put(sim, 'w', [w]); sim.settle();
      expect(get(sim, 'y'), `round ${i}`).toEqual(roundStep(v, k, w));
      if (i % 4 === 3) await yieldTick();
    }
  }, 120000);
  it('the schedule register: w is W[t] for all 64 rounds, and the registers hold the sliding window', async () => {
    const sim = simulate(shaSchedule()), r = lcg(9), blk = Array.from({ length: 16 }, () => rnd32(r)), W = schedule(blk);
    put(sim, 'blk', blk); sim.setInput('ld', 1); sim.setInput('en', 1); sim.setInput('clk', 0); sim.settle(); pulse(sim);
    sim.setInput('ld', 0); sim.settle();
    for (let t = 0; t < 64; t++) {
      expect(get(sim, 'w'), `W[${t}]`).toEqual([W[t]]);
      if (t % 16 === 15) await yieldTick();
      if (t < 50) expect([0, 5, 15].map((i) => reg(sim, `r${i}`)[0]), `window at ${t}`).toEqual([0, 5, 15].map((i) => (W[t + i] ?? reg(sim, `r${i}`)[0])));
      pulse(sim);
    }
  }, 120000);
});

describe('compression core', () => {
  /** Load h and a block, then compare a..h with the model after every clock; returns the output. */
  async function run(sim: Sim, h: number[], blk: number[], label: string, table?: number[][]) {
    const t = compressTrace(h, blk);
    put(sim, 'h', h); put(sim, 'blk', blk); sim.setInput('rst', 0); sim.setInput('start', 1); sim.setInput('clk', 0); sim.settle();
    pulse(sim); sim.setInput('start', 0); sim.settle();
    expect(reg(sim, 'V'), `${label}: after load`).toEqual(h);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
    for (let i = 0; i < 64; i++) {
      pulse(sim);
      expect(reg(sim, 'V'), `${label}: a..h after round ${i}`).toEqual(t.rounds[i].vars);
      expect(get(sim, 'out'), `${label}: out (h + a..h) after round ${i}`).toEqual(h.map((x, j) => (x + t.rounds[i].vars[j]) >>> 0));
      if (table) expect(reg(sim, 'V'), `${label}: NIST table t=${i}`).toEqual(table[i]);
      expect(sim.getBits(sim.design.root.ports.done)[0], `${label}: done after round ${i}`).toBe(i === 63 ? 1 : 0);
      if (i % 8 === 7) await yieldTick();
    }
    expect(get(sim, 'out'), `${label}: out`).toEqual(t.out);
    pulse(sim); pulse(sim);
    expect(get(sim, 'out'), `${label}: idle clocks change nothing`).toEqual(t.out);
    return t.out;
  }
  it('the NIST example, every clock against the document\'s round table: abc, then the two-block message with its chaining', async () => {
    const sim = simulate(shaCore());
    sim.setInput('rst', 1); sim.setInput('start', 0); sim.setInput('clk', 0); sim.settle(); pulse(sim); sim.setInput('rst', 0); sim.settle();
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
    for (const m of V.messages) {
      let h = [...H0];
      for (let bi = 0; bi < m.blocks.length; bi++) {
        h = await run(sim, h, blocksOf(utf8(m.text))[bi], `${m.text.slice(0, 6)} block ${bi}`, m.blocks[bi].rounds);
        expect(h).toEqual(m.blocks[bi].out);
      }
      expect(hex8(h), m.text).toBe(m.digest);
    }
  }, 900000);
  it('seeded random blocks and chaining values against the model, and a restart mid-run', async () => {
    const sim = simulate(shaCore()), r = lcg(31);
    sim.setInput('rst', 1); sim.setInput('start', 0); sim.setInput('clk', 0); sim.settle(); pulse(sim); sim.setInput('rst', 0); sim.settle();
    for (let i = 0; i < 2; i++) {
      const h = Array.from({ length: 8 }, () => rnd32(r)), blk = Array.from({ length: 16 }, () => rnd32(r));
      expect(await run(sim, h, blk, `random ${i}`)).toEqual(compress(h, blk));
    }
    const msg = Array.from({ length: 100 }, () => r(256));
    let h = [...H0];
    for (const b of blocksOf(msg)) h = await run(sim, h, b, 'message');
    expect(h).toEqual(sha256Words(msg));
    expect(hex8(h)).toBe(createHash('sha256').update(Buffer.from(msg)).digest('hex'));
    // rst stops a run
    put(sim, 'h', [...H0]); put(sim, 'blk', blocksOf(utf8('abc'))[0]); sim.setInput('start', 1); sim.settle(); pulse(sim); sim.setInput('start', 0); sim.settle(); pulse(sim); pulse(sim);
    sim.setInput('rst', 1); sim.settle(); pulse(sim); sim.setInput('rst', 0); sim.settle();
    const frozen = reg(sim, 'V'); pulse(sim);
    expect(reg(sim, 'V'), 'rst stops the rounds').toEqual(frozen);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
  }, 900000);
  it('reports its costs', () => {
    // eslint-disable-next-line no-console
    for (const d of [shaRound(), shaK(), shaSchedule(), shaCore()]) console.log(d.id, stats(d).nands, d.id === 'sha_round' ? logicDepth(d) : '');
  });
});
