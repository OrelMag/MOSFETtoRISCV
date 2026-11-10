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
import type { Custom16Row } from '../riscv/rv16/custom16';
import { disasm16, MMIO16, MMIO_BASE, REG_NAMES16 } from '../riscv/rv16/isa16';
import { Iss16 } from '../riscv/rv16/iss16';

export interface CoreTest {
  name: string;
  /** What a directed test aims at (its first comment line), for the task and failure texts. */
  what?: string;
  /** Assembly, or the words (and data) directly. */
  src?: string;
  words?: number[];
  data?: Map<number, number>;
  /** A program that never halts (a game): only its first this-many instructions are expected; what the core does after is not judged. */
  bounded?: number;
  /** Words read, in order, from IN (0xFFFC), and the switches' value: a campaign program level's test run on a core (owncore.ts). */
  input?: number[];
  switches?: number;
}

export interface CoreSpec {
  tests: () => CoreTest[];
  /** Cycles allowed: cpi × instructions + extra. */
  budget: { cpi: number; extra: number };
  /** Cycles to keep running after the last expected event, to catch extra writes. */
  drain?: number;
  m?: boolean;
  system?: boolean;
  /** A lane core (act 9): this many lanes, each with its memory and register ports (lanecheck.ts). */
  lanes?: number;
  /** Warps taking turns (warpcheck.ts: a data memory one cycle late, a second write port for loads). */
  warps?: number;
  /** k_frame: the core has the rasterizer as a device and writes the screen through fa / fd / fwe. */
  raster?: boolean;
  /** A scalar core that runs all of RV16I (branches, jumps, loads after use): a pass offers Pong on it (campaign/bench.ts addPongBench). */
  rv16i?: boolean;
  /**
   * A pipeline: the first register write after reset must come at this cycle or later (a five-stage core writes from W, a
   * single-cycle core in cycle 1), so a core that does not pipeline cannot pass as one on its period alone.
   */
  minFirstWrite?: number;
  /** The core's own instructions (riscv/rv16/custom16.ts): the tests assemble and the golden model runs them (sandbox cores, tests). */
  custom?: readonly Custom16Row[];
}

interface Event {
  pc: number; instr: number; rd?: number; addr?: number; value: number;
  /** The golden step that made it, the IN reads before that step, and whether the step read IN itself. */
  step: number; inBefore: number; inLoad: boolean;
}

interface Golden {
  name: string;
  imem: Uint16Array;
  dmem: Uint16Array;
  regs: Event[];
  stores: Event[];
  steps: number;
  bounded: boolean;
  input: number[];
  switches: number;
}

const hex = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;
const rname = (r: number) => `${REG_NAMES16[r]} (x${r})`;

/** Run a test on the golden model; throws when the test itself is broken (a bug in the campaign). */
export function golden(t: CoreTest, spec: Pick<CoreSpec, 'm' | 'system' | 'custom'>, maxSteps = 20000, loose = false): Golden {
  const a = t.words ? { words: t.words, data: t.data ?? new Map<number, number>(), errors: [] } : assemble16(t.src ?? '', spec.custom);
  if (a.errors.length) throw new Error(`core test ${t.name}: ${a.errors[0].line}: ${a.errors[0].message}`);
  // loose: a program level's code, run as runPuzzle runs it (no strict initialisation: a program that passes there passes here)
  const iss = new Iss16(a.words, { m: spec.m, system: spec.system, strictInit: !loose, ...(spec.custom?.length ? { custom: spec.custom } : {}) }, a.data);
  const input = [...(t.input ?? [])];
  iss.input = [...input];
  iss.switches = t.switches ?? 0;
  const regs: Event[] = [], stores: Event[] = [];
  while (!iss.halted && iss.steps < (t.bounded ?? maxSteps)) {
    const step = iss.steps, inBefore = input.length - iss.input.length;
    const s = iss.step();
    const inLoad = input.length - iss.input.length > inBefore;
    if (s.reg) regs.push({ pc: s.pc, instr: s.instr, rd: s.reg.rd, value: s.reg.value, step, inBefore, inLoad });
    if (s.store) stores.push({ pc: s.pc, instr: s.instr, addr: s.store.addr, value: s.store.value, step, inBefore, inLoad });
  }
  if (iss.error || (!iss.halted && !t.bounded)) throw new Error(`core test ${t.name}: ${iss.error ?? 'does not halt'}`);
  const imem = new Uint16Array(65536);
  imem.set(a.words);
  const dmem = new Uint16Array(65536);
  for (const [k, v] of a.data) dmem[k] = v;
  return { name: t.name, imem, dmem, regs, stores, steps: iss.steps, bounded: !!t.bounded, input, switches: t.switches ?? 0 };
}

/** The two engines behind one face: per-lane inputs and outputs. */
export interface Bench {
  lanes: number;
  set(port: string, values: number[]): void;
  get(port: string): number[];
  settle(): void;
}

export function bitBench(def: ComponentDef): Bench | null {
  const design = flatten(def, { mode: 'gate' });
  // Behaviours are evaluated on lane 0 only: such a design gets the event-driven bench.
  if (!design.leaves.every((l) => l.kind === 'nand' || (l.kind === 'behavior' && !l.inputs.length))) return null;
  const sim = new BitSim(design);
  return { lanes: LANES, set: (p, v) => sim.setInput(p, v), get: (p) => sim.get(p), settle: () => sim.settle() };
}

export function gateBench(def: ComponentDef): Bench {
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
  /** Index of the test in spec.tests(). */
  i: number;
  dmem: Uint16Array;
  ri: number;
  si: number;
  cycles: number;
  /** Cycle the last expected event was seen (-1: not yet). */
  doneAt: number;
  /** Cycle of the first register write (0: none yet). */
  firstWrite: number;
  /** The interrupt line, raised and lowered by stores to IRQ (0xFFF9). */
  irq: number;
  fail?: string;
  /** The same failure as data (own-core runs). */
  why?: CoreDisagree;
  /** The register writes that matched, in order (Step to it rebuilds the core's registers from them). */
  writes: { rd: number; value: number }[];
}

/** Where a core first parted from the golden model. */
export interface CoreDisagree {
  kind: 'reg' | 'store' | 'extra' | 'x' | 'stuck';
  /** The golden step of the event expected (an index into the model's instructions), its pc and word. */
  step?: number; pc?: number; instr?: number;
  /** What the model did and what the core did, in words ('a1 (x11) ← 0x000a'). */
  expected?: string; got?: string;
  /** A wrong register write as numbers (Step to it shows the register file just after it). */
  wrote?: { rd: number; value: number };
  /** Register writes and stores that agreed before it. */
  agreed: number;
  cycle: number;
}

/** One test's run on a core: its cycles to the last expected event, the model's instructions, the matched writes. */
export interface CoreTestRun {
  name: string; i: number; ok: boolean; cycles: number; steps: number; why?: CoreDisagree; writes: { rd: number; value: number }[];
  /** The model's instructions after its last register write or store (the halt among them): cycles stop at that event. */
  tail: number;
}

export interface RunOptions {
  /** A learner's program on their core (owncore.ts): no cycle budget (a slow core is not wrong) and no pipeline check; a hard cap of cycles instead. */
  own?: { maxCycles: (steps: number) => number };
}

const PORTS_IN = ['clk', 'rst', 'instr', 'drdata'];

/** Run the core on the tests; failures name the test, the event and the instruction. */
export function runCore(def: ComponentDef, mode: 'gate' | 'switch', spec: CoreSpec, engine: 'auto' | 'gate' = 'auto', opts: RunOptions = {}): CustomRun & { perTest?: CoreTestRun[] } {
  if (mode === 'switch') return { failures: ['switch level: a core must simulate at gate level (no tri-states or floating nets)'], tested: 0 };
  const have = new Set(def.ports.map((p) => p.name));
  const outs = ['pc', 'daddr', 'dwdata', 'dwe', 'rwe', 'rwa', 'rwd'].filter((p) => !have.has(p));
  if (outs.length) return { failures: [`missing pins: ${outs.join(', ')}`], tested: 0 };
  const own = opts.own;
  const tests = spec.tests().map((t) => golden(t, spec, 20000, !!own));
  const perTest: CoreTestRun[] = [];
  const bench = engine === 'gate' ? null : bitBench(def);
  const failures: string[] = [];
  const failed: number[] = [];
  let cycles = 0;
  const drain = spec.drain ?? 8;
  const groups: { g: Golden; i: number }[][] = [];
  const width = bench?.lanes ?? 1;
  const indexed = tests.map((g, i) => ({ g, i }));
  for (let i = 0; i < tests.length; i += width) groups.push(indexed.slice(i, i + width));
  for (const group of groups) {
    const b = bench && group === groups[0] ? bench : (engine === 'gate' ? null : bitBench(def)) ?? gateBench(def);
    const lanes: Lane[] = group.map(({ g, i }) => ({ g, i, dmem: g.dmem.slice(), ri: 0, si: 0, cycles: 0, doneAt: -1, firstWrite: 0, irq: 0, writes: [] }));
    const hasIrq = have.has('irq');
    const n = lanes.length;
    const fill = (v: (l: Lane, k: number) => number) => {
      const arr = lanes.map(v);
      while (arr.length < b.lanes) arr.push(arr[0] ?? 0);
      return arr;
    };
    for (const p of [...PORTS_IN, ...(hasIrq ? ['irq'] : [])]) b.set(p, fill(() => 0));
    const serve = () => {
      // instr from pc, drdata from daddr, until nothing moves (a single-cycle core: two rounds).
      let lastPc: number[] = [], lastA: number[] = [];
      for (let it = 0; it < 6; it++) {
        b.settle();
        const pc = b.get('pc');
        b.set('instr', fill((l, k) => (Number.isNaN(pc[k]) ? 0 : l.g.imem[pc[k] & 0xffff])));
        b.settle();
        const da = b.get('daddr');
        b.set('drdata', fill((l, k) => read(l, da[k], inAt(l))));
        if (pc.slice(0, n).every((v, k) => v === lastPc[k]) && da.slice(0, n).every((v, k) => v === lastA[k])) return ins();
        lastPc = pc;
        lastA = da;
      }
      b.settle();
      ins();
    };
    // A read of the bench's memory or its I/O. IN gives the test's words in order, as the golden model's IN does.
    const read = (l: Lane, a: number, k: number) => {
      if (Number.isNaN(a)) return 0;
      if (a < MMIO_BASE) return l.dmem[a];
      if (a === MMIO16.IN) return (l.g.input[k] ?? 0) & 0xffff;
      if (a === MMIO16.SWITCHES) return l.g.switches & 0xffff;
      if (a === MMIO16.IRQ) return l.irq;
      return 0;
    };
    // Which IN word a read now is: the IN reads the golden model made before the oldest event the core still owes. A core
    // whose memory stage sits one instruction behind the stage that writes registers (every campaign core: in-order, at most
    // one register write a cycle) may be reading for the next instruction while it writes an IN load's result: then try
    // the next word, and keep it unless the write itself moves (a single-cycle core, whose write is that read).
    const oldest = (l: Lane): Event | undefined => {
      const r = l.g.regs[l.ri], s = l.g.stores[l.si];
      return !r ? s : !s ? r : r.step <= s.step ? r : s;
    };
    const inAt = (l: Lane) => oldest(l)?.inBefore ?? l.g.input.length;
    const ins = () => {
      if (!lanes.some((l) => l.g.input.length)) return;
      const da = b.get('daddr');
      if (!lanes.some((_, k) => da[k] === MMIO16.IN)) return;
      const rwe = b.get('rwe'), rwa = b.get('rwa'), rwd = b.get('rwd');
      const ahead = lanes.map((l, k) => {
        const e = l.g.regs[l.ri];
        return da[k] === MMIO16.IN && !!e && e === oldest(l) && e.inLoad && rwe[k] === 1 && rwa[k] === e.rd && rwd[k] === e.value;
      });
      if (!ahead.some(Boolean)) return;
      b.set('drdata', fill((l, k) => read(l, da[k], inAt(l) + (ahead[k] ? 1 : 0))));
      b.settle();
      const moved = b.get('rwd').map((v, k) => k < n && ahead[k] && v !== rwd[k]);
      if (!moved.some(Boolean)) return;
      b.set('drdata', fill((l, k) => read(l, da[k], inAt(l) + (ahead[k] && !moved[k] ? 1 : 0))));
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
    // A lane runs on past its budget (to twice it) so a slow core's cycles are counted to the end: the score
    // is the same whichever bench runs the core, and the failure says how many cycles it took.
    const budgetOf = (l: Lane) => (own ? Math.ceil(own.maxCycles(l.g.steps) / 2) : Math.ceil(spec.budget.cpi * l.g.steps + spec.budget.extra));
    const limit = Math.max(...lanes.map((l) => 2 * budgetOf(l)));
    for (let cyc = 1; cyc <= limit + drain; cyc++) {
      if (hasIrq) b.set('irq', fill((l) => l.irq));
      serve();
      const dwe = b.get('dwe'), daddr = b.get('daddr'), dwd = b.get('dwdata'), rwe = b.get('rwe'), rwa = b.get('rwa'), rwd = b.get('rwd'), pc = b.get('pc');
      lanes.forEach((l, k) => {
        if (l.fail || (l.doneAt >= 0 && cyc > l.doneAt + drain) || (l.doneAt < 0 && cyc > 2 * budgetOf(l))) return;
        l.cycles = cyc;
        const at = `cycle ${cyc} (pc ${Number.isNaN(pc[k]) ? 'X' : hex(pc[k])})`;
        const where = (e: Event) => `"${disasm16(e.instr, e.pc)}" @ ${hex(e.pc)}`;
        const agreed = l.ri + l.si;
        const say = (e: Event | undefined) => (e ? { step: e.step, pc: e.pc, instr: e.instr } : {});
        if (Number.isNaN(rwe[k]) || Number.isNaN(dwe[k])) {
          l.fail = `${l.g.name}: rwe or dwe is X at ${at}`;
          l.why = { kind: 'x', ...say(oldest(l)), got: 'rwe or dwe is X', agreed, cycle: cyc };
          return;
        }
        if (rwe[k] && rwa[k] !== 0) {
          const e = l.g.regs[l.ri];
          const got = `${Number.isNaN(rwa[k]) ? 'X' : rname(rwa[k])} ← ${Number.isNaN(rwd[k]) ? 'X' : hex(rwd[k])}`;
          if (!e) {
            if (!l.g.bounded) {
              l.fail = `${l.g.name}: an extra register write ${rname(rwa[k])} ← ${hex(rwd[k])} at ${at}: the program has ended`;
              l.why = { kind: 'extra', got, agreed, cycle: cyc };
            }
          } else if (rwa[k] !== e.rd || rwd[k] !== e.value) {
            l.fail = `${l.g.name}: register write #${l.ri + 1} is ${got} at ${at}; expected ${rname(e.rd!)} ← ${hex(e.value)} from ${where(e)}`;
            l.why = { kind: 'reg', ...say(e), expected: `${rname(e.rd!)} ← ${hex(e.value)}`, got, agreed, cycle: cyc, ...(Number.isNaN(rwa[k]) || Number.isNaN(rwd[k]) ? {} : { wrote: { rd: rwa[k], value: rwd[k] } }) };
          } else {
            l.writes.push({ rd: e.rd!, value: e.value });
            l.ri++;
            if (!l.firstWrite) l.firstWrite = cyc;
          }
        }
        if (!l.fail && dwe[k]) {
          const e = l.g.stores[l.si];
          const a = daddr[k], v = dwd[k];
          const got = `[${Number.isNaN(a) ? 'X' : hex(a)}] ← ${Number.isNaN(v) ? 'X' : hex(v)}`;
          if (!e) {
            if (!l.g.bounded) {
              l.fail = `${l.g.name}: an extra store [${hex(a)}] ← ${hex(v)} at ${at}: the program has ended`;
              l.why = { kind: 'extra', got, agreed, cycle: cyc };
            }
          } else if (a !== e.addr || v !== e.value) {
            l.fail = `${l.g.name}: store #${l.si + 1} is ${got} at ${at}; expected [${hex(e.addr!)}] ← ${hex(e.value)} from ${where(e)}`;
            l.why = { kind: 'store', ...say(e), expected: `[${hex(e.addr!)}] ← ${hex(e.value)}`, got, agreed, cycle: cyc };
          } else {
            l.si++;
            if (a < MMIO_BASE) l.dmem[a] = v;
            if (a === MMIO16.IRQ) l.irq = v & 1;
          }
        }
        if (!l.fail && l.doneAt < 0 && l.ri === l.g.regs.length && l.si === l.g.stores.length) l.doneAt = cyc;
      });
      edge();
      if (lanes.every((l) => l.fail || (l.doneAt >= 0 ? cyc >= l.doneAt + drain : cyc >= 2 * budgetOf(l)))) break;
    }
    for (const l of lanes) {
      const budget = budgetOf(l);
      if (!l.fail && l.doneAt < 0) {
        const o = oldest(l);
        l.why = { kind: 'stuck', ...(o ? { step: o.step, pc: o.pc, instr: o.instr } : {}), agreed: l.ri + l.si, cycle: l.cycles };
        l.fail = `${l.g.name}: after ${l.cycles} cycles (budget ${budget}) only ${l.ri} of ${l.g.regs.length} register writes and ${l.si} of ${l.g.stores.length} stores happened`
          + (l.g.regs[l.ri] ? `; next expected: ${rname(l.g.regs[l.ri].rd!)} ← ${hex(l.g.regs[l.ri].value)} from "${disasm16(l.g.regs[l.ri].instr, l.g.regs[l.ri].pc)}"` : '');
      } else if (!own && !l.fail && l.doneAt > budget) l.fail = `${l.g.name}: correct, but ${l.doneAt} cycles for ${l.g.steps} instructions (budget ${budget})`;
      if (!own && !l.fail && spec.minFirstWrite && l.firstWrite && l.firstWrite < spec.minFirstWrite) {
        l.fail = `${l.g.name}: the first register write came at cycle ${l.firstWrite}: a pipeline writes from W, at cycle ${spec.minFirstWrite} or later`;
      }
      if (l.fail) {
        failures.push(l.fail);
        failed.push(l.i);
      }
      cycles += l.doneAt >= 0 ? l.doneAt : l.cycles;
      const last = Math.max(l.g.regs.at(-1)?.step ?? -1, l.g.stores.at(-1)?.step ?? -1);
      perTest[l.i] = { name: l.g.name, i: l.i, ok: !l.fail, cycles: l.doneAt >= 0 ? l.doneAt : l.cycles, steps: l.g.steps, why: l.why, writes: l.writes, tail: l.g.steps - 1 - last };
    }
  }
  return { failures: failures.slice(0, 6).concat(failures.length > 6 ? [`… and ${failures.length - 6} more programs fail`] : []), tested: tests.length, cycles, failed, perTest };
}

/** Read delay of the bench's memories, in NAND delays (an asynchronous SRAM / ROM read). */
export const MEM_DELAY = 8;

export const memLeaf = (id: string, name: string): ComponentDef => ({
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

/** A core level's check: a custom check that also carries its programs (for "debug this test"). */
export type CoreCheck = ChallengeCheck & { core: CoreSpec };

/** The programs behind a core level's check, or null for any other check. */
export const coreSpecOf = (c: ChallengeCheck): CoreSpec | null => ('core' in c ? (c as CoreCheck).core : null);

/** A build challenge's check for a core level: the programs, cycles, and the period with memories. */
export function coreCheck(spec: CoreSpec, what: string): CoreCheck {
  return {
    kind: 'custom', describe: what, core: spec,
    run: (def, mode) => {
      const r = runCore(def, mode, spec);
      const p = r.failures.length ? null : corePeriod(def);
      return p === null ? r : { ...r, period: p };
    },
  };
}
