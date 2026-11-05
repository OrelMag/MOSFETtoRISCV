// Capstone 2, a link that closes (DOM-free): the choices and what they measure, on the chapters' own models. A carrier link is run: random bits
// through the real convolutional encoder (comm/conv) onto the Gray-labelled constellation (comm/modem), Gaussian noise, the nearest point, a block
// interleaver so a wrong symbol's bits are spread apart, and the real Viterbi decoder, and the errors counted. A serial link is read from the
// same eye and noise model the serial chapter uses (phys/line). Nothing here is a formula made for the capstone.

import { berOf, ctleNoiseGain, eye, eyePam, gaussian, pam4Ber, pam4Symbols, PAM4_LEVELS, prbs, rng, type ChannelSpec } from '../phys/line';
import { CONV_K3, CONV_K7, convEncode, viterbiDecode, type ConvSpec } from './conv';
import { dbToRatio } from './limits';
import { constellation, decide } from './modem';

// ---- a carrier link -------------------------------------------------------------------------------------------------------------------

export const MODULATIONS = [{ name: 'QPSK', M: 4 }, { name: '16-QAM', M: 16 }, { name: '64-QAM', M: 64 }, { name: '256-QAM', M: 256 }] as const;
export const CODES: readonly { name: string; spec: ConvSpec | null; rate: number }[] = [
  { name: 'No code', spec: null, rate: 1 },
  { name: 'Convolutional, K = 3, rate ½', spec: CONV_K3, rate: 0.5 },
  { name: 'Convolutional, K = 7, rate ½', spec: CONV_K7, rate: 0.5 },
];

export interface CarrierChannel { name: string; hz: number; snrDb: number; target: number }
export interface CarrierChoice { mod: number; code: number }
export interface LinkResult { rate: number; ber: number; errors: number; bits: number; closes: boolean }

/** Symbols of a block interleaver's row: a wrong symbol's bits land this far apart. */
const DEPTH = 64;

/** Bits a second: a pass band of B holds B complex symbols a second (the modem chapter). */
export const carrierRate = (ch: CarrierChannel, c: CarrierChoice): number => ch.hz * Math.log2(MODULATIONS[c.mod].M) * CODES[c.code].rate;

/** The link run: `bits` random data bits, counted after the decoder. */
export function runCarrier(ch: CarrierChannel, c: CarrierChoice, bits: number, seed = 1): LinkResult {
  const u = rng(seed), code = CODES[c.code], con = constellation('qam', MODULATIONS[c.mod].M), b = Math.log2(con.M);
  const data = new Uint8Array(bits);
  for (let i = 0; i < bits; i++) data[i] = u() < 0.5 ? 1 : 0;
  const coded: ArrayLike<number> = code.spec ? convEncode(code.spec, data) : data;
  // write by rows, read by columns
  const rows = Math.ceil(coded.length / DEPTH), order = new Int32Array(coded.length);
  let k = 0;
  for (let col = 0; col < DEPTH; col++) for (let r = 0; r < rows; r++) { const at = r * DEPTH + col; if (at < coded.length) order[k++] = at; }
  const sigma = Math.sqrt(1 / (2 * dbToRatio(ch.snrDb))), heard = new Uint8Array(coded.length);
  for (let i = 0; i < coded.length; i += b) {
    let label = 0;
    for (let j = 0; j < b; j++) label = (label << 1) | (i + j < coded.length ? coded[order[i + j]] : 0);
    const [x, y] = con.pts[label], got = decide(con, x + sigma * gaussian(u), y + sigma * gaussian(u));
    for (let j = 0; j < b; j++) if (i + j < coded.length) heard[order[i + j]] = (got >> (b - 1 - j)) & 1;
  }
  let out: ArrayLike<number> = heard, skip = 0, last = bits;
  if (code.spec) {
    const depth = code.spec.K * 10;
    out = viterbiDecode(code.spec, heard, { q: 1, depth });
    skip = depth;  // the decoder's first outputs are its reset's, and each output is `depth − 1` bits old
    last = out.length;
  }
  let errors = 0, seen = 0;
  for (let i = skip; i < last; i++) {
    const j = code.spec ? i - (code.spec.K * 10 - 1) : i;
    if (j < 0 || j >= bits) continue;
    seen++;
    if (out[i] !== data[j]) errors++;
  }
  const ber = seen ? errors / seen : 1;
  return { rate: carrierRate(ch, c), ber, errors, bits: seen, closes: ber <= ch.target };
}

// ---- a serial link ----------------------------------------------------------------------------------------------------------------------

export const LINE_CODES = ['NRZ', 'PAM4'] as const;
export const EQUALIZERS: readonly { name: string; spec: Partial<ChannelSpec>; pam4: boolean }[] = [
  { name: 'None', spec: {}, pam4: true },
  { name: 'Transmit de-emphasis', spec: { de: 0.3 }, pam4: true },
  { name: 'Receive CTLE', spec: { ctle: 2 }, pam4: true },
  { name: 'Decision feedback, one tap', spec: { dfe: 1 }, pam4: false },
];
export const SERIAL_RATES = [4, 8, 12, 16, 20, 25] as const;

export interface SerialChannel { name: string; bandwidth: number; sigma: number; target: number }
export interface SerialChoice { line: 0 | 1; eq: number; rate: number }

/** The eye and the error rate at this choice, as the serial chapter reads them. A PAM4 symbol is two bits, so its symbol rate is half. */
export function runSerial(ch: SerialChannel, c: SerialChoice): LinkResult & { opening: number } {
  const bits = prbs(9, 1022), eq = EQUALIZERS[c.eq], rate = SERIAL_RATES[c.rate];
  if (c.line === 1 && !eq.pam4) return { rate, ber: 0.5, errors: 0, bits: 0, closes: false, opening: 0 };
  const spec: ChannelSpec = { rate: c.line ? rate / 2 : rate, bandwidth: ch.bandwidth, ...eq.spec };
  const sg = ch.sigma * ctleNoiseGain(spec);
  const opening = c.line ? eyePam(pam4Symbols(bits), PAM4_LEVELS, spec).opening : eye(bits, spec).opening;
  const ber = c.line ? pam4Ber(opening, sg) : opening <= 0 ? 0.5 : berOf(opening / 2, sg);
  return { rate, ber, errors: 0, bits: 0, closes: ber <= ch.target, opening };
}

// ---- the briefs -------------------------------------------------------------------------------------------------------------------------

export const CARRIER_BRIEF: CarrierChannel = { name: 'A radio channel of 20 MHz at 18 dB SNR', hz: 20e6, snrDb: 18, target: 1e-3 };
export const SERIAL_BRIEF: SerialChannel = { name: 'A board trace with a 4 GHz pole and 40 mV of noise', bandwidth: 4, sigma: 0.04, target: 1e-12 };
export const CARRIER_BITS = 60000;

/** The best rate any choice reaches on the carrier brief: every choice tried. */
export function bestCarrier(ch = CARRIER_BRIEF, bits = CARRIER_BITS): { choice: CarrierChoice; rate: number } {
  let best = { choice: { mod: 0, code: 0 }, rate: 0 };
  MODULATIONS.forEach((_, mod) => CODES.forEach((__, code) => {
    const c = { mod, code }, r = runCarrier(ch, c, bits);
    if (r.closes && r.rate > best.rate) best = { choice: c, rate: r.rate };
  }));
  return best;
}

/** The same on the serial brief. */
export function bestSerial(ch = SERIAL_BRIEF): { choice: SerialChoice; rate: number } {
  let best: { choice: SerialChoice; rate: number } = { choice: { line: 0, eq: 0, rate: 0 }, rate: 0 };
  for (const line of [0, 1] as const) EQUALIZERS.forEach((_, eq) => SERIAL_RATES.forEach((__, rate) => {
    const c = { line, eq, rate }, r = runSerial(ch, c);
    if (r.closes && r.rate > best.rate) best = { choice: c, rate: r.rate };
  }));
  return best;
}
