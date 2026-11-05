// The lane core's drawing with wires (lib/lanewires.ts): the decoder's signals reach every lane as wires, nothing
// overlaps; what stays a pointer is the clock, the write enables, the mask and the served lane, and the long control nets.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { laneCore } from '../src/lib/lanes';
import { assemble } from '../src/riscv/asm';
import { SIMT_PROGRAMS } from '../src/riscv/simtprograms';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

describe('lane core schematic', () => {
  const words = assemble(SIMT_PROGRAMS[0].source).words;
  const d = laneCore(words, 4), nl = netlistOf(d)!;
  const routed = routeNetlist(d, nl);

  it('has no wires on one line, no label or symbol overlaps', () => {
    expect(wireOverlaps(routed.nets)).toEqual([]);
    expect(labelOverlaps(d, nl)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(backwardEnds(d, nl)).toEqual([]);
  });

  it('draws the decoder fanning out to every lane as wires', () => {
    for (const sig of ['aluSrcA', 'aluSrcB', 'aluCtl', 'resultSrc', 'isCsr', 'csrSel', 'csrS', 'rs1', 'rs2', 'rd', 'PC', 'ImmExt', 'PCPlus4', 'ReadData']) {
      const i = nl.nets.findIndex((n) => n.name === sig);
      expect(i, sig).toBeGreaterThanOrEqual(0);
      expect(routed.nets[i].paths.length, sig).toBeGreaterThanOrEqual(4);
      expect(routed.nets[i].tags.filter((t) => /^lane\d+\./.test(t.end)), sig).toEqual([]);
    }
  });

  it('keeps pointers to about a quarter of what it was (234 labels)', () => {
    expect(routed.nets.reduce((a, n) => a + n.tags.length, 0)).toBeLessThanOrEqual(70);
  });
});
