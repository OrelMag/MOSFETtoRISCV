// Check yourself for the Signal processing level, group E: the DSP core, speech, music and the software radio. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK11E: Record<string, Quiz[]> = {
  agu: [
    {
      question: 'On the DSP core, mac x(p0)+c, y(p4)+c runs in one clock. Why does it not need an instruction to step each pointer?',
      options: ['Each memory\'s address generator updates the pointer in the same clock as the access', 'The pointers are stepped by the next instruction in the pipeline', 'The memories are addressed by the program counter', 'The multiplier adds the stride to the address'],
      answer: 0,
      explain: 'The operand names a pointer and a mode. The memory reads at the pointer as it is, and the generator\'s adder computes the next value alongside, ready for the next clock.',
      why: ['', 'The core is single-cycle; there is no later instruction doing it.', 'The program counter addresses the program memory; the data memories have pointers of their own.', 'The multiplier only sees the two words read; the address arithmetic is separate.'],
    },
    {
      question: 'The pointer p0 holds 9, the window is base 4 and length 6, and the instruction is x(p0)+c. Which word is read, and what does p0 hold afterwards?',
      options: ['Word 9; p0 holds 4', 'Word 10; p0 holds 11', 'Word 4; p0 holds 5', 'Word 9; p0 holds 10'],
      answer: 0,
      explain: 'The access uses the pointer as it was, word 9. The update then adds 1, gets 10 = base + length, and takes the base: 4.',
      why: ['', 'The update happens after the access, so the read is at 9, not 10.', 'The read is at the old pointer; the wrap only shows in the update.', 'The window is 4 to 9: 10 is outside it, so the update wraps instead.'],
    },
  ],
  circbuf: [
    {
      question: 'A 64-tap filter keeps its delay line in a circular window. What does a new sample cost compared with a delay line kept in order?',
      options: ['One store, instead of 63 moves', 'Nothing at all: the sample is not stored', 'Two stores, one for the data and one for the pointer', 'The same, but in fewer clocks'],
      answer: 0,
      explain: 'In order, every new sample shifts the other 63 along. In a ring it overwrites the oldest and only the pointer moves, and the wrap is part of the access.',
      why: ['', 'The 64 samples are stored either way; the ring saves the moves, not the memory.', 'The pointer is updated by the access itself, not by a store.', 'The moves are not made at all; it is not a faster way of making them.'],
    },
    {
      question: 'A circular window has base 4 and length 6, and a pointer starts at 12 with mode +c. What does it visit?',
      options: ['12, 13, 14: it never wraps', '12, 4, 5', '12, 9, 8', '12, 13, 4'],
      answer: 0,
      explain: 'The wrap fires when the next address equals base + length, which is 10. A pointer outside the window just steps and never meets it.',
      why: ['', 'The pointer is not pulled into the window; there is no test for "above".', 'That is −c from the base, a different mode and start.', 'Nothing in the update compares against the pointer\'s own value; only 10 triggers the wrap.'],
    },
  ],
  bitrev: [
    {
      question: 'In bit-reversed mode with m = 4 on an 8-point FFT, the pointer starts at 0. What are the next addresses?',
      options: ['4, 2, 6, 1, 5, 3, 7', '1, 2, 3, 4, 5, 6, 7', '4, 6, 2, 5, 1, 7, 3', '7, 6, 5, 4, 3, 2, 1'],
      answer: 0,
      explain: 'The index bits are reversed: 1 is 001 and goes to 100 = 4, 2 is 010 and stays 2, 3 is 011 and goes to 110 = 6. Counting in that order gives 0, 4, 2, 6, 1, 5, 3, 7.',
      why: ['', 'That is the ordinary count; the mode is there to avoid it.', 'That mixes the order of the pairs; each step is the previous plus the reversed 1.', 'That is the descending count, −1 mode.'],
    },
    {
      question: 'Which modifier steps a pointer through the order of a 64-point FFT?',
      options: ['m = 32', 'm = 64', 'm = 1', 'm = 128'],
      answer: 0,
      explain: 'For N points the modifier is N / 2. With 32 the pointer counts 0, 32, 16, 48, … through all 64 places and back to 0.',
      why: ['', 'Adding 64 in the reversed domain is a different order, not N / 2.', 'A modifier of 1 toggles the lowest bit and never visits all places.', 'm = 128 walks the 256-point order: 0, 128, 64, 192, …'],
    },
  ],
  hwloop: [
    {
      question: 'What does the loop unit do when the PC reaches the end address of an active loop and the count is above 1?',
      options: ['The next PC is the start address, with no fetch for a jump', 'It fetches a branch instruction and executes it', 'It stalls one clock to reload the count', 'It halts the core'],
      answer: 0,
      explain: 'The comparator on the PC replaces the next address with the start. No branch instruction exists in the loop, which is why a one-instruction loop is one clock a pass.',
      why: ['', 'There is no branch in the loop body; that is the point.', 'The count is decremented in the same clock; there is no stall.', 'Halting is a separate instruction.'],
    },
    {
      question: 'A 64-tap sample costs 71 clocks on the core, of which 64 are the loop. Where do the other 7 go?',
      options: ['The load, the store, the loop set-up, the round, the output, the count and the outer branch', 'The loop unit, one clock a pass', 'The pointer steps, one for each memory', 'The second multiplier'],
      answer: 0,
      explain: 'Everything outside the inner loop is still instructions: N + 7 a sample, which is why the cost a product approaches 1 only as the filter lengthens.',
      why: ['', 'The loop unit adds no clocks; the 64 are the passes themselves.', 'The pointers step in the access, with no clocks of their own.', 'It sits idle and costs no clocks.'],
    },
  ],
  mulaw: [
    {
      question: 'Why does μ-law do so much better than 8 uniform bits on a quiet sine, and no better near full scale?',
      options: ['Its steps grow with the level, so they are fine where the signal is small', 'It uses more bits for the quiet samples', 'It filters the noise out', 'It samples faster when the signal is small'],
      answer: 0,
      explain: 'A quiet signal lives in the first segments, whose steps are 2 and 4 wide; near full scale the step is 256, coarser than a uniform step of 64.',
      why: ['', 'Every sample has 8 bits; what changes is the size of the step each code stands for.', 'Quantization noise is not filtered; it is made smaller where the step is smaller.', 'The sample rate is the same, 8,000 a second.'],
    },
    {
      question: 'G.711\'s μ-law code for silence is 0xFF. Why is it not 0?',
      options: ['The code is sent inverted: a positive sample\'s code is 255 − n', 'Silence is the largest sample', 'The sign bit is set for zero', 'A zero byte is reserved for synchronisation'],
      answer: 0,
      explain: 'G.711 complements the sign, segment and step, so zero crossings give a long run of ones and the quietest codes are the largest bytes.',
      why: ['', 'Silence is the smallest magnitude; only the transmitted bits are complemented.', 'The sign bit of a positive sample is set in the inverted code, and zero counts as positive.', 'Nothing in G.711 reserves a code for that; the inversion has its own reason.'],
    },
  ],
  adpcm: [
    {
      question: 'ADPCM never sends its step size. How does the decoder know it?',
      options: ['It moves the step by the same table, from the same codes, as the encoder', 'The step is fixed by the standard', 'It is sent once at the start of the call', 'It is read from the signal\'s level'],
      answer: 0,
      explain: 'After each code the index moves by a table of the code\'s magnitude. Both sides apply that to the same codes from the same start, so they stay in step.',
      why: ['', 'It changes at every sample, between 7 and 32,767.', 'One value at the start could not adapt to the voice.', 'The decoder sees only the codes, not the original signal.'],
    },
    {
      question: 'An ADPCM encoder meets a sudden loud onset after silence. What happens to its error?',
      options: ['It is large for several samples while the step grows by up to 8 places each time', 'It is zero: the codes adapt instantly', 'It is large for the rest of the signal', 'It becomes negative'],
      answer: 0,
      explain: 'The step can grow only as fast as the table moves, so the prediction needs several samples to catch up, as in the step to 1,000 above that took six.',
      why: ['', 'The index moves at most 8 places a sample, not all the way at once.', 'Once the step has caught up, the error falls to the level of the step.', 'The error is the difference between sample and prediction; its sign varies, and its size is the issue.'],
    },
  ],
  lpc: [
    {
      question: 'What does the response of the LPC filter 1 / A(z) trace in a voiced frame?',
      options: ['The spectral envelope, with the formants as peaks', 'Each harmonic of the pitch exactly', 'The pitch of the speaker', 'The noise floor alone'],
      answer: 0,
      explain: 'Ten all-pole coefficients draw a smooth curve over the spectrum, whose peaks are the resonances of the vocal tract. The harmonics stay in the residual.',
      why: ['', 'It would take many more coefficients than ten to follow the harmonics.', 'The pitch is in the source, so in the residual, not in the envelope.', 'The envelope rises above the floor at each formant.'],
    },
    {
      question: 'Why are the reflection coefficients, not the predictor coefficients, what a vocoder quantizes?',
      options: ['Each is inside ±1 for any real signal, so a quantized set keeps the filter stable', 'They need fewer multiplications', 'They are always positive', 'They equal the formant frequencies'],
      answer: 0,
      explain: 'A lattice filter with every coefficient inside ±1 is stable. Rounding the predictor\'s own coefficients can put a pole outside the unit circle.',
      why: ['', 'The number of multiplications is not the reason.', 'They take both signs; the limit is on their size.', 'They are dimensionless and do not read as frequencies.'],
    },
  ],
  vocoder: [
    {
      question: 'Why is SNR no measure of the 2.4 kb/s vocoder?',
      options: ['It does not try to match the waveform', 'Its noise is always zero', 'Its rate is too low to measure', 'SNR only applies to music'],
      answer: 0,
      explain: 'It builds a new waveform with the same envelope and pitch. Sample by sample it differs from the input almost everywhere, however natural or machine-like it sounds.',
      why: ['', 'The output differs from the input almost everywhere; there is a lot of error.', 'SNR does not depend on the rate.', 'It applies to any waveform coder, speech included.'],
    },
    {
      question: 'The vocoder sends 54 bits every 180 samples at 8 kHz. What is its rate?',
      options: ['2,400 b/s', '8,000 b/s', '1,200 b/s', '54,000 b/s'],
      answer: 0,
      explain: '180 samples at 8 kHz are 22.5 ms, so 54 bits / 0.0225 s = 2,400 b/s, a twenty-seventh of μ-law\'s 64 kb/s.',
      why: ['', 'That is one bit a sample; it sends 54 for every 180.', 'That would be 27 bits a frame.', 'That would be 54 bits every millisecond.'],
    },
  ],
  mdct: [
    {
      question: 'One MDCT frame of 2M samples is transformed and inverted alone. What comes back?',
      options: ['The windowed frame with its halves folded: first half minus its mirror, second half plus its mirror', 'The original frame exactly', 'Only the first M samples', 'Zero, because the transform is not invertible'],
      answer: 0,
      explain: 'The MDCT loses the difference between each half and its mirror image. Overlap-adding the neighbouring frame supplies the opposite alias, and the two cancel.',
      why: ['', 'Exact recovery needs the neighbour\'s overlap; alone the aliasing remains.', 'Both halves come back, each with an alias.', 'It returns something nonzero and wrong in a known way, which the overlap repairs.'],
    },
    {
      question: 'For a frame of 2M samples, how many coefficients does the MDCT give?',
      options: ['M', '2M', '4M', 'M / 2'],
      answer: 0,
      explain: 'Half as many as its samples, and since frames overlap by half, exactly one coefficient per sample overall: critically sampled.',
      why: ['', 'That would double the data and make the transform oversampled.', 'That is four times more numbers than the signal has.', 'That would lose information.'],
    },
  ],
  masking: [
    {
      question: 'A loud tone at 1 kHz. Which is better hidden: a faint tone a Bark above it or a Bark below?',
      options: ['The one above: masking falls 10 dB a Bark upward and 25 downward', 'The one below', 'Both the same', 'Neither: masking only works at the same frequency'],
      answer: 0,
      explain: 'The spread is asymmetric. A Bark above the masker the mask is 24 dB under it (10 + 14); a Bark below it is 39 dB under (25 + 14).',
      why: ['', 'Below, the mask falls off faster, so less of it reaches the tone.', 'The spread is not symmetric.', 'It extends over neighbouring bands, which is why a codec can use it.'],
    },
    {
      question: 'Why does giving bits by the mask leave a lower SNR but sound better?',
      options: ['Its noise sits under the mask in each band, while bits by signal leave some audible', 'It uses more bits than the other', 'It removes the noise', 'SNR measures it wrongly'],
      answer: 0,
      explain: 'At 64 kb/s bits by signal reach 49.4 dB and leave 11.3 % of the band-frames above their mask; bits by mask reach 21.4 dB and leave 1.0 %.',
      why: ['', 'It spends fewer: 49.4 kb/s against 63.9.', 'Quantization always adds noise; it only chooses where.', 'SNR counts every band alike; it does not weigh by what is heard.'],
    },
  ],
  barkscale: [
    {
      question: 'Why does a codec group its coefficients in bands a Bark wide, not a fixed number of hertz?',
      options: ['The ear\'s resolution and masking are roughly constant on the Bark scale', 'Bands of equal hertz cost more bits', 'The MDCT only has bands of that width', 'It makes the transform exact'],
      answer: 0,
      explain: 'A Bark is about 107 Hz wide near the bottom and about 1 kHz between 4 and 8 kHz. A noise level that is masked in one Bark band is masked across it.',
      why: ['', 'The cost in bits does not depend on how the bands are cut.', 'The MDCT has evenly spaced coefficients; the grouping is chosen by the codec.', 'The transform is exact whatever the grouping.'],
    },
    {
      question: 'At 16 kHz the 256 coefficients of an MDCT frame form 20 bands about a Bark wide. Which band holds more coefficients?',
      options: ['The top one: 28, against 4 at the bottom', 'The bottom one', 'All hold the same', 'It depends on the signal'],
      answer: 0,
      explain: 'The coefficients are evenly spaced in hertz while a Bark is wider the higher the frequency, so the top band covers many more of them.',
      why: ['', 'A Bark is narrow there; the first band is 4 coefficients wide (125 Hz).', 'Equal widths in Bark are unequal in hertz.', 'The bands are fixed by the scale, not by the signal.'],
    },
  ],
  nco: [
    {
      question: 'What sets how finely the oscillator can be tuned: the table size or the phase register?',
      options: ['The phase register: steps of fs / 2^16, 14.65 Hz at 960 kHz', 'The table size', 'The multiplier width', 'The number of stations'],
      answer: 0,
      explain: 'The tuning word is added to the phase every clock, so the frequency moves in steps of the sample rate over 2<sup>16</sup>. The table only decides how coarse the staircase of the wave is.',
      why: ['', 'The table sets the spur level, not the resolution of the tuning.', 'The multipliers belong to the mixer, after the oscillator.', 'The tuning word has nothing to do with how many stations exist.'],
    },
    {
      question: 'The oscillator\'s table goes from 6 to 8 bits. What happens to the spur and the cost?',
      options: ['The spur falls about 12 dB (36.0 to 48.1) and the oscillator grows from 3,146 to 13,658 NANDs', 'The spur falls 6 dB and the cost doubles', 'The spur is unchanged and the cost rises 4 %', 'Both are unchanged'],
      answer: 0,
      explain: 'About 6 dB a bit while the table\'s words allow, and a table of 2<sup>k</sup> steps doubles for every bit; two bits are nearly a factor of four in size.',
      why: ['', 'That is for one bit; there are two.', 'The staircase gets finer, so the spur does change.', 'Both change: a bigger table costs more and is more accurate.'],
    },
  ],
  complexmixer: [
    {
      question: 'Tuned to −300 kHz, where does a station at +340 kHz end up in a band of ±480 kHz?',
      options: ['At −320 kHz: +640 kHz wraps round the band', 'At +40 kHz', 'At +640 kHz', 'At 0 Hz'],
      answer: 0,
      explain: 'The mixer subtracts the tuned frequency: 340 − (−300) = +640 kHz. The band is only ±480 kHz, so it wraps to 640 − 960 = −320 kHz.',
      why: ['', 'That would be the sum 340 + (−300), the wrong sign.', '640 kHz is outside the band; the sampled signal cannot hold it.', 'Only the station at the tuned frequency lands at zero.'],
    },
    {
      question: 'Why use a complex mixer (four multiplications) instead of one multiplication by cos θ?',
      options: ['The real mixer makes the sum and the difference, folding a mirror image onto the station', 'It is cheaper', 'A real mixer cannot tune below 0', 'It needs no table'],
      answer: 0,
      explain: 'Multiplying by cos θ alone is multiplying by e<sup>jθ</sup> and e<sup>−jθ</sup> together. The complex product keeps only the difference frequency.',
      why: ['', 'The complex mixer needs four multipliers and two adders; it costs more.', 'A real mixer tunes anywhere; its trouble is the mirror image.', 'Both mixers need the oscillator\'s tables.'],
    },
  ],
  fmdiscriminator: [
    {
      question: 'Why does the discriminator take the angle of z[n] · conj(z[n−1]) instead of subtracting the two angles?',
      options: ['The product\'s angle is already the small difference, with no 2π to undo', 'It is cheaper than a subtraction', 'It removes the noise', 'Angles of complex samples cannot be computed'],
      answer: 0,
      explain: 'Two angles each wrapped at ±π differ by a number off by 2π whenever one has just wrapped. The product\'s angle is the phase turn in one sample directly.',
      why: ['', 'It costs a complex multiplication, more than a subtraction; cost is not the reason.', 'It does not touch the noise.', 'atan2 computes exactly that.'],
    },
    {
      question: 'At the CIC\'s 240 kHz, a tone at +25 kHz reaches the discriminator with the deviation 50 kHz. What does it read?',
      options: ['0.500, whatever the amplitude', '0.250', '1.000', 'It depends on the amplitude'],
      answer: 0,
      explain: 'The output is the frequency over the deviation: 25 / 50 = 0.5. The angle of the product ignores how large the samples are.',
      why: ['', 'That would be 12.5 kHz of deviation.', 'That is a tone at the full deviation, 50 kHz.', 'Amplitude scales the product\'s length, not its angle.'],
    },
  ],
  emphasis: [
    {
      question: 'What would the listener get if the receiver skipped the de-emphasis?',
      options: ['Too much treble, with the high-frequency noise at full strength', 'Nothing: de-emphasis only matters for noise', 'The audio at half speed', 'Only the bass'],
      answer: 0,
      explain: 'The transmitter boosted the treble by the curve de-emphasis cuts. Without the cut the programme is bright and the noise, which rises towards the top, is not reduced.',
      why: ['', 'It also changes the sound: the two curves are inverses.', 'The sample rate and pitch are unaffected.', 'The boost was on the treble, so the treble is what stays too strong.'],
    },
    {
      question: 'At 10 kHz, how does the chapter\'s discrete pre-emphasis compare with the analogue 75 µs network?',
      options: ['It lifts 11.07 dB where the analogue lifts 13.66', 'They lift the same', 'It lifts 13.66 dB where the analogue lifts 11.07', 'The discrete one cuts the treble'],
      answer: 0,
      explain: 'Both are first-order, but the discrete pair at 24 kHz has a different response shape from the analogue network; it is not the broadcast standard.',
      why: ['', 'The two curves differ by 2.6 dB at 10 kHz.', 'The analogue network lifts more, not less.', 'Pre-emphasis boosts the treble by definition.'],
    },
  ],
};
