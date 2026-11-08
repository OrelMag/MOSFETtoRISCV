// The fuller codex for the Signal processing level: numbers that fit, the z-plane (codexdspa.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE9A: Record<string, CodexMore> = {
  qformat: {
    idea: `A word has no point in it. A Q format is a promise about where the designer put one: <b>Qm.f</b> is a two's complement integer divided by 2^f, with m bits before the point, the sign counted among them. Range and step are fixed when the design is: Q1.15 runs from −1 to 1 − 2⁻¹⁵ in steps of 2⁻¹⁵, and the largest word is 0111…1, 32 767 / 32 768. There is a word for −1 and none for +1, because two's complement has one more negative value than positive. The adder, the register and the multiplier do not know the format; the same hardware serves every one.<br><br>Signal processing lives in fractions because a product of two fractions is still a fraction: Q1.15 × Q1.15 is Q2.30 with two sign bits, and it comes back to Q1.15 by dropping 15 bits, not 16. Integers do the reverse and their products grow out of the word. Keep the full product, round once at the end, and note that only −1 × −1 has an answer that does not fit.`,
    example: {
      title: 'Q1.7 in eight bits',
      body: `<pre>largest word 0111 1111 = 127  → 127 / 128 = 0.9922
smallest word 1000 0000 = −128 → −128 / 128 = −1
0.75 → 96 (0110 0000)    0.5 → 64 (0100 0000)
96 × 64 = 6144 in Q2.14 → dropped by 7 places → 48 → 48 / 128 = 0.375 = 0.75 × 0.5
−1 × −1 = +1 → 128: one past the largest word → the clamp gives 127</pre>The shift by 7 is wiring. Shift by 8 instead and the answer is 24, half of what it should be.`,
    },
    mistakes: [
      'Shifting a fractional product down by the word length. Q1.(w−1) × Q1.(w−1) has two sign bits, so it comes down by w − 1; shifting by w gives half the right answer.',
      'Counting the sign outside the integer bits. In Q1.15 the one integer bit is the sign: 16 bits in all, not 17, and the range is −1 to just below +1.',
      'Expecting +1 to be representable. The top word is 1 − 2⁻¹⁵; a coefficient of exactly 1 needs a wider integer part or must be stored as the nearest word below it.',
      'Treating the format as a property of the hardware. The same word means 96 in Q8.0 and 0.75 in Q1.7; mixing two formats in one sum silently shifts one of them.',
    ],
    chapters: [
      { chapter: 'fixed', step: 0, label: 'A word and its point' },
      { chapter: 'fixed', step: 3, label: 'Multiplying fractions' },
      { chapter: 'binary', step: 1, label: 'Negative numbers: two\'s complement' },
    ],
  },
  saturate: {
    idea: `An adder's natural behaviour past full scale is to <b>wrap</b>: the largest positive word plus one is the most negative. In a signal that is a jump from one rail to the other, nearly two full scales, about the most violent error a word can make. <b>Saturating</b> stops at the rail instead: a clipped peak in place of a full-scale step. A third way is to shift down first by as many bits as the worst peak needs, which never overflows and spends bits a short word cannot spare.<br><br>In gates the test is cheap. Compute the sum with one more bit, which cannot overflow. If its top two bits agree the value fits; if they differ it does not, and the top bit is the true sign. A mux then picks the sum or the limit (the sign on top and its inverse below, 100…0 or 011…1). Every result pays for the mux, overflow or not, and for its delay. A real part makes the flag sticky so that a program can look afterwards. Saturation is the right rule for the output of a stage and the wrong one in the middle of a long sum.`,
    example: {
      title: 'The price, and what it buys',
      body: `<pre>             plain adder   saturating   extra
 8 bits            72          118      46  (81 for the 9-bit adder + 37 for the clamp)
16 bits           144          222      78
24 bits           216          326     110

6 dB of gain on the tones (peak 1.8 × full scale), 16 bits, against the ideal:
  wrap  −2.1 dB    saturate  11.1 dB    shift down first  94.4 dB</pre>Saturating is far less wrong than wrapping. Shifting down first costs a bit of resolution and is nearly exact here, because 16 bits have room for it.`,
    },
    mistakes: [
      'Saturating everywhere. A clamp in the middle of a sum throws away information that a later term would have cancelled; wrapped, the same sum comes out right if its final value fits.',
      'Thinking saturation makes an overloaded signal acceptable. It is much less wrong than wrapping and still distortion: the clipped tops add harmonics.',
      'Reading the sum\'s top bit alone. Overflow is when the top two bits of the one-bit-wider sum differ; the top bit by itself is the sign of a value that may not fit.',
      'Leaving out the clamp on a fractional multiplier. −1 × −1 is the one input pair whose answer does not fit, and without a clamp it returns −1, flipping the sign of a full-scale sample.',
    ],
    chapters: [
      { chapter: 'fixed', step: 1, label: 'Wrap or saturate' },
      { chapter: 'fixed', step: 2, label: 'A saturating adder' },
      { chapter: 'fixed', step: 3, label: 'Multiplying fractions' },
    ],
  },
  guardbits: {
    idea: `Two's complement addition is arithmetic modulo 2^w, so every intermediate result is correct modulo 2^w, however far it strayed. A value that fits in w bits is fixed by its residue; if the final answer of a sum fits, the excursions on the way leave no trace. A clamp inside the sum is the opposite: it clips what it could not hold and never gets it back.<br><br>So an accumulator is built wider than the word and clamped once at the end. The extra bits are <b>guard bits</b>. A sum of n products, each below 1 in magnitude, needs up to log₂ n bits above the product: 8 for 256 terms. That is why a 16-bit DSP commonly has a 40-bit accumulator, 32 for a Q2.30 product and 8 guard bits. The worst case is the safe number; a filter whose taps sum to far less than n in magnitude needs fewer, and the sum of |h| says how many.`,
    example: {
      title: 'Eight words in an 8-bit accumulator',
      body: `<pre>words:       90   80   70  −60  −90  −50   20   15
true sum:     90  170  240  180   90   40   60   75     (peak 240)
wrapped:      90  −86  −16  −76   90   40   60   75     ends at 75: right
saturated:    90  127  127   67  −23  −73  −53  −38     ends at −38: wrong

guard bits:   256 terms → 8     1024 terms → 10, so 32 + 10 = 42 bits for Q1.15 taps</pre>The wrapped sum passes through values that are wrong, and ends right because the true total, 75, fits in eight bits.`,
    },
    mistakes: [
      'Clamping after every addition "to be safe". The clamp is what makes the final answer wrong; wrapping through an excursion that comes back is harmless.',
      'Counting guard bits from the number of taps when the taps are small. 1024 taps need 10 only if every product can be near full scale; the sum of |h| gives the real bound.',
      'Assuming wrapping is always safe. It is right only if the final value fits in the word; if it may not, the accumulator needs the guard bits, or a clamp at the end.',
      'Forgetting the clamp at the end. The accumulator is wider than the word it feeds, so the result must be saturated or rounded down to the word, once.',
    ],
    chapters: [
      { chapter: 'fixed', step: 5, label: 'Wrapping can be right' },
    ],
  },
  headroom: {
    idea: `A fixed-point word is full only if its biggest value comes near the top. Every shift down throws bits away and adds rounding noise at that point in the chain, and a later gain raises that noise along with the signal; so <b>attenuate late and amplify early</b>, as long as the signal still fits. A gain of 1 made from a shift down and a shift up keeps its bits only if the up comes first, and that needs headroom: room above the signal for the peaks it will meet.<br><br>How much room is a bet about the input, and there are three grades. The sum of |h[n]| over the impulse response bounds the peak for any input at all. The filter's gain at one frequency covers tones. A measured or assumed peak covers what you expect, which is what most audio equipment relies on. Pass the top and a clip costs far more than a rounding, so the art is to keep the word as full as possible without ever passing it.`,
    example: {
      title: 'A gain of 1 in 16 bits',
      body: `<pre>tone peaking at 0.1 of full scale, 3 bits down and 3 bits up:
  down first   59.7 dB      (3 bits thrown away, then amplified)
  up first     78.1 dB      (the most this word gives at this level)

impulse response summing |h| to 3.2:
  worst output is 3.2 × the input's peak → the input must stay below 1 / 3.2
  2 bits of headroom: input below 1 / 4, which is under 1 / 3.2</pre>Raise the tone until up first clips and the order flips: a clip is worse than a rounding.`,
    },
    mistakes: [
      'Attenuating at the input "to be safe". The bits thrown away there are lost for good and the rounding noise is amplified by every later gain.',
      'Sizing headroom from a typical signal. The bound for any input is the sum of |h|; a peak that was never seen is the one that wraps.',
      'Assuming equal gains in either order give the same result. The overall gain is the same, the noise is not: it depends on where the bits are dropped.',
      'Shifting the output down after it overflowed. Once a value has wrapped or saturated the information is gone, and no shift brings it back.',
    ],
    chapters: [
      { chapter: 'fixed', step: 6, label: 'Where the gain goes' },
      { chapter: 'zplane', step: 5, label: 'Inside the circle' },
    ],
  },
  diffeq: {
    idea: `Weight the last few inputs and, optionally, the last few outputs, and add: <b>y[n] = b₀x[n] + b₁x[n−1] + … − a₁y[n−1] − a₂y[n−2] − …</b>. That is every linear, time-invariant filter with a finite number of coefficients. If every a is zero only inputs appear, an input stops mattering after a fixed number of samples, and the filter is FIR. With feedback a sample is in the output for ever, fading if the filter is well made: IIR, infinite impulse response.<br><br>What it costs reads straight off the equation: one multiplication per coefficient, one addition per term after the first, one word of memory per delay. Feedback buys sharpness: a pair of poles uses two multiplications and two delays and gives a peak an FIR filter needs hundreds of taps for, and it risks instability and rounding trouble in fixed point. Stepping the equation by hand, one sample at a time, is the most direct way to see what a filter does.`,
    example: {
      title: 'One pole, stepped',
      body: `<pre>y[n] = 0.1 x[n] + 0.9 y[n−1]      an impulse x[0] = 1 at rest
y[0] = 0.1
y[1] = 0.9 × 0.1    = 0.09
y[2] = 0.9 × 0.09   = 0.081
y[3] = 0.9 × 0.081  = 0.0729 = 0.1 × 0.9³

cost: 2 multiplications, 1 addition, 1 word of memory</pre>Each output is 0.9 of the last, for ever: the one tap of feedback made an infinite impulse response from two coefficients.`,
    },
    mistakes: [
      'Reading the a signs from the polynomial. The equation has − a₁y[n−1]; the denominator is 1 + a₁z⁻¹ + …. A pole at 0.9 is a₁ = −0.9, and the equation reads y[n] = x[n] + 0.9 y[n−1].',
      'Calling a filter IIR because it has many taps. IIR means feedback: a 1000-tap filter with no a terms is FIR and stops after 1000 samples.',
      'Starting a step from a non-zero state. The impulse response is the output from rest; leftover y[n−1] terms add their own tail.',
      'Counting memory by the highest delay of the inputs only. The feedback terms need their own words, one per y delay.',
    ],
    chapters: [
      { chapter: 'zplane', step: 0, label: 'An equation with a memory' },
      { chapter: 'signals', step: 3, label: 'A filter is a sum of delayed samples' },
    ],
  },
  convolution: {
    idea: `Feed a single 1 into a linear, time-invariant filter and what comes out is its <b>impulse response</b> h[n]. Any input is a list of scaled, delayed impulses, and such a filter treats each in the same way, so the output is the same list of scaled, delayed copies of h, added together: <b>y[n] = Σ h[k] x[n−k]</b>. Slide the reversed h along x, multiply where they overlap, add. For an FIR filter the taps are the impulse response and this sum is the filter.<br><br>N samples through M taps give N + M − 1 samples, at N × M multiplications done directly. In frequency the same operation is a plain product, Y(f) = H(f) X(f), which is why filters look simple on a spectrum and why a long one can be run faster through an FFT. In the z-transform, convolving two sets of taps is multiplying their polynomials, which is also what connecting two filters in a row does.`,
    example: {
      title: 'Six samples through three taps',
      body: `<pre>x = 1, 2, 0, −1, 3, 1       h = 1, 0.5, 0.25
y[2] = x[2]h[0] + x[1]h[1] + x[0]h[2] = 0 + 1 + 0.25 = 1.25
y    = 1, 2.5, 1.25, −0.5, 2.5, 2.25, 1.25, 0.25     (6 + 3 − 1 = 8 samples)
cost: 6 × 3 = 18 multiplications

(1 + z⁻¹)(1 − z⁻¹) = 1 − z⁻²       taps 1, 1 then 1, −1  →  1, 0, −1</pre>Only at n = 2 … 5 do all three taps overlap the input; at the ends the sum has fewer terms.`,
    },
    mistakes: [
      'Forgetting that h is reversed. The sum pairs x[n−k] with h[k]: the newest sample meets the first tap, so h is reversed as it slides along x.',
      'Expecting the output to be as long as the input. A block of N through M taps gives N + M − 1; the extra M − 1 samples are the filter\'s tail.',
      'Adding two lists of taps to cascade two filters. Cascading convolves them; adding is two filters in parallel.',
      'Using the sliding sum on a long filter without counting. N × M grows fast: 1000 samples through 101 taps is 101 000 multiplications, which is when an FFT pays.',
    ],
    chapters: [
      { chapter: 'zplane', step: 1, label: 'Slide, multiply, add' },
      { chapter: 'signals', step: 3, label: 'A filter is a sum of delayed samples' },
      { chapter: 'zplane', step: 2, label: 'A delay is z⁻¹' },
    ],
  },
  ztransform: {
    idea: `Writing sums of delayed samples is awkward, so give the delay a symbol: <b>z⁻¹</b> means one sample later. A filter's taps become a polynomial in it, 1 + 4z⁻¹ + 6z⁻² + 4z⁻³ + z⁻⁴ for FIR5, and connecting two filters in a row multiplies their polynomials: the convolution of the taps is polynomial multiplication. A feedback filter moves its y terms across and divides, H(z) = B(z) / A(z), and only that ratio matters: the coefficients are all there is.<br><br>A sine at frequency f is multiplied by e^(−j2πf) by each delay, so putting z = e^(j2πf) in H gives the gain and phase at f. As f goes from 0 to half the sample rate, z walks the top half of the unit circle. That one substitution is the bridge from algebra to the spectrum. Factor B and A and their roots are points on the picture: zeros where B(z) = 0, poles where A(z) = 0.`,
    example: {
      title: 'FIR5 as a polynomial',
      body: `<pre>(1 + z⁻¹)⁴ = 1 + 4z⁻¹ + 6z⁻² + 4z⁻³ + z⁻⁴      taps 1, 4, 6, 4, 1; four zeros at z = −1
at f = 0:       gain 16, so 1 relative to DC
at f = 0.25:    gain 4, so 0.25 relative to DC = cos⁴(π × 0.25)
at f = 0.5:     gain 0, the fastest tone, removed</pre>Dividing by the gain at DC, 16, gives the figure its own chapter quotes: cos⁴(πf).`,
    },
    mistakes: [
      'Reading z as a frequency. z is a point in the plane; frequency is the angle at which a point on the unit circle sits: f cycles a sample is an angle of 2πf.',
      'Treating z⁻¹ as a gain that shrinks with frequency. It is a delay: unit magnitude on the circle, and a phase of −2πf that grows with f.',
      'Cascading filters by adding polynomials. Series filters multiply; adding is parallel.',
      'Forgetting that only the ratio matters. Multiplying B and A by the same polynomial, which is a pole and a zero at the same point, changes nothing about the filter and costs a multiplier.',
    ],
    chapters: [
      { chapter: 'zplane', step: 2, label: 'A delay is z⁻¹' },
      { chapter: 'zplane', step: 3, label: 'Zeros remove a frequency' },
    ],
  },
  polezero: {
    idea: `Factor the numerator and the denominator of a filter and their roots are points in the z-plane: <b>zeros</b> where B(z) = 0, <b>poles</b> where A(z) = 0. Gain at a frequency is read off the picture: the product of the distances from the point on the unit circle to the zeros, over the product of the distances to the poles. A zero on the circle removes its frequency exactly: mains hum, an unwanted carrier. A pole close to the circle makes a peak, higher the closer it comes. Real coefficients need each complex root's conjugate alongside, so roots come in pairs.<br><br>A pole is a price in time as well. A pole of radius r gives a term rⁿ, so a sharp peak in frequency is a long ring in time, and the two are inverse. Below 1 it fades, at 1 it never does, and above 1 it grows until the word overflows: a filter is stable when every pole is inside the circle. A pole and a zero at one angle make a notch: the null from the zero, and just beside it the pole's distance is nearly the zero's, so the ratio returns to about 1.`,
    example: {
      title: 'A ring, a notch and a test',
      body: `<pre>pole radius r    samples to fall to 1 %     (about 4.6 / (1 − r))
   0.9                44
   0.97              152
   0.99              459

notch at 0.2 cycles a sample, zero on the circle, pole at the same angle:
  pole radius   gain at 0.2   at 0.21    at 0.25
     0.8           0            0.34     1.01
     0.98          0            0.97     1.02

y[n] = x[n] + 1.5y[n−1] − 0.7y[n−2]: poles 0.75 ± 0.37j, radius √0.7 = 0.84: stable</pre>A narrower notch needs a pole closer to the circle, and so a longer ring.`,
    },
    mistakes: [
      'Judging stability from the coefficients. 1.5 is greater than 1 and the filter above is stable; only the roots count.',
      'Putting a pole on the unit circle for a sharp peak and expecting a filter. That is an oscillator: it never decays.',
      'Forgetting that rounding the coefficients moves the poles. A pole just inside the circle can be pushed outside by nothing more than a rounded coefficient, which is why real IIR filters are built from small sections.',
      'Using a pole to remove a frequency. Zeros do that; a pole at the same place makes a peak instead.',
    ],
    chapters: [
      { chapter: 'zplane', step: 3, label: 'Zeros remove a frequency' },
      { chapter: 'zplane', step: 4, label: 'Poles make it ring' },
      { chapter: 'zplane', step: 5, label: 'Inside the circle' },
    ],
  },
  minphase: {
    idea: `Gain is half of H. Each frequency also gets a phase, and the slope of the phase against frequency, with its sign changed, is the <b>group delay</b>: how long that frequency takes to come through. When it varies, the parts of a pulse arrive at different times and the pulse changes shape, though the size of its spectrum has not changed at all.<br><br>Take a zero and move it to its mirror image across the circle, from radius r to 1/r at the same angle. The distance from any point on the circle changes only by a constant factor, so the gain keeps its shape everywhere and the taps are simply reversed. The delay is what differs. Zeros inside the circle give the least delay a gain can have: <b>minimum phase</b>. Near the zero's angle that delay even goes negative; nothing arrives early, the zero is taking out the middle of a narrow band and the envelope of what is left moves forward. Pair every zero with its mirror and the taps become symmetric and the delay the same at every frequency: linear phase, (N − 1) / 2 samples for N taps. A pole cannot be mirrored: its mirror image is outside the circle.`,
    example: {
      title: 'A zero pair at radius 0.7 and its mirror',
      body: `<pre>inside  (r = 0.7, angle 1 rad):  1, −0.76, 0.49
outside (mirror):               0.49, −0.76, 1        same gain at every frequency
group delay at 0.16:            inside −1.96 samples   outside 3.96 samples
both together (5 taps):         0.49, −1.13, 1.81, −1.13, 0.49    symmetric
group delay of the pair, any f: 2 samples = (5 − 1) / 2

linear phase, 101 taps at 48 kHz: 50 samples, 1.04 ms     115 taps: 57 samples</pre>Delays add when filters are cascaded: −1.96 + 3.96 = 2 at 0.16, as at every frequency. FIR5, with four zeros at −1, has the same delay of 2.`,
    },
    mistakes: [
      'Thinking linear phase means no delay. It means the same delay at every frequency: a 115-tap filter holds everything back 57 samples, and that latency may be the deciding problem.',
      'Concluding that a negative group delay breaks causality. Nothing comes out before it goes in; the envelope of a band-limited part shifts, not a signal.',
      'Comparing filters by gain alone. Two filters with identical gain can differ in delay by several samples, and a pulse through the wrong one changes shape.',
      'Asking an IIR filter for linear phase. It would need each pole paired with its mirror, which is outside the circle and unstable; that is why linear phase is an FIR property.',
    ],
    chapters: [
      { chapter: 'zplane', step: 6, label: 'Same gain, different delay' },
    ],
  },
};
