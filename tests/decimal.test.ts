// sim/decimal.ts: exact expansions, correctly rounded parsing, and the 6 / 9 (15 / 17) digit rules.
import { describe, expect, it } from 'vitest';
import { digitsSurviving, digitsToRoundTrip, exactDecimal, exactSum, parseDecimal, printSig, shortestDigits, sigDigits } from '../src/sim/decimal';
import { F16, F32, bitsToF32, f32ToBits } from '../src/sim/fpref';

describe('decimal', () => {
  it('exact expansions', () => {
    expect(exactDecimal(0.1)).toBe('0.1000000000000000055511151231257827021181583404541015625');
    expect(exactDecimal(Math.fround(0.1))).toBe('0.100000001490116119384765625');
    expect(exactDecimal(0.5)).toBe('0.5');
    expect(exactDecimal(-1024)).toBe('−1024');
    expect(exactDecimal(2 ** 70)).toBe('1180591620717411303424');
  });
  it('0.1 + 0.2 in float64', () => {
    expect(0.1 + 0.2).toBe(0.30000000000000004);
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });
  it('digit counts', () => {
    expect([digitsToRoundTrip(24), digitsToRoundTrip(53), digitsSurviving(24), digitsSurviving(53)]).toEqual([9, 17, 6, 15]);
    expect([digitsToRoundTrip(11), digitsSurviving(11)]).toEqual([5, 3]);
  });
  it('parsing agrees with the host where the host rounds once', () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 3000; i++) {
      const t = (rnd() * 10 ** (1 + Math.floor(rnd() * 6))).toFixed(Math.floor(rnd() * 7));
      expect(parseDecimal(t, F32), t).toBe(f32ToBits(Math.fround(Number(t))));
    }
    expect(parseDecimal('1e-50', F32)).toBe(0);
    expect(parseDecimal('1e50', F32)).toBe(0x7f800000);
    expect(parseDecimal('0.1', F32)).toBe(0x3dcccccd);
    expect(parseDecimal('x', F32)).toBeNull();
  });
  it('9 digits always bring a float32 back, 6-digit text survives', () => {
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 4000; i++) {
      const b = Math.floor(rnd() * 0x7f800000);
      const v = bitsToF32(b);
      expect(parseDecimal(printSig(v, 9), F32), `bits ${b}`).toBe(b);
      expect(shortestDigits(b, F32)).toBeLessThanOrEqual(9);
      const d = Math.floor(100000 + rnd() * 900000), e = Math.floor(rnd() * 60) - 30;
      const t = `${d}e${e}`, back = parseDecimal(t, F32)!;
      expect(Number(printSig(bitsToF32(back), 6)), t).toBe(Number(t));
    }
    // 8 digits can be too few: 16777217 and 16777216 share a float32 only with 8 digits
    expect(parseDecimal('16777217', F32)).toBe(parseDecimal('16777216', F32));
  });
  it('5 digits bring a binary16 back', () => {
    for (let b = 0; b < 0x7c00; b++) expect(parseDecimal(printSig(Math.abs(fpV(b)), 5), F16)).toBe(b);
    expect(sigDigits('0.00123')).toBe(3);
    expect(sigDigits('1.500e3')).toBe(2);
  });
});
import { fpValue } from '../src/sim/fpref';
const fpV = (b: number) => fpValue(b, F16);

describe('the float chapter quotes it', () => {
  it('prose figures', async () => {
    const { chFloat } = await import('../src/chapters/ch-float');
    const { B8, T7 } = await import('../src/chapters/float/decimal');
    const { bitsToF32: b2f } = await import('../src/sim/fpref');
    const t = chFloat.steps.map((s) => [s.body, ...Object.values(s.more ?? {}).map((m) => (typeof m === 'function' ? '' : m))].join(' ')).join(' ');
    expect(t).toContain('0.100000001490116119384765625');
    expect(t).toContain('0.30000000000000004');
    // the 8-digit collision and the 7-digit text that does not survive
    expect(parseDecimal(printSig(b2f(B8), 8), F32) === B8 && parseDecimal(printSig(b2f(B8 + 1), 8), F32) === B8 + 1).toBe(false);
    expect(printSig(b2f(B8), 8)).toBe(printSig(b2f(B8 + 1), 8));
    expect(printSig(b2f(B8), 9)).not.toBe(printSig(b2f(B8 + 1), 9));
    expect(Number(printSig(b2f(parseDecimal(T7, F32)!), 7))).not.toBe(Number(T7));
    // the sum before rounding, and 0.05 / 0.35 stored above / below
    expect(exactSum(0.1, 0.2)).toBe('0.3000000000000000166533453693773481063544750213623046875');
    expect(exactDecimal(0.05) > '0.05').toBe(true);
    expect(exactDecimal(0.35) < '0.35').toBe(true);
    expect(exactDecimal(0.125)).toBe('0.125');
  });
});
