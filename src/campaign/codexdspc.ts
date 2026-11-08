// Codex entries for the Signal processing level: IIR and stability, changing the rate, CORDIC. Same shape as codex.ts, gathered by codexdsp.ts; the fuller texts are codexmore9c.ts, the questions codexcheck11c.ts,
// the numbers pinned by tests/content-codexdspc.test.ts. No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_C: CodexEntry[] = [
  E('iirfilter', 'IIR filter', 'component', `An infinite-impulse-response filter feeds its own past outputs back: y[n] = Σ b[k] x[n − k] − Σ a[k] y[n − k]. The feedback makes poles, so a few coefficients give a sharpness an FIR filter needs hundreds of taps for. For one mask (pass to 0.1 cycles a sample with 0.1 dB of ripple, stop from 0.125 at 60 dB) the elliptic design is order 8 in 4 sections and 20 multiplications a sample, against 58 for the shortest folded FIR filter of 115 taps. The price: phase that is not linear, a state that feeds back, and poles that must stay inside the unit circle with the coefficients a register can hold.`, ['firfilter', 'feedback', 'polezero', 'ztransform', 'biquad']),
  E('bilinear', 'Bilinear transform', 'tool', `A map from an analog filter's s-plane to the z-plane: z = (2 + s) / (2 − s), for one sample a second. The imaginary axis becomes the unit circle and the left half-plane its inside, so a stable analog design gives a stable digital one. All frequencies from 0 to infinity are squeezed onto half a turn, f = atan(ω / 2) / π, so scaling a prototype by 2π f misplaces the edge: 0.1 lands at 0.0969 and 0.4 at 0.286. Prewarping to 2 tan(π f) puts it back; for 0.2 that is 1.453 where 2π f would give 1.257.`, ['iirfilter', 'polezero', 'ztransform', 'biquad']),
  E('biquad', 'Biquad', 'component', `A second-order IIR section: y[n] = b₀x[n] + b₁x[n − 1] + b₂x[n − 2] − a₁y[n − 1] − a₂y[n − 2], five multiplications and two poles. In gates it is direct form I: five 16 × 16 multipliers of 3572 NANDs each, a 35-bit accumulator that keeps every product bit, one rounding, one clamp and four delay registers, 20 313 NANDs in all and 135 NAND delays from one clock edge to the next. A high-order filter is a cascade of these, because a section can be checked, scaled and rounded one pole pair at a time.`, ['iirfilter', 'coefsens', 'limitcycle', 'saturate', 'guardbits', 'arraymul']),
  E('coefsens', 'Coefficient sensitivity', 'concept', `Round a filter's coefficients to a b-bit word, a step of 2<sup>−(b − 2)</sup>, and its poles move to the nearest lattice point, by an amount set by how closely the other poles crowd it. A pole at radius 0.97 and 0.04 cycles a sample is held at radius 0.968 by 6 bits, exactly on the unit circle by 5 and as a double pole at z = 1 by 4. The narrow elliptic filter of the chapter, as one degree-6 polynomial, is unstable at every width from 8 to 19 bits; as three sections it is stable from 8. The worst pole's sensitivity is about 3021 per unit of rounding as a polynomial and 6.5 in a section.`, ['biquad', 'iirfilter', 'qformat', 'polezero', 'limitcycle']),
  E('limitcycle', 'Limit cycle', 'concept', `A steady output that a stable filter keeps making after its input has stopped, sustained by rounding inside the feedback loop. A biquad with a₁ = 0 and a₂ = 14 787 / 2¹⁴ (radius 0.95), given one word of 8000, rings down and then repeats 5, 0, −5, 0 for ever, inside the dead band ½ / (1 − a₂) = 5.13 LSB. Rounding toward zero removes it for a₁ = 0 by proof, and left no cycle in a 176-case sweep where floor still left 59 and four more bits in the fed-back outputs 22. A wider accumulator changes nothing: the rounding that matters comes after it.`, ['biquad', 'coefsens', 'iirfilter', 'saturate', 'guardbits', 'headroom']),
  E('decimation', 'Decimation', 'tool', `Keeping every R-th sample. The new rate has a new half-rate, and everything above it folds into the band, indistinguishable from what belonged there: a tone at 0.3 of the input rate, decimated by 4, is 1.2 cycles a sample and lands at 0.2 of the new rate. So the filter comes first, at the old rate, where it costs most: ÷ 64, keeping 40 % of the new rate and 50 dB down from 60 %, is 1037 taps, 1037 multiplications for each input sample. Polyphase branches, half-band stages and a CIC exist to pay less for that one filter; the chapter's cascade gets it to 1.05.`, ['aliasing', 'polyphase', 'cic', 'halfband', 'interpolation', 'firfilter']),
  E('interpolation', 'Upsampling and interpolation', 'tool', `Going up by L: put L − 1 zeros between the samples. The spectrum is unchanged but now repeats L times across the new rate, because the zeros made images, and a low-pass filter at the new rate removes them and fills the zeros in. Most of its inputs are zeros, so its taps split into L branches and each output needs only every L-th tap, taps / L multiplications. A tone at 0.1 of the old rate, up by 4, stands at 0.025 with images at 0.225, 0.275 and 0.475. Up by L, filter, down by M is any rational rate change, one filter doing both jobs.`, ['decimation', 'polyphase', 'halfband', 'aliasing', 'resampling']),
  E('polyphase', 'Polyphase filter', 'trick', `Filtering and then keeping one output in R computes R − 1 outputs in every R and throws them away. Polyphase sorts the taps by index mod R, so each branch holds every R-th tap, sees every R-th input sample. The same products are added in another order: identical in integers, equal to rounding in floating point. N taps cost N / R multiplications for each input sample, 8 for 64 taps and ÷ 8. The chapter's gates (R = 4, 16 taps, 8-bit words) use 4 multipliers of 972 NANDs instead of 16, 7809 NANDs in all.`, ['decimation', 'interpolation', 'firfilter', 'transposed', 'multacc']),
  E('halfband', 'Half-band filter', 'trick', `A filter for halving the rate, with its cut-off at a quarter of the rate. A windowed sinc there is zero at every even distance from its middle, so half the taps vanish, and symmetry lets the rest share multipliers: 23 taps have 13 that are not zero and need 6 multipliers and a shift for the middle tap, which is exactly ½: under a third of its length. Its edge is broad, centred on a quarter of the rate, which suits a stage with plenty of room left, and it takes several in a row to go far: six halvings of the chapter's job cost 4.03 multiplications for each input sample, against 1037 for one filter.`, ['decimation', 'linearphase', 'windowdesign', 'polyphase', 'firfilter']),
  E('cic', 'CIC filter', 'component', `Cascaded integrator-comb: a moving average of R samples rearranged as an integrator at the high rate and a comb at the low rate, N of each. Adders and registers only, with no multiplier and no sample memory. Its response (sin(π R f) / (R sin(π f)))<sup>N</sup> has a null at every multiple of the new rate, exactly the frequencies that fold onto DC. The registers wrap harmlessly but must be N log₂ R bits wider than the input: 8-bit samples at order 3 and ÷ 8 need 17 bits, and the DC gain is 512. It droops and rejects well only near its nulls, so a short ordinary filter follows it at the low rate. In gates (order 3, ÷ 8) it is 3010 NANDs.`, ['decimation', 'overflow', 'twos', 'firfilter', 'polyphase', 'guardbits']),
  E('cordic', 'CORDIC', 'component', `The COordinate Rotation DIgital Computer turns a vector by a fixed sequence of angles atan 2<sup>−i</sup>, each one way or the other, so each cross term of a rotation is a shift and a stage is three adders with no multiplier. Rotating steers the angle to 0 and reads sine and cosine; vectoring steers y to 0 and reads arctangent and magnitude, with the same adders. A 14-bit, 12-stage pipeline is 15 537 NANDs for 9.0 good bits and a result every clock; the iterative form is 2551 NANDs for 13 clocks a result. One 16 × 16 multiplier alone is 3572.`, ['cordicgain', 'minsky', 'mixer', 'shiftadd', 'arraymul', 'fft']),
  E('cordicgain', 'CORDIC gain', 'law', `Every CORDIC stage lengthens the vector by √(1 + 2<sup>−2i</sup>) whichever way it turns, since cos(−θ) = cos θ. The product tends to 1.6468 (after 1, 2 and 3 stages 1.4142, 1.5811 and 1.6298), so starting at x = 0.607253 pays for it once, up front, and no multiplier is needed at the end. It holds only because no stage may be skipped. A vector √2 long grows to 2.33 times the range of either coordinate, so x and y need two more bits at the top than the result.`, ['cordic', 'minsky', 'headroom', 'guardbits']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_C: Record<string, string> = {
  iirfilter: 'zplane',
  bilinear: 'iir',
  biquad: 'iir',
  coefsens: 'iir',
  limitcycle: 'iir',
  decimation: 'radio',
  interpolation: 'multirate',
  polyphase: 'multirate',
  halfband: 'multirate',
  cic: 'radio',
  cordic: 'cordic',
  cordicgain: 'cordic',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_C: Record<string, string[]> = {
  iirfilter: ['recursive filter'],
  bilinear: ['prewarp'],
  biquad: ['biquads', 'second-order section'],
  limitcycle: ['limit cycles'],
  decimation: ['decimate', 'decimator'],
  interpolation: ['interpolator', 'upsample', 'upsampling'],
  polyphase: ['polyphase'],
  halfband: ['half-band'],
  cic: ['CIC'],
};
