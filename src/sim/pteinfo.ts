// What an Sv32 leaf page-table entry permits (DOM-free): the rule of riscv/iss.ts walk() for a 4 KiB leaf, in words, for the
// chapter's PTE widget. tests/content-vmem.test.ts holds `leafOutcome` equal to ISS.walk over all 256 flag combinations,
// both modes and the three accesses, so the words cannot drift from the golden model (and the gates are held to that).

export const PTE_BITS = ['V', 'R', 'W', 'X', 'U', 'G', 'A', 'D'] as const;
export type Access = 'fetch' | 'load' | 'store';
export const ACCESSES: Access[] = ['fetch', 'load', 'store'];

export interface Outcome { ok: boolean; why: string }

/**
 * May this mode (U = 0, S = 1) do this access through a level-0 leaf with these flags (bit i of `flags` is PTE bit i: V R W X U G A D)?
 * `why` is the first rule that says no, in the order the walker tests them (the walker and the golden model agree on the order only
 * in the sense that any failing rule gives the same page fault).
 */
export function leafOutcome(flags: number, priv: 0 | 1, access: Access, sum = false, mxr = false): Outcome {
  const bit = (n: number) => (flags >> n) & 1;
  const [v, r, w, x, u, , a, d] = [0, 1, 2, 3, 4, 5, 6, 7].map(bit);
  if (!v) return { ok: false, why: 'V = 0: the entry is not valid' };
  if (!r && w) return { ok: false, why: 'W = 1 without R: a reserved combination' };
  if (!r && !x) return { ok: false, why: 'R = W = X = 0 marks a pointer to the next table, and there is no next table at the last level' };
  if (u ? priv === 1 && (access === 'fetch' || !sum) : priv !== 1) {
    return { ok: false, why: u ? 'U = 1: a user page, closed to supervisor mode' + (access === 'fetch' ? ' (for fetches always)' : ' unless SUM is set') : 'U = 0: a supervisor page, closed to user mode' };
  }
  if (access === 'fetch' ? !x : access === 'load' ? !(r || (mxr && x)) : !w) {
    return { ok: false, why: access === 'fetch' ? 'X = 0: not executable' : access === 'load' ? 'R = 0: not readable' : 'W = 0: not writable' };
  }
  if (!a) return { ok: false, why: 'A = 0: this hardware never sets A itself, software must (a page fault)' };
  if (access === 'store' && !d) return { ok: false, why: 'D = 0 on a store: software must set D (a page fault)' };
  return { ok: true, why: 'allowed' };
}

/** The page fault cause an access that fails raises: 12 fetch, 13 load, 15 store / atomic. */
export const faultCause = (a: Access): number => (a === 'fetch' ? 12 : a === 'load' ? 13 : 15);
