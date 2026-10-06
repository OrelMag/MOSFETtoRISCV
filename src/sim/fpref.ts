// Reference IEEE 754 arithmetic for any binary format (E exponent bits, M fraction bits): exact
// rational arithmetic with BigInt, then one correct rounding in any of RISC-V's five rounding
// modes, with the five exception flags. Used to check the gate-level floating-point units
// exhaustively on small formats and on float32, by the instruction-set simulator, and by the
// floating-point explorer. NaN results are RISC-V's canonical quiet NaN; tininess is detected
// after rounding, as RISC-V specifies.

export interface FpFormat { E: number; M: number }
export const F32: FpFormat = { E: 8, M: 23 };
export const F16: FpFormat = { E: 5, M: 10 };

/** Rounding modes, numbered as in the rm field and frm. 5 and 6 are reserved (treated as RTZ here). */
export const RM = { RNE: 0, RTZ: 1, RDN: 2, RUP: 3, RMM: 4 } as const;
export const RM_NAMES = ['rne', 'rtz', 'rdn', 'rup', 'rmm'] as const;
/** Exception flags, as in fflags: NV invalid, DZ divide by zero, OF overflow, UF underflow, NX inexact. */
export const FLAG = { NX: 1, UF: 2, OF: 4, DZ: 8, NV: 16 } as const;
export const flagNames = (fl: number) => (['NV', 'DZ', 'OF', 'UF', 'NX'] as const).filter((_, i) => fl & (16 >> i)).join(' ') || '–';

/** A rounded result and the flags it raised. */
export interface FpResult { y: number; fl: number }

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

/** A signaling NaN: exponent all ones, quiet bit (top fraction bit) 0, fraction non-zero. */
export const isSNaN = (bits: number, f: FpFormat) => { const p = parts(bits, f); return p.kind === 'nan' && p.frac < 2 ** (f.M - 1); };

const pack = (sign: number, field: number, frac: number, f: FpFormat) => (sign * 2 ** f.E + field) * 2 ** f.M + frac;
const infOf = (sign: number, f: FpFormat) => pack(sign, 2 ** f.E - 1, 0, f);
const maxFinite = (sign: number, f: FpFormat) => pack(sign, 2 ** f.E - 2, 2 ** f.M - 1, f);
const nanResult = (fl: number, f: FpFormat): FpResult => ({ y: canonicalNaN(f), fl });

/** value = mant × 2^exp2 exactly (finite, non-NaN). */
function exact(bits: number, f: FpFormat): { sign: number; mant: bigint; exp2: number } {
  const p = parts(bits, f);
  if (p.field === 0) return { sign: p.sign, mant: BigInt(p.frac), exp2: 1 - p.bias - f.M };
  return { sign: p.sign, mant: BigInt(p.frac + 2 ** f.M), exp2: p.field - p.bias - f.M };
}

const bitLength = (v: bigint) => v.toString(2).length;

/** Should a magnitude be rounded up? lsb = last kept bit, g = first dropped bit, s = any later bit. */
export function roundUp(rm: number, sign: number, lsb: boolean, g: boolean, s: boolean): boolean {
  switch (rm) {
    case RM.RNE: return g && (s || lsb);
    case RM.RDN: return !!sign && (g || s);
    case RM.RUP: return !sign && (g || s);
    case RM.RMM: return g;
    default: return false; // RTZ (and the reserved encodings)
  }
}
/** Does an overflow round to infinity (otherwise to the largest finite number)? */
export const overflowToInf = (rm: number, sign: number) => rm === RM.RNE || rm === RM.RMM || (rm === RM.RUP && !sign) || (rm === RM.RDN && !!sign);

/** Round mant / 2^d (d > 0) to an integer: quotient, rounded quotient, inexact. */
function roundShift(mant: bigint, d: number, rm: number, sign: number): { n: bigint; inexact: boolean } {
  const D = BigInt(d), q = mant >> D, r = mant - (q << D);
  const g = ((r >> (D - 1n)) & 1n) === 1n, s = (r & ((1n << (D - 1n)) - 1n)) !== 0n;
  return { n: roundUp(rm, sign, (q & 1n) === 1n, g, s) ? q + 1n : q, inexact: r !== 0n };
}

/** Round sign × mant × 2^exp2 (mant > 0) to the format: the encoding and the flags. */
export function roundToX(sign: number, mant: bigint, exp2: number, f: FpFormat, rm: number = RM.RNE): FpResult {
  const b = bias(f), top = 2 ** f.E - 1, emin = 1 - b;
  const e = bitLength(mant) - 1 + exp2;            // unbiased exponent of the leading 1
  let qe = Math.max(e, emin) - f.M;               // weight of the last fraction bit
  const sh = exp2 - qe;
  let n: bigint, inexact = false;
  if (sh >= 0) n = mant << BigInt(sh);
  else ({ n, inexact } = roundShift(mant, -sh, rm, sign));
  if (n === 1n << BigInt(f.M + 1)) { n >>= 1n; qe += 1; }
  let fl = inexact ? FLAG.NX : 0;
  if (e < emin && inexact) {
    // tiny after rounding: rounded to M + 1 bits with an unbounded exponent, still below 2^emin?
    const u = exp2 - (e - f.M) < 0 ? roundShift(mant, e - f.M - exp2, rm, sign).n : mant << BigInt(exp2 - (e - f.M));
    if (!(e === emin - 1 && u === 1n << BigInt(f.M + 1))) fl |= FLAG.UF;
  }
  if (n < 1n << BigInt(f.M)) return { y: pack(sign, 0, Number(n), f), fl };   // subnormal (or zero)
  const field = qe + f.M + b;
  if (field >= top) return { y: overflowToInf(rm, sign) ? infOf(sign, f) : maxFinite(sign, f), fl: FLAG.OF | FLAG.NX };
  return { y: pack(sign, field, Number(n - (1n << BigInt(f.M))), f), fl };
}

/** Round to nearest even, encoding only (the explorer's and the original units' interface). */
export const roundTo = (sign: number, mant: bigint, exp2: number, f: FpFormat) => roundToX(sign, mant, exp2, f).y;

export function fpAddX(a: number, b: number, sub: boolean, f: FpFormat, rm: number = RM.RNE): FpResult {
  const pa = parts(a, f), pb0 = parts(b, f);
  const sb = pb0.sign ^ (sub ? 1 : 0);
  if (pa.kind === 'nan' || pb0.kind === 'nan') return nanResult(isSNaN(a, f) || isSNaN(b, f) ? FLAG.NV : 0, f);
  if (pa.kind === 'inf' && pb0.kind === 'inf') return pa.sign !== sb ? nanResult(FLAG.NV, f) : { y: infOf(pa.sign, f), fl: 0 };
  if (pa.kind === 'inf') return { y: infOf(pa.sign, f), fl: 0 };
  if (pb0.kind === 'inf') return { y: infOf(sb, f), fl: 0 };
  const x = exact(a, f), y = exact(b, f);
  const e = Math.min(x.exp2, y.exp2);
  const vx = (x.sign ? -1n : 1n) * (x.mant << BigInt(x.exp2 - e)), vy = (sb ? -1n : 1n) * (y.mant << BigInt(y.exp2 - e));
  const s = vx + vy;
  // exact zero: the common sign if both agree, otherwise +0 (−0 when rounding down)
  if (s === 0n) return { y: pack(pa.sign === sb ? pa.sign : rm === RM.RDN ? 1 : 0, 0, 0, f), fl: 0 };
  return roundToX(s < 0n ? 1 : 0, s < 0n ? -s : s, e, f, rm);
}

export function fpMulX(a: number, b: number, f: FpFormat, rm: number = RM.RNE): FpResult {
  const pa = parts(a, f), pb = parts(b, f), sign = pa.sign ^ pb.sign;
  if (pa.kind === 'nan' || pb.kind === 'nan') return nanResult(isSNaN(a, f) || isSNaN(b, f) ? FLAG.NV : 0, f);
  if ((pa.kind === 'inf' && pb.kind === 'zero') || (pa.kind === 'zero' && pb.kind === 'inf')) return nanResult(FLAG.NV, f);
  if (pa.kind === 'inf' || pb.kind === 'inf') return { y: infOf(sign, f), fl: 0 };
  if (pa.kind === 'zero' || pb.kind === 'zero') return { y: pack(sign, 0, 0, f), fl: 0 };
  const x = exact(a, f), y = exact(b, f);
  return roundToX(sign, x.mant * y.mant, x.exp2 + y.exp2, f, rm);
}

/** a / b. x / 0 (x finite, non-zero) is ∞ with DZ; 0 / 0 and ∞ / ∞ are invalid. */
export function fpDivX(a: number, b: number, f: FpFormat, rm: number = RM.RNE): FpResult {
  const pa = parts(a, f), pb = parts(b, f), sign = pa.sign ^ pb.sign;
  if (pa.kind === 'nan' || pb.kind === 'nan') return nanResult(isSNaN(a, f) || isSNaN(b, f) ? FLAG.NV : 0, f);
  if ((pa.kind === 'inf' && pb.kind === 'inf') || (pa.kind === 'zero' && pb.kind === 'zero')) return nanResult(FLAG.NV, f);
  if (pa.kind === 'inf') return { y: infOf(sign, f), fl: 0 };
  if (pb.kind === 'zero') return { y: infOf(sign, f), fl: FLAG.DZ };
  if (pa.kind === 'zero' || pb.kind === 'inf') return { y: pack(sign, 0, 0, f), fl: 0 };
  const x = exact(a, f), y = exact(b, f);
  // enough quotient bits that the remainder only matters as a sticky bit below the guard
  const K = 2 * f.M + 8, num = x.mant << BigInt(K), q = num / y.mant, r = num - q * y.mant;
  return roundToX(sign, (q << 1n) | (r ? 1n : 0n), x.exp2 - y.exp2 - K - 1, f, rm);
}

/**
 * Fused multiply-add, rounded once: (−1)^negProd × a × b + (−1)^negC × c. fmadd = (0, 0),
 * fmsub = (0, 1), fnmsub = (1, 0), fnmadd = (1, 1). ∞ × 0 is invalid even when c is a quiet NaN.
 */
export function fpFmaX(a: number, b: number, c: number, negProd: boolean, negC: boolean, f: FpFormat, rm: number = RM.RNE): FpResult {
  const pa = parts(a, f), pb = parts(b, f), pc = parts(c, f);
  const ps = pa.sign ^ pb.sign ^ (negProd ? 1 : 0), sc = pc.sign ^ (negC ? 1 : 0);
  if ((pa.kind === 'inf' && pb.kind === 'zero') || (pa.kind === 'zero' && pb.kind === 'inf')) return nanResult(FLAG.NV, f);
  if (pa.kind === 'nan' || pb.kind === 'nan' || pc.kind === 'nan') return nanResult(isSNaN(a, f) || isSNaN(b, f) || isSNaN(c, f) ? FLAG.NV : 0, f);
  const pInf = pa.kind === 'inf' || pb.kind === 'inf';
  if (pInf && pc.kind === 'inf' && ps !== sc) return nanResult(FLAG.NV, f);
  if (pInf) return { y: infOf(ps, f), fl: 0 };
  if (pc.kind === 'inf') return { y: infOf(sc, f), fl: 0 };
  const x = exact(a, f), y = exact(b, f), z = exact(c, f);
  const ep = x.exp2 + y.exp2, e = Math.min(ep, z.exp2);
  const vp = (ps ? -1n : 1n) * ((x.mant * y.mant) << BigInt(ep - e)), vc = (sc ? -1n : 1n) * (z.mant << BigInt(z.exp2 - e));
  const s = vp + vc;
  // an exact zero: the common sign of two zero terms, otherwise +0 (−0 when rounding down)
  if (s === 0n) return { y: pack(vp === 0n && vc === 0n && ps === sc ? ps : rm === RM.RDN ? 1 : 0, 0, 0, f), fl: 0 };
  return roundToX(s < 0n ? 1 : 0, s < 0n ? -s : s, e, f, rm);
}

/** Integer square root (floor) of a non-negative BigInt. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLength(n) + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** √a. √−0 = −0; the root of anything below zero (−∞ included) is invalid. */
export function fpSqrtX(a: number, f: FpFormat, rm: number = RM.RNE): FpResult {
  const p = parts(a, f);
  if (p.kind === 'nan') return nanResult(isSNaN(a, f) ? FLAG.NV : 0, f);
  if (p.kind === 'zero') return { y: a, fl: 0 };
  if (p.sign) return nanResult(FLAG.NV, f);
  if (p.kind === 'inf') return { y: a, fl: 0 };
  const x = exact(a, f);
  let m = x.mant, e = x.exp2;
  if (e & 1) { m <<= 1n; e -= 1; }               // an even exponent halves exactly
  const K = 2 * f.M + 8, n = m << BigInt(2 * K), s = isqrt(n);
  return roundToX(0, (s << 1n) | (s * s !== n ? 1n : 0n), e / 2 - K - 1, f, rm);
}

/** Integer (two's complement if signed) to float. */
export function fpFromIntX(v: number, signed: boolean, f: FpFormat, rm: number = RM.RNE, width = 32): FpResult {
  let x = BigInt(Math.floor(v) % 2 ** width);
  if (signed && x >= 1n << BigInt(width - 1)) x -= 1n << BigInt(width);
  if (x === 0n) return { y: 0, fl: 0 };
  return roundToX(x < 0n ? 1 : 0, x < 0n ? -x : x, 0, f, rm);
}

/**
 * Float to integer (fcvt.w.s / fcvt.wu.s): round in the given mode, then saturate. NaN and
 * out-of-range values (after rounding) raise NV and give the largest integer of the operand's
 * sign (NaN counts as positive); otherwise NX if rounding changed the value. The result is the
 * width-bit pattern.
 */
export function fpToIntX(a: number, signed: boolean, f: FpFormat, rm: number = RM.RNE, width = 32): FpResult {
  const p = parts(a, f), W = BigInt(width);
  const max = signed ? (1n << (W - 1n)) - 1n : (1n << W) - 1n, min = signed ? -(1n << (W - 1n)) : 0n;
  const enc = (v: bigint) => Number(BigInt.asUintN(width, v));
  if (p.kind === 'nan') return { y: enc(max), fl: FLAG.NV };
  if (p.kind === 'inf') return { y: enc(p.sign ? min : max), fl: FLAG.NV };
  const x = exact(a, f);
  let n: bigint, inexact = false;
  if (x.exp2 >= 0) n = x.mant << BigInt(x.exp2);
  else ({ n, inexact } = roundShift(x.mant, -x.exp2, rm, p.sign));
  const v = p.sign ? -n : n;
  if (v > max || v < min) return { y: enc(p.sign ? min : max), fl: FLAG.NV };
  return { y: enc(v), fl: inexact ? FLAG.NX : 0 };
}

/** feq / flt / fle: 0 or 1. feq is quiet (NV only for signaling NaNs), flt and fle signal on any NaN. */
export function fpCmpX(a: number, b: number, op: 'eq' | 'lt' | 'le', f: FpFormat): FpResult {
  const pa = parts(a, f), pb = parts(b, f);
  if (pa.kind === 'nan' || pb.kind === 'nan') return { y: 0, fl: op !== 'eq' || isSNaN(a, f) || isSNaN(b, f) ? FLAG.NV : 0 };
  const A = fpValue(a, f), B = fpValue(b, f);
  return { y: (op === 'eq' ? A === B : op === 'lt' ? A < B : A <= B) ? 1 : 0, fl: 0 };
}

/**
 * fmin.s / fmax.s (IEEE 754-2019 minimumNumber / maximumNumber): a NaN operand is ignored,
 * two NaNs give the canonical NaN, −0 is smaller than +0, and NV only for a signaling NaN.
 */
export function fpMinMaxX(a: number, b: number, max: boolean, f: FpFormat): FpResult {
  const pa = parts(a, f), pb = parts(b, f);
  const fl = isSNaN(a, f) || isSNaN(b, f) ? FLAG.NV : 0;
  if (pa.kind === 'nan' && pb.kind === 'nan') return { y: canonicalNaN(f), fl };
  if (pa.kind === 'nan') return { y: b, fl };
  if (pb.kind === 'nan') return { y: a, fl };
  const A = fpValue(a, f), B = fpValue(b, f);
  const aLess = A < B || (A === B && pa.sign > pb.sign);
  return { y: aLess !== max ? a : b, fl };
}

/** fclass.s: a one-hot 10-bit mask. */
export function fpClass(a: number, f: FpFormat): number {
  const p = parts(a, f);
  switch (p.kind) {
    case 'nan': return isSNaN(a, f) ? 1 << 8 : 1 << 9;
    case 'inf': return p.sign ? 1 << 0 : 1 << 7;
    case 'normal': return p.sign ? 1 << 1 : 1 << 6;
    case 'subnormal': return p.sign ? 1 << 2 : 1 << 5;
    default: return p.sign ? 1 << 3 : 1 << 4;
  }
}
export const FCLASS_NAMES = ['−∞', '−normal', '−subnormal', '−0', '+0', '+subnormal', '+normal', '+∞', 'sNaN', 'qNaN'];

// the original round-to-nearest-even interface (encodings only)
export const fpAddRef = (a: number, b: number, sub: boolean, f: FpFormat) => fpAddX(a, b, sub, f).y;
export const fpMulRef = (a: number, b: number, f: FpFormat) => fpMulX(a, b, f).y;
export const fpFromIntRef = (v: number, signed: boolean, f: FpFormat, width = 32) => fpFromIntX(v >>> 0, signed, f, RM.RNE, width).y;

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
