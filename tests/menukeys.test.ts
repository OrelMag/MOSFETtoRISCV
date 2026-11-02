import { describe, expect, it } from 'vitest';
import { menuStep } from '../src/ui/menukeys';

describe('menuStep', () => {
  it('wraps Down and Up, Home and End jump', () => {
    expect(menuStep('ArrowDown', -1, 3)).toBe(0);
    expect(menuStep('ArrowDown', 2, 3)).toBe(0);
    expect(menuStep('ArrowUp', 0, 3)).toBe(2);
    expect(menuStep('ArrowUp', -1, 3)).toBe(2);
    expect(menuStep('Home', 2, 3)).toBe(0);
    expect(menuStep('End', 0, 3)).toBe(2);
    expect(menuStep('ArrowDown', -1, 0)).toBe(-1);
    expect(menuStep('a', 0, 3)).toBe(-1);
  });
});
