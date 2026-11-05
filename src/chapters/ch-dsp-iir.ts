// IIR and stability: what feedback buys on one specification, the bilinear transform, a pole held in a register, direct form against sections, a biquad in gates,
// a limit cycle on those gates, what removes it, and the order and scaling of sections. The gates are lib/biquad.ts, equal to dsp/iir.ts at every clock
// (tests/dsp-iir-gates.test.ts); the design half is held to scipy (tests/dsp-iir.test.ts); what the text claims is tests/dsp-iir-chapter.test.ts.

import {
  BQ, burstThenSilence, coefWord, cycleSweep, deadBand, findCycle, LIMIT_CYCLE, MASK, runBiquad, SWEEP_RUNS, SWEEP_VARIANTS, warpedAt, prewarp, type Words,
} from '../dsp/iir';
import { biquad } from '../lib/biquad';
import { stats } from '../sim/stats';
import { treeMul } from '../lib/muldiv';
import {
  biquadCost, biquadScene, cycleScene, dbfs, designRows, bilinearWidget, firstStableWidth, limitCycleWidget, maskWidget, mulNands, narrowFilter, NARROW, orderData, orderWidget,
  sensitivityWidget,
} from '../widgets/dspiir';
import { heldPair, planeWidget } from '../widgets/dspzplane';
import { directStable } from '../dsp/iir';
import { polyRoots } from '../dsp/zplane';
import { DSP_LEVEL } from './dspladder';
import { numOf } from './order';
import type { Chapter } from './types';

const TAU = 2 * Math.PI;
const g = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const nf = (v: number, d = 3) => v.toFixed(d);
const sig = (v: number) => v.toExponential(0).replace('e+', ' × 10^');

/** The pole of step 3's centre: radius 0.97 at 0.04 cycles a sample, and a narrow one. */
export const RES = { r: 0.97, f: 0.04 };
export const NARROW_POLE = { r: 0.99, f: 0.02 };
export const held = (p: { r: number; f: number }, bits: number) => heldPair({ r: p.r, t: p.f * TAU }, bits);
/** The narrowest word, from 4 bits, at which a pole asked for is held stable. */
export const stableFrom = (p: { r: number; f: number }, hi = 16): number | null => { for (let b = 4; b <= hi; b++) if (held(p, b).state === 'stable') return b; return null; };
/** Widths from 8 to 32 at which the direct form of the narrow filter is unstable. */
export const directUnstable = (): number[] => { const a = narrowFilter().a, out: number[] = []; for (let b = 8; b <= 32; b++) if (!directStable(a, b)) out.push(b); return out; };

/** The pole spacing of the filter's direct form: one over the product of distances to the other poles, worst pole; a section's: one over twice its imaginary part. */
export function sensitivity(): { direct: number; sections: number } {
  const F = narrowFilter(), poles = polyRoots(F.a);
  let direct = 0;
  poles.forEach((p, i) => { let d = 1; poles.forEach((q, j) => { if (j !== i) d *= Math.hypot(p.re - q.re, p.im - q.im); }); direct = Math.max(direct, 1 / d); });
  const sections = Math.max(...F.sos.map((q) => 1 / Math.sqrt(4 * q.a[2] - q.a[1] ** 2)));
  return { direct, sections };
}

/** The words of the second Try of step 7: toward zero near the circle. */
export const NEAR_CIRCLE: Words = { b0: 1024, b1: 0, b2: 0, a1: -28873, a2: 16328 };
export const NEAR_INPUT = { amp: 2972, burst: 2 };

export const chIir: Chapter = {
  id: 'iir', num: numOf('iir'), title: 'IIR and stability', level: DSP_LEVEL,
  blurb: 'What feedback buys and what it can break: the bilinear transform, poles that can only sit on a lattice, direct form against sections, a biquad in gates and a limit cycle it will not stop making, and how to order and scale sections.',
  goals: [
    'say what a mask costs in multiplications as an FIR and as an IIR filter, and what the IIR gives up',
    'design a low-pass from an analog prototype with the bilinear transform, and prewarp its edge',
    'read the lattice of poles a coefficient word can hold, and tell when rounding puts a pole on the circle',
    'say why a high-order filter is built from second-order sections, with the numbers for one narrow filter',
    'find a limit cycle on a biquad in gates, and say what does and does not remove one',
  ],
  builds: ['zplane', 'fixed', 'muldiv'],
  recap: {
    keep: [
      'An IIR filter spends its multiplications on poles. For one mask the elliptic design needs 20 a sample, against 53 for the shortest symmetric FIR filter: but its phase is not linear, and its poles must stay inside the unit circle with the coefficients a register can hold.',
      'The bilinear transform s → (2 + s) / (2 − s) maps the left half of the s-plane into the unit circle, so a stable analog filter gives a stable digital one. It squeezes frequency, f = atan(ω / 2) / π, so the analog edge is prewarped to 2 tan(π f).',
      'A second-order section holds its poles in two words: a₁ = −2r cos θ and a₂ = r². A word of b bits has a step of 2^−(b−2), so poles sit on a lattice, sparsest near z = 1, where narrow filters need them. The section is stable exactly inside the triangle |a₂| < 1, |a₁| < 1 + a₂.',
      'Poles of a high-order polynomial that lie close together move enormously when a coefficient is rounded. The narrow elliptic filter of this chapter is unstable as one polynomial at every width from 8 to 19 bits, and stable as three sections at every width.',
      `The biquad in gates is direct form I: five signed multipliers, a ${BQ.accW}-bit accumulator that keeps every product bit, one rounding and one clamp, and four delay registers. ${g(stats(biquad()).nands)} NANDs, equal to the model at every clock.`,
      'A limit cycle is rounding inside a feedback loop sustaining an output with no input. It is bounded by the dead band ½ / (1 − a₂). Rounding toward zero removes it for poles not too close to the circle and not for those that are; a wider accumulator removes nothing, since the rounding comes after it.',
      'Cascaded sections need scaling and an order. Scaling the numerators so that a full-scale sine reaches every output at gain 1 prevents overflow and adds noise margin; the order moves the output noise by a few dB.',
    ],
    check: [
      {
        question: 'A mask asks for a sharp transition at a low frequency. Which costs the fewest multiplications a sample?',
        options: ['An elliptic IIR filter in second-order sections', 'A Butterworth IIR filter in second-order sections', 'A window FIR filter', 'They cost the same: a mask fixes the multiplications'],
        answer: 0,
        explain: 'For equal specifications the elliptic design has the lowest order, since its ripples in both bands are spent on steepness. FIR and Butterworth need many times more.',
        why: ['', 'Butterworth is flat in both bands, and flatness is paid for in order: 37 against 8 here.', 'A window FIR needs a length inversely proportional to the transition width.', 'The multiplications follow from the order or length that the family needs, and families differ greatly.'],
      },
      {
        question: 'A pole asked for at radius 0.97 is held in a 5-bit coefficient word, as in step 3. What does the register hold?',
        options: ['A pole pair exactly on the unit circle', 'A pole pair at radius 0.97, slightly off in angle', 'A double pole at z = 1', 'A pole pair outside the circle'],
        answer: 0,
        explain: 'a₂ = r² = 0.941 rounds to 1.0 at a step of 0.125, and a pair on the circle never decays. At 4 bits a₁ also reaches −2 and both roots are at z = 1.',
        why: ['', 'Rounding a₂ to the lattice moves the radius a lot, not the angle: here the radius lands on 1.', 'That is the 4-bit word: a₁ rounds to −2 as well.', 'A section\'s coefficient range stops a₂ at 2 − step, and rounding never took this one beyond the circle.'],
      },
      {
        question: 'A biquad with a₂ = 14 787 / 2¹⁴ rings on after its input has stopped, at 5 LSB. A wider accumulator is proposed. What would it change?',
        options: ['Nothing: the accumulator is already exact, and the rounding that sustains the cycle comes after it', 'It would remove the cycle, since the cycle is an overflow', 'It would halve the cycle', 'It would make the cycle louder'],
        answer: 0,
        explain: 'The accumulator keeps all 29 fractional bits of every product. What feeds back is the output after rounding, and no width before the rounding can change that.',
        why: ['', 'It is not an overflow: the values are 5, 0, −5, 0. Overflow is a different failure.', 'The accumulator has no part in setting the amplitude: the dead band ½ / (1 − a₂) does.', 'Its level is fixed by a₂ and the rounding, so it is not affected.'],
      },
    ],
  },
  steps: [
    {
      title: 'What feedback buys',
      get body() {
        const rows = designRows(), by = (id: string) => rows.find((r) => r.id === id)!, mul = mulNands();
        const pm = by('pm'), ka = by('kaiser'), bu = by('butter'), ch = by('cheby1'), el = by('ellip');
        return `
        <p>The last step of <a href="#/c/zplane/0">the z-plane</a> ended on a promise: a pole pair costs two multiplications and gives a sharpness that an FIR filter would need hundreds of taps for. Here it is worked on one specification.</p>
        <p>The mask: pass to <strong>${MASK.fp}</strong> cycles a sample with at most ${MASK.rp} dB of loss, stop from <strong>${MASK.fs}</strong> with at least ${MASK.rs} dB. Tools such as scipy quote edges as fractions of Nyquist, half the sample rate, so this is 0.2 and 0.25 there. The transition band is ${nf(MASK.fs - MASK.fp)} of the sample rate wide.</p>
        <p>A symmetric FIR filter that meets it needs ${pm.size} (the smallest length a search found, using scipy's equiripple design) or ${ka.size} by the window estimate. Folded, so that tap pairs share a multiplier, that is ${pm.mults} and ${ka.mults} multiplications a sample. The three classical IIR designs need an order of ${bu.size.match(/\d+/)![0]} (Butterworth), ${ch.size.match(/\d+/)![0]} (Chebyshev I) and ${el.size.match(/\d+/)![0]} (elliptic), built as ${bu.size.split(', ')[1]}, ${ch.size.split(', ')[1]} and ${el.size.split(', ')[1]}, at five multiplications each. The elliptic filter needs <strong>${el.mults}</strong>: ${nf(pm.mults / el.mults, 1)} times fewer than the shortest FIR filter.</p>
        <p>Counted in gates, with a <span data-show="">16 × 16 signed multiplier</span> at ${g(mul)} NANDs for each multiplication, that is ${g(el.mults * mul)} against ${g(pm.mults * mul)}. This counts multipliers alone, one for each multiplication, which nobody would build for a filter this slow: adders, registers and sharing one multiplier over time are not here. The ratio is what matters.</p>
        <p>The price is three-fold. The phase is not linear, which the z-plane chapter explained. The filter has a state that feeds back, so the word that is stored changes the answer. And the poles must stay inside the unit circle with only the coefficients a word can hold. The next steps take the last two in turn, after a way of finding the coefficients.</p>
        <div class="try">Click each IIR row. The Butterworth design touches the pass-band floor exactly; the other two spend their ripple. Compare the number of sections, then the NANDs column.</div>`;
      },
      widget: maskWidget,
      challenge: {
        kind: 'quiz', question: 'How many multiplications a sample does the Chebyshev I design need, at five for each second-order section?',
        get options() { const c = designRows().find((r) => r.id === 'cheby1')!; return [String(c.mults), '14', String(c.mults * 2), String(c.mults * 5)]; },
        answer: 0,
        explain: 'Order 14 is seven sections, and a section has three numerator and two feedback coefficients: 7 × 5.',
        why: ['', 'That is the order, the number of poles. A section holds two poles and multiplies five times.', 'That would give each section ten multiplications.', 'That counts the 35 once more by five.'],
      },
    },
    {
      title: 'From an analog filter to a digital one',
      get body() {
        const lo = warpedAt(TAU * 0.1), hi = warpedAt(TAU * 0.4);
        return `
        <p>Analog filters were designed long before digital ones, and their tables are good. The <strong>bilinear transform</strong> carries one over. Take the analog design's poles and zeros in the s-plane, and map each by <strong>z = (2 + s) / (2 − s)</strong>, for one sample a second. The imaginary axis, which is where an analog filter has its frequency response, becomes the unit circle. The left half-plane, where stable poles live, becomes the inside of the circle. A stable analog filter gives a stable digital one, always.</p>
        <p>All of frequency, from 0 to infinity, is mapped onto half a turn of the circle. So an analog frequency ω lands at <strong>f = atan(ω / 2) / π</strong> cycles a sample: close to ω / 2π while ω is small, and squeezed hard as it grows. The analog zeros at infinity come to rest at z = −1, half the sample rate; that is why a Butterworth design has all its zeros there, and why the chart below shows the count.</p>
        <p>The squeeze moves the edge. Ask for an edge at 0.1 cycles a sample, scale the analog filter by 2π × 0.1 as one would without thinking, and it lands at ${nf(lo, 4)}. At 0.4 it lands at ${nf(hi, 3)}. The cure is to <strong>prewarp</strong>: scale the prototype to 2 tan(π f) instead, which the transform maps back to f exactly. The edges are right and the shape between them is the analog filter's, compressed.</p>
        <p>Chebyshev and elliptic prototypes come from closed forms too, and the elliptic one from elliptic functions of the ripple and the order. Butterworth poles lie on a circle, Chebyshev poles on an ellipse: tests hold the code to both formulas, and to scipy's designs.</p>
        <div class="try">Set the family to Butterworth, order 4, edge 0.4, and switch the prewarp off: the edge lands at ${nf(hi, 3)}. Turn it on and it lands on 0.4. Then look at the zeros on the right for an elliptic filter of order 5.</div>`;
      },
      widget: bilinearWidget,
      challenge: {
        kind: 'quiz', question: 'A designer wants a −3 dB edge at 0.2 cycles a sample from a Butterworth prototype. To what edge, in rad/s at one sample a second, is the prototype scaled before the transform?',
        get options() { return [nf(prewarp(0.2), 3), nf(TAU * 0.2, 3), '0.2', nf(2 * Math.atan(Math.PI * 0.2), 3)]; },
        answer: 0,
        explain: '2 tan(π × 0.2) = 1.453. The transform maps that back to 0.2 exactly; 2π × 0.2 = 1.257 would land lower, at 0.18.',
        why: ['', 'That is the unwarped scaling, ω = 2π f: the edge lands below where it was asked for.', 'That is the frequency itself in cycles, not an analog edge in rad/s.', 'That is the inverse mapping turned the wrong way.'],
      },
    },
    {
      title: 'Where a pole is allowed to sit',
      get body() {
        const k6 = held(RES, 6), k5 = held(RES, 5), k4 = held(RES, 4), nar = stableFrom(NARROW_POLE)!, S = 2 ** -4, r = RES.r, th = RES.f * TAU;
        return `
        <p>A second-order section is y[n] = b₀x[n] + b₁x[n−1] + b₂x[n−2] − a₁y[n−1] − a₂y[n−2]. A pole pair at radius r and angle θ means a₁ = −2r cos θ and a₂ = r². In a register those two are not real numbers: they are multiples of a step. The coefficient format used from here on is <strong>Q2.(b−2)</strong>, a word of b bits whose step is 2<sup>−(b−2)</sup> and whose range is −2 up to 2 minus a step. So <strong>the poles a section can have are the roots for the coefficient pairs on this lattice</strong>, and nothing else. The dots below are those poles, for words of up to 6 bits.</p>
        <p>Look at where they thin out. A step in a₂ moves the radius by about step / 2r, wherever the pole is. A step in a₁ moves the angle by about step / (2r sin θ), which grows as θ falls: the lattice is sparsest near z = 1, which is exactly where a narrow low-pass filter needs its poles. For the pole asked for below, r = ${r} at ${RES.f} cycles a sample, a 6-bit word has neighbouring poles ${nf(S / (2 * r), 3)} apart in radius and ${nf(S / (2 * r * Math.sin(th)) / TAU, 3)} cycles in angle: half of the angle asked for.</p>
        <p>The register takes the nearest values of a₁ and a₂, not the nearest pole. At 6 bits that holds radius ${nf(k6.radius, 3)} for the ${r} asked. At 5 bits, a₂ = ${nf(k6.asked.a2)} rounds to ${nf(k5.a2)}: the pole is <strong>on the circle</strong>, radius ${nf(k5.radius)}, and never stops ringing. At 4 bits, a₁ rounds to ${nf(k4.a1)} too and both roots sit at z = 1, ${k4.state === 'unstable' ? 'a double pole whose response grows' : ''}. The filter whose designer asked for a fast decay now has an oscillator.</p>
        <p>The test for a section is exact and needs no root finder: it is stable when |a₂| < 1 and |a₁| < 1 + a₂, a triangle in the coefficient plane, which a lattice of whole steps either is inside or not. The filter in this chapter's gates is built from sections like this for just that reason: rounding a section's two words can put a pole on the circle, as here, but it cannot throw one far outside.</p>
        <div class="try">Press <em>Resonator</em> and take the word down: ${k6.radius.toFixed(3)} at 6 bits, then radius ${nf(k5.radius)} at 5 and a double root at z = 1 at 4. Then press <em>Narrow</em> (r = ${NARROW_POLE.r} at ${NARROW_POLE.f}) and find the shortest word that keeps it stable: ${nar} bits.</div>`;
      },
      widget: () => planeWidget({
        zeros: [{ r: 1, t: Math.PI }], poles: [{ r: RES.r, t: RES.f * TAU }], taps: true, sound: true, coeffBits: { min: 4, max: 16, start: 6 },
        presets: [
          { name: 'Resonator', zeros: [{ r: 1, t: Math.PI }], poles: [{ r: RES.r, t: RES.f * TAU }] },
          { name: 'Narrow', zeros: [{ r: 1, t: Math.PI }], poles: [{ r: NARROW_POLE.r, t: NARROW_POLE.f * TAU }] },
          { name: 'Quarter rate', zeros: [{ r: 1, t: Math.PI }], poles: [{ r: 0.9, t: TAU / 4 }] },
        ],
      }),
      more: {
        derive: '<p>For a pole pair the roots of z² + a₁z + a₂ are r e<sup>±jθ</sup>, so a₂ = r² and a₁ = −2r cos θ. The stability triangle comes from asking that both roots have |z| < 1: the corner a₂ = 1 is a pair on the circle, a₁ = −(1 + a₂) is a real root at z = 1, and a₁ = 1 + a₂ is one at z = −1.</p>',
      },
      challenge: {
        kind: 'quiz', question: `A pole is asked for at radius ${NARROW_POLE.r} and ${NARROW_POLE.f} cycles a sample. The coefficients are held in 6-bit words (Q2.4). What does the register hold?`,
        get options() { const k = held(NARROW_POLE, 6); return [`A pair on the unit circle at ${nf(k.radius, 3)}`, `Radius ${NARROW_POLE.r}, off by a rounding error in angle`, 'A double pole at z = 1, which grows', 'A pair outside the circle']; },
        answer: 0,
        explain: 'a₂ = 0.980 rounds to 1.000 at a step of 1/16, and a pair with a₂ = 1 lies on the circle. It rings for ever. Eight bits is the first word that holds it stable.',
        why: ['', 'The angle is not the problem: a₂ takes the radius straight to the circle.', 'That needs a₁ = −2 as well, and here a₁ = −1.9375.', 'Rounding takes a₂ to 1.000, no further, and a pair at a₂ = 1 is on the circle.'],
      },
    },
    {
      title: 'One polynomial or small sections',
      get body() {
        const F = narrowFilter(), un = directUnstable(), first = firstStableWidth()!, sen = sensitivity();
        const radii = polyRoots(F.a).map((p) => Math.hypot(p.re, p.im));
        return `
        <p>A sixth-order filter has six poles, and you may build it as one polynomial of degree six, 13 coefficients in all, or as three biquads. They compute the same function in exact arithmetic. This one is a narrow elliptic low-pass: pass edge ${NARROW.f} cycles a sample, ${NARROW.rp} dB, ${NARROW.rs} dB, so its poles crowd close to z = 1, at radii ${nf(Math.min(...radii), 2)} to ${nf(Math.max(...radii), 3)}.</p>
        <p>Round each coefficient to a word of b bits (the largest of them sets how many bits go before the point) and look at the poles. As one polynomial the filter is <strong>unstable at every width from ${un[0]} to ${un[un.length - 1]} bits</strong> and stable from ${first} up to 32. As three sections it is stable at every width from 8 bits up. The responses are in the plot: where the direct form is stable at all, it takes many bits to look like the ideal.</p>
        <p>The reason is the geometry of roots. To first order, a change δ in one coefficient moves a pole by δ × 1 / ∏|pᵢ − pⱼ|, the distances to the other poles. Poles in a tight cluster have small distances and the product is tiny. For the worst pole of this filter the factor is about ${sig(sen.direct)}, so one unit in the last place moves it by as much as that many units. In a section, each pair depends on two coefficients and on its own spacing alone, 1 / (2 Im p): ${sig(sen.sections)} at worst, ${sig(sen.direct / sen.sections)} times smaller.</p>
        <p>Sections cost two multiplications more than the polynomial (${3 * 5} against 13), and in exchange the design can be checked one pair at a time, as step 3 did. All real implementations of high-order IIR filters are built this way. It is also why the mask's Butterworth design above was counted in sections.</p>
        <div class="try">Slide the word from 8 to 32 bits. Find the first width at which the direct form is stable, and look at its response there: it is stable, and is it right? Then look at the sections at 8 bits.</div>`;
      },
      widget: sensitivityWidget,
      challenge: {
        kind: 'quiz', question: 'The sections of the narrow filter are stable at 8 bits. Does that mean the filter is good at 8 bits?',
        options: ['No: stable only says every pole is inside the circle; the response may still be far from the design', 'Yes: stability is the only requirement', 'Yes, but only for the numerator', 'No: sections are never stable at 8 bits'],
        answer: 0,
        explain: 'Rounding still moves the poles within the circle, and a narrow filter\'s response depends on exactly where they are. The plot shows the response at each width; stability is the floor, not the specification.',
        why: ['', 'A stable filter can still miss its mask by any amount.', 'The numerator is exact in this plot: only the feedback is rounded.', 'They are, at every width from 8: the table in the tests says so.'],
      },
    },
    {
      title: 'A biquad in gates',
      get body() {
        const c = biquadCost(), mul = c.mul;
        return `
        <p>Here is one section, built to the format of step 3. It is <strong>direct form I</strong>: the four delay registers hold the last two inputs x[n−1] and x[n−2] and the last two <em>outputs</em> y[n−1] and y[n−2]. The data are Q1.15 words and the coefficients, which are input pins here, Q2.14.</p>
        <p>The sum of products goes through <span data-show="mb0 mb1 mb2 ma1 ma2">five signed multipliers</span>, ${g(mul)} NANDs each, the <span data-show="mul">16 × 16 tree multiplier</span> of the multiplication chapter, giving 32-bit Q3.29 products. Five of them are summed in <span data-show="sum01 sumA sum012 acc">four 35-bit ripple adders</span>: the 32 bits of a product and ${BQ.accW - BQ.prod} guard bits, the log₂ 5 of <a href="#/c/fixed/4">the guard-bit rule</a>. The feedback terms are subtracted by inverting their sum and adding a one, so the word −2, a legal a₁, works. Every bit of every product is kept.</p>
        <p>There is one rounding, <span data-show="round">after the sum</span>: the fourteen low bits come off and the first one dropped is added back, round half up. And there is one clamp, <span data-show="clamp">the saturating clamp</span> of <a href="#/c/fixed/2">the first chapter of this level</a>, widened to look at the top six bits instead of two. A filter whose poles are on the circle can drive the sum off the end, so the clamp stays, and its <code>sat</code> output says when it has acted.</p>
        <p>The whole block is ${g(c.nands)} NANDs, of which ${g(5 * mul)} are multipliers. Static timing gives ${c.depth} NAND delays from one clock edge to the next: the multiplier and three adders in a row. Below, an input goes into the gates and into the model, and every output of the gates is compared with the model's at every clock.</p>
        <div class="try">Choose the resonator and press <em>An impulse</em>: it rings at 0.1 cycles a sample and fades. Then the notch with <em>A tone at 0.2</em>: the output falls to nothing. In both, the status line says the gates matched.</div>`;
      },
      scene: biquadScene,
      lit: '',
      challenge: {
        kind: 'quiz', question: 'Why does the accumulator have 35 bits?',
        options: ['A product is 32 bits, and five products need log₂ 5 → 3 more', 'Five multipliers of 7 bits each', 'The data are 35 bits wide', 'To hold the rounding bits only'],
        answer: 0,
        explain: 'Five terms of at most 2³⁰ add up to less than 2³³, so 34 bits would in fact do; the rule of guard bits gives 35 and is the one the design follows.',
        why: ['', 'The multipliers are 16 bits each, and nothing is 7 bits wide.', 'The data are 16 bits, Q1.15.', 'The accumulator holds the whole sum, with every product bit.'],
      },
    },
    {
      title: 'A limit cycle on the gates',
      get body() {
        const w = LIMIT_CYCLE.words, ys = runBiquad(w, burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, 800)), cy = findCycle(ys, 16)!, db = deadBand(w.a2), a2 = w.a2 / 2 ** BQ.cf;
        return `
        <p>Now put in a single word and then nothing. A stable filter with no input should die away. Set up the gates as a resonator at a quarter of the sample rate (a₁ = 0), radius 0.95, so a₂ = ${w.a2} / 2¹⁴ = ${nf(a2, 4)}, and send one word of ${LIMIT_CYCLE.amp}. The output rings, fades and, from about clock ${cy.start} on, <strong>repeats ${cy.seq.join(', ')} for ever</strong>: ${cy.peak} least significant bits, ${nf(dbfs(cy.peak), 1)} dBFS. This is a <strong>limit cycle</strong>.</p>
        <p>It comes from rounding. With a₁ = 0 the recurrence is y[n] = round(−a₂ y[n−2]). The product of ${cy.peak} with ${nf(a2, 4)} is ${nf(cy.peak * a2, 3)}, which rounds to ${Math.round(cy.peak * a2)} again: the sign flips and the size is kept. The loop would shrink any larger number to the next, but not a number within <strong>½ / (1 − a₂) = ${nf(db, 2)}</strong> of zero, the dead band: every y from 1 to ${Math.floor(db)} maps back onto itself. It is a rounding nonlinearity inside a feedback loop, which an exact computation would not have, and the pole radius is not what keeps the output alive: the radius is 0.95, well inside.</p>
        <p>Rounding is applied to the output <em>and</em> what goes into y[n−1], y[n−2]. Direct form I rounds once, but the rounded value is what circulates. A model beside the gates (dashed) rounds toward zero instead, so the product ${nf(cy.peak * a2, 3)} becomes ${Math.trunc(cy.peak * a2)} and the output falls to zero. The input is the same; only the rounding rule differs.</p>
        <p>The gates and the model agree at every clock, including the cycle. That is checked by the test, not only by the panel: the test runs the same ${LIMIT_CYCLE.cycles} clocks, and also the gate variant that rounds toward zero (${g(stats(biquad('zero')).nands)} NANDs, ${stats(biquad('zero')).nands - stats(biquad()).nands} more), which does die away.</p>
        <div class="try">Press the button. Watch the output decay from ${ys[0]}, then look at the last forty clocks, enlarged: ${cy.seq.join(' ')}. The dashed line, the model that rounds toward zero, lies on zero.</div>`;
      },
      scene: cycleScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run the limit cycle: send the word, then silence.',
        check: (st) => st.value('y') !== undefined && Math.abs(st.value('y') > 32767 ? st.value('y') - 65536 : st.value('y')) <= 5 && st.sim!.time > 0,
        hints: ['Press the button in the panel.', 'It runs 140 clocks and the output ends on the pattern.'],
        answer: 'Press the button: the output falls from 500 to a few units, and then repeats 5, 0, −5, 0 for ever.',
      },
    },
    {
      title: 'What removes a limit cycle',
      get body() {
        const sw = cycleSweep(), nearCycle = findCycle(runBiquad(NEAR_CIRCLE, burstThenSilence(NEAR_INPUT.amp, NEAR_INPUT.burst, 4000), { round: 'zero' }), 16)!;
        const row = (i: number) => `${sw.cycling[i]} of ${sw.runs}`;
        return `
        <p>Not the accumulator. It is already exact: every bit of every product is added, and the one rounding comes after the sum. A wider accumulator would hold a longer number and then round it just the same. What sustains the cycle is that the <em>rounded</em> output is what the filter feeds back.</p>
        <p>The model can try the alternatives, run for run on the same inputs. The search below has ${SWEEP_RUNS} cases: pole radius 0.90 to 0.97 and eleven angles, two sizes of input word and two lengths, then silence. How many end in a repeating non-zero output, with ${SWEEP_VARIANTS.map((v, i) => `${v.name}: <strong>${row(i)}</strong>`).join('; ')}.</p>
        <p>So rounding toward zero removes the cycle for all of these, because it never rounds a value away from zero: the loop cannot hold a number up. Keeping extra bits in y[n−1] and y[n−2] helps a great deal and removes nothing by itself; it is also a different structure from the gates, with wider registers and a second rounding, so it is a labelled model here and not built. Floor, which is just dropping the bits and is the cheapest rounding there is, helps a little.</p>
        <p>Toward zero is not a cure. Move the pole very close to the circle, radius 0.998, with a₁ = ${NEAR_CIRCLE.a1} and a₂ = ${NEAR_CIRCLE.a2} in the words, and give it one input of ${NEAR_INPUT.amp}: toward zero then sustains a cycle of period ${nearCycle.period} and ${nearCycle.peak} LSB. The decay per sample is so slow that a pole this close needs the output to fall nearly to nothing before it stops, and rounding toward zero loses too little each time to get there. Everything here is a sweep of the model on the pole positions listed: it does not prove that other pole positions are free of a cycle.</p>
        <p>Listen for it. The button plays the cycle alone, from the model, scaled up to the player's level, so what you hear is far louder than ${nf(dbfs(deadBand(LIMIT_CYCLE.words.a2) | 0), 0)} dBFS. The level is on the screen beside it.</p>
        <div class="try">With the defaults (radius 0.95, angle 0.25, half up) read the cycle. Switch to Toward zero: it dies. Switch back, raise the extra bits to 4: it dies, and at 2 it lives, at 1 LSB. Then press <em>Near the circle</em> and switch to toward zero: it sustains.</div>`;
      },
      widget: limitCycleWidget,
      challenge: {
        kind: 'quiz', question: 'A filter cycles on its rounding. Which change is most likely to help, in the cases swept here?',
        options: ['Round toward zero', 'Widen the accumulator', 'Move the clamp before the rounding', 'Use a faster clock'],
        answer: 0,
        explain: 'Toward zero never rounds away from zero, and ended with no cycle in all the cases swept except those very near the circle. The others do not touch the rounding that is fed back.',
        why: ['', 'The accumulator is already exact before the rounding.', 'The clamp acts on values that do not fit, and the cycle is a few LSB.', 'The rate has no part in the recurrence.'],
      },
    },
    {
      title: 'Sections in a cascade',
      get body() {
        const D = orderData(), best = [...D.rows].sort((a, b) => b.snrScaled - a.snrScaled), rawBest = [...D.rows].sort((a, b) => b.snrRaw - a.snrRaw);
        const def = D.rows.find((r) => r.p.join('') === '0123')!;
        return `
        <p>The mask's elliptic filter is ${D.base.length} sections one after another, each with its own rounding. Two decisions are left: the <strong>scale</strong> of each section and their <strong>order</strong>.</p>
        <p>Each section sees the signal after the sections before it. The peak gain from the input to the output of each of them decides how big a sine can be before that section's word overflows. In the order poles-farthest-first, which the design tool returns, the peaks are ${def.raw.length ? '' : ''}${(() => { const ps = (D.rows.find((r) => r.p.join('') === '0123')!); return ps ? '' : ''; })()}small at first and grow to 1 at the end, so a full-scale sine fits, but most of the word is empty in the early sections and their output is noise-limited. <strong>Scaling</strong> multiplies each section's numerator so that the peak to every output is 1: no overflow, and every word uses its range. It is free in hardware, since it changes only the b coefficients, and it is the largest effect here: ${nf(def.snrScaled - def.snrRaw, 1)} dB of signal to rounding noise on this order, ${nf(def.snrRaw, 1)} → ${nf(def.snrScaled, 1)}.</p>
        <p>The noise from each rounding passes through its own section's 1 / A and through the sections after it, so the order matters too. With scaling the ${D.rows.length} orders span ${nf(best[best.length - 1].snrScaled, 1)} to ${nf(best[0].snrScaled, 1)} dB, ${nf(best[0].snrScaled - best[best.length - 1].snrScaled, 1)} dB apart. The usual rule, poles nearest the circle last, comes ${best.findIndex((r) => r.p.join('') === '0123') + 1}th of ${D.rows.length} here. Without scaling it is the best order (${nf(rawBest[0].snrRaw, 1)} dB) because it keeps the peaks low, and the worst orders overflow a full-scale sine many times over. The model and the figure agree: the predicted noise is a frequency-domain integral and the check runs the biquad model on a sine.</p>
        <p>Scaling to a gain of 1 protects against sines. Protecting against any bounded input takes the sum of the impulse response's absolute values, as in <a href="#/c/fixed/5">the scaling step</a>, and costs bits.</p>
        <div class="try">Click the best and the worst bar with scaling on, then uncheck scaling: the bars reorder, and the first section's peak goes above 1 for most orders.</div>`;
      },
      widget: orderWidget,
      challenge: {
        kind: 'quiz', question: 'A designer scales each section of a cascade so that a full-scale sine reaches every output at gain 1. What does that change in the hardware?',
        options: ['Only the numerator coefficients b₀, b₁, b₂ of each section', 'The feedback coefficients a₁, a₂', 'The word width of every register', 'The order of the sections'],
        answer: 0,
        explain: 'A numerator is scaled by a constant, and the poles, which are in a₁ and a₂, do not move. The multipliers are the same size.',
        why: ['', 'Scaling the feedback would move the poles and change the filter.', 'The words stay Q1.15: that is the point, to fill them.', 'The order is a separate choice, made for noise.'],
      },
    },
  ],
};
void coefWord; void treeMul;
