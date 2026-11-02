import { describe, expect, it } from 'vitest';
import { groupDigits, ungroupDigits } from '../src/sim/numfmt';

describe('groupDigits', () => {
  it('groups from five digits with U+202F', () => {
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(999)).toBe('999');
    expect(groupDigits(1024)).toBe('1024');
    expect(groupDigits(9999)).toBe('9999');
    expect(groupDigits(12345)).toBe('12 345');
    expect(groupDigits(2714935)).toBe('2 714 935');
    expect(groupDigits(1000000)).toBe('1 000 000');
  });
  it('handles negatives and fractions', () => {
    expect(groupDigits(-1234567)).toBe('-1 234 567');
    expect(groupDigits(-123)).toBe('-123');
    expect(groupDigits(12345.6789)).toBe('12 345.6789');
    expect(groupDigits(0.12345)).toBe('0.12345');
  });
  it('handles bigint and non-finite', () => {
    expect(groupDigits(123456789012345678901234567890n)).toBe('123 456 789 012 345 678 901 234 567 890');
    expect(groupDigits(NaN)).toBe('NaN');
    expect(groupDigits(Infinity)).toBe('Infinity');
  });
  it('round-trips through ungroupDigits', () => {
    for (const n of [0, 5, 12345, -2714935, 1e9]) expect(Number(ungroupDigits(groupDigits(n)))).toBe(n);
    expect(ungroupDigits('1,234,567')).toBe('1234567');
  });
});
