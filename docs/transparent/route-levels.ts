// Transparent boxes, measurement 1 (prototype, not product): what it costs to route each box of a CPU's top level, the
// work an in-place opening would do before it can draw. For every distinct child definition of the single-cycle CPU,
// the plain pipeline and the out-of-order core: its netlist (build), wires-first (drawnNetlist), routeNetlist (the
// router with its untangle budget), plus the same one level further down (the box's own boxes).
//   node node_modules/vite-node/vite-node.mjs docs/transparent/route-levels.ts [--json out.json]
import '../../src/lib';
import { singleCycleCpu } from '../../src/lib/cpu';
import { pipelinedCpu } from '../../src/lib/pipeline';
import { oooCpu } from '../../src/lib/ooocore';
import { assemble } from '../../src/riscv/asm';
import { PROGRAMS } from '../../src/riscv/programs';
import { routeNetlist } from '../../src/view/route';
import { drawnNetlist } from '../../src/view/wirefirst';
import { estimateInstances } from '../../src/sim/flatten';
import { netlistOf, type ComponentDef } from '../../src/sim/types';
import { writeFileSync } from 'node:fs';

const words = assemble(PROGRAMS.find((p) => p.id === 'fib')!.source).words;
const tops: [string, ComponentDef][] = [
  ['single-cycle', singleCycleCpu(words)],
  ['pipeline', pipelinedCpu(words)],
  ['ooo', oooCpu(words, { imemK: 6, dmemK: 6 })],
];

interface Row { top: string; inst: string; id: string; depth: 1 | 2; parts: number; nets: number; below: number; buildMs: number; wiresMs: number; routeMs: number }
const rows: Row[] = [];
const seen = new Map<string, Omit<Row, 'top' | 'inst' | 'depth'>>();

function measure(def: ComponentDef): Omit<Row, 'top' | 'inst' | 'depth'> | null {
  const hit = seen.get(def.id);
  if (hit) return hit;
  let t = performance.now();
  const nl = netlistOf(def);
  if (!nl) return null;
  const buildMs = performance.now() - t;
  t = performance.now();
  const drawn = drawnNetlist(def, nl);
  const wiresMs = performance.now() - t;
  t = performance.now();
  routeNetlist(def, drawn);
  const routeMs = performance.now() - t;
  const r = { id: def.id, parts: nl.instances.length, nets: nl.nets.length, below: estimateInstances(def), buildMs, wiresMs, routeMs };
  seen.set(def.id, r);
  return r;
}

// pass 1 warms the JIT and the routers' caches; pass 2 is what a page that has already drawn a few levels pays
const cold = new Map<string, number>();
for (let pass = 1; pass <= 2; pass++) {
if (pass === 2) { for (const [k, v] of seen) cold.set(k, v.buildMs + v.wiresMs + v.routeMs); seen.clear(); rows.length = 0; }
for (const [top, def] of tops) {
  const nl = netlistOf(def)!;
  for (const i of nl.instances) {
    const r = measure(i.def);
    if (!r) continue;
    rows.push({ top, inst: i.name, depth: 1, ...r });
    for (const j of netlistOf(i.def)?.instances ?? []) {
      const q = measure(j.def);
      if (q) rows.push({ top, inst: `${i.name}.${j.name}`, depth: 2, ...q });
    }
  }
}
}

const f = (x: number) => x.toFixed(1).padStart(7);
for (const [top] of tops) {
  const d1 = rows.filter((r) => r.top === top && r.depth === 1).sort((a, b) => b.routeMs - a.routeMs);
  console.log(`\n${top}: ${d1.length} boxes that open (first measurement of each definition counts; repeats are cached)`);
  console.log('inst'.padEnd(12), 'id'.padEnd(28), 'parts'.padStart(6), 'nets'.padStart(6), 'below'.padStart(8), '  build', '  wires', '  route');
  for (const r of d1.slice(0, 40)) console.log(r.inst.padEnd(12), r.id.slice(0, 28).padEnd(28), String(r.parts).padStart(6), String(r.nets).padStart(6), String(r.below).padStart(8), f(r.buildMs), f(r.wiresMs), f(r.routeMs));
  const d2 = rows.filter((r) => r.top === top && r.depth === 2);
  const worst2 = d2.sort((a, b) => b.routeMs - a.routeMs)[0];
  console.log(`  depth 2: ${d2.length} boxes; slowest ${worst2?.inst} (${worst2?.id}) ${worst2?.routeMs.toFixed(1)} ms`);
}
const all = [...seen.values()].map((r) => r.routeMs + r.wiresMs + r.buildMs).sort((a, b) => a - b);
const pct = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))].toFixed(1);
console.log(`\ndistinct levels: ${all.length}; build + wires + route per level: median ${pct(0.5)} ms, p90 ${pct(0.9)} ms, max ${pct(1)} ms`);
const out = process.argv.indexOf('--json');
if (out > 0) writeFileSync(process.argv[out + 1], JSON.stringify({ rows, cold: Object.fromEntries(cold), node: process.version, at: new Date().toISOString() }, null, 1));
