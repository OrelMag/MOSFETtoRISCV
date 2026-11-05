// The fuller texts of the Communication entries of chapters 45-47 (codexcomm.ts): modems, fast serial links, codes. Every number
// is the chapter's own, computed from comm/ and phys/ (tests/content-codexcomm.test.ts pins them to the models and to the
// chapter steps that print them). No DOM.

import type { CodexMore } from './codexmore';

export const MORE5: Record<string, CodexMore> = {
  qam: {
    idea: `A sinusoid has frequency, amplitude and phase. Keep the frequency; both of the others can carry data. Written as x(t) = I cos 2πft − Q sin 2πft, the cosine and sine are <b>orthogonal</b> (the integral of their product over a cycle is zero), so I and Q do not disturb each other and a receiver recovers them separately. One symbol is one point (I, Q) of the plane: its distance from the centre is the amplitude, its angle the phase. Four points at 90° are QPSK (4-QAM), two bits a symbol; sixteen points are four. Labelled with a Gray code on each axis, the commonest error (a point taken for its nearest neighbour) costs one bit.<br><br>More points in the same spectrum cost distance. Normalize the average symbol energy to 1: the points of 256-QAM sit nine times closer than QPSK's, and the symbol is wrong when noise on either axis crosses the half-way boundary. For square M-QAM, P<sub>axis</sub> = 2(1 − 1/√M) · Q(√(3 E<sub>s</sub>/N<sub>0</sub> / (M − 1))); the M − 1 means four times the points (two bits) needs about four times the SNR, 6 dB, for the same error rate. Mixing costs gates too: two multipliers and an adder, about 747 NANDs with the chapter's 6-bit library multiplier (342 NANDs), plus the second table, and the receiver needs the same mixing, a recovered carrier and an equalizer, which is why QAM waited for cheap digital signal processing.`,
    example: {
      title: 'How many points a 35 dB line holds',
      body: `<pre>symbol error 10⁻⁶ needs E_s/N_0 of
  QPSK   13.8 dB     16-QAM  20.9 dB     64-QAM  27.2 dB
  256-QAM 33.3 dB    1024-QAM 39.3 dB
35 dB line: the largest that clears the bar is 256-QAM, 8 bits a symbol
V.34's 3429 baud × 8 bits = 27.4 kb/s uncoded</pre>V.34's 33.6 kb/s came from the other 1.8 bits a symbol, which uncoded QAM cannot hold at this SNR: trellis coding and shaping spend a bit of redundancy to get the coded points further apart. Uncoded 256-QAM at 10<sup>−6</sup> sits 9.2 dB above Shannon's floor.`,
    },
    mistakes: [
      'Reading the SNR in a QAM table as signal-to-noise power over the whole band: the abscissa is E<sub>s</sub>/N<sub>0</sub>, symbol energy over noise density, and bit-level comparisons need E<sub>b</sub> = E<sub>s</sub> / bits per symbol.',
      'Choosing the constellation by the bit rate wanted: the SNR chooses it. The rate follows from how many points the noise leaves distinct, times a baud rate the band allows.',
      'Forgetting the carrier: a coherent receiver must recover the phase, and a constellation turned by an unknown angle decodes as noise (V.22 sent the change of phase, DPSK, to avoid an absolute reference).',
    ],
    chapters: [
      { chapter: 'modem', step: 4, label: 'Phase and amplitude' },
      { chapter: 'modem', step: 5, label: 'Noise decides how many points' },
      { chapter: 'modem', step: 6, label: '300 b/s to 56 kb/s' },
    ],
  },
  ofdm: {
    idea: `Over the megahertz it can pass, a copper pair is far from flat, and one fast carrier meets all of it. The alternative is many slow carriers, each narrow enough to see a nearly flat channel. Choose the tones to fit a whole number of cycles in a block of N samples and any two have zero overlap over the block: Σ e<sup>j2π(k−m)n/N</sup> = 0 unless k = m. They are <b>orthogonal</b> though their spectra overlap heavily, so a tone is read by correlating with it and no guard band is spent. Correlating with every tone is the discrete Fourier transform, X[k] = Σ x[n] e<sup>−j2πkn/N</sup>, and summing every tone with its QAM point as amplitude is its inverse. The modem is two transforms and no oscillators.<br><br>The definition costs N² complex multiplications. The <b>FFT</b> splits a transform of N into two of N/2 on the even and odd samples, joined by one multiplication per pair (a butterfly), and recursion leaves N/2 · log<sub>2</sub> N. What it buys is the whole equalizer: a channel is a convolution and the transform turns <i>circular</i> convolution into one multiplication per tone, Y[k] = H[k] X[k]. A real channel convolves linearly, so the sender copies the block's last samples in front of it, the <b>cyclic prefix</b>; if the prefix is at least as long as the echo, the receiver cuts it off and what remains is exactly circular, and each tone needs one complex division. ADSL gives every tone the bits its own SNR allows: b<sub>k</sub> = ⌊log<sub>2</sub>(1 + SNR<sub>k</sub> / Γ)⌋, from 0 to at most 15, where Γ is the gap to Shannon (10.0 dB uncoded at 10<sup>−7</sup>).`,
    example: {
      title: 'ADSL\'s numbers',
      body: `<pre>512-point transform:  N² = 262 144 complex multiplications
                       FFT: N/2 · log2 N = 256 · 9 = 2 304   (114 × fewer)
256 tones × 4 312.5 Hz = 1.104 MHz
512 × 4 312.5 Hz = 2.208 MHz of samples; prefix 32: 2.208 MHz / 544 = 4 058.8 blocks/s
one sync block in 69 brings it to the 4 000 symbols/s the standard quotes
echo of 5 samples: error vector 19.2 % with no prefix, none with a prefix of 5</pre>Loaded by the chapter's illustrative loop: 3 km at −120 dBm/Hz gives 1682 bits a symbol, 6.73 Mb/s; 5 km gives 370 bits and 1.48 Mb/s. That is a negotiated rate, not a standard one.`,
    },
    mistakes: [
      'Making the cyclic prefix shorter than the channel\'s echo: the block is then not circular, tones leak into each other and no per-tone division can remove it.',
      'Counting only the prefix as the overhead: the prefix (32 of 544 samples) and the sync block both lower the symbol rate, and the standard\'s 4 000 symbols/s already includes both.',
      'Loading every tone with the same constellation: the SNR varies steeply across a copper pair, and a tone loaded above its SNR carries errors, not bits.',
    ],
    chapters: [
      { chapter: 'modem', step: 7, label: 'Many tones, one FFT' },
      { chapter: 'modem', step: 8, label: 'ADSL: many carriers' },
    ],
  },
  linecode: {
    idea: `Two chips sharing a clock wire need no recovery. A serial link sends the clock in the data, so the receiver watches the transitions and its sampler must fire near the middle of every bit: the stream has to keep supplying edges, and its average level has to stay in the middle, which an AC-coupled receiver or a transformer needs. A line code fixes both. <b>Manchester</b> makes every bit two half-bits with a transition between (one XNOR of the bit and the half-bit clock, 5 NANDs): runs of at most 2 and an exact mean, for 100 % of the bandwidth.<br><br><b>8b/10b</b> (Widmer and Franaszek, IBM, 1983) spends 25 %. Each byte HGF EDCBA becomes ten bits: the low five bits take a 6-bit block, the high three a 4-bit block, each chosen at the current <b>running disparity</b> (RD, one bit of encoder state). Codes are balanced (five ones) or unbalanced by two; an unbalanced code with an excess of ones is sent only at RD−, and flips it, so the count of ones minus zeros stays within ±1 at every code boundary forever, and no run exceeds five equal bits. 141 of the 268 symbols (256 data and 12 control) are balanced and the same at both disparities. The control code K28.5 (0011111010 after RD−) holds the <b>comma</b>, seven bits that appear nowhere else in a legal stream, so a receiver that sees it knows where a word starts. Of the 1024 ten-bit patterns, 464 are codes and 560 are neither; a decoder reports a <i>code error</i> or a <i>disparity error</i>.<br><br><b>64b/66b</b> spends 3.1 %: a 2-bit header (01 or 10, a transition every 66 bits, which the clock recovery and block alignment lean on) and 64 scrambled bits. A multiplicative scrambler 1 + x<sup>39</sup> + x<sup>58</sup> XORs each bit with earlier bits of the stream itself, so the output looks random on average; it guarantees nothing, and the descrambler is the same two XORs on the received bits, self-synchronizing after 58 bits. The price is error multiplication: one wrong line bit is three wrong output bits.`,
    example: {
      title: 'What each code spends',
      body: `<pre>Manchester   1 bit → 2 half-bits                100 % overhead
8b/10b       8 bits → 10, 1 Gb/s = 1.25 Gbaud     25 %
64b/66b      64 bits → 66, 10 Gb/s = 10.3125 Gbaud  3.1 %
8b/10b gates (table form): encoder 1195 NANDs, decoder 1795
1 + x⁶ + x⁷ scrambler: 7 flip-flops and 2 XORs = 113 NANDs per end</pre>The 8b/10b tables are checked against Xilinx UG196 on all 268 symbols at both disparities.`,
    },
    mistakes: [
      'Calling a scrambler a line code: it removes long runs on average only. A payload equal to the scrambler\'s own output comes out as zeros, and an all-zero payload into an empty register stays zero; the unscrambled header exists partly for that reason.',
      'Sending K28.7 before certain codes: it can form a false comma with the code after it, so word alignment breaks.',
      'Expecting 8b/10b to be free: the line runs 25 % faster than the data (1 Gb/s is 1.25 Gbaud), so the channel and the receiver must handle 1.25 Gbaud.',
    ],
    lib: 'enc8b10b',
    compare: ['dec8b10b', 'manch_enc'],
    chapters: [
      { chapter: 'serial', step: 0, label: 'No clock on the wire' },
      { chapter: 'serial', step: 1, label: '8b/10b and running disparity' },
      { chapter: 'serial', step: 2, label: 'Scrambling instead' },
    ],
  },
  cdr: {
    idea: `A receiver given only the line must find where each bit is. The receiver here samples the line every cycle, four times a bit, and keeps the last five samples x<sub>0</sub> (newest) … x<sub>4</sub>. At every strobe it takes the data sample d = x<sub>0</sub>, the previous one p = x<sub>4</sub> one bit earlier, and an edge sample e = x<sub>2</sub> halfway between. If d and p differ there was a transition between them and e says where: e still equal to p means it came after e, so the strobe fired <b>early</b>; e already equal to d means it came before, <b>late</b>. This is an Alexander (bang-bang) phase detector (J. D. H. Alexander, 1975): it says which way and not how far, and nothing when d = p. Each vote moves a counter by ±1; at ±4 the strobe counter is reloaded once with a 5- or 3-cycle period (the strobe falls back one sample or gains one) and the counter clears.<br><br>How far it follows: a sender off by a fraction δ drifts 4δ samples every bit; the loop slips a sample for every 4 votes in the same direction and a vote needs an edge, so with a fraction ρ of bit periods carrying one it slips ρ/4 samples a bit. It keeps up while 4δ ≤ ρ/4, so δ<sub>max</sub> = ρ / 16. The line code is what guarantees ρ: 8b/10b has an edge in every five bits, ρ ≥ 0.2, a floor of 1.25 %. A real link is specified to ±100 ppm (0.01 %) and a real loop steps a 1/32 bit or finer; this one steps a quarter bit, so it tolerates orders of magnitude more and hunts by a quarter bit in steady state.`,
    example: {
      title: 'The ceiling ρ/16, and what the golden model measures',
      body: `<pre>pattern                       edges ρ   ceiling ρ/16   measured
commas and random bytes         59 %       3.7 %         ±2.0 %
D21.5 between commas            93 %       5.8 %         ±2.2 %
D30.3 between commas            33 %       2.0 %         ±2.0 %
K28.5 only                      50 %       3.1 %         ±3.0 %
guaranteed floor (ρ = 0.2)                 1.25 %</pre>Sparse, regular patterns reach the ceiling; a dense one gets noisy votes (the sender's own edges move by a sample) and falls short. The detector with its five samples is 487 NANDs.`,
    },
    mistakes: [
      'Assuming a clock-recovery loop can follow any stream: with no transitions it has no votes. A line code is what makes the loop\'s bound a guarantee.',
      'Using a bang-bang detector\'s output as a measure of the error: it only says early or late, so the loop dithers by a step around lock and the steady-state jitter is set by the step size.',
      'Quoting the loop\'s tolerance as the link\'s: the ±100 ppm of a real link is the crystals\' accuracy, and the loop\'s range is a separate, much larger number.',
    ],
    lib: 'cdr',
    chapters: [
      { chapter: 'serial', step: 3, label: 'A SerDes in gates' },
      { chapter: 'serial', step: 4, label: 'Finding the clock in the data' },
    ],
  },
  eye: {
    idea: `Between the sender's driver and the receiver's slicer the channel is not a wire: here it is a single pole at B = 1 GHz (the model of the chapter on lines). A bit at the far end is a rounded pulse whose tail runs into the next bits. Fold a long random pattern on itself one bit period at a time and the traces form an <b>eye</b>; the slicer samples in the gap that is left. The opening is the margin against noise, the width the margin against the sampling instant, and when the tails of earlier bits fill the gap there is <b>intersymbol interference</b> (ISI).<br><br>For one pole the numbers are closed forms. Each bit period the pole retains a = e<sup>−2π·B/R</sup> of the last level at bit rate R. At the end of the bit the sampled value is (1 − a) times the new bit plus a geometric tail of the earlier ones; the worst-case ISI is the sum of the tail, a; the opening is 2(1 − 2a) of the ±1 swing. It closes at a = ½, that is at R = 2π · B / ln 2 = 9.06 B, 9.1 Gb/s for 1 GHz, with Nyquist at 4.5 GHz. With Gaussian noise of rms σ at the slicer a bit is wrong when the noise exceeds half the opening, BER = Q(opening / 2σ); 10<sup>−12</sup> needs half the opening to be 7.03 σ. The pattern 1010 is the fastest square wave the data can make, with its fundamental at R/2, the Nyquist frequency; a long run reaches down to DC.`,
    example: {
      title: 'One pole, two rates (σ = 40 mV)',
      body: `<pre>R = 6 Gb/s:  a = e^(−2π/6) = 0.351   opening 1 − 2a = 30 %   BER 4 × 10⁻¹⁴
R = 8 Gb/s:  a = e^(−2π/8) = 0.456   opening 1 − 2a =  9 %   BER 1 × 10⁻²
closes at a = ½:  R = 2π · 1 GHz / ln 2 = 9.06 Gb/s</pre>The BER falls apart long before the pole: 6 to 8 Gb/s takes it from 10<sup>−14</sup> to 10<sup>−2</sup>: two bits in a hundred wrong.`,
    },
    mistakes: [
      'Reading the opening at the centre of a picture of the eye rather than at the sampling instant: the BER is set where the slicer samples, so a clock-recovery loop that sits off centre trades width for height.',
      'Looking at a pattern that is too short: a long run produces the full tail (a down to DC) that a 1010 does not; eyes are built on pseudo-random sequences for that reason.',
      'Treating noise and ISI as the same budget: ISI is deterministic and known, so it can be cancelled (equalization), while σ cannot.',
    ],
    chapters: [
      { chapter: 'signals', step: 0, label: 'A wave is a sum of sines' },
      { chapter: 'serial', step: 5, label: 'The eye diagram' },
    ],
  },
  equalization: {
    idea: `The eye is closed by ISI, and ISI is a known, linear thing: the tail of bits already sent. It can be cancelled in three places, at 8 Gb/s on the 1 GHz channel where a = 0.456 and the eye is 9 % open (BER 1 × 10<sup>−2</sup> at σ = 40 mV).<br><br><b>Transmit de-emphasis (FFE)</b> sends the first bit after a transition at full swing and the bits that repeat it at (1 − d) of it: a two-tap filter (1 − d/2, −d/2) on the data, one flip-flop for the previous bit and a driver with two strengths. It cuts the low-frequency content the channel passes best, adds no noise, costs swing (power), and cannot see the channel it is meant to match: at d = 30 % the opening is 23 %. <b>CTLE</b>, a continuous-time linear equalizer at the receiver, puts a zero on the channel's pole and its own pole higher: the pair is one pole at the higher bandwidth. At twice the pole the opening is 58 %, but it amplifies whatever came with the signal: its gain at Nyquist is 1.84 here, so σ at the slicer is 74 mV. <b>DFE</b>, the decision-feedback equalizer, does not filter the signal: it subtracts the tail of the bits it has already decided, h<sub>1</sub> times the last decision, from the sample before slicing. It takes nothing from the noise, so the first post-cursor is gone for free: opening 2(1 − a − a²), 34 %. The price is timing (the decision must travel through the subtract and slicer and be back in one bit, 125 ps here) and error propagation (one wrong decision subtracts the wrong tail).<br><br>The other way out is to need less equalizing: PAM4 halves the symbol rate (Nyquist falls by half) at the cost of 9.54 dB of margin, since the same swing is split into three eyes.`,
    example: {
      title: 'The same channel, four ways (8 Gb/s, 1 GHz pole)',
      body: `<pre>                       eye opening   BER
none                         9 %    1 × 10⁻²
FFE, d = 30 %               23 %    9 × 10⁻⁹
CTLE at 2× the pole         58 %    1 × 10⁻¹⁵   (σ 74 mV at the slicer)
DFE                         34 %    2 × 10⁻¹⁷   (noise unchanged, 40 mV)</pre>The DFE opens the eye less than the CTLE yet gives the better BER because the CTLE amplifies noise by 1.84×.`,
    },
    mistakes: [
      'Ranking equalizers by eye opening alone: a CTLE\'s opening is bigger and its BER can still be worse, because it amplifies the noise with the signal.',
      'Putting a DFE in front of a closed eye: its decisions are wrong and the subtracted tail makes the next ones more likely wrong (error propagation); the widget assumes right decisions.',
      'Equalizing to flat at any cost: all three trade something (swing, noise, timing), and past a point the channel needs less loss (shorter reach, fibre) rather than a stronger equalizer.',
    ],
    chapters: [
      { chapter: 'serial', step: 6, label: 'Equalization' },
      { chapter: 'serial', step: 5, label: 'The eye diagram' },
      { chapter: 'serial', step: 7, label: 'PAM4' },
    ],
  },
  crc: {
    idea: `Parity is one check bit for a whole word; a cyclic redundancy check is thirty-two chosen so that bursts cannot hide. Read the message as a polynomial over GF(2), bit i the coefficient of x<sup>i</sup>, and divide it by a fixed generator of degree 32; subtraction is XOR and there are no borrows, so the division is a handful of XORs of the divisor under the dividend. The remainder is the CRC. Appended to the message it makes the whole word a multiple of the generator, so the receiver divides again and accepts only a zero remainder (or, as the register does it, a fixed one). The generator of Ethernet, zlib, PNG and gzip is 0x04C11DB7 without its leading term, and 0xEDB88320 written the other way round, which is the form the shift register uses. The convention adds two details: the register starts at all ones and the result is complemented, so extra leading zeros change the CRC and an all-zero frame does not have CRC zero.<br><br>What the arithmetic guarantees follows from divisibility. An error pattern E goes unnoticed only if the generator G divides E. A single flipped bit is x<sup>i</sup>, which G does not divide; a burst from bit i to bit j is x<sup>i</sup> times a polynomial of degree j − i with constant term 1, and G (degree 32, constant term 1) cannot divide anything of lower degree: every burst of 32 bits or fewer is caught. Any other pattern is a multiple of G with probability 2<sup>−32</sup> = 2.3 × 10<sup>−10</sup>. It does not promise odd-weight detection: G has 15 terms, an odd number, so x + 1 does not divide it.<br><br>In gates the division is a shift register with feedback: the bit that leaves, XOR the data bit arriving, is the feedback f, XORed into the bit shifted in wherever the generator has a 1 (14 XORs for the 14 ones). The next-state block is 56 NANDs, 6 levels; the register (32 flip-flops with an enable) is the bulk of the 795 NANDs in all. A link faster than the clock needs a byte at a time: eight serial steps are one XOR network (880 NANDs written out, 288 after factoring the most common pair, repeatedly, at the same 12 levels), and the byte-wide unit is 1,027 NANDs.`,
    example: {
      title: 'Check value, and what a frame risks',
      body: `<pre>CRC-32("123456789") = 0xCBF43926
bit-serial unit        795 NANDs, 16 delays → 0.40 ns, 2.50 GHz  =  2.5 Gb/s
byte-wide unit       1 027 NANDs, 22 delays →         1.82 GHz  = 14.5 Gb/s (5.8×)
1500-byte frame, 12 032 bits, 63 Mb/s: 5 260 frames/s
if every frame were garbage, one passes every 2³² / 5260 s = 9.5 days</pre>Real garbage is rarer than that: a stuck driver, a truncated or mis-addressed frame is what the 2<sup>−32</sup> figure is for. For random single-bit errors at 10<sup>−6</sup>, 1.2 % of those frames arrive damaged and the check misses essentially none.`,
    },
    mistakes: [
      'Leaving out the all-ones start and the final complement: without them a message with extra leading zeros has the same CRC, and an all-zero frame has CRC zero.',
      'Using a CRC as the only barrier on a path where frames can be mis-delivered whole: a CRC covers corruption of the bits it covers, so addresses and lengths belong inside it.',
      'Feeding the bits in the wrong order: Ethernet\'s CRC takes each byte least significant bit first, which is why the reflected form of the polynomial is the one the register uses.',
    ],
    lib: 'nextcrc32_EDB88320_1s',
    compare: ['unitcrc32_EDB88320_1s'],
    chapters: [
      { chapter: 'errors', step: 2, label: 'A remainder as a check' },
      { chapter: 'errors', step: 3, label: 'How good is a check?' },
      { chapter: 'errors', step: 4, label: 'CRC in gates, a bit a clock' },
      { chapter: 'errors', step: 5, label: 'A byte at a time' },
    ],
  },
  arq: {
    idea: `A check that fails is only useful if something follows. The oldest scheme is <b>automatic repeat request</b>: the receiver acknowledges frames it accepts, the sender keeps a timer, and a frame not acknowledged in time is sent again. A corrupted frame is simply dropped, so the check turns a bit error into a lost frame and the timeout repairs it. The schemes differ in how many frames may be out at once. Let a be the one-way delay in frame times; the round trip is 1 + 2a slots and a loss rate p repeats each frame 1/(1 − p) times on average.<br><br><b>Stop-and-wait</b> sends one frame and waits: (1 − p) / (1 + 2a) frames a slot. A <b>window</b> of W frames in flight fills the pipe when W reaches the round trip (the bandwidth-delay product in frames plus the one being sent); below that, utilization is W / (1 + 2a). <b>Go-back-N</b> acknowledges cumulatively with one timer: when the oldest frame times out it goes back and resends it and everything after it, and the receiver discards what arrives out of order (it keeps one counter). With W ≥ 1 + 2a it carries (1 − p) / (1 + 2ap), exact in this model: each loss costs a whole round trip of slots. <b>Selective repeat</b> resends only the frame that timed out and buffers the rest, which costs a buffer per window slot and a sequence space of at least twice the window. Its ideal is 1 − p, but a lost frame is resent a timeout late and acknowledged a round trip after, and the window cannot slide past it meanwhile, so it takes about three round trips of window to reach 1 − p.`,
    example: {
      title: '1500-byte frames at 63 Mb/s across 10 ms',
      body: `<pre>a = 10 ms / 190 µs per frame = 52.7        round trip 1 + 2a = 106 slots
stop-and-wait, p = 1 %:  0.99 / (1 + 105.4) = 0.93 %   (the line is idle 99 % of the time)
window to fill the pipe:  107 frames
go-back-N,   p = 1 %:  0.99 / (1 + 2 · 52.7 · 0.01) = 48.2 %
selective repeat, ideal: 1 − p = 99 %</pre>`,
    },
    mistakes: [
      'Sizing the window by bandwidth alone: it has to cover the round trip, and a long fat path needs about a hundred frames in flight to run at all.',
      'Choosing a sequence space equal to the window in selective repeat: a retransmission is then indistinguishable from the next window\'s frame; the space must be at least twice the window.',
      'Assuming go-back-N is wasteful only on loss: it is exact at W ≥ 1 + 2a, but a loss costs a full round trip of slots, so at high loss selective repeat or FEC wins.',
    ],
    chapters: [
      { chapter: 'errors', step: 7, label: 'Asking again' },
      { chapter: 'errors', step: 8, label: 'Correcting instead of asking' },
    ],
  },
  viterbi: {
    idea: `Block codes cut the stream into words and treat each alone. A convolutional code does not cut it: every data bit makes two channel bits, each the parity of that bit and the last K − 1 bits, so the redundancy is spread along the stream and there are no word boundaries for an error to fall across. The encoder is a shift register of K − 1 flip-flops and one XOR tree per generator, a state machine with 2<sup>K−1</sup> states: 42 NANDs for K = 3 (octal 7 and 5), 122 for K = 7 (133 and 171 octal, NASA's deep-space code and 802.11's). Its strength is a property of paths: the <b>free distance</b>, the fewest channel bits in which two paths that split and rejoin can differ, is 5 for K = 3 (a single 1 followed by zeros writes 11 10 11) and 10 for K = 7.<br><br>The best decoder picks the sent stream closest to what arrived, and there are 2<sup>L</sup> streams of L bits. <b>Viterbi's</b> observation: two streams in the same state at the same moment have the same future, so only the cheaper can win; keep one path per state and extend every state once per symbol. The work per bit is constant and the stream can be any length. Each state holds an add-compare-select (two adders, a subtractor, a multiplexer), a path metric and a <b>survivor</b>. In hardware the metrics are never normalized, they wrap at 4 bits (5 for K = 7), and the comparison is the top bit of a subtraction, correct because no two compared metrics ever differ by half the range. All the price is in the decoder: one state is 1,579 NANDs of which the ACS is 160, because survivors are nearly everything; real decoders store the selects in RAM and trace back.<br><br><b>Soft decisions</b> are the cheapest gain in communications. The slicer throws away how sure it was; keep three bits of that and the branch metric becomes a distance in voltage, not a count of differing bits.`,
    example: {
      title: 'What the decoder costs, and what it gains',
      body: `<pre>encoder K = 3 42 NANDs        K = 7 122 NANDs
decoder K = 3, hard    3 118 NANDs        K = 7 (64 states, 70-bit survivors)  101 094 NANDs
K = 7 with 3-bit soft levels  110 578 NANDs (+9 %), about 2.4 dB less signal needed
at 10⁻⁵, uncoded BPSK needs 9.59 dB E_b/N_0; K = 7 gains 3.1 dB hard, 5.4 dB soft, at rate ½</pre>5.4 dB is a link that needs about a third of the transmit power or reaches 1.9 times as far in free space. K = 7 soft at 10<sup>−5</sup> still sits 4.0 dB above Shannon's rate-½ limit.`,
    },
    mistakes: [
      'Reading the decoder from a fixed state with a short traceback: that needs about ten constraint lengths before more depth stops helping (at five, K = 7 is over five times worse at 4 dB); reading from the best state needs about five at the cost of comparing all 64 metrics.',
      'Comparing a rate-½ code to an uncoded link at the same E<sub>s</sub>/N<sub>0</sub>: each channel bit carries half the energy per data bit, so the code starts 3 dB behind; plot against E<sub>b</sub>/N<sub>0</sub>.',
      'Using the code on a bursty channel: a Viterbi decoder fails badly when errors arrive together, whatever the average rate; interleave in front of it.',
    ],
    chapters: [
      { chapter: 'errors', step: 9, label: 'A code with memory' },
      { chapter: 'errors', step: 10, label: 'The Viterbi decoder' },
      { chapter: 'errors', step: 13, label: 'How far from Shannon' },
    ],
  },
  reedsolomon: {
    idea: `Reed–Solomon codes treat bytes as the symbols. A byte is an element of GF(256): adding is XOR and multiplying is polynomial multiplication reduced by x<sup>8</sup> + x<sup>4</sup> + x<sup>3</sup> + x<sup>2</sup> + 1. The code words are the multiples of a generator with roots α<sup>0</sup> … α<sup>2t−1</sup>, and 2t check bytes correct any t wrong bytes. Nothing can do better: t errors must not reach half way between two code words, and this is the maximum distance a code of that size can have. A byte wrong in all eight bits costs what a byte wrong in one bit does, so a burst of up to 121 bits is at most 16 bytes, within RS(255, 223)'s t = 16.<br><br>The encoder is the CRC's circuit with bytes for bits: polynomial division by a shift register, here 10 byte stages, each with a constant multiplier. A constant multiplier has no multiplier in it: multiplying by a fixed element is linear over GF(2), so each output bit is an XOR of input bits. The feedback is the data byte plus the top register while the message goes in; then it is zero and the output shifts the check bytes out. The receiver's first step is as cheap, one byte a clock evaluating the word at each root (a code word leaves all of them at zero). Correcting is where the cost is: Berlekamp–Massey finds the polynomial whose roots mark the wrong positions from the syndromes, Chien's search tries every position, Forney's formula gives each error's value, each with general multiplications (416 NANDs apiece against a few dozen for a constant); the chapter's decoder is a model, not gates. Past t the decoder either says so or lands on a different code word, which is why a CRC stays above it. This is the family in CDs, QR codes, DVB and, as RS(544, 514) over a ten-bit field, 400 Gb/s Ethernet.`,
    example: {
      title: 'RS(255, 223): bytes, bursts, gates',
      body: `<pre>255 − 223 = 32 check bytes → t = 16 wrong bytes
burst of 121 bits: 1 + 15 · 8 bits touches at most 16 bytes → corrected
encoder  10 check bytes   2 356 NANDs        32 check bytes   7 452 NANDs
syndromes, 10 roots       2 366 NANDs        general GF(256) multiplier  416 NANDs
RS coding gain at 10⁻⁵ (hard decisions) 3.4 dB</pre>The encoder's output on the published QR example message equals the published check bytes.`,
    },
    mistakes: [
      'Counting corrected errors in bits: t counts bytes, so a burst of eight adjacent bit errors is one error and eight scattered single-bit errors in eight bytes are eight.',
      'Trusting an RS decoder\'s output past t errors: it may report failure or land on another code word that looks valid; an outer CRC catches that.',
      'Expecting the decoder to be as small as the encoder: encoding and the syndromes need only constant multipliers (XOR networks), correcting needs general GF(256) multipliers, 416 NANDs each, and a fast decoder has dozens working at once.',
    ],
    chapters: [
      { chapter: 'errors', step: 11, label: 'Reed-Solomon: errors in bytes' },
      { chapter: 'errors', step: 12, label: 'Bursts: interleaving' },
      { chapter: 'errors', step: 13, label: 'How far from Shannon' },
    ],
  },
  interleave: {
    idea: `Real channels do not flip bits one at a time. A scratch, a fade or a lightning strike takes out a run, and the codes of this chapter, Viterbi's most of all, fail badly when errors arrive together whatever their average rate. <b>Interleaving</b> changes the errors instead of the code: write D words as rows and send the columns. A burst of b channel bits now puts at most ⌈b / D⌉ errors in any word, so a code correcting t per word survives any burst up to D · t. It adds no redundancy, so the rate does not change, and it costs two things: a buffer of D words at each end, and D words of delay, since nothing can be read until the block is full. That delay is why a voice call interleaves less than a broadcast.<br><br>The two kinds of code combine well. The deep-space standard runs K = 7 inside and RS(255, 223) outside: Viterbi turns a noisy channel into a nearly clean one whose rare errors come in bursts, an interleaver spreads those bursts, and Reed–Solomon cleans up what remains.`,
    example: {
      title: 'How long a burst survives',
      body: `<pre>32 SEC-DED(72, 64) words, t = 1 bit a word:  burst of up to 32 × 1 = 32 bits
8 RS(255, 223) words, t = 16 bytes a word:      up to 8 × 16 = 128 bytes,
                                                 1017 bits however it falls on byte edges
depth 1: a burst of 6 costs a word;  raise the depth until it costs none</pre>`,
    },
    mistakes: [
      'Interleaving without a code behind it: spreading a burst helps only if each word can absorb its share.',
      'Choosing the depth by the longest burst alone: the delay and buffer grow with D, and a latency-bound link (a voice call) pays for them on every word.',
      'Confusing it with DRAM bank interleaving: that spreads consecutive addresses over banks for parallelism; this spreads consecutive channel bits over code words to shorten a burst.',
    ],
    chapters: [
      { chapter: 'errors', step: 12, label: 'Bursts: interleaving' },
    ],
  },
};
