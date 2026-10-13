// The warp core's timing, cycle for cycle, without its gates: the golden model (warps.ts) plus the
// scheduler's rules, so a widget can sweep warps and latencies at once. tests/warpcore.test.ts
// checks that it predicts the gate-level core's cycle count.
//
//   ready      the warp runs, waits at no barrier, its next instruction uses no pending register,
//              and none of its loads is being written back this cycle (one write port per bank)
//   scheduler  the round-robin arbiter (lib/mpdecode.ts arbiterN): the first ready warp at or after
//              the pointer issues; when two or more were ready, the pointer moves past it
//   loads      a load issued in cycle t is written back at the end of cycle t + L − 1
//
// Chapter 29's core (lsu): a memory instruction serves its lanes in accesses (lib/warpmem.ts
// serveLanes: a line, a set of banks, one lane for amoadd.w), one per cycle, and holds the issue
// port until the last; only then does its warp move on. A shared-memory access reaches the memory
// Ls − 1 cycles later instead of L − 1, so it waits a cycle while a global request issued L − Ls
// cycles earlier would arrive with it. The registers are written back as each access returns; the
// scoreboard clears with the last.

import { hazardSpec } from '../lib/warps';
import { serveLanes } from '../lib/warpmem';
import { decode, OPCODES } from './isa';
import { isShared } from './simt';
import { WarpISS, type WarpsOptions } from './warps';

export interface WarpCycle {
  /** The warp that issued (-1: none was ready). */
  warp: number;
  /** Its instruction's mnemonic. */
  op: string;
  /** Per warp: a load of it is in flight. */
  waiting: boolean[];
  /** Per warp: ready this cycle. */
  ready: boolean[];
  /** lsu: the lanes this cycle's memory access served (0: none, or no access). */
  served: number;
  /** lsu: the instruction finished this cycle (a memory instruction's last access, or any other). */
  done: boolean;
  /** lsu: per warp, waiting at the barrier. */
  atBar: boolean[];
}

export interface WarpTiming {
  cycles: number;
  issued: number;
  trace: WarpCycle[];
  model: WarpISS;
  /** lsu: accesses to global memory (lines) and to shared memory. */
  globalAccesses: number;
  sharedAccesses: number;
  /** lsu: cycles a memory instruction held the issue port past its first. */
  heldCycles: number;
  /** lsu: cycles a shared access waited for its slot. */
  slotWaits: number;
}

export interface TimingOptions extends WarpsOptions {
  latency: number;
  /** Chapter 29's memory system (one port, accesses per line or bank, shared memory, bar, amoadd.w). */
  lsu?: boolean;
  /** Shared memory's latency (lsu; default 2). */
  sharedLatency?: number;
  /** lsu: global memory starts a line access at most every this many cycles (default 1). */
  globalEvery?: number;
  maxCycles?: number;
  keep?: number;
}

/** A memory instruction's lane addresses, from its warp's registers before it runs. */
export function laneAddrs(m: WarpISS, w: number, word: number): number[] {
  const d = decode(word), s = m.warps[w];
  const off = d.opcode === OPCODES.AMO ? 0 : d.imm;
  return s.lanes.map((l) => (l.x[d.rs1] + off) >>> 0);
}

/** Run a program to the end as the warp core would; `keep` cycles of the trace are kept. */
export function warpTiming(words: number[], opts: TimingOptions): WarpTiming {
  const L = opts.latency, W = opts.warps ?? 4, lsu = !!opts.lsu, Ls = opts.sharedLatency ?? 2, B = opts.globalEvery ?? 1;
  if (L < 2) throw new Error('latency: at least 2');
  if (lsu && (Ls < 2 || Ls > L)) throw new Error('shared latency: 2 … L');
  const m = new WarpISS(words, opts);
  const pending = Array<number>(W).fill(0);
  /** Accesses that return: [warp, rd, cycle of their write-back, last]. */
  let inflight: [number, number, number, boolean][] = [];
  /** Cycles in which a global request entered the pipeline (lsu: a shared one may not arrive with it). */
  const globalAt = new Set<number>();
  let held: { warp: number; left: number } | null = null;
  let ptr = 0, c = 0, issued = 0, globalAccesses = 0, sharedAccesses = 0, heldCycles = 0, slotWaits = 0;
  const trace: WarpCycle[] = [];
  const max = opts.maxCycles ?? 100000, keep = opts.keep ?? 0;
  for (; c < max && !m.halted; c++) {
    if (m.deadlocked && !held && inflight.length === 0) throw new Error(`deadlock at cycle ${c}: warps wait at a barrier that counts more warps than reach it`);
    const back = new Set(inflight.filter(([, , t]) => t === c).map(([w]) => w));
    const ready = held
      ? Array.from({ length: W }, (_, w) => w === held!.warp)
      : Array.from({ length: W }, (_, w) => {
        if (!m.runnable(w) || back.has(w)) return false;
        const s = m.warps[w];
        return !hazardSpec(s.lanes[0].fetch(s.pc), pending[w], lsu);
      });
    let warp = -1;
    for (let k = 0; k < W && warp < 0; k++) if (ready[(ptr + k) % W]) warp = (ptr + k) % W;
    let op = '', served = 0, done = false;
    if (warp >= 0) {
      if (ready.filter(Boolean).length > 1) ptr = (warp + 1) % W;
      const s = m.warps[warp];
      const word = s.lanes[0].fetch(s.pc);
      const d = decode(word);
      op = d.spec?.name ?? '?';
      const amo = lsu && d.opcode === OPCODES.AMO;
      const returns = (d.opcode === OPCODES.LOAD || amo) && d.rd !== 0;
      if (lsu && (d.opcode === OPCODES.LOAD || d.opcode === OPCODES.STORE || amo)) {
        if (held) heldCycles++;
        const unserved: number = held ? held.left : s.mask;
        const addrs = laneAddrs(m, warp, word);
        const lead = 31 - Math.clz32(unserved & -unserved);
        const shared = isShared(addrs[lead]);
        let blocked = shared && Ls < L && globalAt.has(c - (L - Ls));
        for (let j = 1; j < B && !shared; j++) if (globalAt.has(c - j)) blocked = true;
        if (blocked) slotWaits++;
        served = blocked ? 0 : serveLanes(unserved, addrs, amo);
        if (returns) pending[warp] |= 1 << d.rd;
        const left: number = unserved & ~served;
        done = left === 0;
        if (served) {
          if (shared) sharedAccesses++;
          else {
            globalAccesses++;
            // a request occupies its slot when it does something at the memory (a load to x0 does not)
            if (returns || amo || d.opcode === OPCODES.STORE) globalAt.add(c);
          }
          if (returns) inflight.push([warp, d.rd, c + (shared ? Ls : L) - 1, done]);
        }
        held = done ? null : { warp, left };
      } else {
        done = true;
        if (d.opcode === OPCODES.LOAD && d.rd) {
          pending[warp] |= 1 << d.rd;
          inflight.push([warp, d.rd, c + L - 1, true]);
        }
      }
      if (done) { m.step(warp); issued++; }
    }
    if (trace.length < keep) {
      trace.push({ warp, op, ready, served, done,
        waiting: Array.from({ length: W }, (_, w) => inflight.some(([v, , t]) => v === w && t >= c)),
        atBar: m.waiting.slice() });
    }
    // write-backs at the end of this cycle; the last access of a load clears its register's pending bit
    for (const [w, rd, t, last] of inflight) if (t === c && last) pending[w] &= ~(1 << rd);
    inflight = inflight.filter(([, , t]) => t > c);
  }
  return { cycles: c, issued, trace, model: m, globalAccesses, sharedAccesses, heldCycles, slotWaits };
}
