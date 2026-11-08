// The five-stage pipeline's stage occupancy, cycle by cycle, from the golden model and the hazard unit's rules (DOM-free).
// Sources: lib/pipeline.ts hazardUnit's Verilog (lwStall, taken, enPC / enFD, flushFD / flushDE) and buildPipe (pc, FD, DE,
// EM, MW, validF tied to 1); chapter 17's "The load-use stall" and "Control hazards" steps. tests/model-assembly.test.ts
// compares every cycle with the gate-level pipelinedCpu through riscv/cosim.ts pipeSnap, so this is the hardware's
// schedule, not a textbook's.
//
// Not a second pipeline: only the registers' valid bits, PCs and the two hazard conditions. Values never matter here,
// because the golden model already says which way each branch goes.

import { ISS } from './iss';

export interface Item {
  /** Fetch number: unique per fetch, so a loop's refetched PC is a different pallet. */
  seq: number;
  pc: number;
  /** False: a bubble (the pipeline register was cleared). F is always valid, as in the gates. */
  valid: boolean;
}

export interface Cycle {
  /** F (the PC register), D, E, M, W: the snapshot before the cycle's clock edge, as pipeSnap reads it. */
  slots: [Item, Item, Item, Item, Item];
  /** hazard.lwStall: the load in E feeds the instruction in D (PC and IF/ID hold, a bubble goes into ID/EX). */
  stall: boolean;
  /** hazard.taken: a jump or taken branch in E (IF/ID and ID/EX cleared, the PC takes the target). */
  flush: boolean;
  /** The fetch numbers of the wrong-path instructions this flush pulls off the line (those in F and D). */
  pulled: number[];
}

const OPC = { LOAD: 0x03, BRANCH: 0x63, JALR: 0x67, JAL: 0x6f };
/** The raw register fields the comparators see (bits 19:15 and 24:20), whether or not the instruction reads them. */
const rs1Of = (w: number) => (w >>> 15) & 31;
const rs2Of = (w: number) => (w >>> 20) & 31;
const rdOf = (w: number) => (w >>> 7) & 31;

/**
 * The first `n` cycles from power-on. `words` is the program image; the ROM is 2^imemK words, so a fetch past the end reads
 * what the ROM holds there (zero) and wraps.
 */
export function pipeSchedule(words: number[], n: number, imemK = 6): Cycle[] {
  const size = 1 << imemK, rom = (pc: number) => (words[(pc >>> 2) & (size - 1)] ?? 0) >>> 0;
  const iss = new ISS(words);
  const bubble = (seq: number): Item => ({ seq, pc: 0, valid: false });
  let seq = 0;
  let slots: Cycle["slots"] = [{ seq: seq++, pc: 0, valid: true }, bubble(seq++), bubble(seq++), bubble(seq++), bubble(seq++)];
  // Only correct-path instructions reach E (the flush clears D and E), so the golden model steps once per valid E entry.
  const resolved = new Map<number, { taken: boolean; target: number }>();
  const resolve = (e: Item) => {
    let r = resolved.get(e.seq);
    if (!r) {
      const info = iss.step();
      if (info.pc !== e.pc) throw new Error(`pipeSchedule: E holds pc ${e.pc} but the golden model ran ${info.pc}`);
      const op = rom(e.pc) & 0x7f, target = iss.pc;
      // pcSrc != 0 for every jal / jalr, and for a taken branch (a branch to pc + 4 reads as not taken here)
      r = { taken: op === OPC.JAL || op === OPC.JALR || (op === OPC.BRANCH && target !== ((e.pc + 4) >>> 0)), target };
      resolved.set(e.seq, r);
    }
    return r;
  };
  const out: Cycle[] = [];
  for (let t = 0; t < n; t++) {
    const [F, D, E, M] = slots;
    const eWord = rom(E.pc), dWord = D.valid ? rom(D.pc) : 0; // a cleared IF/ID holds zeros
    const stall = E.valid && (eWord & 0x7f) === OPC.LOAD && (rs1Of(dWord) === rdOf(eWord) || rs2Of(dWord) === rdOf(eWord));
    const r = E.valid ? resolve(E) : null;
    const flush = !!r?.taken;
    out.push({ slots, stall, flush, pulled: flush ? [F.seq, ...(D.valid ? [D.seq] : [])] : [] });
    if (flush) slots = [{ seq: seq++, pc: r!.target, valid: true }, bubble(seq++), bubble(seq++), E, M];
    else if (stall) slots = [F, D, bubble(seq++), E, M];
    else slots = [{ seq: seq++, pc: (F.pc + 4) >>> 0, valid: true }, F, D, E, M];
  }
  return out;
}
