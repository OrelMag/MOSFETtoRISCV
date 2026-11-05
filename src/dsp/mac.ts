// The RV32's MAC, as a model (DOM-free): the specification of lib/macunit.ts (gates, compared with it every cycle) and of the golden model's four
// instructions (riscv/iss.ts), so the three cannot disagree. One 40-bit accumulator; mac / mac2 add signed 16 x 16 products, clracc empties it, and
// racc reads it once: shift right (arithmetic), add the first dropped bit back (round half up), clamp to 32 bits (dsp/fixed.ts's rules,
// comm/fftfix.ts's "keep every bit, round once").

/** The accumulator's width. Past it the sum wraps, as any two's complement register does: no guard, no saturation. */
export const ACC_BITS = 40;

/** funct3 of the four instructions on custom-2 (R-type, funct7 0). */
export const MAC_F3 = { mac: 0, mac2: 1, clracc: 2, racc: 3 } as const;
export type MacOp = keyof typeof MAC_F3;
export const MAC_OPS: readonly MacOp[] = ['mac', 'mac2', 'clracc', 'racc'];

/** The signed 16-bit half of a word: lo (bits 15:0) or hi (31:16). */
export const half = (w: number, hi: boolean): number => (hi ? (w | 0) >> 16 : (w << 16) >> 16);

export const wrapAcc = (v: bigint): bigint => BigInt.asIntN(ACC_BITS, v);

/** The product(s) a mac or mac2 adds: lo x lo, and for mac2 hi x hi too. */
export const macProduct = (f3: number, a: number, b: number): bigint =>
  BigInt(half(a, false) * half(b, false)) + (f3 === MAC_F3.mac2 ? BigInt(half(a, true) * half(b, true)) : 0n);

/** The accumulator after one instruction (funct3 0..3; racc leaves it as it is). */
export function accAfter(acc: bigint, f3: number, a: number, b: number): bigint {
  if (f3 === MAC_F3.clracc) return 0n;
  if (f3 === MAC_F3.racc) return acc;
  return wrapAcc(acc + macProduct(f3, a, b));
}

export interface Raccd { y: number; sat: boolean; exact: bigint }

/**
 * racc: round(acc / 2^sh) half up (the first dropped bit added back, none when sh = 0), then clamped to a signed 32-bit word. sh is the low six bits
 * of rs1: 0 .. 63, so a shift past the accumulator's width leaves only the sign (and its rounding).
 */
export function raccOf(acc: bigint, shift: number): Raccd {
  const sh = BigInt(shift & 63);
  const exact = (acc + (sh > 0n ? 1n << (sh - 1n) : 0n)) >> sh;
  const y = exact > 0x7fffffffn ? 0x7fffffff : exact < -0x80000000n ? -0x80000000 : Number(exact);
  return { y, sat: BigInt(y) !== exact, exact };
}

/** The state machine of the instructions, for tests and the widgets: a register file is not part of it. */
export class MacModel {
  acc = 0n;
  /** One instruction. Returns racc's result (signed), else undefined. */
  exec(f3: number, a: number, b: number): number | undefined {
    if (f3 === MAC_F3.racc) return raccOf(this.acc, a).y;
    this.acc = accAfter(this.acc, f3, a, b);
    return undefined;
  }
}

/** The accumulator in hex, 10 digits (40 bits), as the panels show it. */
export const accHex = (acc: bigint): string => BigInt.asUintN(ACC_BITS, acc).toString(16).padStart(10, '0');
