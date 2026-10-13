// Golden model of the lane cores (the GPU chapters): a warp of n lanes shares one PC. Each lane is
// an ISS of its own (its registers) over one shared data memory. An instruction runs on every
// active lane, lowest lane first (so a store's lanes land in that order, as the hardware's memory
// sequencer serves them), and the lowest active lane, the leader, decides where the warp goes:
// a branch on which the active lanes disagree follows the leader and is counted as a divergence.
//
// split / join keep a stack with one entry per split, the layout the hardware keeps too: the mask
// before the split, the lanes that did not take the first path (else), where they resume (the
// instruction after the split), and whether they are still to run. The first join sends them
// there; the second restores the mask and pops. A split on which the active lanes agree pushes an
// entry with nothing pending, so its join just pops.

import { CSRS, decode, disasm, OPCODES } from './isa';
import { ISS, type ModelState, restoreFields, saveFields, type StepInfo } from './iss';

export interface SimtEntry {
  /** Active mask before the split (restored by the last join). */
  mask: number;
  /** Lanes still to run the region (rs1 = 0 at the split). */
  elseMask: number;
  /** Where they resume: the instruction after the split. */
  pc: number;
  /** They have not run yet. */
  pending: boolean;
}

export interface SimtOptions {
  lanes?: number;
  dmemWords?: number;
  imemWords?: number;
  /** Stack entries (nested splits). */
  depth?: number;
  /** This warp's number (tid = warp · lanes + lane) and how many warps the core holds (CSR nwarps). */
  warp?: number;
  warps?: number;
  /** A data memory shared with other warps (warps.ts); else one of dmemWords. */
  dmem?: Uint32Array;
}

export interface WarpStep {
  pc: number;
  word: number;
  text: string;
  /** Active mask the instruction ran with. */
  mask: number;
  /** What each lane did (null: masked off, or not a per-lane instruction). */
  lanes: (StepInfo | null)[];
  /** Active lanes disagreed on the next PC (a branch without split); the leader's choice was taken. */
  divergent: boolean;
  /** Clock cycles it took on the hardware: a load or store serves one lane per cycle. */
  cycles: number;
  halted: boolean;
}

const SIMT_CSR = new Set([CSRS.lane, CSRS.warp, CSRS.nlanes, CSRS.tid, CSRS.tmask]);

export const popcount = (m: number) => { let c = 0; for (; m; m &= m - 1) c++; return c; };

export class SimtISS {
  readonly n: number;
  readonly lanes: ISS[];
  readonly dmem: Uint32Array;
  readonly depth: number;
  /** Warp number, and the warps the core holds. */
  readonly warp: number;
  readonly warps: number;
  /** nwarps exists on the warp cores only (the lane core of chapters 26–27 does not decode it). */
  private readonly csrs: Set<number>;
  pc = 0;
  mask: number;
  stack: SimtEntry[] = [];
  halted = false;
  cycles = 0;
  retired = 0;
  /** Branches on which the active lanes disagreed (the program forgot a split). */
  divergences = 0;
  /** Lane-steps that did work, over n per instruction: lane utilization. */
  activeLaneSteps = 0;
  private readonly full: number;

  constructor(program: number[], opts: SimtOptions = {}) {
    this.n = opts.lanes ?? 4;
    this.depth = opts.depth ?? 4;
    this.full = 2 ** this.n - 1;
    this.mask = this.full;
    this.warp = opts.warp ?? 0;
    this.warps = opts.warps ?? 1;
    this.csrs = opts.warps === undefined ? SIMT_CSR : new Set([...SIMT_CSR, CSRS.nwarps]);
    const dmemWords = opts.dmem?.length ?? opts.dmemWords ?? 32;
    this.dmem = opts.dmem ?? new Uint32Array(dmemWords);
    this.lanes = Array.from({ length: this.n }, () => {
      const l = new ISS(program, { dmemWords, imemWords: opts.imemWords ?? 64 });
      l.dmem = this.dmem;
      return l;
    });
  }

  /** The lowest active lane (-1: none). */
  get leader(): number {
    return this.mask ? 31 - Math.clz32(this.mask & -this.mask) : -1;
  }

  /** Lane utilization so far (1 = every lane busy on every instruction). */
  get utilization(): number {
    return this.retired ? this.activeLaneSteps / (this.retired * this.n) : 1;
  }

  save(): { self: ModelState; stack: SimtEntry[]; lanes: ModelState[] } {
    return { self: saveFields(this), stack: this.stack.map((e) => ({ ...e })), lanes: this.lanes.map((l) => l.save()) };
  }

  restore(s: { self: ModelState; stack: SimtEntry[]; lanes: ModelState[] }): void {
    restoreFields(this, s.self);
    this.stack = s.stack.map((e) => ({ ...e }));
    this.lanes.forEach((l, i) => l.restore(s.lanes[i]));
    for (const l of this.lanes) l.dmem = this.dmem;
  }

  private on(i: number): boolean {
    return ((this.mask >>> i) & 1) === 1;
  }

  /** One warp instruction. */
  step(): WarpStep {
    const pc = this.pc, mask = this.mask, lead = this.leader;
    const word = this.lanes[0].fetch(pc);
    const d = decode(word);
    const lanes: (StepInfo | null)[] = this.lanes.map(() => null);
    let next = (pc + 4) >>> 0, divergent = false, cycles = 1;
    const reg = (i: number, r: number) => this.lanes[i].x[r];
    const predOf = (r: number) => this.lanes.reduce((p, _, i) => (this.on(i) && reg(i, r) !== 0 ? p | (1 << i) : p), 0);
    const csrA = (word >>> 20) & 0xfff;
    if (d.opcode === OPCODES.SIMT) {
      switch (d.funct3) {
        case 0: // tmc rs1: the leader's rs1 is the new mask
          this.mask = lead < 0 ? 0 : reg(lead, d.rs1) & this.full;
          break;
        case 2: { // split rs1
          const then = predOf(d.rs1), els = mask & ~then;
          if (this.stack.length >= this.depth) throw new Error(`SIMT stack overflow at 0x${pc.toString(16)} (${this.depth} entries)`);
          const pending = then !== 0 && els !== 0;
          this.stack.push({ mask, elseMask: els, pc: next, pending });
          if (pending) this.mask = then;
          break;
        }
        case 3: { // join
          const top = this.stack[this.stack.length - 1];
          if (!top) break;
          if (top.pending) {
            this.mask = top.elseMask;
            next = top.pc;
            top.pending = false;
          } else {
            this.mask = top.mask;
            this.stack.pop();
          }
          break;
        }
        case 5: { // pred rs1, rs2: lanes with rs1 = 0 stop; if none would remain, the leader's rs2 is the mask
          const p = predOf(d.rs1);
          this.mask = p || (lead < 0 ? 0 : reg(lead, d.rs2) & this.full);
          break;
        }
        default: break; // wspawn, bar: one warp has nobody to start or wait for (warps.ts runs them)
      }
    } else if (d.opcode === OPCODES.SYSTEM && d.funct3 === 2 && d.rs1 === 0 && this.csrs.has(csrA)) {
      for (let i = 0; i < this.n; i++) {
        if (!this.on(i)) continue;
        const v = csrA === CSRS.lane ? i : csrA === CSRS.warp ? this.warp : csrA === CSRS.nlanes ? this.n : csrA === CSRS.tid ? this.warp * this.n + i : csrA === CSRS.nwarps ? this.warps : mask;
        if (d.rd !== 0) this.lanes[i].x[d.rd] = v >>> 0;
        lanes[i] = { pc, word, text: disasm(word, pc), rd: d.rd, value: v >>> 0, halted: false };
      }
    } else {
      for (let i = 0; i < this.n; i++) {
        if (!this.on(i)) continue;
        this.lanes[i].pc = pc;
        this.lanes[i].halted = false;
        lanes[i] = this.lanes[i].step();
      }
      if (lead >= 0) {
        next = this.lanes[lead].pc;
        divergent = this.lanes.some((l, i) => this.on(i) && l.pc !== next);
      }
      if (d.opcode === OPCODES.LOAD || d.opcode === OPCODES.STORE || d.opcode === OPCODES.AMO) cycles = Math.max(1, popcount(mask));
    }
    for (const l of this.lanes) l.pc = next;
    if (divergent) this.divergences++;
    this.halted = this.mask === 0 || next === pc;
    this.pc = next;
    this.cycles += cycles;
    this.retired++;
    this.activeLaneSteps += popcount(mask);
    return { pc, word, text: disasm(word, pc), mask, lanes, divergent, cycles, halted: this.halted };
  }

  run(maxSteps = 10000): number {
    let k = 0;
    while (!this.halted && k < maxSteps) { this.step(); k++; }
    return k;
  }
}
