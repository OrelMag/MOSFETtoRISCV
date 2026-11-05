// The noise chapter's models (DOM-free): thermal noise, a decision against it, the matched filter, a chain's noise figure, and Shannon's
// limit met by real random codes. Closed forms held to seeded Monte Carlo in tests/comm-noise.test.ts; the curves are comm/ber.ts's.

import { gaussian, qFunc, rng } from '../phys/line';
import { sigmaOf } from './ber';
import { dbToRatio, ratioToDb } from './limits';

export const BOLTZMANN = 1.380649e-23;
/** The reference temperature of noise figures, kelvin. */
export const T0 = 290;

/** Thermal noise power density, dBm per hertz. */
export const noiseDensityDbm = (kelvin = T0): number => 10 * Math.log10(BOLTZMANN * kelvin * 1000);
/** The noise floor in a bandwidth: density + 10 log B + the receiver's noise figure. */
export const noiseFloorDbm = (hz: number, nfDb = 0, kelvin = T0): number => noiseDensityDbm(kelvin) + 10 * Math.log10(hz) + nfDb;
/**
 * The floor with a source at `kelvin` and a receiver of this noise figure. A noise figure is quoted against a 290 K source: the receiver adds
 * (F − 1) · 290 K of its own whatever the source's temperature, so cooling only the source soon stops helping.
 */
export const receiverFloorDbm = (hz: number, nfDb: number, kelvin = T0): number => 10 * Math.log10(BOLTZMANN * (kelvin + (dbToRatio(nfDb) - 1) * T0) * hz * 1000);
/** The open-circuit RMS noise voltage of a resistor, √(4 k T R B) (Johnson, Nyquist 1928). */
export const johnsonVolts = (ohms: number, hz: number, kelvin = T0): number => Math.sqrt(4 * BOLTZMANN * kelvin * ohms * hz);

/** The chance a level 2d apart from the other is read wrong, with the threshold half way and Gaussian noise. */
export const decisionError = (halfGap: number, sigma: number): number => qFunc(halfGap / sigma);

/** Two levels ±1 and the threshold at 0, `n` noisy samples: the share that fall on the wrong side. */
export function measuredDecision(sigma: number, n: number, seed: number): number {
  const u = rng(seed);
  let wrong = 0;
  for (let i = 0; i < n; i++) if (1 + sigma * gaussian(u) < 0) wrong++;
  return wrong / n;
}

// ---- the matched filter -----------------------------------------------------------------------------------------------------------

export const PULSE_SAMPLES = 16;

export interface PulseDef { id: string; name: string; shape: number[] }

const pulse = (id: string, name: string, f: (t: number) => number): PulseDef => ({ id, name, shape: Array.from({ length: PULSE_SAMPLES }, (_, i) => f((i + 0.5) / PULSE_SAMPLES)) });

export const PULSES: readonly PulseDef[] = [
  pulse('rect', 'Rectangle', () => 1),
  pulse('sine', 'Half a sine', (t) => Math.sin(Math.PI * t)),
  pulse('ramp', 'A falling ramp', (t) => 1 - t),
];

export interface ReceiverDef { id: string; name: string; weights: (shape: readonly number[]) => number[] }

/** What the receiver does with the samples of a symbol: a weighted sum, compared with 0. */
export const RECEIVERS: readonly ReceiverDef[] = [
  { id: 'one', name: 'Look at one sample, the largest', weights: (p) => { const m = Math.max(...p); let done = false; return p.map((v) => { const pick = !done && v === m; if (pick) done = true; return pick ? 1 : 0; }); } },
  { id: 'avg', name: 'Average them all', weights: (p) => p.map(() => 1) },
  { id: 'matched', name: 'Weigh each by the pulse (matched)', weights: (p) => [...p] },
];

export const energyOf = (p: readonly number[]): number => p.reduce((m, v) => m + v * v, 0);

/** The SNR after a weighted sum, as a power ratio: (Σ p w)² / (σ² Σ w²). Cauchy–Schwarz: largest at w ∝ p, and there it is E / σ². */
export function snrAfter(p: readonly number[], w: readonly number[], sigma: number): number {
  const top = p.reduce((m, v, i) => m + v * w[i], 0);
  return (top * top) / (sigma * sigma * energyOf(w));
}

/** The error rate that SNR gives on ±pulse. */
export const errorAfter = (snr: number): number => qFunc(Math.sqrt(snr));

/** ±pulse in white noise through the weights: `n` random symbols, the share read wrong. */
export function measuredReceiver(p: readonly number[], w: readonly number[], sigma: number, n: number, seed: number): number {
  const u = rng(seed);
  let wrong = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < p.length; k++) sum += (p[k] + sigma * gaussian(u)) * w[k];
    if (sum < 0) wrong++;
  }
  return wrong / n;
}

/** Uncoded ±1 at this Eb/N0, measured. */
export function measuredBer(ebn0Db: number, bits: number, seed: number): number {
  return measuredDecision(sigmaOf(ebn0Db, 1), bits, seed);
}

// ---- a chain ------------------------------------------------------------------------------------------------------------------------

export interface ChainStage { name: string; gainDb: number; nfDb: number }

/** Friis: each stage's excess noise counts divided by the gain before it. */
export function cascadeNfDb(stages: readonly ChainStage[]): number {
  let f = 1, gain = 1;
  for (const s of stages) { f += (dbToRatio(s.nfDb) - 1) / gain; gain *= dbToRatio(s.gainDb); }
  return ratioToDb(f);
}

// ---- Shannon, measured -------------------------------------------------------------------------------------------------------------

/**
 * A random code: 2^k codewords of n bits, each bit drawn at random, one codebook a trial. Send one word through Gaussian noise; the
 * receiver takes the nearest word (the best any receiver can do). The share of words read wrong. This is the code of Shannon's proof.
 */
export function randomCodeError(n: number, k: number, ebn0Db: number, trials: number, seed: number): number {
  const u = rng(seed), words = 2 ** k, sigma = sigmaOf(ebn0Db, k / n);
  const book = new Int8Array(words * n), y = new Float64Array(n);
  let wrong = 0;
  for (let t = 0; t < trials; t++) {
    for (let i = 0; i < book.length; i++) book[i] = u() < 0.5 ? -1 : 1;
    for (let j = 0; j < n; j++) y[j] = book[j] + sigma * gaussian(u); // word 0 was sent: the book is random, so any will do
    let best = 0, bestIdx = 0;
    for (let w = 0; w < words; w++) {
      let c = 0;
      for (let j = 0; j < n; j++) c += book[w * n + j] * y[j];
      if (w === 0 || c > best) { best = c; bestIdx = w; }
    }
    if (bestIdx !== 0) wrong++;
  }
  return wrong / trials;
}

/** Capacity in bit/s at signal power over noise density `pn0` (hertz) in bandwidth `hz`. */
export const capacityAt = (pn0: number, hz: number): number => hz * Math.log2(1 + pn0 / hz);
/** Its limit with bandwidth unbounded: more band does not help past this. */
export const capacityCeiling = (pn0: number): number => pn0 / Math.LN2;
