// IIR and stability: what feedback buys on one specification, the bilinear transform, a pole held in a register, direct form against sections, a biquad in gates,
// a limit cycle on those gates, what removes it, and the order and scaling of sections. The gates are lib/biquad.ts, equal to dsp/iir.ts at every clock
// (tests/dsp-iir-gates.test.ts); the design half is held to scipy (tests/dsp-iir.test.ts); what the text claims is tests/dsp-iir-chapter.test.ts.

import {
  BQ, burstThenSilence, coefWord, cycleSweep, deadBand, deltaPass, findCycle, LIMIT_CYCLE, MASK, runBiquad, SWEEP_RUNS, SWEEP_VARIANTS, warpedAt, prewarp, zeroSweep,
} from '../dsp/iir';
import { biquad } from '../lib/biquad';
import { stats } from '../sim/stats';
import { treeMul } from '../lib/muldiv';
import {
  biquadCost, NEAR_CIRCLE, NEAR_INPUT, biquadScene, cycleScene, dbfs, designRows, bilinearWidget, firstStableWidth, limitCycleWidget, maskWidget, mulNands, narrowFilter, NARROW, orderData, orderWidget,
  sensitivityWidget,
} from '../widgets/dspiir';
import { heldPair, planeWidget } from '../widgets/dspzplane';
import { directStable } from '../dsp/iir';
import { polyRoots } from '../dsp/zplane';
import { DSP_LEVEL } from './dspladder';
import { numOf } from './order';
import type { Chapter } from './types';

/** A figure to one significant digit, written plainly: 6, 500. */
const about = (v: number): string => { const p = 10 ** Math.floor(Math.log10(Math.abs(v))); return String(Math.round(v / p) * p).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); };
const TAU = 2 * Math.PI;
const g = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const nf = (v: number, d = 3) => v.toFixed(d);
/** 21 → '21st': the order of one section order among the 24. */
export const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10]}`;
const once = <T>(f: () => T): (() => T) => { let v: T | undefined, done = false; return () => (done ? (v as T) : ((done = true), (v = f()))); };
/** The two sweeps are run once, on first use: the 176-case one with its five variants, and the finer one for rounding toward zero. */
export const sweepOnce = once(() => cycleSweep());
export const zeroSweepOnce = once(() => zeroSweep());
const sig = (v: number) => v.toExponential(0).replace(/e\+?(-?\d+)/, ' × 10<sup>$1</sup>');

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

export { NEAR_CIRCLE, NEAR_INPUT };

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
  builds: ['zplane', 'firdesign', 'fixed', 'muldiv'],
  recap: {
    keep: [
      'An IIR filter spends its multiplications on poles. For one mask the elliptic design needs 20 multiplications a sample, against 58 for the shortest odd-length symmetric FIR filter, folded (16 against 58 if the sections fold their symmetric numerators too): but its phase is not linear, and its poles must stay inside the unit circle with the coefficients a register can hold.',
      'The bilinear transform s → (2 + s) / (2 − s) maps the left half of the s-plane into the unit circle, so a stable analog filter gives a stable digital one. It squeezes frequency, f = atan(ω / 2) / π, so the analog edge is prewarped to 2 tan(π f).',
      'A second-order section holds its poles in two words: a₁ = −2r cos θ and a₂ = r². A word of b bits has a step of 2^−(b−2), so poles sit on a lattice, sparsest near z = 1, where narrow filters need them. The section is stable exactly inside the triangle |a₂| < 1, |a₁| < 1 + a₂.',
      'Poles of a high-order polynomial that lie close together move enormously when a coefficient is rounded. The narrow elliptic filter of this chapter is unstable as one polynomial at every width from 8 to 19 bits, and stable as three sections at every width.',
      `The biquad in gates is direct form I: five signed multipliers, a ${BQ.accW}-bit accumulator that keeps every product bit, one rounding and one clamp, and four delay registers. ${g(stats(biquad()).nands)} NANDs, equal to the model at every clock.`,
      'A limit cycle is rounding inside a feedback loop sustaining an output with no input. For a₁ = 0 it is bounded by the dead band ½ / (1 − a₂), and rounding toward zero removes it (a proof: |y[n]| < |y[n−2]|); for a₁ ≠ 0 neither holds as a rule. In the sweeps here toward zero left no cycle up to radius 0.975 and rare ones from 0.98; a wider accumulator removes nothing, since the rounding comes after it.',
      'Cascaded sections need scaling and an order. Scaling the numerators so that a full-scale sine reaches every output at gain 1 prevents overflow and adds noise margin; the order moves the output noise by a few dB.',
    ],
    check: [
      {
        question: 'A mask asks for a sharp transition at a low frequency. Which costs the fewest multiplications a sample?',
        options: ['An elliptic IIR filter in second-order sections', 'A Butterworth IIR filter in second-order sections', 'A window FIR filter', 'They cost the same: a mask fixes the multiplications'],
        answer: 0,
        get explain() { const r = designRows(), by = (id: string) => r.find((x) => x.id === id)!; return `For equal specifications the elliptic design has the lowest order, since its ripples in both bands are spent on steepness: ${by('ellip').mults} multiplications, against ${by('pm').mults} for the shortest folded FIR filter (${nf(by('pm').mults / by('ellip').mults, 1)} times) and ${by('butter').mults} for Butterworth (${nf(by('butter').mults / by('ellip').mults, 1)} times).`; },
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
        <p><a href="#/c/zplane/4">Poles make it ring</a>, a step of the z-plane chapter, showed what a pole pair buys: two multiplications for a sharpness that an FIR filter needs many taps for. Here it is worked on one specification: the mask that <a href="#/c/firdesign/0">chapter ${numOf('firdesign')}</a> met with symmetric taps, met again with feedback.</p>
        <p>The mask: pass to <strong>${MASK.fp}</strong> cycles a sample with ${MASK.rp} dB of ripple, stop from <strong>${MASK.fs}</strong> with at least ${MASK.rs} dB. Tools such as scipy quote edges as fractions of Nyquist, half the sample rate, so this is 0.2 and 0.25 there. The transition band is ${nf(MASK.fs - MASK.fp)} of the sample rate wide. The ripple is <strong>peak to peak</strong>, as scipy's Chebyshev and elliptic <code>rp</code> is: an IIR design's pass band runs from 0 dB down to −${MASK.rp}, and an FIR filter's gain stays within 1 ± ${nf(deltaPass(), 5)}, centred on 1, which is ${MASK.rp} dB from top to bottom.</p>
        <p>A symmetric FIR filter that meets it needs, as chapter ${numOf('firdesign')} found, ${pm.size} (the shortest odd length a search found with scipy's equiripple design; an even 114 also meets it) or ${ka.size} by the window estimate. Folded, so that tap pairs share a multiplier, that is ${pm.mults} and ${ka.mults} multiplications a sample. Three classical families of IIR design trade the shape of the ripple against the number of poles, the filter's <strong>order</strong>. <strong>Butterworth</strong> is flat in both bands, with no ripple at all, and needs the most; <strong>Chebyshev I</strong> ripples in the passband only; <strong>elliptic</strong> ripples in both bands and needs the fewest. A <strong>section</strong> is one biquad, two poles and two zeros, so an order-n filter takes about n / 2 of them. The three need an order of ${bu.size.match(/\d+/)![0]} (Butterworth), ${ch.size.match(/\d+/)![0]} (Chebyshev I) and ${el.size.match(/\d+/)![0]} (elliptic), built as ${bu.size.split(', ')[1]}, ${ch.size.split(', ')[1]} and ${el.size.split(', ')[1]}, at five multiplications each, as the biquad of step 5 is built. The elliptic filter needs <strong>${el.mults}</strong>: ${nf(pm.mults / el.mults, 1)} times fewer than the shortest FIR filter. The numerators of these IIR sections are symmetric too (b₀ = b₂), so a section could fold like the FIR taps and spend four: the elliptic filter would then need ${el.folded}, ${nf(pm.mults / el.folded!, 1)} times fewer. The table counts the sections as built, which is the more cautious comparison.</p>
        <p>Counted in gates, with a 16 × 16 signed multiplier at ${g(mul)} NANDs for each multiplication, that is ${g(el.mults * mul)} against ${g(pm.mults * mul)}. This counts multipliers alone, one for each multiplication, which nobody would build for a filter this slow: adders, registers and sharing one multiplier over time are not here. The ratio is what matters.</p>
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
        <p>All of frequency, from 0 to infinity, is mapped onto half a turn of the circle. So an analog frequency ω lands at <strong>f = atan(ω / 2) / π</strong> cycles a sample: close to ω / 2π while ω is small, and squeezed hard as it grows. The analog zeros at infinity come to rest at z = −1, half the sample rate; that is why a Butterworth design has all its zeros there, and why the picture and the chip below show the count.</p>
        <p>The squeeze moves the edge. Ask for an edge at 0.1 cycles a sample, scale the analog filter by 2π × 0.1 as one would without thinking, and it lands at ${nf(lo, 4)}. At 0.4 it lands at ${nf(hi, 3)}. The cure is to <strong>prewarp</strong>: scale the prototype to 2 tan(π f) instead, which the transform maps back to f exactly. The edges are right and the shape between them is the analog filter's, compressed.</p>
        <p>Chebyshev and elliptic prototypes come from closed forms too, and the elliptic one from elliptic functions of the ripple and the order. Butterworth poles lie on a circle, Chebyshev poles on an ellipse: tests hold the code to both formulas, and to scipy's designs.</p>
        <div class="try">Set the family to Butterworth, order 4, edge 0.4, and switch the prewarp off: the edge lands at ${nf(hi, 3)}. Turn it on and it lands on 0.4. Every analog pole stays in the left half of the s-plane (a cross turns red only where it would not). Then choose Elliptic, order 5: on the right the zeros lie on the circle in pairs and the last one sits at z = −1, which the chip counts as 1 of 5.</div>`;
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
        <p>A second-order section is y[n] = b₀x[n] + b₁x[n−1] + b₂x[n−2] − a₁y[n−1] − a₂y[n−2]. A pole pair at radius r and angle θ means a₁ = −2r cos θ and a₂ = r². In a register those two are not real numbers: they are multiples of a step. The coefficient format used from here on is <strong>Q2.(b−2)</strong>, a word of b bits whose step is 2<sup>−(b−2)</sup> and whose range is −2 up to 2 minus a step. So <strong>the poles a section can have are the roots for the coefficient pairs on this lattice</strong>, and nothing else. The dots in the picture are those poles, for words of up to 6 bits.</p>
        <p>Look at where they thin out. A step in a₂ moves the radius by about step / 2r, wherever the pole is. A step in a₁ moves the angle by about step / (2r sin θ), which grows as θ falls: the lattice is sparsest near z = 1, which is exactly where a narrow low-pass filter needs its poles. For the pole asked for below, r = ${r} at ${RES.f} cycles a sample, a 6-bit word has neighbouring poles ${nf(S / (2 * r), 3)} apart in radius and ${nf(S / (2 * r * Math.sin(th)) / TAU, 3)} cycles in angle: half of the angle asked for.</p>
        <p>The register takes the nearest values of a₁ and a₂, not the nearest pole. At 6 bits that holds radius ${nf(k6.radius, 3)} for the ${r} asked. At 5 bits, a₂ = ${nf(k6.asked.a2)} rounds to ${nf(k5.a2)}: the pole is <strong>on the circle</strong>, radius ${nf(k5.radius)}, and never stops ringing. At 4 bits, a₁ rounds to ${nf(k4.a1)} too and both roots sit at z = 1, ${k4.state === 'unstable' ? 'a double pole whose response grows' : ''}. The filter whose designer asked for a fast decay now has an oscillator.</p>
        <p>The test for a section is exact and needs no root finder: it is stable when |a₂| < 1 and |a₁| < 1 + a₂, a triangle in the coefficient plane, and a pair of words is inside it or not, checked exactly on the integers. Both inequalities are strict: a₂ = 1 is a pair on the circle, which is not stable. The gates of step 5 are one such section, with its coefficients on pins, so any pair of words from this lattice can be loaded into it.</p>
        <div class="try">Press <em>Resonator</em> and take the word down: ${k6.radius.toFixed(3)} at 6 bits, then radius ${nf(k5.radius)} at 5 and a double root at z = 1 at 4. Then press <em>Narrow</em> (r = ${NARROW_POLE.r} at ${NARROW_POLE.f}) and find the shortest word that keeps it stable: ${nar} bits. At ${nar - 1} bits the words land exactly on the triangle's other edge, a₁ = −(1 + a₂): a root at z = 1, still not stable.</div>`;
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
        <p>Round each coefficient to a word of b bits (the largest of them sets how many bits go before the point) and look at the poles. As one polynomial the filter is <strong>unstable at every width from ${un[0]} to ${un[un.length - 1]} bits</strong> and stable from ${first} up to 32. As three sections it is stable at every width from 8 bits up. The responses are in the plot: where the direct form (one polynomial, the coefficients as written) is stable at all, it takes many bits to look like the ideal.</p>
        <p>The reason is the geometry of roots. To first order, a change δ in one coefficient moves a pole by δ × 1 / ∏|pᵢ − pⱼ|, the distances to the other poles. Poles in a tight cluster have small distances and the product is tiny. For the worst pole of this filter the factor is about ${sig(sen.direct)}, so one unit in the last place moves it by as much as that many units. In a section, each pair depends on two coefficients and on its own spacing alone, 1 / (2 Im p): about ${about(sen.sections)} at worst, about ${about(sen.direct / sen.sections)} times smaller.</p>
        <p>Sections cost two multiplications more than the polynomial (${3 * 5} against 13), and in exchange the design can be checked one pair at a time, as step 3 did. A cascade of second-order sections is a common way to build a high-order IIR filter (lattice and wave-digital structures are others, left out here). It is also why the mask's Butterworth design above was counted in sections.</p>
        <div class="try">Slide the word from 8 to 32 bits. Find the first width at which the direct form is stable, and look at its response there: it is stable, and is it right? Then look at the sections at 8 bits.</div>`;
      },
      widget: sensitivityWidget,
      challenge: {
        kind: 'quiz', question: 'The sections of the narrow filter are stable at 8 bits. Does that mean the filter is good at 8 bits?',
        options: ['No: stable only says every pole is inside the circle; the response may still be far from the design', 'Yes: stability is the only requirement', 'Yes, but only for the numerator', 'No: sections are never stable at 8 bits'],
        answer: 0,
        explain: 'Rounding still moves the poles within the circle, and a narrow filter\'s response depends on exactly where they are. The plot shows the response at each width; stability is the floor, not the specification.',
        why: ['', 'A stable filter can still miss its mask by any amount.', 'The numerator is exact in this plot: only the feedback is rounded.', 'They are, at every width from 8 (the slider\'s lowest): the chip says so.'],
      },
    },
    {
      title: 'A biquad in gates',
      get body() {
        const c = biquadCost(), mul = c.mul;
        return `
        <p>Here is one section, built to the format of step 3. It is <strong>direct form I</strong>: the four REG16 delay registers hold the last two inputs x[n−1] and x[n−2] and the last two <em>outputs</em> y[n−1] and y[n−2] (the multipliers are named by their products, b₀ x[n] and so on, when the drawing is large enough to show names). The data are Q1.15 words and the coefficients, which are input pins here, Q2.14.</p>
        <p>The sum of products goes through <span data-show="mb0 mb1 mb2 ma1 ma2">five signed multipliers</span> (the MUL16 boxes), ${g(mul)} NANDs each, the 16 × 16 tree multiplier of the multiplication chapter, giving 32-bit Q3.29 products. Five of them are summed in <span data-show="sum01 sumA sum012 acc">four 35-bit ripple adders</span> (ADD35): the 32 bits of a product and ${BQ.accW - BQ.prod} guard bits, the log₂ 5 of <a href="#/c/fixed/5">the guard-bit rule</a>. The feedback terms are subtracted by inverting their sum (the NOT box) and adding a one, so the word −2, a legal a₁, works. Every bit of every product is kept.</p>
        <p>There is one rounding, <span data-show="round">after the sum</span> (the ROUND box): the fourteen low bits come off and the first one dropped is added back, round half up. And there is one clamp, <span data-show="clamp">the saturating clamp</span> (CLAMP) of <a href="#/c/fixed/2">Numbers that fit</a>, widened to look at the top six bits instead of two. A filter whose poles are on the circle can drive the sum off the end, so the clamp stays, and its <code>sat</code> output says when it has acted.</p>
        <p>The whole block is ${g(c.nands)} NANDs, of which ${g(5 * mul)} are multipliers. Static timing gives ${c.depth} NAND delays from one clock edge to the next: a multiplier, then the sum of five products as three adders in a row (with an inverter on the feedback side), then the rounder and the clamp. Below, an input goes into the gates and into the model, and every output of the gates is compared with the model's at every clock.</p>
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
        <p>It comes from rounding. With a₁ = 0 the recurrence is y[n] = round(−a₂ y[n−2]). The product of ${cy.peak} with ${nf(a2, 4)} is ${nf(cy.peak * a2, 3)}, which rounds to ${Math.round(cy.peak * a2)} again: the sign flips and the size is kept. The loop would shrink any larger number to the next, but not a number within <strong>½ / (1 − a₂) = ${nf(db, 2)}</strong> of zero, the dead band: every y from 1 to ${Math.floor(db)} maps back onto itself. This formula is for a₁ = 0 only; with a₁ ≠ 0 the cycle can be far larger than it says. It is a rounding nonlinearity inside a feedback loop, which an exact computation would not have, and the pole radius is not what keeps the output alive: the radius is 0.95, well inside.</p>
        <p>Rounding is applied to the output <em>and</em> what goes into y[n−1], y[n−2]. Direct form I, whose delays hold past inputs and past outputs as in <a href="#/c/zplane/0">chapter ${numOf('zplane')}</a>'s difference equation, rounds once, but the rounded value is what circulates. A model beside the gates (orange) rounds toward zero instead, so the product ${nf(cy.peak * a2, 3)} becomes ${Math.trunc(cy.peak * a2)} and the output falls to zero. The input is the same; only the rounding rule differs. For a₁ = 0 this is a proof, not a sample: y[n] depends on y[n−2] alone, and rounding toward zero gives |y[n]| < |y[n−2]| until zero, so no cycle can survive.</p>
        <p>The gates and the model agree at every clock, including the cycle. That is checked by the test, not only by the panel: the test runs the same ${LIMIT_CYCLE.cycles} clocks, and also the gate variant that rounds toward zero (${g(stats(biquad('zero')).nands)} NANDs, ${stats(biquad('zero')).nands - stats(biquad()).nands} more), which does die away.</p>
        <div class="try">Press the button. Watch the output decay from ${ys[0]}, then look at the last forty clocks, enlarged: ${cy.seq.join(' ')}. The orange line, the model that rounds toward zero, lies on zero.</div>`;
      },
      scene: cycleScene,
      lit: '',
      challenge: {
        kind: 'quiz', question: 'After the input stops, the output repeats 5, 0, −5, 0. What is the pole radius doing, and what keeps the output alive?',
        options: ['The radius is 0.95, inside the circle; the rounding of the fed-back output keeps it alive', 'The radius has reached 1 through rounding of a₂', 'A bug: the gates disagree with the model', 'The input did not really stop'],
        answer: 0,
        explain: 'The coefficients are the same exact words throughout, a₂ = 14 787 / 2¹⁴ = 0.9025 = r². The cycle is the rounding nonlinearity inside the loop, and the model reproduces it exactly.',
        why: ['', 'The words do not change while the filter runs: a₂ is what it was.', 'Gates and model agree at every clock, including the cycle.', 'The input was one word and then zeros.'],
      },
    },
    {
      title: 'What removes a limit cycle',
      get body() {
        const sw = sweepOnce(), zs = zeroSweepOnce(), nearCycle = findCycle(runBiquad(NEAR_CIRCLE, burstThenSilence(NEAR_INPUT.amp, NEAR_INPUT.burst, 4000), { round: 'zero' }), 16)!;
        const row = (i: number) => `${sw.cycling[i]} of ${sw.runs}`;
        const zlow = zs.filter((x) => x.r <= 0.975), zlowRuns = zlow.reduce((n, x) => n + x.runs, 0), zlowCyc = zlow.reduce((n, x) => n + x.cycling, 0);
        const zhi = zs.filter((x) => x.r >= 0.98).map((x) => `${x.r}: ${x.cycling}`).join(', '), zcase = findCycle(runBiquad({ b0: 1024, b1: 0, b2: 0, a1: coefWord(-2 * 0.98 * Math.cos(TAU * 0.09)), a2: coefWord(0.98 * 0.98) }, burstThenSilence(1000, 3, 4000), { round: 'zero' }), 32)!;
        return `
        <p>Not the accumulator. It is already exact: every bit of every product is added, and the one rounding comes after the sum. A wider accumulator would hold a longer number and then round it just the same. What sustains the cycle is that the <em>rounded</em> output is what the filter feeds back.</p>
        <p>The model can try the alternatives, run for run on the same inputs. The search below has ${SWEEP_RUNS} cases: pole radius 0.90, 0.93, 0.95 and 0.97 as asked (the words round them), eleven angles from 0.02 to 0.45 cycles a sample, input words of 8000 and 30000, bursts of 1 and 3 samples, then silence for 800 clocks. How many end in a repeating non-zero output, with ${SWEEP_VARIANTS.map((v, i) => `${v.name}: <strong>${row(i)}</strong>`).join('; ')}.</p>
        <p>Rounding toward zero ends with no cycle in any of these. For a₁ = 0 that is a proof (step 6); for a₁ ≠ 0 it is only the result of this sweep, because y[n] then depends on y[n−1] and y[n−2] together, and rounding toward zero only says that y[n] is no larger than the unrounded sum of them, not that the output never exceeds an earlier one. Keeping extra bits in y[n−1] and y[n−2] helps a great deal and still leaves ${sw.cycling[3]} of ${sw.runs} cycling; it is also a different structure from the gates, with wider registers and a second rounding, so it is a labelled model here and not built. Floor, which is just dropping the bits and is the cheapest rounding there is, removes about two thirds of the cycles (${sw.cycling[0]} to ${sw.cycling[1]} of ${sw.runs}) and leaves the rest.</p>
        <details class="deeper"><summary>Toward zero is not a cure: a finer sweep</summary><p>Toward zero is not a cure. A finer sweep went further toward the circle with that rounding alone: radius 0.90, 0.93, 0.95, 0.97, 0.975, 0.98, 0.985, 0.99 and 0.995, forty-nine angles (0.01 to 0.49 cycles a sample), input words of 1 000, 8 000 and 30 000, bursts of 1 and 3, 4 000 clocks: ${zs[0].runs} runs a radius. Up to 0.975, ${zlowCyc} of ${zlowRuns} ended in a cycle. From 0.98 a few did (radius: runs cycling, of ${zs[0].runs} each, ${zhi}). One is radius 0.98 at 0.09 cycles a sample, one input word of 1 000 three times: period ${zcase.period}, ${zcase.peak} LSB. They are rare and depend on the angle and the input, so this gives no safe radius, only where the grids found none. The preset <em>Near the circle</em> is another: radius 0.9983 (a₁ = ${NEAR_CIRCLE.a1} and a₂ = ${NEAR_CIRCLE.a2} in the words), two inputs of ${NEAR_INPUT.amp}: period ${nearCycle.period}, ${nearCycle.peak} LSB. These are sweeps of the model on the positions listed; they do not show that other positions are free of a cycle.</p></details>
        <p>Listen for it. The button plays the cycle alone, from the model, scaled up to the player's level, so what you hear is far louder than ${nf(dbfs(deadBand(LIMIT_CYCLE.words.a2) | 0), 0)} dBFS. The level is on the screen beside it.</p>
        <div class="try">With the defaults (radius 0.95, angle 0.25, half up) read the cycle. Switch to Toward zero: it dies. Switch back, raise the extra bits to 4: it dies, and at 2 it lives, at 1 LSB. Then press <em>Near the circle</em>, which selects toward zero: it sustains. The dead-band chip reads a number only for a₁ = 0 (angle 0.25), and says so otherwise.</div>`;
      },
      widget: limitCycleWidget,
      challenge: {
        kind: 'quiz', question: 'A filter cycles on its rounding. Which change is most likely to help, in the cases swept here?',
        options: ['Round toward zero', 'Widen the accumulator', 'Move the clamp before the rounding', 'Use a faster clock'],
        answer: 0,
        explain: 'Toward zero ended with no cycle in all 176 cases of the sweep (radius up to 0.97), and in the finer sweep up to 0.975; from 0.98 it still cycled in a few runs. The others do not touch the rounding that is fed back.',
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
        <p>Each section sees the signal after the sections before it. The peak gain from the input to the output of each of them decides how big a sine can be before that section's word overflows. In the order the design tool returns, poles farthest from the circle first, the peaks are small at first and grow to 1 at the end, so a full-scale sine fits, but most of the word is empty in the early sections and their output is noise-limited. <strong>Scaling</strong> multiplies each section's numerator so that the peak to every output is 1: no overflow, and every word uses its range. It is free in hardware, since it changes only the b coefficients, and it is the largest effect here: ${nf(def.snrScaled - def.snrRaw, 1)} dB of signal to rounding noise on this order, ${nf(def.snrRaw, 1)} → ${nf(def.snrScaled, 1)}.</p>
        <p>The noise from each rounding passes through its own section's 1 / A and through the sections after it, so the order matters too. With scaling the ${D.rows.length} orders span ${nf(best[best.length - 1].snrScaled, 1)} to ${nf(best[0].snrScaled, 1)} dB, ${nf(best[0].snrScaled - best[best.length - 1].snrScaled, 1)} dB apart. A rule of thumb that puts the poles nearest the circle last comes ${ordinal(best.findIndex((r) => r.p.join('') === '0123') + 1)} of ${D.rows.length} here once the sections are scaled. Without scaling it is the best order (${nf(rawBest[0].snrRaw, 1)} dB) because it keeps the peaks low, and the worst orders overflow a full-scale sine many times over. Take it as a rule of thumb: one filter cannot prove it. The model and the figure agree to within 2 dB on every one of the 24 orders, scaled or not: the predicted noise is a frequency-domain integral, and the check runs the biquad model on a sine at the same amplitude.</p>
        <p>Scaling to a gain of 1 protects against sines. Protecting against any bounded input takes the sum of the impulse response's absolute values, as in <a href="#/c/fixed/6">the scaling step</a>, and costs bits.</p>
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
