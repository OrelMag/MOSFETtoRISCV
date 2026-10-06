import { describe, expect, it } from 'vitest';
import { cachedMemory, dualCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { define, registry } from '../src/lib/define';
import { NAND } from '../src/lib/transistors';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import type { ComponentDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';
import { routeNetlist, wireOverlaps } from '../src/view/route';
import { cpuTops } from './tops';

// Build the parametric designs the chapters show, so their schematics are in the registry too.
const words = assemble(PROGRAMS[0].source).words;
singleCycleCpu(words);
singleCycleCpu(words, { adder: 'ks' });
pipelinedCpu(words, { adder: 'ks', balanced: true, predictor: true });
pipelinedCpu(words);
systemCpu(words, { m: true });
multicycleCpu(words, { control: 'fsm' });
multicycleCpu(words, { control: 'micro' });
dualCore(words);
cachedMemory(6, 2);

/** Every component reachable from the registry, including generated sub-components. */
function allDefs(): ComponentDef[] {
  const seen = new Set<ComponentDef>();
  const visit = (d: ComponentDef) => {
    if (seen.has(d)) return;
    seen.add(d);
    for (const i of netlistOf(d)?.instances ?? []) visit(i.def);
  };
  for (const d of registry.values()) visit(d);
  for (const d of cpuTops()) visit(d); // top-level CPUs are not registered
  return [...seen];
}

describe('schematic routing', () => {
  // One test per schematic: each is quick, and the runner gets the event loop back in between
  // (a single loop over every design starved Vitest's worker RPC on CI).
  const defs = allDefs().filter((d) => netlistOf(d));
  it.each(defs.map((d) => [d.id, d] as const))('%s: never draws two nets on one line', (_, def) => {
    const nl = netlistOf(def)!;
    const bad = wireOverlaps(routeNetlist(def, nl).nets).map((o) => {
      const [a, b] = o.nets.map((n) => nl.nets[n].name ?? nl.nets[n].ends[0]);
      return `${a} / ${b} on ${o.axis === 'h' ? 'y' : 'x'}=${o.at} (${o.from}..${o.to})`;
    });
    expect(bad).toEqual([]);
  });

  // Two NANDs side by side, each driving a sink on the far side: both default trunks sit at
  // the same x, so one must move.
  const pair = define({
    id: 'test_route_pair',
    name: 'route pair',
    category: 'gate',
    ports: [
      { name: 'a', dir: 'in', width: 1 }, { name: 'b', dir: 'in', width: 1 },
      { name: 'y', dir: 'out', width: 1 }, { name: 'z', dir: 'out', width: 1 },
    ],
    symbol: { kind: 'box' },
    netlist: () => ({
      instances: [{ name: 'g', def: NAND, at: [10, 0] }, { name: 'h', def: NAND, at: [10, 6] }],
      pins: { a: [0, 1], b: [0, 9], y: [30, 13], z: [30, 15] },
      nets: [
        { ends: ['a', 'g.a', 'g.b'] }, { ends: ['b', 'h.a', 'h.b'] },
        { ends: ['g.y', 'y'] }, { ends: ['h.y', 'z'] },
      ],
    }),
  });

  it('moves a trunk off another net', () => {
    const nl = netlistOf(pair)!;
    const { nets } = routeNetlist(pair, nl);
    expect(wireOverlaps(nets)).toEqual([]);
    const trunkX = (n: number) => nets[n].paths[0].find((p, i, ps) => i > 0 && ps[i - 1][0] === p[0] && ps[i - 1][1] !== p[1])![0];
    expect(trunkX(2)).not.toBe(trunkX(3));
  });

  it('leaves a clean wire on its preferred trunk', () => {
    const nl = netlistOf(pair)!;
    const { nets } = routeNetlist(pair, nl);
    // a fans out on a trunk one stub from its pin; nothing is in the way, so nothing moves.
    expect(nets[0].paths[1]).toEqual([[0, 1], [1, 1], [1, 3], [10, 3]]);
    // Of the two colliding trunks (both at the midpoint, x = 22) one stays put.
    expect(nets[3].paths[0]).toEqual([[14, 8], [22, 8], [22, 15], [30, 15]]);
  });
});
