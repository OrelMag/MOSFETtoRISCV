// Check yourself for the Signal processing level: converters, filters that learn, pictures. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';
import { ECHO_FIGS as EF } from '../dsp/echofigs';

export const CHECK11D: Record<string, Quiz[]> = {
  enob: [
    {
      question: 'A 10-bit converter is specified at 9.0 effective bits on a full-scale sine. What SNDR does that mean?',
      options: ['55.9 dB: 6.02 × 9 + 1.76', '62.0 dB: 6.02 × 10 + 1.76', '54.2 dB: 6.02 × 9 alone', '90 dB: ten decibels a bit'],
      answer: 0,
      explain: 'A perfect converter of b bits reaches 6.02 b + 1.76 dB on a full-scale sine, so nine effective bits are 55.9 dB, and the tenth bit is below the noise.',
      why: ['', 'That is what a perfect 10-bit converter would reach; this one is a bit short of it.', 'That leaves out the 1.76 dB that a full-scale sine contributes.', 'A bit is a factor of two in amplitude, which is 6.02 dB, not 10.'],
    },
    {
      question: 'The same converter is tested with a half-scale sine instead of a full-scale one, its noise unchanged. What do the effective bits read?',
      options: ['About one bit fewer: 6 dB less signal', 'The same: the noise has not changed', 'About two bits fewer: 12 dB less', 'About half a bit fewer: 3 dB less'],
      answer: 0,
      explain: 'The formula assumes full scale. Half the amplitude is 6.02 dB less signal over the same noise, which is exactly one effective bit.',
      why: ['', 'The ratio of signal to noise has changed, and effective bits are read from the ratio.', 'Half the amplitude is 6 dB, which is one bit; two bits would need a quarter of the amplitude.', 'Three decibels is half the power; half the amplitude is a quarter of it.'],
    },
  ],
  sar: [
    {
      question: 'Going from 8 to 12 bits, what changes in a successive-approximation converter?',
      options: ['12 clocks instead of 8, with one comparator still', '4095 comparators instead of 255', '8 clocks still, but a finer DAC', '16 clocks, one for each new comparator'],
      answer: 0,
      explain: 'It makes one trial a bit with the same comparator, so b bits take b clocks. The 255 and 4095 comparators are a flash converter\'s.',
      why: ['', 'That is the flash converter, which decides all bits at once and pays 2^b − 1 comparators for it.', 'Each added bit is another trial, so the clock count rises with the bits.', 'A SAR has no extra comparators to wait for; 12 bits are 12 trials.'],
    },
    {
      question: 'Why must the DAC inside a SAR be as accurate as the converter\'s result?',
      options: ['Every trial compares the input with a level the DAC makes', 'The comparator copies the DAC\'s noise into the clock', 'The DAC sets how many clocks a conversion needs', 'It is the only part that dissipates power'],
      answer: 0,
      explain: 'The code is the set of trials the input passed, each against a level from the DAC. An error in a level is an error in a decision, and decisions are never revisited.',
      why: ['', 'The comparator and the clock are separate; the DAC\'s errors reach the result through the levels it compares against.', 'Clocks are b whatever the DAC; its accuracy changes which code comes out, not how many trials.', 'Power is not the issue; accuracy is.'],
    },
  ],
  r2r: [
    {
      question: 'An ideal 8-bit R–2R ladder is given code 128. What does it put out, as a share of the reference?',
      options: ['0.5: the MSB alone, 128 / 256', '0.996: the top code, 255 / 256', '0.25: the second bit', '0.0039: one step, 1 / 256'],
      answer: 0,
      explain: 'Each bit counts half as much as the one before, and code 128 is only the MSB set. The output is the code over 256, so the top code gives 0.996 and one step is 0.0039.',
      why: ['', 'That is code 255, with every bit set; code 128 has only the MSB.', 'The second bit alone is code 64.', 'That is code 1, the LSB alone.'],
    },
    {
      question: 'At one step of an imperfect ladder the DNL is −1.3 LSB. What does that say?',
      options: ['The output went down when the code went up', 'The output is 1.3 LSB below the ideal line', 'The step is 1.3 times larger than one LSB', 'The ladder has lost 1.3 bits'],
      answer: 0,
      explain: 'DNL is the step\'s size against one LSB, minus one. At −1.3 the step is −0.3 LSB: the next code gives a lower output than the one before.',
      why: ['', 'That would be an INL figure, the distance from the line through the ends.', 'A step larger than one LSB has a positive DNL; this one is negative.', 'DNL is about one step at a time and has no unit of bits.'],
    },
  ],
  jitter: [
    {
      question: 'A clock with 1 ps RMS jitter samples a 10 MHz full-scale sine. What does jitter limit the SNR to?',
      options: ['84 dB: 2π f σ is 6.3 × 10⁻⁵', '104 dB, the figure for 1 MHz', '64 dB, the figure for 100 MHz', 'It depends on the number of bits'],
      answer: 0,
      explain: '2π f σ is 6.3 × 10⁻⁵, whose −20 log₁₀ is 84 dB. Each ten times the frequency costs 20 dB, and the bits do not enter.',
      why: ['', 'That is the limit at 1 MHz; ten times the frequency is 20 dB worse.', 'That is the limit at 100 MHz; this input is ten times lower.', 'The formula has the signal\'s frequency and the jitter in it, and no bits.'],
    },
    {
      question: 'With the input fixed, the clock\'s jitter doubles. What happens to the jitter-limited SNR?',
      options: ['It falls by 6 dB', 'It falls by 3 dB', 'It falls by 12 dB', 'It does not change'],
      answer: 0,
      explain: 'The limit is −20 log₁₀(2π f σ), so doubling σ adds 20 log₁₀ 2 = 6.02 dB to the term: the error doubles in amplitude.',
      why: ['', 'That would be the figure for a doubling of the error power; the jitter doubles the error amplitude.', 'That would be a quadrupling of σ.', 'The jitter is in the formula; only a change in the signal\'s frequency would offset it.'],
    },
  ],
  sigmadelta: [
    {
      question: 'What does the one-bit DAC in the digital sigma-delta loop cost in gates?',
      options: ['Nothing: wires and an inverted decision bit', 'A resistor ladder with one rung for each bit', 'A multiplier by plus or minus one', 'A register as wide as the integrators'],
      answer: 0,
      explain: 'The words for + and − full scale differ only in their top bits, so the DAC is the decision, inverted, on some wires.',
      why: ['', 'That is the multi-bit DAC the one-bit loop avoids.', 'The words need no multiplication; the levels are fixed and the decision selects between them.', 'No storage is needed to turn a bit into one of two words.'],
    },
    {
      question: 'Why does a one-bit converter need no matched components to be linear?',
      options: ['Two levels always lie on a straight line', 'A filter after it averages out the mismatch', 'The feedback measures and trims each level', 'Its levels are made equal by calibration'],
      answer: 0,
      explain: 'Any two points make a straight line, so a one-bit DAC cannot be out of line with itself, whatever its levels are. Rate is traded for the bits that matching would have cost.',
      why: ['', 'Averaging is how bits are gained, but it cannot make a mismatch among many levels linear; here there are only two.', 'The loop has no step that measures the levels.', 'No calibration is used, and none is needed with two levels.'],
    },
  ],
  noiseshaping: [
    {
      question: 'A second-order loop moves the quantizer\'s error to high frequencies. What happens to its total power?',
      options: ['It rises about six-fold: 1² + 2² + 1²', 'It is unchanged: the error is only moved', 'It falls to zero outside the band', 'It falls to a sixth of what it was'],
      answer: 0,
      explain: '(1 − z⁻¹)² has coefficients 1, −2 and 1, whose squares sum to 6, about 7.8 dB. The band that is kept gets quieter; the rest gets much louder, and a filter removes it.',
      why: ['', 'Moved, yes, but through a filter whose gain is large at high frequencies, so the total goes up.', 'The error is not removed anywhere; it is there at full strength and more, out of the band.', 'The shaped error has more power than the original, not less.'],
    },
    {
      question: 'Why does an order-1 loop measure erratically while order 2 follows the theory closely?',
      options: ['Its error falls into patterns tied to the input', 'Its integrator overflows at every input', 'It has fewer bits than the order-2 loop', 'Theory gives it 6 dB, which is hard to see'],
      answer: 0,
      explain: 'Theory says 9 dB a doubling, and the loop wanders between 6 and 11, since its error falls into patterns tied to the input instead of behaving as white noise.',
      why: ['', 'It keeps its integrator within range at the levels measured; the cause is the error\'s pattern.', 'Both loops have one-bit outputs and the same word width.', 'Theory gives order 1 nine decibels a doubling, not six.'],
    },
  ],
  wiener: [
    {
      question: 'Roughly how many operations does Levinson\'s recursion need for a 128-tap Wiener filter?',
      options: ['About 16 thousand: 128², Toeplitz', 'About 2 million: 128³, as for any matrix', 'About 128: one step for each tap', 'About 4096: 128 steps of 32 operations each'],
      answer: 0,
      explain: 'A stationary input makes R Toeplitz, a constant along each diagonal, and Levinson exploits that: n² = 16 384 operations where a general solver does n³ = 2 097 152.',
      why: ['', 'That is the cost of a general solver, which ignores the structure of R.', 'Each step of the recursion does work in proportion to the taps so far, not one operation.', 'The recursion grows its solution one tap at a time, doing work in proportion to the taps so far.'],
    },
    {
      question: 'Two different input signals have the same autocorrelation and the same cross-correlation with d. What follows for their best filters?',
      options: ['They are the same: only R and p enter', 'They differ in the phase of the samples', 'They differ by the way d was made', 'No best filter exists for either'],
      answer: 0,
      explain: 'R w = p contains the signals only through R and p. Any pair of signals with the same correlations has the same Wiener solution.',
      why: ['', 'Correlations average over the phase of the individual samples, so they do not show it.', 'The solution needs no model of how d was produced.', 'The bowl has a bottom whenever R is invertible, which is the case here.'],
    },
  ],
  lms: [
    {
      question: 'Plain LMS is stable. The input gets ten times louder in amplitude. What happens to the step limit 2 / (N σ²)?',
      options: ['It falls a hundredfold, with the power', 'It falls tenfold, with the amplitude', 'It does not change: μ is only a number', 'It rises tenfold'],
      answer: 0,
      explain: 'σ² is the power, which goes as the amplitude squared. A step that was safe can be far over the new limit, and NLMS avoids that by dividing by the input\'s power.',
      why: ['', 'The limit has the power in it, and power is the square of amplitude.', 'The limit is a property of the input\'s energy as well as of μ.', 'More power in the filter\'s samples means a smaller allowed step.'],
    },
    {
      question: 'What does LMS use to estimate the gradient of the error at each sample?',
      options: ['The current error and input samples alone: −2 e x', 'The autocorrelation matrix, estimated over a block', 'The echo path\'s impulse response, if known', 'Levinson\'s recursion on the last n samples'],
      answer: 0,
      explain: 'One sample gives a noisy estimate of the slope, −2 e x, and on average the steps go downhill. No correlations are formed and no model is needed.',
      why: ['', 'That is what the Wiener solution needs; LMS goes without it.', 'If it were known, there would be nothing to learn.', 'That solves for the bottom of the bowl in one go; LMS walks instead.'],
    },
  ],
  echocancel: [
    {
      question: 'What does ERLE measure in an echo canceller?',
      options: ['How far the echo has been brought down, in dB', 'How loud the far end is at the speaker', 'How many taps the filter has learnt so far', 'How long the room\'s echo lasts'],
      answer: 0,
      explain: `Echo return loss enhancement is the echo's power over the power left after subtraction, in decibels: ${EF.erle.toFixed(1)} dB over the last quarter of the chapter's run.`,
      why: ['', 'The far end\'s level is the input; ERLE compares the echo with what remains.', 'The taps are a design choice, and ERLE would not count them.', 'The room\'s tail is a property of the path, not a measure of the canceller.'],
    },
    {
      question: `Near-end talk starts and ends. Over the last second, with learning left on, ERLE is ${EF.talkOn.toFixed(1)} dB; with learning frozen it is ${EF.talkHeld.toFixed(1)}. How much does leaving it on lose?`,
      options: [`About ${Math.round(EF.talkHeld - EF.talkOn)} dB`, 'About 2 dB', `About ${Math.round(EF.talkOn)} dB`, 'Nothing: the voice ended'],
      answer: 0,
      explain: `The voice lands in the error while it lasts and drives the coefficients away from the path; ending it does not undo that. The difference is about ${Math.round(EF.talkHeld - EF.talkOn)} dB.`,
      why: ['', `That is too small; the figures given are ${EF.talkOn.toFixed(1)} and ${EF.talkHeld.toFixed(1)}.`, 'That is what is left with learning on, not what is lost.', 'The damage was done while the voice lasted and stays.'],
    },
  ],
  separable: [
    {
      question: 'A 9 × 9 box blur is a row of nine equal weights times a column of nine. How many multiplications a sample, done as two passes?',
      options: ['18', '81', '9', '162'],
      answer: 0,
      explain: 'A row pass of 9 and a column pass of 9. Applied whole, the kernel would need 81.',
      why: ['', 'That is the whole kernel, 9 × 9.', 'That is one of the two passes.', 'That counts both passes as if each were the whole kernel.'],
    },
    {
      question: 'How can you tell that a 3 × 3 kernel is separable?',
      options: ['Every row is a multiple of one row', 'It is symmetric about its centre', 'Its entries add up to 1', 'All nine entries are non-zero'],
      answer: 0,
      explain: 'A product c[j] r[i] has rows that are all multiples of r. The sharpening kernel is symmetric and fails: its first row is not a multiple of its second.',
      why: ['', 'The sharpening kernel is symmetric and is not separable.', 'Unit gain is a matter of scale and says nothing about the structure.', 'The Sobel kernel has zeros and is separable; entries being non-zero is not the test.'],
    },
  ],
  resampling: [
    {
      question: 'A picture is shrunk four times along each axis. Where does the low-pass before it cut, in cycles a sample of the original?',
      options: ['0.125: 1/(2m) with m = 4', '0.25: 1/m', '0.5: half the original rate', '0.0625: 1/(4m)'],
      answer: 0,
      explain: 'Keeping one sample in four leaves a rate of a quarter, whose Nyquist frequency is an eighth of the original: 1/(2m).',
      why: ['', 'That is the new sample rate, not its Nyquist limit.', 'That is the original Nyquist frequency, which would filter nothing.', 'That cuts at half the frequency the new rate needs, and blurs more than necessary.'],
    },
    {
      question: 'Why can bilinear growing not bring back detail the small picture lost?',
      options: ['It only draws lines between the samples it has', 'It repeats each sample, as the other method does', 'It filters so much that the detail is smoothed away', 'It limits the picture to fewer levels'],
      answer: 0,
      explain: 'The detail is not in the samples any more. Bilinear invents a smooth path between them, which looks better than blocks and adds no information.',
      why: ['', 'Repeating samples is the nearest-neighbour method; bilinear draws lines between them.', 'The smoothness is the result, not the cause; the detail was gone before the growing.', 'The number of levels is not changed by the interpolation.'],
    },
  ],
  dct: [
    {
      question: 'After the shift by 128, what is S(0, 0) of an 8 × 8 block?',
      options: ['Eight times the mean of the shifted samples', 'The largest sample in the block', 'The sum of the other 63 coefficients', 'Zero for any smooth block'],
      answer: 0,
      explain: 'With C(0) = 1/√2 on both axes the definition gives ¼ × ½ × the sum of 64 samples, which is 64 × mean / 8: eight times the mean.',
      why: ['', 'It is built from every sample, not only the largest.', 'The coefficients are independent amounts of different patterns, not parts of a sum to match.', 'Only a block of exactly mid-grey is all zeros; a smooth bright sky has a large S(0, 0).'],
    },
    {
      question: 'On the chapter\'s scene, which of these 8 × 8 blocks has the fewest coefficients of size 10 or more?',
      options: ['The sky, with 2', 'The checks, with 28', 'The rings, with 46', 'The sun\'s edge, with 53'],
      answer: 0,
      explain: 'A smooth block needs only a few low-frequency patterns, while edges and texture spread the energy over many coefficients.',
      why: ['', 'Checks are a fine pattern, and 28 of their coefficients are large.', 'Rings carry edges in several directions, and spread to 46.', 'An edge is full of high frequencies, so it needs 53.'],
    },
  ],
  quanttable: [
    {
      question: 'At libjpeg quality 25, how is Table K.1 scaled, and what is the DC step?',
      options: ['200 %, so 32', '150 %, so 24', '25 %, so 4', '50 %, so 8'],
      answer: 0,
      explain: 'Below quality 50 the scale is 5000 / q percent: 5000 / 25 = 200, which doubles K.1\'s 16 to 32.',
      why: ['', 'That is 200 − 2q, the formula for qualities above 50.', 'Quality is not a percentage of the table.', 'That halves the table, which is the scale at quality 75, not 25.'],
    },
    {
      question: 'A coefficient of 37 is divided by a table entry of 16 and rounded. What does the decoder get back?',
      options: ['32: rounded to 2, times 16', '37: the division is undone exactly', '48: rounded up to 3', '16: only the table entry survives'],
      answer: 0,
      explain: '37 / 16 = 2.31 rounds to 2, and the decoder multiplies by 16: 32. The error is 5, never more than half the entry, 8.',
      why: ['', 'The rounding is the loss; it cannot be undone.', 'Rounding is to the nearest whole number, and 2.31 is nearer 2.', 'The level 2 comes back multiplied by the entry, not replaced by it.'],
    },
  ],
  zigzag: [
    {
      question: 'A block\'s AC levels in zig-zag order are 5, 0, 0, −2, then zeros to the end. How many Huffman symbols does its AC part need?',
      options: ['3: two (run, size) pairs and EOB', '63: one for each coefficient', '4: one for each value listed', '2: only the non-zero values'],
      answer: 0,
      explain: 'The 5 is (0, 3), the −2 after two zeros is (2, 2), and one EOB ends the block. The zeros are counted into the pairs, never sent alone.',
      why: ['', 'Zeros are not sent one at a time.', 'The two zeros are folded into the run count of the −2, and the end needs a symbol.', 'The block still has to be ended, which takes an EOB.'],
    },
    {
      question: 'Why is S(0, 0) sent as a difference from the previous block\'s?',
      options: ['Neighbouring means are close, so the difference is small', 'S(0, 0) cannot be coded by a Huffman table', 'It lets the decoder skip the first block', 'The difference is always zero'],
      answer: 0,
      explain: 'Adjacent blocks in a picture usually have similar mean levels, so the difference falls in a low size category and takes few bits.',
      why: ['', 'The DC table codes size categories, with 12 symbols, and handles it well.', 'Every block is decoded; the first is relative to zero.', 'Only equal means give zero; most neighbours differ a little.'],
    },
  ],
  huffman: [
    {
      question: 'How much of its Huffman code does a JPEG file carry?',
      options: ['BITS and HUFFVAL: counts and symbols', 'Every code word in full', 'A tree of branch bits for each table', 'A table of how often each symbol occurs'],
      answer: 0,
      explain: 'Sixteen counts and the symbols in order are enough: the codes follow by counting, each length starting where the shorter ones ended, doubled.',
      why: ['', 'The code words are rebuilt by the decoder, not sent.', 'No tree is stored; the canonical form makes it unnecessary.', 'The frequencies were used to design the code, and are not in the file.'],
    },
    {
      question: 'The symbol (0, 3) has a 3-bit code and the coefficient is 5. How many bits does it take in all?',
      options: ['6: the 3-bit code and 3 magnitude bits', '3: the code alone', '8: one byte', '4: the code and a sign'],
      answer: 0,
      explain: 'The code names the pair; the magnitude follows in as many plain bits as the size says: 5 is 101 in 3 bits.',
      why: ['', 'The magnitude comes behind the code as plain bits.', 'The symbol is a byte, but the bits sent are the code and the extra bits.', 'There is no separate sign bit: a negative value is coded in the extra bits.'],
    },
  ],
  jpeg: [
    {
      question: 'The chapter\'s 36 864-byte picture is a 3932-byte file at quality 50. What is the ratio?',
      options: ['9.4 to 1: raw bytes over file bytes', '0.11 to 1: file bytes over raw bytes', '4.7 to 1: half the file taken up by headers', '36.9 to 1: raw size over a thousand'],
      answer: 0,
      explain: '36 864 / 3932 = 9.4. Headers and tables are about 8 % of that file, so the coded data are most of it.',
      why: ['', 'That is the inverse, a fraction of the raw size.', 'Headers are about 8 % of the file, not half.', 'That divides the raw size by a thousand, which is no part of the arithmetic.'],
    },
    {
      question: 'Why is a coded byte of 0xFF followed by a 0 in a JPEG file?',
      options: ['So that it is never taken for a marker', 'To pad the data to a whole word', 'To mark the end of a block', 'To check the data for transmission errors'],
      answer: 0,
      explain: 'Markers begin with 0xFF. The coded data may contain that byte by chance, so a zero is stuffed after it and removed by the decoder.',
      why: ['', 'No word alignment is needed; the stuffing is only after 0xFF.', 'A block ends with EOB, a Huffman code, not a byte.', 'JPEG carries no check of that kind in the baseline data.'],
    },
  ],
};
