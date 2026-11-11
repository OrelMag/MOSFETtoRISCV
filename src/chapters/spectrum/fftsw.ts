// "Measuring a spectrum", the last steps: the FFT as software. The programs are dsp/fftpy.ts, run here on the gate-level pipelined RV32IM through
// pyScene (16 points, on the cycle engine); every figure is src/dsp/fftcosts.json (scripts/fft-costs.ts: the gates, cycle by cycle), held to
// the programs by tests/fft-software.test.ts. The FFT in hardware is chapter "carriers"'; this one is code.

import costs from '../../dsp/fftcosts.json';
import { FFT_DATA } from '../../dsp/bench24data';
import { fftCase, type FftVariant } from '../../dsp/fftpy';
import { groupNum } from '../../sim/numfmt';
import { pyScene } from '../../widgets/python';
import { numOf } from '../order';
import type { Step } from '../types';

type Cost = { cycles: number; kernel: number; kernelInstrs: number; instrs: number; maxErr: number; perLine: [number, number, number][]; words: number };
const C = costs as unknown as Record<string, Cost>;
export const fftCost = (v: FftVariant, N: number): Cost => C[`${v}${N}`];
const n0 = (x: number) => groupNum(x);
const x1 = (a: number, b: number) => (a / b).toFixed(1);

/** Clocks of the kernel lines between two comment markers of a variant's source (the marker lines themselves cost nothing). */
export function partClocks(v: FftVariant, N: number, from: string, to: string): number {
  const L = fftCase(v, N, FFT_DATA).program.source.split('\n');
  const a = L.findIndex((l) => l.startsWith(from)) + 1, b = L.findIndex((l) => l.startsWith(to)) + 1;
  return fftCost(v, N).perLine.filter(([l]) => l > a && l < b).reduce((s, [, c]) => s + c, 0);
}

/** Clocks of the kernel lines whose text (indent dropped) starts with a prefix. */
export function lineClocks(v: FftVariant, N: number, prefix: string): number {
  const L = fftCase(v, N, FFT_DATA).program.source.split('\n');
  return fftCost(v, N).perLine.filter(([l]) => L[l - 1]?.trim().startsWith(prefix)).reduce((s, [, c]) => s + c, 0);
}

/** The radix-4 program's butterflies, and those at k = 0 (every twiddle 1), for N points. */
export function radix4Butterflies(N: number): { all: number; trivial: number } {
  let all = 0, trivial = 0;
  for (let q = 1; q < N; q *= 4) { all += N / 4; trivial += N / (4 * q); }
  return { all, trivial };
}

/** Real multiplications each variant makes (the products the compiler turns into mul). */
export function fftMults(v: FftVariant, N: number): number {
  const lg = Math.log2(N);
  if (v === 'dft') return 4 * N * N;
  if (v === 'rec' || v === 'iter') return 4 * (N / 2) * lg;
  if (v === 'real') return 4 * (N / 4) * (lg - 1) + 4 * (N / 2 - 1);
  let m = 0;
  for (let q = 1; q < N; q *= 4) for (let k = 1; k < q; k++) m += 12 * (N / (4 * q));
  return m;
}

const scene = (v: FftVariant) => () => pyScene(fftCase(v, 16, FFT_DATA).program.source, { pipeline: true, m: true, switch: false, mem: { imemK: 9, dmemK: 8 } });

const table = () => {
  const rows: [FftVariant, string][] = [['dft', 'direct DFT'], ['rec', 'recursive radix 2'], ['iter', 'in place, radix 2'], ['fast', 'radix 4, twiddles hoisted'], ['real', 'real input, N/2-point FFT']];
  return `<table class="mini"><tr><th>program</th><th>products, 64 points</th><th>clocks, 16</th><th>clocks, 64</th><th>clocks a point, 64</th><th>largest error, 64</th></tr>${rows.map(([v, name]) =>
    `<tr><td>${name}</td><td>${n0(fftMults(v, 64))}</td><td>${n0(fftCost(v, 16).kernel)}</td><td>${n0(fftCost(v, 64).kernel)}</td><td>${(fftCost(v, 64).kernel / 64).toFixed(0)}</td><td>${fftCost(v, 64).maxErr.toFixed(2)}</td></tr>`).join('')}</table>`;
};

export const FFT_SW_STEPS: Step[] = [
  {
    title: 'The FFT as a program',
    get body() {
      const d16 = fftCost('dft', 16), r16 = fftCost('rec', 16), d64 = fftCost('dft', 64), r64 = fftCost('rec', 64);
      return `
        <p>Every spectrum so far was computed for you. Here the transform runs as a program: Python in the subset of chapter ${numOf('python')}, compiled for RV32IM and run on the gate-level pipelined CPU of chapter ${numOf('pipeline')} with the multiplier of chapter ${numOf('muldiv')}. The butterfly is the one <a href="#/c/carriers/2">chapter ${numOf('carriers')}</a> built in gates; here it is four multiplications, six additions and two roundings of code.</p>
        <p>Cooley and Tukey's step splits N samples into the even ones and the odd ones, transforms each half, and joins them: X[k] = E[k] + W<sup>k</sup>·O[k] and X[k + N/2] = E[k] − W<sup>k</sup>·O[k], with W = e<sup>−2πj/N</sup>. A function that calls itself on each half does it in log₂ N levels. The subset's lists are global, so the function is given places instead of new lists: <code>fft(o, i, n, s)</code> transforms n samples of x, starting at i and taking every s-th, into y from o. The even half is every 2s-th sample from i, the odd half the same from i + s.</p>
        <p>The arithmetic is fixed point, as on a DSP: whole-number samples, twiddles (the constants W<sup>k</sup> a butterfly multiplies by) in Q15 (cos and −sin times 32 767 and clamped to 32 766, as the DSP core's table is, so cos 0 is 32 766, a hair under 1), and each product pair rounded once, <code>(… + 16384) &gt;&gt; 15</code>. Nothing is scaled between stages: these inputs stay within ±${n0(Math.max(...FFT_DATA.re.map(Math.abs), ...FFT_DATA.im.map(Math.abs)))}, so the largest bin fits easily.</p>
        <p>The direct DFT is N² complex products: ${n0(d16.kernel)} clocks for 16 points on this CPU, ${n0(d64.kernel)} for 64. The recursive FFT takes ${n0(r16.kernel)} and ${n0(r64.kernel)}: ${x1(d16.kernel, r16.kernel)} times faster at 16 points, ${x1(d64.kernel, r64.kernel)} times at 64, and the gap keeps growing as N / log₂ N. Its 64-point result is the DSP core's FFT of chapter ${numOf('dspcore')} word for word, the same inputs and the same roundings, and it stays within ${r64.maxErr.toFixed(2)} of the exact transform computed in floating point.</p>
        <div class="try">Press <b>Run to end</b> in the Python panel. The lines computing <code>tr</code> and <code>ti</code> cost the most clocks, with the calls and the function's entry: the line of each call adds the frames, return address and saved registers pushed and popped at every level.</div>`;
    },
    scene: scene('rec'),
    lit: '',
    more: {
      derive: `<p>Counting products: a level of the recursion does N/2 butterflies of 4 real multiplications, and there are log₂ N levels, so 2N log₂ N in all: ${n0(fftMults('rec', 64))} for 64 points against the DFT's 4N² = ${n0(fftMults('dft', 64))}. Clocks fall less than products, because each butterfly also loads, stores, adds and computes indices: ${(fftCost('rec', 64).kernel / (fftMults('rec', 64) / 4)).toFixed(0)} clocks a butterfly here.</p>`,
      pitfall: `<p>Rounding each product on its own, <code>(a·c &gt;&gt; 15) − (b·s &gt;&gt; 15)</code>. Two roundings per output instead of one double the error, and the result no longer matches a DSP that keeps the sum in its accumulator and rounds once.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'Why does fft() take an offset and a stride instead of two new lists for the even and odd samples?',
      options: ['The subset\'s lists are global and fixed in size, so a call names where its samples are', 'Lists would be too slow to copy on any machine', 'A stride makes the transform more accurate', 'The FFT only works on samples a stride apart'],
      answer: 0,
      explain: 'The compiler places every list in data memory once. A recursive call cannot make new ones, so it is told where its half starts and how far apart its samples are: the even half is every 2s-th from i, the odd half every 2s-th from i + s.',
      why: ['', 'Copying costs N words a level, but Python would happily do it; the subset cannot.', 'The arithmetic is the same either way.', 'Any sequence works; the stride is only how this version addresses the halves.'],
    },
  },
  {
    title: 'In place, by loops',
    get body() {
      const r16 = fftCost('rec', 16), i16 = fftCost('iter', 16), r64 = fftCost('rec', 64), i64 = fftCost('iter', 64);
      const br64 = partClocks('iter', 64, '# bit reversal', '# stages');
      return `
        <p>The recursion can be unrolled. Its deepest level pairs samples whose indices differ only in their lowest bit, after the even–odd splits have sorted them: sample i ends up at the position given by i's bits in reverse order. So reorder the input once, by <em>bit reversal</em>, and then run the log₂ N levels as loops from the bottom up, each butterfly writing its results over its inputs. One array, no second list, no calls.</p>
        <p>The bit reversal is a loop of swaps with a counter that adds 1 at the top bit and carries downwards: ${n0(br64)} clocks for 64 points, ${((100 * br64) / i64.kernel).toFixed(0)} % of the transform. The stages are three loops: the distance h between a butterfly's two points doubles each stage, the groups step by 2h, and the twiddle index steps by N / 2h.</p>
        <p>Measured on the gates: ${n0(i16.kernel)} clocks for 16 points against the recursion's ${n0(r16.kernel)}, ${n0(i64.kernel)} against ${n0(r64.kernel)} for 64. The butterflies are the same butterflies with the same roundings, so the result is the same, bit for bit; what went is the calls. What the loops cost instead is the index work in Python, which a DSP does in its addressing hardware as it reads.</p>
        <div class="try">Run it to the end and compare the panel's total with the recursive version's. Then step through the first lines: the swaps happen only where i &lt; j, so each pair is swapped once.</div>`;
    },
    scene: scene('iter'),
    lit: '',
    challenge: {
      kind: 'quiz', question: 'In a 16-point FFT, which sample does bit reversal put at position 1?',
      options: ['Sample 8: 0001 reversed is 1000', 'Sample 1: it stays', 'Sample 15', 'Sample 2: 0001 shifted left'],
      answer: 0,
      explain: 'Position 1 is 0001 in four bits; reversed that is 1000, sample 8. The first split puts the even samples first, the next puts multiples of 4 first, and so on: the low bits end up deciding the high positions.',
      why: ['', 'Only 0, 6, 9 and 15 (0000, 0110, 1001, 1111) stay where they are among 16.', '1111 reversed is itself: sample 15 stays at 15.', 'Reversing is not shifting: shifting 0001 left once gives 0010, reversing all four bits gives 1000.'],
    },
    more: {
      real: `<p>Libraries pick between the two by size. FFTW, the usual library on PCs, generates recursive code for large transforms (the halves fit in the caches) with straight-line "codelets" of 8 to 64 points at the bottom; DSP libraries use the in-place loops, with the reordering done by the processor's addressing hardware.</p>`,
    },
  },
  {
    title: 'Making it fast',
    get body() {
      const i16 = fftCost('iter', 16), f16 = fftCost('fast', 16), i64 = fftCost('iter', 64), f64 = fftCost('fast', 64);
      const b16 = radix4Butterflies(16), k0 = lineClocks('fast', 16, 'if k == 0');
      return `
        <p>Three changes, each removing work the loops did for nothing.</p>
        <p><strong>Radix 4.</strong> Join four quarters at once instead of two halves (the radix is how many parts each step joins). The four outputs need W<sup>k</sup>, W<sup>2k</sup> and W<sup>3k</sup> times three of the inputs, and the rest is multiplication by ±1 and ±j, which only swaps and negates the parts. Three complex products for four points, where two radix-2 stages spend four: ${n0(fftMults('fast', 64))} real multiplications for 64 points against ${n0(fftMults('iter', 64))}. The input is reordered by reversing its base-4 digits.</p>
        <p><strong>Twiddles once per k.</strong> The loops are swapped so that the twiddle index is the outer one: the six table reads happen once per k instead of once per butterfly.</p>
        <p><strong>Trivial twiddles skipped.</strong> At k = 0 every twiddle is 1, and those butterflies multiply nothing.</p>
        <p>Together: ${n0(f16.kernel)} clocks for 16 points against ${n0(i16.kernel)}, and ${n0(f64.kernel)} against ${n0(i64.kernel)} for 64, ${x1(i64.kernel, f64.kernel)} times faster. The result is no longer the DSP core's word for word: skipping k = 0 multiplies by an exact 1 where the table holds 32 766 / 32 768, and the rounding happens at other places. Against the exact transform the largest error is ${f64.maxErr.toFixed(2)}, against ${i64.maxErr.toFixed(2)}.</p>
        <div class="try">Run it and find the line <code>if k == 0:</code> in the panel: at 16 points it costs ${n0(k0)} clocks over ${b16.all} butterflies, about ${(k0 / b16.all).toFixed(0)} each, and saves twelve real multiplications on each of the ${b16.trivial} with k = 0: every butterfly of the first stage and the first of each group after it.</div>`;
    },
    scene: scene('fast'),
    lit: '',
    more: {
      derive: `<p>The radix-4 butterfly: with B<sub>m</sub> = W<sup>mk</sup>·A<sub>m</sub>, u = A<sub>0</sub> + B<sub>2</sub>, v = A<sub>0</sub> − B<sub>2</sub>, f = B<sub>1</sub> + B<sub>3</sub> and g = B<sub>1</sub> − B<sub>3</sub>, the four outputs are u + f, v − j·g, u − f and v + j·g. Multiplying by −j takes (g<sub>r</sub>, g<sub>i</sub>) to (g<sub>i</sub>, −g<sub>r</sub>): no product. Split radix mixes the two (radix 2 for the even outputs, radix 4 for the odd) and needs the fewest multiplications of the power-of-two FFTs, at the price of irregular code.</p>`,
      pitfall: `<p>Counting only multiplications. On this CPU a multiply is one clock in the pipeline like an add, so the radix-4 version gains as much from fewer loads, stores and index sums as from fewer products. The in-place radix-2 kernel's ${n0(fftMults('iter', 64))} multiplications are ${Math.round((100 * fftMults('iter', 64)) / fftCost('iter', 64).kernelInstrs)} % of its ${n0(fftCost('iter', 64).kernelInstrs)} instructions at 64 points, so cutting ${n0(fftMults('iter', 64) - fftMults('fast', 64))} of them moves the total far less than the product count suggests. On a machine without a multiplier, the products would dominate and the gain would be larger.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'A radix-4 butterfly takes four points. How many complex multiplications does it need, and why not four?',
      options: ['Three: the fourth input\'s twiddle is W⁰ = 1, and ±1, ±j only swap and negate', 'Four: one per input', 'Two: it is two radix-2 butterflies', 'None: the twiddles are folded into the table'],
      answer: 0,
      explain: 'A₀ is never multiplied, and the factors between the outputs are powers of j. Two radix-2 stages over the same four points multiply four times.',
      why: ['', 'A₀ multiplies by 1 in every output.', 'Two radix-2 stages are four butterflies over the four points, each with a product.', 'The table holds the twiddles; something still has to multiply by them.'],
    },
  },
  {
    title: 'Real input, half the work',
    get body() {
      const re64 = fftCost('real', 64), i64 = fftCost('iter', 64);
      return `
        <p>A sampled signal is real, and its spectrum mirrors itself: X[N − k] is the conjugate of X[k], so half the outputs are known before computing anything. A complex FFT fed a real block wastes its imaginary inputs and half of its outputs.</p>
        <p>The trick: pack the N real samples into N/2 complex ones, the even samples as the real parts and the odd ones as the imaginary, and run an N/2-point FFT Z. The two halves come apart again by symmetry: the even samples' spectrum is E[k] = (Z[k] + Z*[N/2 − k]) / 2 and the odd ones' is O[k] = (Z[k] − Z*[N/2 − k]) / 2j. One last radix-2 step joins them, X[k] = E[k] + W<sup>k</sup>·O[k], for the N/2 + 1 bins that matter.</p>
        <p>On the 64 real samples of the test signal: ${n0(re64.kernel)} clocks against ${n0(i64.kernel)} for the 64-point complex FFT, ${x1(i64.kernel, re64.kernel)} times faster, and the largest error is ${re64.maxErr.toFixed(2)} (the halving by a shift drops a bit). That is the routine a phone calls for audio.</p>
        <p>All five programs, measured on the gates:</p>
        ${table()}
        <div class="try">Run it and read the last loop's cost: one pass of N/2 iterations that turns a 32-point transform into a 64-point one.</div>`;
    },
    scene: scene('real'),
    lit: '',
    challenge: {
      kind: 'quiz', question: 'A 64-sample real block is packed into 32 complex samples. Which bins of X does the last pass compute, and why not all 64?',
      options: ['0 to 32: the others are the conjugates of these, X[64 − k] = X*[k]', '0 to 63: the pass is a full FFT stage', '0 to 31: bin 32 is always zero', 'Only the even bins: the odd ones need a second FFT'],
      answer: 0,
      explain: 'A real signal\'s spectrum mirrors itself, so 33 bins (0 and 32 real, the rest complex) hold everything; the program computes those.',
      why: ['', 'The other 31 bins carry no new information for a real input.', 'Bin 32, half the sample rate, is real but not zero in general: here it is Z[0]\'s real part minus its imaginary part.', 'Both halves come out of the one 32-point FFT by symmetry.'],
    },
    more: {
      real: `<p>Every FFT library has a real-input entry (FFTW's r2c, numpy's rfft) built this way or with a dedicated real-input algorithm. Audio codecs go further: a codec's transform on every block (the MDCT) is usually computed with an N/4-point complex FFT and a twist before and after. The codec of chapter ${numOf('music')} computes it directly, for clarity.</p>`,
    },
  },
];

/** Instructions (one a clock on the single-cycle RV32IM) of the kernel lines whose text starts with one of the prefixes. */
export function lineInstrs(v: FftVariant, N: number, ...prefixes: string[]): number {
  const L = fftCase(v, N, FFT_DATA).program.source.split('\n');
  return fftCost(v, N).perLine.filter(([l]) => prefixes.some((p) => L[l - 1].trim().startsWith(p))).reduce((s, [, , i]) => s + i, 0);
}

/** Instructions between two comment markers of a variant's source. */
export function partInstrs(v: FftVariant, N: number, from: string, to: string): number {
  const L = fftCase(v, N, FFT_DATA).program.source.split('\n');
  const a = L.findIndex((l) => l.startsWith(from)) + 1, b = L.findIndex((l) => l.startsWith(to)) + 1;
  return fftCost(v, N).perLine.filter(([l]) => l > a && l < b).reduce((s, [, , i]) => s + i, 0);
}
