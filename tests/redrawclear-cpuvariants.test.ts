import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { DRAM_OPEN } from './verify/cpus';
import { assemble } from '../src/riscv/asm';
import { labelOverlaps, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

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
