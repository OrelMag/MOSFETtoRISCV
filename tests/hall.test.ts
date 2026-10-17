import { describe, expect, it } from 'vitest';
import '../src/lib/index';
import { AISLE, CABINET, cabinetCounts, hallCpu, hallFacts, hallLayout, nandOutputsByBlock, periodIn, withoutProgram } from '../src/lib/hall';
import { flatten } from '../src/sim/flatten';
import { cabinets, price, withoutParts } from '../src/lib/tech';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';

describe('the machine hall', () => {
  for (const id of ['cpu4', 'rv32i'] as const) {
    for (const tech of ['relay', 'tube'] as const) {
      describe(`${id} in ${tech}s`, () => {
        const cpu = hallCpu(id).def;
        const h = hallLayout(cpu, tech);

        it('prices the CPU without its program ROM, as the technology table does', () => {
          const rom = id === 'cpu4' ? 'rom' : 'imem';
          expect(h.program).toBe(rom);
          expect(h.def).toBe(withoutParts(cpu, [rom]));
          expect(h.total).toEqual(price(withoutParts(cpu, [rom]), tech, null));
          expect(stats(h.def).nands).toBe(stats(cpu).nands - stats(netlistOf(cpu)!.instances.find((i) => i.name === rom)!.def).nands);
        });

        it('has every block with devices, each priced alone, the devices between blocks shared out', () => {
          const names = new Set(h.blocks.map((b) => b.name));
          for (const i of netlistOf(h.def)!.instances) expect(names.has(i.name)).toBe((price(i.def, tech, null)?.devices ?? 0) > 0);
          for (const b of h.blocks) expect(b.priced).toEqual(price(b.def, tech, null));
          expect(h.between).toBe(h.total.devices - h.blocks.reduce((s, b) => s + b.priced.devices, 0));
          expect(h.blocks.reduce((s, b) => s + b.devices, 0)).toBe(h.total.devices);
          for (const b of h.blocks) expect(Math.abs(b.devices - b.priced.devices)).toBeLessThanOrEqual(Math.abs(h.between));
        });

        it('fills whole cabinets per block, consistent with cabinets()', () => {
          const per = CABINET[tech].per;
          h.blocks.forEach((b, bi) => {
            expect(b.cabinets).toBe(Math.ceil(b.devices / per));
            const own = h.cabinets.filter((c) => c.block === bi);
            expect(own.length).toBe(b.cabinets);
            expect(own.reduce((s, c) => s + c.devices, 0)).toBe(b.devices);
            for (const c of own) expect(c.devices).toBeGreaterThan(0), expect(c.devices).toBeLessThanOrEqual(per);
          });
          const { used, packed } = cabinetCounts(h);
          expect(packed).toBe(cabinets(h.total));
          expect(used).toBeGreaterThanOrEqual(packed);
          expect(used).toBeLessThan(packed + h.blocks.length);
        });

        it('stands the cabinets in rows with aisles, none overlapping', () => {
          const s = CABINET[tech];
          for (const c of h.cabinets) {
            expect(c.x).toBeGreaterThanOrEqual(0);
            expect(c.x + s.w).toBeLessThanOrEqual(h.width + 1e-9);
            expect(c.z).toBeGreaterThanOrEqual(-h.depth - 1e-9);
            expect(c.z + s.d).toBeLessThanOrEqual(1e-9);
          }
          const rows = new Map<number, number[]>();
          for (const c of h.cabinets) rows.set(c.row, [...(rows.get(c.row) ?? []), c.x]);
          for (const xs of rows.values()) {
            xs.sort((a, b) => a - b);
            for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(s.w - 1e-9);
          }
          for (let r = 1; r < h.rows; r++) {
            const a = h.cabinets.find((c) => c.row === r - 1)!, b = h.cabinets.find((c) => c.row === r)!;
            expect(a.z - (b.z + s.d)).toBeCloseTo(AISLE, 9);
          }
          // the person and the CMOS table stand in the front aisle, clear of the racks
          for (const [x, z] of [h.person, h.speck]) expect(x < 0 || z > 0).toBe(true);
        });
      });
    }
  }

  it('quotes the mockup\'s RV32I counts: 48 434 NANDs, 55 699 relays on 70 racks\' worth', () => {
    const f = hallFacts('rv32i');
    expect(f.nands).toBe(48434);
    expect(f.relay.total.devices).toBe(55699);
    expect(cabinets(f.relay.total)).toBe(70);
    expect(f.steps).toBeGreaterThan(100);
    expect(periodIn(f.steps, 'relay')).toBeCloseTo(f.steps * 8.2e-3, 2);
    expect(f.cmos.area).toBeGreaterThan(0);
  });

  it('gives every block of the hall its NAND outputs to show (the program ROM is a lookup leaf)', () => {
    for (const id of ['cpu4', 'rv32i'] as const) {
      const cpu = hallCpu(id).def, groups = nandOutputsByBlock(flatten(cpu)), h = hallLayout(cpu, 'relay');
      for (const b of h.blocks) expect(groups.get(b.name)?.length).toBe(b.nands);
      expect(groups.has(h.program!)).toBe(false);
    }
  });

  it('leaves a CPU without a program ROM whole', () => {
    const blk = hallLayout(hallCpu('rv32i').def, 'relay').blocks[0].def;
    expect(withoutProgram(blk)).toEqual({ def: blk, program: null });
  });
});
