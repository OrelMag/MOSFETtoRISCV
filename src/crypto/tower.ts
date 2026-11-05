// The S-box's inverse as hardware wants it: GF(2^8) rebuilt as a tower of fields (Rijmen; Satoh et al.; Canright), so the
// inverse needs a handful of 2-bit and 4-bit operations instead of a 256-entry table or 254 multiplications.
//   GF(4)   = GF(2)[y] / (y^2 + y + 1)                    2 bits, element = hi·y + lo
//   GF(16)  = GF(4)[z] / (z^2 + z + N)                    4 bits, hi·z + lo, hi and lo in GF(4)
//   GF(256) = GF(16)[w] / (w^2 + w + LAMBDA)              8 bits, hi·w + lo, hi and lo in GF(16)
// N and LAMBDA are the smallest values that make the polynomial irreducible (searched, not typed); the isomorphism with
// AES's field (x^8 + x^4 + x^3 + x + 1) maps x to the smallest root of AES's polynomial in the tower. Both maps are linear over
// GF(2), so each is an XOR network (matrixOf), and the S-box's affine step folds into the output one.
// Everything here is the specification of the gates in lib/aes.ts; tests/crypto-aes.test.ts holds it to crypto/aes.ts on all 256 inputs.

import { affine } from './aes';

export const mul4 = (a: number, b: number): number => {
  const a1 = a >> 1, a0 = a & 1, b1 = b >> 1, b0 = b & 1;
  const m11 = a1 & b1, m00 = a0 & b0, p = (a1 ^ a0) & (b1 ^ b0); // Karatsuba: three products, y^2 = y + 1
  return ((p ^ m00) << 1) | (m11 ^ m00);
};

/** Smallest N in GF(4) with z^2 + z + N irreducible (no root). */
export const N4: number = [1, 2, 3].find((n) => ![0, 1, 2, 3].some((x) => (mul4(x, x) ^ x ^ n) === 0))!;

export const mul16 = (a: number, b: number): number => {
  const a1 = a >> 2, a0 = a & 3, b1 = b >> 2, b0 = b & 3;
  const m11 = mul4(a1, b1), m00 = mul4(a0, b0), p = mul4(a1 ^ a0, b1 ^ b0);
  return ((p ^ m00) << 2) | (mul4(N4, m11) ^ m00);
};

/** Smallest LAMBDA in GF(16) with w^2 + w + LAMBDA irreducible. */
export const LAMBDA: number = Array.from({ length: 15 }, (_, i) => i + 1).find((l) => !Array.from({ length: 16 }, (_, x) => x).some((x) => (mul16(x, x) ^ x ^ l) === 0))!;

export const mul256 = (a: number, b: number): number => {
  const a1 = a >> 4, a0 = a & 15, b1 = b >> 4, b0 = b & 15;
  const m11 = mul16(a1, b1), m00 = mul16(a0, b0), p = mul16(a1 ^ a0, b1 ^ b0);
  return ((p ^ m00) << 4) | (mul16(LAMBDA, m11) ^ m00);
};

// Inverses by the norm: (a1·t + a0)^-1 = (a1·e)·t + (a0 + a1)·e with e = (a0^2 + a0·a1 + C·a1^2)^-1 in the field below.
export const inv4 = (a: number): number => mul4(a, a); // x^3 = 1, so x^-1 = x^2 (and 0 stays 0)
export const inv16 = (a: number): number => {
  const a1 = a >> 2, a0 = a & 3, e = inv4(mul4(a0, a0) ^ mul4(a0, a1) ^ mul4(N4, mul4(a1, a1)));
  return (mul4(a1, e) << 2) | mul4(a0 ^ a1, e);
};
export const inv256 = (a: number): number => {
  const a1 = a >> 4, a0 = a & 15, e = inv16(mul16(a0, a0) ^ mul16(a0, a1) ^ mul16(LAMBDA, mul16(a1, a1)));
  return (mul16(a1, e) << 4) | mul16(a0 ^ a1, e);
};

const pow256 = (a: number, n: number) => { let r = 1; for (let i = 0; i < n; i++) r = mul256(r, a); return r; };
/** The smallest root of x^8 + x^4 + x^3 + x + 1 in the tower: where AES's x goes. */
export const ROOT: number = Array.from({ length: 254 }, (_, i) => i + 2).find((r) => (pow256(r, 8) ^ pow256(r, 4) ^ pow256(r, 3) ^ r ^ 1) === 0)!;

/** AES-field byte (polynomial basis) → tower byte. */
export const toTower = (b: number): number => { let r = 0; for (let i = 0; i < 8; i++) if ((b >> i) & 1) r ^= pow256(ROOT, i); return r; };
const TOWER_BACK: number[] = (() => { const t = new Array<number>(256); for (let b = 0; b < 256; b++) t[toTower(b)] = b; return t; })();
export const fromTower = (t: number): number => TOWER_BACK[t];

export const parity = (x: number): number => { let p = 0; for (; x; x &= x - 1) p ^= 1; return p; };

/** The matrix of a GF(2)-linear map as `nout` row masks (bit j of row i: output bit i depends on input bit j). */
export function matrixOf(f: (x: number) => number, nin: number, nout: number): bigint[] {
  const rows: bigint[] = new Array<bigint>(nout).fill(0n);
  for (let j = 0; j < nin; j++) { const v = f(2 ** j); for (let i = 0; i < nout; i++) if (Math.floor(v / 2 ** i) % 2) rows[i] |= 1n << BigInt(j); }
  return rows;
}

/** Input map of the S-box: AES basis → tower basis. */
export const SBOX_IN = matrixOf(toTower, 8, 8);
/** Output map: tower basis → AES basis, then the affine step's matrix; the constant 0x63 is added after (NOT gates). */
export const SBOX_OUT = matrixOf((t) => affine(fromTower(t)), 8, 8);

/** The S-box as the hardware computes it: change basis, invert in the tower, change back with the affine map folded in. */
export const sboxTower = (x: number): number => {
  const t = inv256(toTower(x));
  return (affine(fromTower(t)) ^ 0x63) & 0xff;
};
