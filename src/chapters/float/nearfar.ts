// Chapter 24's faster adder: the dual-path (near / far) adder and its leading-zero anticipation. Two steps, placed
// after "float32: the same circuit, bigger". Every number the prose quotes is measured from the circuits when the
// step is first read (tests/fpnearfar.test.ts pins them).

import { fpAdd, fpAddNearFar, lza, lzc, addSubFast } from '../../lib';
import { groupDigits } from '../../sim/numfmt';
import { F32, fpAddX } from '../../sim/fpref';
import { logicDepth, stats } from '../../sim/stats';
import type { ComponentDef } from '../../sim/types';
import type { Layers, Step } from '../types';

const E4M3 = { E: 4, M: 3 };
const grp = (n: number) => groupDigits(Math.round(n));
const nands = (d: ComponentDef) => stats(d).nands;
const unit = (d: ComponentDef) => logicDepth(d) ?? 0;
const load = (d: ComponentDef) => Math.round(logicDepth(d, 'load') ?? 0);
/** The result and flags of E4M3 a ± b (the exact reference), for the tours' expectations. */
const want = (a: number, b: number, sub: number) => { const r = fpAddX(a, b, !!sub, E4M3); return { y: r.y, flags: r.fl }; };

interface Measured {
  one: { n: number; d: number; l: number };
  counted: { n: number; d: number; l: number };
  nf: { n: number; d: number; l: number };
  lzaD: number; lzaN: number; addD: number; lzcD: number;
  far: { n: number; d: number }; near: { n: number; d: number }; rnd: { n: number; d: number }; unpackD: number; expD: number;
}
let cached: Measured | undefined;
/** float32, flattened once on first use. */
function measured(): Measured {
  if (cached) return cached;
  const row = (d: ComponentDef) => ({ n: nands(d), d: unit(d), l: load(d) });
  const nf = fpAddNearFar(F32);
  const parts = new Map(nf.netlist!().instances.map((i) => [i.name, i.def]));
  const part = (n: string) => ({ n: nands(parts.get(n)!), d: unit(parts.get(n)!) });
  const n = F32.M + 2;
  return (cached = {
    one: row(fpAdd(F32)), counted: row(fpAddNearFar(F32, false)), nf: row(nf),
    lzaD: unit(lza(n)), lzaN: nands(lza(n)), addD: unit(addSubFast(n)), lzcD: unit(lzc(32)),
    far: part('far'), near: part('near'), rnd: part('rnd'), unpackD: unit(parts.get('ua')!), expD: unit(parts.get('dab')!),
  });
}
/** The change from a to b in percent, with a true minus sign. */
const pct = (a: number, b: number) => { const v = Math.round((100 * (b - a)) / a); return v < 0 ? `−${-v}` : `${v}`; };
const lazyLayers = (make: () => Layers): Layers => {
  let m: Layers | undefined;
  const get = () => (m ??= make());
  return new Proxy({} as Layers, {
    get: (_, k) => get()[k as keyof Layers],
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_, k) => ({ value: get()[k as keyof Layers], enumerable: true, configurable: true, writable: true }),
    has: (_, k) => k in get(),
  });
};

export const nearFarSteps: Step[] = [
  {
    title: 'A faster adder: near and far paths',
    get body() {
      const m = measured();
      return `
        <p>The adder above is one serial path: compare the magnitudes, swap, subtract the exponents, align right, add, count the leading zeros, shift left, round. Every addition is built to pay for a long right shift
        <em>and</em> a long left shift, one after the other, though no pair of operands needs both. Split on the exponent difference d = |e<sub>a</sub> − e<sub>b</sub>| and on whether the operation is an effective subtraction.</p>
        <p><strong>Far path</strong> (<span data-show="far">FAR</span>): an effective addition, or a subtraction with d ≥ 2. The smaller significand shifts right by up to M + 3 places, the sticky bit keeping what falls off. The result is in [1, 4)
        for an addition and in (½, 2) for a subtraction with d ≥ 2, so it moves at most one place right (a carry) or two left, counted from the carry column: two rows of multiplexers and no counter. <strong>Near path</strong> (<span data-show="near">NEAR</span>): a
        subtraction with d ≤ 1. The smaller significand moves at most one place, into one extra bit, so nothing is lost: no sticky, no aligner, an exact difference. What can happen instead is cancellation to any depth, so this path keeps the
        counting and the left shifter. Each path carries one of the two big shifters, not both in series.</p>
        <p>The swap goes by exponent alone: <span data-show="dab dba">both differences e<sub>a</sub> − e<sub>b</sub> and e<sub>b</sub> − e<sub>a</sub> are formed and the borrow picks</span>, which removes the magnitude comparator that stood in front of
        everything (31 bits wide in float32). When d = 0 either operand may be the larger, so the near path forms X − Y and Y − X and keeps the one without a borrow. A select between the two results, then <span data-show="rnd">one rounder</span>
        shared by both paths: the rounding decision, increment, overflow and tininess logic of normalize &amp; round, without its counter and shifters, which the paths have already done. Results and flags are bit for bit those of the single-path adder:
        every operand pair of the 6-bit format and of E4M3 in all five modes, float16 and float32 on biased random operands.</p>
        <p>Measured in float32: <strong>${grp(m.nf.n)} NANDs</strong> against ${grp(m.one.n)} (+${pct(m.one.n, m.nf.n)} %), <strong>${m.nf.d} NAND delays deep</strong> against ${m.one.d} (${pct(m.one.d, m.nf.d)} %), and ${m.nf.l} against
        ${m.one.l} units under the load-dependent model (${pct(m.one.l, m.nf.l)} %). Where the rest of the depth sits: unpack ${m.unpackD}, exponent difference ${m.expD}, then the paths (far ${m.far.d}, near ${m.near.d}), then the rounder ${m.rnd.d}. The near path has slack (${m.far.d - m.near.d} delays), so the far path sets the depth, and the front and the rounder are common to both: a serial floor that the split cannot touch.</p>
        <div class="try">3.0 + 1.0 takes the far path. Then 1.125 − 1.0 (0x39 − 0x38): the near path, three leading zeros. Then 1.0 − 1.125: equal exponents, X &lt; Y, so the other difference is used and the sign flips.</div>`;
    },
    scene: () => ({ root: fpAddNearFar(E4M3), inputs: { a: 0x44, b: 0x38, sub: 0 } }),
    tour: {
      beats: [
        { title: 'Far: align and add', at: [], show: ['dab', 'dba', 'far', 'rnd'], expect: want(0x44, 0x38, 0),
          say: '<p>3.0 + 1.0: an addition, so the far path. The exponents differ by 1, the smaller significand shifts right one place, the sum carries and moves back one: y = {v:y} = 0x48 = 4.0, no flags. The near path computes something too, but is not selected.</p>' },
        { title: 'Near: cancellation', set: { sub: 1, a: 0x39, b: 0x38 }, show: ['near', 'rnd'], expect: want(0x39, 0x38, 1),
          say: '<p>1.125 − 1.0: a subtraction with equal exponents, the near path. The difference is 0.001₂, three leading zeros; the near path shifts them out and lowers the exponent by 3: y = {v:y} = 0x20 = 0.125, exact, flags {b:flags}.</p>' },
        { title: 'Near: the other order', set: { a: 0x38, b: 0x39 }, show: ['near', 'rnd'], expect: want(0x38, 0x39, 1),
          say: '<p>1.0 − 1.125: with equal exponents nothing says which operand is larger until the significands are subtracted. X − Y borrows, so the path takes Y − X and the sign of the second operand: y = {v:y} = 0xA0 = −0.125. The magnitude comparator of the single-path adder is replaced by a second subtractor running beside the first.</p>' },
        { title: 'Far: subtraction, d ≥ 2', set: { a: 0x48, b: 0x30 }, show: ['far', 'rnd'], expect: want(0x48, 0x30, 1),
          say: '<p>4.0 − 0.5: the exponents differ by 3, so even a subtraction takes the far path. The result 3.5 is at least half of the larger operand: at most two places of left shift, no counting. y = {v:y} = 0x46 = 3.5.</p>' },
      ],
    },
    more: lazyLayers(() => {
      const m = measured();
      const row = (name: string, e4: ComponentDef, f: { n: number; d: number; l: number }) => `<tr><td>${name}</td><td>${grp(nands(e4))} / ${unit(e4)} / ${load(e4)}</td><td>${grp(f.n)} / ${f.d} / ${f.l}</td></tr>`;
      return {
        numbers: `<table class="mini"><tr><th>NANDs / unit depth / load depth</th><th>E4M3</th><th>float32</th></tr>
          ${row('single path (fpAdd)', fpAdd(E4M3), m.one)}${row('near / far, count behind the subtractor', fpAddNearFar(E4M3, false), m.counted)}${row('near / far, anticipated', fpAddNearFar(E4M3), m.nf)}</table>`,
        derive: `<p>Why a subtraction with d ≥ 2 never needs more than two places. Let the larger operand be x ∈ [1, 2) (normal, since its exponent is at least 3) and the smaller y &lt; 2<sup>1−d</sup> ≤ ½. Then x − y &gt; ½, so the leading one of the difference is in
          the first or second position below the carry column: at most one place of left shift beyond the one every addition result may need. For d ≤ 1 the difference can be anywhere down to 0, and for d = 1 the smaller operand shifted one place needs exactly one more bit, so with one extra bit of width the
          subtraction is exact.</p>`,
        pitfall: `<p>Choosing the path from the result. The path must be known before the work starts: the exponents say it, the size of the result does not (that is what the near path's counter finds out). Selecting by "the result is small" would
          put the select behind the subtraction and give back the delay the split removed.</p>`,
        real: `<p>Dual-path adders have been standard in high-performance FPUs since the 1990s. Production ones also fold the rounding into each path (a compound adder produces sum and sum + 1, the carry picks) so that the round
          increment is not a serial step behind the sum; here the rounder is shared and serial, which is why the rounder's ${m.rnd.d} is still on the critical path.</p>`,
      };
    }),
    challenge: {
      kind: 'quiz',
      question: 'Both operands are positive. Which of these takes the near path?',
      options: ['x − y where the exponents differ by 1', 'x + y with equal exponents', 'x − y where the exponents differ by 2', 'any x − y whose result turns out to be small'],
      answer: 0,
      why: [
        '',
        'With both operands positive, x + y is an effective addition. It never cancels: the sum is at least the larger operand and carries at most one place. Whatever its exponents, it takes the far path. (x + y with opposite signs would be an effective subtraction, and could be near.)',
        'With d = 2 the smaller operand is below a quarter of the larger one; the difference is more than half of it and needs at most two places of left shift. That is the far path, which has no counter.',
        'The path is chosen from the exponents before the subtraction starts. The size of the result is only known after, which is exactly why the near path needs a counter or an anticipator.',
      ],
      explain: 'Near = effective subtraction (the operand signs differ after fsub flips the sign of b) with an exponent difference of 0 or 1: the only case where the result can cancel to any depth. Everything else has a long alignment but a short normalization.',
    },
  },
  {
    title: 'Anticipating the leading zeros',
    get body() {
      const m = measured();
      return `
        <p>Cancellation in the near path can leave anywhere from 0 to ${F32.M + 1} leading zeros in <span data-show="dxy">X − Y</span>, and the shifter that removes them needs the count. Counting behind the subtractor puts three things in series before the shift: the
        carry chain, the select between X − Y and Y − X, and a priority encoder. <strong>Anticipation</strong> predicts the count from the operands X and Y alone, by <span data-show="lzxy">an anticipator</span> running at the same time as the subtraction (and
        <span data-show="lzyx">a second one for Y − X</span>, since the borrow that says which difference is wanted arrives late).</p>
        <p>For each bit of X + ¬Y the anticipator forms propagate T = x ⊕ ȳ, generate G = x·ȳ and zero Z = x̄·y, then a pattern f<sub>i</sub> = T<sub>i+1</sub>·(G<sub>i</sub>·Z̄<sub>i−1</sub> + Z<sub>i</sub>·Ḡ<sub>i−1</sub>) + T̄<sub>i+1</sub>·(Z<sub>i</sub>·Z̄<sub>i−1</sub> + G<sub>i</sub>·Ḡ<sub>i−1</sub>)
        from three neighbouring bits, with no carry. The first 1 of f is at the leading one of the difference <em>or one place above it</em> (checked exhaustively on the circuit's reference for 4 to 8 bits): the count is the true one or one too small, never too large, which would shift a one out. A
        priority encoder turns the position into a count.</p>
        <p>The shift is therefore taken by p, and then <span data-show="shift">the shifter's output</span> is looked at: if its top bit is still 0, p was one short, and one more place is shifted (one row of multiplexers) with the exponent lowered by one. Both exponents, e − p
        and e − p − 1, are formed while the shifter works, and the top bit picks. A shift may not take the exponent below its minimum (the result would be a subnormal): instead of comparing after the encoder, <span data-show="clamp">a decoder</span> forces a one at the pattern position of count
        e − 1 into f, so the encoder itself returns min(p, e − 1), and the correction is blocked when p has reached e − 1.</p>
        <p>Does it pay? The anticipator is <strong>${m.lzaD}</strong> deep (${grp(m.lzaN)} NANDs, and the near path has two). The subtractor it runs beside is ${m.addD} deep and a 32-bit counter ${m.lzcD}: ${m.addD} + ${m.lzcD} = ${m.addD + m.lzcD}, about the same.
        What anticipation removes is not the counting but the chain behind the subtractor: the sign select and the comparison with the exponent. Measured on the same float32 adder with the count taken behind the subtractor instead: <strong>${grp(m.counted.n)} NANDs, ${m.counted.d} deep</strong>
        (${m.counted.l} units loaded), against <strong>${grp(m.nf.n)} NANDs, ${m.nf.d} deep</strong> (${m.nf.l}) anticipated. The split alone took the adder from ${m.one.d} to ${m.counted.d} delays for ${pct(m.one.n, m.counted.n)} % more NANDs; anticipation takes a further
        ${m.counted.d - m.nf.d} delays (${pct(m.counted.d, m.nf.d)} %) for ${pct(m.counted.n, m.nf.n)} % more NANDs. A trade, not a free win, and with a Kogge–Stone subtractor and an 11-deep counter it is a modest one: a slower adder, or a wider format, would favour it more.</p>
        <div class="try">1.125 − 1.0: watch both anticipators; the one for X − Y is the one that counts. Then 1.0 − 1.125 hands the shift to the other.</div>`;
    },
    scene: () => ({ root: fpAddNearFar(E4M3), path: ['near'], inputs: { a: 0x39, b: 0x38, sub: 1 } }),
    tour: {
      beats: [
        { title: 'Two subtractors, two anticipators', at: ['near'], show: ['dxy', 'lzxy', 'dyx', 'lzyx'], expect: want(0x39, 0x38, 1),
          say: '<p>1.125 − 1.0: X = 2·1.001₂, Y the same shifted for equal exponents. Both X − Y and Y − X are formed, each with its anticipator, from the operands. X − Y does not borrow, so its count is used: three leading zeros, y = {v:y} = 0x20 = 0.125.</p>' },
        { title: 'The other difference', set: { a: 0x38, b: 0x39 }, show: ['dyx', 'lzyx', 'shift'], expect: want(0x38, 0x39, 1),
          say: '<p>1.0 − 1.125: X − Y borrows, so the difference and the count of Y − X are selected and the sign flips: y = {v:y} = 0xA0 = −0.125. The count was ready before the borrow was; only a 2:1 select is left behind it.</p>' },
        { title: 'The exponent limit', set: { a: 0x09, b: 0x08 }, show: ['clamp', 'shift'], expect: want(0x09, 0x08, 1),
          say: '<p>1.001₂ × 2<sup>−6</sup> − 1.0 × 2<sup>−6</sup> = 2<sup>−9</sup>, below the smallest normal number. The exponent allows no left shift at all, so the decoder forces the count to 0 and the result stays a subnormal: y = {v:y} = 0x01, exact.</p>' },
      ],
    },
    more: lazyLayers(() => ({
      derive: `<p>A − B = A + ¬B + 1. For one bit position, T says the pair propagates a carry (the sum bit is 1 whatever comes from below), G that it generates one, Z that it kills one. f<sub>i</sub> reads bits i + 1, i and i − 1 only, so it cannot see whether a carry
        arrives from further below. When one does, the true leading one is one position lower than f says: that is the one-place uncertainty, and the reason for the correction shift. A 1 entering below the least significant bit stands for the +1 of the subtraction.</p>`,
      pitfall: `<p>Letting the anticipated count stand for the true one. The count is only exact when the carry from below does not reach the leading position; assume it always is and the normalized result has a leading zero in about three cases in ten (measured over every 8-bit operand pair), and the packer reads the 0 hidden bit as a subnormal: a number far too small
        in a plausible encoding, with no flag. The correction shift is part of the design, not an optional refinement.</p>`,
      real: `<p>The anticipator in real FPUs is the same idea (Schmookler and Nowka, 2001, compare the methods), usually folded with the sign decision so that one pattern serves both X − Y and Y − X. Here the two differences are kept apart: simpler to read,
        about twice the anticipator's gates.</p>`,
    })),
    challenge: {
      kind: 'quiz',
      question: 'After the shift by the anticipated count the top bit is still 0, and the exponent has room. What does the near path do?',
      options: [
        'Shifts one more place and lowers the exponent by one: the anticipated count was one short',
        'Signals an error: the anticipator is supposed to be exact',
        'Throws the result away and counts again behind the subtractor',
        'Rounds it as it is: a leading zero is harmless',
      ],
      answer: 0,
      why: [
        '',
        'The anticipator is exact only to within one place, by design: it does not see the carry from below. A one-place miss is the normal case, not an error, and it costs one multiplexer row.',
        'That would put the counter back in the path and cost what the anticipator saved. The correction needs only the top bit of the shifted word.',
        'The top bit is the hidden bit. With a 0 there the packer encodes a subnormal: a result off by a large factor in a valid-looking encoding, and no flag.',
      ],
      explain: 'The count is the true one or one too small. A single correction shift on the shifter\'s output, with the exponent lowered, makes it exact; it is blocked when the exponent has no more room (the result is a subnormal).',
    },
  },
];
