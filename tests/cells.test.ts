import { describe, expect, it } from 'vitest';
import { DRAM_CELL, SRAM_COLUMN } from '../src/lib';
import { flatten, findNode } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BX, BZ } from '../src/sim/types';

function sim(def: Parameters<typeof flatten>[0]) {
  const s = new SwitchSim(flatten(def, { mode: 'switch' }));
  const set = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) s.setInput(k, x); s.settle(); };
  const out = (p: string) => s.getBits(s.design.root.ports[p])[0];
  const node = (path: string[], net: string) => {
    const n = findNode(s.design.root, path)!;
    const i = n.def.netlist!().nets.findIndex((x) => x.name === net);
    return s.get(n.nets![i][0]);
  };
  return { s, set, out, node };
}

describe('6T SRAM column (switch level, strengths and bit-line charge)', () => {
  it('powers up unknown, writes, holds, reads and is not disturbed by reads', () => {
    const { s, set, out, node } = sim(SRAM_COLUMN);
    set({ pre_n: 1, w0: 0, w1: 0, wl0: 0, wl1: 0 });
    expect(node(['c0'], 'q')).toBe(BX);
    // write 1 into cell 0: pull bl̄ low, word line high
    set({ w1: 1, wl0: 1 });
    expect(node(['c0'], 'q')).toBe(B1);
    expect(node(['c0'], 'q̄')).toBe(B0);
    expect(s.shorted.some((x) => x)).toBe(false);
    set({ wl0: 0, w1: 0 });
    expect(node(['c0'], 'q')).toBe(B1); // holds
    // write 0 into cell 1
    set({ w0: 1, wl1: 1 });
    expect(node(['c1'], 'q')).toBe(B0);
    set({ wl1: 0, w0: 0 });
    // precharge, then release: bit lines keep their charge
    set({ pre_n: 0 });
    expect([out('bl'), out('blb')]).toEqual([B1, B1]);
    set({ pre_n: 1 });
    expect([out('bl'), out('blb')]).toEqual([B1, B1]);
    // read cell 0 (stores 1): bl̄ discharges
    set({ wl0: 1 });
    expect([out('bl'), out('blb')]).toEqual([B1, B0]);
    expect(node(['c0'], 'q')).toBe(B1);
    set({ wl0: 0, pre_n: 0 });
    set({ pre_n: 1, wl1: 1 });
    expect([out('bl'), out('blb')]).toEqual([B0, B1]);
    expect(node(['c1'], 'q')).toBe(B0);
    // overwrite cell 1 with 1 while selected
    set({ wl1: 1, w1: 1 });
    expect(node(['c1'], 'q')).toBe(B1);
  });
  it('precharging while writing is a short', () => {
    const { s, set } = sim(SRAM_COLUMN);
    set({ pre_n: 0, w0: 1, w1: 0, wl0: 0, wl1: 0 });
    expect(s.shorted.some((x) => x)).toBe(true);
  });
});

describe('1T1C DRAM cell', () => {
  it('stores charge while the word line is low', () => {
    const { set, out } = sim(DRAM_CELL);
    set({ wl: 0, bl: 0 });
    expect(out('q')).toBe(BZ);
    set({ wl: 1, bl: 1 });
    expect(out('q')).toBe(B1);
    set({ wl: 0 });
    set({ bl: 0 });
    expect(out('q')).toBe(B1);
    set({ wl: 1 });
    expect(out('q')).toBe(B0);
  });
});
