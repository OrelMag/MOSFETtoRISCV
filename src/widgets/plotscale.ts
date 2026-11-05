// The x axis of widgets/line.ts's plots (DOM-free): where a value lands, and which ticks it gets. A range starts wherever it is given, below 0 as well.

/** A value's position, for an axis from `lo` to `hi` drawn between pixels `a` and `b`. */
export const axisX = (v: number, lo: number, hi: number, a: number, b: number): number => a + ((v - lo) / (hi - lo)) * (b - a);

/** A "nice" tick step (1, 2, 5 × 10^k) giving about n ticks across a span. */
export function tickStep(span: number, n = 4): number {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

/** The ticks of [lo, hi], at multiples of the step. */
export function axisTicks(lo: number, hi: number): { step: number; ticks: number[] } {
  const step = tickStep(hi - lo), ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step + 0; v <= lo + (hi - lo) * 1.0001; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { step, ticks };
}
