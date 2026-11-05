// Many carriers: the integer FFT against the float one, and the gates against the integer model.
import { describe, expect, it } from 'vitest';
import { addH, butterflyFx, cmulFx, FftStream, fftFx, flowGraph, ifftFx, packFx, rootHalf, safeMagnitude, subH, twiddle, twiddleCount, twiddleFx, unpackFx, wrap, type Fx } from '../src/comm/fftfix';
import { cx, fft, fftMults } from '../src/comm/fourier';
import { csdDigits, fftNet, fftStream, fxButterfly, fxCmul, fxCore, fxHalve, fxMinusJ, fxRoot, fxRot45, roundUp } from '../src/lib/fft';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { inPorts } from '../src/sim/types';

const rnd = (seed: number) => { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32); };

/** A random block with |x| at most m (in units of full scale). */
function block(N: number, W: number, m: number, u: () => number): Fx[] {
  return Array.from({ length: N }, () => {
    const r = m * Math.sqrt(u()), a = 2 * Math.PI * u();
    return { re: Math.trunc(r * Math.cos(a) * 2 ** (W - 1)), im: Math.trunc(r * Math.sin(a) * 2 ** (W - 1)) };
  });
}
const tone = (N: number, W: number, m: number, k: number): Fx[] => Array.from({ length: N }, (_, n) => ({ re: Math.trunc(m * Math.cos((2 * Math.PI * k * n) / N) * 2 ** (W - 1)), im: Math.trunc(m * Math.sin((2 * Math.PI * k * n) / N) * 2 ** (W - 1)) }));

/** Largest error, in units of the last place, against the float FFT divided by N. */
function maxErr(x: Fx[], W: number): number {
  const N = x.length, F = fft(cx(x.map((c) => c.re), x.map((c) => c.im))), got = fftFx(x, W);
  let e = 0;
  got.forEach((c, k) => { e = Math.max(e, Math.abs(c.re - F.re[k] / N), Math.abs(c.im - F.im[k] / N)); });
  return e;
}

/** Signal over error, dB, of the transform at word width W, on full-scale blocks. */
function snrDb(N: number, W: number, seed: number): number {
  const u = rnd(seed);
  let sig = 0, err = 0;
  for (let t = 0; t < 40; t++) {
    const x = block(N, W, 0.9, u), F = fft(cx(x.map((c) => c.re), x.map((c) => c.im))), got = fftFx(x, W);
    got.forEach((c, k) => { const fr = F.re[k] / N, fi = F.im[k] / N; sig += fr * fr + fi * fi; err += (c.re - fr) ** 2 + (c.im - fi) ** 2; });
  }
  return 10 * Math.log10(sig / err);
}

describe('the integer FFT', () => {
  it('rounds a butterfly so that the sum and the difference lose nothing', () => {
    for (let x = -32; x < 32; x++) for (let y = -32; y < 32; y++) expect(addH(x, y, 6) + subH(x, y, 6)).toBe(x);
  });
  it('stays within a stated distance of the float FFT, at every size and on the worst blocks', () => {
    const u = rnd(7);
    for (const N of [2, 4, 8, 16, 32, 64, 256, 512]) for (const W of [10, 12, 16]) {
      const limit = 2 * Math.log2(N) + 2, m = safeMagnitude(W, N);
      for (let t = 0; t < 6; t++) expect(maxErr(block(N, W, m, u), W), `N ${N} W ${W}`).toBeLessThanOrEqual(limit);
      for (const k of [0, 1, N / 4, N / 2, N - 1]) expect(maxErr(tone(N, W, m, k), W), `N ${N} W ${W} tone ${k}`).toBeLessThanOrEqual(limit);
    }
  });
  it('gains about 6 dB a bit and loses about 3 dB a doubling of N', () => {
    const a = snrDb(64, 10, 1), b = snrDb(64, 14, 1), c = snrDb(256, 14, 1);
    expect((b - a) / 4).toBeGreaterThan(5.5); expect((b - a) / 4).toBeLessThan(6.5);
    expect((b - c) / 2).toBeGreaterThan(2); expect((b - c) / 2).toBeLessThan(4);
  });
  it('inverts by swapping the parts, as defined', () => {
    const u = rnd(3), W = 14, N = 16, X = block(N, W, 0.8, u), F = fft(cx(X.map((c) => c.re), X.map((c) => c.im)), true), got = ifftFx(X, W);
    got.forEach((c, k) => { expect(Math.abs(c.re - F.re[k])).toBeLessThanOrEqual(10); expect(Math.abs(c.im - F.im[k])).toBeLessThanOrEqual(10); });
  });
  it('needs far fewer real multiplications than the count of butterflies', () => {
    expect(flowGraph(8).flat().length).toBe(fftMults(8));
    expect(twiddleCount(8)).toEqual({ one: 7, minusj: 3, root1: 1, root3: 1, general: 0 });
    const c = twiddleCount(64);
    expect(c.one + c.minusj + c.root1 + c.root3 + c.general).toBe(fftMults(64));
    expect(c.general).toBeLessThan(fftMults(64) / 2);
  });
  it('rounds every twiddle to within half a unit of the true value', () => {
    for (const [N, W] of [[8, 10], [16, 10], [64, 12], [512, 12]]) for (let k = 1; k < N / 2; k++) {
      const t = twiddle(k, N, W), s = 2 ** (W - 1), a = (2 * Math.PI * k) / N;
      expect(Math.abs(t.re - Math.cos(a) * s), `${k} of ${N}`).toBeLessThanOrEqual(t.re === s - 1 ? 1 : 0.5);
      expect(Math.abs(t.im + Math.sin(a) * s), `${k} of ${N}`).toBeLessThanOrEqual(0.5);
    }
  });
  it('writes 1/√2 in signed digits that add back up', () => {
    for (const W of [8, 10, 12, 16]) {
      const C = rootHalf(W), d = csdDigits(C);
      expect(d.reduce((a, x) => a + (x.neg ? -1 : 1) * 2 ** x.pos, 0)).toBe(C);
      d.slice(1).forEach((x, i) => expect(x.pos - d[i].pos).toBeGreaterThan(1));
    }
  });
});

function checkSpec(def: ComponentDef, tries = 1500) {
  const sim = simulate(def), u = rnd(99);
  for (let t = 0; t < tries; t++) {
    const ins = inPorts(def).map((p) => Math.floor(u() * 2 ** p.width));
    expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins));
  }
}

describe('the FFT in gates matches the integer model', () => {
  it('halving adders, every input', () => {
    for (const sub of [false, true]) checkSpec(fxHalve(6, sub), 3000);
  });
  it('the rounder, the constant multiplier and the 45° turn', () => {
    checkSpec(roundUp(6), 200); checkSpec(fxRoot(10)); checkSpec(fxRot45(10), 600);
  });
  it('the general complex multiplier', () => { checkSpec(fxCmul(10), 400); });
  it('every kind of butterfly', () => {
    checkSpec(fxCore(8, false), 500); checkSpec(fxCore(8, true), 500);
    for (const [k, N] of [[0, 8], [2, 8], [1, 8], [3, 8], [1, 16]]) checkSpec(fxButterfly(10, k, N), 300);
  });
  it('the 8-point network, on random words and on blocks within the safe magnitude', () => {
    const W = 10, def = fftNet(8, W), sim = simulate(def), u = rnd(5);
    for (let t = 0; t < 150; t++) {
      const x = t < 75 ? Array.from({ length: 8 }, () => unpackFx(Math.floor(u() * 2 ** (2 * W)), W)) : block(8, W, safeMagnitude(W, 8), u);
      const got = evalOnce(sim, x.map((c) => packFx(c, W)));
      expect(got.map((v: number) => unpackFx(v, W))).toEqual(fftFx(x, W));
    }
  });
  it('keeps the largest inputs in range', () => {
    const W = 10, M = 2 ** (W - 1) - 1, [y0] = butterflyFx({ re: M, im: M }, { re: M, im: M }, 0, 8, W);
    expect(wrap(y0.re, W)).toBe(M);
  });
  it('costs what it costs', () => {
    const c = (d: ComponentDef) => stats(d).nands;
    // eslint-disable-next-line no-console
    console.log('NANDs', { add: c(fxHalve(10, false)), core: c(fxCore(10, false)), root: c(fxRoot(10)), rot45: c(fxRot45(10)), cmul: c(fxCmul(10)), fft4: c(fftNet(4, 10)), fft8: c(fftNet(8, 10)), fft16: c(fftNet(16, 10)) });
    expect(c(fxRot45(10))).toBeLessThan(c(fxCmul(10)) / 2);
  });
});

describe('the streaming FFT', () => {
  const nodeOf = (sim: ReturnType<typeof simulate>, path: string[]) => { let n = sim.design.root; for (const p of path) n = n.children!.get(p)!; return n; };
  const num = (sim: ReturnType<typeof simulate>, path: string[], port: string) => Array.from(sim.getBits(nodeOf(sim, path).ports[port])).reduce<number>((a, b, i) => a + Number(b) * 2 ** i, 0);

  it('model: the tones are the float FFT\'s within the bound', () => {
    const u = rnd(11);
    for (const N of [4, 8, 16, 64, 256]) for (const W of [10, 14]) {
      const x = block(N, W, safeMagnitude(W, N), u), got = FftStream.transform(x, W), F = fft(cx(x.map((c) => c.re), x.map((c) => c.im))), lim = 2 * Math.log2(N) + 2;
      got.forEach((c, k) => { expect(Math.abs(c.re - F.re[k] / N), `N ${N} W ${W} k ${k}`).toBeLessThanOrEqual(lim); expect(Math.abs(c.im - F.im[k] / N)).toBeLessThanOrEqual(lim); });
    }
  });
  it('a quarter turn through the multiplier is the same word as the wires', () => {
    const u = rnd(13), W = 10;
    for (let t = 0; t < 500; t++) { const x = unpackFx(Math.floor(u() * 2 ** (2 * W)), W); expect(cmulFx(x, twiddle(4, 16, W), W)).toEqual(twiddleFx(x, 4, 16, W)); }
  });
  it('quarter turn gates', () => { checkSpec(fxMinusJ(10), 400); });
  for (const [N, W] of [[4, 8], [8, 10], [16, 10]] as const) it(`gates: every register every clock, ${N} points`, async () => {
    const def = fftStream(N, W), sim = simulate(def), f = new FftStream(N, W), u = rnd(N * 31);
    const set = (d: number, en: number, rst: number) => { sim.setInput('d', d); sim.setInput('en', en); sim.setInput('rst', rst); sim.settle(); };
    const edge = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); };
    set(0, 0, 1); f.step({ re: 0, im: 0 }, false, true); edge();
    for (let t = 0; t < 40 * N; t++) {
      const en = u() < 0.85 ? 1 : 0, rst = u() < 0.002 ? 1 : 0, x = unpackFx(Math.floor(u() * 2 ** (2 * W)), W);
      set(packFx(x, W), en, rst);
      f.step(x, !!en, !!rst);
      edge();
      f.stages.forEach((st, s) => {
        expect(num(sim, [`s${s}`, 'ctr'], 'q'), `t ${t} count ${s}`).toBe(st.count);
        expect(num(sim, [`s${s}`, 'out'], 'q'), `t ${t} out ${s}`).toBe(packFx(st.out, W));
        st.line.forEach((v, i) => expect(num(sim, [`s${s}`, 'line', `w${i}`], 'q'), `t ${t} line ${s}.${i}`).toBe(packFx(v, W)));
      });
      if (t % 100 === 0) await new Promise((r) => setTimeout(r));
    }
  }, 120000);
  it('costs: the unrolled network against the stream', () => {
    const c = (d: ComponentDef) => stats(d).nands;
    // eslint-disable-next-line no-console
    console.log('stream NANDs', { s8: c(fftStream(8, 10)), s16: c(fftStream(16, 10)), s64: c(fftStream(64, 10)), s64w12: c(fftStream(64, 12)), s512: c(fftStream(512, 12)), net8: c(fftNet(8, 10)), net16: c(fftNet(16, 10)), minusj: c(fxMinusJ(10)) });
    expect(c(fftStream(16, 10))).toBeLessThan(c(fftNet(16, 10)));
  });
});
