// Golden model of the warp cores (chapters 28–29): W warps of n lanes over one data memory. Each warp
// is a SimtISS of its own (its PC, mask, stack and every lane's registers); which warp runs next is
// the hardware's choice (its scheduler), so the model steps the warp the hardware issued. Warp 0 runs
// from reset; wspawn rs1, rs2 (run by any warp) starts warps 1 … rs1 − 1 at the leader's rs2, with
// every lane active. tid = warp · n + lane; nwarps reads W.
//
// Chapter 29's cores add a shared memory (smemWords > 0, at SHARED_BASE) and bar rs1, rs2: the warp
// waits at barrier rs1 until rs2 warps (itself included) have arrived; the last arrival releases them
// all and carries on. The hardware has one barrier, so warps waiting at two ids at once is an error.
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
  /** Initial data memory (the kernel's input). */
  data?: ArrayLike<number>;
  /** Shared memory words (a power of two; 0: none). */
  smemWords?: number;
  /** The lanes multiply (mul). */
  mul?: boolean;
}

export class WarpISS {
  readonly W: number;
  readonly n: number;
  readonly dmem: Uint32Array;
  readonly smem: Uint32Array;
  readonly warps: SimtISS[];
  /** Started (warp 0 at reset, the others by wspawn). */
  active: boolean[];
  /** Waiting at the barrier. */
  waiting: boolean[];
  /** The barrier id the waiting warps wait at. */
  barId = 0;
  retired = 0;
  activeLaneSteps = 0;

  constructor(program: number[], opts: WarpsOptions = {}) {
    this.W = opts.warps ?? 4;
    this.n = opts.lanes ?? 4;
    this.dmem = new Uint32Array(opts.dmemWords ?? 64);
    this.smem = new Uint32Array(opts.smemWords ?? 0);
    if (opts.data) this.dmem.set(Array.from(opts.data, (v) => v >>> 0).slice(0, this.dmem.length));
    const smem = this.smem.length ? this.smem : undefined;
    this.warps = Array.from({ length: this.W }, (_, w) => new SimtISS(program, { lanes: this.n, warp: w, warps: this.W, dmem: this.dmem, smem, mul: opts.mul, imemWords: opts.imemWords }));
    this.active = this.warps.map((_, w) => w === 0);
    this.waiting = this.warps.map(() => false);
  }

  /** A dispatch (chapter 31's command unit, every warp done): warp 0 starts again at PC 0 with every lane active. */
  launch(): void {
    const w = this.warps[0];
    w.pc = 0;
    w.mask = 2 ** this.n - 1;
    w.stack = [];
    w.halted = false;
    this.active[0] = true;
  }

  /** Started and not finished (it may be waiting at the barrier). */
  alive(w: number): boolean {
    return this.active[w] && !this.warps[w].halted;
  }

  /** May warp w issue (alive, not waiting at the barrier)? */
  runnable(w: number): boolean {
    return this.alive(w) && !this.waiting[w];
  }

  /** Every started warp has finished. */
  get halted(): boolean {
    return this.warps.every((_, w) => !this.alive(w));
  }

  /** Some warp waits at the barrier and none can issue: the barrier counts more warps than will come. */
  get deadlocked(): boolean {
    return !this.halted && this.warps.every((_, w) => !this.runnable(w));
  }

  /** Lane-steps that did work over n per instruction, all warps together. */
  get utilization(): number {
    return this.retired ? this.activeLaneSteps / (this.retired * this.n) : 1;
  }

  /** Run one instruction of warp w (the one the scheduler issued). */
  step(w: number): WarpStep {
    if (!this.runnable(w)) throw new Error(`warp ${w} issued, but it ${!this.active[w] ? 'was never started' : this.waiting[w] ? 'waits at the barrier' : 'has finished'}`);
    const m = this.warps[w];
    const d = decode(m.lanes[0].fetch(m.pc));
    const lead = m.leader >= 0 ? m.lanes[m.leader] : null;
    const simt = d.opcode === OPCODES.SIMT && lead;
    const spawn = simt && d.funct3 === 1 ? { count: lead.x[d.rs1], pc: lead.x[d.rs2] } : null;
    const bar = simt && d.funct3 === 4 ? { id: lead.x[d.rs1] >>> 0, count: lead.x[d.rs2] >>> 0 } : null;
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
    if (bar) {
      const arrived = this.waiting.filter(Boolean).length + 1;
      if (arrived > 1 && bar.id !== this.barId) throw new Error(`warp ${w} reached barrier ${bar.id} while others wait at ${this.barId}: the core has one barrier`);
      this.barId = bar.id;
      if (arrived >= bar.count) this.waiting.fill(false);
      else this.waiting[w] = true;
    }
    this.retired++;
    this.activeLaneSteps += s.mask ? popcount(s.mask) : 0;
    return s;
  }
}

const popcount = (m: number) => { let c = 0; for (; m; m &= m - 1) c++; return c; };
