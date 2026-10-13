// Golden model of the warp cores (chapter 28): W warps of n lanes over one data memory. Each warp is
// a SimtISS of its own (its PC, mask, stack and every lane's registers); which warp runs next is the
// hardware's choice (its scheduler), so the model steps the warp the hardware issued. Warp 0 runs
// from reset; wspawn rs1, rs2 (run by any warp) starts warps 1 … rs1 − 1 at the leader's rs2, with
// every lane active. tid = warp · n + lane; nwarps reads W.
//
// The model is functional: a load reads memory when the warp issues it, while the hardware reads it
// L cycles later. The two agree on programs in which warps share no data between a write and a read
// except across a barrier (the programming model): a warp's own accesses stay in order in both.

import { decode, OPCODES } from './isa';
import { SimtISS, type WarpStep } from './simt';

export interface WarpsOptions {
  warps?: number;
  lanes?: number;
  dmemWords?: number;
  imemWords?: number;
}

export class WarpISS {
  readonly W: number;
  readonly n: number;
  readonly dmem: Uint32Array;
  readonly warps: SimtISS[];
  /** Started (warp 0 at reset, the others by wspawn). */
  active: boolean[];
  retired = 0;
  activeLaneSteps = 0;

  constructor(program: number[], opts: WarpsOptions = {}) {
    this.W = opts.warps ?? 4;
    this.n = opts.lanes ?? 4;
    this.dmem = new Uint32Array(opts.dmemWords ?? 64);
    this.warps = Array.from({ length: this.W }, (_, w) => new SimtISS(program, { lanes: this.n, warp: w, warps: this.W, dmem: this.dmem, imemWords: opts.imemWords }));
    this.active = this.warps.map((_, w) => w === 0);
  }

  /** May warp w run (started, not finished)? */
  runnable(w: number): boolean {
    return this.active[w] && !this.warps[w].halted;
  }

  /** Every started warp has finished. */
  get halted(): boolean {
    return this.warps.every((_, w) => !this.runnable(w));
  }

  /** Lane-steps that did work over n per instruction, all warps together. */
  get utilization(): number {
    return this.retired ? this.activeLaneSteps / (this.retired * this.n) : 1;
  }

  /** Run one instruction of warp w (the one the scheduler issued). */
  step(w: number): WarpStep {
    if (!this.runnable(w)) throw new Error(`warp ${w} issued, but it ${this.active[w] ? 'has finished' : 'was never started'}`);
    const m = this.warps[w];
    const d = decode(m.lanes[0].fetch(m.pc));
    let spawn: { count: number; pc: number } | null = null;
    if (d.opcode === OPCODES.SIMT && d.funct3 === 1 && m.leader >= 0) {
      const l = m.lanes[m.leader];
      spawn = { count: l.x[d.rs1], pc: l.x[d.rs2] };
    }
    const s = m.step();
    if (spawn) {
      for (let k = 1; k < Math.min(spawn.count, this.W); k++) {
        const v = this.warps[k];
        v.pc = spawn.pc >>> 0;
        v.mask = 2 ** this.n - 1;
        v.halted = false;
        for (const l of v.lanes) l.pc = v.pc;
        this.active[k] = true;
      }
    }
    this.retired++;
    this.activeLaneSteps += s.mask ? popcount(s.mask) : 0;
    return s;
  }
}

const popcount = (m: number) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
