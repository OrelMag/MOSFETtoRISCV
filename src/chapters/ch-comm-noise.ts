// Noise and detection: how faint a signal can be. Thermal noise, a decision against it, the matched filter, Eb/N0 as the axis every link is
// judged on, capacity against band, and Shannon's limit derived and then met by the random codes of his proof. A labelled model: closed forms
// held to seeded counts in tests/comm-noise.test.ts; the telegraph chapter states the limit, the codes chapter approaches it.

import { ebn0For, shannonBinaryDb, uncodedBer } from '../comm/ber';
import { dbToRatio, EBN0_MIN, ratioToDb } from '../comm/limits';
import { capacityAt, capacityCeiling, cascadeNfDb, decisionError, everyText, johnsonVolts, noiseDensityDbm, noiseFloorDbm, oneInText, PULSES, Q_ROWS, RECEIVERS, snrAfter, T0, withinSigmas } from '../comm/noise';
import { berCurveWidget, capacityWidget, chainWidget, decisionWidget, gaussianWidget, matchedWidget, randomCodeWidget, thermalWidget } from '../widgets/noise';
import { numOf } from './order';
import type { Chapter } from './types';

const nf = (x: number, d = 2) => x.toFixed(d);
const db = (x: number, d = 1) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)} dB`;
const dbm = (x: number, d = 1) => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)} dBm`;
const sup = (e: string) => [...e].map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(c)]).join('');
const sci = (x: number) => x.toExponential(0).replace(/e-(\d+)/, (_, e: string) => ` × 10⁻${sup(e)}`);
/** Two decimals of mantissa: 1.59 × 10⁻¹. */
const sci3 = (x: number) => x.toExponential(2).replace(/e-(\d+)/, (_, e: string) => ` × 10⁻${sup(e)}`);
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)} %`;
const NV = (v: number) => (v * 1e9).toFixed(1);
const FLOOR = noiseDensityDbm();
const WALL = ratioToDb(EBN0_MIN);
const FOR_1E5 = ebn0For(uncodedBer, 1e-5), FOR_1E9 = ebn0For(uncodedBer, 1e-9);
const RECT = PULSES[0].shape, SINE = PULSES[1].shape;
const GAIN = (p: readonly number[], r: number) => 10 * Math.log10(snrAfter(p, RECEIVERS[r].weights(p), 1));
const LNA = { name: 'amplifier', gainDb: 20, nfDb: 1 }, CABLE = { name: 'cable', gainDb: -10, nfDb: 10 };

export const chNoise: Chapter = {
  id: 'noise', num: numOf('noise'), title: 'Noise and detection', level: 'Communication',
  blurb: 'How faint a signal can be: thermal noise, a decision against it, the matched filter, Eb/N0, what more band buys, and Shannon\'s limit derived and then met by real random codes.',
  goals: [
    'compute a receiver\'s noise floor from temperature, band and noise figure',
    'turn a signal-to-noise ratio into an error rate through the Gaussian tail, and say why a few dB change it by orders of magnitude',
    'derive the matched filter, and say what it gains over looking at one sample',
    'compare any two links on the Eb/N0 axis, and place them against the limit',
    'derive Shannon\'s capacity from counting noise spheres, and say why the code in his proof cannot be built',
  ],
  builds: ['message', 'signals', 'telegraph'],
  recap: {
    keep: [
      `Thermal noise has a density kT, ${dbm(FLOOR)}/Hz at ${T0} K, flat far past any radio band: the floor in a bandwidth is ${nf(FLOOR, 0).replace('-', '−')} dBm + 10 log₁₀ B + the receiver's noise figure. Double the band, double the noise.`,
      `A level d from a threshold, in Gaussian noise of σ, is read wrong with probability Q(d / σ). Going from ${sci(1e-3)} to ${sci(1e-9)} takes about ${db(20 * Math.log10(6 / 3.09), 0)}: the tail falls fast.`,
      'The best weights for a known pulse in white noise are the pulse itself: the SNR after them is E / σ², the energy over the noise, whatever the shape. Averaging is that filter for a rectangle.',
      `Eb/N0 is energy per bit over noise density: SNR = (Eb/N0) (R / B). Uncoded ±1 signalling gives Q(√(2 Eb/N0)), ${db(FOR_1E5)} at 10⁻⁵ and ${db(FOR_1E9)} at 10⁻⁹.`,
      `C = B log₂(1 + P / (N0 B)). More band at fixed power flattens out at P / (N0 ln 2), so no code runs below ${db(WALL, 2)}. Short of power, spend band; short of band, each extra bit a second per hertz costs 3 dB.`,
      'Shannon\'s proof picks a code at random. It works, with no structure at all, and needs 2^(nR) comparisons to decode: real codes exist to make decoding possible.',
      'In a chain each stage\'s excess noise counts divided by the gain before it (Friis), so the first amplifier sets the figure, and loss before it adds in full.',
    ],
    check: [
      {
        question: 'A receiver has a 20 MHz channel and a noise figure of 6 dB. What is its noise floor?',
        options: [`About ${dbm(noiseFloorDbm(20e6, 6), 0)}: −174 + 73 + 6`, 'About −174 dBm: the density is the floor', 'About −168 dBm: −174 + 6', 'About −101 dBm: it leaves out the noise figure'],
        answer: 0,
        explain: '10 log₁₀(20 × 10⁶) is 73 dB. The density is per hertz, so the band adds; the receiver\'s own noise adds on top.',
        why: ['', 'That is per hertz. The channel collects noise over all 20 MHz.', 'That leaves out the band, which is the larger term.', 'That is the thermal floor alone. The noise figure says how much the receiver adds to it.'],
      },
      {
        question: 'A rectangular pulse of 16 samples is read by looking at one sample, then by averaging all of them. What does averaging gain?',
        options: [`${db(GAIN(RECT, 2) - GAIN(RECT, 0))}: the signal adds 16 times over, the noise only 4`, '0 dB: the pulse has the same height', '24 dB: 16 times over in amplitude', '3 dB: it can never gain more'],
        answer: 0,
        explain: 'The samples of the pulse add in step, and the independent noise adds in power: the SNR rises by the number of samples, 10 log₁₀ 16.',
        why: ['', 'The height of the pulse is unchanged, but the noise on the average is much smaller.', 'That treats the noise as adding in step too. It adds as √16.', 'There is no such limit: the gain grows with the energy collected.'],
      },
      {
        question: 'Why can nobody simply use the random code from Shannon\'s proof?',
        options: ['Decoding by comparing with every codeword takes 2^(nR) comparisons, and n must be large', 'It does not actually reach the limit', 'Random codes have no check bits', 'It only works at low noise'],
        answer: 0,
        explain: 'A random code has no structure for a decoder to exploit. At n = 1000 and rate ½ that is 2⁵⁰⁰ words. The whole of modern coding is structure that keeps the performance and loses the search.',
        why: ['', 'As n grows it does reach it. That is the proof.', 'Every bit of a codeword is redundant in a sense, and none is separately a check bit. That is no obstacle.', 'It works at any noise below the limit.'],
      },
    ],
  },
  steps: [
    {
      title: 'The floor',
      body: `
        <p>The last chapter's channels were noiseless: a signal went in, a scaled and delayed one came out. A real receiver also hears a floor that no design removes, and how far a link reaches, and how many bits a hertz carries, are both fought out against it.</p>
        <p>Electrons in a resistor move with heat, and their motion is a voltage. John Johnson measured it in 1926 and Harry Nyquist derived it in 1928: an open resistor has an RMS (root-mean-square, the usual size of a fluctuating voltage) noise voltage of √(4 k T R B), ${NV(johnsonVolts(1000, 1))} nV in 1 kΩ over 1 Hz at room temperature. No design removes it, because it comes with being warm and being connected.</p>
        <p>The power it can deliver does not depend on the resistor: <strong>kT per hertz</strong>, which at the reference temperature of ${T0} K is ${dbm(FLOOR)}/Hz (dBm: decibels above one milliwatt, <a href="#/c/message/5">Sending a message</a>). That is the most-used number in radio engineering. A band of B collects kTB, so the floor in dBm is ${nf(FLOOR, 0).replace('-', '−')} + 10 log₁₀ B. The density is flat far past any radio band, and noise that is flat is called <strong>white</strong>.</p>
        <p>A receiver adds its own on top, stated as its <strong>noise figure</strong>: how many dB it degrades the SNR. So a Wi-Fi receiver with 20 MHz and 6 dB of figure has a floor of ${dbm(noiseFloorDbm(20e6, 6))}, and a signal must clear that by whatever its modulation needs. A noise figure is quoted against a ${T0} K source, so that receiver adds about ${Math.round((dbToRatio(6) - 1) * T0)} K of its own, whatever it listens to. Cooling only the source then gains little. Stations that listen to deep-space probes look at a cold sky through cooled amplifiers: with everything near 4 K the floor would be up to ${db(10 * Math.log10(T0 / 4), 0)} lower.</p>
        <div class="try">Widen the band by ten and read the floor. Set the noise figure to 0 and compare halving the band with cooling the source from 290 K to 145 K: each is 3 dB. Then set the figure to 6 dB and try cooling again.</div>`,
      widget: thermalWidget,
      challenge: {
        kind: 'quiz', question: 'A channel is narrowed from 100 MHz to 1 MHz. What happens to the thermal noise in it?',
        options: ['It falls by 20 dB, a hundred times: noise power is proportional to band', 'Nothing: the density is unchanged', 'It falls by 10 dB', 'It rises: narrow filters ring'],
        answer: 0,
        explain: 'The density is unchanged and the band is a hundredth: 10 log₁₀ 100 = 20 dB.',
        why: ['', 'The density is per hertz, and the channel now holds fewer of them.', 'A factor of 100 in power is 20 dB.', 'Ringing changes a pulse\'s shape, and does not add thermal noise.'],
      },
    },
    {
      title: 'A chain: who pays',
      get body() {
        const good = cascadeNfDb([LNA, CABLE]), bad = cascadeNfDb([CABLE, LNA]);
        return `
        <p>A receiver is a chain of stages, each with a gain and each adding noise. Friis's formula (1944) says how they combine: F = F₁ + (F₂ − 1) / G₁ + (F₃ − 1) / (G₁ G₂) + …, in ratios. Each stage's excess noise counts divided by the gain before it, so a good first amplifier makes everything after it matter less.</p>
        <p>A passive loss has a noise figure equal to its loss. So take an amplifier of 20 dB gain and 1 dB figure, and a 10 dB cable. Amplifier first: ${db(good, 2)}. Cable first: ${db(bad, 2)}. The same two parts differ by ${db(bad - good, 1)}, which for the same signal-to-noise ratio at the end of the chain is ${(10 ** ((bad - good) / 10)).toFixed(0)} times the transmit power, or ${(10 ** ((bad - good) / 20)).toFixed(0)} times the distance in free space. That is why a satellite dish mounts its amplifier at the focus, and why receivers put their low-noise amplifier right after the antenna.</p>
        <div class="try">Flip the order. Then put a poor amplifier first and see the penalty, and raise its gain to see where more gain stops helping.</div>`;
      },
      widget: chainWidget,
      challenge: {
        kind: 'quiz', question: 'A cable of 3 dB loss sits between the antenna and a 2 dB amplifier. Moving the amplifier to the antenna gains about how much?',
        options: ['About 3 dB: the loss before the first amplifier adds in full', 'Nothing: the same parts are in the chain', 'About 1 dB: it is shared with the amplifier', 'About 0.3 dB: a tenth of the loss'],
        answer: 0,
        explain: 'Before: 3 + 2 = 5 dB. After, with enough gain: about 2 dB, because the cable is now divided by the amplifier\'s gain.',
        why: ['', 'Order is the whole point: noise is added at different signal levels.', 'Loss before any gain cannot be shared: it reduces the signal against the noise at full weight.', 'A tenth would apply to a stage after a 10 dB gain. This loss sits before any gain, so it adds in full.'],
      },
    },
    {
      title: 'The bell curve and its tail',
      get body() {
        const rows = Q_ROWS.map((r) => `<tr><td class="num">${r.k}</td><td class="num">${sci3(r.q)}</td><td class="num">${oneInText(r.oneIn)}</td><td class="num">${everyText(r.every)}</td></tr>`).join('');
        const q3 = Q_ROWS[2].q, q6 = Q_ROWS[5].q;
        return `
        <p>The first step's resistor gave a voltage that wanders: you cannot say what the next sample will be, but you can say how often each value turns up. Take 20 000 samples of it and sort them into bins by voltage, a bar for each bin whose height is how many fell in. That is a <strong>histogram</strong>. With a hundred samples it is ragged. With twenty thousand it settles into a smooth hill, tall in the middle and falling fast on both sides: the <strong>Gaussian</strong> or <strong>normal</strong> curve, proportional to e<sup>−x²/2σ²</sup>.</p>
        <p>The shape is no accident. Thermal noise is the sum of an enormous number of tiny independent pushes, and the <em>central limit theorem</em> says that a sum of many independent small things comes out in this shape, whatever each one looks like. That is why nearly every noise in this book is taken as Gaussian: not because it is simple, but because it is what the arithmetic gives.</p>
        <p><strong>σ</strong> (sigma) is the curve's width, and it is the same RMS that the first step defined: square every sample, average, take the root. Noise averages to zero, so the RMS is the typical distance from the middle. How much of the hill lies within a distance of the middle is fixed by σ alone: ${pct(withinSigmas(1))} within ±1 σ, ${pct(withinSigmas(2))} within ±2 σ, ${pct(withinSigmas(3), 2)} within ±3 σ. Double σ and the hill is twice as wide and half as tall, with the same shape.</p>
        <p>Now the question a receiver asks. A level sits a distance <em>d</em> from its threshold, and the noise carries a sample across when it is more than <em>d</em> in the wrong direction. The chance of that is the area of the hill beyond <em>d</em>: its <strong>tail</strong>, written <strong>Q(d / σ)</strong>. It depends only on how many σ the margin is. Reading it for 1 to 7 σ, with the time between errors for a link that makes a decision every nanosecond (1 Gb/s):</p>
        <table class="tbl">
          <thead><tr><th class="num">d / σ</th><th class="num">Q(d / σ)</th><th class="num">one in</th><th class="num">at 1 Gb/s, an error every</th></tr></thead><tbody>
          ${rows}</tbody>
        </table>
        <p>Each extra σ of margin cuts the chance by a larger factor: from 3 σ to 6 σ it falls by a factor of about ${sci(q3 / q6)}. There is no distance at which it reaches zero: no voltage is impossible, only rare. Two consequences recur. A link gives no warning: it looks perfect for a long time and then fails within a few dB of margin. And counting errors cannot measure a tail this thin, so the formula has to: at 7 σ you would wait ${everyText(Q_ROWS[6].every)} at a gigabit a second for one error.</p>
        <p>The rule of thumb in chapter ${numOf('clocks')} now reads plainly. A hysteresis about 6 σ wide is ±3 σ either side of the middle, which leaves ${pct(2 * q3, 2)} of the samples outside at any one moment, small enough that a keeper that wide is crossed by noise only now and then.</p>
        <div class="try">Start at 100 samples and add more: watch the bars settle onto the curve. Then set d to 3 σ and compare the counted share beyond it with Q(3). Double σ with d fixed and see how far the tail grows. Which of the two, d or σ, matters?</div>`;
      },
      widget: gaussianWidget,
      more: {
        derive: `<p><strong>Where Q comes from.</strong> The unit-width hill is e<sup>−x²/2</sup> / √(2π), and Q(x) is its area beyond x. That area has no closed form in simple functions, so it is named: Q(x) = ½ erfc(x / √2), where erfc is the <em>complementary error function</em>, tabulated for centuries and computed here by a rational approximation good to one part in ten million. For large x, Q(x) ≈ e<sup>−x²/2</sup> / (x √(2π)): the e<sup>−x²/2</sup> is why each step outwards cuts so much more than the last.</p>`,
        pitfall: `<p><strong>One tail, or two.</strong> A decision looks at one side only: noise carrying a "1" down across the threshold. Q is therefore the right figure, not 2Q. The 2Q(3) used for a keeper counts both sides.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Noise has σ = 0.2 V. A signal level sits 0.6 V from the threshold. About how often is a sample read wrong?',
        options: [`About ${sci(decisionError(0.6, 0.2))}, one in ${oneInText(1 / decisionError(0.6, 0.2))}: 0.6 V is 3 σ, and Q(3) is that`, 'About one in three: 0.2 / 0.6', `About ${sci(2 * decisionError(0.6, 0.2))}, one in ${oneInText(0.5 / decisionError(0.6, 0.2))}`, 'Never: 0.6 V is more than any noise sample reaches'],
        answer: 0,
        explain: `0.6 V over 0.2 V is 3 σ. Q(3) is ${sci3(decisionError(0.6, 0.2))}: about one sample in ${oneInText(1 / decisionError(0.6, 0.2))}.`,
        why: ['', 'That divides the wrong way round and treats the chance as proportional to the ratio. The tail falls far faster than that.', 'That is 2 Q(3), the chance of passing 3 σ on either side. A decision reads one side, so it is Q(3).', 'A Gaussian tail has no end. A sample beyond 3 σ is rare but it happens, and across a billion bits it happens a great deal.'],
      },
    },
    {
      title: 'A decision',
      body: `
        <p>A receiver reading two levels ±d with a threshold half way gets a bit wrong when the noise exceeds d. The chance is the tail of the last step, <strong>Q(d / σ)</strong>.</p>
        <p>That tail is steep. At d / σ = 3 it is ${sci(decisionError(3, 1))}; at 6 it is ${sci(decisionError(6, 1))}. Doubling the ratio is 6 dB of SNR and moves the error rate by six orders of magnitude. This is why a link seems to work perfectly and then fails within a few dB, and why engineers talk about margin.</p>
        <p><a href="#/c/wire/0">A wire is not a wire</a> met this tail on a line. Here it is the general form, and the rest of the chapter asks how to get the largest d / σ out of a given signal.</p>
        <div class="try">Slide the noise until the two humps touch at the threshold, and compare the formula with the counted errors. Then find the noise where one bit in a thousand is wrong, and halve it.</div>`,
      widget: decisionWidget,
      challenge: {
        kind: 'quiz', question: 'A link has one bit wrong in a thousand. Its SNR is improved by 6 dB. Roughly what happens?',
        options: [`The errors fall to about ${sci(decisionError(2 * 3.09, 1))}: d / σ doubles, and the tail falls that fast`, 'They halve', 'They fall by four: 6 dB is a factor of four', 'Nothing much: 6 dB is small'],
        answer: 0,
        explain: 'One in a thousand is d / σ = 3.09. 6 dB doubles it to 6.18, and Q(6.18) is about three in 10¹⁰.',
        why: ['', 'The error rate is not proportional to the noise: it is a Gaussian tail.', 'A factor of four in power is right, and it applies to the SNR. The error rate moves far more.', 'On this curve 6 dB is enormous.'],
      },
    },
    {
      title: 'The matched filter',
      get body() {
        return `
        <p>A symbol lasts many samples, and looking at just one wastes the rest. The receiver can take a weighted sum Σ w<sub>k</sub> r<sub>k</sub>, where r is the pulse p plus noise of σ on each sample, and compare it with zero. What weights make the decision best?</p>
        <p>The signal part of the sum is Σ w p, and the noise part has variance σ² Σ w². So the SNR is (Σ w p)² / (σ² Σ w²). By the Cauchy–Schwarz inequality that is largest when w is proportional to p, and there it equals <strong>E / σ²</strong>, the pulse's energy over the noise per sample. This is the <strong>matched filter</strong> (D. O. North, 1943): weigh each sample by how much signal you expect in it.</p>
        <p>Two things follow. The best SNR depends only on the pulse's energy, not its shape, so a shape can be chosen for its band and lose nothing to noise. And for a rectangle the weights are all equal, so the best receiver just averages: over ${RECT.length} samples that gains ${db(GAIN(RECT, 2) - GAIN(RECT, 0))} on one sample. For half a sine, plain averaging is ${db(GAIN(SINE, 2) - GAIN(SINE, 1), 2)} short of matched, which shows how forgiving the optimum is.</p>
        <div class="try">Keep the half sine and step through the receivers. Then pick the rectangle: averaging and matched should now agree exactly. Raise the noise until the single sample is useless and see how the matched receiver does.</div>`;
      },
      widget: matchedWidget,
      more: {
        derive: `<p>Write s = Σ w p and n² = σ² Σ w². Cauchy–Schwarz says (Σ w p)² ≤ (Σ w²)(Σ p²), with equality exactly when w is a multiple of p. So SNR = s² / n² ≤ Σ p² / σ² = E / σ². In continuous time the same weights become a filter whose impulse response is the pulse reversed in time, hence the name.</p>`,
        real: `<p>Practical links split the matched filter between the two ends: the root-raised-cosine pulse is a filter at the transmitter and the same at the receiver. Their product leaves no interference between symbols at the sampling instants, and the receiver's half is matched to what was sent.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'What sets the best SNR a receiver can get from a known pulse in white noise?',
        options: ['The pulse\'s energy over the noise density, and nothing about its shape', 'The pulse\'s peak height', 'Its bandwidth', 'How many samples are taken, however fine'],
        answer: 0,
        explain: 'The matched filter gives E / σ². A shape with the same energy gives the same SNR, so band and noise can be designed separately.',
        why: ['', 'A taller, shorter pulse of equal energy does exactly as well.', 'The band it occupies does not enter the result.', 'Finer sampling of the same signal in the same noise density adds no energy.'],
      },
    },
    {
      title: 'One axis for every link',
      body: `
        <p>To compare a 300 b/s modem with a 400 Gb/s fibre, take out the rate. <strong>E<sub>b</sub></strong> is the energy per bit, signal power divided by bit rate. <strong>N<sub>0</sub></strong> is the noise density. Their ratio is dimensionless, and SNR = (E<sub>b</sub> / N<sub>0</sub>) (R / B): what a bit gets, scaled by how many bits share each hertz.</p>
        <p>With ±√E<sub>b</sub> and a matched filter, the noise on the decision has variance N<sub>0</sub> / 2, so the error rate is <strong>Q(√(2 E<sub>b</sub> / N<sub>0</sub>))</strong>. That needs ${db(FOR_1E5)} for one bit in 10⁵ and ${db(FOR_1E9)} for one in 10⁹. These figures are the reference for every link: the gain of a code is how far left of this curve it runs.</p>
        <p>The dashed line at ${db(WALL, 2)} is the limit for any code at all, derived in the next step. Between it and the curve lie ${db(FOR_1E5 - WALL)} at 10⁻⁵. That gap, a factor of ${(10 ** ((FOR_1E5 - WALL) / 10)).toFixed(0)} in power, is what <a href="#/c/codes/0">the stronger codes</a> are for. <a href="#/c/modem/5">Modems</a> use the same Gaussian tail for symbols of many points.</p>
        <div class="try">Find the Eb/N0 for one wrong bit a second at 1 Gb/s. Then read how far above the limit that is.</div>`,
      widget: berCurveWidget,
      challenge: {
        kind: 'quiz', question: `Two uncoded links run at ${db(FOR_1E5, 0)} Eb/N0, one at 1 kb/s and one at 1 Gb/s, with matched filters. What share of their bits is wrong?`,
        options: ['The same share: it depends on Eb/N0 alone. The fast link needs a million times the power', 'A million times the share on the fast one', 'The slow one has more errors, being narrower', 'They cannot be compared'],
        answer: 0,
        explain: 'That is the point of the axis. Power = Eb × R, so at the same Eb/N0 the 1 Gb/s link spends 60 dB more power.',
        why: ['', 'It makes a million times as many errors each second, and sends a million times as many bits. The share is equal.', 'A narrower band collects less noise, and each bit also gets its energy in less band. It cancels.', 'Taking the rate out is exactly what makes them comparable.'],
      },
    },
    {
      title: 'Power or band',
      get body() {
        return `
        <p>Chapter ${numOf('telegraph')} stated C = B log₂(1 + SNR). Keep the power P and the noise density N<sub>0</sub> fixed, so SNR = P / (N<sub>0</sub> B), and ask what more band buys. At first it buys a lot. Then the noise it lets in catches up: as B grows, C tends to <strong>P / (N<sub>0</sub> ln 2)</strong> and stops there.</p>
        <p>That ceiling gives the limit in the last step's plot. Bits a second can never exceed P / (N<sub>0</sub> ln 2), so the energy per bit P / C over N<sub>0</sub> can never go below ln 2, which is <strong>${db(WALL, 2)}</strong>. Below that no code works, however long and however wide its band.</p>
        <p>The two regimes engineer very differently. A deep-space probe has plenty of band and almost no power: its link runs far below 1 bit per hertz, near the ceiling, and uses very low rate codes. A telephone line or a crowded radio band is the reverse: little band, and each extra bit per hertz costs about 3 dB of power at high SNR, so large constellations appear. With B = P / N<sub>0</sub>, SNR 0 dB, capacity is already ${nf(capacityAt(1, 1) / capacityCeiling(1) * 100, 0)} % of the ceiling.</p>
        <div class="try">Read off the three capacities and find where a hundredfold increase in band buys little. Change P / N0 and note that the shape does not move.</div>`;
      },
      widget: capacityWidget,
      challenge: {
        kind: 'quiz', question: 'A link at 30 dB SNR needs one more bit per hertz. What does that cost?',
        options: ['About 3 dB more power: log₂(1 + SNR) gains 1 when SNR doubles', 'Twice the band', '30 dB more', 'It cannot be done at this SNR'],
        answer: 0,
        explain: 'At high SNR, log₂(1 + 2 SNR) ≈ log₂(SNR) + 1. Each bit per hertz doubles the power.',
        why: ['', 'Band is the other way of raising the rate, and it does not raise bits per hertz.', 'That would double the logarithm: 30 dB is ten bits per hertz.', 'Capacity has no such step: it rises smoothly with SNR.'],
      },
    },
    {
      title: 'Shannon\'s argument, and his code',
      body: `
        <p>Send a block of n values, each of power P, through noise of power N. The received vector lies, with near certainty as n grows, inside a ball of radius √(n(P + N)). Around each transmitted vector, the noise leaves it within a small ball of radius √(nN). If those small balls do not overlap, the receiver can always tell which was sent. So the most codewords that can fit is the ratio of the volumes: (√(n(P + N)) / √(nN))<sup>n</sup> = (1 + P / N)<sup>n/2</sup>.</p>
        <p>That is ½ log₂(1 + P / N) bits per value. At 2B values a second it is exactly <strong>C = B log₂(1 + SNR)</strong>. The bound comes from nothing but counting and geometry. The other half of the theorem is stranger: pick the codewords <em>at random</em>, with no design at all, and as n grows the error rate falls to zero at any rate below that.</p>
        <p>The plot runs that code. Every point draws fresh random codewords at rate ½ and decodes by comparing with all of them, the best any receiver can do. Below the limit of ${db(shannonBinaryDb(0.5), 2)} for ±1 signals at this rate, a longer code does worse. Well above it, a longer code does better. The curves pivot within about a dB of the limit, and steepen as n grows, which is the theorem appearing. Twenty bits is still far from the limit's sharp edge: the curve only becomes a cliff with very large n.</p>
        <p>Nobody can use this. Decoding 20 bits tries 2¹⁰ words; a block of 1000 would try 2⁵⁰⁰. Real codes exist for one reason, to keep this performance while making decoding possible: <a href="#/c/codes/0">a code with memory</a> (chapter ${numOf('codes')}) is the first of them. The next chapter first puts this one's numbers on a telephone line.</p>
        <div class="try">Run it. Compare the three lengths at 6 dB, then at −3 dB, and find where they cross.</div>`,
      widget: randomCodeWidget,
      challenge: {
        kind: 'quiz', question: 'In the volume argument, why does the number of codewords grow exponentially with n?',
        options: ['Each extra value multiplies the volume ratio by the same factor, √(1 + P / N)', 'Longer codes have more check bits', 'Longer blocks have less noise', 'Because a longer code is decoded more slowly'],
        answer: 0,
        explain: 'Volumes in n dimensions go as radius to the n. So each dimension contributes a fixed number of bits, ½ log₂(1 + P / N), which is the capacity.',
        why: ['', 'The argument has no check bits: it only counts what fits.', 'Noise per value is unchanged. What changes is that its total becomes predictable.', 'The decoding cost does grow fast, and it plays no part in the bound.'],
      },
    },
  ],
};
