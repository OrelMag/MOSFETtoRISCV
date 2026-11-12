// The DAC's output side (chapter "Converters", "The way out: hold and smooth"): a zero-order hold, its sin x / x droop, the images
// around every multiple of the DAC's rate, and the analogue low-pass that removes them. DOM-free. The closed forms here are
// checked against an FFT of a staircase drawn many points a sample (tests/dsp-dachold.test.ts).

import { amplitudeSpectrum, dbOf } from './spectrum';

/** sin(πx) / (πx): the hold's gain at x cycles a sample of the DAC's rate. */
export const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
/** The hold's gain in dB at frequency f for a DAC running at rate fs. */
export const holdDb = (f: number, fs: number): number => 20 * Math.log10(Math.abs(sinc(f / fs)));
/** A Butterworth low-pass of order n with its −3 dB corner at fc: the gentlest steepness for an order (chapter iir). */
export const butterDb = (f: number, fc: number, n: number): number => -10 * Math.log10(1 + (f / fc) ** (2 * n));
/** The smallest Butterworth order whose loss at f reaches `needDb`, corner at fc. */
export const butterOrder = (needDb: number, f: number, fc: number): number =>
  needDb <= 0 ? 0 : Math.ceil(Math.log10(10 ** (needDb / 10) - 1) / (2 * Math.log10(f / fc)));

/** The tone and its images at a DAC rate fs, up to `top`: f, then k·fs ∓ f for k = 1, 2, …. Each with the hold's gain on it. */
export function linesOf(f: number, fs: number, top: number): { f: number; holdDb: number; image: boolean }[] {
  const out = [{ f, holdDb: holdDb(f, fs), image: false }];
  for (let k = 1; k * fs - f <= top; k++) for (const g of [k * fs - f, k * fs + f]) if (g <= top) out.push({ f: g, holdDb: holdDb(g, fs), image: true });
  return out;
}

/** The chapter's case: CD audio, a band to 20 kHz, the first image to end 96 dB under the tone (16 bits' worth). */
export const CD = { fs: 44_100, band: 20_000, keepDb: 96 } as const;

export interface DacRow {
  /** Interpolation factor before the DAC. */
  L: number;
  /** The DAC's rate. */
  fs: number;
  /** The hold's loss at the band's top (negative dB). */
  droopDb: number;
  /** The first image of a tone at the band's top. */
  image: number;
  /** The hold's gain there, relative to the tone's (negative dB). */
  imageRelDb: number;
  /** What the analogue filter must still take off the image, in dB. */
  needDb: number;
  /** The smallest Butterworth order that does it, corner at the band's top. */
  order: number;
}

/** One table row per interpolation factor: what a DAC at L times the CD rate asks of its filter. */
export function dacRow(L: number, c: { fs: number; band: number; keepDb: number } = CD): DacRow {
  const fs = c.fs * L, f = c.band, image = fs - f, droopDb = holdDb(f, fs), imageRelDb = holdDb(image, fs) - droopDb, needDb = c.keepDb + imageRelDb;
  return { L, fs, droopDb, image, imageRelDb, needDb, order: butterOrder(needDb, image, f) };
}

/**
 * The staircase measured: n samples of a tone at `cycles` cycles in the block, each held for `over` points, and the level of the
 * line at each of the given frequencies (cycles a sample of the DAC's rate) in dB, read from the FFT of the held signal. A whole
 * number of cycles in the block puts every line on a bin, so a rectangular window reads them exactly.
 */
export function measuredHold(n: number, cycles: number, over: number, at: readonly number[]): number[] {
  const x: number[] = [];
  for (let k = 0; k < n; k++) { const v = Math.cos((2 * Math.PI * cycles * k) / n); for (let j = 0; j < over; j++) x.push(v); }
  const S = amplitudeSpectrum(x, 'rect');
  // one bin is 1 / n of a sample's rate; f cycles a sample is bin f · n (the spectrum covers `over` sample rates)
  return at.map((f) => dbOf(S[Math.round(f * n)]));
}
