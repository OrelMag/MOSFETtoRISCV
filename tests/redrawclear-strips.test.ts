import { describe, expect, it } from 'vitest';
import { cordicPipeline } from '../src/lib/cordic';
import { firRing } from '../src/lib/firmac';
import { readShifter } from '../src/lib/macunit';
import { gfMulGates } from '../src/lib/rs';
import { gfInvGates, rsBuffer } from '../src/lib/rsdec';
import { shaK } from '../src/lib/sha256';
import { symbolGeom } from '../src/sim/geometry';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// Levels that were one long row or column (a strip a few pixels high at fit), or ran wires through gates, laid out by depth
// in bands near the canvas's shape (lib/layered.ts aspect): no wire through a part, nothing drawn on anything else, and no
// side more than four times the other.
const levels: [string, () => ComponentDef][] = [
  ['RS byte buffer, 26 bytes (was 432 × 9)', () => rsBuffer(26)],
  ['GF(256) inverter (232 × 8)', () => gfInvGates()],
  ['GF(256) multiplier (17 wires through gates)', () => gfMulGates()],
  ['FIR sample ring (301 × 22)', () => firRing(16, 16)],
  ['MAC read shifter (172 × 31)', () => readShifter()],
  ['CORDIC pipeline (401 × 40)', () => cordicPipeline({ w: 12, z: 12, n: 10 })],
  ['SHA-256 round constants (85 × 1193, 15 wires through gates)', () => shaK()],
];

describe('strips laid out in bands', () => {
  it.each(levels)('%s', (_, make) => {
    const def = make(), nl = netlistOf(def)!, drawn = drawnNetlist(def, nl);
    expect(wiresThroughParts(drawn, routeNetlist(def, drawn).nets).size).toBe(0);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(labelOverlaps(def, nl)).toEqual([]);
    expect(wireOverlaps(routeNetlist(def, nl).nets)).toEqual([]);
    let w = 1, h = 1;
    for (const i of nl.instances) { const g = symbolGeom(i.def); w = Math.max(w, i.at![0] + g.w); h = Math.max(h, i.at![1] + g.h); }
    expect(Math.max(w / h, h / w)).toBeLessThan(4);
  });
});
