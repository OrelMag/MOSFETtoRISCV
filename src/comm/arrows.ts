// Complex numbers as arrows (DOM-free): the arithmetic behind chapter signals' step "Arrows that turn". Every length and angle the prose
// and the widget quote comes from here (tests/comm-arrows.test.ts); the DFT bin is built term by term and equals comm/fourier.ts's dft.

/** An arrow from zero to the point (re, im): the complex number re + j·im. */
export interface Arrow { re: number; im: number }

export const arrow = (re: number, im = 0): Arrow => ({ re, im });
export const plus = (a: Arrow, b: Arrow): Arrow => ({ re: a.re + b.re, im: a.im + b.im });
/** (a + jb)(c + jd) = (ac − bd) + j(ad + bc): four multiplications and two additions. */
export const times = (a: Arrow, b: Arrow): Arrow => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
export const scale = (a: Arrow, k: number): Arrow => ({ re: a.re * k, im: a.im * k });
export const lengthOf = (a: Arrow): number => Math.hypot(a.re, a.im);
/** The angle in degrees, anticlockwise from the real axis: atan2(b, a). */
export const angleOf = (a: Arrow): number => (Math.atan2(a.im, a.re) * 180) / Math.PI;
/** The arrow of length 1 at angle θ radians: cos θ + j sin θ, written e^(jθ). */
export const expj = (theta: number): Arrow => ({ re: Math.cos(theta), im: Math.sin(theta) });
/** The arrow of a length and an angle in degrees. */
export const polar = (len: number, deg: number): Arrow => scale(expj((deg * Math.PI) / 180), len);

export interface Product { z: Arrow; w: Arrow; p: Arrow; lengths: [number, number, number]; angles: [number, number, number] }

/** z × w with the three lengths and angles: the lengths multiply and the angles add. */
export function product(z: Arrow, w: Arrow): Product {
  const p = times(z, w);
  return { z, w, p, lengths: [lengthOf(z), lengthOf(w), lengthOf(p)], angles: [angleOf(z), angleOf(w), angleOf(p)] };
}

export interface CosinePair { plus: Arrow; minus: Arrow; sum: Arrow }

/** cos θ = (e^(jθ) + e^(−jθ)) / 2: two arrows of length ½ turning opposite ways; their sum stays on the real axis. */
export function cosinePair(theta: number): CosinePair {
  const a = scale(expj(theta), 0.5), b = scale(expj(-theta), 0.5);
  return { plus: a, minus: b, sum: plus(a, b) };
}

export interface Bin {
  k: number; N: number;
  /** x[n] e^(−j2πkn/N), one arrow a sample. */
  terms: Arrow[];
  /** The running total head to tail: partial[0] = 0, partial[N] = the bin. */
  partial: Arrow[];
  total: Arrow;
  /** |X[k]|: the amplitude of a cosine at k is this over N / 2. */
  length: number;
  /** length ÷ (N / 2): the amplitude the spectrum view reads off. */
  amplitude: number;
  /** The angle of the total in degrees: the phase of the cosine A cos(2πkn/N + φ). */
  phase: number;
}

/** Bin k of a real block by its definition, X[k] = Σ x[n] e^(−j2πkn/N), with every partial sum kept. */
export function binChain(x: readonly number[], k: number): Bin {
  const N = x.length, terms: Arrow[] = [], partial: Arrow[] = [arrow(0)];
  let acc = arrow(0);
  for (let n = 0; n < N; n++) {
    const t = scale(expj((-2 * Math.PI * k * n) / N), x[n]);
    terms.push(t);
    acc = plus(acc, t);
    partial.push(acc);
  }
  const length = lengthOf(acc);
  return { k, N, terms, partial, total: acc, length, amplitude: length / (N / 2), phase: angleOf(acc) };
}
