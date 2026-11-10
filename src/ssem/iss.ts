// The Baby's golden model, one instruction a step, as the replica manual specifies it: CI is incremented just before
// each fetch (so CI holds the line of the last instruction, and a jump's target is one line short), PI = store[CI mod
// 32], then the function acts on the line its digits 0–4 name. The arithmetic is 32-bit two's complement. CMP's skip
// takes effect as CI + 1 here; the hardware holds it in a test flip-flop and adds it at the next increment, so CI + T
// there equals CI here (tests/baby-gates.test.ts).

import { fnOf, lineOf, LINES } from './isa';

export interface SsemStep {
  /** The line the instruction came from, its word, function and operand line. */
  line: number; word: number; f: number; s: number;
  /** CMP found A negative. */
  skip: boolean;
}

export class SsemISS {
  store = new Int32Array(LINES);
  /** The control: the line of the last instruction (32 bits; only digits 0–4 address the store). */
  ci = 0;
  a = 0;
  halted = false;
  /** Instructions executed and store accesses (a fetch, and an operand for every function but CMP and STP). */
  instrs = 0;
  accesses = 0;

  constructor(words: ArrayLike<number> = []) {
    for (let i = 0; i < Math.min(LINES, words.length); i++) this.store[i] = words[i] | 0;
  }

  step(): SsemStep | null {
    if (this.halted) return null;
    this.ci = (this.ci + 1) | 0;
    const line = this.ci & 31, word = this.store[line], f = fnOf(word), s = lineOf(word);
    this.instrs++;
    this.accesses += f === 6 || f === 7 ? 1 : 2;
    let skip = false;
    switch (f) {
      case 0: this.ci = this.store[s]; break;
      case 1: this.ci = (this.ci + this.store[s]) | 0; break;
      case 2: this.a = -this.store[s] | 0; break;
      case 3: this.store[s] = this.a; break;
      case 4: case 5: this.a = (this.a - this.store[s]) | 0; break;
      case 6: if (this.a < 0) { this.ci = (this.ci + 1) | 0; skip = true; } break;
      default: this.halted = true;
    }
    return { line, word, f, s, skip };
  }

  /** Run until STP or `max` instructions; returns instructions executed by this call. */
  run(max = Infinity): number {
    let n = 0;
    while (!this.halted && n < max) { this.step(); n++; }
    return n;
  }

  save(): { store: Int32Array; ci: number; a: number; halted: boolean; instrs: number; accesses: number } {
    return { store: this.store.slice(), ci: this.ci, a: this.a, halted: this.halted, instrs: this.instrs, accesses: this.accesses };
  }
  restore(s: ReturnType<SsemISS['save']>): void {
    this.store = s.store.slice(); this.ci = s.ci; this.a = s.a; this.halted = s.halted; this.instrs = s.instrs; this.accesses = s.accesses;
  }
}
