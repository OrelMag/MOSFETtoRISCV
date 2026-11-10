// The TLB as lib/vm.ts builds it, in software (DOM-free): fully associative, keyed by the 20-bit virtual page number, a fill
// replaces the entries in turn (a round-robin pointer, not least-recently-used), a flush forgets them all. Chapter 'vmem' uses
// it to price page-table walks over long address streams the gates would take hours to run; tests/content-vmem.test.ts holds
// its miss counts equal to the stalls of the gate-level CPU on the same program.

import { WALK_CYCLES } from '../riscv/vmprograms';

export class TlbModel {
  private readonly vpn: number[];
  private ptr = 0;
  hits = 0;
  misses = 0;
  constructor(readonly entries: number) {
    this.vpn = new Array(entries).fill(-1);
  }
  /** Look the page up; a miss fills the entry the pointer names (the walk's result) and counts. Returns whether it hit. */
  access(vpn: number): boolean {
    if (this.vpn.includes(vpn)) { this.hits++; return true; }
    this.misses++;
    this.vpn[this.ptr] = vpn;
    this.ptr = (this.ptr + 1) % this.entries;
    return false;
  }
  /** Look up without filling (the access faults: a walk that faults leaves the TLB as it was). */
  has(vpn: number): boolean {
    return this.vpn.includes(vpn);
  }
  flush(): void {
    this.vpn.fill(-1);
    this.ptr = 0;
  }
}

/** An address stream's page numbers through a TLB of this size: misses, accesses and the cycles the walks cost. */
export function missesOf(pages: Iterable<number>, entries: number): { accesses: number; misses: number; rate: number; cycles: number } {
  const t = new TlbModel(entries);
  let n = 0;
  for (const p of pages) { t.access(p); n++; }
  return { accesses: n, misses: t.misses, rate: n ? t.misses / n : 0, cycles: t.misses * WALK_CYCLES };
}

/** Access patterns over `pages` distinct 4 KiB pages (the working set), `n` accesses, as page numbers. */
export type Pattern = 'sequential' | 'stride' | 'random';
export function* pagesOf(p: Pattern, pages: number, n: number): Generator<number> {
  let seed = 20240607;
  for (let i = 0; i < n; i++) {
    if (p === 'sequential') yield Math.floor(i / 1024) % pages; // a word array: 1024 words a page
    else if (p === 'stride') yield i % pages; // one access a page, round and round: a column of a wide matrix
    else {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      yield (seed >>> 8) % pages;
    }
  }
}
