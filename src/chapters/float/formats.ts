// Chapter 24's formats beyond float32: binary16, bfloat16, the two 8-bit formats and float64 from the same generators.
// Costs are the pinned table lib/fpformatcosts.ts (tests/fpformats.test.ts re-measures it); ranges are computed.

import { FORMAT_COSTS as C, formatRange } from '../../lib/fpformatcosts';
import { groupDigits } from '../../sim/numfmt';
import { formatCostWidget, formatsWidget, sciText } from '../../widgets/formats';
import type { Step } from '../types';

const g = (n: number) => groupDigits(n);
const r = (id: string) => formatRange({ e5m2: { E: 5, M: 2 }, e4m3: { E: 4, M: 3 }, f16: { E: 5, M: 10 }, bf16: { E: 8, M: 7 }, f32: { E: 8, M: 23 }, f64: { E: 11, M: 52 } }[id]!);
const x = (a: number, b: number, d = 1) => (a / b).toFixed(d);

export const formatSteps: Step[] = [
  {
    title: 'Narrower and wider: f16, bf16, FP8, f64',
    get body() {
      return `
      <p>The generators take the format as a parameter, so nothing stops us building the others. Six are compared below, all with the same fields (sign, exponent, fraction), the same hidden bit, the same
      subnormals, the same five rounding modes. <strong>The exponent bits buy range, the fraction bits buy precision.</strong> binary16 (E5M10) spans ${sciText(r('f16').minSub)} to ${g(r('f16').max)} with 3.3 decimal digits: fine for
      pixels and weights, hopeless for a running sum (65 520 and above round to ∞). <strong>bfloat16</strong> (E8M7) keeps float32's exponent, so the same range, ${sciText(r('bf16').minNormal)} to ${sciText(r('bf16').max)}, and gives up precision: 8 significant bits, 2.4 digits, spacing 2<sup>−7</sup> at 1. Its great convenience is the conversion: a bfloat16 is the top 16 bits of a float32, so float32 → bf16 is dropping the
      low half (round toward zero; round-to-nearest adds one incrementer), and bf16 → float32 is appending 16 zeros, exact, with no overflow or underflow possible. Training gradients vary over many binades but need few digits; that is
      the trade ML hardware took. float64 (E11M52) spans ${sciText(r('f64').minSub)} to ${sciText(r('f64').max)} with 15.9 digits: it is the host language's number and the reference the chapter's tests use.</p>
      <p>The two 8-bit formats go further: E5M2 (${g(r('e5m2').max)} at most, spacing 0.25 at 1: two fraction bits) is effectively a truncated binary16 and suits gradients; E4M3 trades one exponent bit for one fraction bit for weights and
      activations. <strong>A warning on E4M3:</strong> the chapter's own E4M3 is IEEE-style, exponent 1111 reserved for ∞ and NaN, so its largest value is ${g(r('e4m3').max)}. The
      OCP / NVIDIA FP8 E4M3 used in machine learning is <em>not</em>: it has no infinities, only S.1111.111 is NaN, and the other 1111 exponents hold ordinary numbers, so its largest value is <strong>448</strong>
      (1.75 × 2<sup>8</sup>); one extra binade for the price of losing ∞, with overflow saturating or producing NaN by convention. E5M2 does follow the IEEE rules (∞, NaN, max ${g(r('e5m2').max)}), which is
      why it is described as "IEEE-like" and E4M3 is not. The numbers here for E4M3 are for the IEEE-style one we can build and measure; the ML variant would differ only in the special-case logic (no ∞, one NaN),
      not in the datapath.</p>
      <div class="try">Round 0.1 into each format: float32 holds 0.100000001, bf16 0.100097656, binary16 0.0999756. Then 70000: binary16 and both FP8 formats overflow, bf16 holds 70144.</div>`;
    },
    widget: formatsWidget,
    more: {
      derive: `<p>Largest finite = (2 − 2<sup>−M</sup>) × 2<sup>emax</sup> with emax = 2<sup>E−1</sup> − 1; smallest normal 2<sup>1−emax</sup>; smallest subnormal 2<sup>1−emax−M</sup>. One decimal digit is 3.32 bits, so M + 1 significant bits
        carry (M + 1) · log<sub>10</sub> 2 digits. The ratio largest / smallest subnormal is the <em>dynamic range</em>: bf16 and float32 about 10<sup>${Math.round(Math.log10(r('bf16').max / r('bf16').minSub))}</sup> and 10<sup>${Math.round(Math.log10(r('f32').max / r('f32').minSub))}</sup>, binary16 only 10<sup>${Math.round(Math.log10(r('f16').max / r('f16').minSub))}</sup>.</p>`,
      real: `<p>Fewer exponent bits also mean a tighter choice of scale: FP8 training keeps a per-tensor scale factor (a power of two, sometimes per block) next to the data, because E4M3's seven binades cannot cover a tensor's spread unaided.
        Real FP8 and bf16 units also tend to flush subnormals and offer fewer rounding modes than the unit measured here, which makes them smaller still.</p>`,
      pitfall: `<p>Quoting "FP8 E4M3 max = 448" and then checking it against a library that follows IEEE rules, or the reverse. Always state which E4M3: the IEEE-style one tops out at 240, the OCP one at 448 and has no ∞.</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: 'Why is float32 → bfloat16 conversion cheap, and bf16 → float32 free?',
      options: [
        'bf16 keeps float32\'s sign and 8 exponent bits and the top 7 fraction bits, so the conversion is dropping (or appending) 16 low fraction bits',
        'bf16 uses a different bias, so a small adder converts the exponent',
        'bf16 stores the value as a scaled integer, so conversion is a shift',
        'The conversion needs a normalize step because bf16 has no subnormals',
      ],
      answer: 0,
      explain: 'Same exponent width, same bias, same special encodings: the bf16 bit pattern is the upper half of the float32 one. Widening appends 16 zero bits and is exact; narrowing truncates (round toward zero) or adds one rounding incrementer.',
      why: ['', 'The bias is 127 in both: that is the point of bf16. Exponents carry over unchanged.', 'It is the same sign / exponent / fraction layout as float32, not an integer scaling.', 'bf16 has subnormals like float32, and the exponent and normalized significand carry over unchanged, so no renormalizing is needed.'],
    },
  },
  {
    title: 'What the formats cost',
    get body() {
      const f32 = C.f32, f16 = C.f16, bf = C.bf16, e5 = C.e5m2, f64 = C.f64;
      return `
      <p>Each format's adder, multiplier and fused multiply-add, <em>measured</em> from the same generators (lib/fpu.ts) the chapter has used all along, NANDs and logic depth. The multiplier is the one to watch: its significand
      tree is an (M + 1) × (M + 1) array of partial products, so it grows as <strong>M²</strong>. From float32 to bfloat16 the tree shrinks ${x(f32.mul.tree, bf.mul.tree)}× (${g(f32.mul.tree)} → ${g(bf.mul.tree)} NANDs, against (24 / 8)² = 9);
      to E5M2 it shrinks to ${g(e5.mul.tree)}, ${x(f32.mul.tree, e5.mul.tree, 0)}× less. float64's tree is ${g(f64.mul.tree)}, ${x(f64.mul.tree, f32.mul.tree)}× float32's: its multiplier (${g(f64.mul.nands)}) is ${x(f64.mul.nands, f32.mul.nands)}× the float32 one and its fma ${g(f64.fma.nands)}.
      That quadratic is why ML hardware moved to bf16 and FP8: a multiplier array is what an accelerator is made of, and an 8 × 8 bf16 tree costs about an eighth of the 24 × 24 one, at float32's range.</p>
      <p>The whole multiplier shrinks less than the tree. At bf16 the tree is ${g(bf.mul.tree)} of ${g(bf.mul.nands)} NANDs: the rest is unpacking, exponent arithmetic and the normalize &amp; round (${g(bf.mul.round)}), which does not shrink with M² and
      even grows with the exponent range. Hence the measured oddity that in this design a bfloat16 multiplier (${g(bf.mul.nands)}) is <em>larger</em> than a binary16 one (${g(f16.mul.nands)}), although its tree is half the size (${g(bf.mul.tree)} against ${g(f16.mul.tree)}).
      Only the fixed logic keeps FP8 from being free: ${g(e5.mul.nands)} NANDs for E5M2, of which the tree is ${g(e5.mul.tree)}. Real FP8 multipliers drop the rounding modes and subnormals, and the fixed part falls with them.</p>
      <p>The <strong>fma</strong> is the unit that matters. One fused multiply-add costs only a little more than a separate multiplier and adder (float32: ${g(f32.fma.nands)} NANDs against ${g(f32.mul.nands + f32.add.nands)}; float64: ${x(f64.fma.nands, f64.mul.nands + f64.add.nands, 2)}×), is
      ${f32.mul.depth + f32.add.depth - f32.fma.depth} delays shallower than the two in sequence (${f32.fma.depth} against ${f32.mul.depth + f32.add.depth}), rounds once, and does both halves of a dot product: every GPU and ML core is an array of fma units, so the
      accelerator's area is (units × fma). Mixed precision follows from the table: multiply in bf16 or FP8, where the tree is cheap, and accumulate in float32, whose <em>adder</em> (${g(f32.add.nands)} NANDs, ${f32.add.depth} deep) is now larger than
      the bf16 multiplier's whole tree (${g(bf.mul.tree)}); accumulating in the narrow format would save that adder but lose the low bits of a long sum.</p>
      <div class="try">Compare the bars: the float64 fma is ${x(f64.fma.nands, f32.fma.nands)}× float32's and ${x(f64.fma.nands, bf.fma.nands, 0)}× bfloat16's. Find the format whose multiplier is smaller than its adder (E5M2, E4M3).</div>`;
    },
    widget: formatCostWidget,
    more: {
      numbers: `<table class="mini"><tr><th>Format</th><th>Adder</th><th>Multiplier</th><th>of which tree</th><th>fma</th><th>fma depth</th></tr>${(['e5m2', 'e4m3', 'f16', 'bf16', 'f32', 'f64'] as const)
        .map((k) => `<tr><td>${{ e5m2: 'E5M2', e4m3: 'E4M3', f16: 'binary16', bf16: 'bfloat16', f32: 'float32', f64: 'float64' }[k]}</td><td>${g(C[k].add.nands)}</td><td>${g(C[k].mul.nands)}</td><td>${g(C[k].mul.tree)}</td><td>${g(C[k].fma.nands)}</td><td>${C[k].fma.depth}</td></tr>`).join('')}</table>`,
      real: `<p>float64 is why consumer GPUs run it at a small fraction of their float32 rate: a float64 fma is ${x(C.f64.fma.nands, C.f32.fma.nands)}× the area, so the die holds that many fewer of them. Tensor-core style units go the other way, packing many small multipliers
        (FP8, bf16, f16) around a wide accumulator.</p>`,
      pitfall: `<p>Scaling a cost by "bits squared" from one format to another. Only the tree follows M²; the unpack, exponent and rounding logic follows the exponent width and the product width, so small formats cost more than M² says and the
        ratio between formats comes out below the square (float32 to bf16: ${x(C.f32.mul.nands, C.bf16.mul.nands)}× whole, ${x(C.f32.mul.tree, C.bf16.mul.tree)}× tree).</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: 'Going from float32 to bfloat16, the significand tree of the multiplier shrinks about 8×, but the whole multiplier only about 2.7×. Why?',
      options: [
        'The normalize & round, unpacking and exponent logic do not shrink with the fraction width; at bf16 they are most of the unit',
        'The bf16 multiplier is built from different, larger cells',
        'Rounding to bf16 needs a second multiplication',
        'The tree does not shrink: the measured numbers include the wider exponent adder',
      ],
      answer: 0,
      explain: `The tree is M²-ish (24 × 24 against 8 × 8), but the unit is tree + normalize & round + the rest. At bf16 the tree is ${g(C.bf16.mul.tree)} of ${g(C.bf16.mul.nands)} NANDs and the rounder, ${g(C.bf16.mul.round)}, is bigger than it. A part that does not shrink caps the saving, in area as in time.`,
      why: ['', 'Every format here comes from the same generator and the same NAND cells.', 'The product is rounded once, with no further multiplication; the rounder is a shifter and an incrementer.', 'The tree does shrink (${g(C.f32.mul.tree)} → ${g(C.bf16.mul.tree)} NANDs, measured); the exponent adder is a few hundred NANDs, so it explains none of the gap.'],
    },
  },
];
