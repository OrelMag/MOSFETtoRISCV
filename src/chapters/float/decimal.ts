// Chapter float, the last step: decimal text in and out of binary floats. Every digit string in the prose is computed by
// sim/decimal.ts (exact BigInt arithmetic), the same code the explorer runs, and pinned by tests/decimal.test.ts.

import { digitsSurviving, digitsToRoundTrip, exactDecimal, exactSum, parseDecimal, printSig } from '../../sim/decimal';
import { F32, bitsToF32 } from '../../sim/fpref';
import { floatExplorer } from '../../widgets/float';
import type { Step } from '../types';

const f32 = Math.fround;
/** The float32 nearest a decimal text, as a double. */
const near32 = (t: string) => bitsToF32(parseDecimal(t, F32)!);
/** "1.0002529e-36" as "1.0002529 × 10<sup>−36</sup>". */
const sci = (s: string) => s.replace(/e([+-]?)(\d+)/, (_m, sg, d) => ` × 10<sup>${sg === '-' ? '−' : ''}${Number(d)}</sup>`);
/** A float32 whose 8-digit print is shared with the next pattern: both prints at 8 and at 9 digits. */
export const B8 = 0x03aa2f28;
const eight = printSig(bitsToF32(B8), 8), nine = printSig(bitsToF32(B8), 9), nineNext = printSig(bitsToF32(B8 + 1), 9);
/** A 7-digit decimal text that does not survive float32, and what comes back. */
export const T7 = '8.589973e9';
const back7 = printSig(near32(T7), 7);
const p24 = digitsToRoundTrip(24), p53 = digitsToRoundTrip(53), s24 = digitsSurviving(24), s53 = digitsSurviving(53);
const sum01 = exactSum(0.1, 0.2);

export const decimalSteps: Step[] = [
  {
    title: 'Decimal in, decimal out',
    body: `
      <p>People type and read decimal; the hardware holds binary. Every conversion between them is a rounding, so it is worth knowing exactly what each one does.</p>
      <p><strong>What a float holds.</strong> A float is a dyadic fraction, an integer over a power of two, and every such fraction has a finite decimal expansion (each halving adds one decimal digit). So the float32 called 0.1 holds exactly
      <strong><span class="longnum">${exactDecimal(f32(0.1))}</span></strong>; the float64 called 0.1 holds <span class="longnum">${exactDecimal(0.1)}</span>. Type 0.1 into the explorer below and the exact expansion of the held value is shown under its meaning. The 0.1 in your source code is a request for the nearest float;
      the value in the register is the one printed here.</p>
      <p><strong>Floats to text and back.</strong> Print a float32 with ${p24} significant digits and read the text back, and you always get the same float; with ${p53} the same holds for a float64. The reason is counting: the digits must separate neighbours, whose relative gap is at least 2<sup>−24</sup> (float32) or 2<sup>−53</sup>, and
      ceil(1 + p·log₁₀ 2) digits, for p significant bits, are enough to do that. Fewer is not always enough: the float32 0x${B8.toString(16).toUpperCase().padStart(8, '0')} prints as ${sci(eight)} with eight digits, and so does the next pattern; read back, both become the same float, so one of them comes back wrong. Nine digits tell them apart (${sci(nine)} and ${sci(nineNext)}).</p>
      <p><strong>Text to floats and back.</strong> Going the other way fewer digits survive: any decimal with at most ${s24} significant digits (${s53} for float64) is turned into the nearest float32 and printed back as the same ${s24} digits. At seven the guarantee ends: ${sci(T7)} becomes the float32 that prints, to seven digits, as ${sci(back7)}.
      The rule of thumb: float32 is good for ${s24} decimal digits in and ${p24} digits out; float64 for ${s53} and ${p53}. These are the two constants behind <code>FLT_DIG</code> and <code>FLT_DECIMAL_DIG</code> in C (and <code>DBL_DIG</code>, <code>DBL_DECIMAL_DIG</code>).</p>
      <p><strong>0.1 + 0.2.</strong> The float64 sum of 0.1 and 0.2 is not the float64 called 0.3: the three held values are <span class="longnum">${exactDecimal(0.1)}</span>, <span class="longnum">${exactDecimal(0.2)}</span> and <span class="longnum">${exactDecimal(0.3)}</span>. The first two add, exactly, to <span class="longnum">${sum01}</span>, which lies between two float64s and rounds to
      <span class="longnum">${exactDecimal(0.1 + 0.2)}</span>, one ulp above the stored 0.3. It prints as <strong>${0.1 + 0.2}</strong>, and <code>0.1 + 0.2 == 0.3</code> is ${0.1 + 0.2 === 0.3}. Each of the three roundings was correct; only the expectation of exact decimal arithmetic was wrong.</p>
      <p><strong>Printing as few digits as possible.</strong> Printing ${p53} digits always works but is ugly: 0.1 would be ${printSig(0.1, 17)}. Modern languages print the <em>shortest</em> digit string that reads back to the same float, which is what JavaScript's <code>Number</code> to-string
      and Python's <code>repr</code> do (0.1 stays 0.1; the sum above needs seventeen digits). The algorithms have names: Dragon4 (Steele and White), Grisu, and Ryu, a fast, provably correct method built on 64-bit multiplications and a table. The mirror image, reading, must be <em>correctly rounded</em>: the result is the float nearest the exact decimal value, whatever its length.
      Naive code that multiplies digit by digit rounds at every step and can land an ulp away; correct readers use big integers, or a fast path with a fallback to them. The explorer's reader is exact: it takes the decimal as a ratio of integers and rounds once.</p>
      <div class="try">Type 0.1, then 16777217 (a float32 cannot hold it), then ${T7}, and read the "text → float → text" line: at ${s24} digits the text comes back unchanged, at seven it may not.</div>`,
    widget: floatExplorer,
    more: {
      numbers: `<table class="mini"><tr><th>Format</th><th>Significant bits p</th><th>Digits that always read back as the same float</th><th>Digits that survive text → float → text</th></tr>
        ${([['binary16', 11], ['bfloat16', 8], ['float32', 24], ['float64', 53]] as const).map(([n, p]) => `<tr><td>${n}</td><td>${p}</td><td>${digitsToRoundTrip(p)}</td><td>${digitsSurviving(p)}</td></tr>`).join('')}</table>
        <p>Digits to round-trip: ceil(1 + p·log₁₀ 2). Digits that survive: floor((p − 1)·log₁₀ 2). Both are computed here from p.</p>`,
      derive: `<p>Float → text → float: the n-digit decimals must be closer together than the floats, or two floats share a print. A decade of n-digit decimals has a spacing of 10<sup>−(n−1)</sup> relative to its start, a binade of floats 2<sup>−(p−1)</sup> to 2<sup>−p</sup>
        relative to the value; in the worst case this asks for 10<sup>n−1</sup> &gt; 2<sup>p</sup>, hence n ≥ 1 + p·log₁₀ 2 rounded up. Text → float → text: every n-digit decimal must get a float of its own, which needs 10<sup>n</sup> &lt; 2<sup>p−1</sup>, hence n ≤ (p − 1)·log₁₀ 2 rounded down.
        For p = 24: ceil(8.22) = ${p24} and floor(6.92) = ${s24}.</p>`,
      pitfall: `<p>Writing floats as text with too few digits, or reading a log back with fewer digits than were printed. float32 values written with six digits (<code>%f</code>, or <code>%g</code>'s default of six) do not read back to the same floats; <code>%.9g</code> does. In JSON numbers are decimal text, so a float32 passes through
        a double: its shortest float64 print (${f32(0.1)} for the float32 0.1) is not its shortest float32 print (0.1), and a reader that keeps the double holds a value the sender never had unless it rounds back to float32.</p>`,
      real: `<p>C's <code>strtod</code> is required to round correctly, and glibc does it with big integers. Reading with <code>strtod</code> and casting to float32 is <em>double rounding</em> and can differ by an ulp from <code>strtof</code>.
        Shortest printing was a research problem until Grisu (2010) and Ryu (2018); C++17's <code>std::to_chars</code> promises the shortest string that round-trips, and several language runtimes use methods of this family.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'A program writes float32 values to a text file with 7 significant digits and reads them back. What can happen?',
      options: [
        'Some floats come back as a neighbouring float: 9 digits are needed to be sure',
        'Nothing: 7 digits is the precision of float32',
        'Every value comes back off by 1 ulp',
        'Only subnormals are affected',
      ], answer: 0,
      why: ['', 'Seven digits is about how much decimal text float32 can hold (text → float → text, up to 6 digits), which is a different guarantee from float → text → float: neighbouring floats can print alike at seven or even eight digits.', 'Most come back exact; the failures are the floats whose print is shared with a neighbour.', 'Subnormals are not special here; any binade where the decimal grid is coarser than the binary one has collisions.'],
      explain: `Float → text → float needs ceil(1 + 24·log₁₀ 2) = ${p24} digits for float32, because two adjacent floats can lie closer than 10<sup>−6</sup> of their size. Seven or eight digits identify most floats, not all.`,
    },
  },
];
