// The Reed-Solomon decoder: the register-transfer model against comm/rs.ts's rsDecode, and the gates against the model, every register every clock.
import { describe, expect, it } from 'vitest';
import { gfMul, gfPow, rsDecode, rsEncode } from '../src/comm/rs';
import { gfInvChain, rsLatency, rsRtlDecode } from '../src/comm/rsrtl';
import { RS_PHASE, RS_PHASE_NAMES, RsRtl } from '../src/comm/rsrtl';
import { gfInvGates, gfMulGates, gfSquare, rsBuffer, rsDecoder, rsDelta, rsForney } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { checkSpec, lcg, out, set, tick } from './util';
import { tick as yieldTick } from './yieldtick';

/** tests/comm-codes.test.ts's published QR message: Wikiversity, "Reed-Solomon codes for coders". */
const RS_QR_MSG = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];

/** A code word of k random data bytes with `errs` bytes changed at distinct places. */
function corrupted(r: (n: number) => number, n: number, nsym: number, errs: number): { sent: number[]; rx: number[] } {
  const msg = Array.from({ length: n - nsym }, () => r(256)), sent = [...msg, ...rsEncode(msg, nsym)], rx = sent.slice();
  const places = new Set<number>();
  while (places.size < errs) places.add(r(n));
  for (const p of places) rx[p] ^= 1 + r(255);
  return { sent, rx };
}

describe('the model', () => {
  it('a^254 is the inverse, and 0 stays 0', () => {
    expect(gfInvChain(0)).toBe(0);
    for (let a = 1; a < 256; a++) expect(gfMul(a, gfInvChain(a)), `a = ${a}`).toBe(1);
    expect(gfInvChain(gfPow(1))).toBe(gfPow(254));
  });
  for (const [n, nsym] of [[26, 10], [15, 4], [20, 2], [255, 32], [60, 8]] as const) {
    it(`RS(${n}, ${n - nsym}): the same answers as the software decoder, up to t and past it`, () => {
      const r = lcg(n * 31 + nsym), t = nsym / 2, trials = n > 100 ? 25 : 300;
      let refused = 0, wrongWord = 0;
      for (let i = 0; i < trials; i++) {
        const errs = i % (t + 4), { sent, rx } = corrupted(r, n, nsym, Math.min(errs, n)), soft = rsDecode(rx, nsym), hw = rsRtlDecode(rx, nsym);
        expect(hw.cycles, `trial ${i}`).toBe(rsLatency(nsym, n));
        expect(hw.out.length).toBe(n);
        expect(hw.fail, `trial ${i}, ${errs} errors`).toBe(soft.word === null);
        if (soft.word) expect(hw.out, `trial ${i}, ${errs} errors`).toEqual(soft.word);
        if (errs <= t) { expect(hw.fail).toBe(false); expect(hw.out).toEqual(sent); }
        if (hw.fail) refused++;
        else if (hw.out.some((v, j) => v !== sent[j])) wrongWord++;
      }
      expect(refused + wrongWord).toBeGreaterThan(0);
    });
  }
  it('words nothing like code words: refused or accepted exactly as the software does', () => {
    const r = lcg(77);
    for (let i = 0; i < 400; i++) {
      const rx = Array.from({ length: 26 }, () => r(256)), soft = rsDecode(rx, 10), hw = rsRtlDecode(rx, 10);
      expect(hw.fail, `word ${rx}`).toBe(soft.word === null);
      if (soft.word) expect(hw.out).toEqual(soft.word);
    }
  });
});

type Sim = ReturnType<typeof simulate>;
const nodeOf = (sim: Sim, path: string[]) => { let n = sim.design.root; for (const p of path) n = n.children!.get(p)!; return n; };
const numOf = (sim: Sim, path: string[], port: string): number => Array.from(sim.getBits(nodeOf(sim, path).ports[port])).reduce<number>((a, b, i) => a + Number(b) * 2 ** i, 0);

/** Every register and every combinational result the model names. */
function compare(sim: Sim, m: RsRtl, at: string, en: number) {
  const eq = (path: string[], port: string, want: number, what: string) => { const got = numOf(sim, path, port); if (got !== want) expect(got, `${at}: ${what}`).toBe(want); };
  eq(['ctl'], 'ph', m.phase, 'phase'); eq(['ctl'], 'cnt', m.cnt, 'counter');
  m.ring.forEach((v, k) => eq([`s${k}`], 'q', v, `ring ${k}`));
  m.lam.forEach((v, j) => eq([`l${j}`], 'l', v, `λ${j}`));
  m.b.forEach((v, j) => eq([`l${j}`], 'b', v, `b${j}`));
  m.om.forEach((v, i) => eq([`o${i}`], 'q', v, `Ω${i}`));
  eq(['gam'], 'q', m.gamma, 'γ'); eq(['kk'], 'k', m.k, 'k'); eq(['kk'], 'over', m.over, 'over');
  eq(['mk'], 'q', m.mask.reduce((a, b, i) => a + b * 2 ** i, 0), 'mask');
  const c = m.comb(en);
  eq(['dl'], 'y', c.delta, 'δ'); eq(['kk'], 'swap', c.swap ? 1 : 0, 'swap'); eq(['fr'], 'root', c.root ? 1 : 0, 'root'); eq(['fr'], 'e', c.e, 'e');
  expect(out(sim, 'valid'), `${at}: valid`).toBe(c.valid ? 1 : 0);
  expect(out(sim, 'done'), `${at}: done`).toBe(c.done ? 1 : 0);
  expect(out(sim, 'fail'), `${at}: fail`).toBe(c.fail ? 1 : 0);
  if (m.phase >= RS_PHASE.BM) { m.buf.forEach((v, i) => eq(['buf', `r${i}`], 'q', v, `buffer ${i}`)); }
  if (c.valid) expect(out(sim, 'out'), `${at}: out`).toBe(c.out);
}

/** A word through gates and model side by side; returns what the gates sent. */
async function lockstep(sim: Sim, m: RsRtl, word: readonly number[], stall: (i: number) => boolean) {
  set(sim, { rst: 1, en: 0, d: 0 }); tick(sim); m.step(0, 0, 1); set(sim, { rst: 0 });
  compare(sim, m, 'after reset', 0);
  const sent: number[] = [];
  let i = 0, clock = 0;
  while (out(sim, 'done') === 0) {
    const rx = m.phase === RS_PHASE.RX, en = rx && !stall(clock) ? 1 : 0, d = en ? word[i] : 0;
    set(sim, { en, d });
    compare(sim, m, `clock ${clock} (${RS_PHASE_NAMES[m.phase]})`, en);
    if (out(sim, 'valid')) sent.push(out(sim, 'out'));
    tick(sim); m.step(d, en, 0);
    if (en) i++;
    clock++;
    if (!(clock % 64)) await yieldTick();
  }
  set(sim, { en: 0, d: 0 });
  compare(sim, m, 'at the end', 0);
  return { sent, fail: out(sim, 'fail') === 1, clock };
}

describe('the parts', () => {
  it('match their specs', () => {
    checkSpec(gfSquare(1)); checkSpec(gfSquare(3)); checkSpec(gfInvGates(), 300);
    checkSpec(rsDelta(2), 300); checkSpec(rsDelta(5), 200); checkSpec(rsForney(2), 300); checkSpec(rsForney(5), 200);
  });
});

describe('the gates', () => {
  it('every register every clock, RS(26, 16), no errors up to past t, on one circuit', async () => {
    const sim = simulate(rsDecoder(10, 26)), m = new RsRtl(10, 26), r = lcg(26);
    for (const errs of [0, 1, 3, 5, 6, 9]) {
      const { sent, rx } = corrupted(r, 26, 10, errs), got = await lockstep(sim, m, rx, () => false), soft = rsDecode(rx, 10);
      expect(got.clock).toBe(rsLatency(10, 26));
      expect(got.fail, `${errs} errors`).toBe(soft.word === null);
      if (soft.word) expect(got.sent).toEqual(soft.word);
      if (errs <= 5) expect(got.sent).toEqual(sent);
    }
  }, 120000);
  it('the published QR word: clean, and with five bytes corrupted', async () => {
    const sim = simulate(rsDecoder(10, 26)), m = new RsRtl(10, 26), word = [...RS_QR_MSG, ...rsEncode(RS_QR_MSG, 10)];
    expect((await lockstep(sim, m, word, () => false)).sent).toEqual(word);
    const bad = word.slice();
    for (const [p, x] of [[0, 0xff], [7, 1], [15, 0x80], [16, 0x55], [25, 0xa5]]) bad[p] ^= x;
    const got = await lockstep(sim, m, bad, () => false);
    expect(got.fail).toBe(false);
    expect(got.sent).toEqual(word);
  }, 120000);
  it('holds while en = 0, on another size', async () => {
    const sim = simulate(rsDecoder(4, 15)), m = new RsRtl(4, 15), r = lcg(15);
    for (const errs of [0, 2, 3, 5]) {
      const { rx } = corrupted(r, 15, 4, errs), got = await lockstep(sim, m, rx, (c) => c % 3 === 1), soft = rsDecode(rx, 4);
      expect(got.fail).toBe(soft.word === null);
      if (soft.word) expect(got.sent).toEqual(soft.word);
    }
  }, 120000);
  it('costs what it costs', () => {
    const n = stats(rsDecoder(10, 26)).nands, parts = 22 * stats(gfMulGates()).nands;
    expect(n).toBeGreaterThan(parts);
    expect(n).toBeLessThan(40000);
    console.log(`RS(26, 16) decoder: ${n} NANDs, ${parts} in general multipliers, ${stats(rsBuffer(26)).nands} in the buffer, depth ${logicDepth(rsDecoder(10, 26))}`);
  });
});
