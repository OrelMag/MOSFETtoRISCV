// The test bench for a learner's lane core (act 9): corecheck.ts's bench with four memory ports.
// Each cycle the bench serves instr = imem[pc] and drdata<i> = dmem[daddr<i>] for every lane
// (combinationally, to a fixed point), samples each lane's register write (rwe bit i, rwa, rwd<i>)
// and store (dwe bit i, daddr<i>, dwdata<i>), then clocks. Every program runs on the lane golden
// model (simt16.ts) first; each lane must make the same register writes and stores, in the same
// order, within the cycle budget. Stores of one cycle land lowest lane first, as in the model.
// No DOM.

import type { CustomRun } from '../editor/challenges';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { assemble16 } from '../riscv/rv16/asm16';
import { disasm16, MMIO_BASE, REG_NAMES16 } from '../riscv/rv16/isa16';
import { Simt16 } from '../riscv/rv16/simt16';
import { bitBench, type CoreCheck, type CoreSpec, type CoreTest, gateBench, memLeaf } from './corecheck';

interface Event { pc: number; instr: number; rd?: number; addr?: number; value: number }

interface LaneGolden {
  name: string;
  imem: Uint16Array;
  dmem: Uint16Array;
  /** Per lane: its register writes and its stores, in order. */
  regs: Event[][];
  stores: Event[][];
  steps: number;
}

const hex = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;
const rname = (r: number) => `${REG_NAMES16[r]} (x${r})`;
const each = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);

/** Run a test on the lane golden model; throws when the test itself is broken (a bug in the campaign). */
export function laneGolden(t: CoreTest, n: number, maxSteps = 20000): LaneGolden {
  const a = t.words ? { words: t.words, data: t.data ?? new Map<number, number>(), errors: [] } : assemble16(t.src ?? '');
  if (a.errors.length) throw new Error(`lane test ${t.name}: ${a.errors[0].line}: ${a.errors[0].message}`);
  const w = new Simt16(a.words, { lanes: n, strictInit: true }, a.data);
  const regs: Event[][] = Array.from({ length: n }, () => []), stores: Event[][] = Array.from({ length: n }, () => []);
  while (!w.halted && w.steps < maxSteps) {
    const s = w.step();
    s.lanes.forEach((l, i) => {
      if (l?.reg) regs[i].push({ pc: s.pc, instr: s.instr, rd: l.reg.rd, value: l.reg.value });
      if (l?.store) stores[i].push({ pc: s.pc, instr: s.instr, addr: l.store.addr, value: l.store.value });
    });
  }
  if (w.error || !w.halted) throw new Error(`lane test ${t.name}: ${w.error ?? 'does not halt'}`);
  const imem = new Uint16Array(65536);
  imem.set(a.words);
  const dmem = new Uint16Array(65536);
  for (const [k, v] of a.data) dmem[k] = v;
  return { name: t.name, imem, dmem, regs, stores, steps: w.steps };
}

interface Run {
  g: LaneGolden;
  i: number;
  dmem: Uint16Array;
  ri: number[];
  si: number[];
  cycles: number;
  doneAt: number;
  fail?: string;
}

/** Run a lane core on the tests; failures name the test, the lane, the event and the instruction. */
export function runLanes(def: ComponentDef, mode: 'gate' | 'switch', spec: CoreSpec, engine: 'auto' | 'gate' = 'auto'): CustomRun {
  const n = spec.lanes ?? 4;
  if (mode === 'switch') return { failures: ['switch level: a core must simulate at gate level (no tri-states or floating nets)'], tested: 0 };
  const have = new Set(def.ports.map((p) => p.name));
  const OUTS = ['pc', ...each('daddr', n), ...each('dwdata', n), 'dwe', 'rwe', 'rwa', ...each('rwd', n)];
  const missing = OUTS.filter((p) => !have.has(p));
  if (missing.length) return { failures: [`missing pins: ${missing.join(', ')}`], tested: 0 };
  const tests = spec.tests().map((t) => laneGolden(t, n));
  const bench = engine === 'gate' ? null : bitBench(def);
  const failures: string[] = [];
  const failed: number[] = [];
  let cycles = 0;
  const drain = spec.drain ?? 8;
  const width = bench?.lanes ?? 1;
  const indexed = tests.map((g, i) => ({ g, i }));
  const groups: { g: LaneGolden; i: number }[][] = [];
  for (let i = 0; i < tests.length; i += width) groups.push(indexed.slice(i, i + width));
  for (const group of groups) {
    const b = bench && group === groups[0] ? bench : (engine === 'gate' ? null : bitBench(def)) ?? gateBench(def);
    const runs: Run[] = group.map(({ g, i }) => ({ g, i, dmem: g.dmem.slice(), ri: Array(n).fill(0), si: Array(n).fill(0), cycles: 0, doneAt: -1 }));
    const m = runs.length;
    const fill = (v: (r: Run, k: number) => number) => {
      const arr = runs.map(v);
      while (arr.length < b.lanes) arr.push(arr[0] ?? 0);
      return arr;
    };
    for (const p of ['clk', 'rst', 'instr', ...each('drdata', n)]) b.set(p, fill(() => 0));
    const serve = () => {
      let last: number[][] = [];
      for (let it = 0; it < 6; it++) {
        b.settle();
        const pc = b.get('pc');
        b.set('instr', fill((r, k) => (Number.isNaN(pc[k]) ? 0 : r.g.imem[pc[k] & 0xffff])));
        b.settle();
        const das = Array.from({ length: n }, (_, j) => b.get(`daddr${j}`));
        das.forEach((da, j) => b.set(`drdata${j}`, fill((r, k) => (Number.isNaN(da[k]) || da[k] >= MMIO_BASE ? 0 : r.dmem[da[k]]))));
        const now = [pc, ...das];
        if (now.every((v, j) => v.slice(0, m).every((x, k) => x === last[j]?.[k]))) return;
        last = now;
      }
      b.settle();
    };
    const edge = () => {
      b.set('clk', fill(() => 1));
      b.settle();
      b.set('clk', fill(() => 0));
      b.settle();
    };
    b.set('rst', fill(() => 1));
    serve();
    edge();
    b.set('rst', fill(() => 0));
    const budgetOf = (r: Run) => Math.ceil(spec.budget.cpi * r.g.steps + spec.budget.extra);
    const limit = Math.max(...runs.map((r) => 2 * budgetOf(r)));
    const total = (evs: Event[][]) => evs.reduce((s, e) => s + e.length, 0);
    for (let cyc = 1; cyc <= limit + drain; cyc++) {
      serve();
      const dwe = b.get('dwe'), rwe = b.get('rwe'), rwa = b.get('rwa'), pc = b.get('pc');
      const daddr = each('daddr', n).map((p) => b.get(p)), dwd = each('dwdata', n).map((p) => b.get(p)), rwd = each('rwd', n).map((p) => b.get(p));
      runs.forEach((r, k) => {
        if (r.fail || (r.doneAt >= 0 && cyc > r.doneAt + drain) || (r.doneAt < 0 && cyc > 2 * budgetOf(r))) return;
        r.cycles = cyc;
        const at = `cycle ${cyc} (pc ${Number.isNaN(pc[k]) ? 'X' : hex(pc[k])})`;
        const where = (e: Event) => `"${disasm16(e.instr, e.pc)}" @ ${hex(e.pc)}`;
        if (Number.isNaN(rwe[k]) || Number.isNaN(dwe[k])) {
          r.fail = `${r.g.name}: rwe or dwe is X at ${at}`;
          return;
        }
        const landed: [number, number][] = [];
        for (let j = 0; j < n && !r.fail; j++) {
          const lane = `lane ${j}`;
          if ((rwe[k] >> j) & 1 && rwa[k] !== 0) {
            const e = r.g.regs[j][r.ri[j]], a = rwa[k], v = rwd[j][k];
            if (!e) r.fail = `${r.g.name}: ${lane} makes an extra register write ${Number.isNaN(a) ? 'X' : rname(a)} ← ${Number.isNaN(v) ? 'X' : hex(v)} at ${at}: it has no more`;
            else if (a !== e.rd || v !== e.value) {
              r.fail = `${r.g.name}: ${lane}'s register write #${r.ri[j] + 1} is ${Number.isNaN(a) ? 'X' : rname(a)} ← ${Number.isNaN(v) ? 'X' : hex(v)} at ${at}; expected ${rname(e.rd!)} ← ${hex(e.value)} from ${where(e)}`;
            } else r.ri[j]++;
          }
          if (!r.fail && (dwe[k] >> j) & 1) {
            const e = r.g.stores[j][r.si[j]], a = daddr[j][k], v = dwd[j][k];
            if (!e) r.fail = `${r.g.name}: ${lane} makes an extra store [${Number.isNaN(a) ? 'X' : hex(a)}] ← ${Number.isNaN(v) ? 'X' : hex(v)} at ${at}: it has no more`;
            else if (a !== e.addr || v !== e.value) {
              r.fail = `${r.g.name}: ${lane}'s store #${r.si[j] + 1} is [${Number.isNaN(a) ? 'X' : hex(a)}] ← ${Number.isNaN(v) ? 'X' : hex(v)} at ${at}; expected [${hex(e.addr!)}] ← ${hex(e.value)} from ${where(e)}`;
            } else {
              r.si[j]++;
              landed.push([a, v]);
            }
          }
        }
        // lowest lane first: a higher lane's store to the same word wins
        for (const [a, v] of landed) if (a < MMIO_BASE) r.dmem[a] = v;
        const allDone = r.ri.every((x, j) => x === r.g.regs[j].length) && r.si.every((x, j) => x === r.g.stores[j].length);
        if (!r.fail && r.doneAt < 0 && allDone) r.doneAt = cyc;
      });
      edge();
      if (runs.every((r) => r.fail || (r.doneAt >= 0 ? cyc >= r.doneAt + drain : cyc >= 2 * budgetOf(r)))) break;
    }
    for (const r of runs) {
      const budget = budgetOf(r);
      if (!r.fail && r.doneAt < 0) {
        const j = r.ri.findIndex((x, l) => x < r.g.regs[l].length), next = j >= 0 ? r.g.regs[j][r.ri[j]] : undefined;
        r.fail = `${r.g.name}: after ${r.cycles} cycles (budget ${budget}) only ${r.ri.reduce((s, x) => s + x, 0)} of ${total(r.g.regs)} register writes and ${r.si.reduce((s, x) => s + x, 0)} of ${total(r.g.stores)} stores happened`
          + (next ? `; next expected in lane ${j}: ${rname(next.rd!)} ← ${hex(next.value)} from "${disasm16(next.instr, next.pc)}"` : '');
      } else if (!r.fail && r.doneAt > budget) r.fail = `${r.g.name}: correct, but ${r.doneAt} cycles for ${r.g.steps} warp instructions (budget ${budget})`;
      if (r.fail) {
        failures.push(r.fail);
        failed.push(r.i);
      }
      cycles += r.doneAt >= 0 ? r.doneAt : r.cycles;
    }
  }
  return { failures: failures.slice(0, 6).concat(failures.length > 6 ? [`… and ${failures.length - 6} more programs fail`] : []), tested: tests.length, cycles, failed };
}

const IMEM = memLeaf('bench_imem', 'instruction memory');
const DMEMS = Array.from({ length: 8 }, (_, i) => memLeaf(`bench_dmem${i}`, `data memory ${i}`));

/** Clock period of a lane core with its memories (one instruction memory, a data memory per lane). */
export function lanePeriod(core: ComponentDef, n = 4): number | null {
  const bench: ComponentDef = {
    id: `bench_${core.id}`, name: 'lane core bench', category: 'cpu', symbol: { kind: 'box' },
    ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }],
    netlist: () => ({
      instances: [{ name: 'core', def: core }, { name: 'imem', def: IMEM }, ...Array.from({ length: n }, (_, i) => ({ name: `dmem${i}`, def: DMEMS[i] }))],
      nets: [
        { ends: ['clk', 'core.clk'] }, { ends: ['rst', 'core.rst'] },
        { ends: ['core.pc', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
        ...Array.from({ length: n }, (_, i) => [{ ends: [`core.daddr${i}`, `dmem${i}.addr`] }, { ends: [`dmem${i}.data`, `core.drdata${i}`] }]).flat(),
      ],
    }),
  };
  try {
    return analyzeTiming(flatten(bench, { mode: 'gate' }))?.period ?? null;
  } catch {
    return null;
  }
}

/** A lane core level's check: the programs on every lane, cycles, and the period with memories. */
export function laneCheck(spec: CoreSpec, what: string): CoreCheck {
  const s = { lanes: 4, ...spec };
  return {
    kind: 'custom', describe: what, core: s,
    run: (def, mode) => {
      const r = runLanes(def, mode, s);
      const p = r.failures.length ? null : lanePeriod(def, s.lanes);
      return p === null ? r : { ...r, period: p };
    },
  };
}
