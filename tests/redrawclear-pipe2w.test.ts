import { describe, expect, it } from 'vitest';
import { dualPipeCpu } from '../src/lib/pipe2w';
import { assemble } from '../src/riscv/asm';
import { instPort, symbolGeom } from '../src/sim/geometry';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps } from '../src/view/route';
import { drawnNetlist, wireCrossings, wiresThroughParts } from '../src/view/wirefirst';

// The dual-issue pipeline's top level (chapter ooo, "Two at a time, in order"), redrawn as the plain pipeline is
// (lib/pipe2w.ts dualDrawing): lane 1 below lane 0 with the same layout, the shared units in a band at the bottom.
// Before: one tall column of Builder columns, 409 × 500 units, 179 of 280 nets pointers (64 %), 478 crossings and
// 20 wires drawn under a part; fitted into 1000 × 640 px that is 1.28 px per unit. After: 332 × 270 units, 60 %,
// 263 crossings, none under a part, 2.37 px per unit. Pinned so a later edit cannot slide back unnoticed.
const make = (o: { imemK?: number; dmemK?: number } = {}) => dualPipeCpu(assemble('li a0, 1\nj .').words, o);
const variants: [string, () => ComponentDef][] = [
  ['default sizes', () => make()],
  ['the chapter\'s (data memory 2^6)', () => make({ dmemK: 6 })],
  ['a larger program memory (2^8)', () => make({ imemK: 8, dmemK: 6 })],
];
const drawn = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  return { nl, r: routeNetlist(def, nl) };
};

describe('the dual-issue pipeline drawn as two lanes', () => {
  it.each(variants)('%s: no wire runs through a part, no label hides another, no symbol sits on another', (_, mk) => {
    const def = mk(), { nl, r } = drawn(def);
    expect([...wiresThroughParts(nl, r.nets)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
    expect(labelOverlaps(def, netlistOf(def)!)).toEqual([]);
    expect(symbolOverlaps(netlistOf(def)!)).toEqual([]);
  }, 120_000);

  it.each(variants)('%s: its pointers, crossings and size no more than when redrawn', (_, mk) => {
    const def = mk(), { nl, r } = drawn(def);
    const tagged = nl.nets.filter((n) => n.tags === true || (Array.isArray(n.tags) && n.tags.length > 0)).length;
    expect(tagged / nl.nets.length).toBeLessThanOrEqual(0.60);
    expect(wireCrossings(r.nets)).toBeLessThanOrEqual(263);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const i of nl.instances) { const g = symbolGeom(i.def); add(i.at![0], i.at![1]); add(i.at![0] + g.w, i.at![1] + g.h); }
    for (const n of r.nets) for (const p of n.paths) for (const [x, y] of p) add(x, y);
    expect(Math.min(1000 / (x1 - x0), 640 / (y1 - y0))).toBeGreaterThanOrEqual(2.3);
  }, 120_000);

  it('lines each lane\'s registers up, lane 1 under lane 0 and the shared band under both', () => {
    const nl = netlistOf(make({ dmemK: 6 }))!;
    const inst = new Map(nl.instances.map((i) => [i.name, i]));
    const y = (end: string) => { const [n, p] = end.split('.'), i = inst.get(n)!; return instPort(i.def, i.at!, i.flip, p, i.rot).pos[1]; };
    for (const l of ['', '1']) {
      // the fields that only ride along run straight from one register to the next
      for (const f of ['valid', 'pc', 'pcPlus4']) expect(y(`FD${l}.${f}D`), `${f}D`).toBe(y(`DE${l}.${f}D`));
      for (const f of ['valid', 'pc', 'pcPlus4', 'aluResult', 'imm', 'rd', 'regWrite', 'resultSrc']) expect(y(`EM${l}.${f}M`), `${f}M`).toBe(y(`MW${l}.${f}M`));
    }
    const bottom = (n: string) => inst.get(n)!.at![1] + symbolGeom(inst.get(n)!.def).h;
    expect(inst.get('DE1')!.at![1]).toBeGreaterThan(bottom('DE'));
    for (const n of ['rf', 'pair', 'hz', 'pctl', 'upd', 'cmt']) expect(inst.get(n)!.at![1], n).toBeGreaterThan(bottom('DE1'));
  });
});
