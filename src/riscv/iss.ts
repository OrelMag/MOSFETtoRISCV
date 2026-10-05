// Instruction-set simulator: the golden model. It executes RV32I exactly as the
// specification says, with the same memory organisation as our CPU (separate instruction
// and data memories; the data memory wraps around its size), so the gate-level processor
// can be checked against it cycle by cycle.

import { decode, disasm, OPCODES } from './isa';

export interface IssOptions {
  /** Data memory size in 32-bit words (power of two). */
  dmemWords?: number;
}

export interface StepInfo {
  pc: number;
  word: number;
  text: string;
  /** Register written (0 = none). */
  rd: number;
  value?: number;
  store?: { addr: number; value: number };
  halted: boolean;
}

export class ISS {
  readonly x = new Uint32Array(32);
  pc = 0;
  readonly imem: number[];
  readonly dmem: Uint32Array;
  halted = false;
  steps = 0;

  constructor(program: number[], opts: IssOptions = {}) {
    this.imem = program.slice();
    this.dmem = new Uint32Array(opts.dmemWords ?? 32);
  }

  fetch(pc: number): number {
    return this.imem[(pc >>> 2) % 64] ?? 0x00000013;
  }

  private wordIndex(addr: number): number {
    return (addr >>> 2) & (this.dmem.length - 1);
  }

  load(addr: number, f3: number): number {
    const w = this.dmem[this.wordIndex(addr)];
    const sh = (addr & 3) * 8;
    switch (f3) {
      case 0: return ((w >>> sh) << 24) >> 24;
      case 1: return ((w >>> (addr & 2) * 8) << 16) >> 16;
      case 4: return (w >>> sh) & 0xff;
      case 5: return (w >>> (addr & 2) * 8) & 0xffff;
      default: return w | 0;
    }
  }

  store(addr: number, f3: number, v: number): void {
    const i = this.wordIndex(addr);
    if (f3 === 2) this.dmem[i] = v >>> 0;
    else {
      const bytes = f3 === 0 ? 1 : 2;
      const sh = (addr & (f3 === 0 ? 3 : 2)) * 8;
      const m = ((2 ** (bytes * 8) - 1) << sh) >>> 0;
      this.dmem[i] = ((this.dmem[i] & ~m) | ((v << sh) & m)) >>> 0;
    }
  }

  step(): StepInfo {
    const pc = this.pc;
    const word = this.fetch(pc);
    const d = decode(word);
    const x = this.x;
    const a = x[d.rs1] | 0, b = x[d.rs2] | 0, ua = x[d.rs1], ub = x[d.rs2];
    let next = (pc + 4) >>> 0;
    let rd = 0, value: number | undefined, store: StepInfo['store'];
    const write = (v: number) => {
      rd = d.rd;
      value = v >>> 0;
    };
    switch (d.opcode) {
      case OPCODES.LUI: write(d.imm); break;
      case OPCODES.AUIPC: write(pc + d.imm); break;
      case OPCODES.JAL: write(pc + 4); next = (pc + d.imm) >>> 0; break;
      case OPCODES.JALR: write(pc + 4); next = ((a + d.imm) & ~1) >>> 0; break;
      case OPCODES.BRANCH: {
        const take = [a === b, a !== b, false, false, a < b, a >= b, ua < ub, ua >= ub][d.funct3];
        if (take) next = (pc + d.imm) >>> 0;
        break;
      }
      case OPCODES.LOAD: write(this.load((a + d.imm) >>> 0, d.funct3)); break;
      case OPCODES.STORE: {
        const addr = (a + d.imm) >>> 0;
        this.store(addr, d.funct3, b);
        store = { addr, value: b >>> 0 };
        break;
      }
      case OPCODES.OPIMM:
      case OPCODES.OP: {
        const imm = d.opcode === OPCODES.OPIMM;
        const bb = imm ? d.imm : b;
        const ubb = imm ? d.imm >>> 0 : ub;
        const sh = bb & 31;
        const alt = d.opcode === OPCODES.OP ? d.funct7 === 0x20 : d.funct3 === 5 && (d.funct7 & 0x20) !== 0;
        let r: number;
        switch (d.funct3) {
          case 0: r = imm || !alt ? a + bb : a - bb; break;
          case 1: r = a << sh; break;
          case 2: r = a < bb ? 1 : 0; break;
          case 3: r = ua < ubb ? 1 : 0; break;
          case 4: r = a ^ bb; break;
          case 5: r = alt ? a >> sh : ua >>> sh; break;
          case 6: r = a | bb; break;
          default: r = a & bb;
        }
        write(r);
        break;
      }
      default:
        break; // ecall / ebreak / fence / unknown: no architectural effect here
    }
    if (rd !== 0 && value !== undefined) x[rd] = value;
    else rd = 0;
    // A jump or branch to itself is our "halt".
    this.halted = next === pc;
    this.pc = next;
    this.steps++;
    return { pc, word, text: disasm(word, pc), rd, value, store, halted: this.halted };
  }

  run(maxSteps = 10000): number {
    let n = 0;
    while (!this.halted && n < maxSteps) {
      this.step();
      n++;
    }
    return n;
  }
}
