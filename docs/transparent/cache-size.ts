// Transparent boxes, measurement 4 (prototype, not product): what a build-time route cache would weigh and cost to make.
// Every registered netlist (src/lib's registry: what the registry-wide route tests already route) plus every level the
// three CPU tops reach two deep. Each is routed once, cold, as the build would; a level whose route takes over THRESHOLD ms
// goes in the cache as JSON (its routed nets, coordinates to 0.01 unit), measured raw and gzipped, one file per level.
//   node node_modules/vite-node/vite-node.mjs docs/transparent/cache-size.ts [threshold-ms]
import '../../src/lib';
import { registry } from '../../src/lib/define';
import { singleCycleCpu } from '../../src/lib/cpu';
import { pipelinedCpu } from '../../src/lib/pipeline';
import { oooCpu } from '../../src/lib/ooocore';
import { assemble } from '../../src/riscv/asm';
import { PROGRAMS } from '../../src/riscv/programs';
import { netlistOf, type ComponentDef } from '../../src/sim/types';
import { routeNetlist } from '../../src/view/route';
import { drawnNetlist } from '../../src/view/wirefirst';
import { gzipSync } from 'node:zlib';

const THRESHOLD = Number(process.argv[2] ?? 4);
const words = assemble(PROGRAMS.find((p) => p.id === 'fib')!.source).words;
const defs = new Map<string, ComponentDef>();
for (const d of registry.values()) if (netlistOf(d)) defs.set(d.id, d);
const reach = (d: ComponentDef, depth: number) => {
  for (const i of netlistOf(d)?.instances ?? []) {
    if (netlistOf(i.def) && !i.def.prim) { defs.set(i.def.id, i.def); if (depth > 1) reach(i.def, depth - 1); }
  }
};
for (const top of [singleCycleCpu(words), pipelinedCpu(words), oooCpu(words, { imemK: 6, dmemK: 6 })]) reach(top, 2);

const r2 = (v: number) => Math.round(v * 100) / 100;
let total = 0, files = 0, raw = 0, gz = 0, maxRaw = 0, slow = 0;
const t0 = performance.now();
const slowest: [string, number][] = [];
for (const [id, d] of defs) {
  const t = performance.now();
  let routed;
  try {
    routed = routeNetlist(d, drawnNetlist(d, netlistOf(d)!));
  } catch (e) { console.log('failed', id, String(e).slice(0, 80)); continue; }
  const ms = performance.now() - t;
  total += ms;
  slowest.push([id, ms]);
  if (ms <= THRESHOLD) continue;
  slow++;
  const json = JSON.stringify(routed.nets.map((n) => ({ i: n.index, p: n.paths.map((p) => p.flatMap(([x, y]) => [r2(x), r2(y)])), d: n.dots.flatMap(([x, y]) => [r2(x), r2(y)]), l: n.label && [r2(n.label[0]), r2(n.label[1]), r2(n.labelRoom)], e: n.ends })));
  const b = Buffer.byteLength(json), g = gzipSync(json, { level: 9 }).length;
  files++; raw += b; gz += g; maxRaw = Math.max(maxRaw, b);
}
const kb = (x: number) => `${(x / 1024).toFixed(0)} KB`;
slowest.sort((a, b) => b[1] - a[1]);
console.log(`${defs.size} levels routed in ${(total / 1000).toFixed(1)} s (wall ${((performance.now() - t0) / 1000).toFixed(1)} s); over ${THRESHOLD} ms: ${slow}`);
console.log(`cache: ${files} files, ${kb(raw)} raw, ${kb(gz)} gzipped, largest file ${kb(maxRaw)}`);
console.log('slowest:', slowest.slice(0, 8).map(([id, ms]) => `${id} ${ms.toFixed(0)} ms`).join(', '));
