// The z-plane: a filter as a difference equation, as a convolution, and as a picture of poles and zeros. No gates here: all of it is dsp/zplane.ts, which
// tests/dsp-zplane.test.ts holds to scipy; the next chapters build what this one reads. What the text claims is tests/dsp-zplane-chapter.test.ts.

import { convolve, gainAt, polyRoots } from '../dsp/zplane';
import { binomialGain, FIR_TAPS } from '../comm/signals';
import { CONV_H, CONV_X, convolutionWidget, delayWidget, equationWidget, inner, outer, planeWidget, settleSamples } from '../widgets/dspzplane';
import { DSP_LEVEL } from './dspladder';
import { numOf } from './order';
import type { Chapter } from './types';

const nf = (v: number, d = 3) => v.toFixed(d);
const TAU = 2 * Math.PI;
const FIR5_ZEROS = [{ r: 1, t: Math.PI }, { r: 1, t: Math.PI }];
const NOTCH_T = 0.2 * TAU;
const RES = { r: 0.97, t: 0.04 * TAU };
const CONV_Y = convolve(CONV_X, CONV_H);

export const chZplane: Chapter = {
  id: 'zplane', num: numOf('zplane'), title: 'The z-plane', level: DSP_LEVEL,
  blurb: 'One picture that holds a filter: difference equations and convolution, the z-transform, zeros that remove a frequency, poles that ring, stability, and why two filters with the same gain can sound different.',
  goals: [
    'step a difference equation by hand, and say how much it costs a sample',
    'compute a filter\'s output as a convolution with its impulse response',
    'read a filter\'s gain off the plane, as distances to its zeros over distances to its poles',
    'tell from a pole\'s radius whether a filter is stable, and how long it rings',
    'say what linear phase needs of the zeros, and what it costs in delay',
  ],
  builds: ['signals', 'fixed'],
  recap: {
    keep: [
      'A linear, time-invariant filter is y[n] = Σ b[k] x[n−k] − Σ a[k] y[n−k]. No a terms makes it FIR; with them it is IIR. Its cost is one multiplication per coefficient and one word of memory per delay.',
      'Its output is the input convolved with its impulse response: slide, multiply, add. Convolving in time is multiplying in frequency.',
      'z⁻¹ is one sample of delay, so a filter is a ratio of two polynomials in it, B(z) / A(z). Its response at f is that ratio at z = e^(j2πf), on the unit circle.',
      'Roots of B are zeros and roots of A are poles. Gain at f is the product of distances to the zeros over the product of distances to the poles. A zero on the circle removes that frequency; a pole close to it makes a peak there.',
      `A pole of radius r decays as rⁿ: every pole must be inside the circle for stability, and about ${settleSamples(0.97)} samples to fall to 1 % at r = 0.97. FIR filters have no poles to worry about.`,
      'A zero and its mirror image across the circle have the same gain shape and different delay. Pairing every zero with its mirror gives symmetric taps and linear phase: one delay for every frequency, (N − 1) / 2 samples for N taps.',
    ],
    check: [
      {
        question: 'A filter has one pole pair at radius 0.9, at an angle of a tenth of a cycle a sample. Roughly what does its output do after an impulse?',
        options: ['Rings at a tenth of the sample rate, and falls by 0.9 each sample', 'Holds at 0.9 for ever', 'Stops after two samples, since it has two poles', 'Grows, since a resonance adds energy'],
        answer: 0,
        explain: 'The angle gives the ringing frequency and the radius the decay: the envelope is 0.9ⁿ.',
        why: ['', 'That needs a pole at z = 1, on the circle.', 'Feedback keeps feeding the past in. Only FIR filters stop.', 'A pole inside the circle dies away, however sharply it peaks.'],
      },
      {
        question: 'You want to remove a 50 Hz hum at 1 kHz sampling and leave the rest alone. Which placement does that?',
        options: ['Zeros on the circle at 0.05 cycles a sample, and poles just inside at the same angle', 'Poles on the circle at 0.05, zeros at the origin', 'Zeros at z = 1', 'Poles and zeros both at the origin'],
        answer: 0,
        explain: 'The zero makes a null. Near it, the pole\'s distance nearly equals the zero\'s, so the ratio returns to about 1 quickly and the notch is narrow.',
        why: ['', 'That builds an oscillator at 50 Hz.', 'That removes DC, not 50 Hz.', 'Those cancel, leaving no filter at all.'],
      },
      {
        question: 'Why can an FIR filter be linear phase when a causal IIR filter cannot?',
        options: ['Linear phase needs each zero paired with its mirror across the circle, and a pole\'s mirror would be outside, unstable', 'FIR filters have more multipliers', 'IIR filters only work on audio', 'Feedback removes the phase altogether'],
        answer: 0,
        explain: 'Symmetric taps come from mirrored roots. A zero can sit outside the circle freely; a pole cannot.',
        why: ['', 'Cost and phase are separate questions.', 'IIR filters work on anything, and the limit is mathematical.', 'A feedback filter has phase like any other, and it is usually far from linear.'],
      },
    ],
  },
  steps: [
    {
      title: 'An equation with a memory',
      get body() {
        return `
        <p>The last chapter kept a filter's numbers inside their words; this one is about what the filter does to a signal, and a picture that shows it at a glance. In <a href="#/c/signals/4">chapter ${numOf('signals')}</a> a filter was a weighted sum of delayed samples. Add one idea, the filter's own past outputs among the terms, and you have every linear, time-invariant filter with a finite number of coefficients:</p>
        <p style="text-align:center"><strong>y[n] = b₀x[n] + b₁x[n−1] + … − a₁y[n−1] − a₂y[n−2] − …</strong></p>
        <p>This is the <strong>difference equation</strong>. If every a is zero it uses only inputs: it has a finite memory, and an input stops mattering after a fixed number of samples, so it is <strong>FIR</strong>. With feedback, a sample is in the output for ever, fading if the filter is well made, and it is <strong>IIR</strong>, infinite impulse response. The <strong>impulse</strong> is a single 1 at n = 0 with zeros all round it, and what comes out is the <strong>impulse response</strong>: for an FIR filter it is the taps themselves, as <a href="#/c/signals/4">chapter ${numOf('signals')}</a> found.</p>
        <p>What it costs can be read straight off the equation: one multiplication for each coefficient, one addition for each term after the first, and one word of memory for each delay. Everything else in this chapter is about what these coefficients do.</p>
        <div class="try">Step the one-pole filter through an impulse, reading the equation at each sample: each output is 0.9 of the last. Then give the moving average a step. Then give the resonator an impulse and go a long way along.</div>`;
      },
      widget: equationWidget,
      challenge: {
        kind: 'quiz', question: 'y[n] = 0.1 x[n] + 0.9 y[n−1], starting from rest. An impulse of 1 arrives at n = 0. What is y[3]?',
        options: [nf(0.1 * 0.9 ** 3, 4), '0.1', '0', '0.9'],
        answer: 0,
        explain: 'y[0] = 0.1, and from then on each output is 0.9 of the last: 0.1 × 0.9³.',
        why: ['', 'That is y[0]. The feedback carries it on, smaller each time.', 'An FIR filter would be finished by now. This one has feedback.', 'That is the coefficient, not the output.'],
      },
    },
    {
      title: 'Slide, multiply, add',
      get body() {
        return `
        <p>Feed in a single 1, and what comes out is the filter's <strong>impulse response</strong> h[n]. Any input is a list of scaled, delayed impulses, and a linear, time-invariant filter treats each in the same way, so the output is the same list of scaled, delayed copies of h, added together. That is <strong>convolution</strong>, the sum <a href="#/c/signals/4">chapter ${numOf('signals')}</a> wrote for an FIR, here with its reason:</p>
        <p style="text-align:center"><strong>y[n] = Σ h[k] x[n−k]</strong></p>
        <p>For an FIR filter, the taps are the impulse response and this formula is the filter. A block of ${CONV_X.length} samples through ${CONV_H.length} taps gives ${CONV_Y.length} samples. Convolution of N samples with M taps costs N × M multiplications when done this way.</p>
        <p>In frequency the same operation is a plain multiplication: Y(f) = H(f) X(f). This is why <a href="#/c/signals/2">the spectrum view</a> made filters look simple, and it is also how a long filter can run faster through an FFT.</p>
        <div class="try">Slide n from 0 to the end, and check the sum of products by hand at n = 4. When do all three taps overlap the input, and when does only part of them?</div>`;
      },
      widget: convolutionWidget,
      challenge: {
        kind: 'quiz', question: `With x = ${CONV_X.join(', ')} and h = ${CONV_H.join(', ')}, what is y[2]?`,
        options: [String(CONV_Y[2]), String(CONV_X[2]), String(CONV_X[1] * CONV_H[1]), String(CONV_Y[3])],
        answer: 0,
        explain: `y[2] = x[2] h[0] + x[1] h[1] + x[0] h[2] = 0 + 1 + 0.25.`,
        why: ['', 'That is the input alone.', 'That is one of the three products.', 'That is the next output sample.'],
      },
    },
    {
      title: 'A delay is z⁻¹',
      get body() {
        const f = 0.25, b = FIR_TAPS as readonly number[];
        return `
        <p>Writing out sums is awkward. So give the delay a symbol. Let z⁻¹ mean "one sample later". A filter's taps then become a polynomial: 1 + 4z⁻¹ + 6z⁻² + 4z⁻³ + z⁻⁴ is <a href="#/c/signals/5">FIR5</a> written in one line (chapter ${numOf('signals')} already wrote it as (1 + z⁻¹)⁴; this is what that meant). This is the <strong>z-transform</strong> of its impulse response, and connecting two filters in a row multiplies their polynomials. That convolution of the taps is just polynomial multiplication, as you can check by hand.</p>
        <p>What about a feedback filter? Move the y terms to the left and divide: H(z) = B(z) / A(z), a ratio of two polynomials. Every filter of this kind is such a ratio, and only that ratio matters: the coefficients are all there is.</p>
        <p>A sine at frequency f gets multiplied by e<sup>−j2πf</sup> by each delay: the arrow of <a href="#/c/signals/1">Arrows that turn</a>, turned back one step. So substitute z = e<sup>j2πf</sup> and H(z) gives you the gain and phase at f. As f goes from 0 to half the sample rate, z walks around the top half of the <strong>unit circle</strong>. That one substitution is the bridge from the algebra to the spectrum. On FIR5 at f = ${f} cycles a sample (as in chapter ${numOf('signals')}), it gives ${nf(gainAt([...b], [1], f) / 16)} of the DC gain, which is cos⁴(π f) = ${nf(binomialGain(f))}, the figure quoted in its chapter.</p>
        <p>Factor the polynomial and its roots are points on this picture: <strong>zeros</strong>, where B(z) = 0, and <strong>poles</strong>, where A(z) = 0. FIR5's polynomial is (1 + z⁻¹)⁴, so its zeros are four, all at z = −1, marked (4) below. z = −1 is half the sample rate, where the filter gave you exactly zero in gates.</p>
        <div class="try">Walk the point around the circle, and read the gain at f = 0 and at f = 0.5. Now move Zero 1 away from −1 and watch the taps change: they stop being whole numbers.</div>`;
      },
      widget: () => planeWidget({ zeros: FIR5_ZEROS, poles: [], probe: true, taps: true }),
      challenge: {
        kind: 'quiz', question: 'Two filters in a row have taps 1, 1 and 1, −1. What is the combined filter?',
        options: ['1, 0, −1', '1, 1, 1, −1', '2, 0', '1, −1'],
        answer: 0,
        explain: '(1 + z⁻¹)(1 − z⁻¹) = 1 − z⁻². Multiplying polynomials is the same thing as convolving taps.',
        why: ['', 'That appends the taps rather than convolving them.', 'That adds them, which is two filters in parallel.', 'The first filter has not gone away.'],
      },
    },
    {
      title: 'Zeros remove a frequency',
      get body() {
        return `
        <p>Now read the gain from the picture. The size of B at a point z on the circle is the product of the distances from z to each zero, because that is what a factored polynomial means. So as the point walks the circle, gain falls wherever it passes near a zero, and reaches exactly nothing if it passes through one.</p>
        <p>That makes filter design geometric. A zero on the circle at some angle removes that frequency completely: mains hum at 50 Hz, the carrier you do not want. Put a pair, since real coefficients need each complex root's conjugate alongside it. Each pair costs two delays and, at most, two multiplications.</p>
        <p>A zero away from the circle gives a dip but not a null. A row of zeros along the stopband makes a filter, and a design tool's job is to decide where. Here, you are the design tool.</p>
        <div class="try">Press <em>Two notches</em>. Find which frequencies they remove. Then move a zero off the circle, and watch the null's floor rise.</div>`;
      },
      widget: () => planeWidget({
        zeros: [{ r: 1, t: 0.15 * TAU }, { r: 1, t: 0.35 * TAU }], poles: [], probe: true, taps: true, sound: true,
        presets: [
          { name: 'Two notches', zeros: [{ r: 1, t: 0.15 * TAU }, { r: 1, t: 0.35 * TAU }], poles: [] },
          { name: 'FIR5', zeros: FIR5_ZEROS, poles: [] },
          { name: 'High-pass: zeros at 1', zeros: [{ r: 1, t: 0 }, { r: 1, t: 0 }], poles: [] },
        ],
      }),
      challenge: {
        kind: 'quiz', question: 'A zero pair sits on the circle at a quarter of a cycle a sample. What are the filter\'s taps?',
        options: ['1, 0, 1', '1, 1, 1', '1, −2, 1', '1, 2, 1'],
        answer: 0,
        explain: `At a quarter of a cycle the angle is 90°, so −2 cos θ = 0 and the taps are 1, 0, r². Any tone at fs / 4 alternates so that x[n] and x[n−2] cancel.`,
        why: ['', 'Those are the zeros at a third of a cycle.', 'Those are two zeros at z = 1, removing DC.', 'Those are two zeros at z = −1, removing the fastest tone.'],
      },
    },
    {
      title: 'Poles make it ring',
      get body() {
        return `
        <p>A pole works the other way round. Gain at the point on the circle is divided by its distance to each pole, so the point passing close to one makes a peak, higher the closer it comes. And poles come from feedback, so there is a price in time: y[n] = x[n] + 2r cos θ y[n−1] − r² y[n−2] rings at the pole's angle and fades as rⁿ.</p>
        <p>Two views of one fact: a sharp peak in frequency, and a long ring in time. At r = ${RES.r} it takes ${settleSamples(RES.r)} samples to fall to 1 %. At 0.99, it is ${settleSamples(0.99)}. A pole pair uses only two multiplications and two delays, and gets a sharpness an FIR filter would need hundreds of taps for. That is what feedback buys, and it is not free: the next steps show what it risks.</p>
        <p>A pole and a zero at the same angle make a <strong>notch</strong>: the null from the zero, and just beside it, the pole's distance has almost the same value as the zero's, so their ratio goes back to about 1. The closer the pole is to the zero, the narrower the notch.</p>
        <div class="try">Start with the resonator and play noise through it, and listen for a pitch. Take the pole radius up to 0.995 and down to 0.8. Then press <em>Notch</em>, and compare how wide it is at pole radius 0.8 and at 0.98.</div>`;
      },
      widget: () => planeWidget({
        zeros: [{ r: 1, t: Math.PI }], poles: [{ ...RES }], probe: true, taps: true, sound: true,
        presets: [
          { name: 'Resonator', zeros: [{ r: 1, t: Math.PI }], poles: [{ ...RES }] },
          { name: 'Notch', zeros: [{ r: 1, t: NOTCH_T }], poles: [{ r: 0.95, t: NOTCH_T }] },
          { name: 'Low-pass', zeros: [{ r: 1, t: Math.PI }], poles: [{ r: 0.7, t: 0.06 * TAU }] },
        ],
      }),
      more: {
        derive: '<p>A pole pair is 1 / (1 − 2r cos θ z⁻¹ + r² z⁻²), whose impulse response is rⁿ sin((n + 1)θ) / sin θ. The envelope is rⁿ and the ringing frequency is θ, so the width of the peak in frequency and the time to decay are inverse to each other.</p>',
      },
      challenge: {
        kind: 'quiz', question: `About how many samples does a pole at radius 0.99 take to fall to 1 %?`,
        options: [String(settleSamples(0.99)), '99', '10', '4 600'],
        answer: 0,
        explain: 'rⁿ = 0.01 gives n = ln 0.01 / ln 0.99, near 460: about 4.6 / (1 − r).',
        why: ['', 'The radius is not a count. Work out rⁿ.', 'That would be about r = 0.63.', 'That would be r = 0.999.'],
      },
    },
    {
      title: 'Inside the circle',
      get body() {
        return `
        <p>A pole of radius r gives a term rⁿ in the impulse response. Below 1 it fades, at 1 it never fades, and above 1 it grows until the word overflows. So the rule is simple: <strong>a filter is stable when every pole is inside the unit circle</strong>. FIR filters have no poles, apart from those at the origin, so they cannot go unstable.</p>
        <p>"Stable" here has a precise meaning: every bounded input gives a bounded output, which comes down to the sum of |h[n]| being finite. That sum is the same one you used to scale a chain, <a href="#/c/fixed/6">last chapter</a>, and it is why a pole close to the circle needs so much headroom.</p>
        <p>This matters in fixed point. A pole on the circle would be an oscillator, and that has its uses. A pole just inside can be pushed outside by nothing more than rounding its coefficients. That is why real IIR filters are built out of small sections.</p>
        <div class="try">Drag a pole across the circle. Watch the impulse response turn from a fading ring into a growing one. Press Play out there, and the player refuses.</div>`;
      },
      widget: () => planeWidget({
        zeros: [{ r: 1, t: Math.PI }], poles: [{ r: 0.9, t: 0.08 * TAU }], taps: true, sound: true,
        presets: [
          { name: 'Inside', zeros: [{ r: 1, t: Math.PI }], poles: [{ r: 0.9, t: 0.08 * TAU }] },
          { name: 'On the circle', zeros: [{ r: 1, t: Math.PI }], poles: [{ r: 1, t: 0.08 * TAU }] },
          { name: 'Outside', zeros: [{ r: 1, t: Math.PI }], poles: [{ r: 1.03, t: 0.08 * TAU }] },
        ],
      }),
      challenge: {
        kind: 'quiz', question: 'y[n] = x[n] + 1.5 y[n−1] − 0.7 y[n−2]. Is it stable?',
        options: ['Yes: its poles are a pair of radius √0.7, about 0.84', 'No: 1.5 is greater than 1', 'No: every feedback filter eventually diverges', 'It depends on the input'],
        answer: 0,
        explain: `The product of a conjugate pair is r², so r² = 0.7. Solving: ${polyRoots([1, -1.5, 0.7]).map((z) => `${nf(z.re, 2)} ${z.im < 0 ? '−' : '+'} ${nf(Math.abs(z.im), 2)}j`).join(' and ')}.`,
        why: ['', 'A coefficient may exceed 1. It is the roots that count.', 'With every pole inside the circle, any bounded input gives a bounded output.', 'Stability is a property of the filter.'],
      },
    },
    {
      title: 'Same gain, different delay',
      get body() {
        const r = 0.7, t = 1, a = inner(r, t), b = outer(r, t), both = convolve(a, b);
        return `
        <p>Gain is only half of H. Each frequency also gets a phase, and the slope of the phase against frequency, with its sign changed, is the <strong>group delay</strong>: how long that frequency takes to come through. When it varies, a pulse's parts arrive at different times and the pulse changes shape, though its spectrum's size has not changed at all.</p>
        <p>Take a zero and move it to its mirror image across the circle: from radius r to 1 / r at the same angle. The distance from any point on the circle changes only by a constant factor. So the gain keeps its shape everywhere, and with the taps simply reversed, ${a.map((v) => nf(v, 2)).join(', ')} becoming ${b.map((v) => nf(v, 2)).join(', ')}, it is exactly the same. The delay is what differs. Zeros inside the circle give the least delay a given gain can have, and this is called <strong>minimum phase</strong>. Near the zero's angle that delay even goes negative. Nothing arrives early: the zero is taking out the middle of a narrow band, and what is left has its envelope moved forward.</p>
        <p>Multiply the two and you get taps ${both.map((v) => nf(v, 2)).join(', ')}: symmetric, and the delay is now the same at every frequency: (N − 1) / 2 samples for N taps. That is <strong>linear phase</strong>: no shape change, only a shift (<a href="#/c/signals/4">chapter ${numOf('signals')}</a> stated it; this is why). It explains the symmetric taps of <a href="#/c/signals/4">the windowed sinc</a>, and why FIR5's delay is exactly 2 samples.</p>
        <p>A pole cannot do this. Its mirror image would be outside the circle, and unstable. So the usual choice between FIR and IIR is linear phase with long filters, or short filters with a phase you have to live with.</p>
        <div class="try">Bring the zero radius close to 1. Near its angle the line for zeros outside peaks, and the line for zeros inside dips by as much. Then read the line for both together: flat, whatever you do with the sliders.</div>`;
      },
      widget: delayWidget,
      more: {
        pitfall: '<p>Thinking linear phase means no delay. It means the same delay for all frequencies. A 115-tap filter has 57 samples of it, and that latency may be the deciding problem.</p>',
      },
      challenge: {
        kind: 'quiz', question: 'A symmetric FIR filter has 101 taps at 48 kHz. How long is it from input to output, at every frequency?',
        options: [`50 samples, about ${nf((50 / 48000) * 1000, 2)} ms`, '101 samples, about 2.1 ms', 'Nothing: it is linear phase', 'It depends on the frequency'],
        answer: 0,
        explain: 'A symmetric filter of N taps delays everything by (N − 1) / 2 samples. It is why this sort of filter is hard to use where latency counts.',
        why: ['', 'The delay is half the length, the centre of the taps.', 'Linear phase means equal delay, not zero delay.', 'Linear phase is exactly that the answer does not.'],
      },
    },
  ],
};

