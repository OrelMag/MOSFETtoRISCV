// What a switching network costs, and how often it is busy (chapter exchange). DOM-free.

/** Wires of a full mesh of n telephones. */
export const meshWires = (n: number): number => (n * (n - 1)) / 2;
/** Crosspoints of a square crossbar: n callers by n called lines. */
export const crossbarCrosspoints = (n: number): number => n * n;
/** Crosspoints of a folded crossbar: one for each pair of lines. */
export const foldedCrosspoints = meshWires;

export interface Clos { N: number; n: number; r: number; m: number; crosspoints: number; strict: boolean; rearrangeable: boolean }

/** Three-stage Clos network: r input switches (n × m), m middle switches (r × r), r output switches (m × n); N = n·r inputs. */
export function clos(N: number, n: number, m: number): Clos | null {
  if (n < 1 || m < 1 || N % n !== 0) return null;
  const r = N / n;
  return { N, n, r, m, crosspoints: 2 * r * n * m + m * r * r, strict: m >= 2 * n - 1, rearrangeable: m >= n };
}

/** The cheapest strictly non-blocking Clos (m = 2n − 1) over every n dividing N. */
export function bestClos(N: number): Clos {
  let best: Clos | null = null;
  for (let n = 1; n <= N; n++) {
    if (N % n) continue;
    const c = clos(N, n, 2 * n - 1)!;
    if (!best || c.crosspoints < best.crosspoints) best = c;
  }
  return best!;
}

/** Erlang B: probability a call is blocked when traffic of `erlangs` is offered to m trunks that have no queue. */
export function erlangB(erlangs: number, m: number): number {
  let b = 1;
  for (let k = 1; k <= m; k++) b = (erlangs * b) / (k + erlangs * b);
  return b;
}

/** Fewest trunks whose blocking is at most `target`. */
export function trunksFor(erlangs: number, target: number): number {
  let m = 0;
  while (erlangB(erlangs, m) > target) m++;
  return m;
}

/** Traffic (Erlangs) m trunks carry at blocking `target`, found by bisection. */
export function capacityAt(m: number, target: number): number {
  let lo = 0, hi = m * 4 + 10;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (erlangB(mid, m) > target) hi = mid; else lo = mid; }
  return lo;
}

/** Offered traffic (Erlangs) of n subscribers each placing `callsPerHour` calls of `holdMin` minutes. */
export const offered = (n: number, callsPerHour: number, holdMin: number): number => (n * callsPerHour * holdMin) / 60;
