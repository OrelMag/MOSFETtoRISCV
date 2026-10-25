// Two-level minimization (DOM-free): the prime implicants of a function given by its 1s and don't-cares
// (Quine–McCluskey), and a cover of the 1s by them: exact (fewest terms, then fewest literals) by branch and bound
// while the search stays small, else the greedy cover (essential primes first, then the one covering most). The
// campaign's K-map drills (exact answers) and the sandbox's truth-table chips (editor/ttable.ts) share it.

/** A product term: bits in `mask` are free; the others must equal `val`. Bit n − 1 is the first variable. */
export interface Term { val: number; mask: number }

export const covers = (t: Term, m: number): boolean => (m & ~t.mask) === t.val;

function popcount(x: number): number {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
}

/** Literals in a term of n variables. */
export const literals = (t: Term, n: number): number => n - popcount(t.mask);

/** Prime implicants of ones ∪ dc (Quine–McCluskey). */
export function primes(ones: number[], dc: number[] = []): Term[] {
  let cur: Term[] = [...new Set([...ones, ...dc])].map((m) => ({ val: m, mask: 0 }));
  const out: Term[] = [];
  const key = (t: Term) => `${t.val}/${t.mask}`;
  const seen = new Set<string>();
  while (cur.length) {
    const used = new Set<string>(), next = new Map<string, Term>();
    for (let i = 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
      const a = cur[i], b = cur[j], d = a.val ^ b.val;
      if (a.mask === b.mask && d && !(d & (d - 1))) {
        const t = { val: a.val & ~d, mask: a.mask | d };
        next.set(key(t), t);
        used.add(key(a)).add(key(b));
      }
    }
    for (const t of cur) if (!used.has(key(t)) && !seen.has(key(t))) { seen.add(key(t)); out.push(t); }
    cur = [...next.values()];
  }
  return out;
}

/** Branch-and-bound steps before minimumCover settles for the greedy cover. */
export const EXACT_BUDGET = 2_000;

/**
 * A minimum sum of products covering `ones` (fewest terms, then fewest literals); `exact` false when the search
 * passed `budget` steps and the greedy cover (never worse than what the search had found) was returned instead.
 */
export function cover(n: number, ones: number[], dc: number[] = [], budget = EXACT_BUDGET): { terms: Term[]; exact: boolean } {
  if (!ones.length) return { terms: [], exact: true };
  const all = primes(ones, dc).filter((p) => ones.some((m) => covers(p, m)));
  // Essential primes (the only cover of some 1) are in every minimum: take them, search the rest.
  const ess: Term[] = [];
  for (const m of ones) {
    const by = all.filter((p) => covers(p, m));
    if (by.length === 1 && !ess.includes(by[0])) ess.push(by[0]);
  }
  const rest = ones.filter((m) => !ess.some((p) => covers(p, m)));
  const ps = all.filter((p) => !ess.includes(p) && rest.some((m) => covers(p, m)));
  const cost = (ts: Term[]) => ts.length * 1000 + ts.reduce((a, t) => a + literals(t, n), 0);
  let best: Term[] = rest.length ? greedyCover(rest, ps) : [];
  let steps = 0, out = false;
  const go = (left: number[], chosen: Term[]) => {
    if (out || cost(chosen) >= cost(best)) return;
    if (++steps > budget) { out = true; return; }
    if (!left.length) { best = [...chosen]; return; }
    // Branch on the uncovered minterm with the fewest covering primes.
    let m = left[0], fewest = Infinity;
    for (const x of left) {
      let c = 0;
      for (const p of ps) if (covers(p, x)) c++;
      if (c < fewest) { fewest = c; m = x; }
    }
    for (const p of ps) {
      if (!covers(p, m)) continue;
      go(left.filter((x) => !covers(p, x)), [...chosen, p]);
    }
  };
  if (rest.length) go(rest, []);
  return { terms: [...ess, ...best], exact: !out };
}

/** The exact minimum (drills: small functions only). */
export const minimumCover = (n: number, ones: number[], dc: number[] = []): Term[] => cover(n, ones, dc, Infinity).terms;

function greedyCover(ones: number[], ps: Term[]): Term[] {
  const left = new Set(ones), chosen: Term[] = [];
  while (left.size) {
    let pick: Term | undefined;
    for (const m of left) {
      const by = ps.filter((p) => covers(p, m));
      if (by.length === 1) { pick = by[0]; break; }
    }
    const gain = (p: Term) => { let c = 0; for (const m of left) if (covers(p, m)) c++; return c; };
    pick ??= ps.reduce((b, p) => (gain(p) > gain(b) ? p : b));
    chosen.push(pick);
    for (const m of [...left]) if (covers(pick, m)) left.delete(m);
  }
  return chosen;
}
