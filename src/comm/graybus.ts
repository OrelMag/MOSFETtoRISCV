// What a receiver can read when it samples a multi-bit value that changes under it, DOM-free. Each bit has its own wire
// delay, so for an instant after the sender's edge some of the changing bits have arrived and the others have not: the
// receiver may read the old word with any subset of the changing bits flipped. A binary count flips as many bits as the
// trailing ones of the old value plus one; a Gray count flips exactly one.

import { toGray } from './asyncfifo';

export const bitsOf = (x: number): number => { let n = 0; for (let v = x >>> 0; v; v >>>= 1) n += v & 1; return n; };

/** Every word a sampler can read while `from` becomes `to`: `from` with any subset of the differing bits flipped, ascending. */
export function readings(from: number, to: number): number[] {
  const diff = from ^ to, out: number[] = [];
  // enumerate the subsets of diff
  let sub = 0;
  do { out.push(from ^ sub); sub = (sub - diff) & diff; } while (sub);
  return out.sort((a, b) => a - b);
}

/** The words read that are neither the old nor the new value. */
export const garbage = (from: number, to: number): number[] => readings(from, to).filter((r) => r !== from && r !== to);

/** The largest distance of a possible reading from the word the sender meant (the new one). */
export const worstError = (from: number, to: number): number => Math.max(...readings(from, to).map((r) => Math.abs(r - to)));

/** Probability that a sample taken in the middle of the change is garbage, each changing bit having arrived with probability 1/2. */
export function pGarbage(from: number, to: number): number {
  const h = bitsOf(from ^ to);
  return h <= 1 ? 0 : 1 - 2 ** (1 - h);
}

export interface BusRow {
  from: number; to: number;
  /** Bits that change, readings, garbage, worst error, chance of garbage. */
  flips: number; reads: number; bad: number; err: number; p: number;
}

/** One row per step of an n-bit counter (wrapping), as the bus carries it: `code` is the identity (binary) or toGray. */
export function table(n: number, code: 'binary' | 'gray'): BusRow[] {
  const f = code === 'gray' ? toGray : (x: number) => x;
  return Array.from({ length: 2 ** n }, (_, v) => {
    const from = f(v), to = f((v + 1) % 2 ** n);
    return { from, to, flips: bitsOf(from ^ to), reads: readings(from, to).length, bad: garbage(from, to).length, err: worstError(from, to), p: pGarbage(from, to) };
  });
}

/** Mean chance that a mid-change sample of an n-bit counter is garbage. */
export const meanGarbage = (n: number, code: 'binary' | 'gray'): number => table(n, code).reduce((a, r) => a + r.p, 0) / 2 ** n;
