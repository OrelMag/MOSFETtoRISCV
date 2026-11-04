// Builds chapter 50's two computers and a switch on the cycle engine and runs the ping, reporting how long each step takes.
// npx vite-node scripts/lan-feasibility.ts [cycles]

import { performance } from 'node:perf_hooks';
import { hostApp, pingApp } from '../src/comm/stack/apps';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { stackProgram } from '../src/comm/stack';
import { lanComputers } from '../src/lib/lan';
import { stats } from '../src/sim/stats';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { pack } from '../src/sim/values';

const cycles = Number(process.argv[2] ?? 200000);
let t = performance.now();
const lap = (what: string) => { const n = performance.now(); console.log(`${what}: ${((n - t) / 1000).toFixed(1)} s`); t = n; };

const A = stackProgram(DEFAULT_STACK, pingApp(3, 32)), B = stackProgram(DEFAULT_STACK, hostApp());
if (A.compiled.error || B.compiled.error) throw new Error(`${A.compiled.error?.message ?? ''} ${B.compiled.error?.message ?? ''}`);
console.log('words', A.compiled.words.length, B.compiled.words.length);
lap('compile');
const def = lanComputers(A.compiled.words, B.compiled.words);
lap('build');
const s = stats(def);
console.log('NANDs', s.nands, 'parts', s.parts);
lap('stats');
const flat = flatten(def);
lap('flatten');
const sim = new DualSim(flat);
sim.preferFast = true;
sim.reset('zero');
sim.setInput('clk', 0);
sim.settle(); sim.prepare(); sim.settle();
lap('prepare');
console.log('engine', sim.engine, sim.whyNot);
const root = sim.design.root;
const out = (p: string) => pack(sim.getBits(root.ports[p]));
const con = { A: '', B: '' };
t = performance.now();
let last = t;
for (let c = 0; c < cycles; c++) {
  for (const S of ['A', 'B'] as const) if (out(`consoleValid${S}`) === 1) con[S] += String.fromCharCode(out(`consoleData${S}`));
  sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
  if (c % 20000 === 19999) { const n = performance.now(); console.log(`cycle ${c + 1}: ${(20000 / ((n - last) / 1000)).toFixed(0)} cycles/s`, JSON.stringify(con)); last = n; }
  if (con.A.includes('done')) { console.log('done at cycle', c); break; }
}
lap('run');
console.log(JSON.stringify(con));
