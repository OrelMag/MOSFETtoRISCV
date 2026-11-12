// Signals and spectrum: what a signal is made of. Fourier from a square wave up, a block and its spectrum, a pulse's width against its
// band, FIR filters (one in gates, lib/fir.ts, compared with comm/signals.ts every cycle), sampling and rounding, and a mixer, which is what
// the modem chapter needs next. Computed here, or pinned in tests/comm-signals.test.ts.

import { gibbsOvershoot, PATTERNS, poleGain, powerShare, smallestSample, swing1010, tauOf, toDb } from '../comm/fourier';
import { arrow, binChain, product } from '../comm/arrows';
import { aliasOf, binomialGain, BLOCK, firGain, FIR_TAPS, movingAverage, samplesOf, SIGNALS, sqnrDb, windowedSinc } from '../comm/signals';
import { FIR5, FIR_SETTLE } from '../lib/fir';
import { arrayMul } from '../lib/muldiv';
import { register } from '../lib/sequential';
import { flatten } from '../sim/flatten';
import { stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import { harmonicsWidget } from '../widgets/fourier';
import { withModel } from '../widgets/modelhost';
import { tide3d } from '../widgets/tide3d';
import { aliasWidget, arrowWidget, bandwidthWidget, filterWidget, firApi, firScene, FIR_FASTEST, mixerWidget, quantizeWidget, spectrumWidget } from '../widgets/signals';
import { numOf } from './order';
import type { Chapter } from './types';

const nf = (x: number, d = 2) => x.toFixed(d);
const pc = (x: number, d = 1) => `${(100 * x).toFixed(d)} %`;
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const FIR_NANDS = nands(FIR5), MUL8 = nands(arrayMul(8)), REG8 = nands(register(8));
const FIR_PERIOD = () => analyzeTiming(flatten(FIR5))?.period ?? 0;
const B1 = 1, R8 = 8;
const A8 = Math.exp((-2 * Math.PI * B1) / R8), HALF8 = 1 - 2 * A8, CLOSE = (2 * Math.PI * B1) / Math.LN2;
const SINC_31 = windowedSinc(31, 0.1);

export const chSignals: Chapter = {
  id: 'signals', num: numOf('signals'), title: 'Signals and spectrum', level: 'Communication',
  blurb: 'What a signal is made of: Fourier from a square wave up, band against pulse width, FIR filters with one in gates, sampling and aliasing, rounding, and the mixer that moves a band.',
  goals: [
    'read the same block of samples in time and in frequency, see a sine as an arrow and a bin as one, and say why a channel is specified by a gain against frequency',
    'trade a pulse\'s width against its band, and say what a filter of a given length can and cannot do',
    'build an FIR filter from registers and adders, and price it against general multipliers',
    'predict where a tone lands when it is sampled too slowly, and what each bit of a converter buys',
    'move a band up with a mixer and bring it back, the step every carrier needs',
  ],
  builds: ['message', 'wire', 'telegraph', 'adders', 'registers'],
  recap: {
    keep: [
      `A linear, time-invariant channel scales and shifts each sine and adds nothing new, so any signal can be split into sines, treated one by one and added back. A ±1 square wave is (4 / π) Σ sin(2π k f t) / k over odd k; its fundamental holds ${pc(powerShare(1), 0)} of the power, and a cut sum overshoots by ${pc(gibbsOvershoot(1000), 2)} however many terms it keeps.`,
      `N samples and N / 2 + 1 frequencies are the same numbers read two ways. A shorter pulse takes a proportionally wider band: band × width is about constant.`,
      `An FIR filter is a weighted sum of delayed samples, one multiplication a tap a sample. A moving average of n has zeros at multiples of 1 / n. A sharper edge needs more taps, about 3.3 / n cycles a sample of transition with a Hamming window.`,
      `The taps 1 4 6 4 1 are shifts, so the filter is ${FIR_NANDS} NANDs, ${5 * REG8} of them registers; programmable taps would add three 8 × 8 multipliers, ${3 * MUL8} more. Its gain is cos⁴(π f) relative to DC, 0 at half the sample rate. Symmetric taps delay every frequency alike.`,
      `Sampling at fs folds every tone into 0 … fs / 2: a tone at f and one at fs − f give the same samples, and nothing afterwards can separate them, so the filter goes before the sampler.`,
      `Rounding to b bits leaves a signal-to-error ratio of 6.02 b + 1.76 dB on a full-scale sine: 6 dB a bit.`,
      'Multiplying by a carrier moves a band to carrier ± f; multiplying by the same carrier again brings it back, with a copy at twice the carrier for a filter to remove.',
    ],
    check: [
      {
        question: 'A pulse is made four times shorter. What happens to the band it occupies?',
        options: ['About four times wider: band × width stays about constant', 'Four times narrower: less signal, less band', 'Unchanged: the band depends on the amplitude', 'Sixteen times wider: it goes as the square'],
        answer: 0,
        explain: 'Sharper features in time need higher frequencies to build them. That constant product is why a faster link needs a wider channel.',
        why: ['', 'A short pulse has less energy, but spread over more frequencies.', 'Amplitude scales every frequency alike and moves no energy between them.', 'The relation is proportional, not quadratic.'],
      },
      {
        question: 'A 7 kHz tone reaches a converter sampling at 10 kHz with no filter in front. What comes out?',
        options: [`Samples of a ${aliasOf(7, 10)} kHz tone, indistinguishable from a real one`, 'Nothing: the tone is above the band', 'A 7 kHz tone, with more error', 'A 17 kHz tone'],
        answer: 0,
        explain: 'It folds about 5 kHz: 10 − 7 = 3. The samples are exactly those of a 3 kHz tone, so the digital side cannot remove it afterwards.',
        why: ['', 'Sampling removes nothing. That is what makes aliasing dangerous.', 'No 7 kHz tone can be represented at this rate.', 'A sampled signal only holds frequencies up to half the rate.'],
      },
      {
        question: 'Why does the FIR filter in gates need no multiplier?',
        options: ['Its taps are small powers of two and sums of them: multiplying by 4 is wiring, and 6 is 4 + 2', 'Multipliers cannot run at the sample rate', 'Its adders multiply when given a carry', 'It only handles 1-bit samples'],
        answer: 0,
        explain: `Fixed taps can be chosen to be cheap. A general filter with programmable taps needs real multipliers, each ${MUL8} NANDs at 8 × 8.`,
        why: ['', 'They can, with a long enough clock period: this is about cost.', 'A carry adds one; it does not scale a word.', 'The samples are 8 bits, and the output 12.'],
      },
    ],
  },
  steps: [
    {
      title: 'A wave is a sum of sines',
      get body() {
        const f4 = poleGain(R8 / 2, B1), swing = swing1010(A8);
        return `
        <p>A UART, SPI and I²C take for granted a wire that delivers what was sent. Past a few centimetres at speed it does not (chapter ${numOf('wire')} measured how). The tool for what a channel does to a signal is the spectrum.</p>
        <p>A linear, time-invariant channel does one simple thing to a sine: it scales it and shifts it, and a sine of the same frequency comes out. So split any signal into sines, treat each on its own and add the results. That is <strong>Fourier analysis</strong>, and it is why a channel is specified by a gain against frequency. A ±1 square wave of frequency f is</p>
        <p style="text-align:center"><strong>x(t) = (4 / π) Σ<sub>k odd</sub> sin(2π k f t) / k</strong></p>
        <p>The fundamental alone holds most of the power, but the edges live in the rest. Cut the sum short and it overshoots by ${pc(gibbsOvershoot(1000), 2)} of the step next to each edge however many harmonics you keep (Gibbs): more of them narrow the ripple and do not lower it.</p>
        <p>At bit rate R the pattern 1010 is the fastest square wave the data can make, with its fundamental at <strong>R / 2, the Nyquist frequency</strong>. Other patterns add lower tones, and a long run reaches down to DC (zero frequency, a steady level).</p>
        <p>Now send ${R8} Gb/s through a single pole at ${B1} GHz, the channel of <a href="#/c/wire/0">A wire is not a wire</a>: its gain is 1 / √(1 + (f / B)²). In decibels (<a href="#/c/message/5">Sending a message</a>: 20 log₁₀ of an amplitude ratio), DC passes at 0 dB and the fundamental of 1010, at ${R8 / 2} GHz, at ${nf(toDb(f4), 1).replace('-', '−')} dB. Gain falling smoothly with frequency rounds the edges. In time the same pole keeps a = e<sup>−2πB/R</sup> = ${nf(A8, 3)} of the last level after each bit, and the two views agree exactly. Together they say what <span data-ahead="eye">intersymbol interference, each bit smeared into the next,</span> is: <em>unequal gain is a dependence on the pattern.</em> A long run settles at full swing because its energy is low in frequency; 1010 swings only (1 − a) / (1 + a) = ±${nf(swing, 3)}, because its energy is at Nyquist. The worst case is a lone bit after a long run, whose sample reaches 1 − 2a = ${nf(HALF8, 3)}. A channel with the same gain and delay at every frequency would treat all patterns alike and leave none; <span data-ahead="equalization">equalization, which undoes the channel's shape,</span> works by flattening the gain.</p>
        <div class="try">At ${R8} Gb/s on ${B1} GHz choose <strong>One 1 in eight</strong>: its smallest sample is the lowest of any pattern. Then 1010, at 6 Gb/s, and raise the bandwidth until the fundamental is under the pole. Finally push <strong>Harmonics</strong> from 3 to 25 on 1010 and watch the overshoot stay.</div>`;
      },
      widget: () => withModel(harmonicsWidget(), tide3d()),
      more: {
        derive: `<p>For a repeating pattern of n bits the coefficient of harmonic k is the DFT of the bits times the spectrum of one rectangular bit, sinc(k / n). The second factor is zero at every multiple of the bit rate, so NRZ has no energy at R itself; random data has the same envelope, sinc²(f / R) in power, with most of its power below R / 2. That is why a channel about as wide as Nyquist carries NRZ at all.</p>
          <p>The pole's gain in decibels (<a href="#/c/message/5">Sending a message</a>: 20 log₁₀ of an amplitude ratio) falls to ${nf(toDb(poleGain((3 * R8) / 2, B1)), 1).replace('-', '−')} dB at the third harmonic, ${(3 * R8) / 2} GHz. A smooth gain with a phase lag of up to 90° gives a 10–90 % rise of ln 9 · τ = ${nf(Math.log(9) * tauOf(B1) * 1000, 0)} ps, against a bit of ${nf(1000 / R8, 0)} ps. The harmonics scaled and turned one by one sum to the closed-form response, and a test holds them equal.</p>`,
        real: `<p>The fundamental of a square wave holds ${pc(powerShare(1), 0)} of the power and the first three odd harmonics ${pc(powerShare(3), 0)}. In <a href="#/c/serial/0">Fast serial links</a> a random stream is folded on itself and that spread is read as an eye.</p>
          <p>The sum has been built in brass. Thomson's tide predictor (1872–73) turned ten cranks at the rates of ten tidal components, each carrying a pulley on its pin; one cord ran under every movable pulley and over a fixed one, so the pen at its end moved by the sum of the ten motions: Fourier synthesis done by a cord. The pulleys went round with the pins, a little sideways too, which made small errors; later machines moved them straight up and down on slotted yokes. The model below does the same with the first ten harmonics of the pattern chosen above.</p>
          <p>Nyquist's 2B symbols a second of chapter ${numOf('telegraph')} is the same fact read from the other side, and the sampling limit later in this chapter is a third use of his name.</p>`,
        pitfall: `<p>Taking the 3 dB bandwidth as the limit on the bit rate. At R = 2B, with the fundamental at the corner, this pole's eye is nearly ideal (a = ${nf(Math.exp(-Math.PI), 3)}); it shuts only at ${nf(CLOSE, 1)} × B. A real trace falls faster than one pole, so its limit comes sooner, but the whole shape sets it and not the corner.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `A ${B1} GHz single pole carries ${R8} Gb/s. Which pattern comes out with the smallest sample at the end of a bit?`,
        options: ['One 1 after a long run of 0s', '1010, its energy all at Nyquist', 'A long run of 1s', '1100, its harmonics the most spread'],
        answer: 0,
        explain: `The sample is what a bit reached from where the last ones left the line. After a long run the line sits at the far rail, so a lone opposite bit reaches only 1 − 2a = ${nf(HALF8, 3)} (the widget's one 1 in eight follows a run of only seven, so it reads a little more). In 1010 each bit starts part of the way there, and reaches (1 − a) / (1 + a) = ${nf(swing1010(A8), 3)}.`,
        why: ['', `Its fundamental is heavily attenuated, but the line never settles at a rail between bits, so each bit starts closer: ±${nf(swing1010(A8), 3)}, more than the lone bit's ${nf(HALF8, 3)}.`, 'A long run has its energy at DC, gain 1: it reaches full swing, the largest sample of all.', `Two bits at a level do give the line longer to travel than a lone bit, so 1100 beats the lone bit's ${nf(HALF8, 3)}. But it also sits at a rail for two bit times, so its smallest sample is ${nf(smallestSample(PATTERNS[1].bits, R8, B1), 3)}, below 1010's ${nf(swing1010(A8), 3)}.`],
      },
    },
    {
      title: 'Arrows that turn: complex numbers',
      get body() {
        const r = product(arrow(2, 1), arrow(1, 1)), sq = samplesOf(SIGNALS.find((x) => x.id === 'square')!), b8 = binChain(sq, 8), b24 = binChain(sq, 24);
        const tone = samplesOf(SIGNALS[0]), t8 = binChain(tone, 8), t9 = binChain(tone, 9);
        return `
        <p>The last step split a signal into sines, and each sine took two numbers: how big it is, and how far along its cycle it has got (its <strong>phase</strong>). The next step's transform hands those two numbers back as <em>one</em> object, and so does every radio and filter chapter after it. The object is a <strong>complex number</strong>: school algebra with one new symbol, and a picture.</p>
        <p><strong>A quarter turn.</strong> Multiplying a number by −1 turns it half way round zero on the number line. Is there a multiplication that turns it a quarter? Do it twice and you must get −1, so call it <strong>j</strong>, with j × j = −1. (Mathematics books write i; engineers write j because i is already current.) No point on the line is j: it is a step at right angles to the line. A <strong>complex number</strong> a + jb is the arrow from zero to the point a along and b up; a is its <strong>real part</strong>, b its <strong>imaginary part</strong>. Its length is |z| = √(a² + b²) and its angle is atan2(b, a). Multiplying by j turns any arrow a quarter turn anticlockwise: 1, j, −1, −j, 1.</p>
        <p><strong>Multiplying is turning and scaling.</strong> Multiply two arrows and <em>the lengths multiply and the angles add</em>. The algebra, (a + jb)(c + jd) = (ac − bd) + j(ad + bc), is four multiplications and two additions (<a href="#/c/carriers/0">chapter ${numOf('carriers')}</a> prices it in gates); the picture is the quick way to think. In the figure, 2 + j (length ${nf(r.lengths[0])}, angle ${nf(r.angles[0], 1)}°) times 1 + j (${nf(r.lengths[1])}, ${nf(r.angles[1], 1)}°) is 1 + 3j (${nf(r.lengths[2])}, ${nf(r.angles[2], 1)}°): the lengths multiplied and the angles added. An arrow of length 1 only turns whatever it multiplies; a real number only stretches it.</p>
        <p><strong>An arrow that turns at a steady rate.</strong> The arrow of length 1 at angle θ is cos θ + j sin θ, written <strong>e<sup>jθ</sup></strong>. (The name comes from calculus, where it is the exponential function with an imaginary argument; all this book uses is the picture and the rule that follows from "angles add": e<sup>jα</sup> e<sup>jβ</sup> = e<sup>j(α+β)</sup>.) e<sup>j0</sup> = 1, e<sup>jπ/2</sup> = j, e<sup>jπ</sup> = −1. Now let the angle grow steadily, θ = 2πft: the arrow turns f times a second, and its shadow on the real axis is cos 2πft, on the imaginary axis sin 2πft. A <em>sampled</em> tone at f cycles a sample is the same arrow stepped by e<sup>j2πf</sup> each sample. So a tap k samples late sees the tone turned back by k steps, e<sup>−j2πfk</sup>: that is the factor in the response of <a href="#/c/signals/4">A filter is a sum of delayed samples</a>, whose answer is the sum of the tap-weighted, turned arrows.</p>
        <p><strong>A cosine is two arrows.</strong> cos θ = (e<sup>jθ</sup> + e<sup>−jθ</sup>) / 2: two arrows of length ½ turning opposite ways. Their upward parts cancel at every instant and their sideways parts add, so the sum never leaves the real axis. A real cosine of amplitude A is therefore two arrows of length A / 2, one at +f and one at −f. That is why the spectrum of a real signal mirrors itself, and why the next step needs only N / 2 + 1 of its N numbers.</p>
        <p><strong>A bin is one arrow.</strong> The transform's definition is X[k] = Σ x[n] e<sup>−j2πkn/N</sup>: multiply each sample by an arrow that turns <em>backwards</em> at k cycles a block, and add the arrows head to tail. Take a signal A cos(2πkn/N + φ). Its forward-turning arrow is turned back by exactly as much as it advances, so every one of its terms points the same way, e<sup>jφ</sup>, and N terms of length A / 2 add in a straight line to (N / 2) A e<sup>jφ</sup>. Its other arrow, and any tone at another frequency, keeps turning against the reference, and its terms go round and close up. So <strong>the length of a bin over N / 2 is the amplitude, and its angle is the phase</strong> of the cosine. In the widget, the one tone sin(2π · 8t) over ${BLOCK} samples is a cosine with φ = −90°: bin 8 is an arrow of length ${nf(t8.length, 0)} = N / 2 pointing straight down (${nf(t8.phase, 0).replace('-', '−')}°), and bin 9 closes to ${nf(t9.length, 0)}.</p>
        <div class="try">On <strong>Multiply</strong> set z = 2 + j and w = 1 + j, and read the product's length and angle.</div>
        <div class="try">On <strong>Turn</strong> drag θ to 180° and read −1; run it and watch the shadow trace a cosine.</div>
        <div class="try">On <strong>Two arrows</strong> switch the mirror arrow on and watch the sum stay on the real axis.</div>
        <div class="try">On <strong>A bin</strong> pick <em>One tone</em>, bin 8: the chain runs nearly straight; step to bin 9: it closes. Then <em>Square wave</em>, bin 8 (length about ${nf(b8.length, 0)}) and bin 24 (about ${nf(b24.length, 0)}, a third of the first, as 1 / k says).</div>`;
      },
      widget: () => arrowWidget(),
      more: {
        derive: `<p>Bin of a cosine. Write A cos(2πkn/N + φ) = (A/2)(e<sup>j(2πkn/N+φ)</sup> + e<sup>−j(2πkn/N+φ)</sup>). Multiplying by e<sup>−j2πkn/N</sup> leaves (A/2)e<sup>jφ</sup> + (A/2)e<sup>−jφ</sup> e<sup>−j4πkn/N</sup>. The first term is constant in n and sums to N (A/2) e<sup>jφ</sup>. The second turns 2k times round in N samples: a sum of equal steps taken a whole number of times round the circle is a geometric series with ratio e<sup>−j4πk/N</sup> ≠ 1 and (1 − ratio<sup>N</sup>) = 0, so it is 0 (for 0 &lt; k &lt; N / 2). Euler's e<sup>jθ</sup> = 1 + jθ − θ²/2 − jθ³/6 + … has real terms that are cos θ's series and imaginary terms that are sin θ's.</p>`,
        real: `<p><strong>The same point as I and Q.</strong> <a href="#/c/modem/4">Phase and amplitude</a>, two chapters on, writes a carrier as I cos 2πft − Q sin 2πft and plots a symbol as the point (I, Q). That point is the arrow I + jQ, and the carrier is the real part of that arrow turning at f: Re[(I + jQ) e<sup>j2πft</sup>] = I cos 2πft − Q sin 2πft. Its length is the amplitude and its angle the phase, as for a bin. A receiver that multiplies by e<sup>−j2πft</sup> stops the turning and reads the arrow off; chapters ${numOf('radio')} and ${numOf('sdr')} call that a complex mixer, and chapter ${numOf('zplane')} walks the arrow e<sup>j2πf</sup> round the unit circle to read a filter. A software radio's samples <em>are</em> arrows: each is two numbers, I and Q.</p>
          <p>Engineers took the arrow from Steinmetz (1893), who used it to treat alternating-current circuits as sums of turning arrows he called phasors; that is why they write j. Wessel (1797) and Argand (1806) drew the plane.</p>`,
        pitfall: `<p>Reading the −f arrow as "time running backwards". It is only the mirror arrow a real signal needs so that its imaginary parts cancel. A signal that is really complex, as in a radio after I/Q mixing, can have one without the other, and that is how an image is rejected (chapter ${numOf('radio')}).</p>`,
      },
      challenge: {
        kind: 'quiz', question: '(1 + j) multiplied by (1 − j) is:',
        options: ['2', '2j', '0', '√2'],
        answer: 0,
        explain: `Lengths multiply: √2 × √2 = ${nf(product(arrow(1, 1), arrow(1, -1)).lengths[2], 0)}. Angles add: +45° and −45° make 0°, so the product points along the real axis: (1 + j)(1 − j) = 1 − j + j − j² = 2.`,
        why: ['', 'That would need the angles to add to 90°; (1 − j) points 45° below the axis, so it takes 45° off.', 'Lengths multiply, they do not cancel: two arrows of length √2 give a product of length 2.', 'Both lengths count: they multiply, √2 × √2 = 2.'],
      },
    },
    {
      title: 'The same numbers in frequency',
      body: `
        <p>Take N samples of a signal. The discrete Fourier transform turns them into N complex numbers, the arrows of the last step, of which a real signal needs N / 2 + 1: one amplitude and phase for each frequency that fits a whole number of times in the block. Nothing is lost or gained. It is the same information, in a different basis, and either form can be turned back into the other.</p>
        <p>What changes is what is easy to see. Two tones are a tangle in time and two lines in frequency. A filter is an awkward sum in time and a plain multiplication in frequency. A short pulse, simple in time, spreads across the whole spectrum.</p>
        <p>A tone switched on and off has a peak at its frequency with skirts around it: the switching is itself a signal. Those skirts are why a transmitter must switch gently, and why tones in a shared band need guard space unless, as in <a href="#/c/carriers/0">Many carriers</a>, they are spaced so that each has a null at the others.</p>
        <div class="try">Compare the square wave with the one tone. Then pick the short pulse, and the tone switched on and off: read how much band each needs for 90 % of its power and for 99 %.</div>`,
      widget: spectrumWidget,
      challenge: {
        kind: 'quiz', question: 'A block of 256 real samples is transformed. How many independent amplitudes and phases come out?',
        options: ['129 frequencies, 0 to 128: at the two ends the value is real, so the count of real numbers is again 256', '256 frequencies, each with an amplitude and a phase: 512 numbers', '128 numbers: half of the samples are redundant', 'As many as the signal has tones'],
        answer: 0,
        explain: 'For real input the upper half of the DFT mirrors the lower. 127 complex values plus two real ones make 256 real numbers, the same count as went in.',
        why: ['', 'That would create information from nothing: the upper half is the conjugate of the lower.', 'None of the samples is redundant: the transform is invertible.', 'The transform has a fixed size, however many tones the signal has.'],
      },
    },
    {
      title: 'Narrow in time, wide in frequency',
      body: `
        <p>A pulse's width and its band trade against each other. Make a pulse half as long and its spectrum spreads twice as far. The product is about constant, and this is the bound behind every link: to send symbols faster they must be shorter, and shorter symbols need a wider channel. <a href="#/c/telegraph/4">Nyquist's 2B symbols a second</a> is the sharpest form of it.</p>
        <p>"Band" needs a definition, and there are several: where the gain is 3 dB down, where 90 % or 99 % of the power lies, the band a regulator lets you occupy. They differ by large factors for the same pulse, so quoted figures need their definition with them. The widget uses the 90 % band, and its second tile is that band times the pulse's width, both counted in samples and divided by the block: a number that should stay put while the pulse changes.</p>
        <p>Remove a pulse's upper frequencies and its edges round off and ripple. That is usually acceptable, because the receiver does not need the pulse: it needs to tell it from the other one at the moment it looks. With too little band the pulse no longer reaches half way, and that decision fails.</p>
        <div class="try">Narrow the pulse and watch the 90 % band grow while their product stays about the same. Then lower the band until the filtered pulse no longer crosses half way.</div>`,
      widget: bandwidthWidget,
      challenge: {
        kind: 'quiz', question: 'A link doubles its symbol rate with the same kind of pulse. What does it need from the channel?',
        options: ['About twice the band', 'Twice the power, and the same band', 'The same channel: rate is a property of the transmitter', 'Half the band, since each symbol is shorter'],
        answer: 0,
        explain: 'Pulses half as long take about twice the band. More power helps with noise and does nothing for the shape of the pulse.',
        why: ['', 'Power and band are separate resources. Power does not stop pulses overlapping.', 'A channel too narrow for the pulses smears them into each other.', 'That has the relation backwards.'],
      },
    },
    {
      title: 'A filter is a sum of delayed samples',
      body: `
        <p>The simplest digital filter is a moving average: each output is the mean of the last n inputs. A slow signal barely changes across n samples and passes; a fast one cancels itself. Weigh the samples differently and you have a <strong>finite impulse response</strong> filter: y[n] = Σ h[k] x[n − k], a <strong>convolution</strong> of the input with the weights. The weights h are the <strong>taps</strong>, and they are also the output when the input is a single 1.</p>
        <p>The response at a frequency f is |Σ h[k] e<sup>−j2πfk</sup>|: the DFT of the taps. A moving average of n has a null at every multiple of 1 / n (${nf(firGain(movingAverage(5), 0.2), 3)} at 0.2 for five taps), but large skirts between. For a chosen band the usual first design cuts the ideal low-pass response, a sinc (sin x / x), to n taps and tapers its ends with a window: ${SINC_31.length} taps with a cut-off at 0.1 give ${nf(firGain(SINC_31, 0.05), 3)} at 0.05 and ${firGain(SINC_31, 0.2).toFixed(4)} at 0.2.</p>
        <p>The edge's sharpness costs length: about 3.3 / n cycles a sample of transition under a Hamming window. So a filter twice as sharp has twice the taps, twice the multiplications per sample, and twice the delay. Symmetric taps delay every frequency by exactly (n − 1) / 2 samples, which keeps pulses in shape; this is called <strong>linear phase</strong>.</p>
        <div class="try">On the moving average, find the nulls and move them with the number of taps. On the windowed sinc, raise the taps and watch the edge sharpen. Read the gain at 0.25 for each design.</div>`,
      widget: filterWidget,
      challenge: {
        kind: 'quiz', question: 'A moving average of 8 samples at 80 kHz. What frequency does it remove completely?',
        options: ['10 kHz: a whole cycle fits in the 8 samples and averages to zero', '40 kHz only: the highest frequency there is', '8 kHz: one for each tap', 'None: an average only reduces'],
        answer: 0,
        explain: 'Its nulls are at multiples of 1 / 8 of the sample rate: 10, 20, 30 and 40 kHz.',
        why: ['', 'That is one of the nulls, but the lowest is at 10 kHz.', 'The null depends on the sample rate as well as the number of taps.', 'At these frequencies the sum is exactly zero.'],
      },
    },
    {
      title: 'A filter in gates',
      get body() {
        return `
        <p>Here is one built from what you already have. The taps are ${FIR_TAPS.join(' ')}: small, symmetric, and made of powers of two. Five <span data-show="x0 x1 x2 x3 x4">registers</span> hold the last samples. Multiplying by 4 or 2 is wiring, shown as the boxes marked ×, and costs nothing. Six is <span data-show="six">4 + 2</span>. The symmetric pairs share adders, <span data-show="sum04 sum13">x0 + x4 and 4 (x1 + x3)</span>, and <span data-show="sumA sumB">two more</span> add it up.</p>
        <p>That is ${FIR_NANDS} NANDs in all, ${5 * REG8} of them the registers. Programmable taps would replace the shifts with multipliers: three, since the symmetric pairs share one, at ${MUL8} NANDs each for 8 × 8, which nearly triples it (${nf((FIR_NANDS + 3 * MUL8) / FIR_NANDS, 1)} times). Chosen taps are a large saving, and it is how the fixed filters in real radios and modems stay small. The registers shift in ${FIR_PERIOD()} gate delays, but the sample rate is set by the adders: after a clock edge the output keeps changing for up to ${FIR_SETTLE} delays through the ripple carries, so that is the period if anything registers y.</p>
        <p>The input is 8-bit two's complement. Twelve bits at the output is exactly enough, since the taps sum to 16 and −128 × 16 = −2048 fits. The gain is cos⁴(π f), by the factors (1 + z⁻¹)⁴ (z⁻¹ stands for one sample of delay, so 1 + z⁻¹ is a sample plus the one before it; chapter ${numOf('zplane')} builds on that notation): 1 at DC, ${nf(binomialGain(0.25), 3)} at a quarter of the sample rate, and an exact 0 at half of it, because + − + − cancels in 1 − 4 + 6 − 4 + 1. The panel beside the circuit runs a tone through the gates with the model alongside.</p>
        <div class="try">Run the slow tone and read the peak. Run the quarter-rate tone and compare it with ${nf(binomialGain(0.25), 3)}. Then the fastest.</div>`;
      },
      scene: firScene,
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run the fastest tone the samples can carry through the filter, and read its output: nothing passes.',
        check: (st) => { const a = firApi.get(st); return !!a && a.agrees() && a.lastTone() === FIR_FASTEST && a.lastPeak() === 0; },
        hints: ['The panel has three tones. The fastest alternates + − + −.', 'After the first five clocks the registers hold + − + − +, and 1 − 4 + 6 − 4 + 1 = 0.'],
        answer: 'Half the sample rate alternates sign at every clock. The taps\' alternating sum is 1 − 4 + 6 − 4 + 1 = 0, so once the registers are full the output is exactly 0, as cos⁴(π / 2) = 0 says.',
        solve: (st) => { firApi.get(st)?.runTone(FIR_FASTEST); },
      },
    },
    {
      title: 'Sampling, and what folds',
      body: `
        <p>A converter reads a signal at fs samples a second. The <strong>sampling theorem</strong>, published by Whittaker, Kotelnikov and Shannon, says that a signal with nothing at or above fs / 2 is fixed entirely by its samples. Below that line nothing is lost.</p>
        <p>Above it, the samples still exist and they are wrong. A tone at f and one at fs − f give exactly the same numbers, since cos(2π(fs − f) k / fs) = cos(2π f k / fs) for every whole k. So every frequency folds into 0 … fs / 2, and no later processing can tell the difference: this is <strong>aliasing</strong>, and the only cure is an analog filter <em>before</em> the converter, an <strong>anti-aliasing filter</strong>.</p>
        <p>That filter needs room to fall, so real rates leave a margin. Telephone speech is cut off near 3.4 kHz and sampled at 8 kHz, which is where <a href="#/c/modem/0">the modem chapter</a>'s voice channel gets its edge. A CD holds up to about 20 kHz at 44.1 kHz.</p>
        <p>This is related to Nyquist's limit on symbols, and it is a different claim. Nyquist counts how many independent values a band can carry; sampling says how many readings capture a band. Both come to 2B a second.</p>
        <div class="try">With a 10 Hz sample rate, sweep the tone from 0 to 30 Hz and watch what the samples say: up, down, up. Find a tone that reads as 0 Hz.</div>`,
      widget: aliasWidget,
      challenge: {
        kind: 'quiz', question: `A converter samples at 48 kHz with no filter in front. A 30 kHz interferer is present. Where does it appear?`,
        options: [`At ${aliasOf(30, 48)} kHz, inside the audio band`, 'Nowhere: it is above the band and is lost', 'At 30 kHz, and a digital filter can remove it', 'At 78 kHz'],
        answer: 0,
        explain: '48 − 30 = 18 kHz. After sampling it is indistinguishable from a real 18 kHz tone, so no digital filter can remove it without removing that too.',
        why: ['', 'Sampling does not discard what is above the line: it folds it.', '30 kHz cannot be represented at this rate.', 'The samples hold nothing above 24 kHz.'],
      },
    },
    {
      title: 'Rounding to a number',
      body: `
        <p>Sampling fixes the time axis. A converter must also round each reading to one of 2<sup>b</sup> levels, and the error it makes looks like noise. For a busy signal the error is spread evenly over one step q, with power q² / 12. A full-scale sine has power (2<sup>b</sup> q / 2)² / 2, so the ratio is <strong>6.02 b + 1.76 dB</strong>: 6 dB for each bit.</p>
        <p>That gives ${sqnrDb(8).toFixed(1)} dB at 8 bits and ${sqnrDb(16).toFixed(1)} dB at 16, a CD's width. The figure is a ceiling: a signal below full scale gets less, by exactly its shortfall, and a real converter adds its own noise and jitter (sampling instants that wobble). Datasheets quote the bits actually achieved as the <em>effective number of bits</em>.</p>
        <p>So a converter's width and a link's SNR have to match. Bits below the noise are wasted power, and too few bits add noise of their own. <a href="#/c/noise/0">The next chapter</a> takes up noise itself.</p>
        <div class="try">At 1 bit the sine is a square. Raise it and read the measured ratio against the formula. At low widths the error is plainly not noise-like, and the two disagree most there.</div>`,
      widget: quantizeWidget,
      challenge: {
        kind: 'quiz', question: 'A receiver\'s signal sits 42 dB above its analog noise. About how many converter bits are worth paying for?',
        options: ['About 7 or 8: more bits only record the noise more exactly', '42: one per dB', '3: log₂ of 42 dB', '16: always use the most available'],
        answer: 0,
        explain: '(42 − 1.76) / 6.02 is 6.7 bits; a bit or so of margin keeps the rounding well under the analog noise.',
        why: ['', 'Each bit is worth 6 dB, not 1.', 'A decibel is already a logarithm, and one bit is worth 6.02 dB: divide, do not take a log of it.', 'That spends power and pins on a record of the noise.'],
      },
    },
    {
      title: 'A mixer moves a band',
      body: `
        <p>A cable or an antenna passes a band somewhere up the spectrum, and a voice or a stream of bits sits near zero. A <strong>mixer</strong> moves one to the other, and it is only a multiplication: cos a · cos b = ½ cos(a − b) + ½ cos(a + b). A tone at f times a carrier at fc gives two tones, at fc − f and fc + f. A whole band moves the same way, doubled into two sidebands. New frequencies appear because a mixer is linear but changes with time, so the first step's rule, sine in and the same sine out, does not bind it.</p>
        <p>The receiver multiplies by the same carrier again. The band lands back at zero, with a copy near 2fc that a low-pass filter removes. That is the whole of a basic radio or modem. The hard part is the phase: if the receiver's carrier is out by φ, the result falls by cos φ, and at 90° it vanishes. The modems of chapter ${numOf('modem')} turn that from a problem into a resource, with one signal on the cosine and a second on the sine. Before them, the next chapter asks how faint a signal can be and still be read: noise.</p>
        <div class="try">Set the tone and the carrier and predict the two lines. Then tick the second multiplication and find the tone back where it started.</div>`,
      widget: mixerWidget,
      challenge: {
        kind: 'quiz', question: 'A band of 0 to 4 kHz is multiplied by a 100 kHz carrier. What band does it occupy?',
        options: ['96 to 104 kHz: both sidebands, 8 kHz in all', '100 to 104 kHz only', '0 to 104 kHz', '400 kHz, the product of the two'],
        answer: 0,
        explain: `Each tone f becomes 100 − f and 100 + f, so the band doubles in width. Sending only one sideband, or a second signal on the sine (I and Q, chapter ${numOf('modem')}), gets that width back.`,
        why: ['', 'The product has both a sum and a difference, so both sides appear unless one is filtered off.', 'Nothing is left near zero: the product of two cosines has only the sum and difference.', 'Frequencies add and subtract; they do not multiply.'],
      },
    },
  ],
};
