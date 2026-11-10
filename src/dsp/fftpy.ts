// The FFT as software (chapter "Measuring a spectrum", its last steps; the DSP core's comparison): Cooley–Tukey in the Python subset of
// chapter "From Python to gates", fixed point (Q15 twiddles, a rounding at each product pair, no scaling between stages: the arithmetic of
// the DSP core's FFT and of scripts/dsp/oracle.py), compiled for RV32IM. The FFT hardware itself is chapter "carriers"'.
//
// Variants, each a program source for N points:
//   dft   the direct transform, N² complex products: the baseline
//   rec   recursive radix-2 decimation in time over offsets and strides into global lists (the subset's lists are global)
//   iter  iterative and in place: the input bit-reversed by swaps, log2 N stages of butterflies
//   fast  radix 4, digit-reversed input, twiddles loaded once per k (not per butterfly), the k = 0 butterflies without multiplies
//   real  N real samples as N/2 complex ones (even samples real, odd imaginary), an N/2-point FFT, then one pass to split the halves
// rec and iter compute the DSP core's FFT bit for bit; fast and real round elsewhere and are held to a float DFT (tests/fft-software.test.ts).
// No DOM.

/** The oracle's Q15 twiddle (scripts/dsp/oracle.py q15(…, 32767)): round(c · 32767), clamped to [−32767, 32766]; so cos 0 is 32766. */
export const q15w = (c: number): number => Math.max(-32767, Math.min(32766, Math.round(c * 32767)));
/** W_N^k = wr + j·wi, wi = −sin, for k < count. */
export function twiddles(N: number, count = N / 2): { wr: number[]; wi: number[] } {
  const wr: number[] = [], wi: number[] = [];
  for (let k = 0; k < count; k++) { wr.push(q15w(Math.cos((2 * Math.PI * k) / N))); wi.push(q15w(-Math.sin((2 * Math.PI * k) / N))); }
  return { wr, wi };
}

export type FftVariant = 'dft' | 'rec' | 'iter' | 'fast' | 'real';
export const FFT_VARIANTS: FftVariant[] = ['dft', 'rec', 'iter', 'fast', 'real'];

export interface FftProgram {
  variant: FftVariant;
  N: number;
  source: string;
  /** The lists holding the result after the run, real and imaginary parts (bins 0 … N − 1; real: 0 … N/2). */
  out: { re: string; im: string; bins: number };
  /** The transform's Python lines, first and last (1-based): after the data, before the prints. */
  kernel: [number, number];
}

const list = (xs: readonly number[]) => `[${xs.join(', ')}]`;
/** The kernel's lines of a source whose data ends at its first blank line and whose last three lines print. */
const kernelOf = (src: string): [number, number] => { const L = src.split('\n'); return [L.indexOf('') + 2, L.length - 4]; };
const log2 = (n: number) => Math.round(Math.log2(n));

/**
 * One program. re / im: the input (for 'real', re alone, N samples). show: how many bins it prints at the end (real part, then imaginary),
 * so the output region stays small; the whole result is in the lists for the tests and the memory view.
 */
export function fftProgram(variant: FftVariant, N: number, re: readonly number[], im: readonly number[], show = 4): FftProgram {
  const head = (lines: string[]) => lines.join('\n') + '\n';
  const printBins = (r: string, i: string) => `for k in range(${show}):\n    print(${r}[k])\n    print(${i}[k])\n`;
  if (variant === 'dft') {
    const { wr, wi } = twiddles(N, N);
    const source = head([
      `N = ${N}`, `xr = ${list(re)}`, `xi = ${list(im)}`, `wr = ${list(wr)}`, `wi = ${list(wi)}`, `yr = [0] * ${N}`, `yi = [0] * ${N}`, '',
      '# X[k] = sum of x[n] W^(kn): N products for each of N bins',
      'for k in range(N):',
      '    sr = 0',
      '    si = 0',
      '    w = 0',
      '    for n in range(N):',
      '        sr += xr[n] * wr[w] - xi[n] * wi[w]',
      '        si += xr[n] * wi[w] + xi[n] * wr[w]',
      `        w = (w + k) & ${N - 1}`,
      '    yr[k] = (sr + 16384) >> 15',
      '    yi[k] = (si + 16384) >> 15',
    ]) + printBins('yr', 'yi');
    return { variant, N, source, out: { re: 'yr', im: 'yi', bins: N }, kernel: kernelOf(source) };
  }
  if (variant === 'rec') {
    const { wr, wi } = twiddles(N);
    const source = head([
      `N = ${N}`, `xr = ${list(re)}`, `xi = ${list(im)}`, `wr = ${list(wr)}`, `wi = ${list(wi)}`, `yr = [0] * ${N}`, `yi = [0] * ${N}`, '',
      '# n points of x from i, every s-th, transformed into y from o',
      'def fft(o, i, n, s):',
      '    if n == 1:',
      '        yr[o] = xr[i]',
      '        yi[o] = xi[i]',
      '        return',
      '    h = n // 2',
      '    fft(o, i, h, s + s)          # the even samples',
      '    fft(o + h, i + s, h, s + s)  # the odd samples',
      '    w = 0',
      '    for p in range(o, o + h):',
      '        q = p + h',
      '        tr = (yr[q] * wr[w] - yi[q] * wi[w] + 16384) >> 15',
      '        ti = (yr[q] * wi[w] + yi[q] * wr[w] + 16384) >> 15',
      '        yr[q] = yr[p] - tr',
      '        yi[q] = yi[p] - ti',
      '        yr[p] += tr',
      '        yi[p] += ti',
      '        w += s',
      '',
      'fft(0, 0, N, 1)',
    ]) + printBins('yr', 'yi');
    return { variant, N, source, out: { re: 'yr', im: 'yi', bins: N }, kernel: kernelOf(source) };
  }
  if (variant === 'iter') {
    const { wr, wi } = twiddles(N);
    const source = head([
      `N = ${N}`, `xr = ${list(re)}`, `xi = ${list(im)}`, `wr = ${list(wr)}`, `wi = ${list(wi)}`, '',
      '# bit reversal: swap x[i] and x[j], j = i with its bits in reverse order',
      'j = 0',
      'for i in range(N - 1):',
      '    if i < j:',
      '        t = xr[i]',
      '        xr[i] = xr[j]',
      '        xr[j] = t',
      '        t = xi[i]',
      '        xi[i] = xi[j]',
      '        xi[j] = t',
      '    k = N // 2',
      '    while k <= j:',
      '        j -= k',
      '        k = k // 2',
      '    j += k',
      '# stages: butterflies h apart, twiddle stride s',
      'h = 1',
      's = N // 2',
      'while h < N:',
      '    g = 0',
      '    while g < N:',
      '        for k in range(h):',
      '            p = g + k',
      '            q = p + h',
      '            w = k * s',
      '            tr = (xr[q] * wr[w] - xi[q] * wi[w] + 16384) >> 15',
      '            ti = (xr[q] * wi[w] + xi[q] * wr[w] + 16384) >> 15',
      '            ar = xr[p]',
      '            ai = xi[p]',
      '            xr[p] = ar + tr',
      '            xi[p] = ai + ti',
      '            xr[q] = ar - tr',
      '            xi[q] = ai - ti',
      '        g += h + h',
      '    h += h',
      '    s = s // 2',
    ]) + printBins('xr', 'xi');
    return { variant, N, source, out: { re: 'xr', im: 'xi', bins: N }, kernel: kernelOf(source) };
  }
  if (variant === 'fast') {
    if (log2(N) % 2) throw new Error('radix 4 needs N a power of 4');
    const { wr, wi } = twiddles(N, (3 * N) / 4);
    const digits = log2(N) / 2;
    const source = head([
      `N = ${N}`, `xr = ${list(re)}`, `xi = ${list(im)}`, `wr = ${list(wr)}`, `wi = ${list(wi)}`, '',
      '# digit reversal: the base-4 digits of i in reverse order',
      'for i in range(N):',
      '    j = 0',
      '    v = i',
      `    for d in range(${digits}):`,
      '        j = (j << 2) | (v & 3)',
      '        v = v >> 2',
      '    if i < j:',
      '        t = xr[i]',
      '        xr[i] = xr[j]',
      '        xr[j] = t',
      '        t = xi[i]',
      '        xi[i] = xi[j]',
      '        xi[j] = t',
      '# radix-4 stages: four points q apart, twiddles W^k, W^2k, W^3k loaded once per k',
      'q = 1',
      's = N // 4',
      'while q < N:',
      '    for k in range(q):',
      '        w = k * s',
      '        c1 = wr[w]',
      '        s1 = wi[w]',
      '        c2 = wr[w + w]',
      '        s2 = wi[w + w]',
      '        c3 = wr[w + w + w]',
      '        s3 = wi[w + w + w]',
      '        p = k',
      '        while p < N:',
      '            a = p + q',
      '            b = a + q',
      '            c = b + q',
      '            if k == 0:',
      '                br = xr[a]',
      '                bi = xi[a]',
      '                dr = xr[b]',
      '                di = xi[b]',
      '                er = xr[c]',
      '                ei = xi[c]',
      '            else:',
      '                br = (xr[a] * c1 - xi[a] * s1 + 16384) >> 15',
      '                bi = (xr[a] * s1 + xi[a] * c1 + 16384) >> 15',
      '                dr = (xr[b] * c2 - xi[b] * s2 + 16384) >> 15',
      '                di = (xr[b] * s2 + xi[b] * c2 + 16384) >> 15',
      '                er = (xr[c] * c3 - xi[c] * s3 + 16384) >> 15',
      '                ei = (xr[c] * s3 + xi[c] * c3 + 16384) >> 15',
      '            ur = xr[p] + dr',
      '            ui = xi[p] + di',
      '            vr = xr[p] - dr',
      '            vi = xi[p] - di',
      '            fr = br + er',
      '            fi = bi + ei',
      '            gr = br - er',
      '            gi = bi - ei',
      '            xr[p] = ur + fr',
      '            xi[p] = ui + fi',
      '            xr[a] = vr + gi',
      '            xi[a] = vi - gr',
      '            xr[b] = ur - fr',
      '            xi[b] = ui - fi',
      '            xr[c] = vr - gi',
      '            xi[c] = vi + gr',
      '            p += q + q + q + q',
      '    q = q << 2',
      '    s = s >> 2',
    ]) + printBins('xr', 'xi');
    return { variant, N, source, out: { re: 'xr', im: 'xi', bins: N }, kernel: kernelOf(source) };
  }
  // real: z[m] = x[2m] + j x[2m + 1], an M = N/2 point FFT (iterative, as above), then
  // X[k] = (Z[k] + Z*[M − k]) / 2 + W_N^k (Z[k] − Z*[M − k]) / 2j, for k = 0 … M
  const M = N / 2, { wr, wi } = twiddles(N);
  const zr = Array.from({ length: M }, (_, m) => re[2 * m]), zi = Array.from({ length: M }, (_, m) => re[2 * m + 1]);
  const source = head([
    `N = ${N}`, `M = ${M}`, `xr = ${list(zr)}`, `xi = ${list(zi)}`, `wr = ${list(wr)}`, `wi = ${list(wi)}`, `yr = [0] * ${M + 1}`, `yi = [0] * ${M + 1}`, '',
    '# the even samples as the real part, the odd ones as the imaginary: an M-point FFT does the work of N',
    'j = 0',
    'for i in range(M - 1):',
    '    if i < j:',
    '        t = xr[i]',
    '        xr[i] = xr[j]',
    '        xr[j] = t',
    '        t = xi[i]',
    '        xi[i] = xi[j]',
    '        xi[j] = t',
    '    k = M // 2',
    '    while k <= j:',
    '        j -= k',
    '        k = k // 2',
    '    j += k',
    'h = 1',
    's = N // 4',
    'while h < M:',
    '    g = 0',
    '    while g < M:',
    '        for k in range(h):',
    '            p = g + k',
    '            q = p + h',
    '            w = (k * s) << 1',
    '            tr = (xr[q] * wr[w] - xi[q] * wi[w] + 16384) >> 15',
    '            ti = (xr[q] * wi[w] + xi[q] * wr[w] + 16384) >> 15',
    '            ar = xr[p]',
    '            ai = xi[p]',
    '            xr[p] = ar + tr',
    '            xi[p] = ai + ti',
    '            xr[q] = ar - tr',
    '            xi[q] = ai - ti',
    '        g += h + h',
    '    h += h',
    '    s = s // 2',
    '# split: E = (Z[k] + Z*[M-k]) / 2 is the even samples\' spectrum, O = (Z[k] - Z*[M-k]) / 2j the odd ones\'',
    'yr[0] = xr[0] + xi[0]',
    'yr[M] = xr[0] - xi[0]',
    'for k in range(1, M):',
    '    m = M - k',
    '    er = (xr[k] + xr[m]) >> 1',
    '    ei = (xi[k] - xi[m]) >> 1',
    '    orr = (xi[k] + xi[m]) >> 1',
    '    oi = (xr[m] - xr[k]) >> 1',
    '    yr[k] = er + ((orr * wr[k] - oi * wi[k] + 16384) >> 15)',
    '    yi[k] = ei + ((orr * wi[k] + oi * wr[k] + 16384) >> 15)',
  ]) + printBins('yr', 'yi');
  return { variant, N, source, out: { re: 'yr', im: 'yi', bins: M + 1 }, kernel: kernelOf(source) };
}

/** The exact DFT in floating point: the reference every variant's error is measured against. */
export function dftFloat(re: readonly number[], im: readonly number[]): { re: number[]; im: number[] } {
  const N = re.length, yr: number[] = [], yi: number[] = [];
  for (let k = 0; k < N; k++) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) {
      const a = (-2 * Math.PI * ((k * n) % N)) / N;
      sr += re[n] * Math.cos(a) - im[n] * Math.sin(a);
      si += re[n] * Math.sin(a) + im[n] * Math.cos(a);
    }
    yr.push(sr); yi.push(si);
  }
  return { re: yr, im: yi };
}

/** The sizes measured: 16 points live on the chapter's stage, 64 the DSP core's FFT. */
export const FFT_SIZES = [16, 64] as const;

export interface FftCase {
  program: FftProgram;
  /** The input the float reference transforms (for 'real': re with a zero imaginary part). */
  re: number[];
  im: number[];
  /** The pipelined CPU's ROM and data memory (2^k words) that hold it. */
  imemK: number;
  dmemK: number;
}

/** A variant on the DSP core's test signal (its first N samples): the program and the memories it needs. */
export function fftCase(v: FftVariant, N: number, data: { re: readonly number[]; im: readonly number[] }): FftCase {
  const re = data.re.slice(0, N), im = v === 'real' ? re.map(() => 0) : data.im.slice(0, N);
  const program = fftProgram(v, N, re, v === 'real' ? [] : im);
  return { program, re, im, imemK: N <= 16 ? 9 : 10, dmemK: N <= 16 ? 8 : 9 };
}

/** A short hash of a program's text (FNV-1a), so the measured costs are known to belong to it. */
export function sourceHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
