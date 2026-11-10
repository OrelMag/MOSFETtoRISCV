// The ferrite core's rule (lib/coremem.ts builds with it, view/schematic.ts paints by it): currents counted in half-select
// units, a square loop. No imports beyond values, so the view can use it without pulling in the library.

/** A core's private state: its bit (-1 unknown), the clock as last seen, the drive range sampled while the clock was low. */
export interface CoreState { b: number; clk: number; lo: number; hi: number }

export const isCoreState = (s: unknown): s is CoreState => !!s && typeof s === 'object' && typeof (s as CoreState).b === 'number' && typeof (s as CoreState).lo === 'number';

/** The drive that switches a core, in half-select units (one select wire or the inhibit carries one). */
export const CORE_FULL = 2;

/**
 * The drive on a core as a range (an unknown wire could be on or off): its X and Y lines' write halves +1 each, their
 * read halves and the inhibit -1 each. x and y are the lines' two bits packed (bit 0 read, bit 1 write; -1 unknown).
 */
export function coreDrive(x: number, y: number, inh: number): { lo: number; hi: number } {
  let lo = 0, hi = 0;
  const add = (v: number, sign: number) => {
    if (v === 1) { lo += sign; hi += sign; }
    else if (v !== 0) { lo += Math.min(0, sign); hi += Math.max(0, sign); }
  };
  for (const line of [x, y]) {
    add(line < 0 ? -1 : line & 1, -1);
    add(line < 0 ? -1 : line >> 1 & 1, 1);
  }
  add(inh, -1);
  return { lo, hi };
}

/** Is a core with bit b switching under this drive: 1 sure, 0 not, -1 maybe (an unknown bit or drive). */
export function coreSwitching(b: number, lo: number, hi: number): number {
  if ((b === 0 && lo >= CORE_FULL) || (b === 1 && hi <= -CORE_FULL)) return 1;
  const may = (b !== 1 && hi >= CORE_FULL) || (b !== 0 && lo <= -CORE_FULL);
  return may ? -1 : 0;
}

/** The bit after an edge with this drive (sure: a clean 0 → 1 edge; otherwise anything it could have become is unknown). */
export function coreNext(b: number, lo: number, hi: number, sure: boolean): number {
  if (sure && lo >= CORE_FULL) return 1;
  if (sure && hi <= -CORE_FULL) return 0;
  let n = b;
  if (hi >= CORE_FULL && n !== 1) n = -1;
  if (lo <= -CORE_FULL && n !== 0) n = -1;
  return n;
}
