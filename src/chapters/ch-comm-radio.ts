// Radio (level Communication): how a bit crosses empty air. All models (phys/radio.ts), tested against closed forms and simulation; the chapter says so. What is digital about a radio is the
// next chapters' business; here the channel: antennas, path loss, a budget in dB, the mixer, software radio, multipath, fading, diversity.

import { dbToRatio } from '../comm/limits';
import { apertureM2, bpskAwgn, bpskMrc, bpskRayleigh, coherenceMHz, coherenceTime, dopplerHz, fadeMarginDb, fsplDb, levelCrossing, linkBudget, noiseFloorDbm, wavelengthM } from '../phys/radio';
import { antennaWidget, budgetWidget, BUDGET_DEFAULT, diversityWidget, fadingWidget, mixerWidget, multipathWidget, pathWidget, sdrWidget, WALL_DB } from '../widgets/radio';
import { numOf } from './order';
import type { Chapter } from './types';

const nf = (x: number, d = 1) => x.toFixed(d);
const sci = (x: number) => x.toExponential(0).replace('e-', ' × 10⁻').replace('e+', ' × 10');

const D = BUDGET_DEFAULT;
const B0 = linkBudget({ txDbm: D.tx, gtDbi: D.ga, grDbi: D.ga, km: D.m / 1000, ghz: D.ghz, extraDb: D.walls * WALL_DB(D.ghz), mhz: D.mhz, nfDb: D.nf });
const B5 = linkBudget({ txDbm: D.tx, gtDbi: D.ga, grDbi: D.ga, km: D.m / 1000, ghz: 5.5, extraDb: D.walls * WALL_DB(5.5), mhz: 80, nfDb: D.nf });
const FD = dopplerHz(100, 2);
function solveDb(f: (x: number) => number, target: number): number {
  let lo = -5, hi = 60;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(dbToRatio(m)) > target) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
function needFor(L: number): number { return solveDb((x) => bpskMrc(x, L), 1e-3); }
function needAwgn(t: number): number { return solveDb(bpskAwgn, t); }
function needRay(t: number): number { return solveDb(bpskRayleigh, t); }

export const chRadio: Chapter = {
  id: 'radio', num: numOf('radio'), title: 'Radio', level: 'Communication',
  blurb: 'How a bit crosses empty air: antennas, path loss and the link budget, mixers and software radio, multipath and fading, and what more antennas buy. Models, labelled as models.',
  goals: [
    'say what an antenna\'s gain and effective aperture are, and why a fixed dish gets better with frequency while the path formula says it gets worse',
    'add up a link budget in dB, from transmit power through path and walls to SNR and a Shannon limit',
    'explain what a mixer does, why it has an image, and how a software radio turns all of that into arithmetic',
    'relate delay spread to coherence bandwidth and speed to coherence time, and pick what each one breaks',
    'read a fading BER curve, and say how much diversity buys and why',
  ],
  builds: ['modem', 'serial'],
  recap: {
    keep: [
      'The path formula 20 log d + 20 log f + 92.45 dB is really about the receiving antenna: the same gain at a shorter wavelength has a smaller aperture. Fix the aperture instead and higher frequencies win.',
      `A budget is additions in dB: transmit power, antenna gains, path, walls, against a noise floor of −174 dBm/Hz + 10 log B + NF. Shannon then turns the SNR into a limit, and widening the channel at fixed power soon stops helping.`,
      'A mixer multiplies, and gives you the sum and the difference, so that a whole band can be moved down to where ADCs live. The price is an image, which I/Q (a complex mix) removes in arithmetic. A software radio is an ADC and arithmetic.',
      `Multipath makes the channel a filter: frequencies closer than about 1 / (5 τ) fade together. Speed makes it change, over a time of order 0.42 / f_d. Wide channels see notches, fast ones see change, and every design from here on is about these two numbers.`,
      `In Rayleigh fading BER falls as 1 / SNR, not exponentially. At a BER of 10⁻³ that costs ${nf(needRay(1e-3) - needAwgn(1e-3), 0)} dB against no fading. Two antennas fading independently make it 1 / SNR², which is why diversity is worth more than power.`,
    ],
    check: [
      {
        question: 'A link in free space works out to 60 m. Somewhere you lose 6 dB more. How far does it work now?',
        options: ['30 m: each doubling of distance costs 6 dB', '15 m', '60 m: 6 dB is small', '20 m'],
        answer: 0,
        explain: '20 log d: a factor of 2 in distance is 6 dB. A 6 dB shortfall halves the range, in free space. Through walls and with an exponent of 3 to 4, 6 dB buys less distance than that.',
        why: ['', 'That is the factor for 12 dB.', 'Six dB is a factor of four in power.', 'There is no such rule: the exponent is 2 in free space.'],
      },
      {
        question: 'Why doesn\'t 5 GHz "reach" as far as 2.4 GHz with the same antennas, and why doesn\'t the air explain it?',
        options: ['A same-gain antenna at the higher frequency is smaller and collects less; and walls do absorb more', 'Air absorbs most of it', 'Radio waves slow down at higher frequencies', 'A higher frequency has more noise in it'],
        answer: 0,
        explain: 'Free space does not dissipate anything. λ² / 4π is the area an isotropic antenna collects, and it falls with frequency. Absorption in air only matters in narrow bands, like the oxygen line at 60 GHz.',
        why: ['', 'Air absorption is negligible below tens of GHz.', 'In free space all frequencies travel at c.', 'Thermal noise per Hz is the same at both.'],
      },
      {
        question: 'A channel has a 300 ns delay spread. A 20 MHz single-carrier symbol is 50 ns. What does that mean?',
        options: ['Each symbol\'s echo overlaps several later ones: it needs equalizing, or many slow carriers', 'Nothing: a delay does not change the bits', 'The channel is too slow to use', 'The Doppler shift will correct it'],
        answer: 0,
        explain: 'Coherence bandwidth is about 0.7 MHz, far below 20 MHz, so the channel is frequency-selective. A long symbol, by many narrow carriers, makes the same echo a small fraction of it. That is OFDM.',
        why: ['', 'Six symbols of overlap is severe inter-symbol interference.', 'It can be used, by equalizing or by OFDM.', 'Doppler is a matter of speed, not of delay spread.'],
      },
    ],
    practise: [],
  },
  steps: [
    {
      title: 'An antenna',
      body: `
        <p>Everything so far ran down a wire or a fibre. A radio has only two antennas and the space between them. This chapter is models, tested against closed forms; the radio chapters say so, and they say when a trace is modelled rather than captured. The gates come back in the next chapter, for the part of Wi-Fi that is logic.</p>
        <p>An antenna turns current into a travelling field and, by reciprocity, back. A wire half a wavelength long is resonant: a <strong>half-wave dipole</strong>, ${nf(wavelengthM(2.4) * 50, 1)} cm at 2.4 GHz. It radiates most broadside, nothing along its own axis. Integrating the pattern over the sphere gives its <strong>gain</strong> over an imaginary isotropic antenna: 1.64, or 2.15 dBi. An antenna does not create power, it aims it. So the gain is the concentration and "more dBi" is "narrower".</p>
        <p>Every antenna also has an <strong>effective aperture</strong>, the area of passing wave it collects: A = G λ² / 4π. A 0 dBi antenna at 2.4 GHz collects ${nf(apertureM2(0, 2.4) * 1e4, 0)} cm², at 28 GHz only ${nf(apertureM2(0, 28) * 1e4, 2)} cm². Remember this. It is the whole explanation of the next step.</p>
        <p>Put elements in a line, half a wavelength apart, and feed each with a phase step: their fields add in one direction and cancel in others. That is a <strong>phased array</strong>: isotropic elements would give 10 log n dB of gain (dipoles in a line a little less, since their own pattern already narrows the same way; the panel integrates the plotted pattern), and a beam you steer electronically, with no moving parts. Move the sliders. At 28 GHz, half a wavelength is ${nf(wavelengthM(28) * 500, 1)} mm, and a 64-element array fits in a phone's corner. The cellular chapter returns to this.</p>`,
      widget: antennaWidget,
      challenge: {
        kind: 'quiz',
        question: 'What does a higher-gain antenna do to the total power it radiates?',
        options: ['Nothing: it concentrates the same power in a narrower beam', 'It multiplies it, which is why it costs more', 'It reduces it, because of resistance', 'It depends on the frequency'],
        answer: 0,
        explain: 'Gain is a ratio of the peak to the average over the sphere. The radiated total is what the amplifier supplied, less a little loss.',
        why: ['', 'Antennas are passive: the power comes from the amplifier.', 'Losses are small, and unrelated to gain.', 'Gain is a shape, at whichever frequency.'],
      },
    },
    {
      title: 'Path loss',
      body: `
        <p>A transmitter's power spreads over a sphere, 4πd². At distance d the power density is P / 4πd². Multiply by the receiving antenna's aperture λ² / 4π for a 0 dBi antenna and you have Friis's law:</p>
        <p><code>P<sub>r</sub> / P<sub>t</sub> = G<sub>t</sub> G<sub>r</sub> (λ / 4πd)²</code></p>
        <p>In dB, with d in km and f in GHz, that is the formula every budget uses: <code>20 log d + 20 log f + 92.45</code>. Doubling the distance costs 6 dB. So does doubling the frequency, and now you can say why: nothing about free space depends on frequency. Nothing is absorbed. The aperture is smaller. So a dish of a fixed size has more gain at a higher frequency: four times per octave at each end, sixteen for both, against four times the path loss. A <em>point-to-point</em> link gets better with frequency, not worse.</p>
        <p>Real paths aren't free space. Indoors and in cities the average falls by an exponent n: 10 n log d, with n between 2 and 4 or so. (Over a flat ground the direct and reflected rays cancel and n tends to 4.) The thin line is free space. Set n to 3.5 and see how quickly a building eats a budget.</p>`,
      widget: pathWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why is 60 GHz used for short links rather than long ones, given what you just read?',
        options: ['An oxygen absorption line adds about 15 dB/km near 60 GHz, on top of the small aperture of a low-gain antenna', 'Free space absorbs high frequencies', 'Silicon cannot work at 60 GHz', 'Its wavelength is too long for an antenna'],
        answer: 0,
        explain: 'Below about 10 GHz air absorbs almost nothing, but the oxygen line near 60 GHz is real. It even helps: it keeps neighbouring links apart.',
        why: ['', 'Free space absorbs nothing; aperture is what falls with frequency.', 'CMOS has made 60 GHz radios for years.', 'Its wavelength is 5 mm, small enough for a tiny array.'],
      },
    },
    {
      title: 'The link budget',
      body: `
        <p>Radio engineers add and subtract in dB because the losses multiply. Start from the transmitter, add the antenna, subtract the path and the walls, add the far antenna. What arrives must stand above a <strong>noise floor</strong> set by temperature and bandwidth:</p>
        <p><code>N = −174 dBm/Hz + 10 log B + NF</code></p>
        <p>−174 dBm/Hz is kT at 290 K, thermal noise at room temperature: the floor no receiver goes below, and each adds its noise figure on top. A 20 MHz channel adds ${nf(10 * Math.log10(20e6), 0)} dB of it, and a ${D.nf} dB noise figure makes ${nf(noiseFloorDbm(20, D.nf), 0)} dBm.</p>
        <p>At the defaults (${D.tx} dBm, ${D.ga} dBi each end, ${D.m} m, ${D.walls} walls, ${D.ghz} GHz), the path is ${nf(B0.path, 1)} dB, ${nf(B0.rx, 1)} dBm arrives, the SNR is ${nf(B0.snr, 1)} dB, and Shannon says ${nf(B0.capacityMbps, 0)} Mb/s.</p>
        <p>Move to 5.5 GHz at the same range and widen the channel to 80 MHz. That is ${nf(fsplDb(D.m / 1000, 5.5) - fsplDb(D.m / 1000, D.ghz), 1)} dB more path, ${nf((WALL_DB(5.5) - WALL_DB(2.4)) * D.walls, 0)} dB more walls and 6 dB more noise, leaving ${nf(B5.snr, 1)} dB, for ${nf(B5.capacityMbps, 0)} Mb/s. Capacity is a contest between SNR and bandwidth, and wider doesn't always win. With power fixed, capacity tends to a limit, P / (N₀ ln 2), as the channel widens, and the panel shows it. At that point, more spectrum buys nothing: you need more power, or less distance.</p>`,
      widget: budgetWidget,
      challenge: {
        kind: 'quiz',
        question: 'Doubling transmit power and doubling the bandwidth. For a link at low SNR, which is worth more?',
        options: ['Doubling the power', 'They are about equal', 'Doubling the bandwidth', 'Neither helps at low SNR'],
        answer: 0,
        explain: 'At low SNR, log₂(1 + x) ≈ x / ln 2, so C ≈ B · (P / N₀B) / ln 2 = P / (N₀ ln 2): B cancels. Doubling the power doubles capacity and doubling the bandwidth does very little more. At high SNR, the reverse: bandwidth is linear and power only logarithmic.',
        why: ['', 'B cancels at low SNR, so doubling it adds very little while doubling P doubles capacity.', 'Only at high SNR, where capacity is linear in B and logarithmic in P.', 'Power certainly helps at low SNR.'],
      },
    },
    {
      title: 'The mixer',
      body: `
        <p>A signal at 2.4 GHz and an ADC at 100 MS/s don't meet. The device that brings them together is a <strong>mixer</strong>: multiply the signal by a local oscillator, and the identity</p>
        <p><code>cos a · cos b = ½ cos(a − b) + ½ cos(a + b)</code></p>
        <p>gives two copies, at the difference and the sum. Filter away the sum and the band has moved, its information intact, to where a filter and an ADC can deal with it. The transmitter runs the same trick the other way. A real mixer is a pair of switches, CMOS transistors turned fully on and off by the oscillator: a chopper (so it mixes at the oscillator's odd harmonics too, for the filter in front to deal with).</p>
        <p>Move the sliders. Notice the problem: the absolute value in the difference means that a signal the same distance on the <em>other side</em> of the oscillator lands on the same place. That other frequency is the <strong>image</strong>. Tick the box: two stations, one output, forever mixed. The classic radio (Armstrong's <strong>superheterodyne</strong>, 1918) filters the image away at RF first, which is why it mixes to a fairly high intermediate frequency, to push the image far enough off for a filter to separate it.</p>
        <p>Modern chips mix straight to zero (direct conversion) with two mixers, one driven by cos and one by sin, 90° apart. The modem chapter's I and Q. With both, the mix is a complex multiplication, by e<sup>−jωt</sup>, which shifts in one direction only. There is no image, if the two arms match. Any mismatch leaks one in, so a chip calibrates its I/Q balance: about half a percent of gain error, or a third of a degree of phase, is a −50 dB image.</p>`,
      widget: mixerWidget,
      challenge: {
        kind: 'quiz',
        question: 'A receiver tunes to 2.410 GHz with a 2.400 GHz oscillator. Which frequency is its image?',
        options: ['2.390 GHz', '2.420 GHz', '4.810 GHz', '10 MHz'],
        answer: 0,
        explain: 'The output is |f − LO| = 10 MHz. A station at 2.390 GHz gives the same difference: 2 · LO − f.',
        why: ['', 'That gives 20 MHz.', 'That is the sum, which a filter removes after the mixer. It is not an input frequency that lands on the IF.', 'That is the output frequency, not an input that aliases onto it.'],
      },
    },
    {
      title: 'A radio in arithmetic',
      body: `
        <p>Once a band is digitized, everything else is arithmetic. A <strong>software radio</strong> has an antenna, a filter, a mixer down to near zero, a fast ADC, and then a program: multiply by a numerically controlled oscillator (the same NCO as the modem chapter's), filter and <strong>decimate</strong> to the channel's rate, demodulate. Ten stations are ten sets of arithmetic, on one ADC.</p>
        <p>This explorer does exactly that, sample by sample. Four BPSK stations of different power share a band. Drag <em>Tune</em> onto one. The received symbols sit in two clusters, on the real axis: a clean BPSK. Between stations you get mush. The moving average that decimates is the cheapest low-pass filter there is (several of them in a row, usually three to five, make a CIC filter, the usual first stage of a real digital down-converter, built from adders and registers alone), and over a whole symbol it has a null at every non-zero whole number of cycles per symbol. These stations share one symbol clock and sit on whole offsets, so a strong neighbour disappears here, even at 9 times your power; a real neighbour on its own clock leaves sidelobes for more filtering to deal with.</p>
        <p>Then the price: ADC power goes up with sampling rate and with resolution, and a strong station beside a weak one needs bits. Every 6 dB of dynamic range is a bit. Hence the analog filter before the ADC. A phone keeps as much of the band out as it can, and makes the rest digital. The boundary keeps moving with each process node.</p>`,
      widget: sdrWidget,
      challenge: {
        kind: 'quiz',
        question: 'A strong station shares a software radio\'s band with a weak one you want. What does a strong neighbour do first?',
        options: ['It sets the range the ADC has to cover, so the weak one has fewer effective bits', 'It heats the antenna', 'It changes the frequency of the weak one', 'Nothing: the digital filter removes it completely, however strong'],
        answer: 0,
        explain: 'The filter comes after the ADC. Its gain has to be set so that the strong signal does not clip. The weak one then spans only a few of the codes, and quantization noise is what limits it.',
        why: ['', 'Tiny powers here.', 'Superposition: frequencies do not move in a linear system.', 'A digital filter can only remove what the ADC captured faithfully.'],
      },
    },
    {
      title: 'Multipath',
      body: `
        <p>A signal doesn't arrive once. It reflects off walls, floors and buildings, and arrives as a series of echoes, with their own delays and phases. In the time domain that is an impulse response; in the frequency domain it is a filter, with notches where echoes cancel. Two equal rays Δτ apart have a null every 1 / Δτ.</p>
        <p>Its size is the <strong>delay spread</strong> τ, the rms of those delays weighted by power: about 50 ns indoors, a microsecond or more outdoors in a city. Its other face is the <strong>coherence bandwidth</strong>, about 1 / (5 τ): frequencies closer than that fade together. For τ = 50 ns, ${nf(coherenceMHz(50), 0)} MHz.</p>
        <p>Move the echoes and the channel width. A channel narrower than the coherence bandwidth is <em>flat</em>: the whole thing rises and falls together. A channel wider than that is <em>frequency selective</em>: parts of it can be 20 dB down. In time, the same thing is <strong>inter-symbol interference</strong>: the echo arrives a symbol or more late, and lands on the next one. Fast symbol, long echo: trouble.</p>
        <p>There are two cures. Equalize: run an adaptive filter that undoes the channel (the fast serial links chapter's DFE, working harder). Or use many slow carriers, each narrow enough to be flat, with a guard interval that swallows the echoes: OFDM, the modem chapter's "many tones", and the reason Wi-Fi and LTE look the way they do.</p>`,
      widget: multipathWidget,
      challenge: {
        kind: 'quiz',
        question: 'You split a 20 MHz channel with a 1 µs delay spread into 256 subcarriers. What does each one see?',
        options: ['A nearly flat channel: each is 78 kHz wide, below the coherence bandwidth of about 200 kHz', 'The same 1 µs echoes in each, unchanged', 'No fading at all', 'A channel twice as noisy'],
        answer: 0,
        explain: 'Each subcarrier is 20 MHz / 256 ≈ 78 kHz, and a symbol is 12.8 µs. The echo is a small fraction of it, and a guard interval swallows it. Each subcarrier then fades as a single complex number.',
        why: ['', 'Same echoes, but relative to a much longer symbol they do little harm.', 'It still fades, but flat: one complex gain for each.', 'Noise per Hz is the same; each carrier has less of both.'],
      },
    },
    {
      title: 'Fading',
      body: `
        <p>Now move. As you travel a wavelength the phases of all those rays change, so the sum wanders: <strong>fast fading</strong>. Each ray arrives shifted by <strong>Doppler</strong>, up to f<sub>d</sub> = v f / c: ${nf(FD, 0)} Hz at 100 km/h at 2 GHz. With many rays from all around, their sum has Gaussian real and imaginary parts: its amplitude has a <strong>Rayleigh</strong> distribution, and its power is exponential.</p>
        <p>The plot is Clarke's model: 64 rays with random arrival angles. The pattern's scale is a wavelength: a fade 10 dB down comes about every ${nf(1 / (levelCrossing(Math.sqrt(0.1), 1)), 1)} wavelengths travelled. How often, and for how long, have closed forms, and the tests hold this simulation to them: the rate of downward crossings of level ρ is √(2π) f<sub>d</sub> ρ e<sup>−ρ²</sup>. A common rule of thumb for how long the channel can be treated as unchanged, its <strong>coherence time</strong>, is 0.42 / f<sub>d</sub> (Clarke's correlation has already fallen to a half at 0.24 / f<sub>d</sub>), here ${nf(coherenceTime(FD) * 1000, 1)} ms: the time that choosing a rate and measuring with pilot symbols have to work with.</p>
        <p>The cost in BER is enormous. Without fading BPSK falls off a cliff: exponentially in SNR. With it the error rate is dominated by the moments when you're in a fade, and it falls only as 1 / SNR: ½(1 − √(γ / (1 + γ))). At 10 dB, ${sci(bpskAwgn(dbToRatio(10)))} without fading and ${sci(bpskRayleigh(dbToRatio(10)))} with it. A budget holding outage to 1 % needs a fade margin of ${nf(fadeMarginDb(0.01), 0)} dB.</p>`,
      widget: fadingWidget,
      challenge: {
        kind: 'quiz',
        question: 'A car doubles its speed. What happens to the fades?',
        options: ['Twice as many a second, and each half as long: their depth statistics do not change', 'They get twice as deep', 'They stay the same: speed matters only in the time domain', 'They go away, because the car leaves them behind'],
        answer: 0,
        explain: 'The pattern is a standing map in space with a scale of about a wavelength; speed scales the time axis. Both crossing rate and duration depend on f_d alone, with the same distribution of depth.',
        why: ['', 'The amplitude distribution is unaffected by speed.', 'The rate of change does change, and that is exactly the point.', 'A car moves through the field pattern. It does not leave it.'],
      },
    },
    {
      title: 'What more antennas buy',
      body: `
        <p>If one antenna is in a fade, another half a wavelength away probably isn't. Combine them according to their strengths (<strong>maximal ratio combining</strong>) and an error needs both to be in a fade together. With L independent branches the error rate falls as 1 / SNR<sup>L</sup>: the <strong>diversity order</strong> is the slope of the curve.</p>
        <p>At a BER of 10⁻³, BPSK needs ${nf(needAwgn(1e-3), 1)} dB with no fading and ${nf(needRay(1e-3), 1)} dB in Rayleigh fading with one antenna. Two antennas: ${nf(needFor(2), 1)} dB. Four: ${nf(needFor(4), 1)}. The first extra antenna is worth ${nf(needRay(1e-3) - needFor(2), 0)} dB, more than any amplifier you could afford, for the price of a wire and some arithmetic. That gain is a statistical one, and a real one. A simple rule: don't fight a fade; average over it.</p>
        <p>Diversity comes in other forms too, all of them the same idea. Frequency: spread over more bandwidth than the coherence bandwidth, as the many-carriers system does, with a code across its subcarriers. Time: interleave beyond a coherence time, the errors chapter's interleaver. Space: more antennas at either end, which, used differently, also buys several streams at once. That is MIMO, in the next chapter.</p>
        <p>This is where the wireless engineer's budget differs from the optical one. Fibre has no fading and a known noise. A radio's SNR changes by 30 dB in a fraction of a second, so a radio has to measure and adapt continually. The next two chapters are about who talks, how fast, and how they share.</p>`,
      widget: diversityWidget,
      challenge: {
        kind: 'quiz',
        question: 'You are at 24 dB, a BER near 10⁻³, in a slowly fading channel. Which buys more: 4 dB of transmit power or a second receive antenna?',
        options: ['The second antenna, by a long way: it changes the slope of the curve', '4 dB of power: more signal always wins', 'The same: both raise SNR by about 3 to 4 dB', 'Neither: a slow fade cannot be helped'],
        answer: 0,
        explain: `With one antenna 4 dB lowers BER by a factor of ${nf(bpskRayleigh(dbToRatio(24)) / bpskRayleigh(dbToRatio(28)), 1)}. Going from one antenna to two takes it from ${sci(bpskRayleigh(dbToRatio(24)))} to ${sci(bpskMrc(dbToRatio(24), 2))}: a factor of about ${nf(bpskRayleigh(dbToRatio(24)) / bpskMrc(dbToRatio(24), 2), 0)}, and that is with the SNR per branch held the same.`,
        why: ['', 'Against a 1 / SNR slope, 4 dB does little.', 'Array gain is 3 dB, but the diversity gain is the slope, and it is far larger.', 'Space diversity helps most exactly when it fades slowly, when time diversity cannot.'],
      },
    },
  ],
};

