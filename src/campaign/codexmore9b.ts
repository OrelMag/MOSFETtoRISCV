// The fuller codex for the Signal processing level: measuring a spectrum, FIR design (codexdspb.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE9B: Record<string, CodexMore> = {
  leakage: {
    idea: `Looking at a signal through a block of N samples is multiplying it by a rectangle, and a product in time is a convolution in frequency: every line of the true spectrum is replaced by the rectangle's own transform, a main lobe two bins wide with sidelobes that fall 6 dB for each doubling of distance. The transform computes that curve only at the bins. A tone that holds a whole number of cycles in the block puts every other bin on a zero of the curve, so it looks like a single clean line; any other tone sits between bins and the same curve is sampled at points that are not zeros.<br><br>So the skirt is not noise and not an error of the tone: it is what a cut-off sinusoid is. The consequences are practical. A peak read straight off a bin can be several dB low, a weak tone near a strong one can hide under the strong one's skirt, and a real cosine adds the skirt of its mirror image at negative frequency, which is why a measured skirt levels off near −30 dB instead of falling on. The cures are a window, which lowers the skirt, or a block that holds whole cycles, which is only possible when you control the clock.`,
    example: {
      title: 'One tone, three positions in a 64-sample block',
      body: `<pre>rectangular window, tone of amplitude 1
10 cycles    bin 10 reads 1; 1 bin above −60 dB
10.5 cycles  largest bin 0.646 (−3.8 dB low); 33 bins above −60 dB
12.5 cycles  bins 12 and 13 read 0.642 each
skirt 16.5 bins from a tone alone  −34.3 dB
the same 16 bins past 10.5, real cosine  −29.6 dB (the mirror image adds its skirt)</pre>The amplitudes are scaled so that a tone on a bin reads its true amplitude whatever the window; between bins the reading is lower by the lobe's shape, which is the scalloping loss.`,
    },
    mistakes: [
      'Treating the skirt as measurement noise and averaging it away. It is deterministic, identical on every block of the same tone, and averaging more blocks does not lower it.',
      'Reading a tone\'s amplitude from the largest bin. A tone half a bin off a centre reads about 3.9 dB low under the rectangle (3.8 for a real cosine, whose mirror image adds a little); only a window with a flat lobe, or interpolation, recovers it.',
      'Expecting a clean line because the tone is "pure". Cleanliness needs a whole number of cycles in the block, 10 yes and 10.5 no, and a real source is not locked to your sample clock.',
      'Calling a tone buried under another\'s skirt absent. It may be 40 dB down and still be there; the window decides whether you can see it.',
    ],
    chapters: [{ chapter: 'spectrum', step: 0, label: 'A tone that is not a line' }, { chapter: 'spectrum', step: 2, label: 'What the skirt hides' }],
  },
  windowfn: {
    idea: `A window multiplies the block by a taper that falls to zero at the edges, so the cut is gentle and the skirt falls faster. The price is paid in the main lobe: tapering throws away samples near the ends, the block counts as shorter, and the lobe gets wider. The cosine-family windows are sums of shifted copies of the rectangle's transform whose sidelobes cancel, and that cancellation is the whole trade: the lobe widens by two bins (one each side) for each term added.<br><br>Three figures decide a window when you measure. The highest sidelobe says how weak a tone can be beside a strong one and still show. The main lobe says how close two tones can be and still resolve. The noise bandwidth, the width of the rectangle that would pass the same white noise, says how much the noise floor rises, and the loss for a tone half a bin off a centre says how far a peak can read low. The spectra can be scaled by half the window's sum so that a tone on a bin reads its true amplitude whatever the window. There is no best window, only a choice of what you expect to find; Kaiser's has a knob, β, that moves along the same trade.`,
    example: {
      title: 'Four windows, same trade',
      body: `<pre>window           lobe  sidelobe   noise bw  half-bin loss  skirt, 10 bins
rectangle         2    −13.3 dB   1.00      3.92 dB        −29.2 dB
Hann              4    −31.5      1.50      1.42           −68.5
Blackman          6    −58.1      1.73      1.10           −76.5
Blackman–Harris   8    −92.0      2.00      0.83           −96.6</pre>lobe in bins, null to null; resolving two equal tones takes 1.55, 2.45, 2.8 and 3.25 bins. Hann's noise floor reads 10 log<sub>10</sub> 1.5 = 1.8 dB above the rectangle's for the same noise. A tone 40 dB below another and 10 bins away hides under the rectangle's skirt and shows under Hann's.`,
    },
    mistakes: [
      'Choosing the window with the lowest sidelobes by default. Blackman–Harris needs about 3.3 bins between equal tones (its lobe is 8 bins wide, null to null); two close tones merge into one lump.',
      'Comparing noise floors across windows as if the bins were equal. A Hann spectrum of the same noise reads 1.8 dB higher than the rectangle\'s, because each bin is 1.5 bins wide.',
      'Using the symmetric form for analysis. Blocks that follow one another want the periodic form, which repeats without a seam; the symmetric form is for filter taps.',
      'Forgetting that a window changes amplitude. Without dividing by half its sum a tone on a bin reads 0.5 under Hann.',
    ],
    chapters: [{ chapter: 'spectrum', step: 1, label: 'A window is a choice of skirt' }, { chapter: 'spectrum', step: 2, label: 'What the skirt hides' }],
  },
  zeropad: {
    idea: `Two limits meet in a spectrum. Resolution asks how close two equal tones can be and still show as two: with a 3 dB dip as the rule, 1.55 bins under the rectangle, 2.45 under Hann, 2.8 under Blackman, for tones in phase. Dynamic range asks how weak a tone can be beside a strong one. The window sets both, in opposite directions, and a bin is fs / N wide, so neither moves without more samples.<br><br>Zero padding appends zeros and takes a longer FFT. The transform of the block is one fixed curve, and the padded FFT reads it at more places: the picture is smooth and the same lump stays one lump. It is worth doing for three reasons, a peak read between the old bins is closer to its true height, an FFT wants a power of two and the picture is easier on the eye, but it must not be read as precision. To tell tones Δf cycles a sample apart you must watch for about 1.55 / Δf samples with a rectangle and 2.45 / Δf with Hann, whatever the padding and, in hertz, whatever the sample rate.`,
    example: {
      title: 'Two tones 0.02 cycles a sample apart',
      body: `<pre>rectangle  1.55 bins  → 1.55 / 0.02 ≈ 77 samples
Hann       2.45 bins  → 2.45 / 0.02 ≈ 122 samples
at 32 samples the gap is 0.64 bin: one lump, however much padding

64 samples at 8 kHz, a bin is 125 Hz; padded to 4096 points the dots are 1.95 Hz apart
Hann needs 2.45 × 125 = 306 Hz between tones, padded or not</pre>The padded dots lie on the same curve as the unpadded ones, with more of them.`,
    },
    mistakes: [
      'Padding to resolve closely spaced tones. The lobe is set by the real samples; the extra points only draw it more smoothly.',
      'Quoting the padded bin spacing as the resolution. The 1.95 Hz of the padded dots is the spacing of the picture, not the 306 Hz the tones must be apart.',
      'Quoting a resolution figure without the phase caveat. The figures are for tones in phase; a quarter turn apart they change, and in opposite phase the tones cancel between them.',
      'Counting the zeros as samples when asking how long to record. Only the real samples set the resolution, the record\'s duration in seconds.',
    ],
    chapters: [{ chapter: 'spectrum', step: 2, label: 'What the skirt hides' }, { chapter: 'spectrum', step: 3, label: 'More points are not more resolution' }],
  },
  spectrogram: {
    idea: `A spectrum of a whole signal says what is in it and not when. A spectrogram cuts the signal into frames, windows each, takes the spectrum of each and stacks them: time across, frequency up, level as colour. Frames overlap because a window is small at its edges, and an event there would be under-weighted. One choice, the frame length N, sets both details: in frequency, Hann's main lobe is 4 bins of fs / N hertz, and in time a frame is N / fs seconds long, so the product of the two is fixed and no choice makes both small.<br><br>A signal that changes during a frame is smeared across it: a chirp that moves 47 bins in one frame of 512 samples is a band 47 bins tall, and the line turns into a staircase. A steady tone does the opposite and wants a long frame. Overlap costs: at a hop of N / 2 every sample is in two frames and the signal costs about twice the transforms, at 7/8 overlap about eight times. A Hann window at 50 % overlap adds back to a constant, which is why that pairing is usual. This is the short-time Fourier transform.`,
    example: {
      title: 'Frame length against what you see, at 8 kHz',
      body: `<pre>frame N   frame lasts   Hann main lobe (4 bins)
32         4 ms          1000 Hz
64         8 ms            500 Hz
512        64 ms          62.5 Hz

2048 samples in frames of 512: 7 frames at hop 256 (50 %), 25 at hop 64 (7/8)
without overlap 4 frames: 1.75× and 6.25× the transforms</pre>The steady tone is a sharp line at 512 and a thick band at 32; the chirp is the other way round.`,
    },
    mistakes: [
      'Chasing both time and frequency detail with one frame. Shortening the frame from 512 to 64 samples makes the lobe eight times wider, 500 Hz instead of 62.5.',
      'Overlapping to gain information. Overlap adds no resolution; it only stops an event near a frame\'s edge being under-weighted, and costs one more transform per hop.',
      'Reading a smeared chirp as a wide signal. If the signal moves by more than a bin during a frame, the band\'s width is the sweep, not the signal\'s bandwidth.',
      'Using a rectangular window for the frames. Its skirt then hides weak components in every column.',
    ],
    chapters: [{ chapter: 'spectrum', step: 4, label: 'Time and frequency at once' }],
  },
  overlapsave: {
    idea: `A long FIR costs one multiplication a tap for every output sample. Convolution in time is a product in frequency, so the signal can go through an FFT, a multiplication by the filter's spectrum and an inverse FFT. The snag is that a signal never ends, so it goes in blocks, and a block of N samples through M taps gives a circular convolution: the tail of the response wraps round to the front, so the last N − M + 1 outputs are right and the first M − 1 are wrong.<br><br>Overlap-save keeps the right ones. Each block repeats the last M − 1 inputs of the block before it, so the wrong outputs fall on samples already finished and are thrown away, and a block yields L = N − M + 1 new samples. The method is exact up to rounding. Counted per output sample, the direct form costs M multiplications and the blocks cost 4 (2 · (N / 2) log<sub>2</sub> N + N) / L; they win from 44 taps, and the more taps the bigger the win. Overlap-add is the dual: blocks without overlap, the tails added in.`,
    example: {
      title: 'What a block gives, and when it pays',
      body: `<pre>M = 128 taps, N = 512 block:   L = 385 new samples, 127 thrown away
M = 128 taps, N = 256 block:   L = 129 new samples
33 taps: best block 256 costs 41.1 multiplications a sample, more than the direct 33
60 taps: best block 512 costs 45.2 against 60
crossover: 44 taps

in gates (sums of parts): 256-point streaming FFT 167 844 NANDs
128 direct 16 × 16 multipliers 457 216; two FFTs and four multipliers 349 976</pre>Blocks win on multiplications and on area here; the parallel direct form wins on throughput, one sample a clock against about half.`,
    },
    mistakes: [
      'Keeping all N outputs of a block. The first M − 1 are circular wrap-around and wrong; the error chip beside the method shows them wrong by a lot and the rest exact.',
      'Counting the block as free. At 33 taps the best block costs 41.1 multiplications a sample against 33 for the direct form; short filters belong in the time domain.',
      'Taking the FFT to be the whole cost. Two transforms are needed, one for the signal and one back, and the overlap buffer is not counted in a sum of parts.',
      'Choosing N close to M. L = N − M + 1 then shrinks and almost every output is discarded; a power of two several times M is the usual choice.',
    ],
    chapters: [{ chapter: 'spectrum', step: 5, label: 'Filtering by blocks' }],
  },
  goertzel: {
    idea: `Sometimes the spectrum is not the question. A keypad tone is one of eight frequencies, and an FFT's 129 bins for 256 samples are mostly thrown away. Goertzel computes one bin: run s[n] = x[n] + c s[n−1] − s[n−2], with c = 2 cos(2πf), over the block, and after N samples the last two values give the power at f as s₁² + s₂² − c s₁ s₂, exactly the DFT's value at that frequency. That is one real multiplication a sample, and a few more at the end. On the plane it is a pole pair on the unit circle, a resonator that never decays: it rings up linearly for a matching tone and stays small for the rest.<br><br>The frequency need not be a bin: c takes any value, so Goertzel can sit between an FFT's bins, though off a centre it leaks as every transform does and the block length is worth choosing. K Goertzels cost K (N + 3) multiplications against about 2 N log<sub>2</sub> N for an FFT, so they are equal near K = 2 log<sub>2</sub> N bins. In gates it is a multiplier, two adders and two registers, and the state needs guard bits: it is the input times the resonator's impulse-response sum, so a word several times wider than the input.`,
    example: {
      title: 'A keypad decoder in one cell',
      body: `<pre>697 Hz at 8 kHz: c = 2 cos(2π · 697 / 8000) = 1.7077
block 205 puts the worst of the eight tones 0.269 bin off a centre
cell: 16 × 16 multiplier 3427 NANDs, whole cell 4419
worst tone's response sums to 252.06; × 128.5 = 32 390 fits 16 bits (max 32 767)
8 tones in turn: 8 × (205 + 1) = 1648 clocks a key; the block lasts 25.6 ms,
so the clock must be at least 64.3 kHz
break-even against an FFT: 16 bins for 256 samples, 12 for 64</pre>Eight cells would decode a key at the sample rate for 35 352 NANDs; a 256-point streaming FFT is 167 844.`,
    },
    mistakes: [
      'Computing an FFT to read eight tones. 129 bins for 8 wanted is 121 thrown away; below 2 log<sub>2</sub> N bins Goertzel is cheaper.',
      'Believing Goertzel only finds frequencies that fall on a bin. Any f works through c; only the leakage depends on whether it is on a centre.',
      'Sizing the state like the input. A resonator on a matching tone keeps adding: 8-bit samples need 16 bits of state here, and a 15-bit word overflows on the worst input.',
      'Treating the power as free. The three or four multiplications at the end are real, and the final power is not computed by the cell in this chapter\'s gates.',
    ],
    chapters: [{ chapter: 'spectrum', step: 6, label: 'One bin, cheaply: Goertzel' }, { chapter: 'spectrum', step: 7, label: 'A keypad in gates' }],
  },
  linearphase: {
    idea: `A filter whose taps are mirror images, h[k] = h[N − 1 − k], delays every frequency by the same (N − 1) / 2 samples: its phase is a straight line in frequency, and a pulse comes out the shape it went in, only later. A filter with another phase delays different frequencies by different amounts, and a pulse spreads. Linear phase is not no delay: a 115-tap filter delays 57 samples, and at 48 kHz that is about 1.2 ms, which may be the deciding problem in a feedback loop.<br><br>On the z-plane each zero comes with its mirror image across the unit circle, r and 1 / r on the real axis or four together at r e<sup>±jθ</sup> and e<sup>±jθ</sup> / r. A pole cannot be paired that way, because its mirror would lie outside the circle and be unstable, so a causal IIR filter cannot be linear phase: the choice is long filters with linear phase or short ones with a phase to live with. The symmetry pays twice. The amplitude is a polynomial in cos 2πf with only ⌈N / 2⌉ coefficients, so a design chooses half as many numbers, and in hardware the mirrored taps share a multiplier, so folding halves the multiplications. An even length has a zero at z = −1 and so can never pass half the sample rate.`,
    example: {
      title: 'Delay and multiplications from the length alone',
      body: `<pre>taps N   delay (N − 1) / 2    free numbers ⌈N / 2⌉   folded multiplications
114        56.5 samples         57                      57
115        57 samples           58                      58
147 (Kaiser's window, odd)  73 samples
64 taps at 8 kHz: 31.5 samples = 3.9 ms, at every frequency</pre>The Parks–McClellan filter of 114 taps and the odd-length 115 are the same mask met two ways; the Kaiser design for it needs 146.`,
    },
    mistakes: [
      'Reading linear phase as zero delay. It is the same delay at every frequency, (N − 1) / 2 samples, and a long filter pays it in latency.',
      'Assuming an even length has an integer delay. 114 taps delay 56.5 samples, because the centre lies between two taps.',
      'Asking for linear phase from an IIR filter. A pole\'s mirror would sit outside the circle; only an FIR (or a non-causal or block-wise filter) can have it exactly.',
      'Using an even-length symmetric filter as a high-pass. It always has a zero at z = −1, so the gain at half the sample rate is zero.',
    ],
    chapters: [
      { chapter: 'signals', step: 3, label: 'A filter is a sum of delayed samples' },
      { chapter: 'zplane', step: 6, label: 'Same gain, different delay' },
      { chapter: 'firdesign', step: 0, label: 'A mask, and mirror-image taps' },
    ],
  },
  windowdesign: {
    idea: `The ideal low-pass has taps sin(2π fc k) / (π k), forever. Cut them to N and you have multiplied by a rectangle: the response is the ideal one smeared by the window's transform, with a transition that narrows as 1 / N and, for the rectangle, a stopband peak that falls only slowly with N. Taper the ends instead and the ripples fall at the price of a wider transition. That is the window method: the window decides how far the stopband falls, and the length decides how narrow the transition is.<br><br>One consequence matters for a mask. The window's sidelobes set the passband ripple and the stopband ceiling together, so both bands come out the same size, and a mask that asks 0.0058 of one and 0.001 of the other is met in the passband five times over. Each fixed window has sidelobes of its own height, so it plateaus before it meets a given ceiling: Hamming sits near −58 dB for a long stretch. Kaiser's window has a knob, β, that trades sidelobe height for transition width directly, and a formula gives β and a length from the ripple and the width. Meeting a mask is not quite monotone in length even for one window, so the length is found by checking each candidate, not by solving.`,
    example: {
      title: 'Meeting 60 dB across a transition of 0.025 cycles a sample',
      body: `<pre>mask: pass to 0.100, stop from 0.125, 0.1 dB ripple (1 ± 0.00576), 60 dB (0.001)
rectangle   −23.6 dB at 101 taps, −41.8 at 1001: falls 6 dB a doubling
Hamming   −16.6, −29.7, −56.9, −58.4 dB at 61, 101, 201, 301 taps
          first −60 dB at 489 taps odd (488 if either parity is allowed)
Hann      269 taps odd (268 if either parity is allowed)
Blackman  201 taps
Kaiser    β = 5.65, 147 taps odd (146 if either parity is allowed)
          passband error 0.0011 against 0.0058 allowed</pre>The odd-length figures matter when the hardware wants a symmetric filter with a middle tap; Parks–McClellan meets the same mask with 114.`,
    },
    mistakes: [
      'Choosing the window by its sidelobes alone. The nearest sidelobes sit inside the mask\'s transition until the filter is long, so a window can plateau a few tenths of a dB short for hundreds of taps.',
      'Expecting a longer filter to lower the ripple. With the same window, twice the taps halves the transition width and the sidelobes keep their height.',
      'Designing both bands to the same tolerance when the mask gives different ones. The window spends passband accuracy nobody asked for; that is what Parks–McClellan recovers.',
      'Trusting the first length that meets the mask. Kaiser\'s design misses it again at some longer lengths, so check the neighbours.',
    ],
    chapters: [{ chapter: 'firdesign', step: 1, label: 'The window method' }, { chapter: 'firdesign', step: 2, label: 'Parks–McClellan' }],
  },
  parksmcclellan: {
    idea: `Instead of a recipe, make filter design an optimisation: choose the taps that minimise the largest weighted error over the bands, with weights 1 / δp and 1 / δs from the mask. A result of 1 or less means both bands fit. The optimum has a striking shape: its error touches the same size at no fewer than ⌈N / 2⌉ + 1 frequencies, with alternating signs, called equiripple. The alternation theorem says that is both necessary and sufficient.<br><br>The Remez exchange finds it. Guess that many frequencies, solve for the cosine polynomial that alternates ± δ exactly there, look at where its error really peaks, move the guesses to the peaks, and repeat; it converges in a handful of passes. Because it weights the bands as the mask does, it spends the slack that a window wastes on a narrower transition, and so meets a mask with fewer taps, each tap being a multiplication on every sample. Below the length that just meets the mask, no weighting makes both bands fit, because the error is already the best that any taps can do. The program is checked against scipy's remez and, for every result, against its mask.`,
    example: {
      title: 'The fewest taps for the mask of 0.1 dB and 60 dB',
      body: `<pre>114 taps  passband error 0.00564 (allowed 0.00576), stopband −60.1 dB   meets it
113 taps  passband error 0.00592, stopband −59.7 dB                     misses both
Remez exchange: 8 passes
Kaiser's window: 146 taps = 32 more, 28 % more multiplications a sample
Kaiser's equiripple length estimate: 109, 5 short of 114
odd lengths only: 115 (Kaiser 147)
rounded to 16-bit words with 17 fraction bits, 114 taps miss by 0.22 dB; 115 meet it</pre>The window is simpler to compute and to explain; the exchange is what you use when taps cost money.`,
    },
    mistakes: [
      'Expecting the equiripple filter to have a lower peak error everywhere. It has the lowest largest weighted error; in the stopband it is not as low far from the edge as a tapered window.',
      'Fixing a missed design by re-weighting. At 113 taps both bands are over by a few per cent, and favouring one makes the other worse.',
      'Skipping the rounding check. The 114-tap design meets the mask in floating point and misses it by 0.22 dB in 16-bit words; the check belongs after rounding.',
      'Using the length formula as the answer. It said 109 for a filter that needs 114; it starts a search and does not end it.',
    ],
    chapters: [{ chapter: 'firdesign', step: 2, label: 'Parks–McClellan' }, { chapter: 'firdesign', step: 3, label: 'Taps are words' }, { chapter: 'firdesign', step: 7, label: 'One mask, four ways to build it' }],
  },
  csd: {
    idea: `When the taps never change, a general multiplier is wasted on them. A constant is a sum of powers of two, a shift is wiring, and each further non-zero digit costs an adder: 13 304 is −2³ + 2¹⁰ − 2¹² + 2¹⁴, four terms and three adders. Allowing negative digits cuts the count, as 8 − 1 does for 7 (three ones in binary, two signed digits). The canonical signed digit form is the signed-digit recoding with no two non-zero digits side by side, and it has the fewest non-zero digits of any signed form; it is also unique.<br><br>The saving is large when many taps are fixed, as in a channel filter in a radio. A subtraction is an inverted copy plus a carry in, and because two's complement addition is modular, an intermediate sum may be out of range as long as the final one fits. The price is flexibility: change a tap and you have rebuilt the multiplier, so it is the wrong trade for anything that adapts. It is the same idea as the Booth recoding of a multiplier, applied once, to a constant, at design time.`,
    example: {
      title: 'The 115-tap filter without a multiplier',
      body: `<pre>13 304 = −2³ + 2¹⁰ − 2¹² + 2¹⁴      4 signed digits, 9 ones in binary, 3 adders
58 distinct taps (the rest are mirrors)
binary: 296 non-zero digits   signed digits: 227   173 adders
(227 − 58 + 4: four taps of negative digits only need one more)
58 constant multipliers: 43 853 NANDs
58 general 16 × 16 multipliers (3572 each): 207 176</pre>The whole folded filter goes from 285 871 to 99 048 NANDs, with no multiplier left; the drop is larger than 207 176 − 43 853 because the folded form's multipliers are 17 × 17, one bit wider for the pre-adder. Every constant from 1 to 4095 recoded this way has no two non-zero digits side by side, and none needs more than 7.`,
    },
    mistakes: [
      'Counting the ones of the binary form as the cost. A run of ones is one subtraction in signed digits: 0111 1111 (127) is 2⁷ − 1.',
      'Forgetting the sign bits in the widths. Each shifted copy is wider, and the sum needs the bits the largest partial result asks for, not the input\'s.',
      'Using shifts for taps that adapt. A changed tap is a different circuit; adaptive filters keep the general multiplier.',
      'Believing the fewest digits is the cheapest hardware in every case. Shared sub-expressions between taps can beat a per-tap recoding, and a tap with one digit is just wiring.',
    ],
    chapters: [{ chapter: 'firdesign', step: 5, label: 'A constant is a few shifts' }],
  },
  transposed: {
    idea: `The direct form delays the input and sums the products at the end, so the adder is a tree or a chain behind the last tap. Reverse every arrow and swap adders and forks, and the same transfer function results: the input reaches all the multipliers at once, and the registers hold partial sums that move toward the output, one adder and one register per tap. Nothing waits behind a long adder chain, so the longest path is one multiplier and one adder, and every product is ready the moment a sample arrives.<br><br>The price is in the registers, which hold sums and not samples, so each is as wide as the accumulator. A linear-phase filter folds in this form differently: x[n] h[k] is the product that two mirrored taps both need, so computing it once is the saving, where the direct form adds the pair before multiplying. None of the three forms changes what the filter does. They move cost between multipliers, adders, registers and the longest path, and which wins depends on the technology; in gates, where a multiplier is the expensive part, folding is the first thing to do to a linear-phase filter.`,
    example: {
      title: '115 taps, 16-bit words, counted from the gates',
      body: `<pre>                                          NANDs     multiplications
direct, all parallel                    473 024     115 (adder tree of 7 levels)
folded: add the pair, then multiply     285 871      58
transposed, mirror taps sharing         300 200      58

accumulator, transposed registers: 2 × 16 + 2 = 34 bits; a sample register 16</pre>Here the wide registers cost more than the folded form's pre-adders save; the transposed form's case is the short path, not the area.`,
    },
    mistakes: [
      'Expecting a different response. The transposed form is exactly the same filter in exact arithmetic; only the cost, the path and the rounding noise differ.',
      'Giving its registers the sample width. They hold partial sums, so they need the accumulator\'s guard bits, 34 bits here rather than 16.',
      'Assuming it is always smaller. At 115 taps it is 300 200 NANDs against 285 871 for the folded direct form; it wins on the longest path, not on area.',
      'Forgetting that the input fans out to every multiplier. Its load, not an adder chain, then sets the speed of a long transposed filter.',
    ],
    chapters: [{ chapter: 'firdesign', step: 4, label: 'Folding, and the transposed form' }],
  },
  multacc: {
    idea: `If the clock is much faster than the sample rate, build one multiplier and use it N times a sample. A ring of N sample registers turns one place each clock, so its head shows x[n], x[n − 1], … one tap after another; a ROM gives the tap for each count with two flags, first and last; one multiplier forms the product; and an accumulator adds each, starting afresh at the first tap. After the last, one rounder and one clamp turn the sum into the output word, which a register holds for the N clocks until the next. In the last cycle only the head loads, so the oldest sample falls out and the ring is in order again, with no write pointer.<br><br>The accumulator is wider than the product by guard bits, and here the taps decide: the output is at most Σ|tap| times the largest input, so the guard bits are the ones Σ|tap| asks for, not the log<sub>2</sub> N that a full-scale worst case would need. The sum is wide, rounded once and clamped once at the end. The cost is time: N clocks a sample, so the sample rate is the clock over N, and a radio's channel filter at millions of samples a second is past what one multiplier can do.`,
    example: {
      title: 'One multiplier against 115 in parallel',
      body: `<pre>115 taps, 16-bit words: 37 057 NANDs, 115 clocks a sample
all parallel:            473 024 NANDs, one sample a clock   (13 times more)
accumulator: 2 × 16 + 2 guard = 34 bits (Σ|tap| = 1.94; log₂ 115 would give 7)
48 kHz × 115 = 5.52 MHz clock needed; period 127 NAND delays, which at an
illustrative 25 ps a delay is about 315 MHz → at most 315 / 115 = 2.7 million a second

the drawing: 16 taps, 9336 NANDs, multiplier 3572, accumulator 33 bits
passband tone 0.04: gain 1.001; stopband tone 0.35: 0.024</pre>The model and the gates are compared after every clock edge: the output, the tap number and the accumulator.`,
    },
    mistakes: [
      'Sizing the accumulator at log<sub>2</sub> N guard bits. That is right only if every tap could be full scale; for these taps 2 bits suffice, and every bit costs in every adder and register.',
      'Rounding or clamping at every addition. The sum is kept wide and rounded once, at the end; clamping early changes the answer for no reason.',
      'Forgetting that the sample rate is the clock over the tap count. An illustrative 315 MHz clock (127 NAND delays at 25 ps) with 115 taps is 2.7 million samples a second, not 315.',
      'Letting the ring hold stale data. The new sample must load only in the last cycle; loading earlier shifts the taps against the samples.',
    ],
    chapters: [{ chapter: 'firdesign', step: 6, label: 'One multiplier, N clocks' }, { chapter: 'firdesign', step: 3, label: 'Taps are words' }],
  },
};
