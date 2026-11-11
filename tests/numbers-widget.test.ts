// The number explorer's flags (widgets/numbers.ts numOp) mean what the binary chapter and the ALU say: C is the adder's carry out,
// which after an add is "the unsigned result wrapped" and after a subtract (−1, negate: ¬b + 1, as the ALU subtracts) is "no borrow",
// the flag bltu reads as ¬C; V is "the signed result does not fit". Checked here against those definitions, not against the adder.

import { describe, expect, it } from 'vitest';
import { numOp, type NumOp } from '../src/widgets/numbers';

/** Every value at 4 and 8 bits; at 32 bits the edges and a spread between them. */
function* cases(): Generator<[number, number]> {
  for (const w of [4, 8]) for (let v = 0; v < 2 ** w; v++) yield [w, v];
  const M = 2 ** 32;
  for (const v of [0, 1, 2, 0x7ffffffe, 0x7fffffff, 0x80000000, 0x80000001, M - 2, M - 1, 0x12345678, 0xdeadbeef]) yield [32, v];
}

const signedOf = (x: number, w: number) => (x >= 2 ** (w - 1) ? x - 2 ** w : x);
const fits = (x: number, w: number) => x >= -(2 ** (w - 1)) && x < 2 ** (w - 1);

describe('number explorer: C and V', () => {
  it('adds (+1, ×2): C = the unsigned result wrapped, V = the signed result does not fit', () => {
    for (const [w, v] of cases()) {
      for (const [k, d] of [['inc', 1], ['shl', v]] as [NumOp, number][]) {
        const r = numOp(k, v, w), s = signedOf(v, w) + signedOf(d, w);
        expect(r.v, `${k} ${v} @${w}`).toBe((v + d) % 2 ** w);
        expect(r.C, `${k} ${v} @${w}`).toBe(v + d >= 2 ** w ? 1 : 0);
        expect(r.V, `${k} ${v} @${w}`).toBe(fits(k === 'inc' ? signedOf(v, w) + 1 : s, w) ? 0 : 1);
      }
    }
  });

  it('subtracts (−1 = v − 1, negate = 0 − v): C = no borrow (as the ALU and bltu read it), V = the signed result does not fit', () => {
    for (const [w, v] of cases()) {
      const dec = numOp('dec', v, w), neg = numOp('neg', v, w);
      expect(dec.v).toBe((v - 1 + 2 ** w) % 2 ** w);
      expect(dec.C, `${v} − 1 @${w}`).toBe(v >= 1 ? 1 : 0);
      expect(dec.V, `${v} − 1 @${w}`).toBe(fits(signedOf(v, w) - 1, w) ? 0 : 1);
      expect(neg.v).toBe((2 ** w - v) % 2 ** w);
      expect(neg.C, `0 − ${v} @${w}`).toBe(v === 0 ? 1 : 0);
      expect(neg.V, `0 − ${v} @${w}`).toBe(fits(-signedOf(v, w), w) ? 0 : 1);
    }
  });

  it('the cases the review named: 5 − 1 does not borrow, 0 − 1 does; negating 0 does not borrow, negating 5 does', () => {
    expect(numOp('dec', 5, 8)).toEqual({ v: 4, C: 1, V: 0 });
    expect(numOp('dec', 0, 8)).toEqual({ v: 255, C: 0, V: 0 });
    expect(numOp('neg', 0, 8)).toEqual({ v: 0, C: 1, V: 0 });
    expect(numOp('neg', 5, 8)).toEqual({ v: 251, C: 0, V: 0 });
    expect(numOp('neg', 128, 8)).toEqual({ v: 128, C: 0, V: 1 });
  });
});
