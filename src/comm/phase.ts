// Where a sender's edges land relative to a receiver's clock, DOM-free. Clock A launches data every 1/fa, clock B
// samples every 1/fb. With related clocks the phase of A's edge inside B's period repeats after a few edges, and a
// timing tool checks every one of them; with unrelated clocks every phase occurs, so sooner or later a change lands in
// the window around B's edge.

/** Phase of A's n-th edge inside B's period, in [0, 1): 0 is B's rising edge. `offset` is A's first edge, as a fraction of B's period. */
export const phaseOf = (n: number, fa: number, fb: number, offset = 0): number => {
  const p = ((n / fa) * fb + offset) % 1;
  return p < 0 ? p + 1 : p;
};

/** Is a phase within the window around B's edge: `before` of a period before it, `after` of a period after (setup, hold)? */
export const inWindow = (phase: number, before: number, after: number): boolean => phase >= 1 - before || phase < after;

export interface Landings {
  phases: number[];
  hits: number;
  /** Distinct phases (to 1e-6) among them: related clocks have few. */
  distinct: number;
}

export function landings(fa: number, fb: number, n: number, before: number, after: number, offset = 0): Landings {
  const phases = Array.from({ length: n }, (_, i) => phaseOf(i, fa, fb, offset));
  return {
    phases, hits: phases.filter((p) => inWindow(p, before, after)).length,
    distinct: new Set(phases.map((p) => Math.round(p * 1e6) % 1e6)).size,
  };
}

/** The expected fraction of edges that land in the window when every phase is equally likely. */
export const windowFraction = (before: number, after: number): number => before + after;

/** The ratio fa / fb as a reduced fraction p / q when it is (to two decimals) a ratio of small integers; else null. */
export function reduce(ratio: number, den = 100): [number, number] {
  const a = Math.round(ratio * den), g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  const d = g(a, den);
  return [a / d, den / d];
}
