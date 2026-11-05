// The fuller codex for the Signal processing level: IIR and stability, changing the rate, CORDIC (codexdspc.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE9C: Record<string, CodexMore> = {
  iirfilter: {
    idea: `An FIR filter only looks at the past inputs; an <b>IIR</b> filter also looks at its own past outputs, y[n] = Σ b[k] x[n − k] − Σ a[k] y[n − k]. The feedback gives the transfer function a denominator, whose roots are the poles, and a pole near the unit circle makes a sharp resonance from two multiplications. That is the whole attraction: one mask that costs an FIR filter over a hundred taps costs an elliptic IIR filter four sections. The impulse response never ends, since each output feeds the next, hence the name.<br><br>What it gives up is three things. The phase is not linear, so different frequencies are delayed by different amounts. The filter has a state that feeds back, so the word length that is stored changes the answer, and rounding inside the loop can sustain an output of its own. And stability is no longer free: a pole of radius r gives a term rⁿ, which fades below 1, never fades at 1 and grows above it, so every pole must be inside the unit circle with the coefficients that a register can actually hold. An FIR filter has no poles to worry about and cannot go unstable.`,
    example: {
      title: 'One mask, four designs, and a stability check',
      body: `<pre>mask: pass to 0.1 cycles a sample (0.1 dB), stop from 0.125 at 60 dB
FIR, equiripple        115 taps                     58 multiplications (folded)
Butterworth            order 37, 19 sections        93
Chebyshev I            order 14, 7 sections         35
elliptic               order 8, 4 sections          20   (16 if the symmetric numerators fold)

y[n] = x[n] + 1.5 y[n−1] − 0.7 y[n−2]:  z² − 1.5z + 0.7 = 0  →  z = 0.75 ± 0.371j,  r = √0.7 = 0.837 &lt; 1: stable</pre>The elliptic design spends its ripple in both bands on steepness, which is why it needs the lowest order: 58 / 20 = 2.9 times fewer multiplications than the shortest FIR filter. The coefficient 1.5 is larger than 1 and harmless; it is the roots that count.`,
    },
    mistakes: [
      'Calling a filter stable because its coefficients are small. A coefficient above 1 can be harmless and one below 1 can sit beside a pole outside the circle; the test is the roots, or for a section the triangle |a₂| &lt; 1, |a₁| &lt; 1 + a₂.',
      'Designing in exact arithmetic and checking only the response. The poles that matter are the ones the coefficient words can hold, and a design that is stable on paper can be an oscillator once a₂ rounds to 1.',
      'Counting only multiplications. An elliptic IIR filter is cheaper in multipliers but has non-linear phase; where phase matters, the FIR filter\'s longer length buys a constant delay.',
      'Expecting an IIR filter to forget its input. The response is infinite in exact arithmetic, and with rounding in the loop it can fail to die away at all.',
    ],
    chapters: [
      { chapter: 'zplane', step: 4, label: 'Poles make it ring' },
      { chapter: 'zplane', step: 5, label: 'Inside the circle' },
      { chapter: 'iir', step: 0, label: 'What feedback buys' },
      { chapter: 'iir', step: 3, label: 'One polynomial or small sections' },
    ],
  },
  bilinear: {
    idea: `Analog filter design is old and well tabulated, and the <b>bilinear transform</b> carries a design from the s-plane to the z-plane by the substitution z = (2 + s) / (2 − s) for one sample a second. The imaginary axis, where an analog filter's frequency response lives, becomes the unit circle; the left half-plane, where stable poles live, becomes the inside of the circle. So the map keeps stability, always, and every pole and zero of the analog design is mapped one by one. The zeros an analog low-pass has at infinity come to rest at z = −1, half the sample rate.<br><br>The map is not linear in frequency. All of ω from 0 to infinity lands on half a turn, f = atan(ω / 2) / π cycles a sample, close to ω / 2π while ω is small and squeezed hard as it grows. An edge placed by 2π f therefore lands too low, so the prototype is <b>prewarped</b>: scaled to 2 tan(π f), which the map sends back to exactly f. The edges are then right and the shape between them is the analog filter's, compressed.`,
    example: {
      title: 'Where an edge lands, with and without prewarping',
      body: `<pre>s = −2 → z = 0       s = −1 → z = 1/3       s = 0 → z = 1       s = j2 → z = (2 + 2j) / (2 − 2j) = j   (|z| = 1)
edge asked 0.1, scaled by 2π × 0.1 = 0.628:   lands at atan(0.628 / 2) / π = 0.0969
edge asked 0.4, scaled by 2π × 0.4 = 2.513:   lands at 0.286
edge asked 0.2, prewarped: 2 tan(0.2π) = 1.453 → lands at 0.2;   unwarped 2π × 0.2 = 1.257 → lands at 0.179</pre>Prewarping is a change of the prototype's scale only: nothing is added to the hardware.`,
    },
    mistakes: [
      'Scaling the prototype by 2π f and expecting the edge at f. The error is small near 0.1 and large near 0.4, where it lands at 0.286; prewarp with 2 tan(π f).',
      'Prewarping one edge of a band-pass and leaving the other. The map bends every frequency, so each edge needs its own warped value.',
      'Expecting the digital filter to have the analog filter\'s shape out to Nyquist. The shape is compressed: all of frequency to infinity fits into half a turn.',
      'Using the map with the wrong constant. z = (2 + s) / (2 − s) is for one sample a second; for a rate fs the prototype is scaled by 2 fs tan(π f / fs).',
    ],
    chapters: [{ chapter: 'iir', step: 1, label: 'From an analog filter to a digital one' }],
  },
  biquad: {
    idea: `A <b>biquad</b> is the second-order IIR section, y[n] = b₀x[n] + b₁x[n − 1] + b₂x[n − 2] − a₁y[n − 1] − a₂y[n − 2]: two zeros, two poles, five multiplications. Any filter of higher order factors into such sections, and a pole pair is exactly what two coefficients hold: a₁ = −2r cos θ and a₂ = r². The section is stable inside a triangle of the coefficient plane, |a₂| &lt; 1 and |a₁| &lt; 1 + a₂, which can be checked exactly on the integers.<br><br>In gates the chapter builds direct form I: four delay registers hold the last two inputs and the last two outputs, five signed multipliers form the products, and four adders sum them into an accumulator that keeps every product bit and adds log₂ 5 → 3 guard bits to the 32 of a product, 35 in all. There is one rounding, after the sum, and one saturating clamp, because a filter with poles on the circle can drive the sum off the end. Data are Q1.15 and the coefficients Q2.14, so the word −2 is a legal a₁.`,
    example: {
      title: 'What the chapter\'s section costs',
      body: `<pre>5 multipliers (16 × 16 tree) × 3,572 NANDs     = 17,860
everything else: adders, rounder, clamp, registers     =  2,453
the whole section                                 = 20,313 NANDs, 135 NAND delays clock to clock
accumulator: 32-bit products + 3 guard bits       = 35 bits
radius 0.95 at a quarter rate: a₁ = 0, a₂ = round(0.9025 × 2¹⁴) = 14,787</pre>Multipliers are 88 % of the section. Four such sections are the elliptic filter of the mask: 4 × 5 = 20 multiplications a sample.`,
    },
    mistakes: [
      'Building a high-order filter as one polynomial. The poles of a tight cluster move enormously when a coefficient is rounded; split into sections, each pair depends on its own two coefficients.',
      'Rounding every product. This section keeps every bit of every product and rounds once, after the sum; rounding each product multiplies the noise and the chances of a cycle.',
      'Dropping the clamp because the design never overflows. Poles near the circle give a large gain at resonance, and the clamp is what keeps an overflow a clip instead of a wrap.',
      'Counting the section as two coefficients. It has five multiplications; the numerator is symmetric in many designs (b₀ = b₂), which a folded structure could use to spend four.',
    ],
    chapters: [
      { chapter: 'iir', step: 3, label: 'One polynomial or small sections' },
      { chapter: 'iir', step: 4, label: 'A biquad in gates' },
      { chapter: 'iir', step: 7, label: 'Sections in a cascade' },
    ],
  },
  coefsens: {
    idea: `In a register a coefficient is a multiple of a step, so the poles a section can have are the roots for coefficient pairs on a <b>lattice</b>, and nothing else. In Q2.(b − 2) the step is 2^−(b − 2). A step in a₂ moves the radius by about step / 2r wherever the pole is; a step in a₁ moves the angle by about step / (2r sin θ), which grows as θ falls. The lattice is sparsest near z = 1, which is exactly where a narrow low-pass filter needs its poles. The register takes the nearest values of a₁ and a₂, not the nearest pole, so a radius of 0.97 can become 1.<br><br>For a high-order polynomial the damage is worse. To first order a change δ in one coefficient moves a pole by δ times 1 / ∏|pᵢ − pⱼ|, the distances to the other poles, and poles in a tight cluster have small distances. The narrow elliptic filter has its poles clustered near z = 1, so one unit in the last place moves the worst of them by thousands of units; in a section the factor depends on the pair's own spacing, 1 / (2 Im p), alone. That is the argument for sections, and stability is only the floor: a stable filter can still be far from its mask.`,
    example: {
      title: 'A pole at radius 0.97 and 0.04 cycles a sample, and the narrow filter',
      body: `<pre>bits  step    a₁ held   a₂ held   result
 6    1/16    −1.875    0.9375    pair at radius 0.968, stable
 5    1/8     −1.875    1.000     pair ON the circle, rings for ever
 4    1/4     −2        1.000     double pole at z = 1

narrow elliptic filter (order 6), coefficients rounded:
  one polynomial: unstable at every width 8 … 19 bits, stable from 20
  three sections: stable at every width from 8 bits
  worst-pole sensitivity: 3,021 per unit as a polynomial, 6.5 in a section (about 470 times less)</pre>The asked a₂ = r² = 0.9409 rounds to 1.000 at a step of 1/8; the filter whose designer asked for a fast decay now has an oscillator.`,
    },
    mistakes: [
      'Rounding to the nearest pole instead of the nearest coefficients. The register holds a₁ and a₂ rounded independently, and the pole it makes can be a long way from the one asked for.',
      'Treating a stable result as a good one. Eight bits keeps the narrow filter\'s sections stable, but rounding still moves the poles inside the circle and the response may miss the mask.',
      'Judging sensitivity by the coefficients\' size. What matters is the spacing of the poles: a cluster near z = 1 makes a polynomial fragile whatever its coefficients are.',
      'Adding bits to the data to cure it. The feedback coefficients\' step sets the pole lattice; a wider data path leaves the lattice as sparse as it was.',
    ],
    chapters: [
      { chapter: 'iir', step: 2, label: 'Where a pole is allowed to sit' },
      { chapter: 'iir', step: 3, label: 'One polynomial or small sections' },
    ],
  },
  limitcycle: {
    idea: `A stable filter with no input should die away, and an exact one does. A rounded one need not: the output that is fed back is the <em>rounded</em> value, and rounding is a nonlinearity inside a feedback loop. With a₁ = 0 the recurrence is y[n] = round(−a₂ y[n − 2]), and any y whose product with a₂ rounds back to the same size is a fixed point of the loop in magnitude: every y from 1 to the <b>dead band</b> ½ / (1 − a₂) maps onto itself with the sign flipped. The pole radius is not what keeps the output alive; the radius can be 0.95, well inside the circle.<br><br>What helps and what does not follows from where the rounding is. A wider accumulator cannot, because the accumulator is already exact and the one rounding comes after it. Rounding toward zero can: for a₁ = 0 it gives |y[n]| &lt; |y[n − 2]| until zero, a proof. For a₁ ≠ 0 it is only a result of the sweeps, which found no cycle up to radius 0.975 and rare ones from 0.98, so it is no safe rule. A cycle of a few least significant bits is quiet but not silent, and in audio it is heard as a tone that will not go away.`,
    example: {
      title: 'The chapter\'s resonator: radius 0.95, a quarter of the rate',
      body: `<pre>a₂ = 14,787 / 2¹⁴ = 0.9025    one input word of 8,000, then silence
y = 5:   −0.9025 × 5 = −4.51  → rounds to −5      y = −5: +4.51 → 5      the output repeats 5, 0, −5, 0
dead band ½ / (1 − 0.9025) = 5.13: y = 1 … 5 each map to themselves; y = 6 → 5.4 → 5 shrinks
rounded toward zero: 4.51 → 4, then −3.61 → −3 …   falls to 0

sweep, 176 runs (radius 0.90 … 0.97, 11 angles, 2 inputs, 2 bursts):
  half up 176    floor 59    toward zero 0    half up + 4 extra bits 22    toward zero + 4 extra bits 0</pre>The cycle sets in at about clock 87 and is 5 least significant bits, −76 dBFS. A finer sweep to radius 0.995 (294 runs each) found 2 cycling at 0.98, 1 at 0.99 and 1 at 0.995 with toward zero alone.`,
    },
    mistakes: [
      'Blaming the pole radius. The radius is 0.95 and the coefficients do not change while it runs; the cycle is the rounding nonlinearity inside the loop.',
      'Widening the accumulator. It is already exact; what circulates is the output after the one rounding.',
      'Reading "rounding toward zero removes it" as a guarantee. It is a proof only for a₁ = 0; for the general section it is the result of a sweep, and rare cycles remain from radius 0.98.',
      'Confusing it with overflow. The cycle is a few LSB (5, 0, −5, 0); overflow is the clamp acting, a different failure with its own flag.',
    ],
    chapters: [
      { chapter: 'iir', step: 5, label: 'A limit cycle on the gates' },
      { chapter: 'iir', step: 6, label: 'What removes a limit cycle' },
    ],
  },
  decimation: {
    idea: `<b>Decimation</b> keeps every R-th sample and drops the rest, which is cheap and has the problem sampling always has. The new rate has a new half-rate, and whatever lay above it folds into the band, as a tone that cannot be told apart from one that belonged there, and nothing later can remove it. A frequency f of the old rate becomes R f cycles a sample, and the new frequency is the distance from R f to the nearest whole number: 0.3 decimated by 4 is 1.2 and lands at 0.2. So the filter must come first, and it must run at the old rate, where it is at its most expensive.<br><br>Everything about changing the rate is about paying less for that one filter. A filter's price is taps × rate, so lowering the rate early makes everything after it R times cheaper; polyphase branches skip the outputs that would be dropped; half-band stages halve the rate with half their taps zero; and a CIC makes the first large drop with adders alone. The mixer that brings one station to zero is what makes the rest of the sampled band a waste, which is why a software radio decimates straight after it.`,
    example: {
      title: 'Two tones that become one, and the price of the job',
      body: `<pre>÷ 4:  0.30 × 4 = 1.2 cycles a sample → 0.2        0.45 × 4 = 1.8 → 0.2        both samples: cos 2π(0.2)k
a tone at 0.3 of the input rate, no filter: it lands at 0.2 of the new rate and stays there

the job: ÷ 64, keep 40 % of the new rate, 50 dB down from 60 %
  one filter at the input rate               1,037 taps    1,037 multiplications a sample
  the same filter by branches                              16.2
  halving six times                                          4.03
  CIC of order 3 ÷ 16, then a filter ÷ 4                     1.05</pre>The last row is about a thousandth of the first, from reordering the work, not from a cleverer filter.`,
    },
    mistakes: [
      'Decimating first and filtering after. The fold is permanent: the aliased energy sits on top of the wanted band and no later filter can tell them apart.',
      'Putting the whole filter at the high rate and computing every output. R − 1 of every R results are discarded; polyphase does not compute them.',
      'Treating the new Nyquist as the band edge. The filter needs a transition band, so only 40 % of the new rate is kept in the chapter\'s job and the stop band begins at 60 %.',
      'Forgetting that decimation divides the sampling rate and not the signal\'s content: a tone above the new half-rate does not disappear, it moves.',
    ],
    chapters: [
      { chapter: 'radio', step: 4, label: 'A radio in arithmetic' },
      { chapter: 'multirate', step: 0, label: 'Most of the samples are not needed' },
      { chapter: 'multirate', step: 1, label: 'Throwing samples away' },
      { chapter: 'multirate', step: 8, label: 'The whole job, priced' },
    ],
  },
  interpolation: {
    idea: `Going up by L is the mirror image of decimation. Put L − 1 zeros between the samples: the spectrum is unchanged, but it is now drawn across a rate L times higher, so it repeats L times. The copies are <b>images</b>, and a low-pass filter at the new rate removes them and in doing so fills in the zeros with interpolated values. A tone at f of the old rate stands at f / L of the new, with images at k / L ± f / L for the other copies.<br><br>The filter's inputs are mostly zeros, and multiplying by those is a waste, so the taps split into L branches and each output needs only every L-th tap: taps / L multiplications an output, in the polyphase way. Any rational rate change is the two together: up by L, filter, down by M, with one filter doing both jobs; the chapter's model agrees with scipy's resample_poly at 3 / 2, 2 / 3 and 5 to rounding. In a converter the same idea is oversampling, which spreads the images away from the band so that a simple analog filter will do.`,
    example: {
      title: 'A tone at 0.1 of the old rate, up by 4',
      body: `<pre>samples: x₀ 0 0 0 x₁ 0 0 0 x₂ …    (L − 1 = 3 zeros between)
spectrum, in cycles a sample of the NEW rate:
  the tone            0.1 / 4      = 0.025
  its images          1/4 − 0.025 = 0.225,   1/4 + 0.025 = 0.275,   1/2 − 0.025 = 0.475
a low-pass at 0.125 of the new rate keeps 0.025 and removes the three images</pre>The images are exactly what a decimator would fold, seen from the other side.`,
    },
    mistakes: [
      'Repeating each sample instead of inserting zeros, and calling it interpolation. A held value is a filter already (a moving average), with sinc-shaped nulls and a droop, not an ideal one.',
      'Running the filter at the old rate. The images are at the new rate\'s frequencies; the filter has to run there, which is why polyphase matters.',
      'Forgetting the gain. Inserting L − 1 zeros divides the amplitude by L, so the filter must have a passband gain of L.',
      'Computing every product of the zero-stuffed filter. Most inputs are zero; only every L-th tap meets a real sample for each output.',
    ],
    chapters: [
      { chapter: 'multirate', step: 4, label: 'Going up, and halving' },
      { chapter: 'multirate', step: 2, label: 'Why compute what you throw away?' },
    ],
  },
  polyphase: {
    idea: `A filter followed by a decimator by R computes R outputs and keeps one. Write down one output that survives, y[Rk] = Σ h[j] x[Rk − j], and sort its terms by j mod R. Taps 0, R, 2R, … only meet samples at positions divisible by R; taps 1, R + 1, … only meet those one before that. So each group of taps becomes a <b>branch</b> that receives every R-th input sample and runs at the low rate, and together the branches compute the same sum, each once per output.<br><br>Nothing is approximated: the same products are added in another order. In integers, as in the gates, the two forms agree to every bit; in floating point they differ in the last place. What changes is the count. N taps cost N multiplications an input sample done directly and N / R by branches, and in hardware the saving is in the multipliers: one multiplier per tap of a branch, sharing the branches through multiplexers and a coefficient ROM. The saving grows with R, which is why it is the first thing done to a large rate change, and why the same split serves the interpolator, with its zeros instead of its dropped outputs.`,
    example: {
      title: 'The chapter\'s polyphase decimator, 8-bit samples, ÷ 4 over 16 taps',
      body: `<pre>64 taps, ÷ 8:   direct 64 multiplications an input sample      branches 64 / 8 = 8
gates, R = 4, M = 4 (16 taps):
  4 multipliers × 972 NANDs = 3,888       a direct filter on this clock would need 16 × 972 = 15,552
  the whole decimator: 7,809 NANDs        (storage is the same either way: every sample is held somewhere)
  sum held in full: 2 × 8 + log₂ 16 = 20 bits, no rounding, no saturation</pre>The multiplier saving is the factor R; the registers and the adder are common to both forms.`,
    },
    mistakes: [
      'Thinking polyphase approximates the filter. It computes exactly the surviving outputs of the same filter; only the dropped results are skipped.',
      'Saving taps instead of multiplications. All N taps are still stored; what falls by R is the products an input sample, and so the multipliers.',
      'Splitting the taps by blocks (the first M, the next M) instead of by index mod R. The branches must hold every R-th tap, so that each meets samples at one fixed offset.',
      'Expecting the branches to need a different input rate. Each runs at the output rate, fed every R-th input sample; the commutator is a counter and a multiplexer.',
    ],
    chapters: [
      { chapter: 'multirate', step: 2, label: 'Why compute what you throw away?' },
      { chapter: 'multirate', step: 3, label: 'Branches in gates' },
    ],
  },
  halfband: {
    idea: `Halving the rate is the commonest step, and it has a special filter. Put the cut-off at a quarter of the rate and a windowed sinc, sin(2π · ¼ · t) / t, has a zero at every even distance from its middle, so about half the taps are exactly zero. The ones left are symmetric, so pairs share a multiplier. A 23-tap <b>half-band</b> filter has 13 taps that are not zero (the centre and 12 at odd distances) and needs only 7 multipliers, under a third of its length.<br><br>Its edge is broad, centred on a quarter of the rate, with the stop band symmetric about it, so it suits a stage that has plenty of room left: the early stage of a chain, where what must be kept is a small part of the band. Several in a row go far, and because each stage runs at half the rate of the one before, their costs form a series that adds up to little more than the first. Six halvings of the chapter's ÷ 64 job come to 4.03 multiplications for each input sample, with 13 taps at the first stage and 35 at the last.`,
    example: {
      title: 'The 23-tap half-band filter',
      body: `<pre>tap distance from the middle:  0   ±1  ±2  ±3  ±4  …  ±11
non-zero:                       yes yes  0  yes  0  …  yes      → 1 + 12 = 13 taps
symmetric pairs share one:      centre + 6 pairs         → 7 multipliers (23 × 0.30)

÷ 64 as six halvings (keep 40 %, 50 dB):   first stage 13 taps, last 35 taps
  4.03 multiplications an input sample, against 1,037 for one filter at the input rate</pre>The early stages are cheap because what folds onto the kept band comes only from the far edge, which lies a long way off.`,
    },
    mistakes: [
      'Using it to divide by anything but two. The zeros fall at a quarter of the rate, which is the new Nyquist for ÷ 2 and nothing else.',
      'Expecting a sharp edge. The transition is centred on a quarter of the rate and as wide as the length allows; it needs room, so a narrow band wants a different stage.',
      'Counting 23 multipliers. Half the taps are zero and the rest are symmetric: 7 multiplications cover it, and the multiplications by zero need no hardware.',
      'Using a window that disturbs the zeros. A windowed sinc keeps its zeros at the even distances; an equiripple design for another cut-off does not.',
    ],
    chapters: [
      { chapter: 'multirate', step: 4, label: 'Going up, and halving' },
      { chapter: 'multirate', step: 8, label: 'The whole job, priced' },
    ],
  },
  cic: {
    idea: `The cheapest low-pass there is, a moving average of R samples, has every tap equal to 1, and its sum can be kept running: y[n] = y[n − 1] + x[n] − x[n − R], an <em>integrator</em> and then a <em>comb</em> that subtracts a delayed copy. Put the integrator before the rate change and the comb after it, and the comb's R-sample delay at the high rate becomes a one-sample delay at the low rate: no line of R samples any more. Stack N of each and you have N moving averages in a row, a <b>cascaded integrator-comb</b> (Hogenauer, 1981): N adders at the high rate, N subtractors at the low rate, no multiplier and no sample memory.<br><br>Its response is the moving average's to the Nth power, (sin(π R f) / (R sin(π f)))^N. Every multiple of the new rate is a null, and those are exactly the frequencies that would fold onto DC, so what is about to alias is what it stops best. But it droops across the kept band, and between the nulls it rejects much less. The integrators overflow constantly and it does not matter: only differences of them reach the output, and two's complement differences are right modulo the word. The only sizing is the output's, N log₂ R bits more than the input. It does the large rate change at the rate where multipliers cost most, and a short ordinary filter after it, at the low rate, flattens the droop.`,
    example: {
      title: 'Order 3, ÷ 8, from 8-bit samples (the chapter\'s gates)',
      body: `<pre>DC gain R^N = 8³ = 512 = 2⁹   →   8 + 3 log₂ 8 = 17 bits
worst input: the most negative word, held:  −128 × 512 = −65,536 = −2¹⁶, which just fills 17 bits
impulse response: 3 boxcars of 8 convolved = 22 taps summing to 512
a tone at 1/8 of the input rate (one whole cycle in 8 samples): response 0, a null
at the new Nyquist (f = 1/16): 0.263 of DC, −11.6 dB: the droop
gates: 3,010 NANDs, no multiplier</pre>Order 4 and ÷ 16 would need 4 × 4 = 16 more bits. The chapter's whole-job comparison uses order 3, ÷ 16: aliases 57 dB down at the band edge, droop 0.43 dB.`,
    },
    mistakes: [
      'Saturating the integrators to stop them overflowing. The comb needs the wrapped number: a clamped register has lost the value whose difference is wanted.',
      'Sizing the registers by the input\'s width. They must grow by N log₂ R bits (Hogenauer\'s (R M)^N gain with M = 1), and every stage needs the top bit.',
      'Expecting a flat band and a sharp edge. The response droops and falls only slowly between nulls, so it is a first stage, not a whole decimator.',
      'Counting it as free. It has no multipliers, but its adders run at the input\'s full rate and set the clock; multiplications are all the cascade table counts.',
    ],
    chapters: [
      { chapter: 'radio', step: 4, label: 'A radio in arithmetic' },
      { chapter: 'multirate', step: 5, label: 'A moving average, rearranged' },
      { chapter: 'multirate', step: 6, label: 'Sums that wrap' },
      { chapter: 'multirate', step: 7, label: 'A CIC in gates' },
    ],
  },
  cordic: {
    idea: `A rotation takes four products, x′ = x cos θ − y sin θ and y′ = y cos θ + x sin θ, and before that someone must find cos θ and sin θ. Take cos θ out: x′ = cos θ (x − y tan θ), y′ = cos θ (y + x tan θ). If tan θ is a power of two, each multiplication is a shift, and a shift is only how the wires are laid. So never turn by the angle you want: turn by a sequence of fixed angles atan 1, atan ½, atan ¼, … (45°, 26.57°, 14.04°, 7.13°), each one way or the other as the sign of the angle still to go says, until the sum comes close enough. Three additions a stage, for x, y and the remaining angle z; Jack Volder published it in 1959.<br><br>Run the other way, <b>vectoring</b> steers y to 0 instead of z, and z adds up the turns: arctangent and magnitude from the same adders. The stages reach about ±99.9° of the axis, so a half-turn goes first when the target is further out. A stage gains about a bit of accuracy, so the word has to grow with them; each stage truncates. Against a ROM of sines CORDIC wins past about 6 bits, because a table doubles with every bit while CORDIC grows with the square of the accuracy; and the iterative form trades the pipeline's clock for a fraction of its area.`,
    example: {
      title: 'Rotating by 30°, then pricing the stages',
      body: `<pre>start x = 0.607253, y = 0, z = 30°        angle left after each stage (turn d = ±1):
 stage 0  z ≥ 0: turn +45°     → −15.000°        stage 3  z &lt; 0: turn −7.125°  →  4.654°
 stage 1  z &lt; 0: turn −26.57° →  11.565°        stage 4  z ≥ 0: turn +3.58°   →  1.077°
 stage 2  z ≥ 0: turn +14.04° →  −2.471°        stage 5  z ≥ 0                 → −0.712°
after 12 stages: cos 0.86591, sin 0.50020  (true 0.86603, 0.5), length 1.000
a stage, 14-bit (stage 3): 564 NANDs        pipeline of 12: 15,537 NANDs, 9.0 good bits
iterative: 2,551 NANDs, 13 clocks            four 16 × 16 multipliers: 4 × 3,572 = 14,288 before the sine is found</pre>Vectoring (3, 4): x ends at 8.2338 = 5 × 1.6468, z at 53.11° against the true 53.13°.`,
    },
    mistakes: [
      'Skipping a stage when the angle left is already small. Every stage must run so that the gain is one fixed number; skip some and each angle gets its own gain.',
      'Expecting 99.9° of reach to cover the circle. Past ±90° a half-turn (negate x and y, flip the angle\'s top bit) comes first.',
      'Believing more stages always help. Beyond the word\'s length the truncation of each stage costs as much as the stage gains; word, angle and stages must grow together.',
      'Choosing the pipeline when a result is needed once in many clocks. The iterative form is 2,551 NANDs against 15,537 and fits any task slower than 13 clocks a result.',
    ],
    chapters: [
      { chapter: 'cordic', step: 0, label: 'A rotation is four multiplications' },
      { chapter: 'cordic', step: 1, label: 'One way or the other' },
      { chapter: 'cordic', step: 4, label: 'Run it backwards' },
      { chapter: 'cordic', step: 6, label: 'Against a table' },
    ],
  },
  cordicgain: {
    idea: `Each CORDIC stage dropped a cos θ, so it lengthens the vector by 1 / cos(atan 2^−i) = √(1 + 2^−2i): 1.414 at stage 0, 1.118 at stage 1, rapidly nearer 1. Over many stages the product settles at 1.6468, and its inverse, 0.607253, is the constant to start from. The reason it can be paid in advance is that every stage runs whatever the angle, either way, and cos(−θ) = cos θ: the gain never depends on what was asked for. Begin at x = 0.607253, y = 0 and the output is cosine and sine with no multiplier at the end.<br><br>The consequences are for the word. The vector grows along the way: an input with both coordinates at full scale is √2 long and stretched becomes 2.33 times the range of either, so x and y need two more bits at the top, and nothing saturates because the sizing keeps it from having to. Vectoring returns a length that is still stretched by 1.6468 in x; a design that wants the true magnitude multiplies once at the end, or scales the result. And a design that skips stages loses the property, because each skipped combination has its own gain.`,
    example: {
      title: 'The gain, stage by stage, and what the start value does',
      body: `<pre>stage factor √(1 + 2^−2i):  1.4142  1.1180  1.0308  1.0078  …
cumulative after 1, 2, 3 stages:  1.4142   1.5811   1.6298     after 24 stages: 1.6468
1 / 1.6468 = 0.607253
rotate (1, 0) by 30°, 12 stages, no prescale:   length 1.6468
rotate (0.607253, 0) by 30°, 12 stages:         length 1.0000
a vector √2 long: √2 × 1.6468 = 2.33 times the range of one coordinate → 2 more bits</pre>The gain depends on the number of stages only: 12 or 24, not on the angle.`,
    },
    mistakes: [
      'Thinking each stage turns by a different amount of length. The gain per stage depends only on i; the sign of the turn does not matter, so the total is a constant.',
      'Dividing by 1.6468 at the end. The start value 0.607253 does it before the first stage, at no cost at all.',
      'Sizing x and y by the input\'s range. The stretched vector needs two more bits at the top; a word with none overflows at full scale.',
      'Forgetting the gain in vectoring mode. The magnitude comes out as 1.6468 times the length, and the angle is unaffected.',
    ],
    chapters: [
      { chapter: 'cordic', step: 2, label: 'The gain nobody can avoid' },
      { chapter: 'cordic', step: 4, label: 'Run it backwards' },
    ],
  },
};
