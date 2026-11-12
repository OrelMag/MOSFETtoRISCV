import { describe, expect, it } from 'vitest';
import { CRC32_REFLECTED } from '../src/comm/crc';
import { DLLP_POLY } from '../src/comm/pcie';
import { CRC5_POLY, CRC16_POLY } from '../src/comm/usb';
import { crcNext, crcUnit } from '../src/lib/crc';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// Every CRC generator the book shows (chapter 63, Ethernet, PCIe, USB) and its next-state block: no wire runs through a part.
// A single-sink net that jumps a column of XORs used to be a plain wire drawn level with its ends, straight through them.
const through = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  return [...wiresThroughParts(nl, routeNetlist(def, nl).nets)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0]);
};
const shapes: [string, number, number, number, boolean][] = [
  ['CRC-32, 8 bits a step', 32, CRC32_REFLECTED, 8, true],
  ['CRC-32, 8 bits a step, separate terms', 32, CRC32_REFLECTED, 8, false],
  ['CRC-32, 1 bit a step', 32, CRC32_REFLECTED, 1, true],
  ['PCIe DLLP CRC-16, 8 bits', 16, DLLP_POLY, 8, true],
  ['USB CRC-16, 1 bit', 16, CRC16_POLY, 1, true],
  ['USB CRC-5, 1 bit', 5, CRC5_POLY, 1, true],
];

describe('CRC blocks', () => {
  it.each(shapes)('%s: next state and generator, no wire through a part, nothing drawn on anything else', (_, n, poly, w, share) => {
    for (const def of [crcNext(n, poly, w, share), crcUnit(n, poly, w, share)]) {
      expect(through(def), def.id).toEqual([]);
      const nl = netlistOf(def)!;
      expect(symbolOverlaps(nl), def.id).toEqual([]);
      expect(labelOverlaps(def, nl), def.id).toEqual([]);
      expect(wireOverlaps(routeNetlist(def, nl).nets), def.id).toEqual([]);
    }
  });
});
