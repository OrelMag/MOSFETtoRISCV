// Spike cannot check custom-2, so the lock-step comparison of the MAC core (gates against the golden model) is the only judge of the MAC. Is it a good judge?
// Each mutant below is a golden model with one deliberate fault in the MAC's arithmetic. For each: first the mutant must differ from the real model on the program
// (else the program proves nothing about that fault), then the comparison must report it. A mutant the comparison does not report is a failing test.
import { describe, expect, it } from 'vitest';
import { accAfter, half, macProduct, MAC_F3, raccOf, wrapAcc } from '../src/dsp/mac';
import { assemble } from '../src/riscv/asm';
import { ISS, type IssOptions } from '../src/riscv/iss';
import { firstMismatch } from './verify/maclock';

const SRC = `
  li   t0, 0x7fff8000
  li   t1, 0x80007fff
  li   t2, 0xfffe0003
  li   t3, 0x00018001
  clracc
  mac  t0, t1
  mac2 t2, t3
  mac2 t0, t0
  racc a0, zero
  li   s0, 1
  racc a1, s0
  li   s0, 15
  racc a2, s0
  li   s0, 40
  racc a3, s0
  li   s0, 63
  racc a4, s0
  li   s0, 32
  racc a5, s0
  clracc
  mac  t3, t3
  li   s0, 1
  racc s4, s0
  mac  t2, t2
  racc s5, s0
  mac2 t3, t2
  racc s6, s0
  li   s1, 300
big:
  mac2 t0, t0
  addi s1, s1, -1
  bnez s1, big
  racc a6, zero
  li   s0, 8
  racc a7, s0
  clracc
  racc s2, zero
  mac  t3, t3
  racc s3, zero
  li   s7, 1
  li   s8, -5
  clracc
  mac  s7, s8
  li   s0, 1
  racc s9, s0
  sw   a0, 0(zero)
  sw   a6, 4(zero)
  j .
`;

type Mutant = NonNullable<IssOptions['macMutant']>;
const clamp = (v: bigint, bits: number) => { const hi = (1n << BigInt(bits - 1)) - 1n, lo = -(1n << BigInt(bits - 1)); return v > hi ? hi : v < lo ? lo : v; };
const raccWith = (round: (acc: bigint, sh: bigint) => bigint, bits = 32, shiftMask = 63) => (acc: bigint, shift: number) => {
  const sh = BigInt(shift & shiftMask), exact = round(acc, sh);
  const y = clamp(exact, bits);
  return { y: Number(BigInt.asIntN(32, y)), sat: y !== exact, exact };
};
const unsignedLo = (w: number) => w & 0xffff;

const MUTANTS: [string, Mutant][] = [
  ['mac2 drops the high product', { accAfter: (acc, f3, a, b) => (f3 === MAC_F3.mac2 ? wrapAcc(acc + BigInt(half(a, false) * half(b, false))) : accAfter(acc, f3, a, b)) }],
  ['mac2 adds the high product twice', { accAfter: (acc, f3, a, b) => (f3 === MAC_F3.mac2 ? wrapAcc(acc + macProduct(f3, a, b) + BigInt(half(a, true) * half(b, true))) : accAfter(acc, f3, a, b)) }],
  ['mac takes the low halves unsigned', { accAfter: (acc, f3, a, b) => (f3 === MAC_F3.mac ? wrapAcc(acc + BigInt(unsignedLo(a) * unsignedLo(b))) : accAfter(acc, f3, a, b)) }],
  ['the accumulator wraps at 32 bits, not 40', { accAfter: (acc, f3, a, b) => BigInt.asIntN(32, accAfter(acc, f3, a, b)) }],
  ['the accumulator wraps at 48 bits, not 40', { accAfter: (acc, f3, a, b) => (f3 < 2 ? BigInt.asIntN(48, acc + macProduct(f3, a, b)) : accAfter(acc, f3, a, b)) }],
  ['clracc does nothing', { accAfter: (acc, f3, a, b) => (f3 === MAC_F3.clracc ? acc : accAfter(acc, f3, a, b)) }],
  ['racc truncates instead of rounding', { raccOf: raccWith((acc, sh) => acc >> sh) }],
  ['racc rounds ties down', { raccOf: raccWith((acc, sh) => (sh > 0n ? (acc + (1n << (sh - 1n)) - 1n) >> sh : acc)) }],
  ['racc rounds ties away from zero', { raccOf: raccWith((acc, sh) => (sh > 0n ? (acc + (acc < 0n ? -(1n << (sh - 1n)) : 1n << (sh - 1n))) / (1n << sh) : acc)) }],
  ['racc clamps at 16 bits', { raccOf: raccWith((acc, sh) => (acc + (sh > 0n ? 1n << (sh - 1n) : 0n)) >> sh, 16) }],
  ['racc clamps at 31 bits', { raccOf: raccWith((acc, sh) => (acc + (sh > 0n ? 1n << (sh - 1n) : 0n)) >> sh, 31) }],
  ['racc does not clamp (the low 32 bits)', { raccOf: raccWith((acc, sh) => (acc + (sh > 0n ? 1n << (sh - 1n) : 0n)) >> sh, 41) }],
  ['racc reads the shift in 5 bits', { raccOf: (acc, shift) => raccOf(acc, shift & 31) }],
  ['racc shifts a logical right', { raccOf: raccWith((acc, sh) => (BigInt.asUintN(40, acc) + (sh > 0n ? 1n << (sh - 1n) : 0n)) >> sh) }],
];

describe('the lock-step comparison against a golden model with one fault in the MAC', () => {
  const words = assemble(SRC, [], { mac: true }).words;
  it('the real model agrees with the gates on this program', async () => {
    const r = await firstMismatch(words);
    expect(r.mismatch).toBeNull();
    expect(r.iss.halted).toBe(true);
  }, 120000);
  for (const [name, mutant] of MUTANTS) {
    it(`reports: ${name}`, async () => {
      // 1. the fault is visible on this program at all (else the test below could pass for no reason)
      const real = new ISS(words, { mac: true }), bad = new ISS(words, { mac: true, macMutant: mutant });
      real.run(5000); bad.run(5000);
      expect([...bad.x, bad.acc, ...bad.dmem].map(String), `${name}: the mutant must differ from the real model on the program`).not.toEqual([...real.x, real.acc, ...real.dmem].map(String));
      // 2. the comparison notices
      const r = await firstMismatch(words, { macMutant: mutant });
      expect(r.mismatch, `${name}: not reported`).not.toBeNull();
      expect(r.mismatch!.text).toMatch(/differs after/);
    }, 120000);
  }
});
