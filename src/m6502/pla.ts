// The decode PLA, computed from the control table: for each control signal and cycle, the opcodes
// that assert it are minimized over the eight IR bits, the 105 undocumented opcodes being free
// (don't-cares). Each product term, ANDed with its T line, is one row of the AND plane; a signal is
// the OR of its rows. On the die a row is a NOR gate over complemented literals, an output a NOR of
// rows: the same two-level logic the 6502's 130-row decode ROM is.

import { OPCODES } from './isa';
import { has, MAX_T, SIGNALS, UCODE } from './ucode';

/** A product term over IR: bits in `mask` are free, the others must equal `val`. */
export interface Cube { val: number; mask: number }

export interface PlaRow {
  /** The opcode term. */
  cube: Cube;
  /** Cycle 1 … MAX_T this row is active in. */
  t: number;
  /** Indices into SIGNALS of the outputs it drives. */
  outs: number[];
}

const covers = (c: Cube, m: number) => (m & ~c.mask) === c.val;

/** Quine–McCluskey with don't-cares: primes of on ∪ dc, then a cover of `on` (essential first, then greedy). */
export function minimizeDc(on: number[], dc: number[]): Cube[] {
  if (!on.length) return [];
  const key = (c: Cube) => c.val * 512 + c.mask;
  let cubes = new Map<number, Cube>([...on, ...dc].map((m) => [key({ val: m, mask: 0 }), { val: m, mask: 0 }]));
  const primes: Cube[] = [];
  while (cubes.size) {
    const list = [...cubes.values()], used = new Set<number>(), next = new Map<number, Cube>();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], diff = a.val ^ b.val;
      if (a.mask === b.mask && diff && !(diff & (diff - 1))) {
        const m = { val: a.val & ~diff, mask: a.mask | diff };
        next.set(key(m), m);
        used.add(key(a)).add(key(b));
      }
    }
    for (const c of list) if (!used.has(key(c))) primes.push(c);
    cubes = next;
  }
  const left = new Set(on), chosen: Cube[] = [];
  while (left.size) {
    let pick: Cube | undefined;
    for (const m of left) {
      const by = primes.filter((p) => covers(p, m));
      if (by.length === 1) { pick = by[0]; break; }
    }
    if (!pick) {
      let best = -1;
      for (const p of primes) {
        let n = 0;
        for (const m of left) if (covers(p, m)) n++;
        // more minterms first, then fewer literals (a cheaper row)
        if (n > best || (n === best && pick && popcount(p.mask) > popcount(pick.mask))) { best = n; pick = p; }
      }
    }
    chosen.push(pick!);
    for (const m of [...left]) if (covers(pick!, m)) left.delete(m);
  }
  return chosen;
}

const popcount = (x: number) => { let n = 0; for (; x; x &= x - 1) n++; return n; };

/** The rows of the PLA: one per distinct (term, cycle), shared by every signal that uses it. */
export function plaRows(): PlaRow[] {
  const rows = new Map<string, PlaRow>();
  const undocumented = OPCODES.flatMap((o, op) => (o ? [] : [op]));
  for (let t = 1; t <= MAX_T; t++) {
    // an opcode without a cycle t never meets T line t: free too
    const absent = OPCODES.flatMap((o, op) => (o && UCODE[op]!.length < t ? [op] : []));
    for (let s = 0; s < SIGNALS.length; s++) {
      const on = OPCODES.flatMap((o, op) => (o && UCODE[op]!.length >= t && has(UCODE[op]![t - 1], s) ? [op] : []));
      for (const cube of minimizeDc(on, [...undocumented, ...absent])) {
        const k = `${t}:${cube.val}:${cube.mask}`;
        let r = rows.get(k);
        if (!r) rows.set(k, (r = { cube, t, outs: [] }));
        r.outs.push(s);
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t || a.cube.mask - b.cube.mask || a.cube.val - b.cube.val);
}

/** The PLA's outputs for an opcode and cycle (the rows that match it), as a signal-index set. */
export function plaEval(rows: readonly PlaRow[], ir: number, t: number): Set<number> {
  const out = new Set<number>();
  for (const r of rows) if (r.t === t && covers(r.cube, ir)) for (const s of r.outs) out.add(s);
  return out;
}

/** The literals of a term: per IR bit, 1 / 0 / undefined (free), for drawing and the netlist. */
export function literals(c: Cube): (0 | 1 | undefined)[] {
  return Array.from({ length: 8 }, (_, i) => ((c.mask >> i) & 1 ? undefined : (((c.val >> i) & 1) as 0 | 1)));
}
