// The fuller codex for the Signal processing level: converters, filters that learn, pictures (codexdspd.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE9D: Record<string, CodexMore> = {
  enob: {
    idea: `Rounding to b bits adds an error spread evenly over one step, whose power is a twelfth of the step squared; against a full-scale sine that is a signal to noise ratio of <b>6.02 b + 1.76 dB</b>, and no b-bit converter does better. A real one is worse: thermal noise, nonlinearity, a shaky clock. So it is judged backwards. Measure the signal against everything else in the band, noise <em>and</em> harmonics (SNDR), and ask how many bits a perfect converter would need to reach that: ENOB = (SNDR − 1.76) / 6.02.<br><br>The bits on the front of the datasheet are the bits the converter delivers; effective bits are how many of them are right, and they fall as the input frequency rises, because a clock's jitter costs 20 dB for every ten times the frequency. The figure is also tied to the level of the test tone: the formula assumes full scale, and a tone at half scale gives 6.02 dB less against the same noise, a whole bit lower. The same arithmetic scores the sigma-delta chain, from the words it delivers at the low rate.`,
    example: {
      title: 'Bits delivered, bits effective',
      body: `<pre>perfect 8 / 12 / 16 bits:          49.9 / 74.0 / 98.1 dB
16-bit part, SNDR 74 dB:           (74 − 1.76) / 6.02 = 12.0 effective bits
14-bit part, SNDR 62 dB:           10.0 effective bits
1 ps jitter, 1 MHz tone:           104.0 dB → 17.0 bits
1 ps jitter, 100 MHz tone:          64.0 dB → 10.3 bits, however many are delivered
sigma-delta chain, ÷64 / ÷128 / ÷256: 12.1 / 14.7 / 17.2 bits on a half-scale tone</pre>The chain's figures are measured on words at the low rate and, being judged on a half-scale tone, read about a bit lower than the same noise would against full scale.`,
    },
    mistakes: [
      'Taking the bits on the front page as the accuracy. A part that delivers 14 bits and measures 62 dB of SNDR has 10 effective bits; four of its bits are below the noise.',
      'Applying 6.02 b + 1.76 to a signal below full scale. The ratio falls decibel for decibel with the level, so a half-scale tone reads a bit lower for the same noise.',
      'Quoting effective bits without a frequency. They fall as the input rises: with 1 ps of jitter, 17.0 bits at 1 MHz and 10.3 at 100 MHz.',
      'Mixing SNR and SNDR. Noise alone leaves out the harmonics; effective bits are defined from signal over noise <em>and distortion</em>.',
    ],
    chapters: [
      { chapter: 'signals', step: 6, label: 'Rounding to a number' },
      { chapter: 'converters', step: 0, label: 'What a converter is judged by' },
      { chapter: 'converters', step: 3, label: 'A shaky clock' },
      { chapter: 'converters', step: 6, label: 'Many bits from one' },
    ],
  },
  sar: {
    idea: `A successive-approximation converter is a binary search made of hardware. Set the top bit, so that the DAC puts out half scale; ask a comparator whether the input is above it; keep the bit if so and clear it if not; then set the next bit and ask again. b bits take <b>b clocks</b> with <b>one comparator</b>, and a DAC. A flash converter is the direct opposite: a comparator at every step of the ladder, all deciding at once, in one clock, with 2<sup>b</sup> − 1 of them, so every bit doubles the load on the input and the power.<br><br>The cost moves into the DAC, which usually is a row of binary-weighted capacitors whose charge is the sum of those switched in. It must be as accurate as the result: its largest capacitor is half of the total, so 1 % in it is 1.28 codes at 8 bits, and the early decisions are final, so a wrong level at the top bit is not corrected by anything below it. Past about 12 bits, trimming or calibration becomes part of the design. The conversion rate is the clock over b, which is why a SAR is the middle choice: slower than flash, far cheaper per bit, and no better than its DAC.`,
    example: {
      title: 'An input of 0.3 on a ±1 scale, 8 bits',
      body: `<pre>trial level  0       0.5     0.25    0.375   0.3125  0.28125 0.296875 0.3046875
input above?  yes     no      yes     no      no      yes     yes      no
bit kept      1       0       1       0       0       1       1        0   → 10100110 = 166
the top capacitor 1 % too big:   same input → 10100101 = 165
flash, 8 bits: 255 comparators in one clock;  12 bits: 4,095;  SAR: 8 clocks, then 12, one comparator</pre>The code 166 is the right one, the input's place among 256 steps. A capacitor error moves the levels tried, and the code with them.`,
    },
    mistakes: [
      'Assuming the comparator sets the accuracy. Every trial compares the input with a level the DAC makes, so the DAC\'s errors are errors in the result: with the top capacitor 1 % off, the same input reads 165 and not 166.',
      'Comparing flash and SAR by bits alone. From 8 to 12 bits a flash goes from 255 comparators to 4,095, sixteen times; a SAR keeps its one and takes four clocks more.',
      'Expecting a later bit to repair an earlier one. The search never revisits a decision, so a wrong top-bit trial is final.',
      'Forgetting that the conversion rate is the clock divided by b. Twelve bits at the same clock is a third slower than eight.',
    ],
    chapters: [
      { chapter: 'converters', step: 1, label: 'Compare, and compare again' },
      { chapter: 'converters', step: 2, label: 'The way back: a ladder' },
      { chapter: 'converters', step: 6, label: 'Many bits from one' },
    ],
  },
  r2r: {
    idea: `Going from a word to a voltage has an elegant answer in a ladder of just two resistor values. Each bit switches a 2R between 0 and the reference, and series R's join the nodes. At the far end the terminating 2R and the last bit's 2R in parallel make R, the series R in front makes 2R again, and the same repeats at every node: looking back from any node the rest of the ladder is 2R. So each stage splits the voltage in half, and each bit counts half as much as the one before. A ladder of n bits has n 2R legs, n − 1 series R's and one terminating 2R: 16 resistors for 8 bits, of two values.<br><br>What the ladder cannot do is match itself for free. Judge a staircase by <b>DNL</b>, how far each step is from one LSB (at −1 or below it went backwards), and <b>INL</b>, how far each output is from the straight line between the ends. The worst step is usually in the middle of the range: from 0111 1111 to 1000 0000 the MSB turns on and every other bit turns off, so that step is the difference of all their errors. Matching is a matter of area, and that is the price of a converter's bits.`,
    example: {
      title: 'An 8-bit ladder, ideal and 1 % out',
      body: `<pre>ideal outputs, as a share of the reference:
  code 1 → 0.0039   code 127 → 0.4961   code 128 → 0.5   code 255 → 0.9961   (code / 256)
resistors 1 % out, 200 seeded ladders:
  the worst step is the 127 → 128 one in 130 of them
  its median size is 1.2 LSB; the chapter's ladder 5 has 1.9
resistors 3 % out, ladder 1: worst |DNL| 2.2 LSB, not monotonic</pre>A DNL of −1 or below means one code puts out less than the one before.`,
    },
    mistakes: [
      'Mixing DNL and INL. DNL is one step against one LSB; INL is the distance from the line through the ends, so a ladder can have a small DNL everywhere and a large INL from errors that add up.',
      'Looking for the worst step anywhere. It is usually the middle code, where every bit changes at once; elsewhere fewer bits change.',
      'Matching the absolute resistor values. Only the ratio of 2R to R matters; a ladder of any total resistance with the same ratio gives the same staircase.',
      'Trusting a ladder whose steps are all positive on one sample. At 3 % an 8-bit ladder can go backwards, and which one does depends on the seed: a tolerance is a statement about many ladders.',
    ],
    chapters: [
      { chapter: 'converters', step: 2, label: 'The way back: a ladder' },
      { chapter: 'converters', step: 1, label: 'Compare, and compare again' },
    ],
  },
  jitter: {
    idea: `Every sample is taken at an instant, and no clock is perfectly on time. If the instant is σ seconds off, the sample reads the signal's value there, and the error is the signal's slope times σ. A full-scale sine at f has a largest slope of 2π f, so its mean square error is half of (2π f σ)² against a power of one half: the signal to noise ratio is <b>−20 log<sub>10</sub>(2π f σ) dB</b>. It has no number of bits in it and no sample rate; it goes with the <em>signal's</em> frequency, and so does the damage.<br><br>The limit is unforgiving at the top of the range. A radio's band sampled directly at 100 MHz with a clock of 1 ps RMS jitter is limited to 64.0 dB, 10.3 effective bits, whatever the converter delivers; a low rate does not help, because the slope belongs to the input. The sum assumes a small error, and stops meaning anything once σ is a good share of a period. The cure is the clock, not the arithmetic, which is why a converter at high frequency costs more in its oscillator than in its gates.`,
    example: {
      title: 'The limit, and the same limit measured',
      body: `<pre>1 ps of jitter:  1 MHz → 104.0 dB (17.0 bits)    100 MHz → 64.0 dB (10.3 bits)
10 ps:            1 MHz → 84.0 dB   10 MHz → 64.0 dB   100 MHz → 44.0 dB
measured on a sine sampled at 1 GHz with seeded Gaussian errors, 10 ps:
                  1 MHz → 83.9      10 MHz → 63.9      100 MHz → 43.9
the same clock on 70 MHz and on 7 MHz: 20.0 dB apart</pre>Each ten times the frequency is ten times the slope, which is 20 dB, a little over three bits.`,
    },
    mistakes: [
      'Reading jitter as a sample-rate problem. The formula has the signal\'s frequency in it and no sample rate at all.',
      'Buying more bits to fix it. The limit does not mention bits; at 100 MHz and 1 ps nothing above about 10 effective bits can show.',
      'Thinking undersampling lets a slow clock off. A 70 MHz band sampled at 10 MHz still has the slope of a 70 MHz signal, and the same 20 dB penalty against 7 MHz.',
      'Using the formula at large jitter. It is a small-error sum; it stops holding when the limit it gives falls to about 10 dB, where the error is a big share of the signal.',
    ],
    chapters: [
      { chapter: 'converters', step: 3, label: 'A shaky clock' },
      { chapter: 'converters', step: 0, label: 'What a converter is judged by' },
    ],
  },
  sigmadelta: {
    idea: `Matching is what bits cost in a ladder or a SAR, and rate is cheap. A sigma-delta converter takes one bit, whose two levels cannot be out of line with each other, and samples far faster than the signal needs. The loop adds up input minus output in an integrator and decides from the sign of the sum, so over time the bits' average follows the input. In symbols, with E the error the quantizer added: <b>V = z<sup>−1</sup>U + (1 − z<sup>−1</sup>)<sup>2</sup>E</b> at order 2 (the digital loop here, y₁ += u − v, y₂ += y₁ − v, holds it to the bit). The signal comes through delayed; the error comes through a filter that is nearly zero at low frequencies and largest at half the rate. A filter after the loop, a CIC, removes the shaped noise and lowers the rate.<br><br>A one-bit quantizer alone has a peak signal to noise ratio of only 1.76 dB (a signal power of ½ against an error power of ⅓ on a step of 2); everything beyond that is oversampling and shaping. The textbook sum treats the error as added white noise and gets the slope right: at 64 times the rate and half scale it says 73.2 dB, and the loop measures 69.9. Most of the gap is that the error power is 0.55 and not ⅓ (with it the sum gives 71.0). Near full scale the integrators grow, peaking at 4.2, 8.3 and 20.2 full scales for inputs of 0.5, 0.8 and 0.95, and the measured figure falls to 65.5 and 50.0 dB at the last two; an analogue integrator clips far sooner.`,
    example: {
      title: 'Order 2, half-scale tone',
      body: `<pre>             rate ×16   ×32   ×64   ×128  ×256     (measured, dB)
order 2         39.9  55.7  69.9  83.8   96.6
order 1         30.3  40.5  49.8  56.1   63.6
at ×64:  measured 69.9    model 73.2    model with the measured error power 71.0
gates: loop 12 bits 1,283 NANDs; 16 bits 1,579; loop + CIC (N = 3) at ÷64: 5,181
effective bits of the chain at ÷64 / ÷128 / ÷256:  12.1 / 14.7 / 17.2</pre>The one-bit DAC costs nothing in gates: the words for + and − full scale differ only in their top bits, so it is the decision, inverted, on some wires.`,
    },
    mistakes: [
      'Thinking the loop removes the quantization error. It moves it: the identity holds to the bit on the error the loop recorded, and the total error power at order 2 goes up six-fold.',
      'Keeping every 64th bit instead of filtering. All the noise sits above the band, and decimation without a filter folds it down over the tone.',
      'Trusting the white-noise model for the level. It has the slope and is 3.2 dB out here, because the error is not white nor independent of the input; order 1 is worse, its error falling into patterns tied to the input.',
      'Driving it to full scale. The integrators grow as the input nears it, and past 0.95 the words of this design wrap; the usable range of a real part is a design question of its own.',
    ],
    chapters: [
      { chapter: 'converters', step: 4, label: 'One bit, and feedback' },
      { chapter: 'converters', step: 5, label: 'The loop in gates, and its CIC' },
      { chapter: 'converters', step: 6, label: 'Many bits from one' },
    ],
  },
  noiseshaping: {
    idea: `A quantizer adds an error whatever you do. Noise shaping puts it where it does not matter. With feedback around the quantizer the error reaches the output through a <b>noise transfer function</b>, (1 − z<sup>−1</sup>)<sup>L</sup> for L integrators, whose magnitude is (2 sin(ω/2))<sup>L</sup>: tiny at low frequencies, large at high. The signal goes through with a delay and is untouched. Nothing has been removed, only moved, and the part of the spectrum you keep is the one the error has left.<br><br>The gain follows from the integral of the error over the band: its power goes as the band to the power 2L + 1, so each doubling of the rate buys (2L + 1) × 3.01 dB, which is plain oversampling's 3 dB plus 6 for each order. The measurements land near it at order 2 and wander at order 1, whose noise is less like noise. Two prices come with it: the total error power rises, since the squares of the coefficients 1, −2, 1 sum to 6, and a filter must take the shaped noise away or it folds back in when the rate drops. That is the job of the CIC after the loop.`,
    example: {
      title: 'The filter (1 − z⁻¹)² and what it buys',
      body: `<pre>|NTF| at the edge of the band kept at ×64:   −52.4 dB
|NTF| at half the rate:                      +12.0 dB
total error power gain: order 2  1² + 2² + 1² = 6 (7.8 dB);  order 1  1² + 1² = 2 (3.0 dB)
theory per doubling of the rate:  order 1  9.0 dB   order 2  15.1 dB
measured at order 2, 16 → 32 → 64 → 128 → 256:  15.8, 14.2, 13.9, 12.7 dB</pre>The gain per doubling is a little under the theory at high ratios, and falls further as the input nears full scale.`,
    },
    mistakes: [
      'Believing shaping lowers the noise. In total it raises it, six-fold at order 2; it is the band that gets quieter.',
      'Skipping the filter that follows. Without it, lowering the rate folds the shaped noise over the tone, as the two clips in the chapter show.',
      'Counting 6 dB for each doubling per order. That is the shaping alone; oversampling adds 3 dB a doubling, and the total is (2L + 1) × 3.01.',
      'Expecting the gain to hold at every level. The integrators grow as the input nears full scale and the measured figure falls well before the words run out.',
    ],
    chapters: [
      { chapter: 'converters', step: 4, label: 'One bit, and feedback' },
      { chapter: 'converters', step: 6, label: 'Many bits from one' },
    ],
  },
  wiener: {
    idea: `Say an FIR filter w takes the input x and should produce d, and judge it by the mean of the squared error. That mean is J(w) = E[d²] − 2 wᵀp + wᵀR w: a quadratic in the coefficients, a bowl with one bottom, where R holds the autocorrelations of x and p the correlations of x with d. Set the slope −2p + 2R w to zero and you have the <b>Wiener solution</b>, R w = p, with a smallest error of E[d²] − pᵀw.<br><br>It takes no knowledge of how d was made, only those two sets of correlations, so any way of making d that gives the same correlations has the same best filter. For a stationary input R is Toeplitz, a constant along each diagonal, and Levinson's recursion solves it in about n² operations where a general solver needs n³. In a call the answer is out of reach: the statistics have to be estimated first, and by then the path has changed. It stays the target, and the proof that a learning filter has got there: LMS reaches the same bottom without ever forming R or p.`,
    example: {
      title: 'Two taps by hand, and the cost at 128',
      body: `<pre>r = [1, 0.5]  (R = [[1, 0.5], [0.5, 1]])      p = [0.8, 0.1]
w = R⁻¹ p = [1.0, −0.4]
with E[d²] = 1:  smallest error = 1 − (0.8 × 1.0 + 0.1 × (−0.4)) = 0.24
128 taps:  Levinson 128² = 16,384 operations;  general solver 128³ = 2,097,152, 128 times as many</pre>Levinson's recursion returns the same two coefficients as the direct solution, and in the chapter it agrees with scipy's solve_toeplitz to 8 places.`,
    },
    mistakes: [
      'Thinking it needs a model of how d is produced. Only R and p enter; the echo path itself is never needed to find the best filter.',
      'Treating it as a real-time method. By the time the statistics are estimated the path has moved, which is the reason for walking down the bowl instead.',
      'Solving a Toeplitz system as a general matrix. Levinson is n² where Gaussian elimination is n³, which at 128 taps is a factor of 128.',
      'Expecting zero error. The solution is the best a filter of that length can do: a 32-tap canceller on a 128-tap path leaves the tail it has no taps for, and reaches 10.3 dB in the chapter\'s run.',
    ],
    chapters: [
      { chapter: 'adaptive', step: 1, label: 'The best a filter can do' },
      { chapter: 'adaptive', step: 2, label: 'One step downhill, per sample' },
    ],
  },
  lms: {
    idea: `Rather than solve for the bottom of the bowl, walk to it. The slope needs expected values, but one sample gives a noisy estimate, −2 e x. In 1960 Widrow and Hoff took that seriously, and <b>LMS</b> is the result: e = d − Σ w<sub>k</sub> x<sub>k</sub>, then w<sub>k</sub> ← w<sub>k</sub> + μ e x<sub>k</sub>. One more multiply per tap, no correlations, no matrix, no idea what the signal is. Any step may go the wrong way; on average they go downhill. A coloured input makes the bowl a long narrow valley: the walk crosses it quickly and creeps along it, at a rate set by the spread of the correlation matrix's eigenvalues.<br><br>The step has a limit. It shrinks the error only while μ is below 2 over the energy in the filter's samples, 2 / (N σ²) for a steady input, and for speech the loudest stretch decides, so a loud input can break a filter that was stable. <b>NLMS</b> divides the step by that energy and behaves the same at any loudness, with μ anywhere between 0 and 2. In gates, learning costs a second multiplier and an adder per tap, so a learning filter is about twice the price of a fixed one; the update e × x is shifted down and rounded half up, which leaves a dead zone where small updates are zero.`,
    example: {
      title: 'Step limits on the chapter\'s far end, and what a tap costs',
      body: `<pre>128 taps, generated far-end sound
  2 / (N σ²)  from the average power:        1.27
  2 / (energy of the loudest 128 samples):   0.135   ← where plain LMS diverges
  NLMS: μ in (0, 2), whatever the loudness
LMS tap, 12-bit words:   4,580 NANDs, 4,172 of them the two multipliers
four taps with their sums: 19,188 NANDs
update e × x shifted down 7 places, rounded half up: an update inside ±64 is zero (the dead zone)</pre>The limit is set by the loudest stretch, not the average: 1.27 would have let the run diverge.`,
    },
    mistakes: [
      'Taking the step limit from the average power. For speech it is set by the loudest stretch of N samples, here 0.135 against 1.27.',
      'Calling NLMS faster. It only makes the step independent of loudness; a coloured input still crawls along the valley.',
      'Truncating the update instead of rounding. A truncated product takes one off any small negative value, so the coefficients slide away with nothing to stop them.',
      'Leaving it learning during near-end talk. That voice lands in the error and pushes the coefficients away from the answer.',
    ],
    chapters: [
      { chapter: 'adaptive', step: 2, label: 'One step downhill, per sample' },
      { chapter: 'adaptive', step: 3, label: 'An echo canceller' },
      { chapter: 'adaptive', step: 5, label: 'A tap in gates' },
    ],
  },
  echocancel: {
    idea: `A speaker at your end plays what the far end said; it comes back through the room into your microphone, and the far end hears itself. The room is a filter, and nobody can stop the call to measure it, but the signal sent to the speaker is known to the bit. So a copy of the path, learnt by NLMS, is run on that signal and its output subtracted from the microphone: what is left is the near-end voice and whatever the copy got wrong. The measure is <b>echo return loss enhancement</b>, ERLE, how far the echo has come down, in dB.<br><br>It works because the far-end signal is known and the path linear. Its limits are the length, the learning rule and the near end. Echo beyond the last tap cannot be subtracted, however long it runs. Plain LMS is stable only below a step set by the loudest stretch; NLMS does not mind loudness. And near-end speech is, to the filter, a huge error to be fixed: it wrecks what has been learnt, so a real canceller stops learning while someone talks, which is where most of its difficulty lies. This model is told when that is; a real one has to detect it.`,
    example: {
      title: 'The chapter\'s run: 32,000 samples at 8 kHz, a 128-tap hidden path',
      body: `<pre>128 taps, NLMS μ = 0.5:                      ERLE 30.7 dB (last quarter)
32 taps, the tail has none:                   ERLE 10.3 dB
near-end talk, learning left on:               7.6 dB once the voice has ended
near-end talk, learning frozen while it lasts: 29.7 dB
cost: 128 taps × 2 multiplications = 256 a sample;  × 8,000 = 2,048,000 a second;  128 samples = 16 ms</pre>The difference between leaving learning on and freezing it is 22 dB.`,
    },
    mistakes: [
      'Leaving learning on in double talk. The voice lands in the error and the filter walks away from the path: 7.6 dB against 29.7 with it frozen.',
      'Giving the filter fewer taps than the echo lasts. What is beyond them stays as a floor: 10.3 dB at 32 taps against 30.7 at 128.',
      'Using plain LMS on speech. Its limit is set by the loudest stretch, so a loud far end can make a stable canceller diverge; NLMS divides that out.',
      'Reading the model\'s figures as a compliance claim. The far end here is generated sound and the path a seeded model; ITU-T G.168 sets its own tests and none is claimed.',
    ],
    chapters: [
      { chapter: 'adaptive', step: 0, label: 'An echo nobody can measure' },
      { chapter: 'adaptive', step: 3, label: 'An echo canceller' },
    ],
  },
  separable: {
    idea: `A 2-D filter slides a kernel over the picture, and each output is the weighted sum of the samples under it: n × n multiplications a sample for a kernel n across. If the kernel is a product, K[j][i] = c[j] r[i], the sum factorises: first filter every row with r, then every column of the result with c. The answer is the same picture, for 2n multiplications a sample. Binomial blur is the standard case: [1 2 1] across times [1 2 1] down, over 16.<br><br>The test is that every row of the kernel is a multiple of one row (the matrix has rank one). A box is separable and so is Sobel (a slope across, [1 2 1] down); the sharpening kernel is a plus shape, with a minus one above and below the middle that no row times column makes, and is not. The saving grows with the kernel: 7.5 times at 15 × 15. The same idea is why the 8 × 8 DCT is two passes of an 8-point transform, and why resizing runs a row pass then a column pass. The second pass reads the first pass's results, so a hardware version needs a store between them.`,
    example: {
      title: 'Blur two ways',
      body: `<pre>[1 2 1]ᵀ × [1 2 1] = [[1 2 1],[2 4 2],[1 2 1]]  (÷ 16 for unit gain)
multiplications a sample:   3 × 3:  9 → 6      15 × 15:  225 → 30   (7.5×)      9 × 9: 81 → 18
the scene blurred whole, and as two passes: largest difference 0
8 × 8 DCT, one block:  direct sum 64 × 64 = 4,096 products;  rows then columns, 16 passes of 64 = 1,024;
                       with 22 products a pass: 16 × 22 = 352</pre>The chapter's tests hold the two-pass blur equal to the whole kernel to rounding.`,
    },
    mistakes: [
      'Assuming any symmetric kernel is separable. The sharpening kernel is symmetric and is not a product of a row and a column.',
      'Counting only the multiplications. The column pass reads the row pass\'s results, so the intermediate picture, or a column\'s worth of it, has to be stored.',
      'Rounding to whole levels between the passes and expecting identical pictures. The two forms agree exactly in real numbers and to rounding in integers.',
      'Treating n² as inherent to a 2-D filter. For a separable kernel the cost grows as 2n, which at 15 × 15 is 30 against 225.',
    ],
    chapters: [
      { chapter: 'pictures', step: 1, label: 'Filters in two dimensions' },
      { chapter: 'pictures', step: 3, label: 'Cosines in 8 × 8' },
      { chapter: 'pictures', step: 4, label: 'The DCT in gates' },
    ],
  },
  resampling: {
    idea: `Shrinking a picture m times keeps one sample in m along each axis, and what the multirate chapter said about sound holds on both: anything above 1/(2m) cycles a sample cannot be held by what is kept, and it does not vanish, it folds to a lower frequency and draws itself there. On a zone plate, whose rings reach half a cycle a sample at the edge, kept one in three they come back as false rings around other centres. The cure is the same: a low-pass first, a windowed sinc cut at 1/(2m) with 8m + 1 taps, done as a row pass and a column pass. The fine rings are then simply gone, which is the right answer, since no small picture can hold them.<br><br>Growing has the opposite problem. Repeating each sample makes blocks. Drawing straight lines between neighbours, bilinear interpolation, is smoother, and still cannot bring back detail the small picture lost; it only draws a plausible path between the samples there are. Both zone-plate numbers below are low for that reason. What differs is whether the shrunk picture draws rings that were never there.`,
    example: {
      title: 'Down by 3 and back up',
      body: `<pre>cutoff 1/(2m):  m = 2 → 0.25     m = 3 → 0.167     m = 4 → 0.125     taps 8m + 1 = 25 at m = 3
zone plate 192 × 192 → 64 × 64, grown back by repeating:   unfiltered 7.8 dB    filtered 10.4 dB
the scene, filtered shrink by 3, grown back:               repeated 17.1 dB    bilinear 18.0 dB
cost of the two passes of 25 taps:  50 multiplications a sample, against 625 for the whole kernel</pre>PSNR is against the original; the zone plate's rings are finer than 64 samples can hold, so both its figures stay low.`,
    },
    mistakes: [
      'Resizing by dropping samples. With no low-pass first, everything above 1/(2m) folds into false patterns, the zone plate\'s false rings.',
      'Filtering after the shrink. Folding has already happened by then, and no later filter can tell a false ring from a real one.',
      'Expecting bilinear to restore detail. It draws straight lines between samples that are there; the PSNR gain over repetition is 0.9 dB on this scene, and no detail returns.',
      'Judging a resize by PSNR alone on a picture with fine rings. Both versions score low there; what matters is that only one of them draws rings that were never in the original.',
    ],
    chapters: [
      { chapter: 'pictures', step: 2, label: 'Smaller and larger' },
      { chapter: 'pictures', step: 0, label: 'A picture is a signal' },
    ],
  },
  dct: {
    idea: `JPEG cuts a picture into 8 × 8 blocks and writes each as a sum of 64 fixed patterns, a cosine across times a cosine down. The amounts are the block's <b>DCT</b>: S(v, u) = ¼ C(u) C(v) Σ Σ s(y, x) cos((2x + 1)uπ/16) cos((2y + 1)vπ/16), with C(0) = 1/√2 and 1 elsewhere. The samples are shifted down by 128 first, so a mid-grey block is all zeros and S(0, 0) is eight times the block's mean. The transform is orthonormal: the energy of the 64 coefficients equals that of the 64 samples, and the inverse gives the block back, to rounding. It loses nothing; what it does is move energy.<br><br>A smooth block has nearly all of it in a handful of low-frequency coefficients, at the top left, and the rest are close to zero; a block with edges spreads wider; a block that looks like one of the patterns, stripes for instance, packs into a few again. The cosine's even-symmetric extension has no jump at the block edge, which is why it is used and not a plain DFT. In gates the transform is two passes of an 8-point stage, and the stage needs no multiplier: add and subtract each sample and its mirror, and what remains is 22 products by constants, each written in signed digits as wiring and adders.`,
    example: {
      title: 'Blocks of the chapter\'s scene',
      body: `<pre>block        coefficients ≥ 10    largest coefficient's share of the energy
sky                    2         99.0 %       S(0,0) = −353.9 = 8 × (−44.2)
stripes                5         81.7 %
checks                28         17.7 %
rings                 46         48.3 %
sun's edge            53         45.2 %
products a block:  direct 64 × 64 = 4,096;  rows then columns 16 × 64 = 1,024;  16 stages × 22 = 352
one 8-point stage in gates: 24,721 NANDs;  sixteen side by side 395,536</pre>The constant 1703 is 5 adders in signed digits, 784 is 2.`,
    },
    mistakes: [
      'Saying the DCT compresses. It rearranges: the 64 coefficients carry exactly the energy of the 64 samples, and nothing is smaller until quantization rounds it away.',
      'Leaving out the shift by 128. Without it S(0, 0) carries the grey level, and a mid-grey block is not zero.',
      'Reading the 8 × 8 transform as 4,096 products. It is separable: two passes of an 8-point transform, 16 in all.',
      'Judging a block by how busy it looks. The stripes block packs into 5 large coefficients, and the sun\'s edge, which looks simpler, needs 53.',
    ],
    chapters: [
      { chapter: 'pictures', step: 3, label: 'Cosines in 8 × 8' },
      { chapter: 'pictures', step: 4, label: 'The DCT in gates' },
    ],
  },
  quanttable: {
    idea: `The DCT loses nothing; <b>quantization</b> is where JPEG throws information away. Each of the 64 coefficients is divided by the entry of a table at its place and rounded to the nearest whole number; the decoder multiplies back. The error in each coefficient is at most half its table entry, and any coefficient smaller than half of it becomes zero. The table is large where the eye forgives (high frequencies) and small where it does not: T.81's Table K.1 runs from 16 at DC to 99 at the highest frequency, given in the standard as an example "used with good results", not a requirement. The file carries the table it used.<br><br>The <em>quality</em> setting is not in T.81 at all; it is libjpeg's, and the chapter holds its tables to those Pillow writes at nine qualities from 1 to 100. Below 50 the table is scaled by 5000 / q percent, above by 200 − 2q, each entry rounded and kept between 1 and 255; at 50 it is K.1 itself. At low quality each block keeps little more than its mean and the next block's mean differs, so the grid shows first in smooth areas such as the sky.`,
    example: {
      title: 'The scale, and what it does to a picture',
      body: `<pre>quality   scale     DC step   last entry    bytes (scene 192 × 192)   PSNR   zero levels
   10     500 %       80        255 (99 × 5 clamped)     1,920                 24.5 dB   94.9 %
   50     100 %       16         99                      3,932                 31.0 dB   88.0 %
   90      20 %        3         20                     10,250                 39.3 dB   65.5 %
raw: 36,864 bytes
a coefficient of 37 at a step of 16: 37 / 16 = 2.3 → 2 → decoder gets 32  (off by 5, at most 8)</pre>The sizes are of the real files, headers included.`,
    },
    mistakes: [
      'Reading quality as a share of the information kept. It is a scale on a table: 5000 / q percent below 50, 200 − 2q above.',
      'Looking for the loss anywhere else. The transform is exact to rounding, and zig-zag and Huffman decode to exactly what went in.',
      'Treating Table K.1 as the standard. T.81 gives it as an example; a file carries its own table and a decoder uses that one.',
      'Trusting PSNR to say where the damage is. At quality 10 the figure is 24.5 dB and what the eye sees is a grid of flat blocks in the sky.',
    ],
    chapters: [
      { chapter: 'pictures', step: 5, label: 'Quantization is the only loss' },
      { chapter: 'pictures', step: 7, label: 'A file another program opens' },
    ],
  },
  zigzag: {
    idea: `After quantization a block is mostly zeros, and the file is arranged so that they cost almost nothing. The 63 coefficients after S(0, 0) are read in <b>zig-zag</b> order, T.81's Figure A.6, along the diagonals from low frequency to high: raster positions 0, 1, 8, 16, 9, 2, 3, 10, 17, 24 and on. The high-frequency zeros, which are the most numerous, then fall at the end in one long run. S(0, 0) is sent as its difference from the last block's, since neighbouring means are close.<br><br>Every other non-zero coefficient becomes a symbol: how many zeros came before it (0 to 15, the high nibble) and its size category, the bits its magnitude needs (the low nibble). A Huffman code is sent for the symbol, then the magnitude itself in that many plain bits; for a negative value the bits are its value minus one in the same width. Sixteen zeros followed by something have a symbol of their own, ZRL (0xF0). One symbol, EOB (0x00), says the rest of the block is zero, and a block whose last coefficient is non-zero has none. A byte of 0xFF in the coded data is followed by a 0, so that it is never taken for a marker.`,
    example: {
      title: 'A block\'s AC part: 5, 0, 0, −2, then zeros to the end',
      body: `<pre>5       → (run 0, size 3)  symbol 0x03   code 3 bits  + 3 extra bits (101)
0, 0    → counted into the next symbol
−2      → (run 2, size 2)  symbol 0x22   code 8 bits  + 2 extra bits (01)
rest    → EOB  0x00                       code 4 bits
total 20 bits for 63 coefficients</pre>The code lengths are those of T.81's Table K.5. For the chapter's scene at quality 50, 32,435 of its 36,864 levels are zero.`,
    },
    mistakes: [
      'Sending zeros one at a time. They are counted into the next non-zero coefficient\'s symbol; only the trailing ones are ended by EOB.',
      'Using ZRL for the trailing zeros. ZRL is for a run of sixteen followed by something that is not zero; the end of the block is EOB.',
      'Sending S(0, 0) as it is. Its difference from the last block\'s is small, and fewer bits of size.',
      'Putting an EOB after a block whose last coefficient, position 63, is non-zero. There is nothing left to say, and none is sent.',
    ],
    chapters: [
      { chapter: 'pictures', step: 6, label: 'Zig-zag, runs and codes' },
    ],
  },
  huffman: {
    idea: `A Huffman code gives frequent symbols short codes and rare ones long, with no code the start of another, so that the bits can be read off without separators. JPEG does not store the codes. A file carries two lists: <b>BITS</b>, how many codes there are of each length from 1 to 16, and <b>HUFFVAL</b>, the symbols in order. T.81's Annex C turns them into codes: each length's codes count up from where the shorter ones ended, doubled, so the decoder rebuilds every code from sixteen counts and the symbols. The shortest codes are the first symbols listed, and the code of all ones is never assigned, so a run of ones is always unambiguous.<br><br>The luminance AC table of Annex K is a "typical" one, and its 162 symbols are the (run, size) pairs, with EOB and ZRL; the DC table has 12 symbols, the size categories. The Huffman symbol is only part of what is sent: the magnitude follows as plain bits, and the codes of the chapter's file at quality 50 take 2,465 bytes, the extra bits 1,094 and the markers and tables 326. A table tuned to one picture is allowed; the standard table is the cheap default.`,
    example: {
      title: 'The luminance AC table, from its lists',
      body: `<pre>BITS: 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125      162 codes in all
HUFFVAL begins:  0x01 0x02 0x03 0x00 0x04 0x11 …
0x01 → 00     0x02 → 01     0x03 → 100     EOB 0x00 → 1010     0x04 → 1011     0x11 → 1100
ZRL 0xF0: 11 bits     125 codes of 16 bits     longest = 16
sum of 2^−length over all codes = 0.99998 = 1 − 2^−16: one code, all ones, left unused</pre>For the symbol 0x03 and the value 5 the bits sent are the code 100 and then the magnitude 101: 6 bits.`,
    },
    mistakes: [
      'Thinking the file stores the code words. It stores BITS and HUFFVAL, and the codes are rebuilt by counting.',
      'Believing Table K.5 is optimal for every picture. It is a typical table; a file may carry one tuned to its symbols.',
      'Forgetting the extra bits. The code names the (run, size) pair; the magnitude comes behind it in plain bits, which at quality 50 are 1,094 bytes against 2,465 for the codes.',
      'Forgetting byte stuffing. A 0xFF in the coded data is followed by a 0, which at quality 50 costs 368 bits of the file.',
    ],
    chapters: [
      { chapter: 'pictures', step: 6, label: 'Zig-zag, runs and codes' },
      { chapter: 'pictures', step: 7, label: 'A file another program opens' },
    ],
  },
  jpeg: {
    idea: `A baseline JPEG is five steps on blocks of 8 × 8 samples: shift by 128, the DCT, quantization by a table, zig-zag with run lengths, Huffman codes. Only the third loses information; the others are exact to rounding, and the transform's own rounding and the final rounding to 8 bits are far smaller than what quantization takes. The decoder runs the steps backwards, and the file in between is a list of marker segments, each a marker and a length: start of image, a JFIF header, the quantization table in zig-zag order, the frame (8-bit samples, the size, one component), the two Huffman tables, the start of scan, the coded data and end of image.<br><br>Because it is only a format, any program can write and read it. The chapter writes every byte of a file; libjpeg through Pillow reads it, and so does the browser, and every pixel is within one level of our own reconstruction. They differ by a level or so on a few pixels since T.81 sets how exact an inverse DCT must be, not how to compute it, and fast decoders use integer ones. The one parameter most people see, quality, is not in the standard but libjpeg's scaling of its example table.`,
    example: {
      title: 'The same grey picture at three qualities',
      body: `<pre>raw: 192 × 192 samples = 36,864 bytes
quality 10:   1,920 bytes   19.2 to 1   24.5 dB
quality 50:   3,932 bytes    9.4 to 1   31.0 dB      Huffman codes 2,465 + extra bits 1,094 + markers and tables 326
quality 90:  10,250 bytes    3.6 to 1   39.3 dB</pre>These are real file sizes with headers. At quality 50 the markers and tables are about 8 % of the file.`,
    },
    mistakes: [
      'Thinking every step of the pipeline loses something. The DCT, zig-zag and Huffman coding are exact; only the division and rounding by the table loses.',
      'Treating quality as part of the format. The standard defines tables; the 5000 / q and 200 − 2q scaling belongs to libjpeg, and a file carries the table it ended up with.',
      'Expecting two decoders to agree to the last bit. T.81 does not fix how exact the inverse DCT is; a level of difference on a few pixels is no fault.',
      'Reading PSNR as appearance. At quality 10 the figure is 24.5 dB and the picture shows a grid of eight-sample blocks, first in the smooth sky.',
    ],
    chapters: [
      { chapter: 'pictures', step: 5, label: 'Quantization is the only loss' },
      { chapter: 'pictures', step: 6, label: 'Zig-zag, runs and codes' },
      { chapter: 'pictures', step: 7, label: 'A file another program opens' },
    ],
  },
};
