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

// ---------------------------------------------------------------------------------------------------------------------
// Uneven twist, real lays, a neighbour pair, and stock coax cables

/** Deterministic pseudo-random in [-1, 1) for loop k (a fixed sequence: the drawing and the readouts must agree). */
const jitter = (k: number): number => { const s = Math.sin((k + 1) * 12.9898 + 78.233) * 43758.5453; return 2 * (s - Math.floor(s)) - 1; };

/** Each loop's share of the run (they sum to 1): equal for `uneven` = 0, else loop k is 1 + uneven · jitter(k) before normalising. */
export function loopFractions(halfTwists: number, uneven = 0): number[] {
  const n = loopCount(halfTwists), w = Array.from({ length: n }, (_, k) => 1 + uneven * jitter(k)), s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
}

/** Cumulative loop boundaries 0 … 1 (n + 2 entries): the twist points. */
export const loopEdges = (halfTwists: number, uneven = 0): number[] => loopFractions(halfTwists, uneven).reduce<number[]>((a, f) => (a.push(a[a.length - 1] + f), a), [0]);

/** As pairLoops, with loops of unequal length (the area of a loop is spacing × its length). */
export function unevenLoops(halfTwists: number, spacing: number, len: number, dBdt: number, uneven: number): number[] {
  return loopFractions(halfTwists, uneven).map((f, k) => (k % 2 === 0 ? 1 : -1) * loopEmf(spacing, len * f, dBdt));
}

/** Twist length (one full turn, mm) of two pairs in one sheath, EP1058275 (Lucent) preferred values 0.440 in and 0.596 in. Examples: no standard sets lays. */
export const INCH_MM = 25.4;
export const LAY_A_MM = 0.44 * INCH_MM, LAY_B_MM = 0.596 * INCH_MM;
/** Half twists per metre of a pair whose full turn is `layMm` long. */
export const halfTwistsPerMetre = (layMm: number): number => 2000 / layMm;
/** The neighbour's half twists for the same run when its lay is LAY_B against this pair's LAY_A. */
export const neighbourHalfTwists = (halfTwists: number): number => Math.max(0, Math.round((loopCount(halfTwists) * LAY_A_MM) / LAY_B_MM) - 1);

/** Pair-to-pair coupling in this model: |mean of s1 · s2| over the run, s = ±1 the sign of the loop there, in phase at one end. Equal lays: 1. A teaching estimate of meshing, not a NEXT figure. */
export function neighbourCoupling(e1: readonly number[], e2: readonly number[]): number {
  const cuts = [...new Set([...e1, ...e2])].sort((a, b) => a - b), at = (e: readonly number[], x: number) => { let k = 0; while (k < e.length - 2 && x >= e[k + 1]) k++; return k % 2 === 0 ? 1 : -1; };
  let sum = 0;
  for (let i = 1; i < cuts.length; i++) { const m = (cuts[i - 1] + cuts[i]) / 2; sum += (cuts[i] - cuts[i - 1]) * at(e1, m) * at(e2, m); }
  return Math.abs(sum);
}

/** dB/dt (T / s) of a sinusoidal field of peak `tesla` at `hz`: 2π f B. */
export const fieldRate = (tesla: number, hz: number): number => 2 * Math.PI * hz * tesla;

export type Dielectric = 'pe' | 'foam' | 'ptfe';
/** εr: solid PE 2.3 (Belden 8240 / 8241 list VP 66 %: 1 / 0.66² = 2.30), foam PE 1.5 (1694A VP 82 %: 1.49), PTFE ≈ 2.1 (a tabulated handbook value, not from a datasheet fetched here). */
export const DIELECTRICS: Record<Dielectric, { name: string; er: number }> = {
  pe: { name: 'solid PE', er: 2.3 }, foam: { name: 'foam PE', er: 1.5 }, ptfe: { name: 'PTFE', er: 2.1 },
};
export interface CoaxPreset { id: string; name: string; sheet: string; D: number; d: number; jacket: number; dielectric: Dielectric; z0: number; core: string }
/** Dimensions (mm) and nominal impedance from the Belden datasheets: 8240 (RG-58A/U type), 8241 (RG-59/U type), 1694A (RG-6 type; the Argosy sheet of 1694ANH quotes the same insulation and conductor). */
export const COAX_PRESETS: CoaxPreset[] = [
  { id: 'rg58', name: 'RG-58', sheet: 'Belden 8240', D: 2.9464, d: 0.8382, jacket: 4.902, dielectric: 'pe', z0: 52, core: '20 AWG solid copper' },
  { id: 'rg59', name: 'RG-59', sheet: 'Belden 8241', D: 3.7084, d: 0.584, jacket: 6.096, dielectric: 'pe', z0: 75, core: '23 AWG copper-covered steel' },
  { id: 'rg6', name: 'RG-6', sheet: 'Belden 1694A', D: 4.57, d: 1.02, jacket: 6.96, dielectric: 'foam', z0: 75, core: '18 AWG solid copper' },
];
