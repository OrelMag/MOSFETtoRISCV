// Check yourself for the Signal processing level: measuring a spectrum, FIR design. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK11B: Record<string, Quiz[]> = {
  leakage: [
    {
      question: 'A tone holds exactly 10 cycles in a 64-sample block under a rectangular window, and its spectrum is one clean bin. Why?',
      options: ['Every other bin falls on a zero of the rectangle\'s transform', 'The window removes its skirt when the cycles are whole', 'The FFT only finds tones that sit on a bin', 'A real cosine has no image at negative frequency'],
      answer: 0,
      explain: 'The skirt is always there, as the transform of the rectangle. With whole cycles the bins sample it at its zeros; at 10.5 cycles they sample it between, and 33 bins read above −60 dB.',
      why: ['', 'The window is unchanged. The skirt is still drawn; the bins simply miss it.', 'The transform reads the whole curve at its bins, and a tone off a bin shows in several of them.', 'A real cosine always has an image; it adds to the skirt but is not why the line is clean.'],
    },
    {
      question: 'A tone of amplitude 1 reads 0.65 at its largest bin under a rectangular window. What most likely happened?',
      options: ['It sits between two bins, and the bin reads the lobe\'s shoulder', 'The source is 3.8 dB weaker than its setting', 'Averaging more blocks would raise the reading to 1', 'Noise has been subtracted from the peak'],
      answer: 0,
      explain: 'Halfway between bins the rectangle\'s transform reads 0.64 to 0.65, which is 3.8 dB low: the scalloping loss.',
      why: ['', 'The source is not weaker; the same tone reads 1 when its cycles fit the block.', 'The skirt is deterministic: every block of the same tone shows the same reading.', 'Noise adds power to a bin and does not subtract from a peak.'],
    },
  ],
  windowfn: [
    {
      question: 'A tone 40 dB below another sits 10 bins away in a 64-sample block. Why does Hann show it when the rectangle does not?',
      options: ['Its skirt there is −68.5 dB, against −29.2 dB', 'Its main lobe is narrower than the rectangle\'s', 'It boosts weak components before the transform', 'It has no sidelobes beyond the first'],
      answer: 0,
      explain: 'At 10 bins the rectangle\'s skirt is above the weak tone, which hides under it; Hann\'s is well below, so the tone stands out.',
      why: ['', 'Hann\'s lobe is twice as wide, 4 bins against 2; it wins on the skirt, not the lobe.', 'A window multiplies the whole block by one taper and treats strong and weak alike.', 'It has sidelobes all the way out; they fall faster, which is the point.'],
    },
    {
      question: 'The noise floor of a Hann spectrum reads 1.8 dB above the rectangle\'s for the same white noise. Why?',
      options: ['Each bin passes 1.5 bins of noise: its noise bandwidth', 'Hann amplifies noise by a factor of 1.8', 'The taper lowers the signal by 1.8 dB', 'Hann adds rounding noise of its own'],
      answer: 0,
      explain: 'The noise bandwidth of Hann is 1.5 bins, and 10 log<sub>10</sub> 1.5 = 1.8 dB. The same widening is why Hann does not resolve as close as the rectangle.',
      why: ['', 'The window does not amplify; it weights samples, and the sum of weights is what sets the reading.', 'A tone on a bin is scaled back to its true amplitude by dividing by half the window\'s sum.', 'The window is a fixed set of numbers; it adds no noise of its own.'],
    },
  ],
  zeropad: [
    {
      question: '64 samples at 8 kHz under a Hann window, padded to 4,096 points. Two tones 150 Hz apart: are they resolved?',
      options: ['No: that is 1.2 bins of 125 Hz, and Hann needs 2.45', 'Yes: the padded bins are 1.95 Hz apart', 'Yes: padding multiplies the resolution by 64', 'No: Hann cannot resolve tones under 1 kHz'],
      answer: 0,
      explain: 'The bin that counts is the unpadded one, 8,000 / 64 = 125 Hz. Hann needs about 2.45 of them, 306 Hz, and padding does not change that.',
      why: ['', 'The padded dots are close together, but they lie on a curve whose lobe is still 4 unpadded bins wide.', 'Padding reads the same curve at more points; it narrows nothing.', 'There is no such limit; 306 Hz is the figure for this block, and a longer block would do better.'],
    },
    {
      question: 'To resolve two in-phase tones Δf cycles a sample apart with a rectangular window you must record for about...',
      options: ['1.55 / Δf samples, however the record is padded', '1.55 / Δf points after padding to a power of two', 'Δf / 1.55 samples', '2.45 / Δf samples, the figure for any window'],
      answer: 0,
      explain: 'The rectangle resolves 1.55 bins, a bin is 1 / N cycles a sample, so N must reach 1.55 / Δf. Hann needs 2.45 / Δf.',
      why: ['', 'Zeros are not samples; only the real record counts toward resolution.', 'The record grows as the tones get closer, not shorter.', '2.45 is Hann\'s figure; the rectangle\'s main lobe is narrower, so 1.55.'],
    },
  ],
  spectrogram: [
    {
      question: 'At 8 kHz you go from a frame of 512 samples to one of 32. What happens to a Hann frame\'s main lobe and duration?',
      options: ['The lobe goes from 62.5 Hz to 1,000 Hz; the frame from 64 ms to 4 ms', 'The lobe narrows to 4 Hz and the frame lasts 4 ms', 'The lobe stays 62.5 Hz and the frame shortens', 'The lobe widens to 1,000 Hz and the frame lasts 64 ms'],
      answer: 0,
      explain: 'The lobe is 4 bins of fs / N and the frame lasts N / fs, so shortening N sixteen-fold widens the lobe sixteen-fold and shortens the frame the same.',
      why: ['', 'A shorter frame has fewer samples, which widens the lobe; it cannot narrow it.', 'The lobe\'s width in hertz is 4 fs / N, so it follows N.', 'The frame lasts N / fs, so it follows N as well.'],
    },
    {
      question: 'A 2,048-sample signal is cut into frames of 512 with a hop of 64 instead of 512. About how many more transforms?',
      options: ['6.25 times: 25 frames against 4', 'None: the frames share their transforms', '8 times exactly: every sample is in 8 frames', 'Half as many, since frames overlap'],
      answer: 0,
      explain: 'Without overlap there are 4 frames; at a hop of 64 there are 25. The ends are in fewer frames than the middle, so it is a little under the 8 that 7/8 overlap suggests.',
      why: ['', 'Each frame is a separate windowed transform; overlap means more of them, not shared ones.', 'Only samples away from the ends are in 8 frames; the ones near the ends are in fewer.', 'Overlap adds frames, so the count goes up.'],
    },
  ],
  overlapsave: [
    {
      question: 'A 64-tap filter runs by overlap-save in blocks of 256. How many outputs of each block are kept and how many thrown away?',
      options: ['193 kept, 63 thrown away', '256 kept, none thrown away', '192 kept, 64 thrown away', '64 kept, 192 thrown away'],
      answer: 0,
      explain: 'L = N − M + 1 = 193 new samples per block; the first M − 1 = 63 outputs are circular wrap-around.',
      why: ['', 'The circular convolution wraps the tail of the response onto the first M − 1 outputs, which are wrong.', 'The discard is M − 1, not M.', 'That swaps the count with the discard: most of a block is good.'],
    },
    {
      question: 'Does fast convolution by blocks beat the direct form for a 33-tap filter?',
      options: ['No: the best block costs 41.1 multiplications a sample against 33', 'Yes: an FFT always wins', 'Yes, with a block of exactly 33 points', 'No: the first outputs of a block are wrong, so it never wins'],
      answer: 0,
      explain: 'Blocks win from 44 taps; at 33 the best block, 256, still costs more multiplications than the direct form\'s 33.',
      why: ['', 'An FFT pays two transforms and a product per block; for short filters that costs more than it saves.', 'A block of the filter\'s length leaves L = 1 sample per block and costs far more.', 'Discarding wrong outputs is part of the cost, and for long filters the method wins anyway.'],
    },
  ],
  goertzel: [
    {
      question: 'A decoder needs K tones from each 64-sample block. From about what K does an FFT become cheaper than K Goertzels?',
      options: ['12: two log<sub>2</sub> 64', '64: one per sample', '6: log<sub>2</sub> 64', 'Never: Goertzel is always cheaper'],
      answer: 0,
      explain: 'K Goertzels cost K (N + 3) multiplications and an FFT about 2 N log<sub>2</sub> N, so they meet near K = 2 log<sub>2</sub> N.',
      why: ['', 'The FFT does not cost a bin per sample; its cost grows as N log N.', 'That leaves out the factor 2: four real multiplications to a butterfly.', 'A Goertzel is N real multiplications per bin, so enough bins always favour the FFT.'],
    },
    {
      question: 'A frequency falls between an FFT\'s bins. Can a Goertzel cell find it?',
      options: ['Yes: c = 2 cos(2πf) takes any f, though off a bin centre it leaks', 'No: it only finds frequencies that fall exactly on a bin', 'Yes, and without any leakage, being a recurrence', 'No: it needs a whole number of cycles in the block'],
      answer: 0,
      explain: 'The coefficient is set by the frequency alone. Off a bin centre the block does not hold whole cycles and the result leaks, like any transform, so the block length is worth choosing.',
      why: ['', 'Only the leakage depends on where f sits relative to the bins; the recurrence works at any f.', 'A block cut off mid-cycle leaks whatever method reads it.', 'The recurrence needs no whole cycles; the result is exact for the block as it is, leakage included.'],
    },
  ],
  linearphase: [
    {
      question: 'A symmetric 51-tap filter runs at 1 kHz. What is its delay at 100 Hz and at 400 Hz?',
      options: ['25 ms at both', '51 ms at both', '25 ms at 100 Hz and less at 400 Hz', '12.5 ms at both'],
      answer: 0,
      explain: 'Linear phase means one delay for every frequency, (51 − 1) / 2 = 25 samples, which at 1 kHz is 25 ms.',
      why: ['', 'The signal waits for the middle of the taps, not for all of them.', 'A symmetric filter delays all frequencies equally; unequal delays are what other phases do.', 'That is half the right delay; the centre is 25 samples in.'],
    },
    {
      question: 'Why can a causal filter with poles not be exactly linear phase?',
      options: ['Pairing each singularity with its mirror puts a pole\'s mirror outside the circle, unstable', 'IIR filters have fewer taps than an FIR of the same sharpness', 'Poles always delay the signal by a whole number of samples', 'Feedback reverses the signal in time before the output'],
      answer: 0,
      explain: 'Linear phase needs every zero paired with its mirror across the unit circle. A pole cannot be, because the mirror of a stable pole is an unstable one.',
      why: ['', 'The count of taps has no bearing; it is the position of the singularities that matters.', 'A pole\'s delay varies with frequency, which is the opposite of linear phase.', 'Feedback does not reverse time; it makes the response run on after the input.'],
    },
  ],
  windowdesign: [
    {
      question: 'A Kaiser design that just meets a 0.001 stopband has a passband error near 0.0011, though 0.0058 was allowed. Why?',
      options: ['The window gives both bands the same ripple, set by the tighter one', 'Windows always leave the passband flat, whatever the length', 'Only the stopband is windowed, so the passband is free', 'Rounding the taps to words tightened the passband'],
      answer: 0,
      explain: 'The sidelobes set the passband ripple and the stopband ceiling together. The passband is then 5 times better than the mask asked, which is the accuracy Parks–McClellan spends on a narrower transition.',
      why: ['', 'The passband ripples as much as the stopband does; the ripple is the same size in both.', 'The window multiplies all the taps, whatever band they serve.', 'Rounding adds ripple, it does not remove it.'],
    },
    {
      question: 'A Hamming design of 301 taps reaches only −58.4 dB, and the mask asks −60 dB. What next?',
      options: ['Lengthen it: Hamming first reaches −60 dB at 489 taps, odd', 'Raise β until it passes', 'Nothing: −58 dB is its limit', 'Switch to a rectangle, which falls faster'],
      answer: 0,
      explain: 'Hamming plateaus near −58 dB while its nearest sidelobes sit inside the transition, and falls on again as the filter lengthens, reaching −60 dB at 489 taps.',
      why: ['', 'Hamming has no β; Kaiser\'s window has one.', 'Its sidelobe level is fixed, but the response in the stopband still improves as N grows.', 'The rectangle\'s stopband is at −41.8 dB even at 1,001 taps.'],
    },
  ],
  parksmcclellan: [
    {
      question: 'What does it mean that a Parks–McClellan design is equiripple?',
      options: ['The weighted error touches one size at no fewer than ⌈N / 2⌉ + 1 frequencies, alternating in sign', 'The passband and the stopband ripple are the same size', 'The ripple falls 6 dB for each doubling of the length', 'All the taps in the filter have one and the same value'],
      answer: 0,
      explain: 'The alternation theorem: that many alternating extremes of equal size is both necessary and sufficient for the best weighted fit, and the Remez exchange finds them.',
      why: ['', 'The weights make the two bands\' errors equal after weighting, not before: they follow the mask.', 'That describes the rectangular window\'s stopband peak, not an equiripple design.', 'Taps are mirror images, not equal.'],
    },
    {
      question: 'Parks–McClellan meets the mask with 114 taps and Kaiser\'s window needs 146. What does the window cost on every output sample?',
      options: ['32 more multiplications, 28 % more', '5 more, the formula\'s shortfall', 'None: a window design is cheaper to run', '146 − 109 = 37 more'],
      answer: 0,
      explain: 'Each tap is a multiplication per sample, so 146 against 114 is 32 more, 28 %.',
      why: ['', 'The length formula gave 109 for the 114-tap filter; that is its error, not the window\'s extra.', 'The window is cheaper to design, not to run: it needs more taps.', 'That mixes the formula\'s estimate for one design with the length of the other.'],
    },
  ],
  csd: [
    {
      question: 'The tap 13,304 is −2³ + 2¹⁰ − 2¹² + 2¹⁴. How many adders does it need, with no multiplier?',
      options: ['3: four terms are added or subtracted in three steps', '4: one adder for each of the four terms', '9: one for each one in its binary form', '1: shifts are free, so a single sum does it'],
      answer: 0,
      explain: 'A shift is wiring; combining four shifted copies takes three adders or subtractors. Binary would have nine ones.',
      why: ['', 'The first term needs no adder: the sum starts with it, so n terms take n − 1.', 'That is the cost of the binary form; signed digits cut the nine ones to four terms.', 'One adder combines two copies; four terms need three.'],
    },
    {
      question: 'Why is 7 = 8 − 1 cheaper than 4 + 2 + 1?',
      options: ['Two non-zero digits against three: one adder against two', 'Subtraction is faster than addition', '8 − 1 needs no shifted copy', 'It uses a smaller multiplier'],
      answer: 0,
      explain: 'Each extra non-zero digit costs an adder. Canonical signed digits never put two non-zero digits side by side and use the fewest possible.',
      why: ['', 'A subtractor is an adder with an inverted copy and a carry in, and is no faster.', 'Both need the shifted copy of the input; 8 is a shift by 3.', 'No multiplier is used in either case; that is the point of the form.'],
    },
  ],
  transposed: [
    {
      question: 'What sets the longest path in the transposed form of a 115-tap filter?',
      options: ['One multiplier and one adder', 'A multiplier and a tree of 7 adders', 'The ring of sample registers', 'The ROM that holds the taps'],
      answer: 0,
      explain: 'The input reaches every multiplier at once and each product goes into one adder before a register, so nothing waits behind a long chain.',
      why: ['', 'That is the direct form, which sums all the products behind the last tap.', 'A ring of registers belongs to the shared-multiplier design, not to the transposed form.', 'The taps are fixed multiplier inputs here; there is no ROM to read.'],
    },
    {
      question: 'Why are the transposed form\'s registers wider than the direct form\'s?',
      options: ['They hold partial sums, so they are as wide as the accumulator', 'Each one holds two samples side by side', 'They store the taps along with the data', 'They need extra bits to carry the clock'],
      answer: 0,
      explain: 'A direct-form register holds a sample, 16 bits; a transposed one holds a running sum of products, 34 bits for these taps.',
      why: ['', 'Each holds one value; it is the value that is wider, being a sum of products.', 'The taps are constants in the multipliers, not in the registers.', 'The clock is a single wire to every register and needs no data bits.'],
    },
  ],
  multacc: [
    {
      question: 'A 64-tap filter must give 96,000 samples a second on one multiplier. What is the slowest clock that works?',
      options: ['6.144 MHz: 64 × 96,000', '96 kHz', '3.072 MHz, taking the folded form', '1.5 kHz'],
      answer: 0,
      explain: 'One multiplication a clock and 64 of them a sample is 64 × 96,000 = 6.144 million a second.',
      why: ['', 'That is one multiplication a sample, enough for one tap.', 'That assumes folding, which the shared-multiplier design does not do.', 'That divides instead of multiplying: 96,000 / 64.'],
    },
    {
      question: 'The 115-tap accumulator has 2 guard bits where log<sub>2</sub> 115 would suggest 7. Why is 2 enough?',
      options: ['Σ|tap| = 1.94 bounds the output, where log<sub>2</sub> N assumes full-scale taps', 'Rounding at the end removes the extra bits again', 'The clamp at the end catches any overflow before it', 'The ring holds fewer samples than there are taps'],
      answer: 0,
      explain: 'The output cannot exceed Σ|tap| times the largest input, so the bits above the product are those Σ|tap| asks for. Guard bits are paid for in every adder and register.',
      why: ['', 'Rounding happens once at the end and does not reduce the sum\'s range.', 'Clamping at the end would hide an overflow in the middle of the sum, giving a wrong value.', 'The ring holds one sample per tap, N of them.'],
    },
  ],
};
