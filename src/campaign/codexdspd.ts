// Codex entries for the Signal processing level: converters, filters that learn, pictures. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9d.ts, the questions codexcheck11d.ts,
// the numbers pinned by tests/content-codexdspd.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_D: CodexEntry[] = [
  E('enob', 'SNR and ENOB', 'law', `A converter is judged by what it measures, not by what it delivers. Effective bits are (SNDR − 1.76) / 6.02: the bits a perfect converter would need to do as well. A perfect b-bit one on a full-scale sine reaches 6.02 b + 1.76 dB, 49.9 dB at 8 bits, 74.0 at 12, 98.1 at 16. A 16-bit part that measures 74 dB has 12.0 effective bits, and 62 dB on 14 delivered bits is 10.0. A signal below full scale gets less by exactly its shortfall, so a half-scale tone reads a bit lower.`, ['aliasing', 'thermalnoise', 'decibel', 'jitter', 'sigmadelta']),
  E('sar', 'Successive approximation', 'component', `A successive-approximation converter finds the code by binary search: set the top bit on a DAC, ask one comparator whether the input is above that level, keep or clear the bit, and go on. b bits take b clocks and one comparator, where a flash converter takes one clock and 2<sup>b</sup> − 1 comparators: 255 at 8 bits, 4,095 at 12. The catch is the DAC, which must be as accurate as the result: its largest capacitor is half the total, and 1 % off it moves an 8-bit code by 1.3.`, ['r2r', 'enob', 'jitter', 'sigmadelta']),
  E('r2r', 'R–2R ladder', 'component', `Two resistor values, R and 2R, make a DAC of any width: each bit switches a 2R between 0 and the reference, and from any node the rest of the ladder looks like 2R, so each bit counts half as much as the one before it. Eight bits put out code / 256 of the reference: 0.5 at code 128, 0.996 at 255. The price is matching. With every resistor 1 % out, the worst step is usually at the middle code, where every bit changes at once and the MSB's error shows, and its median is 1.2 LSB; at 3 % a ladder can run backwards.`, ['sar', 'enob', 'sigmadelta', 'positional']),
  E('jitter', 'Sampling jitter', 'concept', `A clock edge σ seconds late samples the signal at the wrong moment, and the error is the signal's slope times σ. For a full-scale sine at f that limits the SNR to −20 log<sub>10</sub>(2π f σ) dB, whatever the converter's bits and sample rate: at 1 ps, 104.0 dB at 1 MHz (17.0 effective bits) and 64.0 dB at 100 MHz (10.3). Ten times the frequency costs 20 dB, more than three bits, which is why a converter that samples a radio's band directly spends more on its clock than on its arithmetic.`, ['enob', 'aliasing', 'skew', 'sar']),
  E('sigmadelta', 'Sigma-delta modulator', 'component', `A sigma-delta modulator trades rate for bits: a one-bit quantizer inside a loop of integrators, run far faster than the signal needs, so that the average of its bits follows the input. At order 2 the output is V = z<sup>−1</sup>U + (1 − z<sup>−1</sup>)<sup>2</sup>E, the signal delayed and the quantizer's error E shaped. One bit has two levels, which cannot be out of line, and its DAC costs no gates; the order-2 loop at 16 bits is 1,579 NANDs, with a CIC at ÷64 5,181. At 64 times the rate and half scale it measures 69.9 dB where the white-noise model says 73.2.`, ['noiseshaping', 'cic', 'decimation', 'enob', 'jitter']),
  E('noiseshaping', 'Noise shaping', 'concept', `Noise shaping moves a quantizer's error out of the band that is kept; it does not remove it. In a second-order loop the error passes through (1 − z<sup>−1</sup>)<sup>2</sup>, whose gain is −52.4 dB at the edge of the band kept at 64 times the rate and +12.0 dB at half the rate. In theory the in-band noise falls (2L + 1) × 3.01 dB a doubling of the rate: 9.0 dB at order 1, 15.1 at order 2. Order 2 measures 13 to 16, and order 1 wanders between 6 and 11. The total error power goes up, six-fold at order 2, and a filter after the loop takes it away.`, ['sigmadelta', 'cic', 'decimation', 'aliasing']),
  E('wiener', 'Wiener filter', 'law', `For an input x and a wanted signal d, the FIR filter w that minimises the mean squared error solves R w = p, R being the autocorrelation of x and p its cross-correlation with d. The error is a quadratic bowl in the coefficients with one bottom, and setting the slope to zero gives the equation. It needs no model of how d was made, only those two sets of correlations. For a stationary input R is Toeplitz, so Levinson's recursion solves it in n² operations instead of n³: 16,384 against 2,097,152 at 128 taps. In the chapter it agrees with scipy's solve_toeplitz to 8 places.`, ['lms', 'echocancel', 'firfilter', 'matchedfilter', 'convolution']),
  E('lms', 'LMS and NLMS', 'tool', `LMS moves every coefficient by μ e x after each sample: e = d − Σ w x, w ← w + μ e x. One sample gives a noisy estimate of the bowl's slope, and on average the steps go downhill: no correlations, no matrix, no model. The step has a limit of 2 over the energy in the filter's samples, set by the loudest stretch for speech: 1.27 on this far end's average power, 0.135 on its loudest 128 samples. NLMS divides by that energy, so μ between 0 and 2 suits any loudness. Learning costs a second multiplier: a tap at 12 bits is 4,580 NANDs, four with their sums 19,188.`, ['wiener', 'echocancel', 'firfilter', 'multacc', 'saturate']),
  E('echocancel', 'Adaptive echo canceller', 'component', `An echo canceller knows the far-end signal exactly and the path not at all: it runs the signal through an adaptive FIR, here 128 taps of NLMS (16 ms at 8 kHz), and subtracts the estimate from the microphone. The figure of merit is ERLE, how far the echo comes down: 30.7 dB over the last quarter of the chapter's run, 10.3 with only 32 taps. Near-end talk lands in the error and wrecks the filter: 7.6 dB once the voice has ended with learning left on, 29.7 with it frozen. It costs 256 multiplications a sample, 2.05 million a second. No G.168 claim is made.`, ['lms', 'wiener', 'equalization', 'firfilter', 'convolution']),
  E('separable', 'Separable 2-D filter', 'trick', `A 2-D kernel that is a product of a row filter and a column filter can be applied as two 1-D passes, 2n multiplications a sample instead of n²: 6 against 9 at 3 × 3, 30 against 225 at 15 × 15, 7.5 times fewer. The binomial blur is [1 2 1] across times [1 2 1] down, and the two passes give the same picture as the whole kernel. The test is that every row is a multiple of one row: the sharpening kernel, a plus shape, fails it. The 8 × 8 DCT is separable too, which turns 4,096 products a block into 1,024.`, ['firfilter', 'convolution', 'dct', 'resampling']),
  E('resampling', 'Resizing an image', 'tool', `Shrinking a picture by m keeps one sample in m along each axis, so detail above 1/(2m) cycles a sample folds into false patterns unless a low-pass runs first: a windowed sinc cut at 1/(2m), 8m + 1 taps (25 at m = 3), done as a row pass and a column pass. Shrunk by 3 and grown back by repeating samples, the zone plate scores 7.8 dB unfiltered and 10.4 filtered. Growing has the opposite problem: repeating makes blocks, and straight lines between neighbours (bilinear) are smoother but cannot return detail the small picture lost: 17.1 dB repeated against 18.0 bilinear on the scene.`, ['decimation', 'interpolation', 'aliasing', 'separable']),
  E('dct', 'Discrete cosine transform', 'tool', `The 8 × 8 DCT writes a block as a sum of 64 fixed patterns, cosines across times cosines down, and gives the amounts. After the shift by 128, S(0, 0) is eight times the block's mean, and a smooth block packs into a few top-left coefficients: the sky block has 2 of size 10 or more, the sun's edge 53. The transform itself loses nothing. It is separable, an 8-point transform on each row and then each column, and one stage needs 22 products by constants and no multiplier: 24,721 NANDs, used sixteen times for a block.`, ['fft', 'separable', 'quanttable', 'jpeg', 'csd']),
  E('quanttable', 'Quantization table', 'concept', `Quantization divides each DCT coefficient by an entry of an 8 × 8 table and rounds: the one step of JPEG that loses information. T.81's example luminance table K.1 runs from 16 at DC to 99 at the highest frequency, fine steps where the eye notices and coarse ones where it forgives. The quality setting is libjpeg's, not the standard's: below 50 the table is scaled by 5000 / q percent, above by 200 − 2q, so the DC step is 80 at quality 10, 16 at 50 and 3 at 90. On the chapter's scene that is 1,920, 3,932 and 10,250 bytes, against 36,864 raw.`, ['dct', 'zigzag', 'jpeg', 'enob']),
  E('zigzag', 'Zig-zag and run lengths', 'trick', `After quantization most of a block is zero, and the file is arranged so that the zeros cost almost nothing. The 63 AC coefficients are read in zig-zag order (T.81 Figure A.6) along the diagonals from low frequency to high, so the zeros of the high frequencies come in one long run at the end. Each non-zero coefficient becomes a symbol of (zeros before it, size of its magnitude), sixteen zeros in a row have ZRL (0xF0), one EOB (0x00) says the rest are zero, and the DC term is sent as its difference from the last block's.`, ['huffman', 'quanttable', 'jpeg', 'dct']),
  E('huffman', 'Huffman code', 'tool', `A Huffman code gives frequent symbols short codes and rare ones long. JPEG does not send the codes but two lists: BITS, how many codes there are of each length 1 to 16, and HUFFVAL, the symbols in order; the codes follow canonically (T.81 Annex C), each length's codes counting up from where the shorter ones ended, doubled. The luminance AC table has 162 symbols: 0x01 and 0x02 take 2 bits, 0x03 takes 3, EOB 4, ZRL 11, and 125 take 16. The magnitude follows the code as plain extra bits, and no code is all ones.`, ['zigzag', 'jpeg', 'shannon', 'linecode']),
  E('jpeg', 'Baseline JPEG', 'concept', `Baseline JPEG is five steps on 8 × 8 blocks: shift by 128, DCT, quantize with a table, zig-zag with run lengths, Huffman. Only the quantization loses information; the rest is exact to rounding. A file is a list of marker segments (SOI, JFIF, DQT, SOF0, DHT, SOS, the coded data, EOI). The chapter's 192 × 192 grey scene is 36,864 bytes raw and 3,932 at quality 50, 9.4 to 1 at 31.0 dB; 1,920 at quality 10 and 10,250 at 90. Written here byte by byte, it is read by libjpeg through Pillow and by the browser, within one level of our own reconstruction.`, ['dct', 'quanttable', 'zigzag', 'huffman', 'fft']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_D: Record<string, string> = {
  enob: 'signals',
  sar: 'converters',
  r2r: 'converters',
  jitter: 'converters',
  sigmadelta: 'converters',
  noiseshaping: 'converters',
  wiener: 'adaptive',
  lms: 'adaptive',
  echocancel: 'adaptive',
  separable: 'pictures',
  resampling: 'pictures',
  dct: 'pictures',
  quanttable: 'pictures',
  zigzag: 'pictures',
  huffman: 'pictures',
  jpeg: 'pictures',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_D: Record<string, string[]> = {
  enob: ['ENOB', 'effective number of bits'],
  sar: ['SAR ADC', 'flash ADC'],
  r2r: ['R-2R'],
  jitter: ['aperture jitter'],
  sigmadelta: ['sigma-delta', 'delta-sigma'],
  noiseshaping: ['noise-shaping'],
  wiener: ['Wiener'],
  lms: ['LMS', 'NLMS', 'least mean squares'],
  resampling: ['bilinear interpolation'],
  dct: ['DCT'],
  quanttable: ['quantization matrix'],
  zigzag: ['zig-zag', 'run-length'],
  huffman: ['Huffman'],
};
