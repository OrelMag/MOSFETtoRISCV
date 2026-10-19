import { describe, expect, it } from 'vitest';
import { Builder } from '../src/lib/builder';
import { busMux2, decoder, muxTree } from '../src/lib/combinational';
import { ones, splitter } from '../src/lib/define';
import { register } from '../src/lib/sequential';
import { lanePortMemory } from '../src/lib/warps';
import { orN } from '../src/lib/wide';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

// The warp cores' data memories (chapters 30, 31, 33) are built on demand, so the registry-wide
// layout tests never see them. Laid out in columns, routing lanePortMemory(7, 4) took half an hour
// and froze the tab that opened it.
describe('lanePortMemory schematic', () => {
  it.each([[5, 2, false], [6, 4, false], [7, 4, true]] as const)('(%i, %i, xport %s) routes cleanly and fast', (k, n, xport) => {
    const def = lanePortMemory(k, n, undefined, xport), nl = netlistOf(def)!;
    const t = performance.now();
    const { nets } = routeNetlist(def, nl);
    expect(performance.now() - t).toBeLessThan(3000);
    expect(wireOverlaps(nets)).toEqual([]);
    expect(symbolOverlaps(nl)).toEqual([]);
    expect(labelOverlaps(def, nl)).toEqual([]);
    expect(backwardEnds(def, nl)).toEqual([]);
  });

  // The old column layout: 128 long d / en wires through one gap, crossing everything. Untangling it
  // took 152 s; the router's work budget (UNTANGLE_POPS) now gives up and draws the overlaps.
  it('a layout too tangled to untangle still routes in seconds', () => {
    const k = 6, n = 4, N = 2 ** k, R = register(32), M2 = busMux2(32), L = [0, 1, 2, 3];
    const ins = [...L.map((i) => `addr${i}`), ...L.map((i) => `wd${i}`), 'we', 'clk'];
    const b = new Builder(18, 16, 2);
    b.pins(...ins);
    const wes = b.op(splitter(ones(n)), ['we']);
    b.next();
    const dec = L.map((i) => b.op(decoder(k, true), [`addr${i}`, `${wes}.o${i}`]));
    b.next();
    const words = Array.from({ length: N }, (_, w) => {
      const sel = L.map((i) => `${dec[i]}.y${w}`);
      let d = 'wd0';
      for (let i = 1; i < n; i++) d = b.op1(M2, [d, `wd${i}`, sel[i]]);
      return { d, en: b.op1(orN(n), sel) };
    });
    b.next();
    const regs = words.map(({ d, en }) => {
      const r = b.add(R);
      b.wire(d, `${r}.d`); b.wire(en, `${r}.en`); b.wire('clk', `${r}.clk`);
      return `${r}.q`;
    });
    b.next();
    L.forEach((i) => {
      const m = b.add(muxTree(k, 32));
      regs.forEach((q, w) => b.wire(q, `${m}.d${w}`));
      b.wire(`addr${i}`, `${m}.s`);
      b.wire(`${m}.y`, `rd${i}`);
    });
    const def = lanePortMemory(k, n);
    const pins: Record<string, [number, number]> = {};
    ins.forEach((p, i) => (pins[p] = [0, 2 + 4 * i]));
    L.forEach((i) => (pins[`rd${i}`] = [b.right, 2 + 4 * i]));
    const t = performance.now();
    routeNetlist(def, { pins, instances: b.instances, nets: b.nets() });
    expect(performance.now() - t).toBeLessThan(15000);
  }, 60000);
});
