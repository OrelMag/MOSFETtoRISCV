// Line codes for a link with no clock of its own (chapter 46), DOM-free: the golden models the gates are compared with.
// Manchester (a transition in the middle of every bit), 8b/10b (Widmer and Franaszek, IBM J. R&D 1983; IEEE 802.3 Clause 36
// tables, typed out once below) with its running disparity, and the self-synchronizing scrambler of 64b/66b.
//
// A 10-bit code is a number whose bit 9 is `a`, the first bit on the wire, and bit 0 is `j`. A byte is HGF EDCBA (value 0 … 255),
// named D.x.y or K.x.y with x = EDCBA and y = HGF. The running disparity RD is 0 for "RD−" (more zeros sent so far) and 1 for "RD+".

export type Rd = 0 | 1;

// ---- Manchester ------------------------------------------------------------------------------------------------------------

/** IEEE 802.3 convention: a 1 is low then high, a 0 is high then low; the half-bit levels, two per bit. */
export function manchester(bits: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < bits.length; i++) out.push(bits[i] ? 0 : 1, bits[i] ? 1 : 0);
  return out;
}

/** Back from half-bit levels: the bit is the level of the second half; a bit whose halves are equal has no mid-bit transition (an error). */
export function unManchester(halves: ArrayLike<number>): { bits: number[]; errors: number } {
  const bits: number[] = [];
  let errors = 0;
  for (let i = 0; i + 1 < halves.length; i += 2) {
    if (halves[i] === halves[i + 1]) errors++;
    bits.push(halves[i + 1]);
  }
  return { bits, errors };
}

/** Longest run of equal levels in a stream. */
export function maxRun(bits: ArrayLike<number>): number {
  let best = 0, run = 0;
  for (let i = 0; i < bits.length; i++) { run = i && bits[i] === bits[i - 1] ? run + 1 : 1; best = Math.max(best, run); }
  return best;
}

/** Fraction of bit boundaries with a transition: the clock content of a stream. */
export function transitionDensity(bits: ArrayLike<number>): number {
  let t = 0;
  for (let i = 1; i < bits.length; i++) if (bits[i] !== bits[i - 1]) t++;
  return bits.length > 1 ? t / (bits.length - 1) : 0;
}

// ---- 8b/10b ----------------------------------------------------------------------------------------------------------------

/** 5b/6b, abcdei, by x = EDCBA: [RD−, RD+] (one string when both are the same). Disparity 0 blocks have one form, except D.7. */
const T6: Record<number, [string, string] | string> = {
  0: ['100111', '011000'], 1: ['011101', '100010'], 2: ['101101', '010010'], 3: '110001', 4: ['110101', '001010'], 5: '101001', 6: '011001',
  7: ['111000', '000111'], 8: ['111001', '000110'], 9: '100101', 10: '010101', 11: '110100', 12: '001101', 13: '101100', 14: '011100',
  15: ['010111', '101000'], 16: ['011011', '100100'], 17: '100011', 18: '010011', 19: '110010', 20: '001011', 21: '101010', 22: '011010',
  23: ['111010', '000101'], 24: ['110011', '001100'], 25: '100110', 26: '010110', 27: ['110110', '001001'], 28: '001110',
  29: ['101110', '010001'], 30: ['011110', '100001'], 31: ['101011', '010100'],
};
/** K.28's 6b block (the other K.x are the D blocks). */
const K28_6: [string, string] = ['001111', '110000'];
/** 3b/4b, fghj, by y = HGF: [RD−, RD+], read at the running disparity after the 6b block. */
const T4D: [string, string][] = [['1011', '0100'], ['1001', '1001'], ['0101', '0101'], ['1100', '0011'], ['1101', '0010'], ['1010', '1010'], ['0110', '0110'], ['1110', '0001']];
/** The alternate 7, used to keep a run of five from forming (D.x.A7). */
const A7: [string, string] = ['0111', '1000'];
/** K codes: y = 1, 2, 5, 6 are the complement of the D forms; K.x.7 is the alternate 7. */
const T4K: [string, string][] = [['1011', '0100'], ['0110', '1001'], ['1010', '0101'], ['1100', '0011'], ['1101', '0010'], ['0101', '1010'], ['1001', '0110'], A7];

/** The twelve control codes: K28.0 … K28.7, K23.7, K27.7, K29.7, K30.7. */
export const K_CODES: number[] = [...[0, 1, 2, 3, 4, 5, 6, 7].map((y) => (y << 5) | 28), ...[23, 27, 29, 30].map((x) => (7 << 5) | x)];
export const isKCode = (v: number): boolean => K_CODES.includes(v);
export const nameOf = (v: number, k: boolean): string => `${k ? 'K' : 'D'}${v & 31}.${v >> 5}`;
/** Byte from a name like "K28.5" or "D21.5". */
export function byteOf(name: string): { v: number; k: boolean } {
  const m = /^([DK])(\d+)\.(\d)$/.exec(name);
  if (!m) throw new Error(`not a code name: ${name}`);
  return { v: (+m[3] << 5) | +m[2], k: m[1] === 'K' };
}

const bitsOf = (s: string): number => parseInt(s, 2);
const ones = (n: number): number => { let c = 0; for (; n; n >>= 1) c += n & 1; return c; };
/** Ones minus zeros in the low `n` bits. */
export const disparityOf = (code: number, n: number): number => 2 * ones(code & ((1 << n) - 1)) - n;

export interface Encoded { code: number; rd: Rd; /** the 6b / 4b parts and the disparity after the 6b block. */ six: number; four: number; rd6: Rd }

export function validByte(v: number, k: boolean): boolean {
  return v >= 0 && v < 256 && (!k || isKCode(v));
}

/** Encode one byte at running disparity `rd`: the code, and the disparity after it. */
export function encode8b10b(v: number, k: boolean, rd: Rd): Encoded {
  if (!validByte(v, k)) throw new Error(`no such code: ${nameOf(v, k)}`);
  const x = v & 31, y = v >> 5;
  const pair = k && x === 28 ? K28_6 : (typeof T6[x] === 'string' ? [T6[x], T6[x]] : T6[x]) as [string, string];
  const six = bitsOf(pair[rd]);
  const rd6: Rd = disparityOf(six, 6) !== 0 ? ((rd ^ 1) as Rd) : rd;
  let four: string;
  if (k) four = T4K[y][rd6];
  else if (y === 7 && ((rd6 === 0 && (x === 17 || x === 18 || x === 20)) || (rd6 === 1 && (x === 11 || x === 13 || x === 14)))) four = A7[rd6];
  else four = T4D[y][rd6];
  const f = bitsOf(four);
  const rd2: Rd = disparityOf(f, 4) !== 0 ? ((rd6 ^ 1) as Rd) : rd6;
  return { code: (six << 4) | f, rd: rd2, six, four: f, rd6 };
}

export type DecodeError = 'code' | 'disparity' | null;
export interface Decoded { v: number; k: boolean; rd: Rd; err: DecodeError }

const DECODE = new Map<number, { v: number; k: boolean; rd: Rd }[]>();   // code -> the (byte, RD) pairs that produce it
for (let rd = 0; rd < 2; rd++) for (let v = 0; v < 256; v++) for (const k of [false, true]) {
  if (!validByte(v, k)) continue;
  const c = encode8b10b(v, k, rd as Rd).code, l = DECODE.get(c) ?? [];
  l.push({ v, k, rd: rd as Rd });
  DECODE.set(c, l);
}

/** Decode one code at running disparity `rd`. A code legal only at the other disparity decodes to its byte with err 'disparity'; one in no table has err 'code' (v = 0). */
export function decode8b10b(code: number, rd: Rd): Decoded {
  const l = DECODE.get(code);
  if (!l) return { v: 0, k: false, rd, err: 'code' };
  const here = l.find((e) => e.rd === rd), e = here ?? l[0];
  const nd = disparityOf(code >> 4, 6) !== 0 ? ((rd ^ 1) as Rd) : rd;
  const nd2: Rd = disparityOf(code & 15, 4) !== 0 ? ((nd ^ 1) as Rd) : nd;
  return { v: e.v, k: e.k, rd: nd2, err: here ? null : 'disparity' };
}

/** A byte stream through the encoder from `rd`: codes and disparities after each. */
export function encodeStream(bytes: { v: number; k?: boolean }[], rd: Rd = 0): { codes: number[]; rds: Rd[]; bits: number[] } {
  const codes: number[] = [], rds: Rd[] = [], bits: number[] = [];
  for (const b of bytes) {
    const e = encode8b10b(b.v, !!b.k, rd);
    codes.push(e.code); rds.push((rd = e.rd));
    for (let i = 9; i >= 0; i--) bits.push((e.code >> i) & 1);
  }
  return { codes, rds, bits };
}

export const codeText = (code: number): string => code.toString(2).padStart(10, '0').replace(/^(\d{6})/, '$1 ');

/** The comma: seven bits that occur nowhere in a legal stream except inside K28.1, K28.5 and K28.7 (0011111 after RD−, 1100000 after RD+). */
export const COMMAS = ['0011111', '1100000'];

/** Longest run in any legal stream: 5, and the one after the worst of the codes. */
export const MAX_RUN_8B10B = 5;

// ---- the self-synchronizing scrambler ---------------------------------------------------------------------------------------

/** Polynomials: the taps are the delays whose output bits are added to the input (1 + x^a + x^b). 64b/66b uses x^39 and x^58 (IEEE 802.3 Clause 49). */
export const POLY_64B66B: [number, number] = [39, 58];
/** A short one for the gate-level scene: 1 + x^6 + x^7. */
export const POLY_7: [number, number] = [6, 7];

/** Multiplicative scrambler: out[t] = in[t] ⊕ out[t−a] ⊕ out[t−b]. Its register holds what it sent. */
export class Scrambler {
  /** hist[0] is the bit sent one step ago. */
  hist: number[];
  /** `seed`: the register's bits, bit i the bit sent i + 1 steps ago (exact to 53 bits). */
  constructor(public taps: [number, number] = POLY_64B66B, seed = 0) {
    const n = Math.max(...taps);
    this.hist = Array.from({ length: n }, (_, i) => Math.floor(seed / 2 ** i) % 2);
  }
  step(bit: number): number {
    const o = bit ^ this.hist[this.taps[0] - 1] ^ this.hist[this.taps[1] - 1];
    this.hist.unshift(o); this.hist.pop();
    return o;
  }
  run(bits: ArrayLike<number>): number[] { return Array.from(bits, (b) => this.step(b)); }
}

/** The matching descrambler: out[t] = rx[t] ⊕ rx[t−a] ⊕ rx[t−b]. Its register holds what it received, so a wrong start state is flushed after max(a, b) bits, and one wrong received bit corrupts three outputs. */
export class Descrambler {
  hist: number[];
  /** `seed`: the register's bits, bit i the bit sent i + 1 steps ago (exact to 53 bits). */
  constructor(public taps: [number, number] = POLY_64B66B, seed = 0) {
    const n = Math.max(...taps);
    this.hist = Array.from({ length: n }, (_, i) => Math.floor(seed / 2 ** i) % 2);
  }
  step(bit: number): number {
    const o = bit ^ this.hist[this.taps[0] - 1] ^ this.hist[this.taps[1] - 1];
    this.hist.unshift(bit); this.hist.pop();
    return o;
  }
  run(bits: ArrayLike<number>): number[] { return Array.from(bits, (b) => this.step(b)); }
}

/** Overhead of a code as extra bits on the wire per payload bit. */
export const overhead = { manchester: 1, '8b/10b': 0.25, '64b/66b': 2 / 64, scrambler: 0 };
