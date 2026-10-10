// Simulation speed of big sandbox circuits (no DOM): clock cycles per second.
// Run: npx vite-node scripts/sim-perf.ts [--ref] [--dump <dir>]
//
// Each CPU of the chapters is opened in the sandbox (remixDef, as "Open in Sandbox" does) running a
// program that never halts, plus the single-cycle CPU with a 64K × 32 data memory (lib/bigmem.ts).
// EditorSim runs each in cycle mode at "max" for two seconds of wall time with no frame budget (no
// rendering in Node: the ceiling a page can reach), on the cycle engine (DualSim's default in
// cycle mode) and on the event-driven GateSim (gate mode's engine). The 64-bit Kogge–Stone adder
// has no clock: its inputs change and EditorSim settles it.
// --ref also times the engine alone against the original object-based GateSim (tests/ref) on the
// same flat design. --dump writes each CPU's workspace as JSON (localStorage
// `mosfet2riscv:sandbox:v1`, the chip's id) to seed a browser measurement.
//
// Measured 2026-10-10 (Node 22, one core of the dev machine), cycles/s:
//                         before (object GateSim)   GateSim (typed arrays)   cycle engine
//   single-cycle RV32I              91                    1 340                ~7 000
//   pipelined RV32I                 61                    1 080                ~6 000
//   system RV32I                    34                      660                ~4 700
//   ks64, additions/s            2 270                   13 400               ~40 000

import { mkdirSync, writeFileSync } from 'node:fs';
import '../src/lib';
import { compileChip } from '../src/editor/compile';
import { docFromDef } from '../src/editor/fromdef';
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
import { DualSim } from '../src/sim/dualsim';
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

const row = (label: string, value: string) => console.log(`${label.padEnd(48)} ${value}`);

/** A workspace with the CPU remixed, optionally its data memory replaced by a chip around a 64K × 32 RAM. */
function open(def: ComponentDef, bigDmem = false): { ws: Workspace; id: string } {
  const r = remixDef(emptyWorkspace(), def);
  if ('error' in r) throw new Error(r.error);
  if (!bigDmem) return { ws: r.ws, id: r.id };
  const pin = (id: string, dir: 'in' | 'out', at: [number, number], width = 1) => ({ id, name: id, dir, width, at });
  const wire = (id: string, a: string, b: string) => {
    const end = (s: string) => (s.startsWith('pin:') ? { pin: s.slice(4) } : { part: s.split('.')[0], port: s.split('.')[1] });
    return { id, a: end(a), b: end(b), pts: [] };
  };
  const dm: ChipDoc = {
    id: 'u_bigdm', name: 'Big data memory', labels: [],
    pins: [pin('addr', 'in', [0, 2], 32), pin('wd', 'in', [0, 6], 32), pin('we', 'in', [0, 8]), pin('clk', 'in', [0, 10]), pin('rd', 'out', [40, 4], 32)],
    parts: [{ id: 'sa', ref: { split: [2, 16, 14] }, at: [6, 1] }, { id: 'ram', ref: { ram: { k: 16, w: 32 } }, at: [14, 0] }],
    wires: [wire('a', 'pin:addr', 'sa.in'), wire('i', 'sa.o1', 'ram.addr'), wire('d', 'pin:wd', 'ram.din'),
      wire('e', 'pin:we', 'ram.we'), wire('c', 'pin:clk', 'ram.clk'), wire('q', 'ram.dout', 'pin:rd')],
  };
  const cpu = r.ws.chips[r.id];
  const doc: ChipDoc = { ...cpu, parts: cpu.parts.map((p) => (p.id === 'dm' ? { ...p, ref: { chip: dm.id } } : p)) };
  return { ws: { ...r.ws, chips: { ...r.ws.chips, [dm.id]: dm, [r.id]: doc } }, id: r.id };
}

/** EditorSim in cycle mode at max for `ms`: cycles per second, and the engine it ran on. */
function runRate(es: EditorSim, fast: boolean, ms = 2000): { hz: number; engine: string; evals: number } {
  const sim = es.sim as DualSim;
  sim.preferFast = fast;
  es.mode = 'cycle';
  es.hz = Infinity;
  es.advance(1 / 60, 50); // warm up (the cycle engine's set-up, JIT)
  const c0 = es.cycles, e0 = sim.evaluations;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) es.advance(1 / 60, 50);
  const dt = performance.now() - t0, cycles = es.cycles - c0;
  return { hz: (cycles * 1000) / dt, engine: sim.engine, evals: (sim.evaluations - e0) / cycles };
}

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
const CPUS: [string, ComponentDef, boolean][] = [
  ['single-cycle RV32I', singleCycleCpu(LOOP), false],
  ['single-cycle RV32I, 64K × 32 data memory', singleCycleCpu(LOOP), true],
  ['pipelined RV32I', pipelinedCpu(LOOP), false],
  ['system RV32I (traps, MMIO)', systemCpu(LOOP), false],
];
for (const [name, def, big] of CPUS) {
  const { ws, id } = open(def, big);
  const lib = new UserLibrary(ws);
  const es = new EditorSim({ debounceMs: 0 });
  const tb = performance.now();
  es.update(lib.compiled(id)!, ws.chips[id].pins);
  const build = performance.now() - tb;
  const sim = es.sim as DualSim;
  console.log(`\n${name}: ${sim.design.leaves.length} leaves, ${sim.design.netCount} nets (rebuild ${build.toFixed(0)} ms)`);
  const g = runRate(es, false);
  row('  EditorSim cycle mode, max: GateSim', `${g.hz.toFixed(0)} cycles/s (${g.engine}, ${g.evals.toFixed(0)} evaluations/cycle)`);
  const tf = performance.now();
  sim.preferFast = true;
  sim.prepare();
  row('  cycle engine set-up (build, tables, load)', `${(performance.now() - tf).toFixed(0)} ms${sim.whyNot ? ` — ${sim.whyNot}` : ''}`);
  const f = runRate(es, true);
  row('  EditorSim cycle mode, max: cycle engine', `${f.hz.toFixed(0)} cycles/s (${f.engine}, ${f.evals.toFixed(0)} evaluations/cycle)`);
  if (withRef && !big) {
    const d = flatten(def);
    row('  engine alone: reference GateSim (before)', `${engineRate(new RefGateSim(d), 1500).toFixed(0)} cycles/s`);
  }
  if (dump) {
    const file = `${dump}/${name.split(/[ ,]/)[0]}${big ? '-bigmem' : ''}.json`;
    writeFileSync(file, JSON.stringify({ id, ws }));
    row('  workspace', file);
  }
}

// The 64-bit Kogge–Stone adder: no clock, random operands, settled after each change.
const ks = docFromDef(resolveComponent('ks64')!) as ChipDoc;
const kc = compileChip(ks, (ref) => partDef(ref, () => undefined));
console.log('\nks64 adder (no clock)');
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const word = () => `0x${Array.from({ length: 16 }, () => Math.floor(rnd() * 16).toString(16)).join('')}`;
for (const fast of [false, true]) {
  const es = new EditorSim({ debounceMs: 0 });
  es.update(kc, ks.pins);
  (es.sim as DualSim).preferFast = fast;
  const pa = ks.pins.find((p) => p.name === 'a')!, pb = ks.pins.find((p) => p.name === 'b')!;
  for (let i = 0; i < 8; i++) es.setInput(pa, word()); // past the warm-up settles
  let n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 1500) {
    es.setInput(pa, word());
    es.setInput(pb, word());
    n++;
  }
  row(`  operand changes settled: ${es.engine === 'cycle' ? 'cycle engine' : 'GateSim'}`, `${((n * 1000) / (performance.now() - t0)).toFixed(0)} /s`);
}
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
