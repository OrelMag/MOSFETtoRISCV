// Why a pair is twisted, and what a coax is (DOM-free). A neighbour's changing field threads the loop a pair makes with its
// load and induces dΦ/dt = A · dB/dt in it (Faraday). Each half twist swaps the two conductors, which turns the loop over
// and flips its sign. Assumption, and the reason the cancellation is exact here: the field is uniform along the pair, so
// every loop of the same area picks up the same magnitude. Real fields fall off along the cable and real twists are
// uneven, which is why a pair cancels most of the noise, not all of it. Units: SI.

export const MU0 = 4e-7 * Math.PI;
export const EPS0 = 8.854187817e-12;

/** Loops a pair makes with n half twists: the twist points split the run into n + 1 pieces. */
export const loopCount = (halfTwists: number): number => Math.max(0, Math.round(halfTwists)) + 1;

/** EMF (V) induced in one loop of conductor spacing `spacing` (m) and length `len` (m) by a field changing at `dBdt` (T / s). */
export const loopEmf = (spacing: number, len: number, dBdt: number): number => spacing * len * dBdt;

/** The signed EMF of each loop along a run of `len` metres with n half twists: equal areas, alternating sign, the first positive. */
export function pairLoops(halfTwists: number, spacing: number, len: number, dBdt: number): number[] {
  const n = loopCount(halfTwists), e = loopEmf(spacing, len / n, dBdt);
  return Array.from({ length: n }, (_, k) => (k % 2 === 0 ? e : -e));
}

/** The running sum after each loop; the last entry is what reaches the receiver. */
export const runningSum = (loops: readonly number[]): number[] => loops.reduce<number[]>((a, e) => (a.push((a.at(-1) ?? 0) + e), a), []);

/** What the pair delivers: zero for an odd number of half twists, one loop's worth for an even number. */
export const pairPickup = (halfTwists: number, spacing: number, len: number, dBdt: number): number =>
  runningSum(pairLoops(halfTwists, spacing, len, dBdt)).at(-1) ?? 0;

/** A coax of outer inner-diameter D and centre-conductor diameter d (same unit), dielectric εr: L (nH / m) and C (pF / m) for phys/line.ts's z0Of. */
export function coaxLC(D: number, d: number, er: number): { l: number; c: number } {
  const ln = Math.log(D / d);
  return { l: ((MU0 / (2 * Math.PI)) * ln) * 1e9, c: ((2 * Math.PI * EPS0 * er) / ln) * 1e12 };
}

/** The closed form: Z0 = 60 / √εr · ln(D / d) (Ω). */
export const coaxZ0 = (D: number, d: number, er: number): number => (60 / Math.sqrt(er)) * Math.log(D / d);
