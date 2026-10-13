// The warp core's timing, cycle for cycle, without its gates: the golden model (warps.ts) plus the
// scheduler's rules, so a widget can sweep warps and latencies at once. tests/warpcore.test.ts
// checks that it predicts the gate-level core's cycle count.
//
//   ready      the warp runs, its next instruction uses no pending register, and none of its
//              loads is being written back this cycle (one write port per register bank)
//   scheduler  the round-robin arbiter (lib/mpdecode.ts arbiterN): the first ready warp at or after
//              the pointer issues; when two or more were ready, the pointer moves past it
//   loads      a load issued in cycle t is written back at the end of cycle t + L − 1

import { hazardSpec } from '../lib/warps';
import { decode, OPCODES } from './isa';
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
}

export interface WarpTiming {
  cycles: number;
  issued: number;
  trace: WarpCycle[];
  model: WarpISS;
}

/** Run a program to the end as the warp core would; `keep` cycles of the trace are kept. */
export function warpTiming(words: number[], opts: WarpsOptions & { latency: number; maxCycles?: number; keep?: number }): WarpTiming {
  const L = opts.latency, W = opts.warps ?? 4;
  if (L < 2) throw new Error('latency: at least 2');
  const m = new WarpISS(words, opts);
  const pending = Array<number>(W).fill(0);
  /** Loads in flight: [warp, rd, cycle of their write-back]. */
  let inflight: [number, number, number][] = [];
  let ptr = 0, c = 0, issued = 0;
  const trace: WarpCycle[] = [];
  const max = opts.maxCycles ?? 100000, keep = opts.keep ?? 0;
  for (; c < max && !m.halted; c++) {
    const back = new Set(inflight.filter(([, , t]) => t === c).map(([w]) => w));
    const ready = Array.from({ length: W }, (_, w) => {
      if (!m.runnable(w) || back.has(w)) return false;
      const s = m.warps[w];
      return !hazardSpec(s.lanes[0].fetch(s.pc), pending[w]);
    });
    let warp = -1;
    for (let k = 0; k < W && warp < 0; k++) if (ready[(ptr + k) % W]) warp = (ptr + k) % W;
    let op = '';
    if (warp >= 0) {
      if (ready.filter(Boolean).length > 1) ptr = (warp + 1) % W;
      const s = m.warps[warp];
      const d = decode(s.lanes[0].fetch(s.pc));
      op = d.spec?.name ?? '?';
      m.step(warp);
      issued++;
      if (d.opcode === OPCODES.LOAD && d.rd) {
        pending[warp] |= 1 << d.rd;
        inflight.push([warp, d.rd, c + L - 1]);
      }
    }
    if (trace.length < keep) trace.push({ warp, op, waiting: Array.from({ length: W }, (_, w) => inflight.some(([v, , t]) => v === w && t >= c)), ready });
    // write-backs at the end of this cycle
    for (const [w, rd, t] of inflight) if (t === c) pending[w] &= ~(1 << rd);
    inflight = inflight.filter(([, , t]) => t > c);
  }
  return { cycles: c, issued, trace, model: m };
}
