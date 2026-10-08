// Act 8's build levels (side quests): an array multiplier, the shift-and-add multiplier, a
// sequential divider, and binary16 adder / multiplier. Their reference designs come from the
// library; each level gives the reference's own building blocks (its rule adds them). No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { fpAdd, fpMul } from '../lib/fpu';
import { arrayMul, seqDivider } from '../lib/muldiv';
import { seqMul } from '../lib/multiply';
import { F16, fpAddX, fpMulX } from '../sim/fpref';
import { type ComponentDef, netlistOf } from '../sim/types';
import { rng } from './drills';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (!a) {
    const doc = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
    if ('error' in doc) throw new Error(`reference ${id}: ${doc.error}`);
    answers.set(id, (a = [{ ...doc, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  }
  return a;
};

/** The library ids a reference is drawn with: what a side quest gives. */
export const partsOf = (def: () => ComponentDef) => (): string[] => [...new Set((netlistOf(def())?.instances ?? []).map((i) => i.def.id))];

/** Start, then n more edges: done and the result are checked after the last one. */
function iterSeq(n: number, pairs: number[][], expect: (a: number, b: number) => Record<string, number>): SeqStep[] {
  const st: SeqStep[] = [];
  for (const [a, b] of pairs) {
    st.push({ set: { start: 1, a, b }, tick: true, expect: {} });
    for (let k = 1; k < n; k++) st.push({ set: { start: 0 }, tick: true, expect: {} });
    st.push({ tick: true, expect: { done: 1, ...expect(a, b) } });
    st.push({ tick: true, expect: { done: 0 } });
  }
  return st;
}

const pairs16 = (seed: number, n: number) => {
  const r = rng(seed);
  return [[0, 0], [0xffff, 0xffff], [0xffff, 1], [1, 0xffff], [1234, 0], [0x8000, 2], ...Array.from({ length: n }, () => [Math.floor(r() * 0x10000), Math.floor(r() * 0x10000)])];
};

const FP_EDGE = [0x0000, 0x8000, 0x3c00, 0xbc00, 0x7bff, 0xfbff, 0x0001, 0x8001, 0x0400, 0x03ff, 0x7c00, 0xfc00, 0x7e00, 0x4248, 0x3555, 0xc500];

export const BUILD8: Record<string, () => BuildChallenge> = {
  o_mularr: () => ({
    id: 'o_mularr', title: 'Array multiplier', level: 'arithmetic', allowed: 'nand',
    brief: '<b>p = a × b</b> for 8-bit unsigned a and b, in one pass: eight partial-product rows (a AND each bit of b), summed by a column of adders. Every product is checked (65 536 of them).',
    ports: pins([['a', 8], ['b', 8]], [['p', 16]]), check: { kind: 'table', spec: ([a, b]) => [a * b] },
    answer: refOf('o_mularr', () => arrayMul(8), 'Array multiplier'),
  }),
  o_mulseq: () => ({
    id: 'o_mulseq', title: 'Shift-and-add multiplier', level: 'sequential', allowed: 'nand',
    brief: 'At a rising edge with <code>start</code> = 1, load a and b; then add and shift once per clock: after the 17th edge, <b>done</b> = 1 for one cycle with <b>p</b> = a × b (32 bits). One 16-bit adder instead of an array: the trade of area for time. The iteration counter is given.',
    ports: pins([['clk'], ['start'], ['a', 16], ['b', 16]], [['p', 32], ['done']], 'clk'),
    check: { kind: 'sequence', init: { start: 0 }, steps: iterSeq(16, pairs16(5, 6), (a, b) => ({ p: a * b })) },
    answer: refOf('o_mulseq', () => seqMul(16), 'Shift-and-add multiplier'),
  }),
  o_div: () => ({
    id: 'o_div', title: 'Divider', level: 'sequential', allowed: 'nand',
    brief: 'Restoring division, one quotient bit per clock: start loads a and b; after the 17th edge, <b>done</b> = 1 with <b>q</b> = a ÷ b and <b>r</b> = a mod b (unsigned; b = 0 gives q = 0xFFFF, r = a, as RISC-V does). The division step and the counter parts are given.',
    ports: pins([['clk'], ['start'], ['a', 16], ['b', 16]], [['q', 16], ['r', 16], ['done']], 'clk'),
    check: { kind: 'sequence', init: { start: 0 }, steps: iterSeq(16, pairs16(9, 6), (a, b) => (b ? { q: Math.floor(a / b), r: a % b } : { q: 0xffff, r: a })) },
    answer: refOf('o_div', () => seqDivider(16), 'Divider'),
  }),
  o_fpadd: () => ({
    id: 'o_fpadd', title: 'binary16 adder', level: 'arithmetic', allowed: 'nand',
    brief: '<b>y = a + b</b> (or a − b when <code>sub</code>) in IEEE 754 binary16, correctly rounded in the mode <code>rm</code> (0 nearest-even, 1 toward zero, 2 down, 3 up, 4 nearest-max), with subnormals, infinities and NaN. Unpack, align with a sticky bit, add, normalise, round: the unpacker, aligner and rounder are given.',
    ports: pins([['a', 16], ['b', 16], ['sub'], ['rm', 3]], [['y', 16]]),
    check: {
      kind: 'table', spec: ([a, b, s, rm]) => [rm > 4 ? fpAddX(a, b, !!s, F16, 0).y : fpAddX(a, b, !!s, F16, rm).y],
      vectors: () => FP_EDGE.flatMap((a) => FP_EDGE.flatMap((b) => [0, 1, 2, 3, 4].map((rm) => [a, b, 0, rm]))),
      care: ([, , , rm]) => [rm > 4 ? 0 : 0xffff],
    },
    answer: refOf('o_fpadd', () => fpAdd(F16), 'binary16 adder'),
  }),
  o_fpmul: () => ({
    id: 'o_fpmul', title: 'binary16 multiplier', level: 'arithmetic', allowed: 'nand',
    brief: '<b>y = a × b</b> in binary16, correctly rounded in the mode <code>rm</code>: multiply the 11-bit significands, add the exponents, normalise and round. The significand multiplier and the rounder are given.',
    ports: pins([['a', 16], ['b', 16], ['rm', 3]], [['y', 16]]),
    check: {
      kind: 'table', spec: ([a, b, rm]) => [fpMulX(a, b, F16, rm > 4 ? 0 : rm).y],
      vectors: () => FP_EDGE.flatMap((a) => FP_EDGE.flatMap((b) => [0, 1, 2, 3, 4].map((rm) => [a, b, rm]))),
      care: ([, , rm]) => [rm > 4 ? 0 : 0xffff],
    },
    answer: refOf('o_fpmul', () => fpMul(F16), 'binary16 multiplier'),
  }),
};
