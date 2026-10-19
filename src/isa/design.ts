// The encoding designer's analysis of a Custom ISA table (DOM-free): which patterns clash (they can
// encode one word and neither is more specific), which shadow another (a special case the most
// specific match takes), an opcode map over the window of bits the patterns fix most, how much of
// the word space decodes, and what a plain decoder would cost in this site's bricks: one AND per
// instruction over its fixed bits (and the NOT of every more specific pattern it overlaps), with
// shared inverters. andN(k) is k − 1 two-input ANDs of 2 NANDs each (lib/combinational.ts;
// tests/isa-design.test.ts holds the count to stats(andN(k))).

import { tableOf, type IsaDoc } from './table';

export interface Clash { a: number; b: number; word: number }
export interface OpCell { value: number; rows: number[]; clash: boolean }

export interface DesignAnalysis {
  /** Same fixed-bit count, overlapping: no pattern wins. */
  clashes: Clash[];
  /** special overlaps general with more fixed bits: the special one wins its words. */
  shadows: { general: number; special: number }[];
  /** The opcode map's bits (inclusive, hi ≥ lo) and its cells. */
  window: { hi: number; lo: number };
  cells: OpCell[];
  decoded: number;
  total: number;
  /** False for 32-bit words: decoded is an upper bound (the patterns' sizes added). */
  exact: boolean;
  decoder: { nands: number; depth: number; ands: number; nots: number; inputs: number[] };
}

const u32 = (v: number) => v >>> 0;
const ones = (v: number) => { let n = 0; for (let x = u32(v); x; x &= x - 1) n++; return n; };
/** NANDs of andN(k): k − 1 ANDs, 2 NANDs each (a single input is a wire). */
export const andCost = (k: number) => (k >= 2 ? 2 * (k - 1) : 0);
/** Gate delays of andN(k): a balanced tree of ANDs, 2 each. */
export const andDepth = (k: number) => (k >= 2 ? 2 * Math.ceil(Math.log2(k)) : 0);

export function analyze(doc: IsaDoc): DesignAnalysis {
  const W = doc.wordBits;
  const rows = tableOf(doc).compiled.map((c) => ({ mask: c.mask, value: c.value, fixed: c.fixed }));
  const overlap = (i: number, j: number) => {
    const a = rows[i], b = rows[j], both = a.mask & b.mask;
    return u32(a.value & both) === u32(b.value & both);
  };

  const clashes: Clash[] = [];
  const shadows: { general: number; special: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (!overlap(i, j)) continue;
      if (rows[i].fixed === rows[j].fixed) clashes.push({ a: i, b: j, word: u32(rows[i].value | rows[j].value) });
      else shadows.push(rows[i].fixed > rows[j].fixed ? { general: j, special: i } : { general: i, special: j });
    }
  }

  // The opcode map: the k consecutive bits the patterns fix most (ties: the higher bits).
  const k = Math.min(W >= 16 ? 4 : 3, W);
  let best = W - 1, bestN = -1;
  for (let hi = W - 1; hi >= k - 1; hi--) {
    let n = 0;
    for (const r of rows) for (let b = hi; b > hi - k; b--) if ((r.mask >>> b) & 1) n++;
    if (n > bestN) { bestN = n; best = hi; }
  }
  const window = { hi: best, lo: best - k + 1 };
  const clashSet = new Set(clashes.map((c) => `${c.a}:${c.b}`));
  const cells: OpCell[] = Array.from({ length: 2 ** k }, (_, v) => {
    const inCell = rows.map((r, i) => [r, i] as const).filter(([r]) => {
      for (let t = 0; t < k; t++) {
        const b = window.lo + t;
        if ((r.mask >>> b) & 1 && ((r.value >>> b) & 1) !== ((v >> t) & 1)) return false;
      }
      return true;
    }).map(([, i]) => i);
    const clash = inCell.some((a) => inCell.some((b) => clashSet.has(`${a}:${b}`)));
    return { value: v, rows: inCell, clash };
  });

  const total = 2 ** W;
  let decoded = 0;
  if (W <= 16) {
    for (let w = 0; w < total; w++) for (const r of rows) if ((w & r.mask) === r.value) { decoded++; break; }
  } else decoded = Math.min(total, rows.reduce((n, r) => n + 2 ** (W - r.fixed), 0));

  // The plain decoder: row i is AND(its fixed literals, NOT match_j for every j that shadows it).
  const excl = rows.map((_, i) => shadows.filter((s) => s.general === i).map((s) => s.special));
  const inputs = rows.map((r, i) => r.fixed + excl[i].length);
  let zeroBits = 0;
  for (let b = 0; b < W; b++) if (rows.some((r) => (r.mask >>> b) & 1 && !((r.value >>> b) & 1))) zeroBits++;
  const inverted = new Set(excl.flat()).size;
  const nots = zeroBits + inverted;
  const ands = inputs.reduce((n, x) => n + andCost(x), 0);
  // Depth: a literal is 1 delay (its inverter), a shadowing match its own depth + 1; most fixed bits first.
  const depth = new Array<number>(rows.length).fill(0);
  const order = rows.map((_, i) => i).sort((a, b) => rows[b].fixed - rows[a].fixed);
  for (const i of order) depth[i] = Math.max(1, ...excl[i].map((j) => depth[j] + 1)) + andDepth(inputs[i]);
  return {
    clashes, shadows, window, cells, decoded, total, exact: W <= 16,
    decoder: { nands: ands + nots, depth: rows.length ? Math.max(...depth) : 0, ands, nots, inputs },
  };
}

/** A pattern written in groups of 4 from the most significant bit. */
export function groupPattern(p: string): string {
  return p.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

/** Bits a letter has in a pattern. */
export const bitsOf = (p: string, l: string) => [...p.replace(/\s+/g, '')].filter((c) => c === l).length;

export { ones as popcount };
