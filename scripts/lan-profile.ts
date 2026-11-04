// Where the cycle engine spends its time on chapter 50's scene: one computer with a NIC looped back, the switch alone, both.
import { performance } from 'node:perf_hooks';
import { DEFAULT_STACK } from '../src/comm/stack/all';
import { hostApp } from '../src/comm/stack/apps';
import { stackProgram } from '../src/comm/stack';
import { busComputer } from '../src/lib/soc';
import { lanSoc } from '../src/lib/lan';
import { ethSwitch } from '../src/lib/ethswitch';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';

function rate(name: string, def: ComponentDef, n = 3000) {
  const t0 = performance.now();
  const sim = new DualSim(flatten(def));
  sim.preferFast = true;
  sim.reset('zero');
  for (const p of def.ports) if (p.dir === 'in') sim.setInput(p.name, p.name === 'clk' ? 0 : p.name.startsWith('txReady') ? 1 : 0);
  sim.settle(); sim.prepare(); sim.settle();
  const t1 = performance.now();
  for (let c = 0; c < n; c++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
  const t2 = performance.now();
  console.log(`${name}: ${stats(def).nands} NANDs, prepare ${((t1 - t0) / 1000).toFixed(1)} s, ${(n / ((t2 - t1) / 1000)).toFixed(0)} cycles/s, engine ${sim.engine} ${sim.whyNot}`);
}
const B = stackProgram(DEFAULT_STACK, hostApp());
const soc = lanSoc(11);
rate('one computer (imemK 11, ram 32 KB, nic)', busComputer(B.compiled.words, [0], soc));
rate('one computer, no nic, 32 KB', busComputer(B.compiled.words, [0], { imemK: 11, ramK: 13 }));
rate('one computer, no nic, 4 KB', busComputer(B.compiled.words, [0], { imemK: 11, ramK: 10 }));
rate('switch cell 7 x 2', ethSwitch({ cellK: 7, cells: 2 }));
rate('switch cell 7 x 4', ethSwitch({ cellK: 7, cells: 4 }));
