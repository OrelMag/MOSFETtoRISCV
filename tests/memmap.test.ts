import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BusModel, MAP } from '../src/bus/model';
import { addExample, EXAMPLES } from '../src/editor/examples';
import { UserLibrary } from '../src/editor/library';
import { analyze, applyMap, busMapOf, cHeader, decoderDef, equation, hasBus, linkerScript, moveTo, names, newRegion, readMap, sameMap, withoutRegion, type MemMap } from '../src/editor/memmap';
import { emptyWorkspace, type ChipDoc } from '../src/editor/model';
import { regenerable } from '../src/lib/resolve';
import { axiDecoder } from '../src/lib/axi';
import { memmapDecoder } from '../src/lib/memmapdec';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';

// The memory-map designer's model on Examples ▸ System on a bus: read the map from the chip, edit it, write it
// back, and the chip still compiles, reads back the new map, and the decoder chip agrees with the bus.

const EX = EXAMPLES.find((e) => e.id === 'bussystem')!;
type Ws = ReturnType<typeof emptyWorkspace>;
const chip = (): { doc: ChipDoc; ws: Ws; id: string } => {
  const { ws, id } = addExample(emptyWorkspace(), EX);
  return { ws, id, doc: ws.chips[id] };
};
const ok = (m: ReturnType<typeof readMap>): MemMap => { if ('error' in m) throw new Error(m.error); return m; };
/** Compile `doc` in the workspace: no error diagnostics. */
function compiles(ws: Ws, doc: ChipDoc) {
  const lib = new UserLibrary({ ...ws, chips: { ...ws.chips, [doc.id]: doc } });
  const c = lib.compiled(doc.id)!;
  expect(c.diags.filter((d) => d.level === 'error').map((d) => d.msg)).toEqual([]);
  return c;
}

describe('reading the example', () => {
  it('finds the bus and its seven slaves by their pointers', () => {
    const { doc } = chip();
    expect(hasBus(doc)).toBe(true);
    const m = ok(readMap(doc));
    expect(m.regions.map((r) => [r.kind, r.base / 2 ** 28])).toEqual([['ram', 0], ['flash', 1], ['dram', 2], ['dma', 4], ['screen', 5], ['io', 6]]);
    expect(m.fallback.id).toBe('none');
    expect(m.regions[0].used).toBe(16384);
    expect(m.regions[4].detail).toBe('64 × 64');
    expect(busMapOf(m)).toEqual({ ram: 0, flash: 1, dram: 2, dma: 4, screen: 5, keys: 6 });
    expect(names(m)).toEqual(['RAM', 'Flash', 'DRAM', 'DMA registers', 'Screen', 'Keys + timer']);
  });

  it('has no problems, and the gaps go to the default slave', () => {
    const a = analyze(ok(readMap(chip().doc)));
    expect(a.problems).toEqual([]);
    expect(a.free).toEqual([3, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('refuses a chip without a bus', () => {
    expect('error' in readMap({ ...chip().doc, parts: [] })).toBe(true);
  });
});

describe('problems', () => {
  const base = () => ok(readMap(chip().doc));
  it('an overlap names both regions and a free window', () => {
    const a = analyze(moveTo(base(), 5, 4));
    expect(a.problems).toHaveLength(1);
    expect(a.problems[0].kind).toBe('overlap');
    expect(a.problems[0].text).toMatch(/DMA registers and Keys \+ timer both sit at 0x4000_0000/);
    expect(a.problems[0].text).toMatch(/free window 0x3000_0000/);
  });
  it('a base off the window grid, and out of range', () => {
    const m = base();
    expect(analyze({ ...m, regions: m.regions.map((r, i) => (i === 4 ? { ...r, base: 0x50001000 } : r)) }).problems[0]).toMatchObject({ kind: 'misaligned' });
    expect(analyze({ ...m, regions: m.regions.map((r, i) => (i === 4 ? { ...r, base: 2 ** 32 } : r)) }).problems[0]).toMatchObject({ kind: 'range' });
  });
  it('no region at all', () => {
    expect(analyze({ ...base(), regions: [] }).problems[0].kind).toBe('count');
  });
  it('apply refuses a map with problems', () => {
    expect(() => applyMap(chip().doc, moveTo(base(), 5, 4))).toThrow(/both sit/);
  });
});

describe('applying a map', () => {
  it('the same map changes nothing that matters: it compiles, and reads back the same', () => {
    const { ws, doc } = chip();
    const m = ok(readMap(doc));
    const out = applyMap(doc, m);
    expect(sameMap(ok(readMap(out)), m)).toBe(true);
    compiles(ws, out);
    expect(out.labels.filter((l) => l.name === 'pixel_req')).toHaveLength(2);
  });

  it('moves the screen to window 7: the bus gets new codes, links follow their slaves', () => {
    const { ws, doc } = chip();
    const out = applyMap(doc, moveTo(ok(readMap(doc)), 4, 7));
    const back = ok(readMap(out));
    expect(back.regions.map((r) => [r.id, r.base / 2 ** 28])).toEqual([['ram', 0], ['flash', 1], ['dram', 2], ['dma', 4], ['io', 6], ['pixel', 7]]);
    expect(out.parts.find((p) => p.id === 'bus')!.ref).toEqual({ lib: 'axibus2_0_1_2_4_6_7_15_b' });
    compiles(ws, out);
  });

  it('adds a RAM in a free window, with its clock', () => {
    const { ws, doc } = chip();
    const m0 = ok(readMap(doc));
    const added = newRegion(m0, 'ram', 3, doc.parts.map((p) => p.id));
    const out = applyMap(doc, { ...m0, regions: [...m0.regions, added] });
    expect(ok(readMap(out)).regions.map((r) => r.kind)).toEqual(['ram', 'flash', 'dram', 'ram', 'dma', 'screen', 'io']);
    expect(out.parts.some((p) => p.id === added.id)).toBe(true);
    compiles(ws, out);
  });

  it('removes a screen and a keys + timer port, then adds them back with their devices', () => {
    const { ws, doc } = chip();
    const m = withoutRegion(withoutRegion(ok(readMap(doc)), 5), 4);
    const out1 = applyMap(doc, m);
    compiles(ws, out1);
    const m1 = ok(readMap(out1));
    expect(m1.regions.map((r) => r.kind)).toEqual(['ram', 'flash', 'dram', 'dma']);
    const ids = () => out1.parts.map((p) => p.id);
    const m2 = { ...m1, regions: [...m1.regions, newRegion(m1, 'screen', 5, ids()), newRegion(m1, 'io', 6, [...ids(), 'screen']), newRegion(m1, 'flash', 9, [...ids(), 'screen', 'io'])] };
    const out2 = applyMap(out1, m2);
    const back = ok(readMap(out2));
    expect(back.regions.map((r) => [r.kind, r.base / 2 ** 28])).toEqual([['ram', 0], ['flash', 1], ['dram', 2], ['dma', 4], ['screen', 5], ['io', 6], ['flash', 9]]);
    compiles(ws, out2);
  });

  it('removes a region: its slave part goes, the bus shrinks', () => {
    const { ws, doc } = chip();
    const out = applyMap(doc, withoutRegion(ok(readMap(doc)), 2));
    expect(out.parts.some((p) => p.id === 'dram')).toBe(false);
    expect(ok(readMap(out)).regions.map((r) => r.kind)).toEqual(['ram', 'flash', 'dma', 'screen', 'io']);
    compiles(ws, out);
  });

  it('the new bus part is found again from its id alone (a saved chip after a reload)', () => {
    expect(regenerable('axibus2_0_1_9_15_b')).toBe(true);
    expect(regenerable('axibus2_0_1_9_15')).toBe(false);
  });
});

describe('the decoder', () => {
  const m = () => ok(readMap(chip().doc));
  it('selects what the bus selects, for every window', () => {
    const map = m();
    const sim = simulate(decoderDef(map));
    const order = [...map.regions].sort((a, b) => a.base - b.base);
    for (let n = 0; n < 16; n++) {
      const want = order.map((r) => (r.base / 2 ** 28 === n ? 1 : 0));
      want.push(want.some(Boolean) ? 0 : 1);
      expect(evalOnce(sim, [((n << 28) | 0x123456) >>> 0]), `window ${n}`).toEqual(want);
    }
  });

  it('is the logic the bus decoder contains, and costs less (no address mux, no held register)', () => {
    const codes = [0, 1, 2, 4, 5, 6, 15];
    const chipNands = stats(memmapDecoder(codes.slice(0, -1).map((c) => ({ name: `r${c}`, code: c })))).nands;
    expect(chipNands).toBeGreaterThan(0);
    expect(chipNands).toBeLessThan(stats(axiDecoder(codes)).nands);
    expect(chipNands).toBe(stats(decoderDef(m())).nands);
  });

  it('writes the equation of a window', () => {
    expect(equation(5)).toBe('a31′ · a30 · a29′ · a28');
  });
});

describe('the golden model follows the map', () => {
  it('BusModel takes the nibbles of an applied map', () => {
    const map = moveTo(ok(readMap(chip().doc)), 4, 7);
    const bus = new BusModel(10, [], 4096, { dramK: 12, screen: 64, keys: true, map: busMapOf(map) });
    expect(bus.map).toEqual({ ...MAP, screen: 7 });
    bus.write(0x70000000, 0xaa, 15);
    expect(bus.screen![0]).toBe(0xaa);
    bus.write(0x50000000, 0xbb, 15);
    expect(bus.screen![0]).toBe(0xaa);
    expect(bus.read(0x50000000)).toBe(0);
    expect(bus.read(0x70000000)).toBe(0xaa);
  });
});

describe('exports', () => {
  it('a C header and a linker MEMORY block', () => {
    const m = ok(readMap(chip().doc));
    const h = cHeader(m, 'System on a bus');
    expect(h).toMatch(/#define RAM_BASE\s+0x00000000u/);
    expect(h).toMatch(/#define SCREEN_BASE\s+0x50000000u/);
    expect(h).toMatch(/#define SCREEN_SIZE\s+0x00004000u/);
    expect(h).toMatch(/#define IO_BASE\s+0x60000000u/);
    expect(h).toMatch(/#define DMA_BASE\s+0x40000000u/);
    const l = linkerScript(m, 'System on a bus');
    expect(l).toContain('ORIGIN = 0x00000000, LENGTH = 16K');
    expect(l).toContain('ORIGIN = 0x10000000, LENGTH = 1K');
    expect(l).toContain('PROVIDE(__screen_base = 0x50000000);');
  });
});
