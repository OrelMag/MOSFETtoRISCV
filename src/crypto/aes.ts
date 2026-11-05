// AES-128 (FIPS 197), the golden model the gates (lib/aes.ts) and the chapter's widgets follow. DOM-free.
// Nothing is typed in from a table: the S-box is the field inverse in GF(2^8) followed by the affine map, the round
// constants are powers of x. tests/crypto-aes.test.ts holds it to FIPS 197 Appendix B / C, SP 800-38A and node:crypto.
// A state is 16 bytes in input order: byte i sits in row i % 4, column ⌊i / 4⌋ (FIPS 197 §3.4).

export type Bytes = number[];

/** Multiply by x in GF(2^8) modulo x^8 + x^4 + x^3 + x + 1. */
export const xtime = (a: number): number => ((a << 1) ^ (a & 0x80 ? 0x11b : 0)) & 0xff;

export function gmul(a: number, b: number): number {
  let r = 0;
  for (; b; b >>= 1) { if (b & 1) r ^= a; a = xtime(a); }
  return r;
}

/** a^-1 as a^254 (0 maps to 0, as the S-box defines). */
export function ginv(a: number): number {
  let r = 1;
  for (let i = 0; i < 254; i++) r = gmul(r, a);
  return a ? r : 0;
}

const rotl8 = (b: number, k: number) => ((b << k) | (b >> (8 - k))) & 0xff;
/** The affine map's matrix part: b ^ b<<<1 ^ b<<<2 ^ b<<<3 ^ b<<<4. */
export const affine = (b: number): number => b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4);
export const AFFINE_CONST = 0x63;

export const SBOX: readonly number[] = Array.from({ length: 256 }, (_, x) => affine(ginv(x)) ^ AFFINE_CONST);
export const INV_SBOX: readonly number[] = (() => { const t = new Array<number>(256); SBOX.forEach((s, x) => { t[s] = x; }); return t; })();

/** Round constants x^(i-1): 01 02 04 … 36. */
export const RCON: readonly number[] = (() => { const r = [1]; for (let i = 1; i < 10; i++) r.push(xtime(r[i - 1])); return r; })();

export const subBytes = (s: Bytes): Bytes => s.map((b) => SBOX[b]);
export const invSubBytes = (s: Bytes): Bytes => s.map((b) => INV_SBOX[b]);
/** Row r rotates left by r columns: out[r, c] = in[r, (c + r) mod 4]. */
export const shiftRows = (s: Bytes): Bytes => s.map((_, i) => s[4 * (((i >> 2) + (i & 3)) & 3) + (i & 3)]);
export const invShiftRows = (s: Bytes): Bytes => { const o = new Array<number>(16); s.forEach((b, i) => { o[4 * (((i >> 2) + (i & 3)) & 3) + (i & 3)] = b; }); return o; };

const MIX = [[2, 3, 1, 1], [1, 2, 3, 1], [1, 1, 2, 3], [3, 1, 1, 2]];
const INV_MIX = [[14, 11, 13, 9], [9, 14, 11, 13], [13, 9, 14, 11], [11, 13, 9, 14]];
function mixWith(m: number[][], s: Bytes): Bytes {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[4 * c + r] ^= gmul(m[r][k], s[4 * c + k]);
  return o;
}
export const mixColumns = (s: Bytes): Bytes => mixWith(MIX, s);
export const invMixColumns = (s: Bytes): Bytes => mixWith(INV_MIX, s);
export const addRoundKey = (s: Bytes, k: Bytes): Bytes => s.map((b, i) => b ^ k[i]);

/** The next round key from this one and the round constant (the key schedule's step, one clock of the gates). */
export function nextKey(k: Bytes, rcon: number): Bytes {
  const o = new Array<number>(16);
  const t = [SBOX[k[13]] ^ rcon, SBOX[k[14]], SBOX[k[15]], SBOX[k[12]]]; // SubWord(RotWord(w3)) ^ Rcon
  for (let i = 0; i < 4; i++) o[i] = k[i] ^ t[i];
  for (let i = 4; i < 16; i++) o[i] = k[i] ^ o[i - 4];
  return o;
}

/** The 11 round keys of an AES-128 key (FIPS 197 §5.2). */
export function expandKey(key: Bytes): Bytes[] {
  if (key.length !== 16) throw new Error('AES-128 takes a 16-byte key');
  const ks = [key.slice()];
  for (let r = 1; r <= 10; r++) ks.push(nextKey(ks[r - 1], RCON[r - 1]));
  return ks;
}

/** One round: SubBytes, ShiftRows, MixColumns (not in the last round), AddRoundKey. */
export function round(s: Bytes, k: Bytes, last = false): Bytes {
  const t = shiftRows(subBytes(s));
  return addRoundKey(last ? t : mixColumns(t), k);
}

export interface RoundTrace {
  round: number;
  start: Bytes;
  afterSub: Bytes;
  afterShift: Bytes;
  /** Absent in the last round. */
  afterMix: Bytes | null;
  roundKey: Bytes;
  /** After AddRoundKey: the next round's start. */
  out: Bytes;
}
export interface AesTrace { input: Bytes; keys: Bytes[]; afterInitial: Bytes; rounds: RoundTrace[]; output: Bytes }

export function encryptTrace(block: Bytes, key: Bytes): AesTrace {
  const keys = expandKey(key);
  const afterInitial = addRoundKey(block, keys[0]);
  let s = afterInitial;
  const rounds: RoundTrace[] = [];
  for (let r = 1; r <= 10; r++) {
    const afterSub = subBytes(s), afterShift = shiftRows(afterSub), afterMix = r < 10 ? mixColumns(afterShift) : null;
    const out = addRoundKey(afterMix ?? afterShift, keys[r]);
    rounds.push({ round: r, start: s, afterSub, afterShift, afterMix, roundKey: keys[r], out });
    s = out;
  }
  return { input: block, keys, afterInitial, rounds, output: s };
}

export const encryptBlock = (block: Bytes, key: Bytes): Bytes => encryptTrace(block, key).output;

export function decryptBlock(block: Bytes, key: Bytes): Bytes {
  const ks = expandKey(key);
  let s = addRoundKey(block, ks[10]);
  for (let r = 9; r >= 0; r--) {
    s = addRoundKey(invSubBytes(invShiftRows(s)), ks[r]);
    if (r > 0) s = invMixColumns(s);
  }
  return s;
}

/** ECB over whole blocks (SP 800-38A §6.1): for the standard's vectors; ECB is not a mode to use. */
export function ecb(data: Bytes, key: Bytes, decrypt = false): Bytes {
  const out: Bytes = [];
  for (let i = 0; i < data.length; i += 16) out.push(...(decrypt ? decryptBlock : encryptBlock)(data.slice(i, i + 16), key));
  return out;
}

export const hex = (b: Bytes): string => b.map((x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Bytes => (h.replace(/\s+/g, '').match(/../g) ?? []).map((x) => parseInt(x, 16));
