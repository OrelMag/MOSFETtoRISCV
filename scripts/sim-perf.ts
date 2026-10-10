// Simulation speed of big sandbox circuits (no DOM): clock cycles per second.
// Run: npx vite-node scripts/sim-perf.ts [--dump <dir>] [--ref]
//
// Each CPU of the chapters is opened in the sandbox (remixDef, as "Open in Sandbox" does) running a
// program that never halts, and EditorSim runs it in cycle mode at "max" for two seconds of wall
// time with no frame budget (Node: no rendering, so this is the ceiling the page can reach). The
// 64-bit Kogge–Stone adder has no clock: its inputs change and EditorSim settles it.
// --ref also times the engine alone against the original object-based GateSim (tests/ref) on the
// same flat design (one cycle = clk high, settle, clk low, settle).
// --dump writes each CPU's workspace as JSON (localStorage `mosfet2riscv:sandbox:v1`) so a browser
// run can be seeded with it: scripts/browser-hz.mjs.

import { mkdirSync, writeFileSync } from 'node:fs';
import '../src/lib';
import { docFromDef } from '../src/editor/fromdef';
import { compileChip } from '../src/editor/compile';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { remixDef } from '../src/editor/remix';
import { EditorSim } from '../src/editor/runtime';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { resolveComponent } from '../src/lib/resolve';
import { systemCpu } from '../src/lib/system';
import { assemble } from '../src/riscv/asm';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { Sim } from '../src/sim/sim';
import type { ComponentDef } from '../src/sim/types';
import { RefGateSim } from '../tests/ref/gatesim-ref';

const args = process.argv.slice(2);
const dump = args.includes('--dump') ? args[args.indexOf('--dump') + 1] : null;
const withRef = args.includes('--ref');

/** Busy forever: ALU, a store and a load every pass, a taken branch (never `j .`, which halts). */
const LOOP = assemble(`
        li   t0, 0
        li   t1, 7
loop:   addi t0, t0, 1
        xor  t1, t1, t0
        slli t2, t1, 3
        sw   t2, 8(zero)
        lw   t3, 8(zero)
        add  a0, a0, t3
        bne  t0, zero, loop
        j    loop`).words;

const CPUS: [string, ComponentDef][] = [
  ['single-cycle RV32I', singleCycleCpu(LOOP)],
  ['pipelined RV32I', pipelinedCpu(LOOP)],
  ['system RV32I (traps, MMIO)', systemCpu(LOOP)],
];

const row = (label: string, value: string) => console.log(`${label.padEnd(48)} ${value}`);

/** Engine alone: full clock cycles per second over `ms` of wall time. */
function engineRate(sim: Sim, ms: number): number {
  sim.setInput('clk', 0);
  sim.settle();
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    sim.setInput('clk', 1);
    sim.settle();
    sim.setInput('clk', 0);
    sim.settle();
    n++;
  }
  return (n * 1000) / (performance.now() - t0);
}

if (dump) mkdirSync(dump, { recursive: true });
for (const [name, def] of CPUS) {
  const r = remixDef(emptyWorkspace(), def);
  if ('error' in r) throw new Error(r.error);
  const lib = new UserLibrary(r.ws);
  const es = new EditorSim({ debounceMs: 0 });
  const tb = performance.now();
  es.update(lib.compiled(r.id)!, r.ws.chips[r.id].pins);
  const build = performance.now() - tb;
  const sim = es.sim!;
  es.mode = 'cycle';
  es.hz = Infinity;
  const c0 = es.cycles, e0 = sim.evaluations;
  const t0 = performance.now();
  while (performance.now() - t0 < 2000) es.advance(1 / 60, 50);
  const dt = performance.now() - t0, cycles = es.cycles - c0;
  console.log(`\n${name}: ${sim.design.leaves.length} leaves, ${sim.design.netCount} nets (rebuild ${build.toFixed(0)} ms)`);
  row('  EditorSim cycle mode, max rate', `${((cycles * 1000) / dt).toFixed(0)} cycles/s (${((sim.evaluations - e0) / cycles).toFixed(0)} evaluations/cycle)`);
  if (withRef) {
    const d = flatten(def);
    row('  engine alone: GateSim', `${engineRate(new GateSim(d), 1500).toFixed(0)} cycles/s`);
    row('  engine alone: reference GateSim (before)', `${engineRate(new RefGateSim(d), 1500).toFixed(0)} cycles/s`);
  }
  if (dump) {
    const file = `${dump}/${name.split(' ')[0]}.json`;
    writeFileSync(file, JSON.stringify({ id: r.id, ws: r.ws satisfies Workspace }));
    row('  workspace', file);
  }
}

// The 64-bit Kogge–Stone adder: no clock, random operands, settled after each change.
const ks = docFromDef(resolveComponent('ks64')!) as ChipDoc;
const kc = compileChip(ks, (ref) => partDef(ref, () => undefined));
const es = new EditorSim({ debounceMs: 0 });
es.update(kc, ks.pins);
const pa = ks.pins.find((p) => p.name === 'a')!, pb = ks.pins.find((p) => p.name === 'b')!;
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const word = () => `0x${Array.from({ length: 16 }, () => Math.floor(rnd() * 16).toString(16)).join('')}`;
let n = 0;
const t0 = performance.now();
while (performance.now() - t0 < 1500) {
  es.setInput(pa, word());
  es.setInput(pb, word());
  n++;
}
console.log(`\nks64 adder: ${es.sim!.design.leaves.length} leaves`);
row('  operand changes settled', `${((n * 1000) / (performance.now() - t0)).toFixed(0)} /s`);
if (withRef) {
  const d = flatten(resolveComponent('ks64')!);
  for (const [label, sim] of [['GateSim', new GateSim(d)], ['reference GateSim (before)', new RefGateSim(d)]] as const) {
    let k = 0;
    const t1 = performance.now();
    while (performance.now() - t1 < 1000) {
      sim.setInputBits('a', Array.from({ length: 64 }, () => (rnd() < 0.5 ? 1 : 0)));
      sim.setInputBits('b', Array.from({ length: 64 }, () => (rnd() < 0.5 ? 1 : 0)));
      sim.settle();
      k++;
    }
    row(`  engine alone: ${label}`, `${((k * 1000) / (performance.now() - t1)).toFixed(0)} additions/s`);
  }
}
