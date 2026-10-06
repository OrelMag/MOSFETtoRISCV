// Reference IEEE 754 arithmetic for any binary format (E exponent bits, M fraction bits): exact
// rational arithmetic with BigInt, then one correct round-to-nearest-even. Used to check the
// gate-level floating-point units exhaustively on small formats and on float32, and by the
// floating-point explorer. NaN results are RISC-V's canonical quiet NaN.

export interface FpFormat { E: number; M: number }
export const F32: FpFormat = { E: 8, M: 23 };
export const F16: FpFormat = { E: 5, M: 10 };

export type FpKind = 'zero' | 'subnormal' | 'normal' | 'inf' | 'nan';

export interface FpParts { sign: number; field: number; frac: number; kind: FpKind; bias: number }

export const bias = (f: FpFormat) => 2 ** (f.E - 1) - 1;
export const canonicalNaN = (f: FpFormat) => (2 ** f.E - 1) * 2 ** f.M + 2 ** (f.M - 1);

export function parts(bits: number, f: FpFormat): FpParts {
  const frac = bits % 2 ** f.M, field = Math.floor(bits / 2 ** f.M) % 2 ** f.E, sign = Math.floor(bits / 2 ** (f.E + f.M)) & 1;
  const top = 2 ** f.E - 1;
  const kind: FpKind = field === top ? (frac ? 'nan' : 'inf') : field === 0 ? (frac ? 'subnormal' : 'zero') : 'normal';
  return { sign, field, frac, kind, bias: bias(f) };
}

const pack = (sign: number, field: number, frac: number, f: FpFormat) => (sign * 2 ** f.E + field) * 2 ** f.M + frac;

/** value = mant × 2^exp2 exactly (finite, non-NaN). */
function exact(bits: number, f: FpFormat): { sign: number; mant: bigint; exp2: number } {
  const p = parts(bits, f);
  if (p.field === 0) return { sign: p.sign, mant: BigInt(p.frac), exp2: 1 - p.bias - f.M };
  return { sign: p.sign, mant: BigInt(p.frac + 2 ** f.M), exp2: p.field - p.bias - f.M };
}

const bitLength = (v: bigint) => v.toString(2).length;

/** Round sign × mant × 2^exp2 (mant > 0) to the format, nearest-even, with overflow to infinity. */
export function roundTo(sign: number, mant: bigint, exp2: number, f: FpFormat): number {
  const b = bias(f), top = 2 ** f.E - 1;
  const e = bitLength(mant) - 1 + exp2;            // unbiased exponent of the leading 1
  let qe = Math.max(e, 1 - b) - f.M;              // weight of the last fraction bit
  const sh = exp2 - qe;
  let n: bigint;
  if (sh >= 0) n = mant << BigInt(sh);
  else {
    const d = BigInt(-sh), q = mant >> d, r = mant - (q << d), half = 1n << (d - 1n);
    n = r > half || (r === half && (q & 1n) === 1n) ? q + 1n : q;
  }
  if (n === 1n << BigInt(f.M + 1)) { n >>= 1n; qe += 1; }
  if (n < 1n << BigInt(f.M)) return pack(sign, 0, Number(n), f);   // subnormal (or zero)
  const field = qe + f.M + b;
  if (field >= top) return pack(sign, top, 0, f);                  // overflow → infinity
  return pack(sign, field, Number(n - (1n << BigInt(f.M))), f);
}

export function fpAddRef(a: number, b: number, sub: boolean, f: FpFormat): number {
  const pa = parts(a, f), pb0 = parts(b, f);
  const sb = pb0.sign ^ (sub ? 1 : 0);
  if (pa.kind === 'nan' || pb0.kind === 'nan') return canonicalNaN(f);
  if (pa.kind === 'inf' && pb0.kind === 'inf') return pa.sign !== sb ? canonicalNaN(f) : pack(pa.sign, 2 ** f.E - 1, 0, f);
  if (pa.kind === 'inf') return pack(pa.sign, 2 ** f.E - 1, 0, f);
  if (pb0.kind === 'inf') return pack(sb, 2 ** f.E - 1, 0, f);
  const x = exact(a, f), y = exact(b, f);
  const e = Math.min(x.exp2, y.exp2);
  const vx = (x.sign ? -1n : 1n) * (x.mant << BigInt(x.exp2 - e)), vy = (sb ? -1n : 1n) * (y.mant << BigInt(y.exp2 - e));
  const s = vx + vy;
  if (s === 0n) return pack(pa.sign === sb ? pa.sign : 0, 0, 0, f); // exact zero: +0 unless both were -0
  return roundTo(s < 0n ? 1 : 0, s < 0n ? -s : s, e, f);
}

export function fpMulRef(a: number, b: number, f: FpFormat): number {
  const pa = parts(a, f), pb = parts(b, f), sign = pa.sign ^ pb.sign;
  if (pa.kind === 'nan' || pb.kind === 'nan') return canonicalNaN(f);
  if ((pa.kind === 'inf' && pb.kind === 'zero') || (pa.kind === 'zero' && pb.kind === 'inf')) return canonicalNaN(f);
  if (pa.kind === 'inf' || pb.kind === 'inf') return pack(sign, 2 ** f.E - 1, 0, f);
  if (pa.kind === 'zero' || pb.kind === 'zero') return pack(sign, 0, 0, f);
  const x = exact(a, f), y = exact(b, f);
  return roundTo(sign, x.mant * y.mant, x.exp2 + y.exp2, f);
}

/** Integer (two's complement if signed) to float. */
export function fpFromIntRef(v: number, signed: boolean, f: FpFormat, width = 32): number {
  let x = BigInt(v >>> 0);
  if (signed && x >= 1n << BigInt(width - 1)) x -= 1n << BigInt(width);
  if (x === 0n) return 0;
  return roundTo(x < 0n ? 1 : 0, x < 0n ? -x : x, 0, f);
}

/** The real value of an encoding (Infinity / NaN included), as a JS number when it fits. */
export function fpValue(bits: number, f: FpFormat): number {
  const p = parts(bits, f);
  if (p.kind === 'nan') return NaN;
  if (p.kind === 'inf') return p.sign ? -Infinity : Infinity;
  const x = exact(bits, f);
  return (p.sign ? -1 : 1) * Number(x.mant) * 2 ** x.exp2;
}

// float32 via the host: correct because a double holds every exact float32 sum or product before rounding.
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export const bitsToF32 = (b: number) => { u32[0] = b >>> 0; return f32[0]; };
export const f32ToBits = (x: number) => { f32[0] = x; return Number.isNaN(x) ? 0x7fc00000 : u32[0] >>> 0; };
