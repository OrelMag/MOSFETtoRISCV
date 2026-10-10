import { describe, expect, it } from 'vitest';
import { cachedMemory, dualCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { registry } from '../src/lib/define';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import { deadInstances } from '../src/sim/dead';
import { netlistOf } from '../src/sim/types';
import { backwardEnds, labelOverlaps, symbolOverlaps } from '../src/view/route';
import { boxText, boxTextOverlaps } from '../src/view/boxtext';
import { counter } from '../src/lib/sequential';
import { symbolGeom } from '../src/sim/geometry';
import { families, initialParams } from '../src/lib/resolve';
import { bigMemTops, cpuTops } from './tops';
import { rv16Core } from '../src/lib/rv16/cpu';
import { rv16Pipe } from '../src/lib/rv16/pipe';
import { rv16SysCore } from '../src/lib/rv16/system';

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
// Every workbench family as it first opens.
for (const f of families) f.make(initialParams(f));
// The campaign's RV16 cores (built on demand, by the levels' reference answers).
for (const full of [false, true]) rv16Core(full);
rv16Core(true, true); rv16Core(true, false, 'mul'); rv16Core(true, false, 'div');
rv16SysCore(false); rv16SysCore(true);
for (const o of [{ fwd: false, stall: false, flush: false }, { fwd: true, stall: false, flush: false }, { fwd: true, stall: true, flush: false },
  { fwd: true, stall: true, flush: true }, { fwd: true, stall: true, flush: true, sys: true }, { fwd: true, stall: true, flush: true, predict: true }]) rv16Pipe(o);

describe('schematic labels', () => {
  // the top-level CPUs are not registered (only their parts are): add them explicitly
  const tops = [...cpuTops(), ...bigMemTops()];
  const defs = [...new Set([...registry.values(), ...tops])].filter((d) => d.netlist);
  it.each(defs.map((d) => [d.id, d] as const))('%s: no label hides another', (_, d) => {
    expect(labelOverlaps(d, netlistOf(d)!)).toEqual([]);
  });
  it.each(defs.map((d) => [d.id, d] as const))('%s: no symbol sits on another', (_, d) => {
    expect(symbolOverlaps(netlistOf(d)!)).toEqual([]);
  });
  it.each(defs.map((d) => [d.id, d] as const))('%s: no wire reaches a pin from behind its symbol', (_, d) => {
    expect(backwardEnds(d, netlistOf(d)!)).toEqual([]);
  });
});

describe('dead parts', () => {
  const defs = [...new Set([...registry.values(), ...cpuTops()])].filter((d) => d.netlist);
  it.each(defs.map((d) => [d.id, d] as const))('%s: every part reaches an output', (_, d) => {
    expect(deadInstances(netlistOf(d)!, d.ports)).toEqual([]);
  });
});

describe('box symbol text', () => {
  // every registered box (with a structure or not), and the sandbox's own displays and I/O parts
  const boxes = [...registry.values()].filter((d) => d.symbol.kind === 'box');
  it.each(boxes.map((d) => [d.id, d] as const))('%s: no port name or label hides another', (_, d) => {
    expect(boxTextOverlaps(d)).toEqual([]);
  });
  it('a short box with a clock at the bottom lifts its label clear of the clock\'s name', () => {
    const c = counter(8), t = boxText(c);
    const clk = t.ports.find((p) => p.name === 'clk')!;
    expect(t.label!.y).toBeLessThan(symbolGeom(c).h / 2 + 0.45);
    expect(t.label!.y).toBeLessThan(clk.y - 0.8);
  });
  it('a constant prints no port name', () => {
    expect(boxText(registry.get('tie1')!).ports).toEqual([]);
  });
});
