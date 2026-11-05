// The fuller codex for the Communication extension: message, signals, noise (codexcomm2a.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE8A: Record<string, CodexMore> = {
  bdp: {
    idea: `A bit sent now is still on the line when the next is sent, so a line has a volume: <b>rate × travel time</b> bytes are in flight at any instant, 35 MB for 10 Gb/s to London. The sender cannot forget a byte until its acknowledgement returns, so what it must hold, and what its window must allow, is <b>rate × round trip</b>. That is the bandwidth-delay product. It is the one number that links a faster line to a bigger buffer: the rate scales it and no upgrade shortens the delay part.<br><br>The same number appears wherever something waits for an answer. A sliding window fills the pipe when W reaches the round trip in frame times, 1 + 2a slots; TCP's receive window has to be at least this much or the line idles; a router buffer of one BDP lets a single loss-based sender recover without emptying the line, and any more only becomes queueing delay. On a long fat path the arithmetic is unforgiving: Reno climbs back from a halved window at a packet a round trip, which on a 1 Gb/s, 100 ms path takes minutes.`,
    example: {
      title: 'Three lines, one product',
      body: `<pre>10 Gb/s to London, 5 600 km: travel 28 ms     → 35 MB on the line  (10¹⁰ × 0.028 / 8)
100 Mb/s, 3 000 km: travel 15 ms                → 187.5 kB
1 Gb/s, round trip 100 ms                       → 12.5 MB = 8 333 packets of 1 500 bytes
1 Gb/s, round trip 40 ms                        → 5 MB to fill it; a 500 kB window uses a tenth
after one loss Reno climbs back 4 167 round trips ≈ 7 minutes on the 100 ms path</pre>The rate in bits a second divided by eight gives bytes; the time is the one way trip for what is on the line and the round trip for the window.`,
    },
    mistakes: [
      'Using the one-way travel time for a window. The data cannot be forgotten until the acknowledgement is back, so the window is rate × round trip: twice what is on the line in one direction.',
      'Leaving out the division by eight, or mixing b and B: a 1 Gb/s link over 40 ms holds 5 MB, not 40.',
      'Upgrading the rate and keeping the window. Ten times the rate is ten times the BDP, so a window that filled the old line uses a tenth of the new one.',
      'Sizing router buffers at several BDPs to be safe. One BDP lets a single Reno flow keep the line busy; the rest is only delay, for every flow.',
    ],
    chapters: [
      { chapter: 'message', step: 2, label: 'What fits on the line' },
      { chapter: 'errors', step: 7, label: 'Asking again' },
      { chapter: 'tcp', step: 3, label: 'The window: room at the far end' },
      { chapter: 'queues', step: 3, label: 'A window from a formula' },
    ],
  },
  layers: {
    idea: `Nobody writes one program that knows about voltages, routes across the world and which browser tab wants the data. The job is split into <b>layers</b>: each uses the one below as a service and adds a header of its own, an envelope inside an envelope. TCP numbers the bytes so that nothing is lost or out of order, IP names a machine anywhere, Ethernet names the next machine on this one cable and checks that its frame came through.<br><br>At each hop the outer envelope is opened and a new one written, and the inner ones travel untouched, so a router reads IP to choose the next hop and builds an Ethernet header to reach it, and has no reason to look inside. That independence is the point: the same page crosses Wi-Fi, then fibre, then copper while TCP and the program above it change nothing. The cost is bytes: 78 around every packet, and a frame shorter than Ethernet's minimum is padded, so for a one-byte message nearly everything on the wire is overhead.`,
    example: {
      title: 'What a layered packet costs on Ethernet',
      body: `<pre>around the data:  TCP 20 + IP 20 + Ethernet header 14 + FCS 4 + preamble and start 8 + gap 12 = 78 bytes
1 460 data bytes  → 1 538 on the wire   94.9 % data
1 data byte       → 59-byte frame padded by 5 to the 64-byte minimum → 84 on the wire   1.2 % data</pre>The 8 bytes of preamble and start and the 12 of gap occupy the line, though no layer calls them a header.`,
    },
    mistakes: [
      'Sizing a link by the payload alone. Every packet carries 78 bytes around its data, and below the 64-byte minimum frame the padding is paid for too.',
      'Thinking every header is rewritten at every hop. Ethernet is, because it names the next machine on this cable; IP stays, because it names the far end; the data and TCP header are for the end machines.',
      'Taking one layer\'s check as an end-to-end guarantee. Ethernet checks a frame across one cable; a router can still drop or reorder it afterwards, which is why TCP numbers bytes at the ends.',
    ],
    chapters: [
      { chapter: 'message', step: 3, label: 'Why messages are cut up' },
      { chapter: 'message', step: 4, label: 'Layers' },
      { chapter: 'tcp', step: 0, label: 'A stream over datagrams' },
    ],
  },
  decibel: {
    idea: `Signals lose power along a line and gain it in amplifiers, and each stage multiplies. A long cable may leave one part in a million; numbers like that are awkward, so use their logarithm: ratio in dB = 10 log<sub>10</sub>(P<sub>2</sub> / P<sub>1</sub>). Then a chain adds, and three facts do most of the arithmetic: 10 dB is ten times, 3 dB is about twice, and a negative number is a loss.<br><br>A decibel is a ratio, so it has no unit of its own. <b>dBm</b> is a level: decibels above one milliwatt, 0 dBm = 1 mW, 30 dBm = 1 W. A level plus a gain is a level; two levels are never added as decibels. For a quantity that goes as the square of the amplitude, such as power into a fixed resistance, the decibels of an amplitude ratio are 20 log<sub>10</sub>: a pole whose gain is 0.24 in voltage is −12.3 dB, which is the same number as 10 log<sub>10</sub> of its power ratio.`,
    example: {
      title: 'A chain, and a level through a loss',
      body: `<pre>+20 dB amplifier, −60 dB cable, +30 dB amplifier:  20 − 60 + 30 = −10 dB  → power × 0.1
20 dBm transmitter, 90 dB path loss:                20 − 90 = −70 dBm = 10⁻⁷ mW
3 dB → ×1.995    10 dB → ×10    −90 dB → ×10⁻⁹
0 dBm + 0 dBm of independent power: 2 mW = 3 dBm, not 0
single pole, 1 GHz, at 4 GHz: gain 1 / √17 in amplitude = −12.3 dB</pre>`,
    },
    mistakes: [
      'Reading −60 dB as a ratio of 60. It is a ratio of one in a million, and the chain of gains and losses is a sum of such numbers.',
      'Multiplying decibels. They are already logarithms, so 20 dB and 30 dB together make 50 dB, not 600.',
      'Adding two levels in dBm. 0 dBm and 0 dBm of independent power are 2 mW, 3 dBm: convert to power, add, convert back.',
      'Using 10 log<sub>10</sub> on an amplitude ratio, or 20 log<sub>10</sub> on a power ratio. The factor of two is the square: halving a voltage costs 6 dB, halving a power 3.',
    ],
    chapters: [
      { chapter: 'message', step: 5, label: 'Decibels' },
      { chapter: 'signals', step: 0, label: 'A wave is a sum of sines' },
      { chapter: 'noise', step: 0, label: 'The floor' },
      { chapter: 'radio', step: 2, label: 'The link budget' },
      { chapter: 'converters', step: 3, label: 'A shaky clock' },
    ],
  },
  fourier: {
    idea: `A linear, time-invariant channel does one simple thing to a sine: it scales it and shifts it, and a sine of the same frequency comes out. So split a signal into sines, treat each on its own and add the results; that is why a channel is specified by a gain against frequency. A ±1 square wave of frequency f is (4 / π) Σ sin(2π k f t) / k over odd k: the fundamental carries 81 % of the power, the first three odd harmonics 93 %, and the edges live in the rest. Cut the sum short and it overshoots by 8.95 % of the step beside each edge, however many terms are kept (Gibbs): more of them narrow the ripple and do not lower it.<br><br>For samples the same idea is the discrete transform: N real samples and N / 2 + 1 frequencies are one set of numbers read two ways, nothing lost. A filter is an awkward sum in time and a multiplication in frequency; a short pulse, simple in time, spreads wide in frequency, with band × width about constant. Unequal gain across frequency is a dependence on the pattern: intersymbol interference is what it looks like in time.`,
    example: {
      title: 'The fastest square wave through one pole',
      body: `<pre>8 Gb/s, pattern 1010: fundamental at R / 2 = 4 GHz; channel: one pole at 1 GHz
fundamental 4 GHz   −12.3 dB     third harmonic 12 GHz   −21.6 dB
10–90 % rise ln 9 · τ = 350 ps against a 125 ps bit
a = e^(−2π · 1 / 8) = 0.456 of the last level left after each bit
1010 swings only (1 − a) / (1 + a) = ±0.374; a lone bit after a long run reaches 1 − 2a = 0.088</pre>The harmonic sum and the closed form agree exactly; a test holds them equal.`,
    },
    mistakes: [
      'Expecting more harmonics to remove the overshoot at a step. Gibbs\'s 8.95 % stays at 1000 terms; only the ripple narrows.',
      'Applying the sine-in, same-sine-out rule to something that is not linear and time-invariant. A mixer is linear but changes with time, and makes frequencies that were not there.',
      'Taking the 3 dB bandwidth as the limit on bit rate. At R = 2B this pole\'s eye is nearly ideal; it shuts only near 9.1 × B, and a real trace, falling faster than one pole, sets its limit from the whole shape.',
      'Quoting a band without its definition: 3 dB down, 90 % or 99 % of the power, or the regulator\'s mask differ by large factors for the same pulse.',
    ],
    chapters: [
      { chapter: 'signals', step: 0, label: 'A wave is a sum of sines' },
      { chapter: 'signals', step: 1, label: 'The same numbers in frequency' },
      { chapter: 'signals', step: 2, label: 'Narrow in time, wide in frequency' },
      { chapter: 'spectrum', step: 0, label: 'A tone that is not a line' },
      { chapter: 'spectrum', step: 1, label: 'A window is a choice of skirt' },
    ],
  },
  firfilter: {
    idea: `The simplest digital filter is a moving average. Weigh the last n samples differently and you have a <b>finite impulse response</b> filter, y[n] = Σ h[k] x[n − k]: the weights h are the taps, and they are also the output when the input is a single 1, so the response ends after n samples. The gain at a frequency is the DFT of the taps. A moving average of n has a null at every multiple of 1 / n of the sample rate; a window applied to the ideal sinc gives a chosen band. Sharpness costs length, about 3.3 / n cycles a sample of transition under a Hamming window, so twice as sharp is twice the taps, twice the multiplications a sample and twice the delay. Symmetric taps delay every frequency by (n − 1) / 2 samples, which is linear phase.<br><br>In gates the cost is in the multiplications, so choose taps that need none. With 1 4 6 4 1 a multiplication by 4 or 2 is wiring and 6 is 4 + 2; five 8-bit registers and a few adders do the rest. The gain is cos<sup>4</sup>(π f): 1 at DC and exactly 0 at half the sample rate, where the registers hold + − + − + and the alternating sum is 0.`,
    example: {
      title: 'The 1 4 6 4 1 filter in gates',
      body: `<pre>taps sum to 16: 8-bit input → 12-bit output (−128 × 16 = −2048 fits)
gain cos⁴(π f):  1 at DC,  0.250 at a quarter of the sample rate,  0 at half
+ − + − + once the registers are full: 1 − 4 + 6 − 4 + 1 = 0
fixed taps         1 140 NANDs, 600 of them in five 8-bit registers
programmable taps  + 3 × 632 = 1 896 NANDs for the 8 × 8 multipliers (it more than doubles)
the adders\' ripple carries set the period: 40 gate delays after an edge</pre>`,
    },
    lib: 'fir5',
    mistakes: [
      'Giving every tap a multiplier. Chosen taps can be shifts and sums of them; a general filter with programmable taps pays 632 NANDs for each 8 × 8 multiplier.',
      'Sizing the output word like the input. The result is a sum of the taps times the samples, so the taps\' sum (16 here) widens it by four bits.',
      'Expecting a short filter to have a sharp edge. About 3.3 / n cycles a sample of transition: halving the transition doubles the taps and the delay.',
      'Reading "no feedback" as "no delay". A symmetric FIR delays every frequency by (n − 1) / 2 samples; that is what keeps pulses in shape and also what a loop has to wait for.',
    ],
    chapters: [
      { chapter: 'signals', step: 3, label: 'A filter is a sum of delayed samples' },
      { chapter: 'signals', step: 4, label: 'A filter in gates' },
      { chapter: 'noise', step: 2, label: 'The matched filter' },
      { chapter: 'firdesign', step: 0, label: 'A mask, and mirror-image taps' },
      { chapter: 'firdesign', step: 2, label: 'Parks–McClellan' },
      { chapter: 'firdesign', step: 6, label: 'One multiplier, N clocks' },
      { chapter: 'spectrum', step: 5, label: 'Filtering by blocks' },
    ],
  },
  aliasing: {
    idea: `A converter reads a signal at fs samples a second. The sampling theorem (Whittaker, Kotelnikov, Shannon) says that a signal with nothing at or above fs / 2 is fixed entirely by its samples. Above that line the samples still exist and they are wrong: cos(2π(fs − f)k / fs) = cos(2π f k / fs) for every whole k, so a tone at f and one at fs − f give exactly the same numbers. Every frequency folds into 0 … fs / 2 and no later processing can tell the folded tone from a real one.<br><br>The cure is an analog filter <em>before</em> the converter, and it needs room to fall, so real rates leave a margin: telephone speech is cut off near 3.4 kHz and sampled at 8 kHz, a CD holds up to about 20 kHz at 44.1 kHz. Rounding each reading to b bits then leaves a signal-to-error ratio of 6.02 b + 1.76 dB on a full-scale sine, 6 dB a bit, so the converter\'s width should match the SNR it sees. Nyquist\'s 2B symbols a second and the 2B samples a second of this theorem are different claims with the same count: one is how many independent values a band can carry, the other how many readings capture it.`,
    example: {
      title: 'Where a tone lands, and what a bit buys',
      body: `<pre>fs = 10 kHz: 7 kHz tone  → |10 − 7| = 3 kHz
fs = 48 kHz: 30 kHz tone → 48 − 30 = 18 kHz, inside the audio band
fs =  8 kHz: 5 kHz tone  → 3 kHz
rounding to b bits: 6.02 b + 1.76 dB   8 bits 49.9 dB   16 bits 98.1 dB</pre>An 18 kHz alias cannot be removed digitally without removing a real 18 kHz tone too.`,
    },
    mistakes: [
      'Filtering the alias out in software. After sampling it is indistinguishable from a real tone at the folded frequency; the filter has to come before the converter.',
      'Believing a tone above fs / 2 is lost. Sampling discards nothing above the line, it folds it, which is why it is dangerous.',
      'Sampling at exactly twice the band. The anti-alias filter has no room to fall, so rates leave a margin: 8 kHz for speech cut near 3.4 kHz.',
      'Buying more converter bits than the SNR can use. At 42 dB above the analog noise, about 7 bits (6.7 by the formula) record the signal and more only record the noise more exactly.',
    ],
    chapters: [
      { chapter: 'signals', step: 5, label: 'Sampling, and what folds' },
      { chapter: 'signals', step: 6, label: 'Rounding to a number' },
      { chapter: 'multirate', step: 1, label: 'Throwing samples away' },
    ],
  },
  mixer: {
    idea: `A cable or an antenna passes a band somewhere up the spectrum; a voice or a stream of bits sits near zero. A mixer moves one to the other, and it is only a multiplication: cos a · cos b = ½ cos(a − b) + ½ cos(a + b). A tone at f times a carrier at fc gives two tones, fc − f and fc + f; a whole band becomes two sidebands, twice as wide in all. New frequencies appear because a mixer is linear but changes with time. A real one is a pair of switches turned on and off by the oscillator, a chopper, so it also mixes at the oscillator\'s odd harmonics.<br><br>The receiver multiplies by the carrier again; the band lands back at zero with a copy near 2fc that a low-pass filter removes. The difficulty is phase: if the receiver\'s carrier is out by φ the result falls by cos φ, and at 90° it vanishes. The other difficulty is the <b>image</b>: because the output is |f − LO|, a station as far on the other side of the oscillator gives the same output. A superheterodyne filters the image away first; direct conversion uses two mixers 90° apart, I and Q, a complex multiplication that shifts one way only, with the image set by how well the two arms match.`,
    example: {
      title: 'Sidebands, the image, and the arm mismatch',
      body: `<pre>band 0–4 kHz × 100 kHz carrier   → 96 to 104 kHz, 8 kHz wide, both sidebands
LO 2.400 GHz, station 2.410 GHz     → IF 10 MHz; image 2 · LO − f = 2.390 GHz
LO 1.000 GHz, station 1.020 GHz     → image 0.980 GHz
receiver carrier φ out of phase     → amplitude × cos φ   (0 at 90°)
I / Q arms: about ½ % gain error or a third of a degree of phase → an image at −50 dB</pre>`,
    },
    mistakes: [
      'Treating a mixer as an adder. Adding two sines gives the same two frequencies; only a product (or a nonlinearity) makes the sum and the difference.',
      'Forgetting the second sideband. The band doubles in width on the carrier, and one sideband alone, or I and Q, is what gets the width back.',
      'Taking the image for noise. It is a real station at 2 · LO − f that lands on the same output and cannot be told apart afterwards; it must be filtered before the mixer.',
      'Assuming any carrier will do on the way back. A carrier out by φ shrinks the result by cos φ, and at 90° the signal is gone.',
    ],
    chapters: [
      { chapter: 'signals', step: 7, label: 'A mixer moves a band' },
      { chapter: 'radio', step: 3, label: 'The mixer' },
    ],
  },
  thermalnoise: {
    idea: `Electrons in a resistor move with heat, and their motion is a voltage (Johnson, 1926; Nyquist, 1928): an open resistor shows √(4 k T R B) RMS, 4.0 nV for 1 kΩ in 1 Hz at 290 K. The power it can deliver does not depend on the resistor: <b>kT per hertz</b>, −174 dBm/Hz at the reference 290 K. It is flat far past any radio band, which is called white, so noise power is proportional to bandwidth: halve the band, or cool the source by half, and gain 3 dB.<br><br>A receiver adds its own, stated as its <b>noise figure</b>, how many dB it degrades the SNR; it is quoted against a 290 K source, so 6 dB is about 865 K of the receiver\'s own noise whatever it listens to, and cooling the source alone gains little. In a chain, Friis\'s formula divides each stage\'s excess noise by the gain before it, F = F<sub>1</sub> + (F<sub>2</sub> − 1) / G<sub>1</sub> + …; a passive loss has a figure equal to its loss. So the first stage sets the figure, and a lossy cable ahead of the amplifier counts in full.`,
    example: {
      title: 'A floor, and the order of two parts',
      body: `<pre>20 MHz, noise figure 6 dB:  −174.0 + 10 log₁₀(2 × 10⁷) + 6 = −174.0 + 73.0 + 6 = −95.0 dBm
100 MHz → 1 MHz: 20 dB less thermal noise (a hundredth of the band)
6 dB figure = 865 K of excess noise at 290 K
amplifier (20 dB gain, 1 dB figure) then cable (10 dB loss): 1.30 dB overall
cable first, then the same amplifier:                       11.00 dB overall
the order alone costs 9.7 dB</pre>9.7 dB is about 9 times the transmit power for the same error rate.`,
    },
    mistakes: [
      'Quoting −174 dBm as the floor of a link. It is per hertz; the channel collects it over its whole band, 73 dB more at 20 MHz.',
      'Leaving out the noise figure. The thermal floor is the best any receiver can do; the figure says how much of its own the receiver adds on top.',
      'Putting a cable or filter ahead of the first amplifier. Its loss adds to the figure in full, which is why dishes mount the low-noise amplifier at the focus.',
      'Cooling only the source and expecting the whole gain. With a 6 dB figure the receiver adds about 865 K of its own, and the source was the smaller part.',
    ],
    chapters: [
      { chapter: 'noise', step: 0, label: 'The floor' },
      { chapter: 'noise', step: 6, label: 'A chain: who pays' },
      { chapter: 'radio', step: 2, label: 'The link budget' },
    ],
  },
  matchedfilter: {
    idea: `A symbol lasts many samples and looking at one wastes the rest. Take a weighted sum Σ w<sub>k</sub> r<sub>k</sub> of samples r = pulse p plus noise of σ on each, and compare it with zero. The signal part is Σ w p; the noise part has variance σ² Σ w². The Cauchy–Schwarz inequality says the SNR (Σ w p)² / (σ² Σ w²) is largest when w is proportional to p, and there it equals <b>E / σ²</b>: the pulse\'s energy over the noise per sample (D. O. North, 1943). In continuous time the filter\'s impulse response is the pulse reversed in time.<br><br>Two things follow. The best SNR depends on the pulse\'s energy and not its shape, so a shape can be chosen for its band without loss to noise. And for a rectangle all weights are equal, so the best receiver just averages: over 16 samples that gains 10 log<sub>10</sub> 16 = 12.0 dB on one. It is forgiving: for half a sine, plain averaging is 0.90 dB short. Practical links split the filter between the ends, a root-raised-cosine at the transmitter and the same at the receiver, whose product leaves no intersymbol interference at the sampling instants.`,
    example: {
      title: 'Why averaging gains 10 log N for a rectangle',
      body: `<pre>pulse: 16 equal samples of height A, noise σ on each sample
one sample:      signal A, noise σ            SNR = A² / σ²
average of 16:   signal 16 A, noise 4 σ       SNR = 16 A² / σ²   → +12.0 dB
matched, any shape: SNR = Σ p² / σ² = E / σ²
a rectangle of 64 samples: 10 log₁₀ 64 = 18.1 dB over one sample
half a sine: averaging all is 0.90 dB below matched</pre>The signal adds in step (16 times); independent noise adds in power (√16 times).`,
    },
    mistakes: [
      'Believing a taller or narrower pulse does better. Only energy counts: any shape of equal energy reaches the same E / σ².',
      'Using equal weights for every pulse. That is the matched filter only for a rectangle; for other shapes weigh each sample by the signal expected in it.',
      'Forgetting what it needs: the pulse\'s shape and the instant to look. The gain is E / σ² only when the filter is lined up with the pulse.',
      'Adding more samples of the same signal in the same noise density and expecting more SNR. Finer sampling adds no energy.',
    ],
    chapters: [
      { chapter: 'noise', step: 2, label: 'The matched filter' },
      { chapter: 'noise', step: 3, label: 'One axis for every link' },
    ],
  },
  ebn0: {
    idea: `To compare a 300 b/s modem with a 400 Gb/s fibre take the rate out. E<sub>b</sub> is the energy per bit, signal power divided by bit rate; N<sub>0</sub> the noise density. Their ratio is dimensionless and SNR = (E<sub>b</sub> / N<sub>0</sub>) (R / B): what a bit gets, scaled by how many bits share each hertz. With ±√E<sub>b</sub> and a matched filter, the decision noise has variance N<sub>0</sub> / 2 and the error rate is <b>Q(√(2 E<sub>b</sub> / N<sub>0</sub>))</b>: 9.59 dB for one bit in 10<sup>5</sup>, 12.5 dB for one in 10<sup>9</sup>. That curve is the reference every code is measured against: a code\'s gain is how far left of it the code runs.<br><br>The limit is ln 2, −1.59 dB: bits a second can never exceed P / (N<sub>0</sub> ln 2), so the energy per bit over N<sub>0</sub> can never fall below ln 2, however long the code and however wide the band. Between that line and the uncoded curve lie 11.2 dB at 10<sup>−5</sup>, a factor of 13 in power, which is what coding is for. For binary ±1 signals at rate ½ the limit is 0.19 dB.`,
    example: {
      title: 'Same axis, two rates',
      body: `<pre>uncoded BPSK:  10⁻⁵ at 9.59 dB     10⁻⁹ at 12.5 dB
no code at all works below ln 2 = −1.59 dB
gap to close at 10⁻⁵: 9.59 + 1.59 = 11.2 dB  = a factor of 13 in power
1 kb/s and 1 Gb/s, both at 9.59 dB:  the same share of bits wrong;
  the fast link spends 10 log₁₀(10⁶) = 60 dB more power  (P = E_b · R)
binary ±1 input at rate ½: limit 0.19 dB</pre>`,
    },
    mistakes: [
      'Comparing a rate-½ code to an uncoded link at the same E<sub>s</sub>/N<sub>0</sub>. Each channel bit carries half the energy per data bit; plot against E<sub>b</sub>/N<sub>0</sub>, per information bit.',
      'Treating E<sub>b</sub>/N<sub>0</sub> as the SNR. They differ by R / B, the bits a second per hertz: the same SNR means very different E<sub>b</sub>/N<sub>0</sub> at 1 bit and at 6 bits per hertz.',
      'Expecting the same error rate to cost the same power at every rate. The share of bits wrong depends on E<sub>b</sub>/N<sub>0</sub> alone, but power is E<sub>b</sub> × R: a million times the rate, 60 dB more.',
      'Reading −1.59 dB as reachable. It is the limit for codes of unbounded length; a real code stops short of it, and the uncoded curve sits 11.2 dB above it at 10<sup>−5</sup>.',
    ],
    chapters: [
      { chapter: 'noise', step: 3, label: 'One axis for every link' },
      { chapter: 'noise', step: 4, label: 'Power or band' },
      { chapter: 'codes', step: 6, label: 'How far from Shannon' },
    ],
  },
};
