// The test bench for the two-warp core (act 9, k_warps): lanecheck.ts's bench with a synchronous data
// memory. Each cycle the bench serves instr = imem[pc] combinationally (the instruction memory still
// answers at once) and drdata<i> = the word at the address lane i presented in the previous cycle (each
// lane's memory reads at the clock edge). It samples the warp bit and both register write ports: rwe /
// rwa / rwd<i> belong to the warp issuing now, lwe / lwa / lwd<i> (the loads coming back) to the warp
// that issued in the previous cycle; the stores (dwe, daddr<i>, dwdata<i>) belong to the warp issuing
// now and land at the edge, after the reads. Every program runs on the two-warp golden model
// (warps16.ts, warps taking turns, warp 0 first) and each thread (warp, lane) must make the same register
// writes and stores in the same order, within the cycle budget. With raster (k_frame), the core's pixel writes
// (fa, fd, fwe) must be the golden model's, in order (its device draws at once), and land in the screen at FB16.
// No DOM.

import type { CustomRun } from '../editor/challenges';
import { RV16_DREG16 } from '../lib/rv16/logic';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { assemble16 } from '../riscv/rv16/asm16';
import { disasm16, MMIO_BASE, REG_NAMES16 } from '../riscv/rv16/isa16';
import { Warps16 } from '../riscv/rv16/warps16';
import { FB16 } from '../gfx/raster16';
import { bitBench, type CoreCheck, type CoreSpec, type CoreTest, gateBench, memLeaf } from './corecheck';

interface Event { pc: number; instr: number; rd?: number; addr?: number; value: number }

interface WarpGolden {
  name: string;
  imem: Uint16Array;
  dmem: Uint16Array;
  /** Per thread (warp · lanes + lane): its register writes and its stores, in order. */
  regs: Event[][];
  stores: Event[][];
  /** Cycles the golden model took, the warps taking turns. */
  cycles: number;
  /** raster: the screen's writes in order (fa = 32·y + x, fd the colour), and the rasterizer's busy cycles. */
  pixels: { fa: number; fd: number; tri: number }[];
  rasterCycles: number;
}

const hex = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;
const rname = (r: number) => `${REG_NAMES16[r]} (x${r})`;
const each = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
const WARPS = 2;

/** Run a test on the two-warp golden model; throws when the test itself is broken (a bug in the campaign). */
export function warpGolden(t: CoreTest, n = 4, maxCycles = 40000, raster = false): WarpGolden {
  const a = t.words ? { words: t.words, data: t.data ?? new Map<number, number>(), errors: [] } : assemble16(t.src ?? '');
  if (a.errors.length) throw new Error(`warp test ${t.name}: ${a.errors[0].line}: ${a.errors[0].message}`);
  const m = new Warps16(a.words, { lanes: n, warps: WARPS, strictInit: true, raster }, a.data);
  const T = WARPS * n;
  const regs: Event[][] = Array.from({ length: T }, () => []), stores: Event[][] = Array.from({ length: T }, () => []);
  while (!m.halted && m.steps < maxCycles) {
    const { warp, step: s } = m.step();
    s?.lanes.forEach((l, i) => {
      const k = warp * n + i;
      if (l?.reg) regs[k].push({ pc: s.pc, instr: s.instr, rd: l.reg.rd, value: l.reg.value });
      if (l?.store) stores[k].push({ pc: s.pc, instr: s.instr, addr: l.store.addr, value: l.store.value });
    });
  }
  if (m.error || !m.halted) throw new Error(`warp test ${t.name}: ${m.error ?? 'does not halt'}`);
  const imem = new Uint16Array(65536);
  imem.set(a.words);
  const dmem = new Uint16Array(65536);
  for (const [k, v] of a.data) dmem[k] = v;
  const pixels = m.draws.flatMap((d, k) => d.pixels.map((p) => ({ fa: 32 * p.y + p.x, fd: d.col, tri: k })));
  return { name: t.name, imem, dmem, regs, stores, cycles: m.steps, pixels, rasterCycles: m.draws.reduce((c, d) => c + d.cycles + 2, 0) };
}

interface Run {
  g: WarpGolden;
  i: number;
  dmem: Uint16Array;
  /** The words each lane's memory read at the last edge: this cycle's drdata. */
  rdata: number[];
  /** The warp that issued in the previous cycle (-1: none yet): the loads coming back are its. */
  prevWarp: number;
  ri: number[];
  si: number[];
  /** raster: pixel writes seen. */
  pi: number;
  cycles: number;
  doneAt: number;
  fail?: string;
}

const OUTS = (n: number) => ['pc', 'warp', ...each('daddr', n), ...each('dwdata', n), 'dwe', 'rwe', 'rwa', ...each('rwd', n), 'lwe', 'lwa', ...each('lwd', n)];

/** Run a two-warp core on the tests; failures name the test, the warp, the lane, the event and the instruction. */
export function runWarps(def: ComponentDef, mode: 'gate' | 'switch', spec: CoreSpec, engine: 'auto' | 'gate' = 'auto'): CustomRun {
  const n = spec.lanes ?? 4;
  const T = WARPS * n;
  if (mode === 'switch') return { failures: ['switch level: a core must simulate at gate level (no tri-states or floating nets)'], tested: 0 };
  const have = new Set(def.ports.map((p) => p.name));
  const missing = [...OUTS(n), ...(spec.raster ? ['fa', 'fd', 'fwe'] : [])].filter((p) => !have.has(p));
  if (missing.length) return { failures: [`missing pins: ${missing.join(', ')}`], tested: 0 };
  const tests = spec.tests().map((t) => warpGolden(t, n, 40000, !!spec.raster));
  const bench = engine === 'gate' ? null : bitBench(def);
  const failures: string[] = [];
  const failed: number[] = [];
  let cycles = 0;
  const drain = spec.drain ?? 8;
  const width = bench?.lanes ?? 1;
  const indexed = tests.map((g, i) => ({ g, i }));
  const groups: { g: WarpGolden; i: number }[][] = [];
  for (let i = 0; i < tests.length; i += width) groups.push(indexed.slice(i, i + width));
  for (const group of groups) {
    const b = bench && group === groups[0] ? bench : (engine === 'gate' ? null : bitBench(def)) ?? gateBench(def);
    const runs: Run[] = group.map(({ g, i }) => ({ g, i, dmem: g.dmem.slice(), rdata: Array(n).fill(0), prevWarp: -1, ri: Array(T).fill(0), si: Array(T).fill(0), pi: 0, cycles: 0, doneAt: -1 }));
    const m = runs.length;
    const fill = (v: (r: Run, k: number) => number) => {
      const arr = runs.map(v);
      while (arr.length < b.lanes) arr.push(arr[0] ?? 0);
      return arr;
    };
    for (const p of ['clk', 'rst', 'instr', ...each('drdata', n)]) b.set(p, fill(() => 0));
    const serve = () => {
      // drdata is the memories' registered output: fixed for the cycle; only the instruction follows pc
      for (let j = 0; j < n; j++) b.set(`drdata${j}`, fill((r) => r.rdata[j]));
      let last: number[] = [];
      for (let it = 0; it < 4; it++) {
        b.settle();
        const pc = b.get('pc');
        if (pc.slice(0, m).every((x, k) => x === last[k])) return;
        last = pc;
        b.set('instr', fill((r, k) => (Number.isNaN(pc[k]) ? 0 : r.g.imem[pc[k] & 0xffff])));
      }
      b.settle();
    };
    /** The edge: each lane's memory reads its address, then this cycle's stores land. */
    const edge = (stores: [number, number][][]) => {
      const das = Array.from({ length: n }, (_, j) => b.get(`daddr${j}`));
      runs.forEach((r, k) => {
        r.rdata = das.map((da) => (Number.isNaN(da[k]) || da[k] >= MMIO_BASE ? 0 : r.dmem[da[k]]));
        for (const [a, v] of stores[k] ?? []) if (a < MMIO_BASE) r.dmem[a] = v;
      });
      b.set('clk', fill(() => 1));
      b.settle();
      b.set('clk', fill(() => 0));
      b.settle();
    };
    b.set('rst', fill(() => 1));
    serve();
    edge([]);
    runs.forEach((r) => (r.rdata = Array(n).fill(0)));
    b.set('rst', fill(() => 0));
    // a warp that waits for the rasterizer loses its turns: at most every busy cycle, twice
    const budgetOf = (r: Run) => Math.ceil(spec.budget.cpi * r.g.cycles + spec.budget.extra + 2 * r.g.rasterCycles);
    const limit = Math.max(...runs.map((r) => 2 * budgetOf(r)));
    const total = (evs: Event[][]) => evs.reduce((s, e) => s + e.length, 0);
    for (let cyc = 1; cyc <= limit + drain; cyc++) {
      serve();
      const get = (p: string) => b.get(p);
      const warp = get('warp'), dwe = get('dwe'), rwe = get('rwe'), rwa = get('rwa'), lwe = get('lwe'), lwa = get('lwa'), pc = get('pc');
      const daddr = each('daddr', n).map(get), dwd = each('dwdata', n).map(get), rwd = each('rwd', n).map(get), lwd = each('lwd', n).map(get);
      const fwe = spec.raster ? get('fwe') : [], fa = spec.raster ? get('fa') : [], fd = spec.raster ? get('fd') : [];
      const landed: [number, number][][] = runs.map(() => []);
      runs.forEach((r, k) => {
        if (r.fail || (r.doneAt >= 0 && cyc > r.doneAt + drain) || (r.doneAt < 0 && cyc > 2 * budgetOf(r))) return;
        r.cycles = cyc;
        const at = `cycle ${cyc} (pc ${Number.isNaN(pc[k]) ? 'X' : hex(pc[k])})`;
        const where = (e: Event) => `"${disasm16(e.instr, e.pc)}" @ ${hex(e.pc)}`;
        const x = [['warp', warp], ['rwe', rwe], ['dwe', dwe], ['lwe', lwe]].find(([, v]) => Number.isNaN((v as number[])[k]));
        if (x) {
          r.fail = `${r.g.name}: ${x[0]} is X at ${at}`;
          return;
        }
        const w = warp[k];
        const who = (wp: number, j: number) => `warp ${wp}, lane ${j} (tid ${wp * n + j})`;
        /** One register write on a port: the thread's next expected one? */
        const reg = (wp: number, j: number, a: number, v: number, port: string) => {
          const t = wp * n + j, e = r.g.regs[t][r.ri[t]];
          const got = `${Number.isNaN(a) ? 'X' : rname(a)} ← ${Number.isNaN(v) ? 'X' : hex(v)}`;
          if (!e) r.fail = `${r.g.name}: ${who(wp, j)} makes an extra register write ${got} on ${port} at ${at}: it has no more`;
          else if (a !== e.rd || v !== e.value) r.fail = `${r.g.name}: ${who(wp, j)}'s register write #${r.ri[t] + 1} is ${got} on ${port} at ${at}; expected ${rname(e.rd!)} ← ${hex(e.value)} from ${where(e)}`;
          else r.ri[t]++;
        };
        // the loads coming back are older than this cycle's instruction: check them first
        for (let j = 0; j < n && !r.fail; j++) {
          if (!((lwe[k] >> j) & 1) || lwa[k] === 0) continue;
          if (r.prevWarp < 0) r.fail = `${r.g.name}: lwe is ${lwe[k].toString(2).padStart(n, '0')} at ${at}, but no warp issued a load in the cycle before`;
          else reg(r.prevWarp, j, lwa[k], lwd[j][k], 'the load port (lwe)');
        }
        for (let j = 0; j < n && !r.fail; j++) {
          if ((rwe[k] >> j) & 1 && rwa[k] !== 0) reg(w, j, rwa[k], rwd[j][k], 'rwe');
          if (!r.fail && (dwe[k] >> j) & 1) {
            const t = w * n + j, e = r.g.stores[t][r.si[t]], a = daddr[j][k], v = dwd[j][k];
            const got = `[${Number.isNaN(a) ? 'X' : hex(a)}] ← ${Number.isNaN(v) ? 'X' : hex(v)}`;
            if (!e) r.fail = `${r.g.name}: ${who(w, j)} makes an extra store ${got} at ${at}: it has no more`;
            else if (a !== e.addr || v !== e.value) r.fail = `${r.g.name}: ${who(w, j)}'s store #${r.si[t] + 1} is ${got} at ${at}; expected [${hex(e.addr!)}] ← ${hex(e.value)} from ${where(e)}`;
            else {
              r.si[t]++;
              landed[k].push([a, v]); // lowest lane first: a higher lane's store to the same word wins
            }
          }
        }
        // the rasterizer's pixel write: the next one the golden model's device made
        if (!r.fail && spec.raster) {
          if (Number.isNaN(fwe[k])) r.fail = `${r.g.name}: fwe is X at ${at}`;
          else if (fwe[k]) {
            const e = r.g.pixels[r.pi], a = fa[k], v = fd[k];
            const px = (q: number) => (Number.isNaN(q) ? 'X' : `(${q & 31}, ${q >> 5})`);
            const got = `${px(a)} ← ${Number.isNaN(v) ? 'X' : hex(v)}`;
            if (!e) r.fail = `${r.g.name}: an extra pixel write ${got} at ${at}: the triangles drawn so far cover no more`;
            else if (a !== e.fa || v !== e.fd) r.fail = `${r.g.name}: pixel write #${r.pi + 1} is ${got} at ${at}; expected ${px(e.fa)} ← ${hex(e.fd)} (triangle ${e.tri + 1})`;
            else { r.pi++; landed[k].push([FB16 + a, v]); }
          }
        }
        r.prevWarp = w;
        const allDone = r.ri.every((v, t) => v === r.g.regs[t].length) && r.si.every((v, t) => v === r.g.stores[t].length) && r.pi === r.g.pixels.length;
        if (!r.fail && r.doneAt < 0 && allDone) r.doneAt = cyc;
      });
      edge(landed);
      if (runs.every((r) => r.fail || (r.doneAt >= 0 ? cyc >= r.doneAt + drain : cyc >= 2 * budgetOf(r)))) break;
    }
    for (const r of runs) {
      const budget = budgetOf(r);
      if (!r.fail && r.doneAt < 0) {
        const t = r.ri.findIndex((v, k) => v < r.g.regs[k].length), next = t >= 0 ? r.g.regs[t][r.ri[t]] : undefined;
        r.fail = `${r.g.name}: after ${r.cycles} cycles (budget ${budget}) only ${r.ri.reduce((s, v) => s + v, 0)} of ${total(r.g.regs)} register writes and ${r.si.reduce((s, v) => s + v, 0)} of ${total(r.g.stores)} stores happened`
          + (spec.raster ? `, ${r.pi} of ${r.g.pixels.length} pixel writes` : '')
          + (next ? `; next expected in warp ${Math.floor(t / n)}, lane ${t % n}: ${rname(next.rd!)} ← ${hex(next.value)} from "${disasm16(next.instr, next.pc)}"` : '');
      } else if (!r.fail && r.doneAt > budget) r.fail = `${r.g.name}: correct, but ${r.doneAt} cycles where the warps taking turns need ${r.g.cycles} (budget ${budget})`;
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
const DMEMS = Array.from({ length: 4 }, (_, i) => memLeaf(`bench_dmem${i}`, `data memory ${i}`));

/**
 * Clock period of a two-warp core with its memories: the instruction memory reads in MEM_DELAY; each
 * data memory is synchronous, its array read (MEM_DELAY) ending in a register clocked with the core.
 */
export function warpPeriod(core: ComponentDef, n = 4): number | null {
  const bench: ComponentDef = {
    id: `bench_${core.id}`, name: 'two-warp core bench', category: 'cpu', symbol: { kind: 'box' },
    ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }],
    netlist: () => ({
      instances: [{ name: 'core', def: core }, { name: 'imem', def: IMEM },
        ...Array.from({ length: n }, (_, i) => [{ name: `dmem${i}`, def: DMEMS[i] }, { name: `dq${i}`, def: RV16_DREG16 }]).flat()],
      nets: [
        { ends: ['clk', 'core.clk', ...Array.from({ length: n }, (_, i) => `dq${i}.clk`)] }, { ends: ['rst', 'core.rst'] },
        { ends: ['core.pc', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
        ...Array.from({ length: n }, (_, i) => [{ ends: [`core.daddr${i}`, `dmem${i}.addr`] }, { ends: [`dmem${i}.data`, `dq${i}.d`] }, { ends: [`dq${i}.q`, `core.drdata${i}`] }]).flat(),
      ],
    }),
  };
  try {
    return analyzeTiming(flatten(bench, { mode: 'gate' }))?.period ?? null;
  } catch {
    return null;
  }
}

/** The two-warp core level's check: the programs on every thread, cycles, and the period with memories. */
export function warpCheck(spec: CoreSpec, what: string): CoreCheck {
  const s = { lanes: 4, warps: WARPS, ...spec };
  return {
    kind: 'custom', describe: what, core: s,
    run: (def, mode) => {
      const r = runWarps(def, mode, s);
      const p = r.failures.length ? null : warpPeriod(def, s.lanes);
      return p === null ? r : { ...r, period: p };
    },
  };
}
