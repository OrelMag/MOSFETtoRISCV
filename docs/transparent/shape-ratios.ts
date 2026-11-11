// Transparent boxes, measurement 3 (prototype, not product): the shape mismatch. For every box on the three CPU tops that
// opens, its symbol (grid units) against the extent of its own drawing (symbols + routed wires), the scale factor between
// them (inner drawn to fit inside the symbol), and the outer zoom at which the inside's text reaches legible.ts's 7 px
// (a box label is 1.05 units; port names 0.8) or its block names NAME_PX = 12 px.
//   node node_modules/vite-node/vite-node.mjs docs/transparent/shape-ratios.ts
import '../../src/lib';
import { singleCycleCpu } from '../../src/lib/cpu';
import { pipelinedCpu } from '../../src/lib/pipeline';
import { oooCpu } from '../../src/lib/ooocore';
import { assemble } from '../../src/riscv/asm';
import { PROGRAMS } from '../../src/riscv/programs';
import { symbolGeom } from '../../src/sim/geometry';
import { netlistOf, type ComponentDef } from '../../src/sim/types';
import { routeNetlist, symbolRects } from '../../src/view/route';
import { drawnNetlist } from '../../src/view/wirefirst';
import { LABEL_UNITS, MIN_TEXT_PX, TEXT_UNITS } from '../../src/view/legible';

const words = assemble(PROGRAMS.find((p) => p.id === 'fib')!.source).words;
const tops: [string, ComponentDef][] = [['single-cycle', singleCycleCpu(words)], ['pipeline', pipelinedCpu(words)], ['ooo', oooCpu(words, { imemK: 6, dmemK: 6 })]];
const PORT = TEXT_UNITS.port;

function extent(def: ComponentDef): { w: number; h: number } {
  const nl = drawnNetlist(def, netlistOf(def)!);
  const xs: number[] = [], ys: number[] = [];
  for (const s of symbolRects(nl)) { xs.push(s.r.x, s.r.x + s.r.w); ys.push(s.r.y, s.r.y + s.r.h); }
  for (const n of routeNetlist(def, nl).nets) for (const p of n.paths) for (const [x, y] of p) { xs.push(x); ys.push(y); }
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

const seen = new Set<string>();
const rows: { top: string; inst: string; id: string; sw: number; sh: number; iw: number; ih: number; k: number; aspect: number; label7: number; port7: number }[] = [];
for (const [top, def] of tops) for (const i of netlistOf(def)!.instances) {
  if (seen.has(i.def.id) || !netlistOf(i.def) || i.def.prim) continue;
  seen.add(i.def.id);
  const g = symbolGeom(i.def), e = extent(i.def);
  if (!(e.w > 0 && e.h > 0)) continue;
  const k = Math.min(g.w / e.w, g.h / e.h);
  // outer px per unit at which the inside, fitted to the symbol, draws its labels / port names at MIN_TEXT_PX
  rows.push({ top, inst: i.name, id: i.def.id, sw: g.w, sh: g.h, iw: e.w, ih: e.h, k, aspect: (e.w / e.h) / (g.w / g.h), label7: MIN_TEXT_PX / LABEL_UNITS / k, port7: MIN_TEXT_PX / PORT / k });
}
rows.sort((a, b) => a.label7 - b.label7);
const r1 = (x: number) => x.toFixed(1);
console.log('inst'.padEnd(9), 'id'.padEnd(22), 'symbol'.padStart(11), 'inside'.padStart(13), '  1/k', ' aspect', ' px/u labels', ' px/u ports', ' symbol px at labels');
for (const r of rows) console.log(r.inst.padEnd(9), r.id.slice(0, 22).padEnd(22), `${r1(r.sw)}×${r1(r.sh)}`.padStart(11), `${r1(r.iw)}×${r1(r.ih)}`.padStart(13), r1(1 / r.k).padStart(6), r1(r.aspect).padStart(7), r1(r.label7).padStart(12), r1(r.port7).padStart(11), `${Math.round(r.sw * r.label7)}×${Math.round(r.sh * r.label7)}`.padStart(20));
const ks = rows.map((r) => 1 / r.k).sort((a, b) => a - b), as = rows.map((r) => Math.max(r.aspect, 1 / r.aspect)).sort((a, b) => a - b);
const q = (a: number[], p: number) => r1(a[Math.floor(p * (a.length - 1))]);
console.log(`\n${rows.length} distinct boxes. inside / symbol scale: median ${q(ks, 0.5)}×, p90 ${q(ks, 0.9)}×, max ${q(ks, 1)}×. aspect mismatch (≥ 1): median ${q(as, 0.5)}, p90 ${q(as, 0.9)}, max ${q(as, 1)}`);
console.log(`a box's labels reach ${MIN_TEXT_PX} px when the box itself is drawn at median ${q(rows.map((r) => r.sh * r.label7).sort((a, b) => a - b), 0.5)} px tall`);
