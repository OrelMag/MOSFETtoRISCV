import { describe, expect, it } from 'vitest';
import { systemCpu } from '../src/lib/system';
import { VM_DMEM_K, VM_IMEM_K } from '../src/riscv/vmprograms';
import { labelOverlaps, routeNetlist, symbolOverlaps } from '../src/view/route';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// The virtual-memory system CPU (chapters vmem and os) on the plain system's wired layout (circuit redraw, pointer review): the
// MMU sits in the address row between the ALU and the data memory (the PC reaches it along the lane over the top, the fetch address
// goes back to the ROM over the top), the glue gates beside the units they feed. As in tests/redrawclear-sysvariants.test.ts: a wire
// under a part's body seems to vanish and come back elsewhere; no label hides another and no symbol sits on another. `pointers`: the
// share of nets still drawn as pointers (94 % before; what stays are the MMU's control and fault signals, which run from the top
// right to the trap unit and the gates at the bottom left), so a later edit cannot slide back unnoticed.
const levels: [string, () => ComponentDef, number][] = [
  ['virtual-memory CPU', () => systemCpu([], { vm: true }), 0.42],
  ['virtual-memory CPU, the chapters\' scene', () => systemCpu([], { vm: true, imemK: VM_IMEM_K, dmemK: VM_DMEM_K }), 0.42],
];
const pointerShare = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  return nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length / nl.nets.length;
};

describe('virtual-memory system CPU drawn with wires', () => {
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
  it.each(levels)('%s: drawn mostly with wires', (_, make, share) => {
    expect(pointerShare(make())).toBeLessThanOrEqual(share + 0.005);
  }, 60_000);
  it('the address row: the MMU takes the ALU result and gives the memory its address by wires', () => {
    const nl = netlistOf(systemCpu([], { vm: true }))!;
    const net = (n: string) => nl.nets.find((x) => x.name === n)!;
    expect(net('ALUResult').tags).toBeUndefined();
    expect(net('ALUResult').ends).toContain('mmu.va');
    expect(net('MemAddr').tags).toBeUndefined();
    expect(net('PC').ends).toContain('mmu.pc');
    expect(net('fpa').tags).toBeUndefined();
  });
});
