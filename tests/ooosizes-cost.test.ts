// src/bench/ooosizes.json (scripts/ooo-sizes.ts: the out-of-order core's NANDs and period by window size) against
// the generators and against results.json, so the lab's prices cannot drift from the gates.

import { describe, expect, it } from 'vitest';
import sizes from '../src/bench/ooosizes.json';
import results from '../src/bench/results.json';
import { OOO_SIZES, type OooSizes } from '../src/lib/ooo';
import { oooCpu } from '../src/lib/ooocore';
import { stats } from '../src/sim/stats';
import { BENCH_DMEM_K, BENCH_IMEM_K } from './verify/bench';
import { IQ_SIZES, measureSize, ROB_SIZES, SIZED_UNITS, sizeProgram, SQ_SIZES } from './verify/ooosizes';
import { tick } from './yieldtick';

const same = (a: OooSizes, b: OooSizes) => a.rob === b.rob && a.iq === b.iq && a.sq === b.sq;
const at = (z: OooSizes) => sizes.points.find((p) => same(p, z))!;

describe('the out-of-order core by window size (ooosizes.json)', () => {
  it('covers the grid, and its default point is results.json\'s ooo', () => {
    expect(sizes.default).toEqual(OOO_SIZES);
    expect([sizes.rob, sizes.iq, sizes.sq]).toEqual([ROB_SIZES, IQ_SIZES, SQ_SIZES]);
    expect(sizes.points.map(({ rob, iq, sq }) => `${rob}/${iq}/${sq}`)).toEqual(ROB_SIZES.flatMap((r) => IQ_SIZES.flatMap((q) => SQ_SIZES.map((s) => `${r}/${q}/${s}`))));
    const ooo = results.cpus.find((c) => c.id === 'ooo')!, d = at(OOO_SIZES);
    expect({ nands: d.nands, period: d.period }).toEqual({ nands: ooo.nands, period: ooo.period });
    expect(sizes.psPerNand).toBe(results.psPerNand);
  });

  it('every point\'s NANDs and units are what the generators build', async () => {
    const words = sizeProgram(), build = (z: OooSizes) => oooCpu(words, { imemK: BENCH_IMEM_K, dmemK: BENCH_DMEM_K, ...z });
    const rom = stats(build(OOO_SIZES)).nands - at(OOO_SIZES).nands; // the program ROM, the same in every build
    for (const p of sizes.points) {
      const def = build(p), kids = def.netlist!().instances;
      expect({ nands: stats(def).nands - rom, units: Object.fromEntries(SIZED_UNITS.map((n) => [n, stats(kids.find((i) => i.name === n)!.def).nands])) }, `${p.rob}/${p.iq}/${p.sq}`)
        .toEqual({ nands: p.nands, units: p.units });
      await tick();
    }
  }, 300_000);

  it('the cheapest point measured again: NANDs, both periods and the critical path', () => {
    const z = { rob: ROB_SIZES[0], iq: IQ_SIZES[0], sq: SQ_SIZES[0] };
    expect(measureSize(z)).toEqual(at(z));
  }, 300_000);
});
