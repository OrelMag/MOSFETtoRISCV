// DRAM timing in our clock cycles, and the row-buffer model the memory chapters (32, 33) share.
// Real DDR4-3200 values (22-22-22) converted at the single-cycle CPU's clock: its period is 158 NAND
// delays (src/bench/results.json) at the 25 ps per NAND the benchmarks use, 3.95 ns. A CPU this slow
// pays only a few cycles per DRAM command; at 3 GHz the same nanoseconds are tens of cycles.

/** ps per NAND delay (src/bench/results.json psPerNand) and the single-cycle CPU's period in NAND delays. */
export const PS_PER_NAND = 25, SC_PERIOD_NANDS = 158;
/** Our clock period, ns. */
export const CLOCK_NS = (SC_PERIOD_NANDS * PS_PER_NAND) / 1000;

/** DDR4-3200 AA (22-22-22), an 8 Gb x8 device: datasheet values in ns. */
export const DDR4_3200 = { tRCD: 13.75, tCAS: 13.75, tRP: 13.75, tRAS: 32, tREFI: 7800, tRFC: 350, retentionMs: 64 } as const;

/** A wait of `ns` in clock cycles of `periodNs`: rounded up (a command may not come early). */
export const cyclesOf = (ns: number, periodNs = CLOCK_NS) => Math.ceil(ns / periodNs - 1e-9);

export interface DramTiming {
  /** ACT → RD / WR: the word line rises and the sense amplifiers settle. */
  tRCD: number;
  /** RD → first data word: the column path. */
  tCAS: number;
  /** PRE → ACT: the bit lines back at VDD/2. */
  tRP: number;
  /** ACT → PRE at the earliest: the row's restore must finish. */
  tRAS: number;
  /** Words per column command (a cache line), one a cycle. */
  burst: number;
  /** A REF command at least this often (rounded down), and how long it keeps the bank busy. */
  tREFI: number;
  tRFC: number;
}

/** The timings every memory chapter uses: DDR4-3200 at our clock, a 4-word burst. */
export const TIMING: DramTiming = {
  tRCD: cyclesOf(DDR4_3200.tRCD), tCAS: cyclesOf(DDR4_3200.tCAS), tRP: cyclesOf(DDR4_3200.tRP), tRAS: cyclesOf(DDR4_3200.tRAS),
  burst: 4, tREFI: Math.floor(DDR4_3200.tREFI / CLOCK_NS), tRFC: cyclesOf(DDR4_3200.tRFC),
};

/** Where the bank's row buffer stood for an access. */
export type RowOutcome = 'hit' | 'miss' | 'conflict';
export type PagePolicy = 'open' | 'closed';

export interface DramGeometry {
  banks: number;
  /** Words per row (a power of two). */
  rowWords: number;
  /** XOR the row's parity into the bank number: two streams a multiple of banks × rows apart stop sharing banks. */
  hash?: boolean;
}

/** Bank and row of a word address: rows interleaved over the banks (word → column, then bank, then row). */
export function bankRow(g: DramGeometry, word: number): { bank: number; row: number } {
  const row = Math.floor(word / (g.rowWords * g.banks));
  let bank = Math.floor(word / g.rowWords) % g.banks;
  if (g.hash && g.banks > 1) {
    let p = 0;
    for (let r = row; r; r >>>= 1) p ^= r & 1;
    bank ^= p;
  }
  return { bank, row };
}

/** Cycles from the request to the last word: the commands an outcome needs, then the burst. */
export function accessCycles(o: RowOutcome | 'closed', t: DramTiming, words = t.burst): number {
  const pre = o === 'conflict' ? t.tRP : 0, act = o === 'hit' ? 0 : t.tRCD;
  return pre + act + t.tCAS + words;
}

export interface Access {
  bank: number;
  row: number;
  outcome: RowOutcome | 'closed';
  cycles: number;
}

/**
 * The row buffers of a DRAM, one request at a time (as the caches' miss controller issues them).
 * Open page: a row stays open after its access; closed page: every access activates its row and
 * precharges after (the precharge hidden before the next request).
 */
export class RowBuffers {
  readonly open: number[];
  hits = 0;
  misses = 0;
  conflicts = 0;
  cycles = 0;

  constructor(readonly g: DramGeometry, readonly policy: PagePolicy = 'open', readonly t: DramTiming = TIMING) {
    this.open = new Array<number>(g.banks).fill(-1);
  }

  access(word: number, words = this.t.burst): Access {
    const { bank, row } = bankRow(this.g, word);
    let outcome: Access['outcome'];
    if (this.policy === 'closed') {
      outcome = 'closed';
      this.misses++;
    } else {
      outcome = this.open[bank] === row ? 'hit' : this.open[bank] < 0 ? 'miss' : 'conflict';
      if (outcome === 'hit') this.hits++;
      else if (outcome === 'miss') this.misses++;
      else this.conflicts++;
      this.open[bank] = row;
    }
    const cycles = accessCycles(outcome, this.t, words);
    this.cycles += cycles;
    return { bank, row, outcome, cycles };
  }
}
