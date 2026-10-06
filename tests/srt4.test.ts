import { describe, expect, it } from 'vitest';
import { SRT4_SELECT, divRef4, srt4Digit, srt4SelectHw, srt4Divider, srt4Step, srt4Term, srt4Thresholds, srtDivider } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { analyzeTiming } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';
import { checkSpec, corners, lcg, out, set, tick } from './util';

describe('radix-4 SRT selection', () => {
  it('thresholds match the published table for the first divisor interval', () => {
    // Ercegovac & Lang: d = [1/2, 9/16): m2 = 12, m1 = 4, m0 = -4, m-1 = -13 (in 1/16); ours are the
    // smallest valid values, so m1 and m0 may sit one step lower inside the same valid range.
    const [m2, m1, m0, mm1] = srt4Thresholds()[0];
    expect([m2, mm1]).toEqual([12, -13]);
    expect(m1).toBeGreaterThanOrEqual(3); expect(m1).toBeLessThanOrEqual(4);
    expect(m0).toBeGreaterThanOrEqual(-5); expect(m0).toBeLessThanOrEqual(-4);
  });
  it('the hardware selection is the reference digit for every reachable estimate', () => {
    for (let i = 0; i < 8; i++) for (let e = -64; e < 64; e++) for (let s = 0; s < 256; s += 37) {
      const q = srt4Digit(e & 255, i);
      expect(srt4SelectHw(s, (e - s) & 255, i), `e=${e} i=${i}`).toEqual([q === 2 ? 1 : 0, q === 1 ? 1 : 0, q === -1 ? 1 : 0, q === -2 ? 1 : 0]);
    }
  });
  it('every chosen digit keeps the next remainder in range (exact rational check)', () => {
    // y in units of 1/256 of the divisor scale, d in 1/256: for every divisor and every y the carry-save
    // estimate can come from, the digit for that estimate must satisfy |y - q d| ≤ 2/3 d.
    for (let d = 128; d < 256; d++) {
      const i = (d >> 4) - 8;
      for (let y = Math.ceil((-8 * d) / 3); y <= Math.floor((8 * d) / 3); y++) {
        // estimate (1/16 units) is floor(y/16) or up to 1 lower (two truncated words)
        for (const est of [Math.floor(y / 16), Math.floor(y / 16) - 1]) {
          const q = srt4Digit(est & 255, i);
          expect(3 * Math.abs(y - q * d), `d=${d} y=${y} est=${est} q=${q}`).toBeLessThanOrEqual(2 * d);
        }
      }
    }
  });
});

describe('radix-4 SRT parts match their specs', () => {
  for (const d of [SRT4_SELECT, srt4Term(4, 8), srt4Term(8, 12), srt4Step(4), srt4Step(8)]) it(d.id, () => checkSpec(d, 400, corners(d)));
});

function divide(s: Sim, a: number, b: number): [number, number, number] {
  set(s, { start: 1, a, b });
  let cycles = 1;
  tick(s);
  set(s, { start: 0 });
  while (!out(s, 'done')) { tick(s); cycles++; expect(cycles).toBeLessThan(60); }
  const res: [number, number, number] = [out(s, 'q'), out(s, 'r'), cycles + 1];
  tick(s);
  return res;
}
function check(def: ComponentDef, n: number, pairs: [number, number][]) {
  const s = simulate(def);
  set(s, { clk: 0, start: 0, a: 0, b: 0 });
  for (const [a, b] of pairs) expect(divide(s, a, b), `${a} / ${b}`).toEqual([...divRef4(a, b, n), n / 2 + 3]);
}
const all = (n: number): [number, number][] => {
  const p: [number, number][] = [];
  for (let a = 0; a < 2 ** n; a++) for (let b = 0; b < 2 ** n; b++) p.push([a, b]);
  return p;
};
const random = (n: number, count: number, seed: number): [number, number][] => {
  const r = lcg(seed), M = 2 ** n;
  const p: [number, number][] = [[M - 1, 1], [M - 1, M - 1], [M - 1, M / 2], [M / 2, M - 1], [0, 5], [7, 0], [M - 1, 3]];
  for (let i = 0; i < count; i++) p.push([r(M), 1 + r(M - 1)]);
  return p;
};

describe('iterative radix-4 SRT divider: n/2 + 3 cycles, RISC-V results', () => {
  it('4 bits, every pair', () => check(srt4Divider(4), 4, all(4)), 60000);
  it('8 bits', () => check(srt4Divider(8), 8, random(8, 1500, 1)), 300000);
  it('16 bits', () => check(srt4Divider(16), 16, random(16, 60, 2)), 120000);
  it('32 bits', () => check(srt4Divider(32), 32, random(32, 20, 3)), 120000);
});

describe('radix 4 against radix 2', () => {
  it('half the cycles for a longer step: faster overall at 16 and 32 bits', () => {
    const per = (d: ComponentDef) => analyzeTiming(flatten(d))!.period;
    for (const n of [16, 32]) {
      const r2 = per(srtDivider(n)) * (n + 2), r4 = per(srt4Divider(n)) * (n / 2 + 3);
      expect(r4, `${n} bits`).toBeLessThan(r2);
    }
  });
});
