// The golden model of RV64I / M (chapter 25's 64-bit core): user-level instructions only, registers as BigInt.
// Memory is organised as the gate-level core's: an instruction ROM of 32-bit words, and a data memory of 64-bit
// doublewords (kept as pairs of 32-bit words, low first, so the riscv-tests data loader fills it as it fills an
// RV32 memory) that wraps around its size. A load or store reaches inside its doubleword only, aligned to its own
// size, as the core's byte lanes do: lh at 4k + 7 reads bytes 6 and 7.

import { decode, disasm, OPCODES } from './isa';
import { restoreFields, saveFields, type ModelState } from './iss';

export interface Iss64Options {
  /** Data memory size in 32-bit words (power of two, at least 2). */
  dmemWords?: number;
  /** Instruction memory size in words (power of two). */
  imemWords?: number;
  /** Implement the M extension (otherwise its encodings do nothing, like any word the model does not know). */
  m?: boolean;
}

export interface StepInfo64 {
  pc: bigint;
  word: number;
  text: string;
  /** Register written (0 = none). */
  rd: number;
  value?: bigint;
  /** Bytes 1, 2, 4 or 8; value is the register's low bytes. */
  store?: { addr: bigint; value: bigint; size: number };
  halted: boolean;
}

const M64 = (1n << 64n) - 1n;
const u64 = (v: bigint) => v & M64;
const s64 = (v: bigint) => BigInt.asIntN(64, v);
/** A 32-bit result sign-extended into 64 bits (the W instructions, lw). */
const sw = (v: bigint) => u64(BigInt.asIntN(32, v));

/** RV64M, exactly as specified (division by zero, overflow); W: the 32-bit operation, its result sign-extended. */
export function mExec64(f3: number, a: bigint, b: bigint, w = false): bigint {
  if (w) {
    const sa = BigInt.asIntN(32, a), sb = BigInt.asIntN(32, b), ua = BigInt.asUintN(32, a), ub = BigInt.asUintN(32, b);
    switch (f3) {
      case 0: return sw(sa * sb);
      case 4: return sb === 0n ? M64 : sa === -(2n ** 31n) && sb === -1n ? sw(sa) : sw(sa / sb);
      case 5: return ub === 0n ? M64 : sw(ua / ub);
      case 6: return sb === 0n ? sw(sa) : sa === -(2n ** 31n) && sb === -1n ? 0n : sw(sa % sb);
      case 7: return ub === 0n ? sw(ua) : sw(ua % ub);
      default: return 0n; // no mulhw
    }
  }
  const sa = s64(a), sb = s64(b), ua = u64(a), ub = u64(b);
  switch (f3) {
    case 0: return u64(sa * sb);
    case 1: return u64((sa * sb) >> 64n);
    case 2: return u64((sa * ub) >> 64n);
    case 3: return u64((ua * ub) >> 64n);
    case 4: return sb === 0n ? M64 : sa === -(2n ** 63n) && sb === -1n ? ua : u64(sa / sb);
    case 5: return ub === 0n ? M64 : ua / ub;
    case 6: return sb === 0n ? ua : sa === -(2n ** 63n) && sb === -1n ? 0n : u64(sa % sb);
    default: return ub === 0n ? ua : ua % ub;
  }
}

/** Bytes a load (funct3 0–6) or store (0–3) moves. */
export const accessSize = (f3: number) => 1 << (f3 & 3);

export class ISS64 {
  readonly x = new BigUint64Array(32);
  pc = 0n;
  readonly imem: number[];
  readonly dmem: Uint32Array;
  readonly m: boolean;
  halted = false;
  steps = 0;
  retired = 0;
  private readonly imemWords: number;

  constructor(program: number[], opts: Iss64Options = {}) {
    this.imem = program.slice();
    this.dmem = new Uint32Array(Math.max(2, opts.dmemWords ?? 64));
    this.imemWords = opts.imemWords ?? 64;
    this.m = !!opts.m;
  }

  save(): ModelState {
    return saveFields(this);
  }

  restore(s: ModelState): void {
    restoreFields(this, s);
  }

  fetch(pc: bigint): number {
    return this.imem[Number((pc >> 2n) % BigInt(this.imemWords))] ?? 0x00000013;
  }

  /** The doubleword holding addr: its index in 32-bit words (even). */
  private dw(addr: bigint): number {
    return Number((addr >> 3n) & BigInt(this.dmem.length / 2 - 1)) * 2;
  }

  /** The doubleword at addr (as stored, unsigned). */
  readDword(addr: bigint): bigint {
    const i = this.dw(addr);
    return BigInt(this.dmem[i]) | (BigInt(this.dmem[i + 1]) << 32n);
  }

  private writeDword(addr: bigint, v: bigint): void {
    const i = this.dw(addr);
    this.dmem[i] = Number(v & 0xffffffffn);
    this.dmem[i + 1] = Number((v >> 32n) & 0xffffffffn);
  }

  /** The byte offset an access of `size` bytes starts at within its doubleword. */
  private static lane(addr: bigint, size: number): bigint {
    return addr & 7n & BigInt(~(size - 1) & 7);
  }

  load(addr: bigint, f3: number): bigint {
    const size = accessSize(f3), bits = BigInt(size * 8);
    const raw = (this.readDword(addr) >> (ISS64.lane(addr, size) * 8n)) & ((1n << bits) - 1n);
    return f3 & 4 || size === 8 ? raw : u64(BigInt.asIntN(Number(bits), raw));
  }

  store(addr: bigint, f3: number, v: bigint): void {
    const size = accessSize(f3), sh = ISS64.lane(addr, size) * 8n;
    const mask = ((1n << BigInt(size * 8)) - 1n) << sh;
    this.writeDword(addr, (this.readDword(addr) & ~mask & M64) | ((v << sh) & mask));
  }

  step(): StepInfo64 {
    const pc = this.pc;
    const word = this.fetch(pc);
    const d = decode(word, undefined, 64);
    const x = this.x;
    const a = x[d.rs1], b = x[d.rs2];
    let next = u64(pc + 4n);
    let rd = 0, value: bigint | undefined, store: StepInfo64['store'];
    const write = (v: bigint) => { rd = d.rd; value = u64(v); };
    const imm = BigInt(d.imm);
    const isM = (d.opcode === OPCODES.OP || d.opcode === OPCODES.OP32) && d.funct7 === 1;
    if (isM) {
      if (this.m && d.spec) write(mExec64(d.funct3, a, b, d.opcode === OPCODES.OP32));
    } else if (d.spec) switch (d.opcode) {
      case OPCODES.LUI: write(imm); break;
      case OPCODES.AUIPC: write(pc + imm); break;
      case OPCODES.JAL: write(pc + 4n); next = u64(pc + imm); break;
      case OPCODES.JALR: write(pc + 4n); next = u64(a + imm) & ~1n; break;
      case OPCODES.BRANCH: {
        const sa = s64(a), sb = s64(b);
        const take = [a === b, a !== b, false, false, sa < sb, sa >= sb, a < b, a >= b][d.funct3];
        if (take) next = u64(pc + imm);
        break;
      }
      case OPCODES.LOAD: write(this.load(u64(a + imm), d.funct3)); break;
      case OPCODES.STORE: {
        const addr = u64(a + imm), size = accessSize(d.funct3);
        this.store(addr, d.funct3, b);
        store = { addr, value: b & ((1n << BigInt(size * 8)) - 1n), size };
        break;
      }
      case OPCODES.OPIMM:
      case OPCODES.OP: {
        const isImm = d.opcode === OPCODES.OPIMM;
        const bb = isImm ? u64(imm) : b;
        const sh = bb & 63n;
        const alt = isImm ? d.funct3 === 5 && (d.funct7 & 0x20) !== 0 : d.funct7 === 0x20;
        switch (d.funct3) {
          case 0: write(isImm || !alt ? a + bb : a - bb); break;
          case 1: write(a << sh); break;
          case 2: write(s64(a) < s64(bb) ? 1n : 0n); break;
          case 3: write(a < bb ? 1n : 0n); break;
          case 4: write(a ^ bb); break;
          case 5: write(alt ? s64(a) >> sh : a >> sh); break;
          case 6: write(a | bb); break;
          default: write(a & bb);
        }
        break;
      }
      case OPCODES.OPIMM32:
      case OPCODES.OP32: {
        const isImm = d.opcode === OPCODES.OPIMM32;
        const bb = isImm ? u64(imm) : b;
        const sh = bb & 31n;
        const alt = isImm ? d.funct3 === 5 && (d.funct7 & 0x20) !== 0 : d.funct7 === 0x20;
        const lo = BigInt.asUintN(32, a);
        switch (d.funct3) {
          case 0: write(sw(isImm || !alt ? a + bb : a - bb)); break;
          case 1: write(sw(lo << sh)); break;
          case 5: write(sw(alt ? BigInt.asIntN(32, lo) >> sh : lo >> sh)); break;
          default: break;
        }
        break;
      }
      default: break; // fence, ecall, ebreak, CSRs: no effect at user level here
    }
    if (rd !== 0 && value !== undefined) x[rd] = value;
    else rd = 0;
    this.halted = next === pc;
    this.pc = next;
    this.retired++;
    this.steps++;
    return { pc, word, text: disasm(word, Number(pc & 0xffffffffn), undefined, 64), rd, value: rd ? value : undefined, store, halted: this.halted };
  }

  run(maxSteps = 10000): number {
    let n = 0;
    while (!this.halted && n < maxSteps) { this.step(); n++; }
    return n;
  }
}
