// A breakpoint's condition language (editor/breakexpr.ts): radixes, slices, unknown bits, rose / fell / changed.

import { describe, expect, it } from 'vitest';
import { type BreakMemory, evalBreak, parseBreak } from '../src/editor/breakexpr';
import type { Bit } from '../src/sim/types';

const bitsOf = (v: bigint, w: number): Bit[] => Array.from({ length: w }, (_, i) => Number((v >> BigInt(i)) & 1n) as Bit);
const parse = (s: string) => { const e = parseBreak(s); if ('error' in e) throw new Error(`${s}: ${e.error}`); return e; };
/** Evaluate once with signals given as [value, width] or as raw bits ({ bits }). */
type Sig = [bigint | number, number] | { bits: Bit[] };
const run = (s: string, sig: Record<string, Sig>, mem: BreakMemory = []) =>
  evalBreak(parse(s), (n) => { const x = sig[n]; return !x ? null : 'bits' in x ? x.bits : bitsOf(BigInt(x[0]), x[1]); }, mem);

describe('breakpoint conditions', () => {
  it('numbers in every radix, with underscores', () => {
    for (const lit of ['64', '0x40', '0X4_0', '0b100_0000', '0o100']) expect(run(`pc == ${lit}`, { pc: [64, 32] }).hit, lit).toBe(true);
    expect(run('pc != 0x40', { pc: [64, 32] }).hit).toBe(false);
  });
  it('comparisons are unsigned and exact past 53 bits', () => {
    expect(run('a < b', { a: [5, 4], b: [9, 4] }).hit).toBe(true);
    expect(run('a >= 0xffff_ffff_ffff_ffff', { a: [2n ** 64n - 1n, 64] }).hit).toBe(true);
    expect(run('a == 0x1_0000_0000_0000_0001', { a: [2n ** 64n + 1n, 80] }).hit).toBe(true);
    expect(run('a == 0x1_0000_0000_0000_0000', { a: [2n ** 64n + 1n, 80] }).hit).toBe(false);
  });
  it('bit selects and slices', () => {
    expect(run('ir[6:0] == 0b1100011', { ir: [0x00b50463, 32] }).hit).toBe(true);
    expect(run('ir[3]', { ir: [0b1000, 4] }).hit).toBe(true);
    expect(run('ir[2]', { ir: [0b1000, 4] }).hit).toBe(false);
    expect(run('(a & 0xf0)[7:4] == 3', { a: [0x3c, 8] }).hit).toBe(true);
  });
  it('logic and bitwise operators, with C precedence', () => {
    expect(run('count >= 12 && en', { count: [12, 8], en: [1, 1] }).hit).toBe(true);
    expect(run('count >= 12 && en', { count: [12, 8], en: [0, 1] }).hit).toBe(false);
    expect(run('a | b == 0', { a: [0, 1], b: [0, 1] }).hit).toBe(true); // a | (b == 0)
    expect(run('!stall || ~m == 0b10', { stall: [1, 1], m: [1, 2] }).hit).toBe(true);
    expect(run('(a ^ b) == 6', { a: [5, 3], b: [3, 3] }).hit).toBe(true);
  });
  it('an unknown bit makes a comparison unknown, never a hit; a known side can still decide', () => {
    const x = { bits: [1, 2, 0, 0] as Bit[] };
    expect(run('a == 1', { a: x })).toEqual({ hit: false, unknown: true });
    expect(run('a[0]', { a: x })).toEqual({ hit: true, unknown: false });
    expect(run('a[1]', { a: x })).toEqual({ hit: false, unknown: true });
    expect(run('a == 1 || b', { a: x, b: [1, 1] })).toEqual({ hit: true, unknown: false });
    expect(run('a == 1 && b', { a: x, b: [0, 1] })).toEqual({ hit: false, unknown: false });
    expect(run('(a & 0b0001) == 1', { a: x })).toEqual({ hit: true, unknown: false });
    expect(run('a[7]', { a: x }).unknown).toBe(true);
    expect(run('nothere', {}).unknown).toBe(true);
  });
  it('rose, fell and changed against the previous check', () => {
    const e = parse('rose(miss) || fell(hit) && changed(pc)');
    const mem: BreakMemory = [];
    const seq: [number, number, number, boolean][] = [[0, 1, 0, false], [1, 1, 4, true], [1, 0, 8, true], [1, 0, 8, false], [0, 1, 8, false]];
    seq.forEach(([miss, hit, pc, want], i) => {
      const r = evalBreak(e, (n) => bitsOf(BigInt(n === 'miss' ? miss : n === 'hit' ? hit : pc), n === 'pc' ? 8 : 1), mem);
      expect(r.hit, `check ${i}`).toBe(want);
    });
  });
  it('names: pins, part.port and paths into chips', () => {
    expect(parse('cpu.rf.x5 == 3 && alu1.y').names).toEqual(['cpu.rf.x5', 'alu1.y']);
  });
  it('says what is wrong and where', () => {
    for (const [s, at] of [['pc ==', 5], ['pc == 0x40 )', 11], ['a < b < c', 6], ['x[2:5]', 6], ['pc @ 3', 3], ['', 0]] as const) {
      const r = parseBreak(s);
      expect('error' in r, s).toBe(true);
      if ('error' in r) expect(r.at, s).toBe(at);
    }
  });
});
