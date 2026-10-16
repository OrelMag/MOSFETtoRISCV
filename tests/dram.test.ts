import { describe, expect, it } from 'vitest';
import { CELL_C, CELL_HALFLIFE } from '../src/lib/dram';
import { BITLINE_C, dramArray, DRAM_SA, VHALF } from '../src/lib/dram';
import { NMOS } from '../src/lib/transistors';
import { flatten } from '../src/sim/flatten';
import { SENSE_OFFSET, SwitchSim } from '../src/sim/switchsim';
import { accessCycles, bankRow, PS_PER_NAND, RowBuffers, SC_PERIOD_NANDS, TIMING } from '../src/dram/timing';
import { requestStream } from '../src/widgets/dramtiming';
import { B0, B1, BX, type ComponentDef } from '../src/sim/types';

/** A cell, a switch and a bit line precharged from a VDD/2 rail: charge sharing by hand. */
const SHARE: ComponentDef = {
  id: 't_share', name: 'share', category: 'memory',
  ports: [{ name: 'pre', width: 1, dir: 'in' }, { name: 'wl', width: 1, dir: 'in' }, { name: 'w', width: 1, dir: 'in' }, { name: 'd', width: 1, dir: 'in' }],
  symbol: { kind: 'box' },
  netlist: () => ({
    level: 'switch',
    instances: [
      { name: 'vh', def: VHALF, at: [0, 0] }, { name: 'p', def: NMOS, at: [0, 0] },
      { name: 'a', def: NMOS, at: [0, 0] }, { name: 'wr', def: NMOS, at: [0, 0] },
    ],
    nets: [
      { ends: ['vh.p', 'p.d'] }, { ends: ['pre', 'p.g'] }, { ends: ['wl', 'a.g'] }, { ends: ['w', 'wr.g'] }, { ends: ['d', 'wr.d'] },
      { name: 'cell', cap: 25, ends: ['a.s', 'wr.s'] },
      { name: 'bl', cap: 100, ends: ['p.s', 'a.d'] },
    ],
  }),
};

const net = (sim: SwitchSim, name: string) => sim.design.root.nets![sim.design.root.def.netlist!().nets.findIndex((n) => n.name === name)][0];

describe('charge levels (SwitchSim)', () => {
  it('shares charge as Σ C·V / Σ C and reads a mid level as X', () => {
    const sim = new SwitchSim(flatten(SHARE, { mode: 'switch' }));
    const cell = net(sim, 'cell'), bl = net(sim, 'bl');
    // write a 1 into the cell, precharge the bit line to VDD/2
    sim.setInput('d', 1); sim.setInput('w', 1); sim.setInput('pre', 1); sim.settle();
    expect(sim.level(cell)).toBe(1);
    expect(sim.level(bl)).toBe(0.5);
    expect(sim.get(bl)).toBe(BX);
    sim.setInput('w', 0); sim.setInput('pre', 0); sim.settle();
    // floating: both keep their charge
    expect(sim.level(cell)).toBe(1);
    expect(sim.level(bl)).toBe(0.5);
    // the word line joins them: (25·1 + 100·½) / 125 = 0.6
    sim.setInput('wl', 1); sim.settle();
    expect(sim.level(bl)).toBeCloseTo(0.6, 12);
    expect(sim.level(cell)).toBeCloseTo(0.6, 12);
    expect(sim.get(bl)).toBe(BX);
    // charge is conserved: settling again changes nothing
    sim.setInput('pre', 0); sim.settle();
    expect(sim.level(bl)).toBeCloseTo(0.6, 12);
  });

  it('a stored 0 pulls the bit line to 0.4, and a cap marked leak loses charge per cycle', () => {
    const sim = new SwitchSim(flatten(SHARE, { mode: 'switch' }));
    const bl = net(sim, 'bl');
    sim.setInput('d', 0); sim.setInput('w', 1); sim.setInput('pre', 1); sim.settle();
    sim.setInput('w', 0); sim.setInput('pre', 0); sim.setInput('wl', 1); sim.settle();
    expect(sim.level(bl)).toBeCloseTo(0.4, 12);
  });
});

/** Drive an array through the protocol of dramArray's comment. */
function harness(R = 4, C = 4) {
  const sim = new SwitchSim(flatten(dramArray(R, C), { mode: 'switch' }));
  const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) sim.setInput(k, v); sim.settle(); };
  const precharge = () => { set({ act: 0, sae: 0, cs: 0, we: 0 }); set({ pre: 1 }); set({ pre: 0 }); };
  const open = (row: number) => { precharge(); set({ row, act: 1 }); set({ sae: 1 }); };
  const read = (col: number) => { set({ col, cs: 1 }); const b = sim.get(sim.design.root.ports.dout[0]); set({ cs: 0 }); return b; };
  const write = (col: number, d: number) => { set({ col, din: d, cs: 1, we: 1 }); set({ we: 0, cs: 0 }); };
  const close = () => set({ act: 0, sae: 0 });
  const bitline = (c: number) => sim.design.root.children!.get(`col${c}`)!.nets![sim.design.root.children!.get(`col${c}`)!.def.netlist!().nets.findIndex((n) => n.name === 'bl')][0];
  const cell = (r: number, c: number) => sim.design.root.children!.get(`col${c}`)!.children!.get(`c${r}`)!.nets![2][0];
  return { sim, set, precharge, open, read, write, close, bitline, cell };
}

describe('DRAM array (switch level)', () => {
  it('writes, then reads back through charge sharing and the sense amplifier', () => {
    const h = harness();
    const words = [0b1010, 0b0110, 0b1111, 0b0001];
    for (let r = 0; r < 4; r++) {
      h.open(r);
      for (let c = 0; c < 4; c++) h.write(c, (words[r] >> c) & 1);
      h.close();
    }
    for (let r = 0; r < 4; r++) {
      h.open(r);
      for (let c = 0; c < 4; c++) expect(h.read(c), `row ${r} col ${c}`).toBe((words[r] >> c) & 1 ? B1 : B0);
      h.close();
    }
  });

  it('moves the bit line by ΔV = ±½ · Cs / (Cs + Cb) before sensing, and restores the cell after', () => {
    const h = harness();
    h.open(1); h.write(2, 1); h.write(3, 0); h.close();
    h.precharge();
    h.set({ row: 1, act: 1 });
    const dv = 0.5 * CELL_C / (CELL_C + BITLINE_C);
    expect(h.sim.level(h.bitline(2))).toBeCloseTo(0.5 + dv, 12);
    expect(h.sim.level(h.bitline(3))).toBeCloseTo(0.5 - dv, 12);
    // the read destroyed the charge: the cell sits at the shared level
    expect(h.sim.level(h.cell(1, 2))).toBeCloseTo(0.5 + dv, 12);
    h.set({ sae: 1 });
    expect(h.sim.level(h.bitline(2))).toBe(1);
    expect(h.sim.level(h.cell(1, 2))).toBe(1); // written back
    expect(h.sim.level(h.cell(1, 3))).toBe(0);
  });

  it('loses a 1 to leakage unless the row is refreshed in time', () => {
    // a 1 is read correctly while (V − ½) · Cs / (Cs + Cb) ≥ offset
    const vmin = 0.5 + SENSE_OFFSET * (CELL_C + BITLINE_C) / CELL_C;
    const safe = Math.floor(CELL_HALFLIFE * Math.log2(1 / vmin));
    const run = (age: number, refreshEvery = 0) => {
      const h = harness();
      h.open(0); h.write(1, 1); h.close(); h.precharge();
      let left = age;
      while (left > 0) {
        const step = refreshEvery ? Math.min(refreshEvery, left) : left;
        h.sim.leak(step);
        left -= step;
        if (refreshEvery) { h.open(0); h.close(); h.precharge(); }
      }
      h.open(0);
      return h.read(1);
    };
    expect(run(safe)).toBe(B1);
    expect(run(safe + 3)).toBe(BX); // a difference below the amplifier's offset
    expect(run(2 * CELL_HALFLIFE)).toBe(B0); // well below VDD/2: the 1 is read, and restored, as a 0
    expect(run(4 * CELL_HALFLIFE, safe)).toBe(B1); // refreshed often enough, it survives any time
  });

  it('keeps a 0 forever (the cell leaks towards 0) and an open row in the amplifiers', () => {
    const h = harness();
    h.open(2); h.write(0, 0); h.write(1, 1); h.close(); h.precharge();
    h.sim.leak(10 * CELL_HALFLIFE);
    h.open(2);
    expect(h.read(0)).toBe(B0);
    expect(h.read(1)).toBe(B0); // long gone
    // the row buffer holds while the row stays open, leakage or not
    h.write(1, 1);
    h.sim.leak(10 * CELL_HALFLIFE);
    expect(h.read(1)).toBe(B1);
  });

  it('has a 15 mV offset at 1.1 V', () => {
    expect(DRAM_SA.offset).toBeCloseTo(0.015 / 1.1, 12);
  });
});

describe('DRAM timing and the row buffer (dram/timing.ts)', () => {
  it('converts DDR4-3200 at the single-cycle CPU\'s period from the benchmark results', async () => {
    const results = (await import('../src/bench/results.json')).default as { psPerNand: number; cpus: { id: string; period: number }[] };
    expect(PS_PER_NAND).toBe(results.psPerNand);
    expect(SC_PERIOD_NANDS).toBe(results.cpus.find((c) => c.id === 'sc')!.period);
    expect(TIMING).toEqual({ tRCD: 4, tCAS: 4, tRP: 4, tRAS: 9, burst: 4, tREFI: 1974, tRFC: 89 });
    // a row hit costs what today's caches charge for every miss
    expect(accessCycles('hit', TIMING)).toBe(8);
    expect([accessCycles('miss', TIMING), accessCycles('conflict', TIMING), accessCycles('closed', TIMING)]).toEqual([12, 16, 12]);
  });

  it('prices the copy\'s two streams: conflicts on the plain mapping, hits with the XOR hash', () => {
    const run = (hash: boolean, policy: 'open' | 'closed' = 'open') => {
      const rb = new RowBuffers({ banks: 2, rowWords: 16, hash }, policy);
      for (const w of requestStream('copy', 2)) rb.access(w);
      return rb;
    };
    const plain = run(false), xor = run(true), closed = run(false, 'closed');
    expect(plain.conflicts).toBeGreaterThan(plain.hits); // the streams evict each other's rows
    expect(xor.conflicts).toBeLessThan(plain.conflicts / 2);
    expect(xor.hits).toBeGreaterThan(plain.hits);
    expect(xor.cycles).toBeLessThan(closed.cycles);
    expect(closed.cycles).toBeLessThan(plain.cycles);
    expect(bankRow({ banks: 2, rowWords: 16 }, 1024).bank).toBe(bankRow({ banks: 2, rowWords: 16 }, 0).bank);
    expect(bankRow({ banks: 2, rowWords: 16, hash: true }, 1024).bank).not.toBe(bankRow({ banks: 2, rowWords: 16, hash: true }, 0).bank);
  });

  it('a read without its restore: the second still senses, the third cannot', () => {
    const share = (v: number) => (CELL_C * v + BITLINE_C * 0.5) / (CELL_C + BITLINE_C);
    expect(share(share(1)) - 0.5).toBeGreaterThan(SENSE_OFFSET);
    expect(share(share(share(1))) - 0.5).toBeLessThan(SENSE_OFFSET);
  });
});
