// Sandbox performance harness (no DOM): the costs behind one edit of a big chip.
// Run: npx vite-node scripts/sandbox-perf.ts
// A CPU opened in the sandbox (docFromDef), then: compile, library update after a move,
// polylines + wire groups + hops (what EditorView recomputes), simulator rebuild and cycle rate;
// and a transistor chip whose truth table is derived (compile after a move).

import '../src/lib';
import { compileChip } from '../src/editor/compile';
import { docFromDef } from '../src/editor/fromdef';
import { wireGroups } from '../src/editor/geom';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, type DefOf, polyline, SCHEMA, type Workspace } from '../src/editor/model';
import { moveSel } from '../src/editor/ops';
import { partDef } from '../src/editor/parts';
import { EditorSim } from '../src/editor/runtime';
import { singleCycleCpu } from '../src/lib/cpu';
import { registry } from '../src/lib/define';
import { resolveComponent } from '../src/lib/resolve';
import { netlistOf } from '../src/sim/types';
import { assemble } from '../src/riscv/asm';
import { PROGRAMS } from '../src/riscv/programs';
import type { Vec } from '../src/sim/geometry';
import { hopPathData, type RoutedNet } from '../src/view/route';

const time = (label: string, f: () => unknown, n = 5): number => {
  f();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) f();
  const ms = (performance.now() - t0) / n;
  console.log(`${label.padEnd(44)} ${ms.toFixed(2).padStart(9)} ms`);
  return ms;
};
const defOf: DefOf = (p) => {
  const r = partDef(p.ref, () => undefined);
  return 'error' in r ? undefined : r;
};
const ws = (doc: ChipDoc): Workspace => ({ schema: SCHEMA, chips: { [doc.id]: doc }, open: [doc.id] });

const cpu = singleCycleCpu(assemble(PROGRAMS[0].source).words);
// The instruction ROM is generated per program and not registered: make it placeable by id.
for (const i of netlistOf(cpu)!.instances) if (!resolveComponent(i.def.id)) registry.set(i.def.id, i.def);
const doc = docFromDef(cpu) as ChipDoc;
if ('error' in doc) throw new Error(String(doc.error));
console.log(`CPU doc: ${doc.parts.length} parts, ${doc.wires.length} wires, ${doc.labels.length} pointers, ${doc.pins.length} pins`);

const compile = (d: ChipDoc) => compileChip(d, (ref) => partDef(ref, () => undefined));
time('compileChip (CPU)', () => compile(doc));
const moved = moveSel(doc, { parts: [doc.parts[3].id] }, [1, 0], defOf);
const lib = new UserLibrary(ws(doc));
let flip = false;
time('UserLibrary.update after a move', () => { flip = !flip; lib.update(ws(flip ? moved : doc)); });
const polys = () => doc.wires.map((w) => polyline(doc, w, defOf));
time('polylines of every wire', polys);
time('wireGroups', () => wireGroups(doc.wires));
const groups = wireGroups(doc.wires);
const pl = new Map(doc.wires.map((w) => [w.id, polyline(doc, w, defOf)]));
const nets: RoutedNet[] = [];
groups.forEach((ids, gi) => { for (const id of ids) { const p = pl.get(id); if (p) nets.push({ index: gi, width: 1, tags: [], paths: [p as Vec[]], dots: [], label: null, labelRoom: 0 }); } });
time('hopPathData (all wires)', () => hopPathData(nets));
time('hopPathData (only 1 group)', () => hopPathData(nets, [], 0.45, new Set([0])));

const c = compile(doc);
const sim = new EditorSim({ debounceMs: 0 });
time('EditorSim rebuild (flatten + GateSim)', () => { sim.update({ ...c, connKey: String(Math.random()) }, doc.pins); }, 3);
sim.mode = 'cycle';
sim.hz = Infinity;
const t0 = performance.now();
let cycles = 0;
while (performance.now() - t0 < 1000) cycles += sim.advance(1 / 60, 8);
console.log(`${'cycle mode, 8 ms budget per frame'.padEnd(44)} ${cycles} cycles/s in budget (${(cycles / (1000 / 8)).toFixed(1)} per frame)`);

// A transistor-level chip: 5 CMOS NORs, 10 inputs (1024-row truth table derived on compile).
const tr: ChipDoc = { id: 'u_tr', name: 'TR', pins: [], parts: [], wires: [], labels: [] };
for (let i = 0; i < 5; i++) {
  tr.parts.push({ id: `g${i}`, ref: { lib: 'nor_cmos' }, at: [10, i * 10] });
  tr.pins.push({ id: `a${i}`, name: `a${i}`, dir: 'in', width: 1, at: [0, i * 10] }, { id: `b${i}`, name: `b${i}`, dir: 'in', width: 1, at: [0, i * 10 + 4] },
    { id: `y${i}`, name: `y${i}`, dir: 'out', width: 1, at: [30, i * 10] });
  tr.wires.push({ id: `wa${i}`, a: { pin: `a${i}` }, b: { part: `g${i}`, port: 'a' }, pts: [] },
    { id: `wb${i}`, a: { pin: `b${i}` }, b: { part: `g${i}`, port: 'b' }, pts: [] },
    { id: `wy${i}`, a: { part: `g${i}`, port: 'y' }, b: { pin: `y${i}` }, pts: [] });
}
const trLib = new UserLibrary(ws(tr));
console.log(`transistor chip derived: ${trLib.compiled('u_tr')!.derived?.ok}`);
const trMoved = moveSel(tr, { parts: ['g0'] }, [0, 1], defOf);
let f2 = false;
time('transistor chip: library update after a move', () => { f2 = !f2; trLib.update(ws(f2 ? trMoved : tr)); }, 4);

// A wide flat chip: the 64-bit Kogge-Stone adder (hundreds of parts, ~1500 wires).
const ks = docFromDef(resolveComponent('ks64')!) as ChipDoc;
console.log(`\nks64 doc: ${ks.parts.length} parts, ${ks.wires.length} wires`);
time('compileChip (ks64)', () => compile(ks));
const ksMoved = moveSel(ks, { parts: [ks.parts[10].id] }, [1, 0], defOf);
const ksLib = new UserLibrary(ws(ks));
let f3 = false;
time('UserLibrary.update after a move (ks64)', () => { f3 = !f3; ksLib.update(ws(f3 ? ksMoved : ks)); });
time('polylines of every wire (ks64)', () => ks.wires.map((w) => polyline(ks, w, defOf)));
time('wireGroups (ks64)', () => wireGroups(ks.wires));
const kg = wireGroups(ks.wires);
const kn: RoutedNet[] = [];
kg.forEach((ids, gi) => { for (const id of ids) { const w = ks.wires.find((x) => x.id === id)!; const p = polyline(ks, w, defOf); if (p) kn.push({ index: gi, width: 1, tags: [], paths: [p], dots: [], label: null, labelRoom: 0 }); } });
time('hopPathData all (ks64)', () => hopPathData(kn));
time('hopPathData only 3 groups (ks64)', () => hopPathData(kn, [], 0.45, new Set([0, 1, 2])));
