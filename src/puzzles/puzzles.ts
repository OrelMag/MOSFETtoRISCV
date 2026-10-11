// Program puzzles (roadmap Phase 12, "Programs on your own CPU"): a task given as streams of words, solved by
// a program on a CPU the learner built (or one of the sandbox's), run on its gates. A test is the words
// PUZZLE IN hands out and the words PUZZLE OUT must record, in order, before the CPU halts. Nothing here
// depends on an ISA: the CPU's program is whatever its ROM holds, so any CPU with a ROM and the two ports
// can play. No DOM.

import { rng } from '../campaign/drills';

export type PuzzleGroup = 'streams' | 'arithmetic' | 'text' | 'memory';

export const PUZZLE_GROUPS: { id: PuzzleGroup; title: string }[] = [
  { id: 'streams', title: 'Streams' },
  { id: 'arithmetic', title: 'Arithmetic' },
  { id: 'text', title: 'Text' },
  { id: 'memory', title: 'Memory' },
];

export interface PuzzleTest {
  name: string;
  /** Words PUZZLE IN hands out, in order (puzzle words: `bits` wide). */
  input: number[];
  /** Words PUZZLE OUT must record, in order, and nothing more. */
  expect: number[];
}

export interface Puzzle {
  id: string;
  title: string;
  group: PuzzleGroup;
  /** One line for the list. */
  short: string;
  /** The task (HTML). */
  brief: string;
  /** Bits of a puzzle word: a narrower port takes (and gives) each word in pieces, most significant first. */
  bits: 8 | 16;
  /** Words are signed: a wider port gets them sign-extended. */
  signed?: boolean;
  tests(): PuzzleTest[];
  /** Clock cycles a test may take before it is declared stuck (generous: a 4-bit CPU is slow). */
  maxCycles: number;
  /** The reference solution in pseudocode (Show answer on a CPU without a reference program). */
  pseudo: string;
}

const u8 = (v: number) => v & 0xff;
const words = (r: () => number, n: number, lo: number, hi: number) => Array.from({ length: n }, () => lo + Math.floor(r() * (hi - lo + 1)));
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const popcount = (v: number) => v.toString(2).split('').filter((c) => c === '1').length;

export const PUZZLES: Puzzle[] = [
  {
    id: 'echo', title: 'Echo', group: 'streams', short: 'copy IN to OUT until a 0',
    brief: 'Copy each word from IN to OUT until a <b>0</b> arrives (the 0 is not copied), then halt.',
    bits: 8, maxCycles: 4000,
    tests: () => {
      const r = rng(101);
      return [[5], [], [1, 2, 3, 255], words(r, 12, 1, 255)].map((ws, i) => ({ name: `stream ${i + 1}`, input: [...ws, 0], expect: ws }));
    },
    pseudo: 'loop:\n  x ← IN\n  if x = 0: halt\n  OUT ← x\n  goto loop',
  },
  {
    id: 'countdown', title: 'Countdown', group: 'streams', short: 'n, n − 1, …, 1',
    brief: 'Read <i>n</i> (0 … 30) and write <i>n</i>, <i>n</i> − 1, …, 1 to OUT, then halt (nothing for 0).',
    bits: 8, maxCycles: 4000,
    tests: () => [3, 0, 1, 10, 30].map((n) => ({ name: `n = ${n}`, input: [n], expect: Array.from({ length: n }, (_, i) => n - i) })),
    pseudo: 'n ← IN\nwhile n ≠ 0:\n  OUT ← n\n  n ← n − 1\nhalt',
  },
  {
    id: 'add_pairs', title: 'Add pairs', group: 'streams', short: 'a + b for each pair',
    brief: 'The first word is <i>n</i> (0 … 10), then <i>n</i> pairs <i>a</i>, <i>b</i> follow. For each pair write <i>a</i> + <i>b</i> (mod 256).',
    bits: 8, maxCycles: 6000,
    tests: () => {
      const r = rng(102);
      return [[[2, 3]], [], [[200, 100], [255, 1], [0, 0]], Array.from({ length: 10 }, () => words(r, 2, 0, 255) as [number, number])].map((ps, i) => ({
        name: `${ps.length} pair${ps.length === 1 ? '' : 's'}${i === 3 ? ', random' : ''}`, input: [ps.length, ...ps.flat()], expect: ps.map(([a, b]) => u8(a + b)),
      }));
    },
    pseudo: 'n ← IN\nrepeat n times:\n  a ← IN; b ← IN\n  OUT ← a + b\nhalt',
  },
  {
    id: 'stream_sum', title: 'Stream sum', group: 'streams', short: 'sum until 0, mod 256',
    brief: 'Read words until a <b>0</b> arrives. Write their sum (mod 256) to OUT, then halt.',
    bits: 8, maxCycles: 6000,
    tests: () => {
      const r = rng(103);
      return [[5, 7], [], [200, 100, 17], [1, 1, 1, 1, 1, 1], words(r, 16, 1, 255)].map((ws, i) => ({ name: `stream ${i + 1}`, input: [...ws, 0], expect: [u8(ws.reduce((s, x) => s + x, 0))] }));
    },
    pseudo: 'sum ← 0\nloop:\n  x ← IN\n  if x = 0: goto done\n  sum ← sum + x\n  goto loop\ndone:\n  OUT ← sum\n  halt',
  },
  {
    id: 'running_max', title: 'Running maximum', group: 'streams', short: 'the largest so far, after every word',
    brief: 'Read words until a <b>0</b> arrives. After each word, write the largest word read so far (unsigned).',
    bits: 8, maxCycles: 8000,
    tests: () => {
      const r = rng(104);
      return [[3, 9, 4], [], [255, 1], [1, 2, 3, 4], words(r, 12, 1, 255)].map((ws, i) => {
        let m = 0;
        return { name: `stream ${i + 1}`, input: [...ws, 0], expect: ws.map((x) => (m = Math.max(m, x))) };
      });
    },
    pseudo: 'max ← 0\nloop:\n  x ← IN\n  if x = 0: halt\n  if x > max: max ← x\n  OUT ← max\n  goto loop',
  },
  {
    id: 'odd_only', title: 'Odd ones out', group: 'streams', short: 'copy only the odd words',
    brief: 'Read words until a <b>0</b> arrives. Copy to OUT only the <b>odd</b> ones, in order.',
    bits: 8, maxCycles: 6000,
    tests: () => {
      const r = rng(105);
      return [[1, 2, 3], [2, 4, 6], [], [255, 254, 127, 128], words(r, 14, 1, 255)].map((ws, i) => ({ name: `stream ${i + 1}`, input: [...ws, 0], expect: ws.filter((x) => x & 1) }));
    },
    pseudo: 'loop:\n  x ← IN\n  if x = 0: halt\n  if x is odd (bit 0 = 1): OUT ← x\n  goto loop',
  },
  {
    id: 'popcount', title: 'Count the ones', group: 'arithmetic', short: 'the number of 1 bits of each word',
    brief: 'Read words until a <b>0</b> arrives. For each, write how many of its 8 bits are 1.',
    bits: 8, maxCycles: 12000,
    tests: () => {
      const r = rng(106);
      return [[1, 3, 255], [128], [], words(r, 8, 1, 255)].map((ws, i) => ({ name: `stream ${i + 1}`, input: [...ws, 0], expect: ws.map(popcount) }));
    },
    pseudo: 'loop:\n  x ← IN\n  if x = 0: halt\n  n ← 0\n  repeat 8 times:\n    n ← n + (x & 1)\n    x ← x >> 1\n  OUT ← n\n  goto loop',
  },
  {
    id: 'multiply', title: 'Multiply', group: 'arithmetic', short: '8 × 8 → 16 bits, shift and add',
    brief: 'Read <i>a</i> and <i>b</i> (0 … 255) and write <i>a</i> × <i>b</i> as two words: the high byte, then the low byte. No multiply instruction needed: for every 1 bit of <i>b</i>, add <i>a</i> shifted to that bit\'s position.',
    bits: 8, maxCycles: 20000,
    tests: () => [[3, 4], [0, 200], [255, 255], [16, 16], [100, 3], [13, 77]].map(([a, b]) => ({ name: `${a} × ${b}`, input: [a, b], expect: [(a * b) >> 8, u8(a * b)] })),
    pseudo: 'a ← IN; b ← IN\np ← 0  (16 bits)\nwhile b ≠ 0:\n  if b & 1: p ← p + a\n  a ← a << 1  (16 bits)\n  b ← b >> 1\nOUT ← p >> 8\nOUT ← p & 255\nhalt',
  },
  {
    id: 'divide', title: 'Divide', group: 'arithmetic', short: 'quotient and remainder',
    brief: 'Read <i>a</i> (0 … 255) and <i>b</i> (1 … 255) and write <i>a</i> / <i>b</i> (rounded down), then <i>a</i> mod <i>b</i>. Repeated subtraction works but takes up to 255 rounds; long division (shift and subtract, one quotient bit per round) takes 8.',
    bits: 8, maxCycles: 20000,
    tests: () => [[7, 2], [0, 5], [255, 1], [255, 255], [100, 7], [9, 10]].map(([a, b]) => ({ name: `${a} / ${b}`, input: [a, b], expect: [Math.floor(a / b), a % b] })),
    pseudo: 'a ← IN; b ← IN\nq ← 0\nwhile a ≥ b:\n  a ← a − b\n  q ← q + 1\nOUT ← q\nOUT ← a\nhalt',
  },
  {
    id: 'gcd', title: 'GCD', group: 'arithmetic', short: 'greatest common divisor',
    brief: 'Read <i>a</i> and <i>b</i> (1 … 255) and write their greatest common divisor. Euclid\'s way needs no division: subtract the smaller from the larger until they are equal. That is slow when one is much smaller than the other (gcd(255, 1) takes 254 rounds); the references use faster ways (remainders, or Stein\'s binary GCD).',
    bits: 8, maxCycles: 20000,
    tests: () => [[12, 18], [7, 5], [100, 75], [255, 1], [36, 36], [233, 144]].map(([a, b]) => ({ name: `gcd(${a}, ${b})`, input: [a, b], expect: [gcd(a, b)] })),
    pseudo: 'a ← IN; b ← IN\nwhile a ≠ b:\n  if a > b: a ← a − b\n  else: b ← b − a\nOUT ← a\nhalt',
  },
  {
    id: 'fibonacci', title: 'Fibonacci', group: 'arithmetic', short: 'the first n Fibonacci numbers',
    brief: 'Read <i>n</i> (1 … 13) and write the first <i>n</i> Fibonacci numbers: 1, 1, 2, 3, 5, …',
    bits: 8, maxCycles: 6000,
    tests: () => [1, 2, 5, 13].map((n) => {
      const f = [1, 1];
      while (f.length < n) f.push(f[f.length - 1] + f[f.length - 2]);
      return { name: `n = ${n}`, input: [n], expect: f.slice(0, n) };
    }),
    pseudo: 'n ← IN\na ← 1; b ← 1\nrepeat n times:\n  OUT ← a\n  (a, b) ← (b, a + b)\nhalt',
  },
  {
    id: 'decimal', title: 'Print decimal', group: 'text', short: 'a number as ASCII digits',
    brief: 'Read <i>n</i> (0 … 255) and write its decimal digits to OUT as ASCII characters (\'0\' is 48), without leading zeros: 7 → "7", 205 → "205". No divide instruction needed: subtract 100s, then 10s (or something faster).',
    bits: 8, maxCycles: 8000,
    tests: () => [0, 7, 10, 99, 100, 205, 255].map((n) => ({ name: `n = ${n}`, input: [n], expect: [...String(n)].map((c) => c.charCodeAt(0)) })),
    pseudo: 'n ← IN\nh ← 0; while n ≥ 100: n ← n − 100; h ← h + 1\nt ← 0; while n ≥ 10: n ← n − 10; t ← t + 1\nif h ≠ 0: OUT ← 48 + h\nif h ≠ 0 or t ≠ 0: OUT ← 48 + t\nOUT ← 48 + n\nhalt',
  },
  {
    id: 'reverse', title: 'Reverse', group: 'memory', short: 'n words in, the same words reversed',
    brief: 'Read <i>n</i> (1 … 16), then <i>n</i> words. Write them back in reverse order. You need somewhere to keep them: a RAM, or a stack.',
    bits: 8, maxCycles: 8000,
    tests: () => {
      const r = rng(107);
      return [[1, 2, 3], [42], words(r, 16, 0, 255), words(r, 9, 0, 255)].map((ws, i) => ({ name: `${ws.length} word${ws.length === 1 ? '' : 's'}${i > 1 ? ', random' : ''}`, input: [ws.length, ...ws], expect: [...ws].reverse() }));
    },
    pseudo: 'n ← IN\nfor i in 0 … n − 1: mem[i] ← IN\nfor i in n − 1 … 0: OUT ← mem[i]\nhalt',
  },
  {
    id: 'sort', title: 'Sort', group: 'memory', short: 'n words in, ascending out',
    brief: 'Read <i>n</i> (1 … 16), then <i>n</i> words (unsigned). Write them in ascending order. Any algorithm; graded on cycles.',
    bits: 8, maxCycles: 30000,
    tests: () => {
      const r = rng(108);
      return [[3, 1, 2], [7], [5, 4, 3, 2, 1], words(r, 16, 0, 255), words(r, 11, 0, 255)].map((ws, i) => ({ name: `${ws.length} word${ws.length === 1 ? '' : 's'}${i > 2 ? ', random' : ''}`, input: [ws.length, ...ws], expect: [...ws].sort((a, b) => a - b) }));
    },
    pseudo: 'n ← IN\nfor i in 0 … n − 1: mem[i] ← IN\nrepeat n − 1 times:          (bubble sort)\n  for i in 0 … n − 2:\n    if mem[i] > mem[i + 1]: swap them\nfor i in 0 … n − 1: OUT ← mem[i]\nhalt',
  },
];

export const PUZZLE_BY_ID = new Map(PUZZLES.map((p) => [p.id, p]));

/** The id of the chip a puzzle is played on. */
export const puzzleChipId = (p: Puzzle) => `u_pz_${p.id}`;

/** The puzzle whose chip this is (a copy the user renamed keeps its id). */
export function puzzleOfChip(chipId: string): Puzzle | undefined {
  const m = chipId.match(/^u_pz_([a-z0-9_]+?)(?:_\d+)?$/);
  return m ? PUZZLE_BY_ID.get(m[1]) ?? PUZZLE_BY_ID.get(m[1].replace(/_\d+$/, '')) : undefined;
}

// ---- words through a port of another width ----------------------------------------------------

/** Pieces of a puzzle word on a port `w` bits wide (most significant first); one piece when it fits. */
export const piecesPer = (p: Puzzle, w: number) => (w >= p.bits ? 1 : Math.ceil(p.bits / w));

/** What PUZZLE IN hands out for a test on a port `w` bits wide. */
export function inputOn(p: Puzzle, t: PuzzleTest, w: number): number[] {
  const k = piecesPer(p, w);
  const m = (v: number) => (w >= 32 ? v >>> 0 : v & (2 ** w - 1));
  if (k === 1) return t.input.map((v) => m(p.signed ? v << (32 - p.bits) >> (32 - p.bits) : v & (2 ** p.bits - 1)));
  return t.input.flatMap((v) => Array.from({ length: k }, (_, i) => m(Math.floor((v & (2 ** p.bits - 1)) / 2 ** (w * (k - 1 - i))))));
}

/**
 * The puzzle words recorded on a port `w` bits wide: pieces joined (most significant first; a last
 * incomplete word is kept as it is, so the comparison fails on it), every word cut to `bits` (an
 * X word stays -1).
 */
export function outputFrom(p: Puzzle, got: number[], w: number): number[] {
  const k = piecesPer(p, w);
  const cut = (v: number) => (v < 0 ? -1 : v % 2 ** p.bits);
  if (k === 1) return got.map(cut);
  const out: number[] = [];
  for (let i = 0; i < got.length; i += k) {
    const ps = got.slice(i, i + k);
    out.push(ps.some((x) => x < 0) || ps.length < k ? -1 : cut(ps.reduce((s, x) => s * 2 ** w + x, 0)));
  }
  return out;
}
