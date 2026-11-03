// Cycles per Python line on the gate-level pipelined CPU, read from its own signals at every rising edge (no
// model of the pipeline: the stage registers' valid bits and pcs, the hazard unit's stall, the divider's busy).
//
// Every cycle is charged to exactly one place, so the lines add up to the clock:
//  - an instruction in Execute (valid): its line. One cycle is its own ("instr"); a cycle the divider keeps it
//    there is "divide".
//  - Execute holds a bubble: the youngest older instruction still in the pipe (Memory, else Writeback) made it.
//    A load or multiply (its result arrives a stage late, the consumer waited) → "stall"; a branch or jump (the
//    two instructions fetched behind it were squashed) → "flush". The charge goes to that instruction's line.
//  - a bubble with nothing older in flight: the pipeline filling at reset ("fill", the program's frame).
// Counting stops when the halt instruction (jal x0, 0) reaches Writeback.

import { pipeSnap } from '../riscv/cosim';
import type { Sim } from '../sim/sim';
import type { Compiled } from './compile';

export interface LineCost {
  /** Instructions executed (one Execute cycle each). */
  instr: number;
  /** Bubbles behind a load or multiply that its consumer waited out. */
  stall: number;
  /** Bubbles behind a taken branch or jump. */
  flush: number;
  /** Extra Execute cycles of a divide. */
  divide: number;
}

export const lineTotal = (c: LineCost) => c.instr + c.stall + c.flush + c.divide;
const zero = (): LineCost => ({ instr: 0, stall: 0, flush: 0, divide: 0 });

export class PipeProfile {
  /** Python line → cost; key 0: the frame (prologue, the halt loop, runtime-free setup). */
  readonly lines = new Map<number, LineCost>();
  /** Cycles with nothing in flight yet (reset). */
  fill = 0;
  cycles = 0;
  finished = false;
  /** The line charged by the last sample (0 the frame). */
  last = 0;

  constructor(private readonly c: Compiled, private readonly haltPc: number) {}

  reset(): void { this.lines.clear(); this.fill = 0; this.cycles = 0; this.finished = false; this.last = 0; }

  save(): { lines: [number, LineCost][]; fill: number; cycles: number; finished: boolean; last: number } {
    return { lines: [...this.lines].map(([k, v]) => [k, { ...v }]), fill: this.fill, cycles: this.cycles, finished: this.finished, last: this.last };
  }
  restore(s: ReturnType<PipeProfile['save']>): void {
    this.lines.clear();
    s.lines.forEach(([k, v]) => this.lines.set(k, { ...v }));
    ({ fill: this.fill, cycles: this.cycles, finished: this.finished, last: this.last } = s);
  }

  cost(line: number): LineCost { return this.lines.get(line) ?? zero(); }
  /** Everything charged to Python lines (not the frame). */
  total(): LineCost {
    const t = zero();
    for (const [k, v] of this.lines) if (k > 0) { t.instr += v.instr; t.stall += v.stall; t.flush += v.flush; t.divide += v.divide; }
    return t;
  }

  /** Charge the cycle about to end (call before the rising edge). */
  sample(sim: Sim): void {
    if (this.finished) return;
    const snap = pipeSnap(sim, sim.design.root, this.cycles);
    if (!snap) return;
    this.cycles++;
    const [, , E, M, W] = snap.slots;
    const word = (pc: number) => this.c.words[pc >>> 2] ?? 0x13;
    const lineOf = (pc: number) => this.c.pyOfPc(pc) ?? 0;
    const bump = (line: number, k: keyof LineCost) => {
      let v = this.lines.get(line);
      if (!v) this.lines.set(line, (v = zero()));
      v[k]++;
      this.last = line;
    };
    if (W.valid && W.pc === this.haltPc) this.finished = true;
    if (E.valid) {
      const div = sim.design.root.children?.get('dive')?.ports.stall;
      bump(lineOf(E.pc), div && sim.getBits(div)[0] === 1 ? 'divide' : 'instr');
      return;
    }
    const older = M.valid ? M : W.valid ? W : null;
    if (!older) { this.fill++; return; }
    const op = word(older.pc) & 0x7f;
    bump(lineOf(older.pc), op === 0x63 || op === 0x6f || op === 0x67 ? 'flush' : 'stall');
  }
}
