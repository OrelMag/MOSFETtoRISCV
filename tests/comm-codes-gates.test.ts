// Chapter 47's codes in gates against the golden models (comm/conv.ts, comm/rs.ts): every output every clock, metrics and survivors read from the registers.
import { describe, expect, it } from 'vitest';
import { CONV_K3, CONV_K7, Viterbi, convStep, statesOf, type ConvSpec } from '../src/comm/conv';
import { gfMul, gfPow, rsEncode, rsGenerator, rsStep } from '../src/comm/rs';
import { convEncoder, gfConst, gfMulGates, notBus, rsEncoder, rsSyndrome, vitAcs, vitBranch, viterbi } from '../src/lib';
import { simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { checkSpec, lcg, out, set, tick } from './util';
import { tick as yieldTick } from './yieldtick';

type Sim = ReturnType<typeof simulate>;
const nodeOf = (sim: Sim, path: string[]) => { let n = sim.design.root; for (const p of path) n = n.children!.get(p)!; return n; };
const bitsOf = (sim: Sim, path: string[], port: string): number[] => Array.from(sim.getBits(nodeOf(sim, path).ports[port]));
const numOf = (sim: Sim, path: string[], port: string): number => bitsOf(sim, path, port).reduce((a, b, i) => a + b * 2 ** i, 0);

describe('parts', () => {
  it('match their specs', () => {
    checkSpec(notBus(3)); checkSpec(vitBranch(1, 4)); checkSpec(vitBranch(3, 8)); checkSpec(vitAcs(4)); checkSpec(vitAcs(8), 800);
    for (const c of [1, 2, 3, 0x1d, 0xe8, 0xff]) checkSpec(gfConst(c));
    checkSpec(gfMulGates(), 2000);
  });
});

describe('convolutional encoder', () => {
  for (const s of [CONV_K3, CONV_K7]) it(`${s.name}: a and b every clock`, () => {
    const sim = simulate(convEncoder(s)), r = lcg(11);
    let st = 0;
    for (let i = 0; i < 300; i++) {
      const u = r(2), en = r(4) ? 1 : 0;
      set(sim, { u, en });
      const m = convStep(s, st, u);
      expect([out(sim, 'a'), out(sim, 'b')], `step ${i}`).toEqual([m.a, m.b]);
      tick(sim);
      if (en) st = m.next;
    }
  });
});

function lockstep(s: ConvSpec, q: number, depth: number, steps: number, seed: number) {
  return async () => {
    const sim = simulate(viterbi(s, { q, depth })), v = new Viterbi(s, { q, depth }), r = lcg(seed), n = statesOf(s), L = 2 ** q;
    const check = (at: string) => {
      expect(out(sim, 'out'), `${at} out`).toBe(v.out);
      for (let i = 0; i < n; i++) {
        expect(numOf(sim, [`u${i}`], 'm'), `${at} metric ${i}`).toBe(v.metric[i]);
        const got = bitsOf(sim, [`u${i}`], 's');
        for (let b = 0; b < depth; b++) if (got[b] !== v.surv[i][b]) expect(got[b], `${at} survivor ${i} bit ${b}`).toBe(v.surv[i][b]);
      }
    };
    let enabled = 0;
    const seen = new Set<number>(); // `out` once the survivors are `depth` long: real decoded data, not the reset's zeros
    set(sim, { r0: 0, r1: 0, en: 0, rst: 1, clk: 0 }); tick(sim); set(sim, { rst: 0 }); v.resetMetrics();
    check('reset');
    for (let t = 0; t < steps; t++) {
      const r0 = r(L), r1 = r(L), en = r(5) ? 1 : 0;
      set(sim, { r0, r1, en });
      if (en && ++enabled > depth) seen.add(v.out);
      if (en) { // the selects are combinational: read them before the edge
        v.step(r0, r1);
        for (let i = 0; i < n; i++) expect(numOf(sim, [`u${i}`], 'sel'), `t ${t} sel ${i}`).toBe(v.sel[i]);
      }
      tick(sim);
      check(`t ${t}`);
      if (t % 8 === 7) await yieldTick();
    }
    if (enabled > depth + 20) expect(seen.size, 'out carried both values after the survivors filled').toBe(2);
  };
}

describe('Viterbi decoder', () => {
  it('K = 3, hard: every metric, select, survivor and output every clock', lockstep(CONV_K3, 1, 30, 400, 21), 60000);
  it('K = 3, three-bit levels', lockstep(CONV_K3, 3, 12, 200, 22), 60000);
  it('K = 7, hard, the standard code', lockstep(CONV_K7, 1, 70, 120, 23), 300000);
  it('K = 7, three-bit levels', lockstep(CONV_K7, 3, 70, 120, 24), 600000); // past the depth, so `out` is decoded data
  it('reports its costs', () => {
    // eslint-disable-next-line no-console
    for (const [s, o] of [[CONV_K3, {}], [CONV_K7, {}], [CONV_K7, { q: 3 }]] as const) { const d = viterbi(s, o); console.log(d.name, stats(d).nands, stats(d).transistors, logicDepth(d)); }
    // eslint-disable-next-line no-console
    console.log('enc', stats(convEncoder(CONV_K3)).nands, stats(convEncoder(CONV_K7)).nands, 'rsenc', stats(rsEncoder(10)).nands, stats(rsEncoder(32)).nands, 'syn', stats(rsSyndrome(10)).nands, stats(rsSyndrome(32)).nands, 'gfmul', stats(gfMulGates()).nands);
  });
});

describe('Reed-Solomon', () => {
  const qr = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], ecc = [196, 35, 39, 119, 235, 215, 231, 226, 93, 23];
  it('the encoder: every register every clock, and the published QR check bytes come out', () => {
    const sim = simulate(rsEncoder(10)), g = rsGenerator(10);
    let st = new Array<number>(10).fill(0);
    set(sim, { d: 0, msg: 0, en: 0, clr: 1, clk: 0 }); tick(sim); set(sim, { clr: 0 });
    const regs = () => st.map((_, i) => numOf(sim, [`s${i}`], 'q'));
    for (const b of qr) {
      set(sim, { d: b, msg: 1, en: 1 });
      expect(out(sim, 'out')).toBe(b);
      tick(sim);
      st = rsStep(g, st, b);
      expect(regs()).toEqual(st);
    }
    expect(st).toEqual(ecc);
    const sent: number[] = [];
    for (let i = 0; i < 10; i++) { set(sim, { d: 0, msg: 0, en: 1 }); sent.push(out(sim, 'out')); tick(sim); }
    expect(sent).toEqual(ecc);
    st = new Array<number>(10).fill(0);
    expect(regs()).toEqual(st);
  });
  it('32 check bytes on random data', () => {
    const sim = simulate(rsEncoder(32)), r = lcg(5), msg = Array.from({ length: 40 }, () => r(256));
    set(sim, { d: 0, msg: 0, en: 0, clr: 1, clk: 0 }); tick(sim); set(sim, { clr: 0 });
    for (const b of msg) { set(sim, { d: b, msg: 1, en: 1 }); tick(sim); }
    const sent: number[] = [];
    for (let i = 0; i < 32; i++) { set(sim, { d: 0, msg: 0, en: 1 }); sent.push(out(sim, 'out')); tick(sim); }
    expect(sent).toEqual(rsEncode(msg, 32));
  });
  it('the syndrome unit: each register every clock; a code word ends ok, a flipped bit does not', () => {
    const sim = simulate(rsSyndrome(10)), cw = [...qr, ...ecc];
    for (const hit of [-1, 0, 7, 25]) {
      set(sim, { d: 0, en: 0, clr: 1, clk: 0 }); tick(sim); set(sim, { clr: 0 });
      const s = new Array<number>(10).fill(0);
      cw.forEach((b0, i) => {
        const b = i === hit ? b0 ^ 0x10 : b0;
        set(sim, { d: b, en: 1 }); tick(sim);
        for (let j = 0; j < 10; j++) { s[j] = gfMul(s[j], gfPow(j)) ^ b; expect(numOf(sim, [`s${j}`], 's')).toBe(s[j]); }
      });
      set(sim, { en: 0 });
      expect(out(sim, 'ok'), `hit ${hit}`).toBe(hit < 0 ? 1 : 0);
    }
  });
});
