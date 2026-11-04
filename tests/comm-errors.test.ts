// Chapter 47's typed numbers: the figures the prose and the quizzes state by hand are pinned here to the models and circuits
// they describe (the computed ones come from the code and need no pin).

import { describe, expect, it } from 'vitest';
import { chErrors } from '../src/chapters/ch-comm-errors';
import { chapterById, chapters } from '../src/chapters';
import { aOf, fullWindow, rttOf, utilization } from '../src/comm/arq';
import { CRC16, CRC32_POLY, CRC32_REFLECTED, CRC32_RESIDUE, CRC8, crc32, polyRem, weightDistribution } from '../src/comm/crc';
import { codeOf, crcOnly, crossover, crossoverTime, secdedCrc } from '../src/comm/fec';
import { stuffRate } from '../src/comm/framing';
import { CLOCK_NS } from '../src/dram/timing';
import { crcNext, crcUnit, eccChannel, hammingDec, hammingEnc, hammingLayout, parity } from '../src/lib';
import { codingGain, convSoftBound, ebn0For, shannonBinaryDb } from '../src/comm/ber';
import { CONV_K7 } from '../src/comm/conv';
import { systemCpu, viterbi } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { VIT_FLIPS, vitStreamErrors } from '../src/widgets/codes';
import { evalOnce, simulate } from '../src/sim/harness';
import { flatten } from '../src/sim/flatten';
import { logicDepth, stats } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';

const soft5 = () => codingGain((d) => convSoftBound(CONV_K7, d), 1e-5);
const popcount = (x: number) => { let n = 0; for (let v = x >>> 0; v; v >>>= 1) n += v & 1; return n; };
const period = (w: number) => analyzeTiming(flatten(crcUnit(32, CRC32_REFLECTED, w), { mode: 'gate' }))!.period;

describe('chapter 47 typed numbers', () => {
  it('the stronger codes: the Viterbi challenge\'s flips, the K = 7 decoder against the system CPU, the distance from Shannon', () => {
    expect(vitStreamErrors(VIT_FLIPS)).toBeGreaterThan(0);
    for (let a = 10; a < 32; a++) for (let b = a + 1; b < 32; b++) expect(vitStreamErrors([a, b]), `flips ${a} ${b}`).toBe(0);
    const cpu = stats(systemCpu(assemble(PROGRAMS[0].source).words, { m: true })).nands, v7 = stats(viterbi(CONV_K7)).nands;
    expect(v7 / cpu).toBeGreaterThan(0.75); expect(v7 / cpu).toBeLessThan(1.25);
    expect(soft5()).toBeGreaterThan(4.6); expect(soft5()).toBeLessThan(5.6);
    expect(ebn0For((d) => convSoftBound(CONV_K7, d), 1e-5) - shannonBinaryDb(0.5)).toBeGreaterThan(3.5);
    expect(ebn0For((d) => convSoftBound(CONV_K7, d), 1e-5) - shannonBinaryDb(0.5)).toBeLessThan(4.5);
  });
  it('is chapter 47, fourteen steps, after what it builds on, with the appendices after every numbered chapter', () => {
    expect(chErrors.num).toBe(47);
    expect(chErrors.steps).toHaveLength(14);
    expect(chapterById('errors')).toBe(chErrors);
    for (const id of chErrors.builds ?? []) expect(chapterById(id)!.num).toBeLessThan(47);
    const last = Math.max(...chapters.filter((c) => !c.appendix).map((c) => c.num));
    for (const c of chapters.filter((x) => x.appendix)) expect(c.num).toBeGreaterThan(last);
    expect(chErrors.steps.every((s) => !!s.scene !== !!s.widget && s.challenge)).toBe(true);
    expect(chErrors.recap!.check).toHaveLength(3);
  });
  it('step 1: parity costs 28 NANDs and 9 levels for 8 bits; the miss share is (n - 1) p / 2', () => {
    expect(stats(parity(8)).nands).toBe(28);
    expect(logicDepth(parity(8))).toBe(9);
    expect(stats(parity(64)).nands).toBe(252);
    expect(logicDepth(parity(64))).toBe(18);
  });
  it('step 2: SEC-DED for 8 and 64 data bits; flipping two bits of the stored word raises double', () => {
    expect([stats(hammingEnc(8)).nands, stats(hammingDec(8)).nands]).toEqual([76, 280]);
    expect([logicDepth(hammingEnc(8)), logicDepth(hammingDec(8))]).toEqual([9, 19]);
    expect([stats(hammingEnc(64)).nands, stats(hammingDec(64)).nands]).toEqual([928, 3052]);
    expect(logicDepth(hammingDec(64))).toBe(30);
    expect(hammingLayout(8)).toMatchObject({ r: 4, n: 13 });
    expect(hammingLayout(64)).toMatchObject({ r: 7, n: 72 });
    const sim = simulate(eccChannel(8));
    const two = evalOnce(sim, [0xa5, 0b101]), one = evalOnce(sim, [0xa5, 0b100]);
    expect([two[2], two[3]]).toEqual([0, 1]);
    expect([one[1], one[2], one[3]]).toEqual([0xa5, 1, 0]);
  });
  it('step 3: the generator has 15 terms, so no x + 1 factor; it misses some odd-weight patterns, CRC-16 none; bursts of 32 never', () => {
    expect(popcount(CRC32_POLY) + 1).toBe(15);
    const g = [1, ...Array.from({ length: 32 }, (_, i) => (CRC32_POLY >>> (31 - i)) & 1)];
    expect(g.reduce((a, b) => a + b, 0) % 2).toBe(1);
    expect(polyRem(g, CRC32_POLY, 32)).toBe(0); // the generator itself, weight 15, is an undetected error
    const A16 = weightDistribution(16, CRC16);
    expect(A16.filter((_, w) => w % 2 === 1).every((x) => x === 0)).toBe(true);
    expect(popcount(CRC16.poly) + 1).toBe(4); // x^16 + x^12 + x^5 + 1
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let len = 1; len <= 32; len++) for (let t = 0; t < 20; t++) {
      const e = Array.from({ length: len }, (_, i) => (i === 0 || i === len - 1 ? 1 : r() < 0.5 ? 1 : 0));
      expect(polyRem([...Array(5).fill(0), ...e, ...Array(7).fill(0)], CRC32_POLY, 32)).not.toBe(0);
    }
    expect(crc32(Array.from(Buffer.from('123456789')))).toBe(0xcbf43926);
    expect(CRC32_RESIDUE).toBe(0xdebb20e3);
  });
  it('step 4: CRC-8 on 16 data bits has no code word lighter than 4 (80 of weight 4); 2^-32 per frame; days per garbage frame', () => {
    const A = weightDistribution(16, CRC8);
    expect(A.slice(1, 4)).toEqual([0, 0, 0]);
    expect(A[4]).toBe(80);
    const rate = 1e9 / (4 * CLOCK_NS), fps = rate / (8 * 1500 + 32);
    expect(Math.round(fps)).toBe(5260);
    expect(2 ** 32 / fps / 86400).toBeCloseTo(9.5, 0);
  });
  it('step 5: the serial next-state is 14 XORs = 56 NANDs, 6 levels; the unit 795 NANDs; 16 delays a clock', () => {
    expect(popcount(CRC32_REFLECTED)).toBe(14);
    expect(stats(crcNext(32, CRC32_REFLECTED, 1)).nands).toBe(56);
    expect(logicDepth(crcNext(32, CRC32_REFLECTED, 1))).toBe(6);
    expect(stats(crcUnit(32, CRC32_REFLECTED, 1)).nands).toBe(795);
    expect(period(1)).toBe(16);
  });
  it('step 6: byte-wide 880 NANDs written out, 288 shared, 12 levels; the unit 1027; 22 delays a clock', () => {
    expect(stats(crcNext(32, CRC32_REFLECTED, 8, false)).nands).toBe(880);
    expect(stats(crcNext(32, CRC32_REFLECTED, 8)).nands).toBe(288);
    expect(logicDepth(crcNext(32, CRC32_REFLECTED, 8))).toBe(12);
    expect(stats(crcUnit(32, CRC32_REFLECTED, 8)).nands).toBe(1027);
    expect(period(8)).toBe(22);
    expect(1000 / (22 * 25) / (1000 / (16 * 25))).toBeCloseTo(16 / 22, 6);
  });
  it('step 7: stuffing 1 in 62 on random data, 1 in 5 worst case', () => {
    expect(1 / stuffRate()).toBeCloseTo(62, 9);
  });
  it('step 8: 63.3 Mb/s, a 1500-byte frame in 189 us, a = 52.7 over 10 ms, a window of 107; stop-and-wait uses 0.93 %', () => {
    const rate = 1e9 / (4 * CLOCK_NS);
    expect(rate / 1e6).toBeCloseTo(63.29, 2);
    expect((1500 * 8) / rate * 1e6).toBeCloseTo(189.6, 1);
    const a = aOf(10e-3, 12000, rate);
    expect(a).toBeCloseTo(52.74, 2);
    expect(fullWindow(a)).toBe(107);
    expect(rttOf(a)).toBeCloseTo(106.5, 1);
    expect(utilization('saw', a, 1, 0.01) * 100).toBeCloseTo(0.93, 2);
    expect(1 / (rate * 1e-12) / 3600).toBeCloseTo(4.4, 1);
  });
  it('step 9: SEC-DED(72, 64) is 8 check bits, 12.5 % redundancy; the goodput crossover is 9.8e-6; the delivery crossovers 9.7e-6 (1 us) and 3.9e-9 (250 ms)', () => {
    expect(codeOf(64)).toMatchObject({ r: 8, n: 72 });
    expect(72 / 64 - 1).toBe(0.125);
    expect(crossover(1500)!).toBeCloseTo(9.79e-6, 8);
    const rate = 1e9 / (4 * CLOCK_NS);
    expect(crossoverTime(1500, rate, 1e-6)!).toBeCloseTo(9.7e-6, 7);
    expect(crossoverTime(1500, rate, 0.25)!).toBeCloseTo(3.95e-9, 11);
    expect(crcOnly(1500, 1e-5).pFail).toBeCloseTo(0.1134, 3);
    expect(secdedCrc(1500, 1e-5).wire).toBe(13536);
    expect(crcOnly(1500, 1e-9).goodput).toBeGreaterThan(secdedCrc(1500, 1e-9).goodput);
  });
});
