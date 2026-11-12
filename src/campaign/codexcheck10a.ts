// Check yourself for the Communication extension: message, signals, noise. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK10A: Record<string, Quiz[]> = {
  bdp: [
    {
      question: 'A path has a 40 ms round trip. At 1 Gb/s, how much must the sender be allowed to keep in flight to fill it?',
      options: ['5 MB: rate × round trip, divided by eight for bytes', '2.5 MB: rate × the one-way time, half the round trip', '40 MB: rate × round trip, with bits taken for bytes', '1 MB: a fixed window, whatever the path'],
      answer: 0,
      explain: '10⁹ b/s × 0.04 s is 40 Mb, which is 5 MB. The sender cannot forget a byte until its acknowledgement is back, so the window covers the whole round trip.',
      why: ['', 'That is what is on the line in one direction; the acknowledgements still have to return before the data can be forgotten.', 'That forgets the division by eight: 40 million bits are 5 million bytes.', 'The figure depends on the rate and the delay of the path, so no fixed window suits every one.'],
    },
    {
      question: 'Why does a sender on a long fast path need memory in proportion to the bandwidth-delay product?',
      options: ['It keeps every byte until its ack returns: rate × round trip', 'Routers cut the data into pieces that all need storing', 'The receiver reads the data in blocks of that size', 'Each acknowledgement is as large as the byte it confirms'],
      answer: 0,
      explain: 'Retransmission needs the data until it is known to have arrived. On a link that holds megabytes, the sender must hold megabytes however little the program thinks it is sending.',
      why: ['', 'Routers hold packets briefly in their own buffers; the sender\'s memory is for retransmission.', 'The receiver\'s reading block size plays no part in how long data waits for its acknowledgement.', 'An acknowledgement is a few bytes; the cost is the time it takes to come back.'],
    },
  ],
  layers: [
    {
      question: 'A one-byte message goes over TCP, IP and Ethernet. How many bytes does it occupy on the wire?',
      options: ['84: padded to the 64-byte minimum, plus preamble and gap', '1: just the data byte, with no headers at all', '59: the data and four headers, with no padding or gap', '78: the headers on their own, without the data'],
      answer: 0,
      explain: '1 + 20 + 20 + 14 + 4 is 59 bytes of frame, padded by 5 to the 64-byte minimum, plus 8 of preamble and 12 of gap: 84, of which the data is 1.2 %.',
      why: ['', 'Every layer adds its header, and Ethernet pads a short frame.', 'A frame shorter than 64 bytes is padded, and the preamble and gap use the line as well.', 'That is the headers, preamble and gap alone; the data byte and the padding come on top.'],
    },
    {
      question: 'Why can the same web page cross Wi-Fi, then fibre, then copper without the program changing?',
      options: ['Each layer uses only the one below, so links change under the headers', 'The program tests every link and adapts to each one it meets', 'All links use the same voltages and timing everywhere', 'The link layers are rebuilt at every hop to match the sender'],
      answer: 0,
      explain: 'The outer envelope belongs to one cable and is replaced at each hop; the IP and TCP headers inside it stay as they are. That independence is what layering buys, for 78 bytes a packet.',
      why: ['', 'The program knows nothing about the links; that is the point of the layers.', 'Links differ widely in signalling; the layers hide that from what is above them.', 'Only the outermost envelope is rewritten, and the headers of the layers above stay the same.'],
    },
  ],
  decibel: [
    {
      question: 'A cable leaves one part in a million of the power. What is its loss?',
      options: ['60 dB: 10 log₁₀ of a million', '6 dB: the base-ten log of a million', '120 dB: 20 log₁₀ of a million', '30 dB: 3 dB for every factor of ten'],
      answer: 0,
      explain: 'log₁₀ 10⁶ is 6, and the decibel takes ten times that. A chain of such losses and gains then adds.',
      why: ['', 'That omits the factor of 10; a decibel is a tenth of a bel, so ten times the logarithm.', 'The factor of 20 is for a ratio of amplitudes; this is a ratio of powers.', '3 dB is a doubling; a factor of ten is 10 dB.'],
    },
    {
      question: 'Two independent signals of 0 dBm each are combined. What is the total power?',
      options: ['About 3 dBm: two milliwatts, as levels add as powers', '0 dBm: adding a signal does not change a level', 'Still 0 dBm, because 0 plus 0 is 0 in any unit', '6 dBm: each signal contributes 3 dB to the level'],
      answer: 0,
      explain: '0 dBm is 1 mW. Two of them are 2 mW, and 10 log₁₀ 2 is 3.01 dBm. Levels are converted to power, added, and converted back.',
      why: ['', 'The total power is twice that of either, which is 3 dB more.', 'The sum of the numbers is 0, but dBm is a logarithm of power, and logarithms of powers do not add that way.', 'That would be four times the power; two equal powers are only twice.'],
    },
  ],
  fourier: [
    {
      question: 'A square wave is built from 25 odd harmonics, then from 1000. How does the overshoot beside each edge change?',
      options: ['It stays about 8.95 % of the step; the ripple only narrows', 'It falls in proportion to the number of terms', 'It disappears once there are enough terms', 'It doubles, since more terms add more energy'],
      answer: 0,
      explain: 'This is the Gibbs phenomenon: the partial sums overshoot by the same fraction of the step however many terms are kept, and the overshoot moves closer to the edge.',
      why: ['', 'The height of the overshoot does not fall with more terms; its width does.', 'It tends to a fixed fraction rather than to zero, however large the count.', 'More terms add power at higher frequencies, but the overshoot stays the same height.'],
    },
    {
      question: 'Why is a channel specified by its gain against frequency?',
      options: ['It only scales and shifts each sine, so each is treated alone and summed back', 'Channels are built from tuned circuits that each respond to one frequency', 'Only sinusoidal signals can be sent through a wire or a cable', 'Frequency is the only quantity that a channel can measure'],
      answer: 0,
      explain: 'A sine in gives the same sine out, scaled and shifted. Split any signal into sines, apply each one\'s gain and phase, and add them back: that is a full description of the channel.',
      why: ['', 'Resonance is one way to build such a response; the description holds for any linear channel.', 'Any signal can be sent; it is simply described as a sum of sines.', 'A channel carries signals in time; frequency is the most convenient way to describe what it does to them.'],
    },
  ],
  complex: [
    {
      question: 'An arrow of length 2 at 30° is multiplied by an arrow of length 3 at 40°. What is the product?',
      options: ['An arrow of length 6 at 70°: the lengths multiply and the angles add', 'An arrow of length 5 at 70°: both add', 'An arrow of length 6 at 1200°: both multiply', 'An arrow of length 6 at −10°: the angles subtract'],
      answer: 0,
      explain: 'A complex product turns and scales: 2 × 3 = 6 for the length, 30° + 40° = 70° for the angle.',
      why: ['', 'Lengths multiply. Adding them is what happens when the arrows are laid head to tail, which is a sum, not a product.', 'Angles add. Multiplying them has no meaning for a turn: turning by 30° and then by 40° is a turn of 70°.', 'Subtracting angles is dividing by the second arrow, not multiplying.'],
    },
    {
      question: 'A bin of a 64-sample block reads an arrow of length 16 pointing along the real axis. What cosine is in the block?',
      options: ['Amplitude 0.5, phase 0: the bin\'s length over N / 2 = 32 is the amplitude', 'Amplitude 16: the length is the amplitude', 'Amplitude 0.25: the length over N', 'Amplitude 0.5, phase 90°: a pure cosine sits on the imaginary axis'],
      answer: 0,
      explain: 'A cosine of amplitude A at bin k gives a bin of length (N / 2) A, so A = 16 / 32 = 0.5, and the bin\'s angle is the cosine\'s phase, 0.',
      why: ['', 'The bin adds N terms, so its length is N / 2 times the amplitude, not the amplitude.', 'The cosine\'s two arrows each carry half of it, but only one lines up at bin k: the divisor is N / 2, not N.', 'A phase of 0 is a cosine and puts the bin on the real axis; a sine (phase −90°) points straight down.'],
    },
  ],
  firfilter: [
    {
      question: 'The filter 1 4 6 4 1 is fed the fastest possible tone, + − + − + at half the sample rate. What comes out once its registers are full?',
      options: ['Exactly 0: 1 − 4 + 6 − 4 + 1 = 0', 'The input scaled by 16, the sum of the taps', 'A tone of half the amplitude', 'The same tone delayed by two samples'],
      answer: 0,
      explain: 'The gain is cos⁴(π f), which is 1 at DC and 0 at half the sample rate, because the alternating sum of the taps cancels.',
      why: ['', 'Sixteen is the gain at DC, where all the samples add in step.', 'The gain at that frequency is exactly zero, not a half.', 'The filter delays by two samples, but nothing remains to be delayed here.'],
    },
    {
      question: 'A designer wants a low-pass filter whose edge is twice as sharp. What does it cost?',
      options: ['About twice the taps, so twice the multiplications and the delay', 'The same taps with larger weights, as only the gain changes', 'Half the taps, because the pass band is then narrower', 'Nothing at all: the sample rate alone sets the edge'],
      answer: 0,
      explain: 'The transition is about 3.3 / n cycles a sample for n taps under a Hamming window, so halving the transition doubles n.',
      why: ['', 'The sharpness comes from the length of the impulse response; larger weights only scale the gain.', 'A shorter filter has a wider transition, not a narrower one.', 'The sample rate sets the scale of frequency but not the length needed for a given edge.'],
    },
  ],
  aliasing: [
    {
      question: 'A converter samples at 8 kHz with no filter in front. A 5 kHz tone arrives. What do the samples show?',
      options: ['A 3 kHz tone: 8 − 5, the same as a real one', 'A 5 kHz tone, only with some more error', 'Nothing, as 5 kHz is above half the rate', 'A 13 kHz tone, the sum of the two'],
      answer: 0,
      explain: 'The converter holds nothing above 4 kHz. The tone at 5 kHz gives exactly the numbers of a tone at 8 − 5 = 3 kHz, so no later stage can tell them apart.',
      why: ['', 'No 5 kHz tone can be represented at this rate, with or without error.', 'Sampling discards nothing: the tone is folded into the band, which is what makes it dangerous.', 'A sampled signal only holds frequencies up to half the rate.'],
    },
    {
      question: 'Where does the filter that removes aliases belong?',
      options: ['In front of the converter, in analog, before the samples exist', 'After the converter, in software, once the samples exist', 'On the output, whichever side the converter sits on', 'Nowhere: a high enough sample rate removes the need'],
      answer: 0,
      explain: 'After sampling, a folded tone is the same numbers as a real one. Only a filter before the converter can separate them, and it needs room to fall, so rates leave a margin.',
      why: ['', 'The digital side cannot tell the alias from a real tone at the folded frequency.', 'A filter on the output cannot undo what the sampling already folded.', 'A higher rate moves the problem up; whatever lies above half the rate still folds.'],
    },
  ],
  mixer: [
    {
      question: 'A receiver has an oscillator at 1.000 GHz and tunes a station at 1.020 GHz. Which frequency is its image?',
      options: ['0.980 GHz: 2 · LO − f, below the oscillator', '1.040 GHz: the same distance above the station', '2.020 GHz: the sum of the two frequencies', '20 MHz: the output frequency itself'],
      answer: 0,
      explain: 'The output is |f − LO| = 20 MHz. A station at 0.980 GHz gives the same difference, so it lands on the same output and must be filtered out before the mixer.',
      why: ['', 'That would give 40 MHz, not the same output.', 'The sum is removed by a filter after the mixer; it is not an input frequency that lands on the output.', 'That is the output frequency, not an input that falls onto it.'],
    },
    {
      question: 'A receiver multiplies by a carrier that is 90° out of phase with the transmitter\'s. What is the recovered amplitude?',
      options: ['Zero: the result falls by cos φ, and cos 90° = 0', 'Full size: only frequency matters', 'Half size: the phase error halves it', 'Doubled: the two carriers add'],
      answer: 0,
      explain: 'The product of cos(ωt) and cos(ωt + φ) has a part that stays at zero frequency of ½ cos φ. At 90° it vanishes, which is why I and Q are used together.',
      why: ['', 'The phase decides how much of the signal lands at zero, not just the frequency.', 'The loss follows cos φ, which is zero at 90°, not a fixed half.', 'A mixer multiplies; nothing adds up to more than the original.'],
    },
  ],
  thermalnoise: [
    {
      question: 'A receiver has a 1 MHz channel and a 3 dB noise figure. What is its noise floor?',
      options: ['About −111 dBm: −174 + 60 + 3', 'About −174 dBm: the density is the floor', 'About −171 dBm: −174 + 3', 'About −114 dBm: the band with no noise figure'],
      answer: 0,
      explain: '10 log₁₀(10⁶) is 60 dB. The density is per hertz, so the band adds to it, and the receiver\'s own noise adds on top.',
      why: ['', 'That is per hertz; the channel collects noise over its whole band.', 'That leaves out the band, which is the larger term.', 'That is the thermal floor alone; the noise figure says how much the receiver adds to it.'],
    },
    {
      question: 'In a receiver chain, why does the first amplifier set the overall noise figure?',
      options: ['The noise of each later stage is divided by the gain ahead of it', 'The first stage always has the lowest noise of all', 'Noise is only ever added at the first stage', 'The later stages are cooled by the first stage'],
      answer: 0,
      explain: 'Friis\'s formula: F = F₁ + (F₂ − 1) / G₁ + (F₃ − 1) / (G₁ G₂) + …. A good first amplifier makes everything after it matter less; a loss in front counts in full.',
      why: ['', 'Nothing guarantees that; the first stage matters because later noise is divided by its gain.', 'Every stage adds noise. What differs is how large it is compared with the signal at that point.', 'Cooling is not part of the argument; it is the gain that divides the later noise.'],
    },
  ],
  gaussian: [
    {
      question: 'Noise has σ = 0.2 V and a signal level sits 0.6 V from the threshold. About how often is a sample read wrong?',
      options: ['About one in 741: 0.6 V is 3 σ, and Q(3) is 1.35 × 10⁻³', 'About one in three: 0.2 / 0.6', 'About one in 370: that is 2 Q(3)', 'Never: 0.6 V is beyond any noise sample'],
      answer: 0,
      explain: '0.6 V over 0.2 V is 3 σ, and the tail beyond it is 1.35 × 10⁻³, one in 741.',
      why: ['', 'That divides the wrong way round and treats the chance as proportional to the ratio.', 'That counts both sides. A decision reads one side, so it is Q(3), not 2 Q(3).', 'A Gaussian tail has no end: the chance is tiny and not zero.'],
    },
    {
      question: 'The margin goes from 3 σ to 6 σ. What happens to the chance of an error?',
      options: ['It falls by a factor of about a million, from 1.35 × 10⁻³ to 9.87 × 10⁻¹⁰', 'It halves, as the margin doubles', 'It falls by a factor of four', 'It stays the same: σ is unchanged'],
      answer: 0,
      explain: 'Q(3) over Q(6) is about 1.4 × 10⁶. The tail falls like e<sup>−x²/2</sup>, so each extra σ cuts it by more than the last.',
      why: ['', 'The chance is a tail area, not proportional to the margin.', 'A factor of four is what doubling a power would do; the Gaussian tail falls far faster.', 'σ is the noise; the margin d grew, and the chance depends on d / σ.'],
    },
  ],
  matchedfilter: [
    {
      question: 'A rectangular pulse of 64 samples is read by averaging all of them instead of by looking at one. How much SNR does that gain?',
      options: ['About 18 dB: 10 log₁₀ 64, signal in step and noise in power', 'About 36 dB: 20 log₁₀ 64, as for an amplitude ratio', 'About 9 dB: 10 log₁₀ 8, the noise falling by √64', 'None, since the pulse is the same height as before'],
      answer: 0,
      explain: 'The signal grows 64 times, the independent noise only 8 times, so the SNR rises 64 times in power. For a rectangle averaging is the matched filter.',
      why: ['', 'The factor of 20 is for a ratio of amplitudes; an SNR is a ratio of powers.', 'A fall of 8 in the noise\'s amplitude is a fall of 64 in its power, and the SNR is a ratio of powers.', 'The height is unchanged, but the noise on the average is much smaller.'],
    },
    {
      question: 'Which weights give the best SNR for a known pulse in white noise?',
      options: ['The pulse itself, each sample weighted by its expected signal', 'Equal weights, whatever the shape of the pulse is', 'Weights that favour the quietest samples of all', 'Weights that follow the spectrum of the noise'],
      answer: 0,
      explain: 'The Cauchy–Schwarz inequality makes the SNR largest when the weights are proportional to the pulse; the SNR is then E / σ². Equal weights are that choice only for a rectangle.',
      why: ['', 'Averaging is matched only when every sample of the pulse is the same height.', 'The noise has the same size on every sample; it is the signal that varies.', 'White noise has no spectral shape to follow; the pulse is what is known.'],
    },
  ],
  ebn0: [
    {
      question: 'Uncoded ±1 signalling is run at about 9.6 dB Eb/N0 with a matched filter. What share of its bits is wrong?',
      options: ['About one in 10⁵ bits', 'About one in 10⁹ bits', 'About one in 100 bits', 'About one in two bits'],
      answer: 0,
      explain: 'Q(√(2 × 9.1)) at 9.59 dB is 10⁻⁵. Going to 12.5 dB brings it to 10⁻⁹: the Gaussian tail falls fast.',
      why: ['', 'One in 10⁹ takes 12.5 dB, nearly 3 dB more.', 'One in 100 is reached at a much lower Eb/N0, about 4.3 dB.', 'One bit in two is a link with no signal at all.'],
    },
    {
      question: 'What is the lowest Eb/N0 at which any code can work?',
      options: ['−1.59 dB (ln 2)', '0 dB (a ratio of 1)', '3 dB (twice)', '9.59 dB (BPSK at 10⁻⁵)'],
      answer: 0,
      explain: 'Bits a second can never exceed P / (N₀ ln 2), so the energy per bit over N₀ can never fall below ln 2, however long the code and however wide the band.',
      why: ['', 'The limit lies 1.59 dB below that, in the limit of very wide band and long codes.', 'That is far above the limit; it is not a boundary of anything here.', 'That is the point where uncoded signalling reaches one error in 10⁵, not the limit of coding.'],
    },
  ],
};
