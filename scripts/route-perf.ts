// Time routeNetlist on the warp cores' data memory (lanePortMemory), which used to take minutes.
// npx vite-node scripts/route-perf.ts [k] [n]
import { lanePortMemory } from '../src/lib/warps';
import { routeNetlist } from '../src/view/route';

const k = Number(process.argv[2] ?? 5), n = Number(process.argv[3] ?? 4);
const def = lanePortMemory(k, n);
let t = performance.now();
const nl = def.netlist!();
console.log(`netlist: ${nl.instances.length} instances, ${nl.nets.length} nets, ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
const r = routeNetlist(def, nl);
console.log(`route: ${(performance.now() - t).toFixed(0)} ms, ${r.nets.reduce((s, x) => s + x.paths.length, 0)} paths`);
