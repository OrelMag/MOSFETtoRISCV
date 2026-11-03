import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { ISS } from '../src/riscv/iss';
import { F32, bitsToF32, f32ToBits, fpDivX, fpFmaX, fpMulX } from '../src/sim/fpref';

const src = (id: string) => F_PROGRAMS.find((p) => p.id === id)!.source;
const run = (source: string, max = 5000) => {
  const asm = assemble(source);
  expect(asm.errors).toEqual([]);
  const iss = new ISS(asm.words);
  for (let i = 0; i < max && !iss.halted; i++) iss.step();
  expect(iss.halted).toBe(true);
  return { iss, asm };
};
const ONE = 0x3f800000, MAGIC = 0x7ef311c7;
const fma = (a: number, b: number, c: number) => fpFmaX(a, b, c, false, false, F32).y;
const nfma = (a: number, b: number, c: number) => fpFmaX(a, b, c, true, false, F32).y; // -(a*b) + c
const mul = (a: number, b: number) => fpMulX(a, b, F32).y;
const div = (a: number, b: number) => fpDivX(a, b, F32).y;
/** The program's algorithm: seed by one integer subtract, n Newton steps of two fma. */
const recip = (b: number, n = 3) => { let x = (MAGIC - b) >>> 0; for (let i = 0; i < n; i++) x = fma(x, nfma(b, x, ONE), x); return x; };
let seed = 20261103;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
/** Random float32 with an exponent in 100..154: quotients and products stay normal. */
const rbits = () => (((rnd() & 0x80000000) | ((100 + (rnd() % 55)) << 23) | (rnd() & 0x7fffff)) >>> 0);

describe('division by Newton-Raphson on the fma', () => {
  it('the program: 5 / 3 lands on the fdiv.s bits, a*x alone is one ulp off', () => {
    const { iss } = run(src('recip'));
    expect([iss.x[10], iss.x[11], iss.x[12], iss.x[13]]).toEqual([0x3fd55556, 0x3fd55555, 0x3fd55555, 1]);
    expect(iss.x[11]).toBe(div(f32ToBits(5), f32ToBits(3)));
  });
  it('the seed has 4.3 bits; each step squares the error', () => {
    let worst = 0;
    for (let i = 0; i < 50000; i++) {
      const b = (0x3f800000 + 0x800000 * (i & 1)) | (rnd() & 0x7fffff);
      worst = Math.max(worst, Math.abs(1 - bitsToF32(b) * bitsToF32((MAGIC - b) >>> 0)));
    }
    expect(worst).toBeGreaterThan(0.05);
    expect(worst).toBeLessThan(0.0506);
    // 0.0505 -> 2.6e-3 -> 6.5e-6 -> 4.2e-11: below 2^-24 only after three steps
    expect(worst ** 4).toBeGreaterThan(2 ** -24);
    expect(worst ** 8).toBeLessThan(2 ** -24);
  });
  it('measured against the correctly rounded quotient (printed: the chapter quotes these)', () => {
    const N = 100000;
    let xOff2 = 0, xOff3 = 0, qOff = 0, maxUlp = 0, mOff = 0;
    for (let i = 0; i < N; i++) {
      const a = rbits(), b = rbits();
      const ref = div(a, b);
      if (recip(b, 2) !== div(ONE, b)) xOff2++;
      const x = recip(b, 3);
      if (x !== div(ONE, b)) xOff3++;
      const q = mul(a, x);
      if (q !== ref) { qOff++; maxUlp = Math.max(maxUlp, Math.abs((q & 0x7fffffff) - (ref & 0x7fffffff))); }
      if (fma(nfma(b, q, a), x, q) !== ref) mOff++;
    }
    console.log(`1/b after 2 steps: ${xOff2} of ${N} not the correctly rounded reciprocal; after 3: ${xOff3}; a*x: ${qOff} off (max ${maxUlp} ulp); with the correction: ${mOff}`);
    expect(xOff2).toBeGreaterThan(N / 2);
    expect(xOff3).toBeLessThan(N / 1000);
    expect(qOff).toBeGreaterThan(N / 5);
    expect(qOff).toBeLessThan(N / 3);
    expect(maxUlp).toBe(1);
    expect(mOff).toBe(0);
  });
  it('the correction survives the operands whose reciprocal is not correctly rounded', () => {
    let seen = 0;
    for (let i = 0; i < 300000 && seen < 40; i++) {
      const b = rbits();
      const x = recip(b);
      if (x === div(ONE, b)) continue;
      seen++;
      for (let k = 0; k < 200; k++) {
        const a = rbits(), q = mul(a, x);
        expect(fma(nfma(b, q, a), x, q)).toBe(div(a, b));
      }
    }
    expect(seen).toBe(40);
  });
});

describe('float32 multiply without F', () => {
  /** Run the soft section on given operands: the result and the instructions between `soft` and `done`. */
  const soft = (source: string, a: number, b: number) => {
    const as = assemble(source);
    expect(as.errors).toEqual([]);
    const iss = new ISS(as.words);
    while (iss.pc !== as.labels.get('soft')) iss.step();
    iss.x[10] = a | 0; iss.x[11] = b | 0;
    let n = 0;
    while (iss.pc !== as.labels.get('done')) { iss.step(); n++; }
    return { y: iss.x[12] >>> 0, n };
  };
  it('the program: same bits as fmul.s', () => {
    const { iss, asm } = run(src('softmul'));
    expect(iss.x[12] >>> 0).toBe(mul(0x3dcccccd, 0x3f333333));
    expect(iss.x[13] >>> 0).toBe(iss.x[12] >>> 0);
    expect(iss.x[14]).toBe(0);
    expect(asm.words.length).toBeLessThanOrEqual(64);
  });
  it('random normal operands against fpref, ties and carries included', () => {
    const cases: [number, number][] = [[0x3f800000, 0x3f800000], [0x3fffffff, 0x3fffffff], [0x3f800001, 0x3f800001], [0x40490fdb, 0x40490fdb], [0xbf800000, 0x3fc00000], [0x3fc00000, 0x3fc00000]];
    for (let i = 0; i < 400; i++) cases.push([rbits(), rbits()]);
    // few-bit operands: products exactly halfway between two floats
    for (let i = 0; i < 100; i++) cases.push([(0x3f800000 | ((rnd() & 0xfff) << 11) | 0x400) >>> 0, (0x3f800000 | ((rnd() & 0xfff) << 11) | 0x400) >>> 0]);
    for (const [a, b] of cases) expect(soft(src('softmul'), a, b).y, `${a.toString(16)} x ${b.toString(16)}`).toBe(mul(a, b));
  });
  it('instruction counts: the loop against one fmul.s, and with mul / mulhu', () => {
    const counts = [soft(src('softmul'), 0x3dcccccd, 0x3f333333).n];
    for (let i = 0; i < 50; i++) counts.push(soft(src('softmul'), rbits(), rbits()).n);
    const M = src('softmul').replace(/        li   a4, 0[\s\S]*?bnez t5, mul[^\n]*\n/, '        mul  t5, t1, t2\n        mulhu a4, t1, t2\n        slli a4, a4, 8\n        srli t6, t5, 24\n        or   a4, a4, t6\n        slli t2, t5, 8\n');
    expect(M).not.toBe(src('softmul'));
    const m = [soft(M, 0x3dcccccd, 0x3f333333).n];
    for (let i = 0; i < 50; i++) { const a = rbits(), b = rbits(); const r = soft(M, a, b); expect(r.y).toBe(mul(a, b)); m.push(r.n); }
    console.log(`soft fmul: ${counts[0]} instructions for 0.1 x 0.7 (${Math.min(...counts)}..${Math.max(...counts)} over random operands); with mul/mulhu: ${m[0]} (${Math.min(...m)}..${Math.max(...m)})`);
    expect(counts[0]).toBeGreaterThan(200);
    expect(m[0]).toBeLessThan(40);
  });
});

describe('what the prose quotes', () => {
  it('a fourth step leaves a*x as often one ulp off; a quotient that is not normal breaks the correction', () => {
    let off4 = 0, miss = 0;
    const N = 30000;
    for (let i = 0; i < N; i++) { const a = rbits(), b = rbits(), x = recip(b, 4); if (mul(a, x) !== div(a, b)) off4++; }
    expect(off4).toBeGreaterThan(N / 5);
    // exponents wide enough for subnormal or overflowing quotients
    const wide = () => (((rnd() & 0x80000000) | ((60 + (rnd() % 134)) << 23) | (rnd() & 0x7fffff)) >>> 0);
    for (let i = 0; i < 100000; i++) { const a = wide(), b = wide(), x = recip(b), q = mul(a, x); if (fma(nfma(b, q, a), x, q) !== div(a, b)) miss++; }
    console.log(`4 steps: a*x off ${off4} of ${N}; wide exponents: correction wrong in ${miss} of 100000`);
    expect(miss).toBeGreaterThan(0);
  });
  it('NANDs and the break-even share of multiplies', async () => {
    const { singleCycleCpu, FPU32, fpDiv } = await import('../src/lib');
    const { stats } = await import('../src/sim/stats');
    const w = assemble(src('recip')).words;
    const i = stats(singleCycleCpu(w, { adder: 'ks' })).nands, f = stats(singleCycleCpu(w, { fpu: true, adder: 'ks' })).nands;
    console.log(`integer CPU ${i}, FPU CPU ${f}, FPU ${stats(FPU32).nands}, fdiv unit ${stats(fpDiv(F32)).nands}`);
    expect(Math.round(i / 100) * 100).toBe(58400);
    expect(Math.round(f / 100) * 100).toBe(172500);
    expect(Math.round(stats(fpDiv(F32)).nands / 100) * 100).toBe(10300);
    expect(((313 / 103 - 1) / 232) * 100).toBeCloseTo(0.88, 2);
    expect(100 * 313).toBe(31300);
    expect((98 + 2 * 233) * 103).toBe(58092);
  });
});

describe('cycles on the gate-level CPUs (the chapter quotes these)', () => {
  async function cycles(source: string, pipe: boolean) {
    const { pipelinedFpCpu, singleCycleCpu } = await import('../src/lib');
    const { clockCycle, retiring } = await import('../src/riscv/cosim');
    const { BitSim } = await import('../src/sim/bitsim');
    const { flatten } = await import('../src/sim/flatten');
    const asm = assemble(source);
    expect(asm.errors).toEqual([]);
    const sim = new BitSim(flatten(pipe ? pipelinedFpCpu(asm.words) : singleCycleCpu(asm.words, { fpu: true, adder: 'ks' })));
    sim.setInput('clk', 0);
    sim.settle();
    const iss = new ISS(asm.words);
    let c = 0;
    while (!iss.halted && c < 2000) { const r = retiring(sim); clockCycle(sim); c++; if (r) iss.step(); }
    expect(iss.halted).toBe(true);
    return c;
  }
  const full = src('recip');
  const noDiv = full.replace(/div:    fdiv.s[^\n]*\n/, '');
  const base = noDiv.replace(/        fmv.x.w t1, fa1[\s\S]*?(?=        fmv.x.w a0)/, '');
  for (const pipe of [false, true]) {
    it(pipe ? 'pipelined RV32IF' : 'single-cycle RV32IF', async () => {
      const [a, b, c] = [await cycles(full, pipe), await cycles(noDiv, pipe), await cycles(base, pipe)];
      console.log(`${pipe ? 'pipe' : 'single'}: newton ${b - c}, fdiv.s ${a - b}`);
      expect([b - c, a - b]).toEqual(pipe ? [43, 28] : [23, 29]);
    }, 120000);
  }
});
