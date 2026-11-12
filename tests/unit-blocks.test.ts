// Control units re-drawn as blocks a reader opens one at a time (the triangle and depth set-up, the vector decoder and
// sequencer): the same gates as their flat drawings had. NANDs, the clock period (or, for the combinational decoder, the
// input-to-output depth) and the flattened leaves are the flat versions' numbers; a change here is a change of hardware.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { RAST_SETUP, Z_SETUP } from '../src/lib/raster';
import { VEC_DECODE, VEC_SEQ } from '../src/lib/vector';
import { stats } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';
import { flatten } from '../src/sim/flatten';
import type { ComponentDef } from '../src/sim/types';

const UNITS: [string, ComponentDef, number, number | null, number, number, string[]][] = [
  // name, def, NANDs, period, input-to-output depth, leaves, top-level blocks
  ['triangle set-up', RAST_SETUP, 6389, 147, 147, 6441, ['box', 'edges', 'products', 'steps']],
  ['depth set-up', Z_SETUP, 12032, 135, 135, 12075, ['acc', 'diff', 'div', 'mul', 'seq']],
  ['vector decoder', VEC_DECODE, 2174, null, 33, 2199, ['fld', 'form', 'legal']],
  ['beat sequencer', VEC_SEQ, 831, 35, 40, 846, ['count', 'lanes', 'regs']],
];

describe('control units drawn as blocks', () => {
  it.each(UNITS)('%s: the flat drawing\'s gates', (_, def, nands, period, depth, leaves, blocks) => {
    const f = flatten(def);
    expect(stats(def).nands).toBe(nands);
    expect(analyzeTiming(f)?.period ?? null).toBe(period);
    expect(analyzeTiming(f, { outputs: true })?.period ?? null).toBe(depth);
    expect(f.leaves.length).toBe(leaves);
    expect(def.netlist!().instances.map((i) => i.name).filter((n) => blocks.includes(n)).sort()).toEqual(blocks);
  });
});
