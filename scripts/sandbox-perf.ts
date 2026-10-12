// Sandbox performance harness (no DOM): the costs behind one edit of a big chip.
// Run: npx vite-node scripts/sandbox-perf.ts
// A CPU opened in the sandbox (docFromDef), then: compile, library update after a move,
// polylines + wire groups + hops (what EditorView recomputes), simulator rebuild and cycle rate;
// a transistor chip whose truth table is derived (compile after a move); large memories (a 64K × 32
// RAM placed and compiled, opened level by level; a 64K-word ROM).

import '../src/lib';
import { compileChip } from '../src/editor/compile';
import { docFromDef } from '../src/editor/fromdef';
import { wireGroups } from '../src/editor/geom';
import { UserLibrary } from '../src/editor/library';
import { lintChip } from '../src/editor/lint';
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
import { flatten } from '../src/sim/flatten';
import type { Vec } from '../src/sim/geometry';
import { analyzeTiming } from '../src/sim/timing';
import { stats } from '../src/sim/stats';
import { bigRam } from '../src/lib/bigmem';
import { romImage } from '../src/editor/memory';
import { ViewCtx } from '../src/view/context';
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

// Analysis on the big chips: lint after an edit, static timing on the CPU's flattening.
const ksC = compile(ks);
const ksPolys = new Map(ks.wires.flatMap((w) => { const p = polyline(ks, w, defOf); return p ? [[w.id, p] as const] : []; }));
time('lintChip (ks64)', () => lintChip(ks, ksC, ksPolys));
const cpuDesign = flatten(c.def, { mode: 'gate' });
time('analyzeTiming (CPU)', () => analyzeTiming(cpuDesign), 3);

// Large memories (lib/bigmem.ts): a 64K × 32 RAM part, cold and warm, with 64K initial words; a
// 64K-word ROM built from a 64K-line program; looking inside at each level (sub-simulation + sync).
console.log('\nLarge memories');
const ramDoc = (k: number, init?: number[]): ChipDoc => ({
  id: 'u_ram', name: 'RAM', labels: [],
  pins: [{ id: 'a', name: 'addr', dir: 'in', width: k, at: [0, 2] }, { id: 'd', name: 'din', dir: 'in', width: 32, at: [0, 4] },
    { id: 'e', name: 'we', dir: 'in', width: 1, at: [0, 6] }, { id: 'c', name: 'clk', dir: 'in', width: 1, at: [0, 8] }, { id: 'q', name: 'dout', dir: 'out', width: 32, at: [40, 4] }],
  parts: [{ id: 'mem', ref: { ram: { k, w: 32, ...(init ? { init } : {}) } }, at: [10, 0] }],
  wires: [['a', 'addr'], ['d', 'din'], ['e', 'we'], ['c', 'clk']].map(([p, port], i) => ({ id: `w${i}`, a: { pin: p }, b: { part: 'mem', port }, pts: [] as Vec[] }))
    .concat([{ id: 'wq', a: { part: 'mem', port: 'dout' } as never, b: { pin: 'q' } as never, pts: [] }]),
});
const once = (label: string, f: () => unknown): void => {
  const t0 = performance.now();
  f();
  console.log(`${label.padEnd(44)} ${(performance.now() - t0).toFixed(2).padStart(9)} ms`);
};
const big = ramDoc(16);
once('compileChip, 64K × 32 RAM (cold: first build)', () => compile(big));
time('compileChip, 64K × 32 RAM (warm)', () => compile({ ...big, parts: big.parts.map((p) => ({ ...p })) }));
const initWords = Array.from({ length: 65536 }, (_, i) => (i * 2654435761) >>> 0);
const bigInit = ramDoc(16, initWords);
time('compileChip, 64K × 32 RAM, 64K initial words', () => compile({ ...bigInit, parts: bigInit.parts.map((p) => ({ ...p, ref: { ram: { k: 16, w: 32, init: initWords } } })) }), 3);
const bigC = compile(big);
const bigSim = new EditorSim({ debounceMs: 0 });
time('EditorSim rebuild, 64K × 32 RAM', () => { bigSim.update({ ...bigC, connKey: String(Math.random()) }, big.pins); bigSim.flush(); }, 3);
const s0 = bigSim.sim!;
s0.setInput('we', 1);
const t1 = performance.now();
let writes = 0;
for (; performance.now() - t1 < 300; writes++) {
  s0.setInput('addr', writes & 0xffff); s0.setInput('din', writes); s0.setInput('clk', 0); s0.settle(); s0.setInput('clk', 1); s0.settle();
}
console.log(`${'write cycles (set, settle, edge, settle)'.padEnd(44)} ${Math.round(writes / 0.3)} /s`);
const prog = `${Array.from({ length: 65535 }, (_, i) => `addi x${1 + (i % 31)}, x0, ${i % 2048}`).join('\n')}\nhalt: j halt\n`;
time('ROM 64K words: romImage of a 64K-line program', () => romImage({ k: 16, w: 32, lang: 'asm', src: prog }), 2);
once('ROM 64K words: partDef (hash, levels)', () => partDef({ rom: { k: 16, w: 32, addr: 'rv32', lang: 'asm', src: prog } }, () => undefined));
const root = new ViewCtx(s0, s0.design.root);
let l1: ViewCtx | null = null;
once('look inside the RAM (16 banks of 4K)', () => { l1 = root.child('mem'); });
time('  sync per frame', () => l1!.sync(), 20);
let l3: ViewCtx | null = null;
once('  open two levels down (4 banks of 64)', () => { l3 = l1!.child('bank3')!.child('bank4'); });
time('  sync per frame', () => l3!.sync(), 20);
let l4: ViewCtx | null = null;
once('  open a 64-word bank (gates: flip-flops)', () => { l4 = l3!.child('bank1'); });
time('  sync per frame (latches seeded)', () => l4!.sync(), 20);
once('stats of 64K × 32 (per level)', () => stats(bigRam(16, 32)));
