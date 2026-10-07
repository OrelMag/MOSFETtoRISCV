// The test bench for a learner's RV16 core (docs/CAMPAIGN.md §4). The core's memories are outside
// it: each cycle the bench serves instr = imem[pc] and drdata = dmem[daddr] combinationally (to a
// fixed point), samples the store and register-write ports, then clocks. Every test program runs
// on the golden model first; the core must make the same register writes and stores, in the same
// order, within a cycle budget. Up to 32 programs run at once, one per lane of the bit-parallel
// simulator (one at a time on the event-driven one when the circuit has behavioural leaves).
// No DOM.

import type { ChallengeCheck, CustomRun } from '../editor/challenges';
import { BitSim, LANES } from '../sim/bitsim';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { analyzeTiming } from '../sim/timing';
import { B0, B1, type ComponentDef } from '../sim/types';
import { assemble16 } from '../riscv/rv16/asm16';
import { disasm16, MMIO_BASE, REG_NAMES16 } from '../riscv/rv16/isa16';
import { Iss16 } from '../riscv/rv16/iss16';

export interface CoreTest {
  name: string;
  src: string;
}

export interface CoreSpec {
  tests: () => CoreTest[];
  /** Cycles allowed: cpi × instructions + extra. */
  budget: { cpi: number; extra: number };
  /** Cycles to keep running after the last expected event, to catch extra writes. */
  drain?: number;
  m?: boolean;
  system?: boolean;
}

interface Event { pc: number; instr: number; rd?: number; addr?: number; value: number }

interface Golden {
  name: string;
  imem: Uint16Array;
  dmem: Uint16Array;
  regs: Event[];
  stores: Event[];
  steps: number;
}

const hex = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;
const rname = (r: number) => `${REG_NAMES16[r]} (x${r})`;

/** Run a test on the golden model; throws when the test itself is broken (a bug in the campaign). */
export function golden(t: CoreTest, spec: Pick<CoreSpec, 'm' | 'system'>, maxSteps = 20000): Golden {
  const a = assemble16(t.src);
  if (a.errors.length) throw new Error(`core test ${t.name}: ${a.errors[0].line}: ${a.errors[0].message}`);
  const iss = new Iss16(a.words, { m: spec.m, system: spec.system, strictInit: true }, a.data);
  const regs: Event[] = [], stores: Event[] = [];
  while (!iss.halted && iss.steps < maxSteps) {
    const s = iss.step();
    if (s.reg) regs.push({ pc: s.pc, instr: s.instr, rd: s.reg.rd, value: s.reg.value });
    if (s.store) stores.push({ pc: s.pc, instr: s.instr, addr: s.store.addr, value: s.store.value });
  }
  if (iss.error || !iss.halted) throw new Error(`core test ${t.name}: ${iss.error ?? 'does not halt'}`);
  const imem = new Uint16Array(65536);
  imem.set(a.words);
  const dmem = new Uint16Array(65536);
  for (const [k, v] of a.data) dmem[k] = v;
  return { name: t.name, imem, dmem, regs, stores, steps: iss.steps };
}

/** The two engines behind one face: per-lane inputs and outputs. */
interface Bench {
  lanes: number;
  set(port: string, values: number[]): void;
  get(port: string): number[];
  settle(): void;
}

function bitBench(def: ComponentDef): Bench | null {
  const design = flatten(def, { mode: 'gate' });
  // Behaviours are evaluated on lane 0 only: such a design gets the event-driven bench.
  if (!design.leaves.every((l) => l.kind === 'nand' || (l.kind === 'behavior' && !l.inputs.length))) return null;
  const sim = new BitSim(design);
  return { lanes: LANES, set: (p, v) => sim.setInput(p, v), get: (p) => sim.get(p), settle: () => sim.settle() };
}

function gateBench(def: ComponentDef): Bench {
  const design = flatten(def, { mode: 'gate' });
  const sim = new GateSim(design);
  sim.reset('zero');
  const read = (p: string) => {
    const bits = sim.getBits(design.root.ports[p]);
    return bits.every((b) => b === B0 || b === B1) ? bits.reduce((a: number, b, i) => a + b * 2 ** i, 0) : NaN;
  };
  return {
    lanes: 1,
    set: (p, v) => sim.setInput(p, v[0]),
    get: (p) => [read(p)],
    settle: () => {
      sim.settle();
      if (sim.unstable) throw new Error('the circuit does not settle (it oscillates)');
    },
  };
}

interface Lane {
  g: Golden;
  dmem: Uint16Array;
  ri: number;
  si: number;
  cycles: number;
  /** Cycle the last expected event was seen (-1: not yet). */
  doneAt: number;
  fail?: string;
}

const PORTS_IN = ['clk', 'rst', 'instr', 'drdata'];

/** Run the core on the tests; failures name the test, the event and the instruction. */
export function runCore(def: ComponentDef, mode: 'gate' | 'switch', spec: CoreSpec, engine: 'auto' | 'gate' = 'auto'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: a core must simulate at gate level (no tri-states or floating nets)'], tested: 0 };
  const have = new Set(def.ports.map((p) => p.name));
  const outs = ['pc', 'daddr', 'dwdata', 'dwe', 'rwe', 'rwa', 'rwd'].filter((p) => !have.has(p));
  if (outs.length) return { failures: [`missing pins: ${outs.join(', ')}`], tested: 0 };
  const tests = spec.tests().map((t) => golden(t, spec));
  const bench = engine === 'gate' ? null : bitBench(def);
  const failures: string[] = [];
  let cycles = 0;
  const drain = spec.drain ?? 8;
  const groups: Golden[][] = [];
  const width = bench?.lanes ?? 1;
  for (let i = 0; i < tests.length; i += width) groups.push(tests.slice(i, i + width));
  for (const group of groups) {
    const b = bench && group === groups[0] ? bench : (engine === 'gate' ? null : bitBench(def)) ?? gateBench(def);
    const lanes: Lane[] = group.map((g) => ({ g, dmem: g.dmem.slice(), ri: 0, si: 0, cycles: 0, doneAt: -1 }));
    const n = lanes.length;
    const fill = (v: (l: Lane, k: number) => number) => {
      const arr = lanes.map(v);
      while (arr.length < b.lanes) arr.push(arr[0] ?? 0);
      return arr;
    };
    for (const p of PORTS_IN) b.set(p, fill(() => 0));
    const serve = () => {
      // instr from pc, drdata from daddr, until nothing moves (a single-cycle core: two rounds).
      let lastPc: number[] = [], lastA: number[] = [];
      for (let it = 0; it < 6; it++) {
        b.settle();
        const pc = b.get('pc');
        b.set('instr', fill((l, k) => (Number.isNaN(pc[k]) ? 0 : l.g.imem[pc[k] & 0xffff])));
        b.settle();
        const da = b.get('daddr');
        b.set('drdata', fill((l, k) => {
          const a = da[k];
          return Number.isNaN(a) || a >= MMIO_BASE ? 0 : l.dmem[a];
        }));
        if (pc.slice(0, n).every((v, k) => v === lastPc[k]) && da.slice(0, n).every((v, k) => v === lastA[k])) return;
        lastPc = pc;
        lastA = da;
      }
      b.settle();
    };
    const edge = () => {
      b.set('clk', fill(() => 1));
      b.settle();
      b.set('clk', fill(() => 0));
      b.settle();
    };
    // Reset: one cycle with rst = 1; whatever the core does meanwhile does not count.
    b.set('rst', fill(() => 1));
    serve();
    edge();
    b.set('rst', fill(() => 0));
    const limit = Math.max(...lanes.map((l) => Math.ceil(spec.budget.cpi * l.g.steps + spec.budget.extra)));
    for (let cyc = 1; cyc <= limit + drain; cyc++) {
      serve();
      const dwe = b.get('dwe'), daddr = b.get('daddr'), dwd = b.get('dwdata'), rwe = b.get('rwe'), rwa = b.get('rwa'), rwd = b.get('rwd'), pc = b.get('pc');
      lanes.forEach((l, k) => {
        if (l.fail || (l.doneAt >= 0 && cyc > l.doneAt + drain)) return;
        l.cycles = cyc;
        const at = `cycle ${cyc} (pc ${Number.isNaN(pc[k]) ? 'X' : hex(pc[k])})`;
        const where = (e: Event) => `"${disasm16(e.instr, e.pc)}" @ ${hex(e.pc)}`;
        if (Number.isNaN(rwe[k]) || Number.isNaN(dwe[k])) {
          l.fail = `${l.g.name}: rwe or dwe is X at ${at}`;
          return;
        }
        if (rwe[k] && rwa[k] !== 0) {
          const e = l.g.regs[l.ri];
          if (!e) l.fail = `${l.g.name}: an extra register write ${rname(rwa[k])} ← ${hex(rwd[k])} at ${at}: the program has ended`;
          else if (rwa[k] !== e.rd || rwd[k] !== e.value) {
            l.fail = `${l.g.name}: register write #${l.ri + 1} is ${Number.isNaN(rwa[k]) ? 'X' : rname(rwa[k])} ← ${Number.isNaN(rwd[k]) ? 'X' : hex(rwd[k])} at ${at}; expected ${rname(e.rd!)} ← ${hex(e.value)} from ${where(e)}`;
          } else l.ri++;
        }
        if (!l.fail && dwe[k]) {
          const e = l.g.stores[l.si];
          const a = daddr[k], v = dwd[k];
          if (!e) l.fail = `${l.g.name}: an extra store [${hex(a)}] ← ${hex(v)} at ${at}: the program has ended`;
          else if (a !== e.addr || v !== e.value) {
            l.fail = `${l.g.name}: store #${l.si + 1} is [${Number.isNaN(a) ? 'X' : hex(a)}] ← ${Number.isNaN(v) ? 'X' : hex(v)} at ${at}; expected [${hex(e.addr!)}] ← ${hex(e.value)} from ${where(e)}`;
          } else {
            l.si++;
            if (a < MMIO_BASE) l.dmem[a] = v;
          }
        }
        if (!l.fail && l.doneAt < 0 && l.ri === l.g.regs.length && l.si === l.g.stores.length) l.doneAt = cyc;
      });
      edge();
      if (lanes.every((l) => l.fail || (l.doneAt >= 0 && cyc >= l.doneAt + drain))) break;
    }
    for (const l of lanes) {
      const budget = Math.ceil(spec.budget.cpi * l.g.steps + spec.budget.extra);
      if (!l.fail && l.doneAt < 0) {
        l.fail = `${l.g.name}: after ${budget} cycles only ${l.ri} of ${l.g.regs.length} register writes and ${l.si} of ${l.g.stores.length} stores happened`
          + (l.g.regs[l.ri] ? `; next expected: ${rname(l.g.regs[l.ri].rd!)} ← ${hex(l.g.regs[l.ri].value)} from "${disasm16(l.g.regs[l.ri].instr, l.g.regs[l.ri].pc)}"` : '');
      } else if (!l.fail && l.doneAt > budget) l.fail = `${l.g.name}: correct, but ${l.doneAt} cycles for ${l.g.steps} instructions (budget ${budget})`;
      if (l.fail) failures.push(l.fail);
      cycles += l.doneAt >= 0 ? l.doneAt : l.cycles;
    }
  }
  return { failures: failures.slice(0, 6).concat(failures.length > 6 ? [`… and ${failures.length - 6} more programs fail`] : []), tested: tests.length, cycles };
}

/** Read delay of the bench's memories, in NAND delays (an asynchronous SRAM / ROM read). */
export const MEM_DELAY = 8;

const memLeaf = (id: string, name: string): ComponentDef => ({
  id, name, category: 'memory', ports: [{ name: 'addr', width: 16, dir: 'in' }, { name: 'data', width: 16, dir: 'out' }],
  symbol: { kind: 'box', label: name }, behavior: { eval: () => [0], delay: MEM_DELAY },
});
const IMEM = memLeaf('bench_imem', 'instruction memory'), DMEM = memLeaf('bench_dmem', 'data memory');

/**
 * Clock period of a core with its memories: the core in a bench whose instruction and data
 * memories read in MEM_DELAY, so the path PC → memory → decode → … → register counts.
 */
export function corePeriod(core: ComponentDef): number | null {
  const bench: ComponentDef = {
    id: `bench_${core.id}`, name: 'core bench', category: 'cpu', symbol: { kind: 'box' },
    ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }],
    netlist: () => ({
      instances: [{ name: 'core', def: core }, { name: 'imem', def: IMEM }, { name: 'dmem', def: DMEM }],
      nets: [
        { ends: ['clk', 'core.clk'] }, { ends: ['rst', 'core.rst'] },
        { ends: ['core.pc', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
        { ends: ['core.daddr', 'dmem.addr'] }, { ends: ['dmem.data', 'core.drdata'] },
      ],
    }),
  };
  try {
    return analyzeTiming(flatten(bench, { mode: 'gate' }))?.period ?? null;
  } catch {
    return null;
  }
}

/** A build challenge's check for a core level: the programs, cycles, and the period with memories. */
export function coreCheck(spec: CoreSpec, what: string): ChallengeCheck {
  return {
    kind: 'custom', describe: what,
    run: (def, mode) => {
      const r = runCore(def, mode, spec);
      const p = r.failures.length ? null : corePeriod(def);
      return p === null ? r : { ...r, period: p };
    },
  };
}
