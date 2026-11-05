// AES-128: the golden model (crypto/aes.ts) against the standards' vectors (tests/crypto/vectors.json, scripts/crypto-vectors.mjs
// reads them out of the NIST PDFs) and node:crypto; then the gates (lib/aes.ts) against the model: every S-box input, every part,
// and the iterative core every clock on the NIST vectors and on seeded random blocks.
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { INV_SBOX, ginv, RCON, SBOX, decryptBlock, ecb, encryptBlock, encryptTrace, expandKey, gmul, mixColumns, nextKey, round, shiftRows, subBytes as subBytesM, xtime } from '../src/crypto/aes';
import type { Bytes } from '../src/crypto/aes';
import { LAMBDA, N4, ROOT, sboxTower } from '../src/crypto/tower';
import { aesCore, aesRound, aesSbox, gf16Inv, gf16Mul, gf256Inv, gf4Mul, keyStep, mixColumn, shiftRowsWire, subBytes, xorBytes, xtimeGate } from '../src/lib/aes';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { logicDepth, stats } from '../src/sim/stats';
import { checkSpec, lcg } from './util';
import { tick as yieldTick } from './yieldtick';
import vectors from './crypto/vectors.json';

const V = vectors as unknown as {
  fips197: { input: Bytes; key: Bytes; rounds: { start: Bytes; sub: Bytes; shift: Bytes; mix: Bytes | null; key: Bytes | null }[]; output: Bytes };
  ecb: { key: Bytes; plaintext: Bytes[]; ciphertext: Bytes[] };
  core: { key: Bytes; initial: Bytes; rounds: { sub: Bytes; shift: Bytes; mix: Bytes | null; key: Bytes }[] };
};
const rnd = (seed: number, n: number): Bytes => { const r = lcg(seed); return Array.from({ length: n }, () => r(256)); };

describe('golden model', () => {
  it('FIPS 197 Appendix B: every state of every round', () => {
    const t = encryptTrace(V.fips197.input, V.fips197.key);
    expect(V.fips197.rounds).toHaveLength(10);
    V.fips197.rounds.forEach((f, i) => {
      const r = t.rounds[i];
      expect(r.start, `round ${i + 1} start`).toEqual(f.start);
      expect(r.afterSub, `round ${i + 1} SubBytes`).toEqual(f.sub);
      expect(r.afterShift, `round ${i + 1} ShiftRows`).toEqual(f.shift);
      expect(r.afterMix, `round ${i + 1} MixColumns`).toEqual(f.mix);
      if (f.key) expect(r.roundKey, `round ${i + 1} key`).toEqual(f.key); // the page cuts round 5's key; AES_Core128 covers it
    });
    expect(t.output).toEqual(V.fips197.output);
  });
  it('every key bit reaches every output bit by round 2 (the lessons table says within a few rounds)', () => {
    let x = 0x12345678;
    const rnd = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return x >>> 0; }, bytes = () => Array.from({ length: 16 }, () => rnd() & 255);
    const reached = new Uint8Array(128 * 128);
    for (let n = 0; n < 16; n++) {
      const p = bytes(), k = bytes(), base = encryptTrace(p, k).rounds[1].out;
      for (let kb = 0; kb < 128; kb++) {
        const k2 = [...k];
        k2[kb >> 3] ^= 0x80 >> (kb & 7);
        const out = encryptTrace(p, k2).rounds[1].out;
        for (let ob = 0; ob < 128; ob++) if (((out[ob >> 3] ^ base[ob >> 3]) >> (7 - (ob & 7))) & 1) reached[kb * 128 + ob] = 1;
      }
    }
    expect(reached.reduce((a, b) => a + b, 0)).toBe(128 * 128);
  });
  it('NIST AES_Core128 (SP 800-38A F.1.1, block 1): the initial AddRoundKey and each round', () => {
    const t = encryptTrace(V.ecb.plaintext[0], V.core.key);
    expect(t.afterInitial).toEqual(V.core.initial);
    V.core.rounds.forEach((f, i) => {
      const r = t.rounds[i];
      expect([r.afterSub, r.afterShift, r.afterMix, r.out], `round ${i + 1}`).toEqual([f.sub, f.shift, f.mix, f.key]);
    });
    expect(t.output).toEqual(V.ecb.ciphertext[0]);
  });
  it('SP 800-38A F.1: ECB-AES128 encrypt and decrypt, four blocks', () => {
    V.ecb.plaintext.forEach((p, i) => {
      expect(encryptBlock(p, V.ecb.key)).toEqual(V.ecb.ciphertext[i]);
      expect(decryptBlock(V.ecb.ciphertext[i], V.ecb.key)).toEqual(p);
    });
    expect(ecb(V.ecb.plaintext.flat(), V.ecb.key)).toEqual(V.ecb.ciphertext.flat());
    expect(ecb(V.ecb.ciphertext.flat(), V.ecb.key, true)).toEqual(V.ecb.plaintext.flat());
  });
  it('matches node:crypto on seeded random keys and blocks, both directions', () => {
    for (let i = 0; i < 300; i++) {
      const key = Buffer.from(rnd(1000 + i, 16)), blk = Buffer.from(rnd(5000 + i, 16));
      const c = createCipheriv('aes-128-ecb', key, null); c.setAutoPadding(false);
      const ref = Buffer.concat([c.update(blk), c.final()]);
      expect(encryptBlock([...blk], [...key]), `enc ${i}`).toEqual([...ref]);
      const d = createDecipheriv('aes-128-ecb', key, null); d.setAutoPadding(false);
      expect(decryptBlock([...blk], [...key]), `dec ${i}`).toEqual([...Buffer.concat([d.update(blk), d.final()])]);
    }
  });
  it('the S-box is computed: inverse + affine, and INV_SBOX undoes it', () => {
    expect(new Set(SBOX).size).toBe(256);
    for (let x = 0; x < 256; x++) expect(INV_SBOX[SBOX[x]]).toBe(x);
    for (let x = 1; x < 256; x++) expect(gmul(x, ginv(x))).toBe(1);
    expect(xtime(0x80)).toBe(0x1b);
    expect(RCON).toHaveLength(10);
  });
  it('the key schedule: nextKey chains into expandKey', () => {
    const ks = expandKey(V.fips197.key);
    expect(ks.slice(1).map((_, i) => nextKey(ks[i], RCON[i]))).toEqual(ks.slice(1));
    V.fips197.rounds.forEach((f, i) => { if (f.key) expect(ks[i + 1]).toEqual(f.key); });
  });
});

describe('tower field (the S-box as hardware computes it)', () => {
  it('searched constants and a root exist', () => {
    expect([N4, LAMBDA, ROOT].every((v) => v > 0)).toBe(true);
  });
  it('change basis, invert in the tower, change back, affine: equals the S-box on all 256 inputs', () => {
    for (let x = 0; x < 256; x++) expect(sboxTower(x), `S(${x})`).toBe(SBOX[x]);
  });
});

// ---- gates ----

const toBits = (b: Bytes): number[] => b.flatMap((v) => Array.from({ length: 8 }, (_, i) => (v >> i) & 1));
const fromBits = (bits: ArrayLike<number>): Bytes => Array.from({ length: bits.length / 8 }, (_, i) => { let v = 0; for (let j = 0; j < 8; j++) v |= (bits[8 * i + j] & 1) << j; return v; });
const put = (sim: Sim, port: string, b: Bytes) => sim.setInputBits(port, toBits(b));
const get = (sim: Sim, port: string): Bytes => {
  const bits = sim.getBits(sim.design.root.ports[port]);
  expect(Array.from(bits).every((x) => x === 0 || x === 1), `${port} has X`).toBe(true);
  return fromBits(bits);
};
const pulse = (sim: Sim) => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
const child = (sim: Sim, ...path: string[]) => { let n = sim.design.root; for (const p of path) n = n.children!.get(p)!; return n; };
const reg = (sim: Sim, name: string): Bytes => fromBits(sim.getBits(child(sim, name).ports.q));

describe('parts match their specs', () => {
  it('the tower floors, exhaustively', () => {
    checkSpec(gf4Mul()); checkSpec(gf16Mul()); checkSpec(gf16Inv()); checkSpec(gf256Inv());
  });
  it('the S-box gates equal the model on all 256 inputs', () => {
    const d = aesSbox(), sim = simulate(d);
    for (let x = 0; x < 256; x++) {
      sim.setInput('x', x); sim.settle();
      expect(Array.from(sim.getBits(sim.design.root.ports.y)).reduce((a: number, b, i) => a + b * 2 ** i, 0), `S(${x})`).toBe(SBOX[x]);
    }
    checkSpec(d);
  });
  it('ShiftRows is wiring: zero NANDs', () => {
    expect(stats(shiftRowsWire()).nands).toBe(0);
  });
  it('xtime, MixColumns (one column), the 4-byte XOR', () => {
    checkSpec(xtimeGate());
    checkSpec(mixColumn(), 600);
    checkSpec(xorBytes(4), 100);
  });
});

describe('wide parts against the model', () => {
  it('SubBytes, ShiftRows (wiring), the round and the key step on random blocks', async () => {
    const sb = simulate(subBytes()), sr = simulate(shiftRowsWire()), rd = simulate(aesRound()), ks = simulate(keyStep());
    for (let i = 0; i < 24; i++) {
      const s = rnd(100 + i, 16), k = rnd(200 + i, 16);
      put(sb, 'a', s); sb.settle(); expect(get(sb, 'y'), `SubBytes ${i}`).toEqual(subBytesM(s));
      put(sr, 'in', s); sr.settle(); expect(get(sr, 'out'), `ShiftRows ${i}`).toEqual(shiftRows(s));
      for (const last of [0, 1]) {
        put(rd, 's', s); put(rd, 'k', k); rd.setInput('last', last); rd.settle();
        expect(get(rd, 'y'), `round ${i} last ${last}`).toEqual(round(s, k, last === 1));
      }
      const rc = RCON[i % 10];
      put(ks, 'k', k); ks.setInput('rcon', rc); ks.settle();
      expect(get(ks, 'y'), `key step ${i}`).toEqual(nextKey(k, rc));
      await yieldTick();
    }
    // MixColumns on the wide path is checked inside the round; here a whole-state check of the column part
    const mc = simulate(mixColumn());
    for (let i = 0; i < 20; i++) {
      const s = rnd(300 + i, 16);
      for (let c = 0; c < 4; c++) { put(mc, 'a', s.slice(4 * c, 4 * c + 4)); mc.settle(); expect(get(mc, 'y')).toEqual(mixColumns(s).slice(4 * c, 4 * c + 4)); }
    }
  }, 120000);
});

describe('iterative core', () => {
  /** Run one block through the core, comparing the registers with the model after every clock. */
  async function run(sim: Sim, key: Bytes, block: Bytes, label: string) {
    const t = encryptTrace(block, key);
    put(sim, 'key', key); put(sim, 'in', block); sim.setInput('rst', 0); sim.setInput('start', 1); sim.setInput('clk', 0); sim.settle();
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.setInput('start', 0); sim.settle();
    expect(reg(sim, 'S'), `${label}: after load`).toEqual(t.afterInitial);
    expect(reg(sim, 'K'), `${label}: key after load`).toEqual(key);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
    for (let r = 1; r <= 10; r++) {
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      expect(reg(sim, 'S'), `${label}: state after round ${r}`).toEqual(t.rounds[r - 1].out);
      expect(reg(sim, 'K'), `${label}: key after round ${r}`).toEqual(t.keys[r]);
      expect(sim.getBits(sim.design.root.ports.done)[0], `${label}: done after round ${r}`).toBe(r === 10 ? 1 : 0);
      if (r % 3 === 0) await yieldTick();
    }
    expect(get(sim, 'out'), `${label}: out`).toEqual(t.output);
    // idle clocks change nothing
    for (let i = 0; i < 2; i++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
    expect(get(sim, 'out')).toEqual(t.output);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(1);
    return t.output;
  }
  it('FIPS 197 Appendix B, SP 800-38A F.1.1 and seeded random blocks, every register every clock', async () => {
    const sim = simulate(aesCore());
    sim.setInput('rst', 1); sim.setInput('start', 0); sim.setInput('clk', 0); sim.settle(); sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
    expect(await run(sim, V.fips197.key, V.fips197.input, 'App B')).toEqual(V.fips197.output);
    for (let i = 0; i < 4; i++) expect(await run(sim, V.ecb.key, V.ecb.plaintext[i], `F.1.1 #${i + 1}`)).toEqual(V.ecb.ciphertext[i]);
    for (let i = 0; i < 3; i++) await run(sim, rnd(900 + i, 16), rnd(950 + i, 16), `random ${i}`);
    // a start in the middle of a run (three rounds in) restarts it: run() raises start again and checks every register of the new block
    put(sim, 'key', rnd(60, 16)); put(sim, 'in', rnd(61, 16)); sim.setInput('start', 1); sim.settle(); pulse(sim); sim.setInput('start', 0); sim.settle();
    for (let i = 0; i < 3; i++) pulse(sim);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
    await run(sim, rnd(62, 16), rnd(63, 16), 'restart at round 3');
    // rst drops busy and done
    put(sim, 'key', V.ecb.key); put(sim, 'in', V.ecb.plaintext[0]); sim.setInput('start', 1); sim.settle(); sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.setInput('start', 0); sim.settle();
    for (let i = 0; i < 3; i++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
    sim.setInput('rst', 1); sim.settle(); sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.setInput('rst', 0); sim.settle();
    const frozen = reg(sim, 'S');
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    expect(reg(sim, 'S'), 'rst stops the rounds').toEqual(frozen);
    expect(sim.getBits(sim.design.root.ports.done)[0]).toBe(0);
  }, 600000);
  it('reports its costs', () => {
    // eslint-disable-next-line no-console
    for (const d of [aesSbox(), mixColumn(), subBytes(), aesRound(), keyStep(), aesCore()]) console.log(d.id, stats(d).nands, d.id === 'aes_core' ? '' : logicDepth(d));
  });
});
