// The golden model of the campaign's lane cores (act 9): a warp of n RV16 lanes sharing one PC,
// the RV32 SimtISS (riscv/simt.ts) on iss16. Each lane is an Iss16 of its own (its registers) over
// one shared data memory. An instruction runs on every active lane, lowest lane first (stores land
// in that order), and the lowest active lane, the leader, decides where the warp goes: a branch on
// which the active lanes disagree follows the leader and is counted as a divergence.
//
//   split rs1   lanes with rs1 ≠ 0 run on; the others wait on the stack (mask, else lanes, the
//               address after the split, pending). A split the active lanes agree on parks nobody.
//   join        the first sends the waiting lanes to that address, the second restores the mask
//   tmc rs1     the mask := the leader's rs1 (its low n bits); 0 ends the warp
//   bar         waits for every warp: with one warp, nothing to wait for
//   csrr rd, tid   each lane reads its thread number, warp · n + lane (CSR 7; 0 on a scalar core)
//
// Lanes have no CSR file and take no traps: any other SYSTEM instruction stops the model with an
// error. Every instruction is one cycle (each lane has a memory port of its own until the
// coalescer). The warp halts on halt (jal x0, 0), a store to EXIT, or tmc with an empty mask.

import { decode16, disasm16, MMIO16 } from './isa16';
import { Iss16, type Iss16State, type Step16 } from './iss16';

export interface Simt16Entry {
  /** Active mask before the split (restored by the last join). */
  mask: number;
  /** Lanes still to run the region (rs1 = 0 at the split). */
  elseMask: number;
  /** Where they resume: the instruction after the split. */
  pc: number;
  /** They have not run yet. */
  pending: boolean;
}

export interface Simt16Options {
  lanes?: number;
  /** Data memory words (default 65536). */
  dmemWords?: number;
  /** Stack entries (nested splits); default 4, as the hardware. */
  depth?: number;
  /** Reading a register a lane never wrote is an error (tests: the hardware powers up unknown). */
  strictInit?: boolean;
  /** Warp number (tid = warp · lanes + lane); one warp until the scheduler. */
  warp?: number;
}

export interface Warp16Step {
  pc: number;
  instr: number;
  /** Active mask the instruction ran with. */
  mask: number;
  /** What each lane did (null: masked off, or a warp instruction: split, join, tmc, bar). */
  lanes: (Step16 | null)[];
  /** Active lanes disagreed on the next PC (a branch without split); the leader's choice was taken. */
  divergent: boolean;
}

export const popcount16 = (m: number) => { let c = 0; for (; m; m &= m - 1) c++; return c; };

export class Simt16 {
  readonly n: number;
  readonly lanes: Iss16[];
  readonly dmem: Uint16Array;
  readonly depth: number;
  readonly warp: number;
  pc = 0;
  mask: number;
  stack: Simt16Entry[] = [];
  halted = false;
  error: string | null = null;
  /** Warp instructions executed (= cycles: one each). */
  steps = 0;
  /** Branches on which the active lanes disagreed (the program forgot a split). */
  divergences = 0;
  /** Lane-steps that did work, over n per instruction: lane utilization. */
  activeLaneSteps = 0;
  /** Words stored to OUT, by every lane, in order. */
  out: number[] = [];
  readonly full: number;

  constructor(program: ArrayLike<number>, opts: Simt16Options = {}, data?: Map<number, number>) {
    this.n = opts.lanes ?? 4;
    this.depth = opts.depth ?? 4;
    this.warp = opts.warp ?? 0;
    this.full = 2 ** this.n - 1;
    this.mask = this.full;
    this.lanes = Array.from({ length: this.n }, () => new Iss16(program, { dmemWords: opts.dmemWords ?? 65536, strictInit: !!opts.strictInit }));
    this.dmem = this.lanes[0].dmem;
    for (const l of this.lanes) l.dmem = this.dmem;
    for (const [a, v] of data ?? []) if (a < this.dmem.length) this.dmem[a] = v & 0xffff;
  }

  /** The lowest active lane (-1: none). */
  get leader(): number {
    return this.mask ? 31 - Math.clz32(this.mask & -this.mask) : -1;
  }

  /** Lane utilization so far (1 = every lane busy on every instruction). */
  get utilization(): number {
    return this.steps ? this.activeLaneSteps / (this.steps * this.n) : 1;
  }

  /** Idle lane-steps as a percentage (100 − utilization), rounded: the kernel puzzles' metric. */
  get idle(): number {
    return Math.round(100 * (1 - this.utilization));
  }

  private on(i: number): boolean {
    return ((this.mask >>> i) & 1) === 1;
  }

  /** One warp instruction. */
  step(): Warp16Step {
    const pc = this.pc, mask = this.mask, lead = this.leader;
    const instr = this.lanes[0].imem[pc] ?? 0;
    const lanes: (Step16 | null)[] = this.lanes.map(() => null);
    const info: Warp16Step = { pc, instr, mask, lanes, divergent: false };
    if (this.halted) return info;
    const d = decode16(instr);
    const s = d.spec;
    let next = (pc + 1) & 0xffff;
    const reg = (i: number, r: number) => {
      const l = this.lanes[i];
      if (l.opts.strictInit && !((l.written >> r) & 1)) throw new Error(`lane ${i}: x${r} read before it was written`);
      return l.x[r];
    };
    const fail = (msg: string) => {
      this.error = msg;
      this.halted = true;
      return info;
    };
    try {
      if (s?.ext === 'simt') {
        switch (s.name) {
          case 'tmc': // the leader's rs1 is the new mask
            this.mask = lead < 0 ? 0 : reg(lead, d.rs1) & this.full;
            break;
          case 'split': {
            let then = 0;
            for (let i = 0; i < this.n; i++) if (this.on(i) && reg(i, d.rs1) !== 0) then |= 1 << i;
            const els = mask & ~then;
            if (this.stack.length >= this.depth) return fail(`split at 0x${pc.toString(16)}: the stack is full (${this.depth} entries)`);
            const pending = then !== 0 && els !== 0;
            this.stack.push({ mask, elseMask: els, pc: next, pending });
            if (pending) this.mask = then;
            break;
          }
          case 'join': {
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
          default: break; // bar: one warp has nobody to wait for
        }
      } else if (s?.fmt === 'CSR' && d.csr === 7) {
        // csrr* on tid: every active lane reads its thread number (writes to it are ignored).
        for (let i = 0; i < this.n; i++) {
          if (!this.on(i)) continue;
          if (d.rs1) reg(i, d.rs1);
          const l = this.lanes[i], v = (this.warp * this.n + i) & 0xffff;
          const st: Step16 = { pc, instr };
          if (d.rd) {
            l.x[d.rd] = v;
            l.written |= 1 << d.rd;
            st.reg = { rd: d.rd, value: v };
          }
          lanes[i] = st;
        }
      } else if (s?.ext === 'system') {
        return fail(`"${disasm16(instr, pc)}" at 0x${pc.toString(16)}: a lane core has no CSRs or traps (only csrr rd, tid)`);
      } else {
        let leadNext = next;
        const nexts: number[] = [];
        for (let i = 0; i < this.n; i++) {
          if (!this.on(i)) continue;
          const l = this.lanes[i];
          l.pc = pc;
          l.halted = false;
          const st = l.step();
          if (l.error) return fail(`lane ${i}: ${l.error}`);
          lanes[i] = st;
          if (st.store?.addr === MMIO16.OUT) this.out.push(st.store.value);
          if (st.store?.addr === MMIO16.EXIT) this.halted = true;
          if (i === lead) leadNext = l.pc;
          nexts.push(l.pc);
        }
        next = leadNext;
        info.divergent = nexts.some((p) => p !== next);
        // halt = jal x0, 0 (the leader's: every lane runs the same word)
        if (s?.name === 'jal' && d.imm === 0) this.halted = true;
      }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    if (info.divergent) this.divergences++;
    if (this.mask === 0) this.halted = true;
    this.pc = next;
    this.steps++;
    this.activeLaneSteps += popcount16(mask);
    return info;
  }

  /** Run to a halt or `max` steps; returns the steps executed. */
  run(max = 100000): number {
    const s0 = this.steps;
    while (!this.halted && this.steps - s0 < max) this.step();
    return this.steps - s0;
  }

  save(): Simt16State {
    return {
      pc: this.pc, mask: this.mask, stack: this.stack.map((e) => ({ ...e })), halted: this.halted, error: this.error, steps: this.steps,
      divergences: this.divergences, activeLaneSteps: this.activeLaneSteps, out: [...this.out], dmem: this.dmem.slice(), lanes: this.lanes.map((l) => l.save()),
    };
  }

  restore(v: Simt16State): void {
    Object.assign(this, { pc: v.pc, mask: v.mask, halted: v.halted, error: v.error, steps: v.steps, divergences: v.divergences, activeLaneSteps: v.activeLaneSteps });
    this.stack = v.stack.map((e) => ({ ...e }));
    this.out = [...v.out];
    this.dmem.set(v.dmem);
    this.lanes.forEach((l, i) => {
      l.restore(v.lanes[i]);
      l.dmem = this.dmem;
    });
  }
}

export interface Simt16State {
  pc: number; mask: number; stack: Simt16Entry[]; halted: boolean; error: string | null; steps: number;
  divergences: number; activeLaneSteps: number; out: number[]; dmem: Uint16Array; lanes: Iss16State[];
}
