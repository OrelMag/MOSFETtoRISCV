// A check on the check: the lock-step comparison must notice a model that is wrong in a few ways. Each mutant is the golden model with one
// rule broken (a hook in iss24.ts), run against the gates on the benchmark that reaches it; the comparison must report a mismatch.
// A mutant it misses is a failing test.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { assemble24 } from '../src/dsp/asm24';
import { accAfter, MAC_F3 } from '../src/dsp/mac';
import { aguStep, Iss24, rev8, rndOf, s16, sat16 } from '../src/dsp/iss24';
import { BENCH24 } from '../src/dsp/programs24';
import { dsp24Computer } from '../src/lib/dsp24core';
import { DspRig } from './dsp-core-kit';
import { randomProgram } from './dsp-core-kit';
import { tick } from './yieldtick';

type Ctor = new (p: ArrayLike<number>, x: ArrayLike<number>, y: ArrayLike<number>) => Iss24;

class Honest extends Iss24 {}
/** The circular window one word too long. */
class WrapLate extends Iss24 {
  protected override stepPtr(p: number, mode: number, base: number, len: number, m: number) { return aguStep(p, mode, base, mode === 4 || mode === 5 ? len + 1 : len, m); }
}
/** The circular window one word too short. */
class WrapEarly extends Iss24 {
  protected override stepPtr(p: number, mode: number, base: number, len: number, m: number) { return aguStep(p, mode, base, mode === 4 || mode === 5 ? len - 1 : len, m); }
}
/** Bit-reversed order one step off. */
class RevOff extends Iss24 {
  protected override stepPtr(p: number, mode: number, base: number, len: number, m: number) { return mode === 6 ? (aguStep(p, 6, base, len, m) + 1) & 255 : aguStep(p, mode, base, len, m); }
}
/** Bit-reversed order, but the modifier is added as it is, not reversed. */
class RevPlain extends Iss24 {
  protected override stepPtr(p: number, mode: number, base: number, len: number, m: number) {
    return mode === 6 ? rev8((rev8(p) + m) & 255) : aguStep(p, mode, base, len, m);
  }
}
/** The loop leaves one pass early. */
class LoopEarly extends Iss24 {
  protected override lastPass(lc: number) { return lc <= 2; }
}
/** The loop runs one pass too many. */
class LoopLate extends Iss24 {
  protected override lastPass(lc: number) { return lc === 0; }
}
/** The read truncates instead of rounding. */
class NoRound extends Iss24 {
  protected override readAcc(acc: bigint, sh: number) { return sat16(Number(acc >> BigInt(sh))); }
}
/** The read rounds half to even. */
class RoundEven extends Iss24 {
  protected override readAcc(acc: bigint, sh: number) {
    if (sh === 0) return rndOf(acc, sh);
    const q = acc >> BigInt(sh), rem = acc - (q << BigInt(sh)), half = 1n << BigInt(sh - 1);
    return sat16(Number(rem > half || (rem === half && (q & 1n) === 1n) ? q + 1n : q));
  }
}
/** The accumulator treats the coefficient as unsigned. */
class UnsignedY extends Iss24 {
  protected override macAcc(acc: bigint, x: number, y: number) { return accAfter(acc, MAC_F3.mac, x, y & 0x7fff); }
}
/** The accumulator is 32 bits, not 40. */
class Acc32 extends Iss24 {
  protected override macAcc(acc: bigint, x: number, y: number) { return BigInt.asIntN(32, accAfter(acc, MAC_F3.mac, x, y)); }
}
/** The saturating add wraps. */
class WrapAdds extends Iss24 {
  protected override satAdd(v: number) { return s16(v); }
}

const bench = (id: string) => BENCH24.find((b) => b.id === id)!;

async function caught(M: Ctor, program: { words: number[]; x: number[]; y: number[] }, cycles: number): Promise<string | null> {
  const rig = new DspRig(dsp24Computer(program.words, program.x, program.y), program.words, program.x, program.y, { iss: new M(program.words, program.x, program.y) });
  rig.run(cycles, (i) => void (i % 300 === 0 && tick()));
  await tick();
  return rig.mismatches[0] ?? rig.memoryMismatch();
}
const of = (id: string) => ({ words: assemble24(bench(id).src).words, x: bench(id).x, y: bench(id).y });

/** A product of exactly one half at the rounding shift, and eight full-scale products that overflow 32 bits. */
const MAC_CORNERS = (() => {
  const a = assemble24(`
        clr
        mac  x(p0)+, y(p4)+     ; 1 · 16384 = half of 2^15
        rnd  r1, 15             ; a tie: half up gives 1, half to even 0
        out  r1
        clr
        ldi  p1, 100
        ldi  p5, 100
        loop 8, big
big:    mac  x(p1), y(p5)       ; 8 · 32767 · 32767: more than 2^32
        rnd  r2, 24
        out  r2
        halt
`);
  const x = Array(256).fill(0), y = Array(256).fill(0);
  x[0] = 1; y[0] = 16384; x[100] = 0x7fff; y[100] = 0x7fff;
  return { words: a.words, x, y };
})();

const ALU_CORNERS = (() => {
  const a = assemble24(`
        ldi  r1, 255
        ldh  r1, 0x7f
        ldi  r2, 1
        adds r4, r1, r2
        out  r4
        halt
`);
  return { words: a.words, x: [], y: [] };
})();

describe('the comparison notices a model that is wrong', () => {
  it('the honest model is not reported (the control)', async () => {
    expect(await caught(Honest, of('fir16'), 3000)).toBeNull();
  });
  const cases: [string, Ctor, () => { words: number[]; x: number[]; y: number[] }][] = [
    ['circular window one too long (FIR delay line)', WrapLate, () => of('fir16')],
    ['circular window one too short (FIR delay line)', WrapEarly, () => of('fir16')],
    ['bit-reverse one step off (FFT copy)', RevOff, () => of('fft')],
    ['bit-reverse adds the modifier unreversed (FFT copy)', RevPlain, () => of('fft')],
    ['loop leaves one pass early (dot product)', LoopEarly, () => of('dot')],
    ['loop runs one pass too many (dot product)', LoopLate, () => of('dot')],
    ['mac read truncates instead of rounding (FIR)', NoRound, () => of('fir16')],
    ['mac read rounds half to even (a tie)', RoundEven, () => MAC_CORNERS],
    ['coefficient taken as unsigned (FIR)', UnsignedY, () => of('fir16')],
    ['accumulator 32 bits, not 40 (eight full-scale products)', Acc32, () => MAC_CORNERS],
    ['saturating add wraps (ALU corners)', WrapAdds, () => ALU_CORNERS],
  ];
  for (const [name, M, prog] of cases) {
    it(name, async () => {
      expect(await caught(M, prog(), 6000), name).not.toBeNull();
    }, 120000);
  }
  it('a random program is enough to notice a wrong circular window too', async () => {
    let found = false;
    for (let seed = 1; seed <= 12 && !found; seed++) found = (await caught(WrapLate, randomProgram(seed), 500)) !== null;
    expect(found).toBe(true);
  }, 120000);
});
