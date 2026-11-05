// Codex entries for the Signal processing level: measuring a spectrum, FIR design. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9b.ts, the questions codexcheck11b.ts,
// the numbers pinned by tests/content-codexdspb.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_B: CodexEntry[] = [
  E('leakage', 'Spectral leakage', 'concept', `A block of N samples is the signal times a rectangle, so every tone is drawn as the rectangle's transform: a main lobe two bins wide and sidelobes that fall 6 dB for each doubling of distance. A tone that fits the block a whole number of times puts every other bin on a zero of that skirt, which is the only reason it ever looks clean. At 10 cycles in 64 samples one bin reads 1; at 10.5 the largest reads 0.646 (3.8 dB low) and all 33 bins read above −60 dB. It is not noise, and it is not a fault of the tone.`, ['windowfn', 'zeropad', 'fourier', 'fft']),
  E('windowfn', 'Window function', 'tool', `Tapering the block to zero at its edges makes the skirt fall faster and the main lobe wider. Rectangle: 2 bins and −13.3 dB for the highest sidelobe; Hann 4 and −31.5; Blackman 6 and −58.1; four-term Blackman–Harris 8 and −92.0. Two more columns matter when you measure: noise bandwidth (Hann 1.5 bins, so its noise floor reads 1.8 dB higher) and the loss for a tone half a bin off a centre (3.92 dB for the rectangle, 1.42 for Hann). None wins on both width and height; the choice is what you expect to find.`, ['leakage', 'zeropad', 'windowdesign', 'fft']),
  E('zeropad', 'Resolution and zero padding', 'concept', `Resolution is how close two equal tones can be and still show a 3 dB dip: 1.55 bins for the rectangle, 2.45 for Hann, 2.8 for Blackman, set by the window and the number of real samples. Appending zeros before the FFT reads the same continuous curve at more points, so the picture is smoother and nothing new is resolved. 64 samples at 8 kHz under Hann, padded to 4,096, still need about 2.45 × 125 Hz = 306 Hz between the tones. Only a longer record narrows the lobe: about 1.55 / Δf samples with a rectangle, 2.45 / Δf with Hann.`, ['leakage', 'windowfn', 'fft', 'fourier']),
  E('spectrogram', 'Spectrogram', 'tool', `A spectrogram is a column of windowed spectra a hop apart: time across, frequency up, level as colour. The frame length N sets both details at once: Hann's main lobe is 4 bins of fs / N, which at 8 kHz is 1,000 Hz at N = 32 and 62.5 Hz at 512, while a frame lasts N / fs, 4 ms and 64 ms. A signal that moves during a frame is smeared. Overlap costs one more transform per hop: 50 % overlap is about twice the transforms, 7/8 about eight times, and with Hann at 50 % the frames add back to a constant.`, ['windowfn', 'zeropad', 'fft', 'fourier']),
  E('overlapsave', 'Overlap-save', 'tool', `Convolution in time is a product in frequency, so a long FIR can run through an FFT, a product and an inverse FFT, block by block. A block of N through M taps gives a circular convolution: the first M − 1 outputs are wrapped round from the tail and are thrown away, and each block repeats the last M − 1 inputs of the one before. L = N − M + 1 samples come out per block: 385 of 512 with 128 taps. Counted in real multiplications a sample, blocks beat the direct form from 44 taps; at 33 taps the best block (256) costs 41.1 against 33.`, ['convolution', 'firfilter', 'fft', 'zeropad']),
  E('goertzel', 'Goertzel algorithm', 'component', `Goertzel computes one DFT bin as a second-order recurrence, s[n] = x[n] + c·s[n−1] − s[n−2] with c = 2 cos(2πf): one multiplication a sample, three more at the end, at any frequency. In gates it is one 16 × 16 multiplier, two adders and two registers, 4,419 NANDs that serve all eight keypad tones in turn. K Goertzels beat an FFT of N points while K < 2 log₂ N, which for 256 samples is 16 bins. Its state is the input times the resonator's impulse-response sum: 252 at the worst keypad tone, so 16 bits for 8-bit input.`, ['fft', 'aliasing', 'guardbits', 'polezero']),
  E('linearphase', 'Linear phase', 'concept', `Symmetric taps, h[k] = h[N − 1 − k], delay every frequency by the same (N − 1) / 2 samples, so a pulse comes out the shape it went in. 114 taps delay 56.5 samples and 115 taps 57; 64 taps at 8 kHz are 31.5 samples, 3.9 ms. It is every zero paired with its mirror across the unit circle, which a causal stable pole cannot do, so it is an FIR privilege. Mirrored taps also halve the multiplications (115 taps need 58) and leave an amplitude that is a cosine polynomial with about N / 2 free numbers. An even length has a zero at z = −1.`, ['firfilter', 'polezero', 'convolution', 'windowdesign']),
  E('windowdesign', 'The window method', 'tool', `Truncate the ideal low-pass sin(2π fc k) / (π k) to N taps and the response is the ideal one smeared by the window's transform: the window sets how far the stopband falls, N sets how narrow the transition is. Both bands come out at the same ripple, so for a mask that allows 0.0058 in the passband and 0.001 in the stopband the passband is about 5 times better than asked. Meeting 60 dB across a transition of 0.025 cycles a sample takes Hamming 489 taps, Hann 269, Blackman 201 and Kaiser (β = 5.65) 147, at odd lengths.`, ['windowfn', 'parksmcclellan', 'linearphase', 'firfilter']),
  E('parksmcclellan', 'Parks–McClellan', 'tool', `Instead of a recipe, minimise the largest weighted error over the bands. The optimum is equiripple: the error touches the same size at no fewer than ⌈N / 2⌉ + 1 frequencies with alternating signs, and the Remez exchange finds it by moving its guesses to the error's peaks, 8 passes here. Weighting the bands as the mask does spends the slack on a narrower transition: the mask of 0.1 dB and 60 dB needs 114 taps where Kaiser's window needs 146, 28 % more multiplications on every sample. At 113 taps the stopband peaks at −59.7 dB and the passband misses too.`, ['windowdesign', 'linearphase', 'firfilter', 'guardbits']),
  E('csd', 'Canonical signed digit', 'trick', `A constant is a sum of powers of two, and a shift is wiring, so a multiplier by a fixed tap is a few adders. Canonical signed digit form writes it with the fewest non-zero digits, never two side by side: 7 = 8 − 1. The tap 13,304 is nine ones in binary and four signed digits, −2³ + 2¹⁰ − 2¹² + 2¹⁴, so three adders and no multiplier. Over the 58 distinct taps of the 115-tap filter binary has 296 ones and signed digits 227, and the constant multipliers cost 43,853 NANDs against 207,176 for general ones. The price is flexibility: change a tap and you have rebuilt the circuit.`, ['shiftadd', 'firfilter', 'arraymul', 'booth']),
  E('transposed', 'Transposed form', 'trick', `Reverse every arrow of the direct form and the same transfer function results, with the input fanned out to all multipliers and the registers holding partial sums that move toward the output. No long adder chain waits behind the last product, so the longest path is one multiplier and one adder, against a multiplier and a tree of 7 adders for 115 taps. The price is in the registers, which are as wide as the accumulator, 34 bits rather than 16. Sharing x[n]·h[k] between mirrored taps makes 300,200 NANDs, against 285,871 for the folded direct form and 473,024 unfolded.`, ['firfilter', 'linearphase', 'multacc', 'csd']),
  E('multacc', 'Multiply–accumulate', 'component', `One multiplier, one accumulator, and a clock N times the sample rate: a ring of sample registers turns a place each clock, a ROM gives the tap for the count, and the accumulator starts afresh at the first tap. The 115-tap filter is 37,057 NANDs against 473,024 in parallel, 13 times fewer, at 115 clocks a sample. The accumulator holds 2 × 16 + 2 = 34 bits, the guard bits asked by Σ|tap| and not by log₂ N, and one rounder and clamp act once on the finished sum. At 48 kHz it needs a 5.52 MHz clock; its gates reach about 315 MHz, so 2.7 million samples a second at most.`, ['firfilter', 'csd', 'guardbits', 'saturate', 'arraymul']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_B: Record<string, string> = {
  leakage: 'spectrum',
  windowfn: 'spectrum',
  zeropad: 'spectrum',
  spectrogram: 'spectrum',
  overlapsave: 'spectrum',
  goertzel: 'spectrum',
  linearphase: 'signals',
  windowdesign: 'firdesign',
  parksmcclellan: 'firdesign',
  csd: 'firdesign',
  transposed: 'firdesign',
  multacc: 'firdesign',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_B: Record<string, string[]> = {
  windowfn: ['Hann window', 'Blackman window'],
  zeropad: ['zero padding', 'zero-padding'],
  spectrogram: ['STFT'],
  overlapsave: ['overlap-add'],
  goertzel: ['Goertzel', 'DTMF'],
  linearphase: ['linear-phase'],
  parksmcclellan: ['Parks-McClellan', 'equiripple'],
  csd: ['CSD'],
  transposed: ['transposed'],
  multacc: ['multiply-accumulate'],
};
