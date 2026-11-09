// The FPGA chapter's side level in act 3: a look-up table from 2:1 multiplexers (m_lut). Its reference answer is the
// library's LUT4 (lib/fpga.ts) drawn as a chip, with its 16:1 multiplexer as a chip of its own, so it is built and
// checked under the level's rule (the library's ready multiplexer trees are withheld). No DOM.

import type { BuildChallenge, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { muxTree } from '../lib/combinational';
import { LUT4 } from '../lib/fpga';

const pins = (ins: [string, number?][], outs: [string, number?][]): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

/** The library parts the level takes away: every ready multiplexer tree and LUT (a 2:1 mux and the bus muxes stay). */
export const LUT_WITHHOLD = ['mux4x1', 'mux8x1', 'mux16x1', 'mux32x1', 'lut2', 'lut4'];

let answer: ChipDoc[] | undefined;
function reference(): ChipDoc[] {
  if (answer) return answer;
  const tree = muxTree(4, 1), sub = { id: 'u_ref_cp_m_lut_0', name: '16:1 mux ref' };
  const refOf = (d: unknown): PartRef | undefined => (d === tree ? { chip: sub.id } : undefined);
  const inner = docFromDef(tree, { ...sub, refOf });
  if ('error' in inner) throw new Error(`reference m_lut (mux): ${inner.error}`);
  const top = docFromDef(LUT4, { id: 'u_ref_cp_m_lut', name: 'Look-up table ref', refOf });
  if ('error' in top) throw new Error(`reference m_lut: ${top.error}`);
  return (answer = [{ ...inner, notes: 'Part of the reference answer: fifteen 2:1 multiplexers in four levels.' }, { ...top, notes: `Reference answer. ${LUT4.summary ?? ''}`.trim() }]);
}

/** Every address against every single configuration bit (256 rows), then the sampled rest. */
function oneHot(): number[][] {
  const v: number[][] = [];
  for (let b = 0; b < 16; b++) for (let i = 0; i < 16; i++) v.push([1 << b, i], [0xffff ^ (1 << b), i]);
  return v;
}

export const BUILD_LUT: Record<string, () => BuildChallenge> = {
  m_lut: () => ({
    id: 'm_lut', title: 'A look-up table', level: 'memory', allowed: 'nand',
    brief: '<b>y = cfg[i]</b>: the 4-bit input <code>i</code> picks one of the 16 configuration bits <code>cfg</code>. Set cfg to a function\'s truth table (bit k = the output for i = k) and the circuit computes it: 0x8000 is the AND of the four bits of i, 0x6666 the XOR of the low two. This is an FPGA\'s logic cell. Build it from 2:1 multiplexers; the library\'s ready multiplexer trees are taken away.',
    ports: pins([['cfg', 16], ['i', 4]], [['y']]),
    check: { kind: 'table', spec: ([cfg, i]) => [(cfg >> i) & 1], vectors: oneHot },
    answer: reference,
  }),
};
