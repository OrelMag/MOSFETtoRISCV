import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { DRAM_OPEN } from './verify/cpus';
import { assemble } from '../src/riscv/asm';
import { labelOverlaps, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';
import { boxText } from '../src/view/boxtext';
import { nameEligible, nameRotated, planNames } from '../src/view/legible';
import { symbolGeom } from '../src/sim/geometry';

// The CPU variants drawn on the plain cores' wires (circuit redraw, CPU variants): the FPU core and the pipeline with fast adders,
// balanced forwarding, a predictor, a data cache or the M extension. As in tests/redrawclear.test.ts: a wire drawn under a part's
// body seems to vanish and come back elsewhere. Also: no label hides another and no symbol sits on another.
const w = assemble('j .').words;
const levels: [string, () => ComponentDef][] = [
  ['FPU core', () => singleCycleCpu(w, { fpu: true })],
  ['FPU core, fast adders', () => singleCycleCpu(w, { fpu: true, adder: 'ks' })],
  ['pipeline, fast adders', () => pipelinedCpu(w, { adder: 'ks' })],
  ['pipeline, balanced', () => pipelinedCpu(w, { adder: 'ks', balanced: true })],
  ['pipeline, predictor', () => pipelinedCpu(w, { predictor: true })],
  ['pipeline, balanced + predictor', () => pipelinedCpu(w, { adder: 'ks', balanced: true, predictor: true })],
  ['pipeline, write-through cache', () => pipelinedCpu(w, { adder: 'ks', dcache: 'wt' })],
  ['pipeline, write-back cache', () => pipelinedCpu(w, { adder: 'ks', dcache: 'wb' })],
  ['pipeline, 2-way write-back cache', () => pipelinedCpu(w, { adder: 'ks', dcache: 'wb2' })],
  ['pipeline, 2-way write-back cache over DRAM', () => pipelinedCpu(w, { adder: 'ks', dcache: 'wb2', dram: DRAM_OPEN })],
  ['pipeline, cache + balanced + predictor', () => pipelinedCpu(w, { adder: 'ks', dcache: 'wt', predictor: true, balanced: true })],
  ['pipeline, M extension', () => pipelinedCpu(w, { adder: 'ks', m: true })],
  ['pipeline, M extension + balanced + predictor', () => pipelinedCpu(w, { adder: 'ks', balanced: true, predictor: true, m: true })],
];

describe('CPU variants drawn with wires', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const r = routeNetlist(def, nl);
    expect([...wiresThroughParts(nl, r.nets)].map((i) => nl.nets[i].name)).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: no label hides another, no symbol sits on another', (_, make) => {
    const def = make();
    expect(labelOverlaps(def, netlistOf(def)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(def)!)).toEqual([]);
  }, 60_000);
  it.each(levels)('%s: every pointer is a named line', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    expect(nl.nets.filter((n) => (n.tags === true || (n.tags?.length ?? 0) > 0) && !n.name).length).toBe(0);
  }, 60_000);
});

// A block's name must survive: the label inside its box (boxtext's placement), and the fixed-size name the view draws where the
// label is too small to read (legible.ts planNames drops a name that collides with a larger block's). A data cache set too close to
// the MEM/WB register's turned name lost its own.
describe('CPU variants keep their blocks named', () => {
  const caches: [string, () => ComponentDef][] = levels.filter(([n]) => /cache|DRAM/.test(n)).concat([['ports + write-through cache', () => pipelinedCpu([], { adder: 'ks', ports: true, dcache: 'wt' })]]);
  it.each(levels)('%s: every box keeps a label', (_, make) => {
    const def = make();
    for (const i of netlistOf(def)!.instances) {
      if (i.def.symbol.kind !== 'box' || i.def.prim === 'alias' || i.def.symbol.verticalLabel) continue;
      const g = symbolGeom(i.def);
      if (g.w < 6 || g.h < 4) continue; // too small for any label
      expect(boxText(i.def, i.flip).label, `${def.id}: ${i.name}`).not.toBeNull();
    }
  }, 60_000);
  it.each(caches)('%s: the cache keeps its fixed-size name at every fitted scale', (_, make) => {
    const def = make();
    const nl = netlistOf(def)!;
    const named = nl.instances.filter((i) => nameEligible(boxText(i.def, i.flip).label?.text ?? i.def.symbol.label ?? i.def.name, symbolGeom(i.def).w, symbolGeom(i.def).h));
    const boxes = named.map((i) => { const g = symbolGeom(i.def), at = i.at ?? [0, 0]; const t = (boxText(i.def, i.flip).label?.text ?? i.def.symbol.label ?? i.def.name).trim(); return { cx: at[0] + g.w / 2, cy: at[1] + g.h / 2, w: g.w, h: g.h, chars: t.length, rot: nameRotated(g.w, g.h) }; });
    const dm = named.findIndex((i) => i.name === 'dm');
    expect(dm).toBeGreaterThanOrEqual(0);
    for (const scale of [2.4, 2.7, 3, 3.5, 4, 4.5, 5]) expect(planNames(boxes, scale)[dm], `scale ${scale}`).toBe(true);
  }, 60_000);
});
