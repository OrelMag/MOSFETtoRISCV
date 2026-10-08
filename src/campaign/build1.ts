// The build levels of acts 1–3 that are new to the campaign: their pins, test sets (truth
// tables, directed and random vectors, long clocked sequences checked against a JS model) and
// reference answers (the library block drawn as a sandbox chip). No DOM.

import { type BuildChallenge, type PinSpec, type SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { aluSpec, alu, shifter } from '../lib/alu';
import { addSub, busMux2, incrementer } from '../lib/combinational';
import { koggeStone } from '../lib/fastadd';
import { ADD16, CMP16, DEC3, DET101, EQ16, PC16, PRIME4, PRIMES4, RF8, WIDE16 } from '../lib/rv16/logic';
import { register } from '../lib/sequential';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

const answers = new Map<string, ChipDoc[]>();
/** The reference answer: the library block as one chip (every part placed by library id). */
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (!a) {
    const doc = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
    if ('error' in doc) throw new Error(`reference ${id}: ${doc.error}`);
    answers.set(id, (a = [{ ...doc, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  }
  return a;
};

const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);

// ---- clocked test sequences (deterministic, from a JS model) ----------------------------------

function regSeq(n = 48): SeqStep[] {
  const r = rng(16);
  let q = 0;
  const st: SeqStep[] = [{ set: { d: 0x1234, en: 1 }, tick: true, expect: { q: (q = 0x1234) } }];
  for (let i = 0; i < n; i++) {
    const d = Math.floor(r() * 0x10000), en = r() < 0.6 ? 1 : 0;
    if (en) q = d;
    st.push({ set: { d, en }, tick: true, expect: { q } });
  }
  st.push({ set: { d: 0xffff, en: 1 }, tick: true, expect: { q: 0xffff } }, { set: { d: 0, en: 0 }, tick: true, expect: { q: 0xffff } });
  return st;
}

function pcSeq(): SeqStep[] {
  const r = rng(99);
  let pc = 0;
  const st: SeqStep[] = [{ set: { rst: 1 }, tick: true, expect: { pc: 0 } }];
  const step = (rst: number, ld: number, d: number) => {
    pc = rst ? 0 : ld ? d : (pc + 1) & 0xffff;
    st.push({ set: { rst, ld, d }, tick: true, expect: { pc } });
  };
  for (let i = 0; i < 6; i++) step(0, 0, 0);
  step(0, 1, 0xfffe);
  step(0, 0, 0);
  step(0, 0, 0); // wraps to 0
  for (let i = 0; i < 40; i++) {
    const u = r();
    step(u < 0.08 ? 1 : 0, u >= 0.08 && u < 0.3 ? 1 : 0, Math.floor(r() * 0x10000));
  }
  step(1, 1, 0x4321); // reset wins over load
  return st;
}

function rfSeq(): SeqStep[] {
  const r = rng(7);
  const x = new Array(8).fill(0);
  const st: SeqStep[] = [];
  const step = (wa: number, we: number, wd: number, ra1: number, ra2: number) => {
    if (we && wa) x[wa] = wd;
    st.push({ set: { wa, we, wd, ra1, ra2 }, tick: true, expect: { rd1: x[ra1], rd2: x[ra2] } });
  };
  // Fill every register (x0 must stay 0), read them back on both ports.
  for (let i = 0; i < 8; i++) step(i, 1, (0x1111 * (i + 1)) & 0xffff, i, (i + 7) % 8);
  for (let i = 0; i < 8; i++) step(0, 0, 0xdead, i, 7 - i);
  for (let i = 0; i < 60; i++) {
    const we = r() < 0.6 ? 1 : 0;
    step(Math.floor(r() * 8), we, Math.floor(r() * 0x10000), Math.floor(r() * 8), Math.floor(r() * 8));
  }
  return st;
}

function fsmSeq(): SeqStep[] {
  const r = rng(101);
  let s0 = 0, s1 = 0;
  const st: SeqStep[] = [];
  const step = (x: number, rst: number) => {
    // y (Mealy) before the edge, then the edge.
    st.push({ set: { x, rst }, expect: { y: x & s1 } });
    const n0 = x & (rst ^ 1), n1 = (x ^ 1) & s0 & (rst ^ 1);
    s0 = n0;
    s1 = n1;
    st.push({ tick: true, expect: {} });
  };
  step(0, 1);
  for (const x of [1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1]) step(x, 0);
  step(1, 1);
  for (let i = 0; i < 40; i++) step(r() < 0.55 ? 1 : 0, r() < 0.05 ? 1 : 0);
  return st;
}

// ---- directed vectors for wide table checks -----------------------------------------------------

const EDGE16 = [0, 1, 2, 0x7fff, 0x8000, 0x8001, 0xfffe, 0xffff, 0x00ff, 0xff00, 0x5555, 0xaaaa];
const pairs16 = (): number[][] => EDGE16.flatMap((a) => EDGE16.map((b) => [a, b]));
const withBit = (vs: number[][]): number[][] => vs.flatMap((v) => [[...v, 0], [...v, 1]]);
/** RV16 ALU controls {OPX, f3}. */
export const ALU_OPS = [0, 8, 1, 2, 3, 4, 5, 13, 6, 7];

// ---- the levels ------------------------------------------------------------------------------

export const BUILD1: Record<string, () => BuildChallenge> = {
  g_sop: () => ({
    id: 'g_sop', title: 'Prime detector', level: 'gates', allowed: 'nand',
    brief: '<b>y = 1</b> when the 4-bit number <code>a</code> is prime (2, 3, 5, 7, 11, 13). Draw its K-map, find a minimal sum of products, and build it NAND–NAND.',
    ports: pins([['a', 4]], [['y']]), check: { kind: 'table', spec: ([a]) => [PRIMES4.includes(a) ? 1 : 0] },
    answer: refOf('g_sop', () => PRIME4, 'Prime detector'),
  }),
  g_wide: () => ({
    id: 'g_wide', title: 'Zero detect', level: 'gates', allowed: 'nand',
    brief: '<b>any</b> = 1 if any of the 16 bits of <code>a</code> is 1; <b>zero</b> = ¬any. A chain of ORs is 15 gates deep; a balanced tree is 4. Graded on depth.',
    ports: pins([['a', 16]], [['any'], ['zero']]), check: { kind: 'table', spec: ([a]) => [a ? 1 : 0, a ? 0 : 1] },
    answer: refOf('g_wide', () => WIDE16, 'Zero detect'),
  }),
  g_dec: () => ({
    id: 'g_dec', title: '3→8 decoder', level: 'gates', allowed: 'nand',
    brief: '<b>y = en ? 1 &lt;&lt; a : 0</b>: exactly one of the 8 outputs is 1, the one numbered <code>a</code>, while <code>en</code> = 1. The register file uses one to choose the register to write.',
    ports: pins([['a', 3], ['en']], [['y', 8]]), check: { kind: 'table', spec: ([a, en]) => [en ? 1 << a : 0] },
    answer: refOf('g_dec', () => DEC3, '3→8 decoder'),
  }),
  g_mux8: () => ({
    id: 'g_mux8', title: 'Bus multiplexer', level: 'gates', allowed: 'nand',
    brief: '<b>y = s ? b : a</b> on 16-bit buses. One 1-bit mux per bit, all sharing <code>s</code>. (With it, the library\'s wider muxes unlock: an 8:1 mux is a tree of three levels of these.)',
    ports: pins([['a', 16], ['b', 16], ['s']], [['y', 16]]), check: { kind: 'table', spec: ([a, b, s]) => [s ? b : a] },
    answer: refOf('g_mux8', () => busMux2(16), 'Bus multiplexer'),
  }),
  g_eq16: () => ({
    id: 'g_eq16', title: 'Equality', level: 'gates', allowed: 'nand',
    brief: '<b>eq = (a = b)</b> on 16-bit words. beq / bne use it, and so does the pipeline\'s forwarding logic.',
    ports: pins([['a', 16], ['b', 16]], [['eq']]),
    check: { kind: 'table', spec: ([a, b]) => [a === b ? 1 : 0], vectors: () => pairs16() },
    answer: refOf('g_eq16', () => EQ16, 'Equality'),
  }),
  a_add16: () => ({
    id: 'a_add16', title: '16-bit adder', level: 'arithmetic', allowed: 'nand',
    brief: '<b>{cout, s} = a + b + cin</b> on 16-bit words. Your 4-bit adder is unlocked: four of them, carries chained.',
    ports: pins([['a', 16], ['b', 16], ['cin']], [['s', 16], ['cout']]),
    check: { kind: 'table', spec: ([a, b, c]) => [(a + b + c) & 0xffff, (a + b + c) >> 16], vectors: () => withBit(pairs16()) },
    answer: refOf('a_add16', () => ADD16, '16-bit adder'),
  }),
  a_inc16: () => ({
    id: 'a_inc16', title: '16-bit incrementer', level: 'arithmetic', allowed: 'nand',
    brief: '<b>{cout, y} = a + 1</b>. The PC does this every cycle. With b = 0 and cin = 1, a full adder per bit is a waste: half adders suffice.',
    ports: pins([['a', 16]], [['y', 16], ['cout']]), check: { kind: 'table', spec: ([a]) => [(a + 1) & 0xffff, a === 0xffff ? 1 : 0] },
    answer: refOf('a_inc16', () => incrementer(16), '16-bit incrementer'),
  }),
  a_addsub16: () => ({
    id: 'a_addsub16', title: 'Adder / subtractor', level: 'arithmetic', allowed: 'nand',
    brief: '<b>s = sub ? a − b : a + b</b> (mod 2<sup>16</sup>), <b>cout</b> the carry out of a + (b ⊕ sub) + sub, <b>v</b> the signed overflow.',
    ports: pins([['a', 16], ['b', 16], ['sub']], [['s', 16], ['cout'], ['v']]),
    check: {
      kind: 'table', spec: ([a, b, sub]) => {
        const bb = sub ? (~b & 0xffff) : b, t = a + bb + sub, s = t & 0xffff;
        const v = (a & 0x8000) === (bb & 0x8000) && (s & 0x8000) !== (a & 0x8000) ? 1 : 0;
        return [s, t >> 16, v];
      },
      vectors: () => withBit(pairs16()),
    },
    answer: refOf('a_addsub16', () => addSub(16), 'Adder / subtractor'),
  }),
  a_slt: () => ({
    id: 'a_slt', title: 'Less than', level: 'arithmetic', allowed: 'nand',
    brief: '<b>lt</b> = (a &lt; b) as signed numbers, <b>ltu</b> = (a &lt; b) as unsigned, for slt / sltu and blt / bge. Both from one subtraction.',
    ports: pins([['a', 16], ['b', 16]], [['lt'], ['ltu']]),
    check: { kind: 'table', spec: ([a, b]) => [s16(a) < s16(b) ? 1 : 0, a < b ? 1 : 0], vectors: () => pairs16() },
    answer: refOf('a_slt', () => CMP16, 'Less than'),
  }),
  a_shift16: () => ({
    id: 'a_shift16', title: 'Barrel shifter', level: 'arithmetic', allowed: 'nand',
    brief: '<b>y</b> = a shifted by <code>sh</code> (0–15): left if <code>left</code>, else right, filling with the sign bit if <code>arith</code> (sra) or 0 (srl).',
    ports: pins([['a', 16], ['sh', 4], ['left'], ['arith']], [['y', 16]]),
    check: {
      kind: 'table', spec: ([a, sh, left, arith]) => [left ? (a << sh) & 0xffff : arith ? (s16(a) >> sh) & 0xffff : a >>> sh],
      vectors: () => EDGE16.flatMap((a) => Array.from({ length: 64 }, (_, k) => [a, k & 15, (k >> 4) & 1, k >> 5])),
    },
    answer: refOf('a_shift16', () => shifter(16), 'Barrel shifter'),
  }),
  a_alu16: () => ({
    id: 'a_alu16', title: 'The ALU', level: 'arithmetic', allowed: 'nand',
    brief: '<b>y</b> = a op b with op = <code>ctl</code> = {OPX, f3}: 0 add, 8 sub, 1 sll, 2 slt, 3 sltu, 4 xor, 5 srl, 13 sra, 6 or, 7 and (shifts by b mod 16); <b>zero</b> = (y = 0).',
    ports: pins([['a', 16], ['b', 16], ['ctl', 4]], [['y', 16], ['zero']]),
    check: { kind: 'table', spec: (v) => aluSpec(16)(v).slice(0, 2), vectors: () => pairs16().flatMap(([a, b]) => ALU_OPS.map((c) => [a, b, c])) },
    answer: refOf('a_alu16', () => alu(16), 'ALU'),
  }),
  o_fastadd: () => ({
    id: 'o_fastadd', title: 'Fast adder', level: 'arithmetic', allowed: 'nand',
    brief: '<b>{cout, s} = a + b + cin</b> again, now graded on <b>depth</b>: compute the carries with a parallel-prefix tree. The generate / propagate cells are given.',
    ports: pins([['a', 16], ['b', 16], ['cin']], [['s', 16], ['cout']]),
    check: { kind: 'table', spec: ([a, b, c]) => [(a + b + c) & 0xffff, (a + b + c) >> 16], vectors: () => withBit(pairs16()) },
    answer: refOf('o_fastadd', () => koggeStone(16), 'Fast adder'),
  }),
  s_reg16: () => ({
    id: 's_reg16', title: '16-bit register', level: 'sequential', allowed: 'nand',
    brief: 'At a rising edge of <code>clk</code>: <b>q ← d</b> if <code>en</code>, else hold. Tested over 50 random cycles.',
    ports: pins([['d', 16], ['en'], ['clk']], [['q', 16]], 'clk'), check: { kind: 'sequence', steps: regSeq() },
    answer: refOf('s_reg16', () => register(16), '16-bit register'),
  }),
  s_pc: () => ({
    id: 's_pc', title: 'Program counter', level: 'sequential', allowed: 'nand',
    brief: 'At each rising edge: <b>pc ← 0</b> if <code>rst</code>, else <b>d</b> if <code>ld</code> (a jump), else <b>pc + 1</b>. Reset wins over load; pc wraps from 0xFFFF to 0.',
    ports: pins([['rst'], ['ld'], ['d', 16], ['clk']], [['pc', 16]], 'clk'), check: { kind: 'sequence', steps: pcSeq() },
    answer: refOf('s_pc', () => PC16, 'Program counter'),
  }),
  s_fsm: () => ({
    id: 's_fsm', title: '"101" detector', level: 'sequential', allowed: 'nand',
    brief: 'A bit arrives on <code>x</code> each clock. <b>y = 1</b> (before the edge) when x = 1 completes the pattern 1, 0, 1 (patterns may overlap: 10101 gives two). <code>rst</code> (synchronous) forgets everything.',
    ports: pins([['x'], ['rst'], ['clk']], [['y']], 'clk'), check: { kind: 'sequence', steps: fsmSeq() },
    answer: refOf('s_fsm', () => DET101, '"101" detector'),
  }),
  m_rf: () => ({
    id: 'm_rf', title: 'Register file', level: 'memory', allowed: 'nand',
    brief: 'Eight 16-bit registers. At a rising edge, if <code>we</code>: <b>x[wa] ← wd</b> (writes to x0 are ignored). Reads are combinational: <b>rd1 = x[ra1]</b>, <b>rd2 = x[ra2]</b>, and x0 always reads 0.',
    ports: pins([['wa', 3], ['we'], ['wd', 16], ['ra1', 3], ['ra2', 3], ['clk']], [['rd1', 16], ['rd2', 16]], 'clk'), check: { kind: 'sequence', steps: rfSeq() },
    answer: refOf('m_rf', () => RF8, 'Register file'),
  }),
};

