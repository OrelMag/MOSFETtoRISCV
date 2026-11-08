// The fuller codex for the Signal processing level, group E: the DSP core, speech, music and the software radio (codexdspe.ts holds the summaries). No DOM.

import type { CodexMore } from './codexmore';

export const MORE9E: Record<string, CodexMore> = {
  agu: {
    idea: `A load-store machine moves a pointer with an instruction of its own, an addition and a clock, for every array it walks. A filter walks two, so the pointer arithmetic outweighs the arithmetic of the filter. A DSP puts a small adder and a few registers beside each memory and lets the operand carry the update, as C's <code>*p++</code> does. Per memory the generator holds four 8-bit pointers, a window (base and length) and a modifier m; the instruction names a pointer and a mode. The address goes out and the memory reads, while the adder works out the pointer's next value in the same clock, ready for the next one.<br><br>The core's modes are unchanged, + and − (by 1), +m and −m (by the modifier, for a stride), +c and −c (by 1, wrapping at the window's edges) and +r (a reverse-carry add of m), all modulo 256, the pointer's width. Pointers p0–p3 address X and p4–p7 address Y. The two memories matter as much as the generators: with one, a multiply-accumulate would need its operands in two clocks, and a cache cannot give back what a second port gives. The price is a program that has to say which array lives in which memory.`,
    example: {
      title: 'One pointer, every mode',
      body: `<pre>next three addresses of one pointer at p = 9, window base 4 length 6, m = 32:
  +     9, 10, 11
  −     9, 8, 7
  +m    9, 41, 73
  −m    9, 233, 201          (modulo 256)
  +c    9, 4, 5              (10 is base + length: back to the base)
  −c    4, 9, 8              (from the base: to the window's last word)
  +r    0, 32, 16, 48        (from 0, m = 32)
64-tap filter, clocks a product:   DSP core 1.11   RV32 + MAC 6.15   RV32IM 7.18</pre>The two generators are 3840 of the core's 21 974 NANDs.`,
    },
    mistakes: [
      'Reading at the updated address. The access uses the pointer as it was and the mode updates it after (post-modify): <code>x(p0)+c</code> at 9 reads word 9 and leaves 4.',
      'Giving the pointer more than 8 bits. The arithmetic is modulo 256: + from 255 gives 0, and −m from 9 with m = 32 gives 233.',
      'Counting the generator as free. It is 1920 NANDs, 639 of them step logic, and the core has two.',
      'Treating X and Y as one address space. The same address in each names a different word, and a <code>mac</code> reads one of each.',
    ],
    chapters: [
      { chapter: 'dspcore', step: 0, label: 'What a loop costs' },
      { chapter: 'dspcore', step: 1, label: 'Two memories, two buses' },
      { chapter: 'dspcore', step: 2, label: 'Address generators' },
    ],
  },
  circbuf: {
    idea: `A delay line is the last N samples, and an FIR needs all of them at every output. Kept in order, the line shifts one place on every new sample: N − 1 loads and stores, more than the filter's own arithmetic. Kept in a ring, the newest sample is written over the oldest and the others stay where they are; only the point where reading starts moves.<br><br>The circular modes keep the ring in the access. <b>+c</b> adds 1 to the pointer and compares the result with base + length; on equality the base replaces it. <b>−c</b> from the base goes to base + length − 1. The window can be any length, which a software ring cannot do cheaply: a power-of-two ring costs an AND with a mask on every access, any other length a compare and a branch. Because the test is by equality, a pointer outside its window is not pulled in; it just steps. N reads round a window of N entries leave the pointer where it started, so the loop needs no fix-up afterwards.`,
    example: {
      title: 'Base 4, length 6',
      body: `<pre>+c from 9:           9 4 5 6 7 8 9 4
−c from the base:     4 9 8 7 6 5 4
+c from 12 (outside): 12 13 14
64 taps: shifting costs 63 moves a sample; the ring costs one store
64 samples of 64 taps on the core: 4550 clocks, (4550 − 6) / 64 = 71 = N + 7 a sample</pre>The window is [base, base + length), so base 4 and length 6 end at word 9.`,
    },
    mistakes: [
      'Starting a pointer outside the window. The wrap fires on equality with base + length; from 12 the pointer counts 12, 13, 14 and never returns.',
      'Taking length for the last address. The window is [base, base + length): base 4, length 6 ends at 9 and 10 is where it wraps.',
      'Walking the ring in the wrong direction for the coefficients. The taps must be stored in the order the pointer meets the samples (the core keeps them reversed in Y).',
      'Calling it a saving of memory. The N samples are stored either way; what the ring saves is the N − 1 moves.',
    ],
    chapters: [
      { chapter: 'dspcore', step: 2, label: 'Address generators' },
      { chapter: 'dspcore', step: 5, label: 'A filter, a tap a clock' },
    ],
  },
  bitrev: {
    idea: `A radix-2 FFT done in place combines pairs, then pairs of pairs, and for the butterflies to find their partners in neighbouring places the input must be shuffled first: sample n goes to the place whose index is n with its bits reversed. Software does it with a table or a loop of shifts and masks. The reverse-carry mode does it as a way of counting: reverse the pointer's bits, add the reversed modifier, reverse back. The reversals are wires; what remains is one 8-bit adder whose carry runs from the top bit down, so the pointer visits the places in bit-reversed order.<br><br>For an N-point transform (N a power of two up to 256) the modifier is N / 2. A table whose base is a multiple of N keeps its high bits, since the carry never reaches them. The streaming FFT of an earlier chapter delivers its tones in this order for the same reason; here the shuffle is paid once, on the way in.`,
    example: {
      title: 'The order a pointer counts in',
      body: `<pre>8 points,   m = 4:     0 4 2 6 1 5 3 7
64 points,  m = 32:    0 32 16 48 8 40 24 56 …   (every place once, then 0 again)
64 points from 128:    128 160 144 176 …         (the base bits stay)
256 points, m = 128:   0128 64 192 32 160 96 224 …
64-point FFT on the core: 4512 clocks, 768 multiply-accumulates; the copy is one loop of 64</pre>`,
    },
    mistakes: [
      'Using the wrong modifier. It is N / 2: m = 128 on a 64-point table walks the 256-point order, 0, 128, 64, 192, … and leaves the table.',
      'Putting the table at a base that is not a multiple of N. The carry then runs into the base\'s bits, and the pointer no longer visits N distinct places of the table.',
      'Thinking of it as a lookup. No table is stored; the order comes out of the adder.',
      'Expecting the mode to reorder the output. It reorders the reads of the input; the stages that follow leave the result in natural order.',
    ],
    chapters: [
      { chapter: 'dspcore', step: 2, label: 'Address generators' },
      { chapter: 'dspcore', step: 6, label: 'The FFT' },
    ],
  },
  hwloop: {
    idea: `On a load-store machine a loop is paid for at every pass: a counter to decrement, a comparison, a branch. In a filter the loop body is one multiply-accumulate, so the overhead is several times the work. A hardware loop moves the bookkeeping into the sequencer. The <code>loop</code> instruction loads a start (the next instruction), an end (a label) and a count; from then on a comparator watches the PC, and when it reaches the end of an active loop with the count above 1, the next PC is the start. No instruction does the jump and no fetch is wasted, so a loop of one instruction runs at one clock a pass.<br><br>What stays is everything outside it. A sample on the core costs N + 7 clocks: the load, the store, the loop set-up, the round, the output, the count and the branch of the outer loop. Seven clocks are 10 % of a 64-tap sample's 71 and 30 % of a 16-tap one's 23, which is why the cost a product approaches 1 only as the filter lengthens. The unit holds one loop; a second level would need another start, end and count and a stack to restore the first, so the outer loop is an ordinary branch.`,
    example: {
      title: 'The loop in numbers',
      body: `<pre>clr
loop  128, dot
dot:  mac  x(p0)+, y(p4)+        128 passes, one clock each
rnd r1, 15 · out r1 · rnd r1, 13 · out r1 · halt
dot product: 135 clocks, 128 multiply-accumulates
FIR, 16 taps:  1.45 clocks a product     FIR, 64 taps:  1.11
64 taps on the RV32 with a MAC: 6.15     RV32IM: 7.18</pre>`,
    },
    mistakes: [
      'Counting the loop as free everywhere. It is free inside; the set-up, the round, the output and the outer branch are seven clocks a sample.',
      'Reading the count as the repeats after the first. The count is the passes still to make, this one included: 16 means 16 passes, the last at count 1.',
      'Expecting a nested loop from the unit. It holds one; an outer loop is a branch, paid once per output.',
      'Comparing clocks without clocks\' lengths. The core\'s clock reaches from the ROM to the accumulator in one go and is longer than the RV32\'s.',
    ],
    chapters: [
      { chapter: 'dspcore', step: 0, label: 'What a loop costs' },
      { chapter: 'dspcore', step: 3, label: 'A loop with no branch' },
      { chapter: 'dspcore', step: 7, label: 'Against the RV32 machines' },
    ],
  },
  mulaw: {
    idea: `A uniform quantizer has one step for whispers and shouts alike, so its noise is the same at every level and a quiet voice gets a poor ratio. Companding makes the step follow the level: compress with a logarithmic curve, quantize uniformly, expand at the far end. The μ-law curve is F(x) = sign(x) · ln(1 + μ|x|) / ln(1 + μ), μ = 255. G.711 does not send it as a formula but as a table on 14-bit samples: 8 segments of 16 steps, the step doubling from one segment to the next, from 2 to 256. Segment ends fall at 31, 95, 223, 479, 991, 2015, 4063 and 8159, the clip level.<br><br>A code is the sign, the segment and the step, sent inverted so that silence is all ones. The encoder adds 33 to the magnitude, finds the top set bit for the segment and takes the four bits below it for the step; the decoder is ((33 + 2m) ≪ e) − 33. Near full scale uniform coding wins, because μ-law's steps there are coarser than a 14-bit-to-8-bit uniform step; the trade is made for the quiet end. G.711 also defines an A-law with a table of its own; only μ-law is built here.`,
    example: {
      title: 'Samples and their codes',
      body: `<pre>sample  code  decoded  segment, step
0       FF    0        1, 0
1       FE    2        1, 1
100     DF    99       3, 0
1000    AF    1023    6, 0
8000    80    8031    8, 15
curve against table: a sample at 1 % of full scale, magnitude 82 → code magnitude 28 of 127; the curve says 29.0
sine peaking at −40 dB:   μ-law 34.4 dB   8 uniform bits 11.1 dB
sine peaking at −20 dB:   38.0 / 29.6      at −6 dB: 36.7 / 43.9</pre>Decibels are below the clip level, 8159.`,
    },
    mistakes: [
      'Reading the 8 bits as 8-bit PCM. They stand for a 14-bit range: the largest code decodes to 8031 and the clip level is 8159.',
      'Forgetting the inversion. G.711 sends the code complemented, so silence is 0xFF, not 0, and a positive sample\'s code is 255 − n.',
      'Expecting μ-law to win everywhere. Near full scale 8 uniform bits do better (43.9 dB against 36.7 at −6 dB); the gain is at the quiet end.',
      'Treating the logarithm as smooth. The table is piecewise linear, 8 segments whose step doubles; the curve is its idealisation.',
    ],
    chapters: [
      { chapter: 'speech', step: 1, label: 'Why logarithms' },
      { chapter: 'speech', step: 2, label: 'μ-law, from G.711\'s table' },
      { chapter: 'speech', step: 3, label: 'μ-law in gates' },
    ],
  },
  adpcm: {
    idea: `Neighbouring samples of a voice are close, so the difference from a prediction is smaller than the sample and fits fewer bits. ADPCM predicts the next sample as the last reconstructed one and sends the difference on 4 bits: one for the sign, three for the magnitude in quarter-steps of the current step, a code <i>m</i> standing for (m + ½) quarter-steps. The step adapts. After each sample the index into IMA's table of 89 steps (7 to 32 767, each about 10 % above the last) moves by −1 for magnitudes 0 to 3 and by +2, +4, +6, +8 for 4 to 7: a small code shrinks the step, a large one grows it, up to 8 places at once.<br><br>The encoder runs the decoder's arithmetic on its own codes, so both keep the same prediction and the same step, and neither is sent. The error is largest just after a loud onset, while the step is still growing. A byte holds two codes; Python's audioop puts the first in the high half, and Microsoft's IMA ADPCM in WAV files in the low half, with block headers, so these codes are not a WAV file\'s. The encoder as an RV32I program needs shifts, compares and table loads, and no multiply.`,
    example: {
      title: 'A step to 1000 from rest',
      body: `<pre>sample  code  prediction  index  step
1       7     11          8      16
2       7     41          16     34
3       7     104         24     73
4       7     240         32     157
5       7     533         40     337
6       5     996         44     494
7       0     1057       43     449
8       8     1001       42     408
9       8     950         41     371
10      0     996         40     337</pre>The step climbs by 8 places a sample, so the prediction needs six samples to arrive and then overshoots. 89 steps from 7 to 32 767 are 1.10 apart on average; 4 bits at 8000 a second are 32 kb/s.`,
    },
    mistakes: [
      'Sending the step. Both sides move it by the same table from the same codes, so it never travels.',
      'Letting the encoder predict from the input. It must follow the decoder\'s reconstruction, or the two drift apart.',
      'Reading the codes as a WAV file\'s. Two codes pack high half first here (as audioop does); WAV\'s IMA ADPCM packs low half first and adds headers.',
      'Expecting the error to be even. It is largest after an onset, while the step is still catching up; the table moves it at most 8 places a sample.',
    ],
    chapters: [
      { chapter: 'speech', step: 4, label: 'Send the difference' },
      { chapter: 'speech', step: 5, label: 'ADPCM on the RV32' },
    ],
  },
  lpc: {
    idea: `A voice is a source driving a resonant tube. Linear prediction finds the tube: for each frame it picks the ten weights a<sub>k</sub> for which Σ a<sub>k</sub> x[n − k] is the best estimate of x[n] in the mean-square sense. This is the Wiener problem of the adaptive filters, with R the frame's autocorrelation, and Levinson's recursion solves it in n² operations. The recursion also yields the reflection coefficients k<sub>i</sub>; for any real signal each is inside ±1, which is why they are the safe numbers to quantize: any set inside the limit makes a stable filter, whereas a small change to the a<sub>k</sub> can push a pole out.<br><br>The synthesis filter 1 / A(z) is an envelope over the spectrum: its peaks, the formants, are the resonances of the throat and mouth. The fine harmonics of the pitch are not in it; they remain in the residual x − x̂, which is what a waveform coder would have to send. The frame is windowed (a Hamming window over 240 samples) and pre-emphasised, 1 − 0.9375 z<sup>−1</sup>, so the strong low end does not take all the predictor's effort. Order about 10 finds the formants of speech at 8 kHz; more adds small bumps, not harmonics.`,
    example: {
      title: 'A single resonance, solved',
      body: `<pre>x[n] = 1.6 x[n−1] − 0.8 x[n−2] + e[n]      (poles at radius 0.894, 590 Hz at 8 kHz)
r0, r1, r2 = 1, 0.8889, 0.6222
Levinson: k1 = 0.8889, k2 = −0.8, a = (1.6, −0.8)
error left: 7.6 % of the power, a prediction gain of 11.2 dB
the filter 1 / A(z) peaks at 576 Hz
on the chapter's voice: order 10, loud frames, mean gain 6.6 dB</pre>The envelope peaks a little off the pole\'s angle.`,
    },
    mistakes: [
      'Expecting the filter to follow the harmonics. Ten coefficients draw a smooth envelope; raising the order past about 10 adds small bumps, not the pitch lines.',
      'Quantizing the a<sub>k</sub> directly. A small error can move a pole outside the unit circle; the reflection coefficients can be quantized so that they stay inside ±1, as the vocoder does with log-area ratios.',
      'Skipping pre-emphasis. The low end holds most of the energy and the predictor spends itself on it.',
      'Quoting a prediction gain without the frame. It is 11.2 dB for the resonance above, 6.6 dB on average over this voice\'s loud frames, and near 0 on noise.',
    ],
    chapters: [
      { chapter: 'speech', step: 6, label: 'Predict the next sample' },
      { chapter: 'speech', step: 7, label: 'A vocoder at 2.4 kb/s' },
    ],
  },
  vocoder: {
    idea: `A waveform coder sends something close to the samples; a vocoder sends a model that regenerates a similar-sounding voice. The model is the source-filter picture. The filter is the frame's LPC envelope, sent as ten reflection coefficients in the form of log-area ratios, with more bits for the first few, which shape the spectrum most. The source is either a train of pulses at the pitch (voiced speech) or noise (unvoiced); the frame sends the choice, the pitch period and a level. The receiver builds the excitation and runs it through the filter.<br><br>The reward is the rate: 54 bits every 22.5 ms. The cost is the person. What comes out is intelligible and sounds like a machine, because the details that make one voice recognisable (the exact glottal shape, the small irregularities) were never sent. SNR does not measure it: its waveform differs from the input almost everywhere, however good it sounds. The pitch tracker is the weak part: centre clipping and an octave-error check keep it honest here, and a real coder is far more careful.`,
    example: {
      title: 'Where the 54 bits go',
      body: `<pre>ten reflection coefficients      5 5 5 5 4 4 4 4 3 2   41 bits
pitch period and voicing                              7
level                                                 5
sync                                                  1
                                                     54 bits per 180 samples (22.5 ms at 8 kHz)
54 / 0.0225 s = 2400 b/s       μ-law 64 000 (27×)       ADPCM 32 000 (13×)
chapter's reading: 59 % of frames voiced, median pitch 127 Hz</pre>`,
    },
    mistakes: [
      'Judging it by SNR. It never tries to match the samples; compare it by intelligibility and by what it keeps.',
      'Reading 2400 b/s as a 27-fold compression of the same thing. μ-law keeps the waveform and the speaker; the vocoder keeps the words.',
      'Believing the filter alone carries the speech. Driving the same filter with noise instead of pulses gives a whisper; the voiced / unvoiced decision and the pitch are half the description.',
      'Trusting the pitch. A tracker can pick an octave or a harmonic; the check reduces the mistakes, it does not remove them.',
    ],
    chapters: [
      { chapter: 'speech', step: 6, label: 'Predict the next sample' },
      { chapter: 'speech', step: 7, label: 'A vocoder at 2.4 kb/s' },
    ],
  },
  mdct: {
    idea: `Frames of a signal need to overlap, or their edges click; but overlapping frames of an ordinary transform give twice the numbers. The MDCT overlaps by half and still gives one coefficient per sample: a frame of 2M samples, windowed, gives M coefficients, and the next frame starts M samples on. The price is that a frame alone does not invert. The transform cannot tell the first half from its mirror image about the quarter point, and the inverse returns the first half minus its mirror and the second half plus its mirror, each times the window.<br><br>Add two neighbouring frames and the second half of one meets the first half of the next. If the window satisfies w[n]² + w[n + M]² = 1 (Princen–Bradley; the sine window does), the two aliases are equal and opposite and cancel, and the signal is back: time-domain aliasing cancellation. If a coder has quantized the coefficients the cancellation is not exact, but the error is spread over the overlap instead of ending in a hard step. That is why audio codecs use it. Here M = 256 at 16 kHz.`,
    example: {
      title: 'One frame, and two',
      body: `<pre>frame of 2M = 512 samples, hop M = 256 (16 ms at 16 kHz), 256 coefficients 31.25 Hz apart
one frame back:   first half   y[n] = w[n] ( w[n] x[n] − w[M−1−n] x[M−1−n] )
                  second half  y[n] = w[n] ( w[n] x[n] + w[3M−1−n] x[3M−1−n] )
two frames added: the aliases cancel; the signal returns to better than 10<sup>−12</sup>
direct computation: 2M² = 131 072 multiplications a frame</pre>`,
    },
    mistakes: [
      'Treating one frame as invertible. Alone it returns the signal folded; only the overlap-add restores it.',
      'Counting 2M coefficients a frame. It is M, one a sample, since frames overlap by half.',
      'Taking the hop for the frame length. The frame is 512 samples (32 ms) but the hop is 256 (16 ms).',
      'Using any window. One that fails w[n]² + w[n + M]² = 1 leaves aliasing the neighbour no longer cancels.',
    ],
    chapters: [
      { chapter: 'music', step: 1, label: 'Overlap without loss' },
      { chapter: 'music', step: 2, label: 'What the ear misses' },
    ],
  },
  masking: {
    idea: `The ear does not hear every component of a sound separately. A loud tone raises the level at which a nearby tone can be heard: the louder one masks the quieter. The effect reaches further upward in frequency than downward, and it is local on the Bark scale, so a codec can ask, band by band, how much noise would go unheard. Where the answer is a lot, few bits will do; where nothing is hidden, the band needs them all.<br><br>The model here is deliberately plain. Each band's level spreads to the others, falling 25 dB a Bark below it and 10 dB a Bark above, and masks 14 dB under itself; the contributions add as powers, and the mask never drops below the threshold in quiet (Terhardt's curve, 3.4 dB SPL at 1 kHz, 23.0 at 100 Hz, with full scale taken as 96 dB SPL). Real codecs also tell tonal maskers from noise, follow masking in time, and are tuned by listening. Given the mask, the loop gives each bit to the band where it buys most: a bit lowers a band\'s noise by 6 dB, and by the mask it counts only while the noise is above the mask.`,
    example: {
      title: 'One masker, and the bits',
      body: `<pre>one band at L = −20 dBFS, the rest silent:
  one Bark above:  L − 10 − 14 = −44 dBFS      one Bark below:  L − 25 − 14 = −59 dBFS
nocturne, bits by mask / by signal:
  64 kb/s   49.4 kb/s spent,  1.0 % audible,  SNR 21.4 dB     63.9 kb/s,  11.3 %,  49.4 dB
  32 kb/s   31.7,            17.3 %,          21.3 dB         31.9,       28.4 %,  35.0 dB
  16 kb/s   15.9,            49.3 %,          13.0 dB         15.9,       58.4 %,  17.5 dB</pre>Audible: band-frames whose noise is above their mask.`,
    },
    mistakes: [
      'Equating a high SNR with good sound. Bits by signal reach 49.4 dB at 64 kb/s and leave 11.3 % of the band-frames audible; bits by mask reach 21.4 dB and leave 1.0 %.',
      'Assuming the mask is symmetric. It falls 10 dB a Bark above the masker and 25 below, so the tone above is the better hidden.',
      'Taking this model for a standard. Its constants are from memory and it follows no format; real codecs add tonality, temporal masking and listening tests.',
      'Forgetting the floor. Noise under the threshold in quiet is inaudible with no masker at all, so a very quiet band needs no bits for that reason alone.',
    ],
    chapters: [
      { chapter: 'music', step: 2, label: 'What the ear misses' },
      { chapter: 'music', step: 3, label: 'Bits where they are heard' },
    ],
  },
  barkscale: {
    idea: `The ear resolves frequency in bands whose width grows with frequency: about 100 Hz wide near the bottom, roughly a fifth of the centre frequency higher up. The Bark scale numbers those critical bands, one Bark each, from 1 to 24. An engineer wants it because masking, loudness summation and the ear's resolution are all roughly constant on it, so a fixed spreading rule in decibels a Bark describes masking at any pitch, where in hertz the same rule would change with frequency.<br><br>Zwicker\'s formula is an approximation to the measured bands, and the chapter takes it from memory. Used for a codec, it fixes the bands: starting at the lowest coefficient, each band takes coefficients until a Bark has been covered. At 16 kHz that makes 20 bands of an MDCT frame, narrow at the bottom (4 coefficients of 31.25 Hz) and wide at the top (28), so more bits and more side information go where the ear is sharper.`,
    example: {
      title: 'Hertz to Bark',
      body: `<pre>f        100    500    1000   4000   8000   16 000 Hz
z(f)     0.99   4.74   8.51    17.26   21.28   24.09  Bark
100 → 500 Hz: 3.75 Bark on 400 Hz, 107 Hz a Bark     4 → 8 kHz: 4.02 Bark on 4000 Hz, about 1 kHz a Bark
20 kHz: 24.6 Bark
MDCT, 16 kHz, 256 coefficients: 20 bands, widths from 4 to 36 coefficients (the last, 28)</pre>`,
    },
    mistakes: [
      'Treating a Bark as a fixed number of hertz. It is about 107 Hz at the bottom and about 1 kHz between 4 and 8 kHz.',
      'Taking Zwicker\'s formula for the measured bands. It is an approximation, from memory here, and other fits (ERB) differ.',
      'Spreading masking in hertz. On the Bark scale a fixed fall of decibels a Bark applies at every pitch; in hertz it would need to change with frequency.',
      'Expecting equal bands to hold equal numbers of coefficients. The coefficients are evenly spaced in hertz, so a band at the top holds many more than one at the bottom.',
    ],
    chapters: [
      { chapter: 'music', step: 2, label: 'What the ear misses' },
      { chapter: 'music', step: 3, label: 'Bits where they are heard' },
    ],
  },
  nco: {
    idea: `To generate a sine of any frequency from a table, step through the table at a rate. The modem chapter builds one for FSK, with a 13-bit register; the software radio's has 16 bits and a cosine table beside the sine one. The phase register is the position, and it advances by the tuning word at every clock; the top bits of the phase pick the table entry. The register being 16 bits wide, the word f / f<sub>s</sub> · 2<sup>16</sup> sets the frequency in steps of f<sub>s</sub> / 2<sup>16</sup>, which at 960 kHz is 14.65 Hz. A second table a quarter turn out gives the cosine, and the pair is the complex oscillator e<sup>jθ</sup> that a mixer needs.<br><br>Fineness of tuning and accuracy of the wave are different things. Resolution comes from the phase register's width; the table size decides how coarse the staircase is, and the staircase leaves a spur at a fixed distance below the carrier, 6 dB lower for every bit of the table until the table's own word length takes over. Where a station sits matters: −300 kHz has the word 0xB000, with 12 trailing zeros, so the phase visits only 16 points, which are all on the table and so have no staircase error. Tuned 100 Hz off, the spurs return. A table of 2<sup>k</sup> entries doubles in size for every bit.`,
    example: {
      title: 'Tuning words and table sizes',
      body: `<pre>step = 960 000 / 65 536 = 14.65 Hz
−300 kHz → word 45 056 = 0xB000   (12 trailing zeros: 16 phase points)
table bits   spur below the carrier   oscillator NANDs
   4           23.5 dB                    902
   6           36.0                     3146      (the chapter's)
   8           48.1                    13 658
   9           52.8                    29 176      (the table's 8-bit words limit it)</pre>`,
    },
    mistakes: [
      'Reading the table size as the tuning resolution. The resolution is f<sub>s</sub> / 2<sup>16</sup> = 14.65 Hz, from the phase register; the table only sets the spur level.',
      'Judging the table on a friendly frequency. At −300 kHz the phase lands on 16 table points and the error vanishes; 100 Hz off, it does not.',
      'Expecting 6 dB a bit without limit. From 9 bits on the table\'s 8-bit entries set the floor, at 52.8 dB.',
      'Forgetting the wrap. Negative frequencies are the word modulo 2<sup>16</sup>, so −300 kHz is 45 056, not a negative number.',
    ],
    chapters: [
      { chapter: 'modem', step: 2, label: 'An oscillator from an adder' },
      { chapter: 'sdr', step: 2, label: 'Moving a station to zero' },
      { chapter: 'sdr', step: 3, label: 'The mixer in gates' },
      { chapter: 'sdr', step: 4, label: 'How fine does the table have to be?' },
    ],
  },
  complexmixer: {
    idea: `Picking one station out of a band at 960 kHz by filtering alone needs a very long impulse response. It is cheaper to move the station to zero and keep the filter fixed. Multiplying every sample by e<sup>−jθ</sup>, θ turning by the tuning word, subtracts the oscillator's frequency from everything in the band. Because the samples are complex (I and Q) the multiplication is one rotation, and nothing is lost: four real multiplications and two additions.<br><br>A real mixer multiplies by cos θ alone, which is e<sup>jθ</sup> and e<sup>−jθ</sup> together, so every frequency appears at both the sum and the difference; the unwanted one folds on the station. The complex mixer keeps one. What is left to design is arithmetic: the tables hold ±127 for 1.0, so the gain is 127 / 128 = 0.992; a rotated sample can grow by √2, so the sum keeps 11 bits from bit 7 up, a floor that biases every output half a step down. A station beyond the band\'s edge wraps: the band is ±480 kHz at the sample rate.`,
    example: {
      title: 'Tuned to −300 kHz',
      body: `<pre>(xr + j xi)(cos θ − j sin θ) = (xr cos θ + xi sin θ) + j (xi cos θ − xr sin θ)
the station at −300 kHz            → 0
the station at +340 kHz            → +640 kHz, past +480 kHz, so it shows at −320 kHz
mixer 9554 NANDs, of which the oscillator 3146; gain 127 / 128 = 0.992</pre>`,
    },
    mistakes: [
      'Using a real mixer on I / Q and expecting one image. Multiplying by cos θ alone makes the sum and the difference, with the mirror image on top of the wanted station.',
      'Forgetting the wrap. A station mixed beyond ±480 kHz is not gone; it re-enters the band at the other side.',
      'Assuming unity gain. The tables\' 127 stand for 1.0, so the output is 0.992 of the input, minus half a step from the floor.',
      'Tuning the filter. The filter stays fixed; the oscillator moves the station into it.',
    ],
    chapters: [
      { chapter: 'sdr', step: 2, label: 'Moving a station to zero' },
      { chapter: 'sdr', step: 3, label: 'The mixer in gates' },
    ],
  },
  fmdiscriminator: {
    idea: `In FM the audio is the rate at which the phase turns. With complex samples z<sub>n</sub> that rate can be read directly. The product z<sub>n</sub> · conj(z<sub>n−1</sub>) has the length of the two samples multiplied and, as its angle, the phase turned in one sample, so atan2 of its imaginary and real parts is that turn in radians. Multiplied by the sample rate over 2π it is the frequency in hertz, and divided by the deviation it is the audio itself: a full-scale tone swings ±1. No oscillator follows the carrier and nothing needs to be locked.<br><br>Taking the angle of the product, rather than subtracting two angles, avoids the 2π error whenever one angle has just wrapped. The detector ignores amplitude, it does not ignore noise, or an alias that landed in the channel, and anything beyond one deviation in its output belongs to those. Its range is ±π a sample, so at the CIC\'s 240 kHz a frequency beyond ±120 kHz wraps. The station\'s width follows Carson\'s rule.`,
    example: {
      title: 'Frequencies and readings at 240 kHz, deviation 50 kHz',
      body: `<pre>input at   +50 kHz → 1.000     +25 kHz → 0.500     −50 kHz → −1.000     +25 kHz at 0.1 amplitude → 0.500
range ±120 kHz; a ±50 kHz deviation uses 42 % of it
Carson: 2 (50 + 15) = 130 kHz       modulation index 50 / 15 = 3.33</pre>`,
    },
    mistakes: [
      'Subtracting two angles. Each wraps at ±π, so the difference is off by 2π whenever one has just wrapped; the angle of the product has no such step.',
      'Expecting it to reject noise. It ignores amplitude, not noise or a neighbour\'s alias: whatever exceeds one deviation in its output is theirs.',
      'Forgetting its range. At 240 kHz anything beyond ±120 kHz wraps, whatever the deviation.',
      'Taking Carson\'s width as exact. It is a rule of thumb for the band that holds nearly all the power, 130 kHz for these figures.',
    ],
    chapters: [
      { chapter: 'sdr', step: 1, label: 'How wide is a station?' },
      { chapter: 'sdr', step: 6, label: 'The channel filter and the discriminator' },
    ],
  },
  emphasis: {
    idea: `After an FM discriminator, noise rises towards the top of the audio band while most programme energy sits at the bottom. A broadcaster takes advantage: it boosts the treble before modulating and every receiver cuts the treble by the inverse curve. The programme comes back flat, the noise added in the channel is cut at the top, and the hiss is quieter than without the pair.<br><br>The analogue standard is a first-order network with a time constant, 75 µs in North American FM broadcasting: its corner is 2122 Hz and it lifts a tone at the corner by 3.01 dB. The chapter\'s discrete version is one tap at 24 kHz, the pre-emphasis y[n] = (m[n] − α m[n−1]) / (1 + α), scaled to unity gain at 12 kHz, with the de-emphasis its exact inverse; α is chosen from the same 75 µs. The two do not match: at 10 kHz the discrete one lifts 11.07 dB, the analogue one 13.66.`,
    example: {
      title: 'The two curves',
      body: `<pre>τ = 75 µs → corner 1 / (2π τ) = 2122 Hz
f         1 kHz   2.122 kHz   5 kHz   10 kHz
analogue  0.87    3.01        8.16    13.66 dB
discrete  0.85    2.90        7.54    11.07 dB     (α = 0.574 at 24 kHz)
discrete de-emphasis undoes the pre-emphasis exactly: the error is rounding</pre>Lift is over the bass.`,
    },
    mistakes: [
      'Treating the discrete pair as the analogue network. At 10 kHz one lifts 11.07 dB and the other 13.66.',
      'Applying only one of the two. A receiver without the de-emphasis plays the treble too strong, with the noise at full strength.',
      'Putting the de-emphasis before the discriminator. It works on the audio, after the discriminator and the audio filter.',
      'Expecting the pair to cancel on the noise. It cancels on the programme, which was boosted before the noise was added; the noise is only cut.',
    ],
    chapters: [
      { chapter: 'sdr', step: 7, label: 'Audio, and the treble that was boosted' },
    ],
  },
};
