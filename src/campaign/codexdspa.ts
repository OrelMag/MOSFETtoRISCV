// Codex entries for the Signal processing level: numbers that fit, the z-plane. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9a.ts, the questions codexcheck11a.ts,
// the numbers pinned by tests/content-codexdspa.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_A: CodexEntry[] = [
  E('qformat', 'Q format', 'tool', `Qm.f is a two's complement word read as an integer divided by 2^f; the hardware is the same adder for every format and the format is a promise the designer keeps. Q1.15 is 16 bits, the sign counted as the one integer bit: −1 to 1 − 2⁻¹⁵ = 32 767 / 32 768 in steps of 2⁻¹⁵. A fraction times a fraction is a fraction, so a product (Q2.30) comes back to Q1.15 by dropping 15 bits, not 16: forget that and every answer is half what it should be. In Q1.7, 96 × 64 (0.75 × 0.5) is 48 (0.375).`, ['twos', 'overflow', 'rounding', 'ieee754']),
  E('saturate', 'Saturating arithmetic', 'concept', `When a sum passes full scale an adder wraps, from the largest word to the most negative, a jump of nearly two full scales; a saturating one stops at the rail. Built in gates it is an adder one bit wider, an XOR on the top two bits of the sum and a mux with the limit made from wires: 118 NANDs at 8 bits against 72 for a plain one, 222 against 144 at 16. Two tones given 6 dB of gain (peak 1.8 × full scale) in 16 bits keep 11.1 dB with saturation and −2.1 dB when they wrap. Inside a long sum, though, wrapping is the safer rule.`, ['overflow', 'guardbits', 'headroom', 'qformat']),
  E('guardbits', 'Guard bits', 'concept', `Extra bits above an accumulator's product, so that a sum of n products never leaves the word: log₂ n of them, 8 for 256 terms and 10 for 1 024. Two's complement addition is arithmetic modulo 2^w, so a sum that wraps along the way is still right if its final value fits, while a clamp along the way loses what a later term would have cancelled: eight words that truly sum to 75 in an 8-bit accumulator end at 75 wrapped and at −38 saturated. Hence a 16-bit DSP's 40-bit accumulator, 32 for a product and 8 guard bits, and one clamp at the end.`, ['overflow', 'saturate', 'twos', 'headroom']),
  E('headroom', 'Scaling and headroom', 'concept', `Every shift down throws bits away and adds rounding noise; a later gain raises that noise with the signal. So attenuate late, amplify early, and keep the word as full as it can be without ever passing the top. A tone at a tenth of full scale with a gain of 1 made from 3 bits down and 3 up keeps 59.7 dB down first and 78.1 dB up first. How far the peak can go is a bet about the input: the sum of |h[n]| bounds it for any input (3.2 needs 2 bits of headroom), a gain at one frequency covers tones, a measured peak covers what you expect.`, ['qformat', 'guardbits', 'saturate', 'rounding']),
  E('diffeq', 'Difference equation', 'tool', `y[n] = b₀x[n] + b₁x[n−1] + … − a₁y[n−1] − a₂y[n−2] − …: the output is a weighted sum of recent inputs and recent outputs. With no a terms an input stops mattering after a fixed number of samples (FIR); with them a sample stays in the output for ever, fading if the filter is well made (IIR). The cost reads off the equation: a multiplication per coefficient, an addition per term after the first, a word of memory per delay. y[n] = 0.1 x[n] + 0.9 y[n−1] answers an impulse 0.1, 0.09, 0.081, 0.0729, … .`, ['firfilter', 'convolution', 'ztransform', 'polezero']),
  E('convolution', 'Convolution', 'tool', `Feed in a single 1 and a linear, time-invariant filter gives its impulse response h; any input is a list of scaled, delayed impulses, so the output is the same list of scaled, delayed copies of h added up: y[n] = Σ h[k] x[n−k]. Slide, multiply, add. N samples through M taps give N + M − 1 samples at N × M multiplications; 6 samples through 3 taps give 8. In frequency the operation is a plain product, Y(f) = H(f) X(f), which is why a long filter can be run through an FFT; in the z-transform it is the product of two polynomials.`, ['firfilter', 'diffeq', 'ztransform', 'fft']),
  E('ztransform', 'The z-transform', 'tool', `Let z⁻¹ mean one sample later; a filter's taps become a polynomial, and the ratio B(z) / A(z) of the numerator and feedback polynomials is all there is to a filter. Cascading filters multiplies the polynomials (taps 1, 1 and 1, −1 give 1, 0, −1), the same thing as convolving the taps. Put z = e^(j2πf) and H(z) is the gain and phase at f: as f goes from 0 to half the sample rate z walks the top of the unit circle. FIR5 is (1 + z⁻¹)⁴, 1, 4, 6, 4, 1, with a gain (relative to DC) of cos⁴(πf): 0.25 at a quarter of the sample rate, 0 at half.`, ['diffeq', 'convolution', 'polezero', 'firfilter']),
  E('polezero', 'Poles and zeros', 'concept', `The roots of B(z) are zeros and the roots of A(z) poles; gain at f is the product of the distances from the point on the circle to the zeros over the product of those to the poles. A zero on the circle removes its frequency exactly; a pole near it makes a peak, and rings: rⁿ, so 152 samples to fall to 1 % at r = 0.97 and 459 at 0.99. Every pole must be inside the circle for stability. A pole and a zero at one angle make a notch, 0.34 of full gain just off the null with the pole at 0.8 and 0.97 at 0.98.`, ['ztransform', 'diffeq', 'minphase', 'fft']),
  E('minphase', 'Minimum phase and group delay', 'concept', `A zero moved to its mirror image across the circle (radius r to 1/r, same angle) keeps the gain's shape and reverses the taps; only the delay changes. The zero inside gives the least delay a gain can have, the minimum-phase one, and near its angle the group delay (minus the slope of phase against frequency) goes negative. Taps 1, −0.76, 0.49 and their reverse have identical gain and group delays of −1.96 and 3.96 samples at 0.16; together they are symmetric, delay 2 at every frequency: (N − 1) / 2 samples for N taps, 57 for 115. A pole cannot be mirrored out of the circle.`, ['polezero', 'ztransform', 'firfilter', 'convolution']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_A: Record<string, string> = {
  qformat: 'fixed',
  saturate: 'fixed',
  guardbits: 'fixed',
  headroom: 'fixed',
  diffeq: 'zplane',
  convolution: 'signals',
  ztransform: 'zplane',
  polezero: 'zplane',
  minphase: 'zplane',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_A: Record<string, string[]> = {
  qformat: ['Q15', 'Q1.15'],
  saturate: ['saturating adder'],
  guardbits: ['guard bit'],
  diffeq: ['difference equation'],
  convolution: ['convolve', 'convolves', 'convolved'],
  ztransform: ['z-transform'],
  polezero: ['poles and zeros'],
  minphase: ['minimum phase', 'group delay'],
};
