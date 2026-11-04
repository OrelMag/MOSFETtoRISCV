// Nyquist and Shannon (chapter 39). DOM-free.

/** Nyquist (Hartley): at most 2B independent symbols a second through a channel of bandwidth B Hz; M levels carry log2 M bits each. */
export const nyquistSymbolRate = (B: number): number => 2 * B;
export const nyquistBitRate = (B: number, M: number): number => 2 * B * Math.log2(M);
/** Bandwidth (Hz) a binary signal at `baud` symbols a second needs at least. */
export const minBandwidth = (baud: number): number => baud / 2;

/** Decibels and ratios (power). */
export const dbToRatio = (db: number): number => 10 ** (db / 10);
export const ratioToDb = (r: number): number => 10 * Math.log10(r);

/** Shannon-Hartley: capacity (bit/s) of a channel of bandwidth B Hz at signal-to-noise power ratio snr (linear). */
export const shannon = (B: number, snr: number): number => B * Math.log2(1 + snr);
export const shannonDb = (B: number, snrDb: number): number => shannon(B, dbToRatio(snrDb));

/** Levels the noise allows when Nyquist's rate equals Shannon's: 2B log2 M = B log2(1 + SNR), so M = sqrt(1 + SNR). */
export const levelsSupported = (snr: number): number => Math.sqrt(1 + snr);

/** SNR (linear) a spectral efficiency of `bitsPerHz` needs at least: 2^η − 1. */
export const snrNeeded = (bitsPerHz: number): number => 2 ** bitsPerHz - 1;

/** The ultimate limit on Eb/N0 as spectral efficiency goes to zero: ln 2 (−1.59 dB). Eb/N0 = SNR / η at capacity. */
export const EBN0_MIN = Math.LN2;
export const ebn0AtCapacity = (bitsPerHz: number): number => snrNeeded(bitsPerHz) / bitsPerHz;

/** Real systems to mark, with numbers that are published (the channel's SNR is ours to assume, said where used). */
export interface Marked {
  name: string;
  /** Bandwidth (Hz), bit rate achieved (bit/s) and, where the standard fixes it, the symbol alphabet. */
  B: number;
  rate: number;
  levels?: number;
  note: string;
}
export const MARKED: Marked[] = [
  { name: 'Telegraph, 50 baud', B: 25, rate: 50 * (5 / 7.5), levels: 2, note: 'a binary signal at 50 baud needs 25 Hz at least; the 5 data bits of a 7.5-unit character' },
  { name: 'V.34 modem', B: 3100, rate: 33600, note: 'a voice line of about 3.1 kHz, 33.6 kb/s' },
  { name: 'Gigabit Ethernet pair', B: 62.5e6, rate: 250e6, levels: 5, note: '125 Mbaud on each of 4 pairs, 5 levels (PAM-5), 2 bits per symbol after coding: 250 Mb/s a pair' },
];
