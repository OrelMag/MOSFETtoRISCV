import { describe, expect, it } from 'vitest';
import { nandBlock, norArray } from '../src/lib/flash';
import { flatten } from '../src/sim/flatten';
import { FG_READ, FG_STEP, SwitchSim } from '../src/sim/switchsim';
import { B0, B1 } from '../src/sim/types';

/** Drive a NOR array or NAND block: read a row, program a row (pulses), erase. */
function harness(def: ReturnType<typeof norArray>) {
  const sim = new SwitchSim(flatten(def, { mode: 'switch' }));
  const C = def.ports.filter((p) => p.name.startsWith('dout')).length;
  const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) sim.setInput(k, v); sim.settle(); };
  const read = (row: number): number => {
    set({ pgm: 0, ers: 0, row, rd: 1 });
    let v = 0;
    for (let c = 0; c < C; c++) {
      const b = sim.get(sim.design.root.ports[`dout${c}`][0]);
      if (b !== B0 && b !== B1) return -1;
      v |= b << c;
    }
    set({ rd: 0 });
    return v;
  };
  /** One program pulse on a row: the 0 bits of `data` are programmed one step. */
  const pulse = (row: number, data: number) => {
    const din: Record<string, number> = {};
    for (let c = 0; c < C; c++) din[`din${c}`] = (data >> c) & 1;
    set({ rd: 0, ers: 0, row, ...din });
    set({ pgm: 1 });
    set({ pgm: 0 });
  };
  /** Program and verify: pulse until the row reads back (at most 8 pulses); returns the pulses used. */
  const program = (row: number, data: number) => {
    for (let n = 1; n <= 8; n++) {
      pulse(row, data);
      if ((read(row) & ~data & ((1 << C) - 1)) === 0) return n;
    }
    return -1;
  };
  const erase = () => { set({ rd: 0, pgm: 0, ers: 1 }); set({ ers: 0 }); };
  return { sim, read, pulse, program, erase };
}

describe.each([['NOR 4 × 4', norArray(4, 4), 4], ['NAND 4 strings × 8', nandBlock(4, 8), 8]] as const)('%s flash', (_, def, rows) => {
  it('reads all 1s after erase, programs 0s pulse by pulse, keeps other rows', () => {
    const h = harness(def);
    h.erase();
    for (let r = 0; r < rows; r++) expect(h.read(r), `row ${r} erased`).toBe(0b1111);
    expect(h.program(1, 0b1010)).toBe(Math.ceil(FG_READ / FG_STEP));
    expect(h.read(1)).toBe(0b1010);
    for (let r = 0; r < rows; r++) if (r !== 1) expect(h.read(r), `row ${r} untouched`).toBe(0b1111);
    h.program(rows - 1, 0b0110);
    expect(h.read(rows - 1)).toBe(0b0110);
    expect(h.read(1)).toBe(0b1010);
  });

  it('cannot turn a 0 back into a 1 without erasing the whole block', () => {
    const h = harness(def);
    h.erase();
    h.program(0, 0b1010);
    h.program(2, 0b0011);
    h.program(0, 0b0110); // programming only adds 0s: 1010 & 0110
    expect(h.read(0)).toBe(0b0010);
    h.erase();
    expect(h.read(0)).toBe(0b1111);
    expect(h.read(2)).toBe(0b1111);
  });

  it('one pulse is not enough: verify reads the cell still erased', () => {
    const h = harness(def);
    h.erase();
    h.pulse(1, 0b0000);
    expect(h.read(1)).toBe(FG_STEP >= FG_READ ? 0 : 0b1111);
  });
});
