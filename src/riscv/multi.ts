// Golden model of the shared-memory multi-core: N harts, one data memory with one port, and the
// same round-robin arbitration as the hardware. Each cycle every hart executes one instruction,
// except harts that need memory and lose arbitration: they stall and retry.

import { decode, OPCODES } from './isa';
import { ISS, type StepInfo } from './iss';

export const isMemOp = (word: number) => {
  const op = decode(word).opcode;
  return op === OPCODES.LOAD || op === OPCODES.STORE || op === OPCODES.AMO;
};

export class MultiISS {
  readonly harts: ISS[];
  readonly dmem: Uint32Array;
  /** Round-robin priority: on a conflict, the hart with priority wins and priority moves on. */
  priority = 0;
  cycles = 0;
  /** What each hart executed in the last cycle (null: stalled). */
  last: (StepInfo | null)[] = [];

  constructor(program: number[], n = 2, dmemWords = 32) {
    this.dmem = new Uint32Array(dmemWords);
    this.harts = Array.from({ length: n }, (_, i) => {
      const h = new ISS(program, { dmemWords, hartid: i });
      h.dmem = this.dmem;
      return h;
    });
  }

  private nextWord(h: ISS): number {
    return h.imem[(h.pc >>> 2) % h.imem.length] ?? 0x13;
  }

  /** Which harts want the memory port this cycle, and which one gets it (-1: none). */
  arbitrate(): { wants: boolean[]; grant: number } {
    const wants = this.harts.map((h) => isMemOp(this.nextWord(h)));
    const n = this.harts.length;
    let grant = -1;
    for (let k = 0; k < n; k++) {
      const i = (this.priority + k) % n;
      if (wants[i]) { grant = i; break; }
    }
    return { wants, grant };
  }

  /** One clock cycle. Returns which harts retired an instruction. */
  step(): boolean[] {
    const { wants, grant } = this.arbitrate();
    this.last = this.harts.map((h, i) => (wants[i] && i !== grant ? null : h.step()));
    const retired = this.last.map((x) => x !== null);
    if (wants.filter(Boolean).length > 1) this.priority = (grant + 1) % this.harts.length;
    this.cycles++;
    return retired;
  }

  get halted(): boolean {
    return this.harts.every((h) => h.halted);
  }
}
