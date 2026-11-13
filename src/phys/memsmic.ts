// A digital MEMS microphone, from pressure to PDM bits (DOM-free, tested): the Infineon IM69D130's datasheet where it says,
// a typical silicon membrane where it does not, and the converters chapter's own sigma-delta loop and CIC for the bits.
//
// Sourced (IM69D130 datasheet v1.0, 2017-12-19): dual backplate (backplate, membrane, backplate), the ASIC's preamplifier,
// sigma-delta ADC and 1-bit PDM interface; sensitivity −36 dBFS at 94 dB SPL (1 kHz); acoustic overload 130 dB SPL; clock
// 3.072 MHz typical; positive pressure raises the density of 1s; the package (widgets/mems3dkit.ts).
// Typical (no teardown found): a round polysilicon membrane between two perforated backplates, its size and gaps a typical
// design's; σ, the membrane's residual stress, is fitted so the stack gives −38 dBV/Pa, the figure Infineon's SENSOR 2013
// paper gives for its analog chips (Dehé, Wurzer, Füldner, Krumbein, doi 10.5162/sensor2013/A4.3), not this part's.
//
// The membrane is tension-dominated (thin, under residual stress): under a pressure difference P it bows as
//   w(r) = P (a² − r²) / (4 σ h),
// zero at the clamped edge. Each backplate makes a capacitor with it, C = ∫ ε₀ / gap(r) dA over the deflected shape; the
// pressure from the port pushes the membrane towards one plate and away from the other, so one C rises as the other falls,
// and with the plates biased ±V_b the membrane's voltage is V_b (C₁ − C₂) / (C₁ + C₂).

import { SdLoop, SD_LIMIT } from '../dsp/converters';
import { cicTaps } from '../dsp/multirate';

export const EPS0 = 8.8541878128e-12;
/** Reference pressure of dB SPL (Pa, RMS). */
export const P_REF = 20e-6;
export const splToPa = (db: number): number => P_REF * 10 ** (db / 20);
export const paToSpl = (pa: number): number => 20 * Math.log10(pa / P_REF);

/** IM69D130 datasheet: sensitivity (dBFS at 94 dB SPL = 1 Pa RMS, 1 kHz), acoustic overload point (dB SPL), clock (Hz), SNR (dB(A)). */
export const IM69 = { sensDbfs: -36, aop: 130, clock: 3.072e6, snr: 69, rolloff: 28, latencyUs: 6 } as const;

/** The typical membrane: radius, thickness, density (polysilicon), gap to each backplate (m), the plates' bias (V). */
export const TYPICAL = { a: 0.5e-3, h: 0.5e-6, rho: 2330, gap: 2e-6, vb: 10 } as const;
/** The figure σ is fitted to: Infineon's 2013 analog chips, dBV/Pa. */
export const FIT_DBV = -38;

export interface Membrane { a: number; h: number; rho: number; gap: number; vb: number; sigma: number }

/** Deflection (m, towards backplate 1) at radius r under a pressure difference p (Pa). */
export const deflection = (m: Membrane, p: number, r: number): number => (p * (m.a * m.a - r * r)) / (4 * m.sigma * m.h);
/** The mean deflection over the membrane's area: P a² / (8 σ h). */
export const meanDeflection = (m: Membrane, p: number): number => (p * m.a * m.a) / (8 * m.sigma * m.h);

const RINGS = 96;
/** The two capacitances (F) at pressure p: backplate 1 (the gap closing for p > 0) and backplate 2. */
export function capacitances(m: Membrane, p: number): [number, number] {
  let c1 = 0, c2 = 0;
  for (let i = 0; i < RINGS; i++) {
    const r = ((i + 0.5) / RINGS) * m.a, dA = 2 * Math.PI * r * (m.a / RINGS), w = deflection(m, p, r);
    c1 += (EPS0 * dA) / (m.gap - w);
    c2 += (EPS0 * dA) / (m.gap + w);
  }
  return [c1, c2];
}
/** The membrane's voltage (V) at pressure p, the plates at ±V_b. */
export const membraneVolts = (m: Membrane, p: number): number => { const [c1, c2] = capacitances(m, p); return (m.vb * (c1 - c2)) / (c1 + c2); };
/** Small-signal sensitivity, V per Pa, and in dBV/Pa. */
export const sensitivity = (m: Membrane): number => membraneVolts(m, 1e-3) / 1e-3;
export const sensitivityDbv = (m: Membrane): number => 20 * Math.log10(sensitivity(m));
/** The fundamental resonance of a tensioned circular membrane in vacuum (no air loading): 2.405 / (2π a) · √(σ / ρ). */
export const resonanceHz = (m: Membrane): number => (2.405 / (2 * Math.PI * m.a)) * Math.sqrt(m.sigma / m.rho);

/** σ (Pa) that gives the stack the sensitivity `dbv` (bisection: sensitivity falls as σ rises). */
export function fitSigma(dbv = FIT_DBV, base: Omit<Membrane, 'sigma'> = TYPICAL): number {
  let lo = 1e5, hi = 1e9;
  for (let k = 0; k < 80; k++) {
    const mid = Math.sqrt(lo * hi);
    if (sensitivityDbv({ ...base, sigma: mid }) > dbv) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}
/** The typical membrane with its fitted σ. */
export const MEMBRANE: Membrane = { ...TYPICAL, sigma: fitSigma() };

// ---------------------------------------------------------------- the ASIC: gain, the loop, the CIC

/** The converters chapter's chain (widgets/dspconverters.ts CHAIN, held equal by a test): loop order, word, CIC order, ÷. */
export const MIC_CHAIN = { order: 2 as const, w: 16, N: 3, R: 64 };
/** The loop's full-scale input per pascal (instantaneous): 0 dBFS is a sine whose peak is full scale, so 1 Pa RMS (√2 Pa
 *  peak) is −36 dBFS of peak. The ASIC's gain is this, divided by the membrane's V/Pa: fitted to the datasheet, not modelled. */
export const FS_PER_PA = 10 ** (IM69.sensDbfs / 20) / Math.SQRT2;
/** The loudest tone the chapter's loop holds (dB SPL): its input's peak at SD_LIMIT. The datasheet's AOP sits at 0 dBFS, past it. */
export const MAX_SPL = paToSpl((SD_LIMIT / FS_PER_PA) / Math.SQRT2);
/** The output rate: the clock ÷ R (48 kHz). */
export const PCM_RATE = IM69.clock / MIC_CHAIN.R;

export interface MicRun {
  /** The PDM bits, 1 / 0, one a clock. */
  bits: number[];
  /** The membrane's mean deflection (m) at each clock, and the pressure (Pa). */
  defl: number[]; pressure: number[];
  /** The CIC's words at the low rate, as a share of full scale (DC gain normalised). */
  words: number[];
}

/** A tone of `spl` dB SPL at `hz` through the microphone for n clocks: pressure → membrane → volts → the ASIC's gain → the
 *  chapter's loop (bits) → the chapter's CIC (words). Above MAX_SPL the input is clipped at the loop's limit. */
export function micRun(spl: number, hz: number, n: number, m: Membrane = MEMBRANE, phase0 = 0): MicRun {
  const { order, w, N, R } = MIC_CHAIN, loop = new SdLoop(order, w), sv = sensitivity(m), gain = FS_PER_PA / sv;
  const amp = splToPa(spl) * Math.SQRT2, bits: number[] = [], defl: number[] = [], pressure: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = amp * Math.sin(phase0 + (2 * Math.PI * hz * i) / IM69.clock);
    const level = Math.max(-SD_LIMIT, Math.min(SD_LIMIT, membraneVolts(m, p) * gain));
    loop.edge(Math.round(level * loop.fs));
    bits.push(loop.bit); defl.push(meanDeflection(m, p)); pressure.push(p);
  }
  return { bits, defl, pressure, words: cicWords(bits, N, R) };
}

/** The chapter's CIC (order N, ÷ R) on ±1 bits, every R-th output, normalised by its DC gain R^N. */
export function cicWords(bits: readonly number[], N = MIC_CHAIN.N, R = MIC_CHAIN.R): number[] {
  const taps = cicTaps(N, R), g = R ** N, out: number[] = [];
  for (let k = taps.length; k <= bits.length; k += R) {
    let s = 0;
    for (let j = 0; j < taps.length; j++) s += taps[j] * (bits[k - 1 - j] ? 1 : -1);
    out.push(s / g);
  }
  return out;
}
