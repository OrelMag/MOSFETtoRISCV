import { describe, expect, it } from 'vitest';
import { SRT_SELECT, nrArrayDiv, nrDivStep, nrFix, nrSeqDivider, seqDivider, srtDivider, srtNorm, srtStep } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { logicDepth } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';
import { checkSpec, corners, lcg, out, set, tick } from './util';

describe('division parts match their specs', () => {
  const small = [nrDivStep(4), nrFix(4), nrArrayDiv(4), SRT_SELECT, srtNorm(4)];
  for (const d of small) it(d.id, () => checkSpec(d));
  const big = [nrDivStep(8), nrDivStep(16), nrFix(16), nrArrayDiv(8), srtStep(4), srtStep(8), srtStep(16), srtNorm(8), srtNorm(16)];
  for (const d of big) it(d.id, () => checkSpec(d, 300, corners(d)));
});

/** Run one division on an iterative divider; returns [q, r, cycles]. */
function divide(s: Sim, a: number, b: number): [number, number, number] {
  set(s, { start: 1, a, b });
  let cycles = 1;
  tick(s);
  set(s, { start: 0 });
  while (!out(s, 'done')) { tick(s); cycles++; expect(cycles).toBeLessThan(80); }
  const res: [number, number, number] = [out(s, 'q'), out(s, 'r'), cycles + 1];
  tick(s);
  expect(out(s, 'busy')).toBe(0);
  return res;
}

function checkIterative(def: ComponentDef, n: number, pairs: [number, number][]) {
  const s = simulate(def);
  set(s, { clk: 0, start: 0, a: 0, b: 0 });
  const M = 2 ** n - 1;
  for (const [a, b] of pairs) {
    const want = b === 0 ? [M, a] : [Math.floor(a / b), a % b];
    expect(divide(s, a, b), `${def.id}: ${a} / ${b}`).toEqual([...want, n + 2]);
  }
}

const edges = (n: number): [number, number][] => {
  const M = 2 ** n - 1, H = 2 ** (n - 1);
  return [[0, 1], [M, 1], [M, M], [M, H], [H, M], [5, 0], [M, 0], [0, 0], [1, M], [H, 1], [H - 1, H], [M, 3], [M - 1, H + 1]];
};
const random = (n: number, count: number, seed = 99): [number, number][] => {
  const r = lcg(seed);
  return Array.from({ length: count }, () => [r(2 ** n), 1 + r(2 ** n - 1)]);
};

describe('iterative dividers (n + 2 cycles, RISC-V divide-by-zero results)', () => {
  it('non-restoring, 8 bits', () => checkIterative(nrSeqDivider(8), 8, [...edges(8), ...random(8, 120)]));
  it('SRT, 4 bits, every pair', () => {
    const all: [number, number][] = [];
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) all.push([a, b]);
    checkIterative(srtDivider(4), 4, all);
  });
  it('SRT, 8 bits', () => checkIterative(srtDivider(8), 8, [...edges(8), ...random(8, 200)]));
  it('SRT, 16 bits', () => checkIterative(srtDivider(16), 16, [...edges(16), ...random(16, 40), ...random(8, 20, 7)]));
  it('SRT, 32 bits', () => checkIterative(srtDivider(32), 32, [...edges(32), ...random(32, 12)]));
});

describe('why SRT is fast', () => {
  it('the step depth does not grow with the width', () => {
    expect(logicDepth(srtStep(32))).toBe(logicDepth(srtStep(8)));
    expect(logicDepth(nrDivStep(32, false))!).toBeGreaterThan(2 * logicDepth(nrDivStep(8, false))!);
  });
  it('the clock period stays put while restoring division depends on its adder', () => {
    const per = (d: ComponentDef) => analyzeTiming(flatten(d))!.period;
    expect(per(srtDivider(8))).toBe(per(srtDivider(16)));
    for (const n of [8, 16, 32]) expect(per(srtDivider(n)), `${n} bits`).toBeLessThan(per(seqDivider(n)));
  });
});
