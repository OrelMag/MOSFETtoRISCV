// Chapters 24, 26 and 27's numbers that the text quotes as typed figures: each measured here and looked up in the text,
// so a change to either the library or the prose fails the test.
import { describe, expect, it } from 'vitest';
import { chFloat } from '../src/chapters/ch-float';
import { chMulticore } from '../src/chapters/ch-multicore';
import type { Chapter } from '../src/chapters/types';
import {
  FCSR, FPU32, ROUND_DECIDE, fmaAdd, fmaMultiply, fmaRound, fpAdd, fpClassify, fpDiv, fpFma, fpMinMax, fpMul, fpPrenorm, fpSqrt, fpToInt, normRound,
} from '../src/lib';
import { F32, canonicalNaN } from '../src/sim/fpref';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { isExhaustive, operandPairs } from './fptest';

/** Every piece of a chapter's prose, whitespace collapsed. */
const text = (c: Chapter) => [
  c.blurb, ...(c.recap?.keep ?? []), ...(c.recap?.check ?? []).map((q) => JSON.stringify(q)),
  ...c.steps.flatMap((s) => [s.body, JSON.stringify(s.challenge ?? '')]),
].join('\n').replace(/\s+/g, ' ');
/** n rounded to a multiple of q, with the chapters' thousands separator (a space). */
const fmt = (n: number, q = 1) => (Math.round(n / q) * q).toLocaleString('en-US').replace(/,/g, ' ');
const nands = (d: ComponentDef) => stats(d).nands;
const depth = (d: ComponentDef) => logicDepth(d)!;

describe('chapter 24 (floating point) quotes measured numbers', () => {
  const t = text(chFloat);
  const has = (s: string) => expect(t, s).toContain(s);

  it('the float32 adder, multiplier and fma', () => {
    const add = fpAdd(F32), mul = fpMul(F32), fma = fpFma(F32);
    has(`adder costs about <strong>${fmt(nands(add), 100)} NANDs</strong> and is ${depth(add)} NAND delays deep`);
    has(`multiplier costs about <strong>${fmt(nands(mul), 100)}</strong> (mostly its 24 × 24 tree) and is ${depth(mul)} deep`);
    has(`float32 fma: ${fmt(nands(fma), 100)} NANDs, ${depth(fma)} deep: deeper than either multiplier (${depth(mul)}) or adder (${depth(add)}), but shallower than the two in a row (${depth(mul) + depth(add)})`);
    has(`multiply (${depth(fmaMultiply(F32))} deep), align and add (${depth(fmaAdd(F32))}), round (${depth(fmaRound(F32))}: the 52-bit normalize &amp; round, ${depth(normRound(F32, 52))},`);
    has(`the fma ${fmt(nands(fma), 100)} and ${depth(fma)}, one rounding against ${depth(mul) + depth(add)} for fmul then fadd`);
  });

  it('rounding: the mode decision and the shared normalize & round', () => {
    has(`That is this block: ${nands(ROUND_DECIDE)} NANDs, ${depth(ROUND_DECIDE)} deep`);
    const nr = normRound(F32, 48);
    has(`the multiplier's instance (48-bit significand) is ${fmt(nands(nr), 10)} NANDs and ${depth(nr)} NAND delays deep`);
  });

  it('division, square root, conversion and the small units', () => {
    const div = fpDiv(F32), insts = div.netlist!().instances;
    const rounder = insts.find((i) => i.def.id.startsWith('fpnr'))!.def;
    const prenorms = insts.filter((i) => i.def === fpPrenorm(F32));
    expect(prenorms.length).toBe(2);
    has(`${fmt(nands(div), 100)} NANDs (${fmt(nands(rounder), 100)} of them normalize &amp; round, ${fmt(2 * nands(fpPrenorm(F32)), 100)} the two prenormalizers)`);
    has(`<strong>28 cycles</strong>, ${fmt(nands(fpSqrt(F32)), 100)} NANDs`);
    const toi = fpToInt(F32);
    has(`converter costs ${fmt(nands(toi), 10)} NANDs and is ${depth(toi)} deep`);
    has(`the FPU is ${fmt(nands(FPU32), 100)} NANDs`);
    has(`fflags (5 bits), ${nands(FCSR)} NANDs`);
    has(`(${fmt(nands(fpMinMax(F32)))} NANDs, comparator included)`);
    has(`returns one of ten bits (${nands(fpClassify(F32))} NANDs)`);
  });

  it('the canonical NaN', () => {
    const hex = (n: number) => '0x' + n.toString(16).toUpperCase();
    has(`<strong>canonical NaN</strong> ${hex(canonicalNaN(F32))}`);
    has(`the canonical NaN is 0 1111 100 = ${hex(canonicalNaN({ E: 4, M: 3 }))}`);
  });

  it('describes the small-format tests as they run', () => {
    expect(isExhaustive({ E: 3, M: 2 })).toBe(true);
    has('The 6-bit format (3 exponent bits, 2 fraction bits) is exhaustive');
    const f = { E: 4, M: 3 };
    if (!isExhaustive(f)) has(`plus ${fmt(operandPairs(f).length - operandPairs(f, 0).length)} random pairs`);
  });
});

describe('chapter 26 (many cores): Amdahl', () => {
  it('quotes 1 / ((1 − p) + p / n) for p = 90 %, n = 8, and its limit', () => {
    const t = text(chMulticore), p = 0.9, s = (1 / ((1 - p) + p / 8)).toFixed(1), lim = Math.round(1 / (1 - p));
    expect(t).toContain(`8 cores give 1 / (0.1 + ${(p / 8).toFixed(4)}) = ${s}×, and no number of cores beats 1 / (1 − p) = ${lim}×`);
    expect(t).toContain(`About ${s}×, at most ${lim}×`);
  });
});
