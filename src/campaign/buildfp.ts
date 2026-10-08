// Act 8's floating-point ladder: the binary16 adder's own blocks built one at a time (unpack,
// the rounding decision, the sticky shifter, the leading-zero counter, normalize & round), then
// a comparator and int → float on top of them. Each reference answer is the library block drawn
// as a chip (the leading-zero counter's halves as chips of their own, so the recursion is built
// too); a level gives the reference's generic parts, and the FP blocks come from the rungs below
// (FP_BLOCK, nodes.ts unlocks). No DOM.

import type { BuildChallenge, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { fpCompare, fpFromInt, fpUnpack, lzc, normRound, ROUND_DECIDE, shiftRightSticky } from '../lib/fpu';
import { bias, F16, fpCmpX, fpFromIntX, overflowToInf, roundToX, roundUp } from '../sim/fpref';
import { type ComponentDef, netlistOf } from '../sim/types';
import { rng } from './drills';

const pins = (ins: [string, number?][], outs: [string, number?][]): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

/** The blocks the ladder builds: never given, always unlocked by the rung that built them. */
export const FP_BLOCK = /^(fpun|fpround$|shrs|lzc|fpnr)/;

/** The references, memoized (building one is the expensive part). */
export const FP_REF = {
  unpack: () => fpUnpack(F16),
  sticky: () => shiftRightSticky(13, 4),
  lzc: () => lzc(16),
  norm: () => normRound(F16, 15),
  cmp: () => fpCompare(F16),
  cvt: () => fpFromInt(F16, 16),
};
/** The leading-zero counter's halves, drawn as chips: lzc8 → lzc4 → lzc2. */
const lzcSubs = () => [lzc(8), lzc(4), lzc(2)];

/**
 * What a rung gives: the library ids its reference tree is drawn with, without the sub-units
 * drawn as chips and without the FP blocks the rungs below unlock.
 */
export const fpGives = (top: () => ComponentDef, subs: () => ComponentDef[] = () => []) => (): string[] => {
  const s = new Set(subs());
  const ids = new Set<string>();
  for (const d of [top(), ...s]) for (const i of netlistOf(d)?.instances ?? []) if (!s.has(i.def)) ids.add(i.def.id);
  return [...ids].filter((id) => !FP_BLOCK.test(id)).sort();
};

const answers = new Map<string, ChipDoc[]>();
/** A reference answer: the top def drawn as a chip, and `subs` drawn as chips it places (innermost last). */
const refOf = (id: string, def: () => ComponentDef, name: string, subs: () => ComponentDef[] = () => []) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const chips = new Map(subs().map((d, i) => [d, { id: `u_ref_cp_${id}_${i}`, name: `${d.name} ref` }]));
  const refOfDef = (d: ComponentDef): PartRef | undefined => (chips.has(d) ? { chip: chips.get(d)!.id } : undefined);
  const docs: ChipDoc[] = [];
  for (const [d, c] of chips) {
    const doc = docFromDef(d, { ...c, refOf: refOfDef });
    if ('error' in doc) throw new Error(`reference ${id} (${d.id}): ${doc.error}`);
    docs.push({ ...doc, notes: `Part of the reference answer. ${d.summary ?? ''}`.trim() });
  }
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref`, refOf: refOfDef });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [...docs.reverse(), { ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

/** binary16 values worth testing: zeros, ±1, the largest finite, subnormals, the smallest normal, ∞, NaNs, and a few ordinary ones. */
export const FP16_EDGE = [0x0000, 0x8000, 0x3c00, 0xbc00, 0x7bff, 0xfbff, 0x0001, 0x8001, 0x0400, 0x03ff, 0x7c00, 0xfc00, 0x7e00, 0x7c01, 0x4248, 0x3555, 0xc500, 0x3bff];

/** normalize & round's significand width in the adder, and its exponent width (two's complement). */
const NW = 15, XE = 8;

/**
 * What normalize & round must give: sign × (mant + stin / 2) × 2^(exp − bias − (NW − 1)), rounded
 * once. stin is a sticky bit below mant: the adder only sets it when mant's leading 1 is in its
 * top two places (an alignment shift of 2 or more cancels at most one bit), so the other rows
 * are don't-cares (normCare).
 */
function normSpec([sign, exp, mant, stin, rm]: number[]): number[] {
  const e = exp >= 2 ** (XE - 1) ? exp - 2 ** XE : exp;
  const m = BigInt(mant) * 2n + BigInt(stin);
  if (m === 0n) return [sign * 0x8000, 0];
  const r = roundToX(sign, m, e - bias(F16) - NW, F16, rm);
  return [r.y, r.fl];
}
/** Don't-cares: stin with mant's leading 1 below its top two places, and exp = −128 (exp − 1 would wrap). */
const normCare = ([, exp, mant, stin]: number[]) => ((stin && mant < 2 ** (NW - 2)) || exp === 2 ** (XE - 1) ? [0, 0] : [0xffff, 0x1f]);

function normVectors(): number[][] {
  const r = rng(1607);
  const out: number[][] = [];
  const int = (n: number) => Math.floor(r() * n);
  const exps = [-30, -14, -11, -10, 0, 1, 2, 3, 15, 16, 29, 30, 31, 32, 33, 45];
  for (const e of exps) {
    for (const rm of [0, 1, 2, 3, 4]) {
      for (const mant of [0, 1, 0x7fff, 0x4000, 0x7ff8, 0x7ffc, 0x4004, 0x400c, 0x3fff, 0x2000, 0x0010]) {
        out.push([rm & 1, (e + 256) % 256, mant, 0, rm]);
        if (mant >= 0x2000) out.push([(rm >> 1) & 1, (e + 256) % 256, mant, 1, rm]);
      }
    }
  }
  for (let i = 0; i < 1500; i++) {
    const e = int(70) - 20, lz = int(NW + 1), mant = Math.floor(int(2 ** NW) / 2 ** lz);
    out.push([int(2), (e + 256) % 256, mant, mant >= 2 ** (NW - 2) ? int(2) : 0, int(5)]);
  }
  return out;
}

export const BUILDFP: Record<string, () => BuildChallenge> = {
  o_fpunpack: () => ({
    id: 'o_fpunpack', title: 'Float unpack', level: 'arithmetic', allowed: 'nand',
    brief: 'Split a binary16 pattern <b>x</b> into what the arithmetic needs: <b>sign</b>; <b>exp</b>, the exponent field, except that a subnormal (field 0) counts as 1; <b>mant</b>, the 11-bit significand with its hidden bit (1 unless the field is 0); and the classes <b>zero</b>, <b>inf</b> (field all 1s, fraction 0), <b>nan</b> (field all 1s, fraction ≠ 0) and <b>snan</b> (a NaN whose top fraction bit, the quiet bit, is 0). Every pattern is checked.',
    ports: pins([['x', 16]], [['sign'], ['exp', 5], ['mant', 11], ['zero'], ['inf'], ['nan'], ['snan']]),
    check: {
      kind: 'table',
      spec: ([x]) => {
        const e = (x >> 10) & 31, f = x & 1023, nan = e === 31 && f !== 0;
        return [x >> 15, e || 1, (e ? 1024 : 0) | f, e === 0 && f === 0 ? 1 : 0, e === 31 && f === 0 ? 1 : 0, nan ? 1 : 0, nan && !(f & 512) ? 1 : 0];
      },
    },
    answer: refOf('o_fpunpack', FP_REF.unpack, 'Float unpack'),
  }),
  o_fpround: () => ({
    id: 'o_fpround', title: 'Rounding decision', level: 'arithmetic', allowed: 'nand',
    brief: 'The heart of every rounder. Given the last bit kept (<b>lsb</b>), the first bit dropped (the guard bit <b>g</b>), the OR of everything below it (the sticky bit <b>s</b>), the <b>sign</b> and the mode <b>rm</b>: <b>up</b> = add one to the kept bits. RNE (0): up when g and (s or lsb), ties to even. RTZ (1): never. RDN (2): when negative and g or s. RUP (3): when positive and g or s. RMM (4): when g. <b>toInf</b>: does an overflow become ∞ (RNE, RMM, and the direction rounded towards) rather than the largest finite number? Modes 5 to 7 behave as RTZ.',
    ports: pins([['rm', 3], ['sign'], ['lsb'], ['g'], ['s']], [['up'], ['toInf']]),
    check: { kind: 'table', spec: ([rm, sign, lsb, g, s]) => [roundUp(rm, sign, !!lsb, !!g, !!s) ? 1 : 0, overflowToInf(rm, sign) ? 1 : 0] },
    answer: refOf('o_fpround', () => ROUND_DECIDE, 'Rounding decision'),
  }),
  o_fpsticky: () => ({
    id: 'o_fpsticky', title: 'Sticky shifter', level: 'arithmetic', allowed: 'nand',
    brief: '<b>y = x &gt;&gt; s</b> (13 bits, zeros in from the left), and <b>sticky</b> = 1 when any 1 fell off the right end. Aligning the smaller operand of an addition loses bits; the sticky bit remembers that they were not all zero, which is all rounding needs to know about them. Every shift of 256 patterns, then random ones.',
    ports: pins([['x', 13], ['s', 4]], [['y', 13], ['sticky']]),
    check: {
      kind: 'table', spec: ([x, s]) => [Math.floor(x / 2 ** s), x % 2 ** s ? 1 : 0],
      vectors: () => { const r = rng(1301); return Array.from({ length: 256 }, () => Math.floor(r() * 2 ** 13)).flatMap((x) => Array.from({ length: 16 }, (_, s) => [x, s])); },
    },
    answer: refOf('o_fpsticky', FP_REF.sticky, 'Sticky shifter'),
  }),
  o_fplzc: () => ({
    id: 'o_fplzc', title: 'Leading-zero counter', level: 'arithmetic', allowed: 'nand',
    brief: '<b>c</b> = how many 0s stand before the first 1 of <b>a</b> (16 bits, counting from the top), and <b>v</b> = 1 when there is a 1 at all (when a = 0, c is a don\'t-care). Normalizing a result means shifting out exactly these zeros. Build it from halves: the count is the upper half\'s, unless the upper half is all zeros, then 8 plus the lower half\'s. Every pattern is checked.',
    ports: pins([['a', 16]], [['c', 4], ['v']]),
    check: { kind: 'table', spec: ([a]) => [a ? 15 - Math.floor(Math.log2(a)) : 0, a ? 1 : 0], care: ([a]) => [a ? 0xf : 0, 1] },
    answer: refOf('o_fplzc', FP_REF.lzc, 'Leading-zero counter', lzcSubs),
  }),
  o_fpnorm: () => ({
    id: 'o_fpnorm', title: 'Normalize & round', level: 'arithmetic', allowed: 'nand',
    brief: `The adder's back end, shared by every FP unit. <b>mant</b> (15 bits) is a significand whose top bit weighs 2^(exp − 15), with <b>exp</b> an 8-bit two's-complement biased exponent (−127 to 127), and <b>stin</b> a sticky bit below it. Give the binary16 encoding <b>y</b> of sign × that value, rounded once in mode <b>rm</b>, and <b>flags</b> = {NV, DZ, OF, UF, NX} (NV and DZ stay 0). Shift out the leading zeros as far as the exponent allows (stop at exponent 1: a subnormal), or shift right with a sticky bit when the exponent is below 1; round on the guard bit and the sticky bit; a carry out of the rounding bumps the exponent; a field past 30 overflows (∞ or the largest finite, by the rounding decision's toInf). UF: inexact and tiny after rounding. stin is only set when mant's top bit or the one below it is 1 (other rows are not checked).`,
    ports: pins([['sign'], ['exp', XE], ['mant', NW], ['stin'], ['rm', 3]], [['y', 16], ['flags', 5]]),
    check: { kind: 'table', spec: normSpec, vectors: normVectors, care: normCare },
    answer: refOf('o_fpnorm', FP_REF.norm, 'Normalize & round'),
  }),
  o_fpcmp: () => ({
    id: 'o_fpcmp', title: 'FP comparator', level: 'arithmetic', allowed: 'nand',
    brief: 'feq, flt and fle for binary16: <b>eq</b>, <b>lt</b> (a &lt; b), <b>le</b>, plus <b>unord</b> (a or b is NaN: every comparison is then false) and <b>snan</b> (a or b is a signaling NaN). Sign-magnitude almost orders like an integer: compare |a| and |b| as 15-bit numbers, then let the signs decide; −0 = +0.',
    ports: pins([['a', 16], ['b', 16]], [['eq'], ['lt'], ['le'], ['unord'], ['snan']]),
    check: {
      kind: 'table', spec: ([a, b]) => [fpCmpX(a, b, 'eq', F16).y, fpCmpX(a, b, 'lt', F16).y, fpCmpX(a, b, 'le', F16).y, fpCmpX(a, b, 'lt', F16).fl ? 1 : 0, fpCmpX(a, b, 'eq', F16).fl ? 1 : 0],
      vectors: () => {
        const r = rng(1709);
        const near = Array.from({ length: 300 }, () => { const a = Math.floor(r() * 0x10000); return [a, (a + Math.floor(r() * 5) - 2) & 0xffff]; });
        return [...FP16_EDGE.flatMap((a) => FP16_EDGE.flatMap((b) => [[a, b], [a, b ^ 0x8000]])), ...near];
      },
    },
    answer: refOf('o_fpcmp', FP_REF.cmp, 'FP comparator'),
  }),
  o_fpcvt: () => ({
    id: 'o_fpcvt', title: 'Integer to float', level: 'arithmetic', allowed: 'nand',
    brief: 'fcvt from a 16-bit integer <b>x</b> (two\'s complement when <b>signed</b>, else unsigned) to binary16, rounded in mode <b>rm</b>, with <b>flags</b> {NV, DZ, OF, UF, NX}. The magnitude is a significand whose top bit weighs 2^15: normalize & round does the rest. Integers above 2048 lose low bits (NX); unsigned 65 535 rounds up past the largest finite in some modes (OF).',
    ports: pins([['x', 16], ['signed'], ['rm', 3]], [['y', 16], ['flags', 5]]),
    check: {
      kind: 'table', spec: ([x, s, rm]) => { const r = fpFromIntX(x, !!s, F16, rm, 16); return [r.y, r.fl]; },
      vectors: () => [0, 1, 2, 3, 2047, 2048, 2049, 2050, 2051, 4095, 4097, 4099, 32767, 32768, 32769, 65504, 65519, 65520, 65535, 0xfff0, 0x8001]
        .flatMap((x) => [0, 1].flatMap((s) => [0, 1, 2, 3, 4].map((rm) => [x, s, rm]))),
    },
    answer: refOf('o_fpcvt', FP_REF.cvt, 'Integer to float'),
  }),
};
