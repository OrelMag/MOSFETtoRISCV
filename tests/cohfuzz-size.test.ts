import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { randomCoherentProgram } from '../src/riscv/cohfuzz';

// Release review sweep: the generator's size count matched /^w+:$/ (a lost backslash), so label lines took up the
// 40-instruction budget and every program came out shorter than meant (48 words at most over these seeds).
describe('random coherent programs', () => {
  it('use their instruction budget (labels do not count) and fit the 64-word ROM', () => {
    const sizes = Array.from({ length: 300 }, (_, i) => assemble(randomCoherentProgram(i + 1)).words.length);
    expect(Math.max(...sizes)).toBeGreaterThan(48);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
  });
});
