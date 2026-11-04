// ram(k, w) is gates and bigRam(k, w) a behavioural leaf: two different parts, whichever is built first. They shared an id at k ≥ 7, and define() hands back the
// first part of an id, so a page that built bigRam(7, 8) changed the memory of a CPU built later (its seeded data never arrived: riscv-tests' rv32mi-ma_addr).

import { describe, expect, it } from 'vitest';
import { bigRam } from '../src/lib/bigmem';
import { bankedMemory } from '../src/lib/lsu';
import { ram } from '../src/lib/memory';
import { resolveComponent } from '../src/lib/resolve';

describe('ram and bigRam', () => {
  it('stay two parts at the sizes both offer, in either order', () => {
    for (const [k, w] of [[7, 8], [8, 3], [9, 16]] as const) {
      const big = bigRam(k, w), gates = ram(k, w);
      expect(big).not.toBe(gates);
      expect(big.id).not.toBe(gates.id);
      expect(big.behavior).toBeDefined();
      expect(gates.behavior).toBeUndefined();
      expect(ram(k, w)).toBe(gates);
    }
  });
  it('a byte-banked memory is gates, whatever was built before it', () => {
    bigRam(7, 8);
    const b = bankedMemory(7).netlist!().instances.find((i) => i.name === 'b0')!.def;
    expect(b.behavior).toBeUndefined();
    expect(b.netlist).toBeDefined();
  });
  it('each id still resolves to its own part', () => {
    expect(resolveComponent(bigRam(7, 8).id)).toBe(bigRam(7, 8));
    expect(resolveComponent(ram(7, 8).id)).toBe(ram(7, 8));
    expect(resolveComponent(ram(5, 8).id)).toBe(ram(5, 8));
  });
});
