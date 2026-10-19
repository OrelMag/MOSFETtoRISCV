// Instruction-level parallelism from the golden model's traces (chapter 25): what each instruction reads and
// writes, its unit and latency, and the dataflow schedule: every instruction as early as its operands allow, with
// unlimited width, window and prediction. The critical path bounds every machine; N / path is the ceiling in IPC.
// The out-of-order model (ooomodel.ts) classifies instructions with the same table.

import { ISS, type IssOptions } from './iss';
import { decode, disasm, immI, immS } from './isa';

/** Which unit an instruction needs (its port and latency follow from this). */
export type UopClass = 'alu' | 'branch' | 'jal' | 'jalr' | 'lui' | 'load' | 'store' | 'mul' | 'div';

export interface Classified {
  cls: UopClass;
  /** Source registers (x0 left out). */
  srcs: number[];
  /** Destination register (0: none). */
  rd: number;
  /** jal / jalr writing ra or t0: a call (the return-address stack pushes pc + 4). */
  call: boolean;
  /** jalr x0, 0(ra | t0): a return (the return-address stack predicts it). */
  ret: boolean;
}

const link = (r: number) => r === 1 || r === 5;

/** Classify one instruction word (an unknown word is a no-op ALU instruction). */
export function classify(word: number): Classified {
  const d = decode(word);
  const nz = (rs: number[]) => rs.filter((r) => r !== 0);
  const none = { call: false, ret: false };
  switch (d.opcode) {
    case 0x33: return { cls: d.funct7 === 1 ? (d.funct3 >= 4 ? 'div' : 'mul') : 'alu', srcs: nz([d.rs1, d.rs2]), rd: d.rd, ...none };
    case 0x13: return { cls: 'alu', srcs: nz([d.rs1]), rd: d.rd, ...none };
    case 0x03: return { cls: 'load', srcs: nz([d.rs1]), rd: d.rd, ...none };
    case 0x23: return { cls: 'store', srcs: nz([d.rs1, d.rs2]), rd: 0, ...none };
    case 0x63: return { cls: 'branch', srcs: nz([d.rs1, d.rs2]), rd: 0, ...none };
    case 0x6f: return { cls: 'jal', srcs: [], rd: d.rd, call: link(d.rd), ret: false };
    case 0x67: return { cls: 'jalr', srcs: nz([d.rs1]), rd: d.rd, call: link(d.rd), ret: d.rd === 0 && link(d.rs1) && immI(word) === 0 };
    case 0x37: return { cls: 'lui', srcs: [], rd: d.rd, ...none };
    case 0x17: return { cls: 'alu', srcs: [], rd: d.rd, ...none };
    default: return { cls: 'alu', srcs: [], rd: 0, ...none };
  }
}

export interface Latencies { alu: number; load: number; mul: number; div: number }
export const LAT: Latencies = { alu: 1, load: 2, mul: 2, div: 19 };

/** Cycles from issue to result for a class (jal and lui have their value when decoded). */
export function latencyOf(cls: UopClass, lat: Latencies): number {
  return cls === 'load' ? lat.load : cls === 'mul' ? lat.mul : cls === 'div' ? lat.div : cls === 'jal' || cls === 'lui' ? 0 : lat.alu;
}

export interface TraceEntry extends Classified {
  pc: number;
  word: number;
  text: string;
  /** The PC after it. */
  next: number;
  /** Byte address of a load or store. */
  addr?: number;
}

/** The program as the golden model runs it, until it jumps to itself or `max` instructions. */
export function traceOf(words: number[], opts: IssOptions = {}, max = 200_000): TraceEntry[] {
  const iss = new ISS(words, { m: true, ...opts });
  const out: TraceEntry[] = [];
  while (out.length < max) {
    const pc = iss.pc, x = iss.x, word = words[pc >>> 2] ?? 0;
    const c = classify(word);
    const addr = c.cls === 'load' ? (x[(word >>> 15) & 31] + immI(word)) >>> 0 : c.cls === 'store' ? (x[(word >>> 15) & 31] + immS(word)) >>> 0 : undefined;
    iss.step();
    out.push({ pc, word, text: disasm(word, pc), next: iss.pc, addr, ...c });
    if (iss.pc === pc || iss.halted) break;
  }
  return out;
}

export interface Dataflow {
  /** Per instruction: the cycle its result is ready, issuing as soon as its operands are. */
  ready: number[];
  /** Per instruction: the instruction it waited for last (-1: none), so the critical path can be walked back. */
  waitedOn: number[];
  /** Cycles of the longest chain. */
  path: number;
  /** Instructions per cycle at that bound. */
  ipc: number;
}

/**
 * The dataflow limit: each instruction starts once its register operands (and, for a load, the last store to its
 * word) are ready, and takes its latency. Branches are free (perfect prediction); nothing limits width or window.
 */
export function dataflow(trace: TraceEntry[], lat: Latencies = LAT): Dataflow {
  const regAt = new Array<number>(32).fill(0), regBy = new Array<number>(32).fill(-1);
  const memAt = new Map<number, number>(), memBy = new Map<number, number>();
  const ready: number[] = [], waitedOn: number[] = [];
  let path = 0;
  trace.forEach((t, i) => {
    let start = 0, by = -1;
    for (const r of t.srcs) if (regAt[r] > start) { start = regAt[r]; by = regBy[r]; }
    if (t.cls === 'load' && t.addr !== undefined) {
      const w = t.addr >>> 2;
      if ((memAt.get(w) ?? 0) > start) { start = memAt.get(w)!; by = memBy.get(w)!; }
    }
    const done = start + Math.max(1, latencyOf(t.cls, lat));
    ready.push(done);
    waitedOn.push(by);
    if (t.rd) { regAt[t.rd] = done; regBy[t.rd] = i; }
    if (t.cls === 'store' && t.addr !== undefined) { memAt.set(t.addr >>> 2, done); memBy.set(t.addr >>> 2, i); }
    path = Math.max(path, done);
  });
  return { ready, waitedOn, path, ipc: trace.length / Math.max(1, path) };
}

/** The instructions on the longest chain ending at or before `end` (indices, first to last). */
export function criticalPath(df: Dataflow, from = 0, end = df.ready.length): number[] {
  let k = -1, best = -1;
  for (let i = from; i < end; i++) if (df.ready[i] > best) { best = df.ready[i]; k = i; }
  const out: number[] = [];
  while (k >= from) { out.push(k); k = df.waitedOn[k]; }
  return out.reverse();
}
