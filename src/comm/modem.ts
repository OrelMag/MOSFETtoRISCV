// Chapter signals's golden models (DOM-free): the numerically controlled oscillator, the FSK modulator and the period-counting
// demodulator that lib/modem.ts builds in gates (exact integer cycle models, compared with the gates every output every
// cycle in tests/comm-modem.test.ts), then the float side: Gray-coded PSK / QAM constellations, their symbol error rate in
// closed form against a seeded Monte Carlo, the modems of the voice-band era and ADSL's bit loading.

import { gaussian, qFunc, rng } from '../phys/line';
import { dbToRatio, ratioToDb, snrNeeded } from './limits';

// ---------------------------------------------------------------------------------------------------------------------
// The oscillator and the FSK pair in gates

/** The sample clock (Hz): 64 samples per bit at 300 baud, and 8 or more per carrier cycle up to 2.4 kHz. */
export const FS = 19200;
/** The phase accumulator's width: the frequency step is FS / 2^13 = 2.34 Hz. */
export const ACC_BITS = 13;
/** The sine table: 2^6 phase steps of the accumulator's top bits, 6-bit offset-binary samples (0 .. 63, centre 31.5). */
export const SINE_K = 6;
export const SINE_W = 6;
export const SINE_TABLE: number[] = Array.from({ length: 2 ** SINE_K }, (_, i) => Math.round(31.5 + 31.5 * Math.sin((2 * Math.PI * (i + 0.5)) / 2 ** SINE_K)));
/** Bit time: samples per bit at 300 baud. */
export const SAMPLES_PER_BIT = FS / 300;

/** The tuning word that puts the oscillator nearest a frequency. */
export const tuningWord = (hz: number): number => Math.round((hz * 2 ** ACC_BITS) / FS);
/** The frequency a tuning word really gives (Hz). */
export const ncoHz = (word: number): number => (word * FS) / 2 ** ACC_BITS;

/** Bell 103 (and the Bell 101 before it): 300 baud FSK, two tones a side, full duplex. A mark (1) is the higher tone. */
export const BELL103 = {
  baud: 300,
  originate: { space: 1070, mark: 1270 },
  answer: { space: 2025, mark: 2225 },
};
/** The originating modem's tuning words, and what they give. */
export const FTW_SPACE = tuningWord(BELL103.originate.space);
export const FTW_MARK = tuningWord(BELL103.originate.mark);

/** The phase accumulator: acc ← acc + word (mod 2^13) at every clock; the sample is the table at the accumulator's top six bits. */
export class NcoModel {
  acc = 0;
  /** The sample in front of the next edge. */
  get sample(): number { return SINE_TABLE[this.acc >> (ACC_BITS - SINE_K)]; }
  clock(word: number): void { this.acc = (this.acc + word) & (2 ** ACC_BITS - 1); }
}

/** FSK_TX: one NCO whose tuning word is chosen by the bit (1: mark). */
export class FskTxModel {
  nco = new NcoModel();
  get sample(): number { return this.nco.sample; }
  clock(bit: number): void { this.nco.clock(bit ? FTW_MARK : FTW_SPACE); }
}

/** A period of at least this many samples between rising zero-crossings is the low tone (a space). Midway: 19200/1070 = 17.9, /1270 = 15.1. */
export const RX_LONG = 17;
/** The counter saturates here (5 bits). */
export const RX_MAX = 31;

/**
 * FSK_RX: the sign bit of a sample is the slicer. A counter measures the samples between rising edges of the sign; at each
 * rising edge the decision register takes "period below RX_LONG" (a mark) and the counter restarts at 1.
 */
export class FskRxModel {
  prev = 0;
  cnt = 0;
  d = 0;
  clock(sample: number): void {
    const sign = sample >> (SINE_W - 1);
    const rise = sign === 1 && this.prev === 0;
    if (rise) this.d = this.cnt >= RX_LONG ? 0 : 1;
    this.cnt = rise ? 1 : this.cnt === RX_MAX ? RX_MAX : this.cnt + 1;
    this.prev = sign;
  }
}

/** Modulate bits at SAMPLES_PER_BIT samples each: the tone for each sample, as the gates produce them. */
export function fskModulate(bits: number[], spb = SAMPLES_PER_BIT): number[] {
  const tx = new FskTxModel(), out: number[] = [];
  for (const b of bits) for (let i = 0; i < spb; i++) { out.push(tx.sample); tx.clock(b); }
  return out;
}

/** Demodulate: the decision register after every sample. */
export function fskDemodulate(samples: number[]): number[] {
  const rx = new FskRxModel(), out: number[] = [];
  for (const s of samples) { rx.clock(s); out.push(rx.d); }
  return out;
}

/** The bits read at the middle of each bit time (bit timing shared with the sender; a real modem must recover it). */
export const sliceBits = (decisions: number[], n: number, spb = SAMPLES_PER_BIT, at = 0.75): number[] =>
  Array.from({ length: n }, (_, i) => decisions[Math.floor((i + at) * spb)]);

/** Add Gaussian noise of rms `sigma` (in table steps) to 6-bit samples, clamped to the range. */
export function noisy(samples: number[], sigma: number, seed: number): number[] {
  const u = rng(seed);
  return samples.map((s) => Math.max(0, Math.min(2 ** SINE_W - 1, Math.round(s + sigma * gaussian(u)))));
}

// ---------------------------------------------------------------------------------------------------------------------
// Constellations

export type Kind = 'psk' | 'qam';
export interface Constellation {
  kind: Kind;
  M: number;
  /** Points (I, Q) at unit average symbol energy, indexed by their Gray label. */
  pts: [number, number][];
  /** Half the distance between nearest neighbours. */
  dmin: number;
}

const gray = (i: number): number => i ^ (i >> 1);
export const bitsOf = (M: number): number => Math.round(Math.log2(M));
export const popcount = (x: number): number => { let n = 0; for (let v = x >>> 0; v; v &= v - 1) n++; return n; };

/** Square M-QAM (M = 4, 16, 64, 256: a Gray code on each axis) or M-PSK (any M ≥ 2: a Gray code round the circle), unit average energy. */
export function constellation(kind: Kind, M: number): Constellation {
  const pts: [number, number][] = Array.from({ length: M }, () => [0, 0]);
  let dmin: number;
  if (kind === 'psk') {
    for (let k = 0; k < M; k++) { const a = (2 * Math.PI * k) / M; pts[gray(k)] = [Math.cos(a), Math.sin(a)]; }
    dmin = M === 2 ? 1 : Math.sin(Math.PI / M);
  } else {
    const L = Math.round(Math.sqrt(M)), k = bitsOf(L), d = Math.sqrt(3 / (2 * (M - 1)));
    if (L * L !== M || L < 2) throw new Error('QAM needs a square M');
    for (let i = 0; i < L; i++) for (let q = 0; q < L; q++) pts[(gray(i) << k) | gray(q)] = [(2 * i - L + 1) * d, (2 * q - L + 1) * d];
    dmin = d;
  }
  return { kind, M, pts, dmin };
}

/** The label of the point nearest (x, y). */
export function decide(c: Constellation, x: number, y: number): number {
  if (c.kind === 'psk') {
    const a = Math.atan2(y, x), k = ((Math.round((a * c.M) / (2 * Math.PI)) % c.M) + c.M) % c.M;
    return gray(k);
  }
  const L = Math.round(Math.sqrt(c.M)), k = bitsOf(L), d = c.dmin;
  const ax = (v: number) => Math.max(0, Math.min(L - 1, Math.round((v / d + L - 1) / 2)));
  return (gray(ax(x)) << k) | gray(ax(y));
}

/** Neighbouring points of a Gray-coded constellation differ in one bit: the largest label distance between nearest neighbours. */
export function worstNeighbourBits(c: Constellation): number {
  let worst = 0;
  for (let a = 0; a < c.M; a++) for (let b = a + 1; b < c.M; b++) {
    if (Math.hypot(c.pts[a][0] - c.pts[b][0], c.pts[a][1] - c.pts[b][1]) < 2 * c.dmin * 1.0001) worst = Math.max(worst, popcount(a ^ b));
  }
  return worst;
}

/** The mean energy (should be 1) and the peak-to-average power ratio (dB) of a constellation. */
export function energies(c: Constellation): { mean: number; papr: number } {
  const e = c.pts.map(([x, y]) => x * x + y * y), mean = e.reduce((a, b) => a + b, 0) / c.M;
  return { mean, papr: ratioToDb(Math.max(...e) / mean) };
}

/** The inverse of Q (bisection). */
export function qInv(p: number): number {
  let lo = 0, hi = 40;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (qFunc(m) > p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/**
 * Symbol error rate over AWGN at Es/N0 = snr (linear). Square QAM: exact, 1 − (1 − Pe)² with Pe = 2 (1 − 1/L) Q(√(3 snr / (M − 1)))
 * per axis. PSK: BPSK exact Q(√(2 snr)); M ≥ 4 the two-neighbour approximation 2 Q(√(2 snr) sin(π / M)) (QPSK as 4-PSK is
 * the same as 4-QAM, and exact there with the square formula).
 */
export function serClosed(kind: Kind, M: number, snr: number): number {
  if (kind === 'psk') {
    if (M === 2) return qFunc(Math.sqrt(2 * snr));
    if (M === 4) return serClosed('qam', 4, snr);
    return Math.min(1, 2 * qFunc(Math.sqrt(2 * snr) * Math.sin(Math.PI / M)));
  }
  const L = Math.sqrt(M), pe = 2 * (1 - 1 / L) * qFunc(Math.sqrt((3 * snr) / (M - 1)));
  return 1 - (1 - pe) * (1 - pe);
}

/** Bit error rate with Gray labels: about one bit per symbol error. */
export const berGray = (kind: Kind, M: number, snr: number): number => serClosed(kind, M, snr) / bitsOf(M);

export interface McResult { symbols: number; symErrors: number; bitErrors: number; ser: number; ber: number }
/** Monte Carlo: n random symbols through unit-energy complex Gaussian noise of variance 1/snr (1/(2 snr) per axis). */
export function monteCarlo(c: Constellation, snrDb: number, n: number, seed: number): McResult {
  const u = rng(seed), sigma = Math.sqrt(1 / (2 * dbToRatio(snrDb)));
  let se = 0, be = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(c.M - 1, Math.floor(u() * c.M)), [x, y] = c.pts[s];
    const r = decide(c, x + sigma * gaussian(u), y + sigma * gaussian(u));
    if (r !== s) { se++; be += popcount(r ^ s); }
  }
  return { symbols: n, symErrors: se, bitErrors: be, ser: se / n, ber: be / (n * bitsOf(c.M)) };
}

/** The Es/N0 (dB) at which the closed form gives symbol error rate `target` (bisection; the curve falls monotonically). */
export function snrForSer(kind: Kind, M: number, target: number): number {
  let lo = -10, hi = 60;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (serClosed(kind, M, dbToRatio(m)) > target) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** How far above Shannon an uncoded M-QAM sits at a symbol error rate: its Es/N0 against 2^b − 1, in dB. */
export const gapToShannonDb = (M: number, ser: number): number => snrForSer('qam', M, ser) - ratioToDb(snrNeeded(bitsOf(M)));

// ---------------------------------------------------------------------------------------------------------------------
// The voice-band modems, with the numbers their standards fix

export interface ModemStd {
  id: string;
  name: string;
  /** Data rate (bit/s) and symbol rate (baud); rate / baud is the data bits a symbol carries. */
  rate: number;
  baud: number;
  scheme: string;
  /** Anything the symbol rate leaves out. */
  note: string;
}
export const MODEMS: ModemStd[] = [
  { id: 'bell103', name: 'Bell 103', rate: 300, baud: 300, scheme: 'FSK', note: 'two tones a side, 1070 / 1270 Hz (originate) and 2025 / 2225 Hz (answer): full duplex by frequency' },
  { id: 'v22', name: 'V.22 (Bell 212A)', rate: 1200, baud: 600, scheme: '4-phase DPSK', note: 'a dibit in the phase change: 2 bits a symbol; carriers 1200 Hz (originate) and 2400 Hz (answer)' },
  { id: 'v22bis', name: 'V.22bis', rate: 2400, baud: 600, scheme: '16-QAM', note: 'the same 600 baud and bands as V.22, four bits a symbol' },
  { id: 'v32', name: 'V.32', rate: 9600, baud: 2400, scheme: 'trellis-coded 32-QAM', note: 'four data bits and one coding bit a symbol, an echo canceller so both directions share the band' },
  { id: 'v32bis', name: 'V.32bis', rate: 14400, baud: 2400, scheme: 'trellis-coded 128-QAM', note: 'six data bits and one coding bit a symbol' },
  { id: 'v34', name: 'V.34', rate: 33600, baud: 3429, scheme: 'trellis-coded QAM', note: 'the highest of its symbol rates (2400 … 3429 baud) at the line\'s probed SNR; the rate follows what the line can carry' },
  { id: 'v90', name: 'V.90 (downstream)', rate: 56000, baud: 8000, scheme: 'PCM levels', note: 'the server sends 8-bit PCM codewords the digital network turns into the loop\'s voltage: a subset of the 256 codewords, worth 7 bits a symbol; upstream stays V.34' },
];
export const bitsPerSymbol = (m: ModemStd): number => m.rate / m.baud;

/** The telephone network's sampling: 8000 PCM samples a second, 8 bits each (DS0). */
export const PCM_RATE = 8000;
export const DS0 = PCM_RATE * 8;

// ---------------------------------------------------------------------------------------------------------------------
// ADSL: many carriers, each loaded with what its own SNR allows

/** ITU-T G.992.1 (ADSL over POTS): 256 tones 4.3125 kHz apart, 4000 DMT symbols a second, at most 15 bits on a tone. */
export const ADSL = { tones: 256, spacingHz: 4312.5, symbolRate: 4000, maxBits: 15 };
/** The uncoded SNR gap (dB) at symbol error rate 1e-7 for large QAM: (Q⁻¹(Pe / 4))² / 3. */
export const gapDb = (ser: number): number => ratioToDb(qInv(ser / 4) ** 2 / 3);

/** Bits a tone carries: ⌊log₂(1 + SNR / Γ)⌋ capped at `max` (0 when the tone cannot hold a bit). */
export function bitsForTone(snrDb: number, gap: number, max = ADSL.maxBits): number {
  const b = Math.floor(Math.log2(1 + dbToRatio(snrDb - gap)));
  return Math.max(0, Math.min(max, b));
}

/**
 * An illustrative loop: attenuation 20 dB / km at 1 MHz and growing with √f (twisted pair's skin effect), a transmit PSD of
 * -40 dBm/Hz and a noise floor `floor` dBm/Hz (thermal plus crosstalk). The SNR on tone k.
 */
export function toneSnrDb(k: number, km: number, floor: number): number {
  const f = (k * ADSL.spacingHz) / 1e6;
  return -40 - 20 * km * Math.sqrt(f) - floor;
}

/** The tones a downstream channel uses: 33 … 255 (the lowest tones carry the voice, the upstream sits just above it). */
export const DOWN_TONES = Array.from({ length: 223 }, (_, i) => 33 + i);

/** Bit loading over the downstream tones; the total rate is the sum of the bits times the symbol rate. */
export function bitLoad(km: number, floor: number, gap: number): { bits: number[]; total: number; rate: number } {
  const bits = DOWN_TONES.map((k) => bitsForTone(toneSnrDb(k, km, floor), gap));
  const total = bits.reduce((a, b) => a + b, 0);
  return { bits, total, rate: total * ADSL.symbolRate };
}

/**
 * The oscillator's own noise: the table's 6-bit samples against an ideal sine of the same (full-resolution) phase, over whole
 * periods of a tuning word, as signal power over error power (dB). Phase truncated to six bits and amplitude to six bits.
 */
export function ncoSnrDb(word = FTW_MARK): number {
  const nco = new NcoModel(), n = 2 ** ACC_BITS;
  let ps = 0, pe = 0;
  for (let i = 0; i < n; i++) {
    const ideal = 31.5 * Math.sin((2 * Math.PI * nco.acc) / 2 ** ACC_BITS), got = nco.sample - 31.5;
    ps += ideal * ideal; pe += (got - ideal) * (got - ideal);
    nco.clock(word);
  }
  return ratioToDb(ps / pe);
}
