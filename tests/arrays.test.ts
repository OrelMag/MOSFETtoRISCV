import { describe, expect, it } from 'vitest';
import { SENSE_AMP, WRITE_DRIVER, sramArray, sramColumn } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BZ } from '../src/sim/types';
import { pack } from '../src/sim/values';

function sim(def: Parameters<typeof flatten>[0]) {
  const s = new SwitchSim(flatten(def, { mode: 'switch' }));
  const set = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) s.setInput(k, x); s.settle(); };
  const bits = (p: string) => s.getBits(s.design.root.ports[p]);
  const shorted = () => s.shorted.some((x) => x);
  return { s, set, bits, val: (p: string) => pack(bits(p)), shorted };
}

describe('write driver and sense amplifier', () => {
  it('the write driver pulls exactly one bit line low, only while enabled', () => {
    const { set, bits } = sim(WRITE_DRIVER);
    set({ we: 0, d: 1 });
    expect([...bits('bl'), ...bits('blb')]).toEqual([BZ, BZ]);
    set({ we: 1, d: 1 });
    expect([...bits('bl'), ...bits('blb')]).toEqual([BZ, B0]);
    set({ d: 0 });
    expect([...bits('bl'), ...bits('blb')]).toEqual([B0, BZ]);
  });
});

describe('SRAM column with I/O', () => {
  it('writes, reads through the sense amplifier, and holds the result during precharge', () => {
    const { set, bits, shorted } = sim(sramColumn(2));
    const idle = { pre_n: 1, wl0: 0, wl1: 0, we: 0, d: 0, sae: 0 };
    set(idle);
    set({ pre_n: 0 }); set({ pre_n: 1 });
    set({ d: 1, we: 1, wl0: 1 }); set({ wl0: 0, we: 0 });          // row 0 ← 1
    set({ pre_n: 0 }); set({ pre_n: 1 });
    set({ d: 0, we: 1, wl1: 1 }); set({ wl1: 0, we: 0 });          // row 1 ← 0
    for (const [row, want] of [[0, B1], [1, B0], [0, B1]] as const) {
      set({ pre_n: 0 }); set({ pre_n: 1 });
      set({ [`wl${row}`]: 1 });
      set({ sae: 1 });
      expect(bits('q')[0], `row ${row}`).toBe(want);
      set({ [`wl${row}`]: 0 });
      set({ pre_n: 0 });                                              // precharge while the latch holds
      expect(bits('q')[0], `row ${row} held`).toBe(want);
      set({ pre_n: 1, sae: 0 });
      expect(shorted()).toBe(false);
    }
  });
});

describe('SRAM array', () => {
  const R = 4, C = 4;
  const run = () => {
    const h = sim(sramArray(R, C));
    h.set({ addr: 0, wl: 0, pre_n: 1, we: 0, din: 0, sae: 0 });
    const precharge = () => { h.set({ pre_n: 0 }); h.set({ pre_n: 1 }); };
    const write = (addr: number, v: number) => { precharge(); h.set({ addr, din: v, we: 1 }); h.set({ wl: 1 }); h.set({ wl: 0, we: 0 }); };
    const read = (addr: number) => { precharge(); h.set({ addr }); h.set({ wl: 1 }); h.set({ sae: 1 }); const v = h.val('dout'); h.set({ wl: 0 }); h.set({ sae: 0 }); return v; };
    return { ...h, write, read };
  };
  it('stores and reads back every word', () => {
    const m = run();
    const words = [0xa, 0x5, 0xf, 0x0];
    words.forEach((v, a) => m.write(a, v));
    words.forEach((v, a) => expect(m.read(a), `word ${a}`).toBe(v));
    expect(m.shorted()).toBe(false);
  });
  it('reads do not disturb, and rewrites take effect', () => {
    const m = run();
    for (let a = 0; a < R; a++) m.write(a, a * 3 + 1);
    for (let rep = 0; rep < 3; rep++) for (let a = 0; a < R; a++) expect(m.read(a)).toBe(a * 3 + 1);
    m.write(2, 0xc);
    expect([m.read(1), m.read(2), m.read(3)]).toEqual([4, 0xc, 10]);
  });
  it('the sense amplifier output is defined before any write (it follows the precharged lines)', () => {
    const m = run();
    m.set({ pre_n: 0 });
    m.set({ pre_n: 1 });
    expect(m.val('dout')).toBe(0);
  });
});

void SENSE_AMP;
