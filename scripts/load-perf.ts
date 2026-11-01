// Times the phases Stage.build runs for a big scene (chapter 34's GPU by default): hierarchy, flatten, engine start.
// Usage: node node_modules/vite-node/vite-node.mjs scripts/load-perf.ts [mesh] [--async]
import { gpu31 } from '../src/lib/gfxpipe';
import { meshById } from '../src/riscv/gfxprograms';
import { flatten, flattenAsync } from '../src/sim/flatten';
import { DualSim } from '../src/sim/dualsim';
import { stats } from '../src/sim/stats';

const ms = () => performance.now();
const t0 = ms();
const root = gpu31(meshById('triangle'));
const t1 = ms();
const st = stats(root);
const t2 = ms();
let design;
if (process.argv.includes('--async')) {
  design = await flattenAsync(root, { mode: "gate", expand: (d, n) => n.parent === null || !d.preferBehavior }, () => {}, () => new Promise<void>((r) => { const c = new MessageChannel(); c.port1.onmessage = () => { c.port1.close(); r(); }; c.port2.postMessage(0); }));
} else {
  design = flatten(root, { mode: 'gate', expand: (d, n) => n.parent === null || !d.preferBehavior });
}
const t3 = ms();
const sim = new DualSim(design);
sim.preferFast = true;
sim.setInput('clk', 0);
sim.reset('zero');
sim.settle();
const t4 = ms();
console.log(JSON.stringify({ nands: st.nands, leaves: design.leaves.length, scene: +(t1 - t0).toFixed(0), stats: +(t2 - t1).toFixed(0), flatten: +(t3 - t2).toFixed(0), engine: +(t4 - t3).toFixed(0), total: +(t4 - t0).toFixed(0) }));
const te = ms();
const est = (await import('../src/sim/flatten')).estimateInstances(root, 'gate');
console.log(JSON.stringify({ estimate: est, estMs: +(ms() - te).toFixed(1) }));
let nodes = 0;
const cnt = (x: any): void => { nodes++; x.children?.forEach(cnt); };
cnt(design.root);
console.log(JSON.stringify({ actualInstances: nodes }));
