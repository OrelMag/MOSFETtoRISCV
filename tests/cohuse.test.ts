import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { cohUse, isMem } from '../src/widgets/cohuse';

const w = (s: string) => assemble(s).words[0];
describe('coherent dual-core instruction marks', () => {
  it('only memory instructions touch a cache', () => {
    for (const s of ['lw t0, 0(s0)', 'sw t0, 0(s0)', 'amoadd.w t0, t1, (s0)', 'lr.w t0, (s0)', 'sc.w t1, t0, (s0)']) expect(isMem(w(s)), s).toBe(true);
    expect(isMem(w('addi t0, t0, 1'))).toBe(false);
    expect(cohUse(w('addi t0, t0, 1'), 1).units).toEqual(['core1']);
  });
  it('a miss lights the bus and memory, a flush the other cache', () => {
    expect(cohUse(w('lw t0, 0(s0)'), 0).units).toEqual(['core0', 'cache0']);
    expect(cohUse(w('lw t0, 0(s0)'), 0, { bus: true, flush: true }).units).toEqual(['core0', 'cache0', 'bus', 'dm', 'cache1']);
  });
});
