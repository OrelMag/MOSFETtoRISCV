// A fast RV32IM(+Zicsr, machine mode) interpreter with the golden model's semantics: the same
// Harvard memories (the data memory wraps around its size), the same I/O unit, CSRs, traps,
// interrupts and cycle counting as ISS (iss.ts) with the same options, so either can replace the
// other at any instruction (tests/fastiss.test.ts runs both in lock step). It exists for programs
// too long for the golden model's per-step objects (Doom: millions of instructions a frame).
//
// Every instruction-memory word is decoded once, by isa.ts's own decode(), into a kind and its
// fields in typed arrays; run(n) is one switch over kinds with the registers, PC and cycle count in
// locals. RAM accesses take an inline path; anything else (I/O, a subclass's regions) goes through
// load / store methods a machine can override (doom/machine.ts adds the WAD and the frame buffer).
// The F extension is not implemented: illegal in system mode, refused at decode otherwise.

import { CAUSE, DIV_CYCLES, IO, saveFields, restoreFields, type IssOptions, type ModelState } from './iss';
import { CSRS, decode, OPCODES } from './isa';

/** Instruction kinds (one switch case each). */
export const K = {
  NOP: 0, LUI: 1, AUIPC: 2, JAL: 3, JALR: 4,
  BEQ: 5, BNE: 6, BNEVER: 7, BLT: 8, BGE: 9, BLTU: 10, BGEU: 11,
  LB: 12, LH: 13, LW: 14, LBU: 15, LHU: 16, SB: 17, SH: 18, SW: 19,
  ADDI: 20, SLLI: 21, SLTI: 22, SLTIU: 23, XORI: 24, SRLI: 25, SRAI: 26, ORI: 27, ANDI: 28,
  ADD: 29, SUB: 30, SLL: 31, SLT: 32, SLTU: 33, XOR: 34, SRL: 35, SRA: 36, OR: 37, AND: 38,
  MUL: 39, MULH: 40, MULHSU: 41, MULHU: 42, DIV: 43, DIVU: 44, REM: 45, REMU: 46,
  AMOADD: 47, AMOSWAP: 48, SYSTEM: 49, ILLEGAL: 50,
} as const;

/** Kind names, for profiles and tests. */
export const KIND_NAMES = Object.fromEntries(Object.entries(K).map(([k, v]) => [v, k.toLowerCase()])) as Record<number, string>;

/** High 32 bits of the unsigned 64-bit product (no BigInt: 16-bit limbs stay exact in doubles). */
export function mulhu(a: number, b: number): number {
  a >>>= 0; b >>>= 0;
  const al = a & 0xffff, ah = a >>> 16, bl = b & 0xffff, bh = b >>> 16;
  const ll = al * bl, lh = al * bh, hl = ah * bl;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (ah * bh + (lh >>> 16) + (hl >>> 16) + Math.floor(mid / 65536)) >>> 0;
}

/** run()'s next PC for an instruction that trapped (never a real one: every real next PC is even). */
const TRAPPED = -1;

/** Region codes per address nibble (addr >>> 28): RAM takes the inline path, the rest load() / store(). */
export const RAM = 0, DEV = 1;

export class FastISS {
  private readonly buf: ArrayBuffer;
  /** Registers as the golden model shows them (x[0] stays 0). */
  readonly x: Uint32Array;
  private readonly xi: Int32Array;
  pc = 0;
  /** Data memory, one buffer in three views (little-endian, as the golden model's byte lanes). */
  readonly dmem: Uint32Array;
  readonly d8: Uint8Array;
  readonly d16: Uint16Array;
  private readonly dmask: number; // byte address mask
  readonly imemWords: number;
  readonly kind: Uint8Array;
  readonly frd: Uint8Array;
  readonly frs1: Uint8Array;
  readonly frs2: Uint8Array;
  readonly fimm: Int32Array;
  readonly words: Uint32Array;
  /** Region of each address nibble (RAM or DEV). */
  readonly region = new Uint8Array(16);
  readonly system: boolean;
  readonly io: boolean;
  readonly m: boolean;
  readonly hartid: number;
  halted = false;
  steps = 0;
  retired = 0;
  // machine-mode state, as ISS
  mie = false; mpie = false; mtie = false; meie = false;
  mtvec = 0; mscratch = 0; mepc = 0; mcause = 0; mtval = 0;
  mtime = 0; mtimecmp = 0; leds = 0; switches = 0; irq = false;
  console = '';
  fflags = 0; frm = 0;

  constructor(program: ArrayLike<number>, opts: IssOptions = {}) {
    const dw = opts.dmemWords ?? 32, iw = opts.imemWords ?? 64;
    if (dw & (dw - 1) || iw & (iw - 1)) throw new Error('FastISS: memory sizes must be powers of two');
    if (opts.f) throw new Error('FastISS: the F extension is not implemented');
    this.buf = new ArrayBuffer(128);
    this.x = new Uint32Array(this.buf, 0, 32);
    this.xi = new Int32Array(this.buf, 0, 32);
    const mem = new ArrayBuffer(dw * 4);
    this.dmem = new Uint32Array(mem); this.d8 = new Uint8Array(mem); this.d16 = new Uint16Array(mem);
    this.dmask = dw * 4 - 1;
    this.imemWords = iw;
    this.system = !!opts.system;
    this.io = this.system || !!opts.mmio;
    this.m = !!opts.m;
    this.hartid = opts.hartid ?? 0;
    if (this.io) this.region.fill(DEV, 8);
    this.kind = new Uint8Array(iw); this.frd = new Uint8Array(iw); this.frs1 = new Uint8Array(iw);
    this.frs2 = new Uint8Array(iw); this.fimm = new Int32Array(iw); this.words = new Uint32Array(iw);
    for (let i = 0; i < iw; i++) this.predecode(i, i < program.length ? program[i] >>> 0 : 0x00000013);
  }

  private predecode(i: number, w: number): void {
    const d = decode(w);
    this.words[i] = w; this.frd[i] = d.rd; this.frs1[i] = d.rs1; this.frs2[i] = d.rs2; this.fimm[i] = d.imm;
    const isM = d.opcode === OPCODES.OP && d.funct7 === 1;
    const isF = !!d.spec?.fp;
    let k: number = K.NOP;
    if (this.system && (!d.spec || (isM && !this.m) || isF)) k = K.ILLEGAL;
    else if (isF) throw new Error(`FastISS: F instruction ${d.name} at word ${i} (not implemented)`);
    else if (isM) k = K.MUL + d.funct3;
    else switch (d.opcode) {
      case OPCODES.LUI: k = K.LUI; break;
      case OPCODES.AUIPC: k = K.AUIPC; break;
      case OPCODES.JAL: k = K.JAL; break;
      case OPCODES.JALR: k = K.JALR; break;
      case OPCODES.BRANCH: k = [K.BEQ, K.BNE, K.BNEVER, K.BNEVER, K.BLT, K.BGE, K.BLTU, K.BGEU][d.funct3]; break;
      // as ISS.load: funct3 0 / 1 / 4 / 5 are narrow, the rest whole words; ISS.store: 0 byte, 2 word, else half
      case OPCODES.LOAD: k = d.funct3 === 0 ? K.LB : d.funct3 === 1 ? K.LH : d.funct3 === 4 ? K.LBU : d.funct3 === 5 ? K.LHU : K.LW; break;
      case OPCODES.STORE: k = d.funct3 === 0 ? K.SB : d.funct3 === 2 ? K.SW : K.SH; break;
      case OPCODES.OPIMM: {
        const alt = d.funct3 === 5 && (d.funct7 & 0x20) !== 0;
        k = [K.ADDI, K.SLLI, K.SLTI, K.SLTIU, K.XORI, alt ? K.SRAI : K.SRLI, K.ORI, K.ANDI][d.funct3];
        if (k === K.SLLI || k === K.SRLI || k === K.SRAI) this.fimm[i] = d.imm & 31;
        break;
      }
      case OPCODES.OP: {
        const alt = d.funct7 === 0x20;
        k = [alt ? K.SUB : K.ADD, K.SLL, K.SLT, K.SLTU, K.XOR, alt ? K.SRA : K.SRL, K.OR, K.AND][d.funct3];
        break;
      }
      case OPCODES.AMO: k = this.system ? K.ILLEGAL : d.name === 'amoadd.w' ? K.AMOADD : K.AMOSWAP; break;
      case OPCODES.SYSTEM: k = K.SYSTEM; break;
      default: k = K.NOP; // fence and anything else: no architectural effect
    }
    this.kind[i] = k;
  }

  /** The instruction word at pc, as the golden model fetches it. */
  fetch(pc: number): number {
    return this.words[(pc >>> 2) & (this.imemWords - 1)];
  }

  save(): ModelState {
    return saveFields(this);
  }

  restore(s: ModelState): void {
    restoreFields(this, s);
  }

  // ---- the slow paths (I/O, other regions) ----

  /** The 32-bit word a device returns for a load at addr (bit 31 set), as ISS.ioRead. */
  protected ioRead(addr: number): number {
    if (!this.system) {
      const a = (addr & ~3) >>> 0;
      return a === IO.LEDS ? this.leds : a === IO.SWITCHES ? this.switches : 0;
    }
    switch ((addr >>> 2) & 7) {
      case 1: return this.leds;
      case 2: return this.switches;
      case 4: return this.mtime;
      case 5: return this.mtimecmp;
      default: return 0;
    }
  }

  /** A store to a device, as ISS.store's I/O branch. */
  protected ioWrite(addr: number, f3: number, v: number): void {
    const wd = f3 === 0 ? ((v & 0xff) * 0x01010101) >>> 0 : f3 === 1 ? ((v & 0xffff) * 0x10001) >>> 0 : v >>> 0;
    let reg: number;
    if (this.system) reg = (addr >>> 2) & 7;
    else { const a = (addr & ~3) >>> 0; reg = a === IO.CONSOLE ? 0 : a === IO.LEDS ? 1 : a === IO.SWITCHES ? 2 : -1; }
    switch (reg) {
      case 0: this.console += String.fromCharCode(wd & 0xff); break;
      case 1: this.leds = wd & 0xff; break;
      case 5: this.mtimecmp = wd; break;
      default: break;
    }
  }

  /** A load outside RAM (region DEV); a machine with more regions overrides it. */
  protected load(addr: number, f3: number): number {
    const w = addr >= 0x80000000 && this.io ? this.ioRead(addr) >>> 0 : this.dmem[(addr >>> 2) & (this.dmask >>> 2)];
    const sh = (addr & 3) * 8;
    switch (f3) {
      case 0: return ((w >>> sh) << 24) >> 24;
      case 1: return ((w >>> (addr & 2) * 8) << 16) >> 16;
      case 4: return (w >>> sh) & 0xff;
      case 5: return (w >>> (addr & 2) * 8) & 0xffff;
      default: return w | 0;
    }
  }

  /** A store outside RAM (region DEV). */
  protected store(addr: number, f3: number, v: number): void {
    if (addr >= 0x80000000 && this.io) this.ioWrite(addr, f3, v);
    else if (f3 === 0) this.d8[addr & this.dmask] = v;
    else if (f3 === 2) this.dmem[(addr & this.dmask) >>> 2] = v;
    else this.d16[(addr & this.dmask) >>> 1] = v;
  }

  get mip(): number {
    return (this.mtime >>> 0 >= this.mtimecmp >>> 0 ? 1 << 7 : 0) | (this.irq ? 1 << 11 : 0);
  }

  csrRead(a: number): number | null {
    switch (a) {
      case CSRS.mstatus: return (this.mie ? 8 : 0) | (this.mpie ? 0x80 : 0) | 0x1800;
      case CSRS.misa: return this.m ? 0x40001100 : 0x40000100;
      case CSRS.mie: return (this.mtie ? 0x80 : 0) | (this.meie ? 0x800 : 0);
      case CSRS.mtvec: return this.mtvec;
      case CSRS.mscratch: return this.mscratch;
      case CSRS.mepc: return this.mepc;
      case CSRS.mcause: return this.mcause;
      case CSRS.mtval: return this.mtval;
      case CSRS.mip: return this.mip;
      case CSRS.mcycle: case CSRS.cycle: return this.mtime;
      case CSRS.mhartid: case CSRS.mvendorid: case CSRS.marchid: case CSRS.mimpid: case CSRS.mstatush: return 0;
      default: return null; // fflags / frm / fcsr: no F extension
    }
  }

  private csrWrite(a: number, v: number): void {
    v >>>= 0;
    switch (a) {
      case CSRS.mstatus: this.mie = !!(v & 8); this.mpie = !!(v & 0x80); break;
      case CSRS.mie: this.mtie = !!(v & 0x80); this.meie = !!(v & 0x800); break;
      case CSRS.mtvec: this.mtvec = (v & ~3) >>> 0; break;
      case CSRS.mscratch: this.mscratch = v; break;
      case CSRS.mepc: this.mepc = (v & ~3) >>> 0; break;
      case CSRS.mcause: this.mcause = v; break;
      case CSRS.mtval: this.mtval = v; break;
      default: break;
    }
  }

  /** Enter a trap: the new PC. */
  private trap(cause: number, tval: number, pc: number): number {
    this.mepc = pc >>> 0;
    this.mcause = cause >>> 0;
    this.mtval = tval >>> 0;
    this.mpie = this.mie;
    this.mie = false;
    return this.mtvec;
  }

  /**
   * A SYSTEM-opcode instruction (rare: CSRs, ecall, mret): the next PC, or TRAPPED (the trap
   * entered, this.pc the handler). Writes rd itself.
   */
  private sysInstr(i: number, pc: number): number {
    const w = this.words[i], rd = this.frd[i], rs1 = this.frs1[i];
    const f3 = (w >>> 12) & 7, csrA = w >>> 20, ua = this.x[rs1];
    const next = (pc + 4) >>> 0;
    if (!this.system) {
      // user-level programs: csrr rd, mhartid (multi-core) and the F CSRs fflags, frm, fcsr
      if (f3 === 2 && csrA === 0xf14 && rs1 === 0) { if (rd) this.x[rd] = this.hartid; }
      else if (f3 & 3 && csrA >= 1 && csrA <= 3) {
        const old = csrA === 1 ? this.fflags : csrA === 2 ? this.frm : (this.frm << 5) | this.fflags;
        const src = f3 & 4 ? rs1 : ua, op = f3 & 3;
        if (op === 1 || rs1 !== 0) {
          const v = op === 1 ? src : op === 2 ? old | src : old & ~src;
          if (csrA !== 2) this.fflags = v & 31;
          if (csrA === 2) this.frm = v & 7;
          if (csrA === 3) this.frm = (v >>> 5) & 7;
        }
        if (rd) this.x[rd] = old;
      }
      return next;
    }
    if (f3 === 0) {
      if (csrA === 0) return this.trapped(CAUSE.ECALL, 0, pc);
      if (csrA === 1) return this.trapped(CAUSE.BREAKPOINT, 0, pc);
      if (csrA === 0x302) { this.mie = this.mpie; this.mpie = true; return this.mepc; }
      return next; // wfi
    }
    const old = this.csrRead(csrA);
    if (old === null) return this.trapped(CAUSE.ILLEGAL, 0, pc);
    const src = f3 & 4 ? rs1 : ua, op = f3 & 3;
    if (op === 1 || rs1 !== 0) this.csrWrite(csrA, op === 1 ? src : op === 2 ? (old | src) : (old & ~src));
    if (rd) this.x[rd] = old;
    return next;
  }

  /**
   * Set by a device during run() (a slow-path load or store): run() returns after the current
   * instruction. A FLIP, a store into the frame buffer: exact stops without a check per instruction.
   */
  yieldNow = false;
  /** Instructions run() has retired so far in the current call (current at slow paths only). */
  runRetired = 0;

  /** Instructions retired, current also inside a device's load / store during run(). */
  get retiredNow(): number {
    return this.retired + this.runRetired;
  }

  /** One instruction (or interrupt entry), as ISS.step without its report. */
  step(): void {
    this.run(1);
  }

  /**
   * Run up to n steps (an interrupt entry counts as one), stopping early at a halt (a jump to
   * itself). Returns the steps run.
   */
  run(n: number): number {
    const x = this.xi, kind = this.kind, frd = this.frd, frs1 = this.frs1, frs2 = this.frs2, fimm = this.fimm;
    const d8 = this.d8, d16 = this.d16, d32 = this.dmem, dmask = this.dmask, region = this.region;
    const imask = this.imemWords - 1, sys = this.system;
    let pc = this.pc, mt = this.mtime, done = 0, retired = 0, slow = false;
    let armed = sys && this.mie && (this.mtie || this.meie);
    while (done < n) {
      done++;
      if (armed) {
        const tp = this.mtie && (mt >>> 0) >= (this.mtimecmp >>> 0), ep = this.meie && this.irq;
        if (tp || ep) {
          this.mtime = mt; this.runRetired = retired; slow = true;
          pc = this.trap(ep ? CAUSE.EXTERNAL_IRQ : CAUSE.TIMER_IRQ, 0, pc);
          mt = (mt + 1) >>> 0;
          armed = false;
          this.halted = false;
          continue;
        }
      }
      const i = (pc >>> 2) & imask;
      const rd = frd[i];
      let next = (pc + 4) | 0;
      let tgt = 0, addr = 0;
      switch (kind[i]) {
        case K.NOP: break;
        case K.LUI: x[rd] = fimm[i]; break;
        case K.AUIPC: x[rd] = pc + fimm[i]; break;
        case K.JAL: tgt = (pc + fimm[i]) | 0; if (sys && tgt & 3) { next = this.misfetch(tgt, pc); break; } x[rd] = next; next = tgt; break;
        case K.JALR: tgt = (x[frs1[i]] + fimm[i]) & ~1; if (sys && tgt & 3) { next = this.misfetch(tgt, pc); break; } x[rd] = next; next = tgt; break;
        case K.BEQ: if (x[frs1[i]] === x[frs2[i]]) next = this.branch(pc, fimm[i], sys); break;
        case K.BNE: if (x[frs1[i]] !== x[frs2[i]]) next = this.branch(pc, fimm[i], sys); break;
        case K.BNEVER: break;
        case K.BLT: if (x[frs1[i]] < x[frs2[i]]) next = this.branch(pc, fimm[i], sys); break;
        case K.BGE: if (x[frs1[i]] >= x[frs2[i]]) next = this.branch(pc, fimm[i], sys); break;
        case K.BLTU: if (x[frs1[i]] >>> 0 < x[frs2[i]] >>> 0) next = this.branch(pc, fimm[i], sys); break;
        case K.BGEU: if (x[frs1[i]] >>> 0 >= x[frs2[i]] >>> 0) next = this.branch(pc, fimm[i], sys); break;
        case K.LB:
          addr = x[frs1[i]] + fimm[i];
          if (region[addr >>> 28] === RAM) x[rd] = (d8[addr & dmask] << 24) >> 24;
          else { this.mtime = mt; this.runRetired = retired; slow = true; x[rd] = this.load(addr >>> 0, 0); }
          break;
        case K.LBU:
          addr = x[frs1[i]] + fimm[i];
          if (region[addr >>> 28] === RAM) x[rd] = d8[addr & dmask];
          else { this.mtime = mt; this.runRetired = retired; slow = true; x[rd] = this.load(addr >>> 0, 4); }
          break;
        case K.LH: case K.LHU: {
          addr = x[frs1[i]] + fimm[i];
          if (sys && addr & 1) { next = this.misaligned(CAUSE.MISALIGNED_LOAD, addr, pc); break; }
          const u = kind[i] === K.LHU;
          if (region[addr >>> 28] === RAM) { const h = d16[(addr & dmask) >>> 1]; x[rd] = u ? h : (h << 16) >> 16; }
          else { this.mtime = mt; this.runRetired = retired; slow = true; x[rd] = this.load(addr >>> 0, u ? 5 : 1); }
          break;
        }
        case K.LW:
          addr = x[frs1[i]] + fimm[i];
          if (sys && addr & 3) { next = this.misaligned(CAUSE.MISALIGNED_LOAD, addr, pc); break; }
          if (region[addr >>> 28] === RAM) x[rd] = d32[(addr & dmask) >>> 2];
          else { this.mtime = mt; this.runRetired = retired; slow = true; x[rd] = this.load(addr >>> 0, 2); }
          break;
        case K.SB:
          addr = x[frs1[i]] + fimm[i];
          if (region[addr >>> 28] === RAM) d8[addr & dmask] = x[frs2[i]];
          else { this.mtime = mt; this.runRetired = retired; slow = true; this.store(addr >>> 0, 0, x[frs2[i]]); armed = sys && this.mie && (this.mtie || this.meie); }
          break;
        case K.SH:
          addr = x[frs1[i]] + fimm[i];
          if (sys && addr & 1) { next = this.misaligned(CAUSE.MISALIGNED_STORE, addr, pc); break; }
          if (region[addr >>> 28] === RAM) d16[(addr & dmask) >>> 1] = x[frs2[i]];
          else { this.mtime = mt; this.runRetired = retired; slow = true; this.store(addr >>> 0, 1, x[frs2[i]]); armed = sys && this.mie && (this.mtie || this.meie); }
          break;
        case K.SW:
          addr = x[frs1[i]] + fimm[i];
          if (sys && addr & 3) { next = this.misaligned(CAUSE.MISALIGNED_STORE, addr, pc); break; }
          if (region[addr >>> 28] === RAM) d32[(addr & dmask) >>> 2] = x[frs2[i]];
          else { this.mtime = mt; this.runRetired = retired; slow = true; this.store(addr >>> 0, 2, x[frs2[i]]); armed = sys && this.mie && (this.mtie || this.meie); }
          break;
        case K.ADDI: x[rd] = x[frs1[i]] + fimm[i]; break;
        case K.SLLI: x[rd] = x[frs1[i]] << fimm[i]; break;
        case K.SLTI: x[rd] = x[frs1[i]] < fimm[i] ? 1 : 0; break;
        case K.SLTIU: x[rd] = x[frs1[i]] >>> 0 < fimm[i] >>> 0 ? 1 : 0; break;
        case K.XORI: x[rd] = x[frs1[i]] ^ fimm[i]; break;
        case K.SRLI: x[rd] = x[frs1[i]] >>> fimm[i]; break;
        case K.SRAI: x[rd] = x[frs1[i]] >> fimm[i]; break;
        case K.ORI: x[rd] = x[frs1[i]] | fimm[i]; break;
        case K.ANDI: x[rd] = x[frs1[i]] & fimm[i]; break;
        case K.ADD: x[rd] = x[frs1[i]] + x[frs2[i]]; break;
        case K.SUB: x[rd] = x[frs1[i]] - x[frs2[i]]; break;
        case K.SLL: x[rd] = x[frs1[i]] << (x[frs2[i]] & 31); break;
        case K.SLT: x[rd] = x[frs1[i]] < x[frs2[i]] ? 1 : 0; break;
        case K.SLTU: x[rd] = x[frs1[i]] >>> 0 < x[frs2[i]] >>> 0 ? 1 : 0; break;
        case K.XOR: x[rd] = x[frs1[i]] ^ x[frs2[i]]; break;
        case K.SRL: x[rd] = x[frs1[i]] >>> (x[frs2[i]] & 31); break;
        case K.SRA: x[rd] = x[frs1[i]] >> (x[frs2[i]] & 31); break;
        case K.OR: x[rd] = x[frs1[i]] | x[frs2[i]]; break;
        case K.AND: x[rd] = x[frs1[i]] & x[frs2[i]]; break;
        case K.MUL: x[rd] = Math.imul(x[frs1[i]], x[frs2[i]]); break;
        case K.MULH: { const a = x[frs1[i]], b = x[frs2[i]]; x[rd] = mulhu(a, b) - (a < 0 ? b >>> 0 : 0) - (b < 0 ? a >>> 0 : 0); break; }
        case K.MULHSU: { const a = x[frs1[i]], b = x[frs2[i]]; x[rd] = mulhu(a, b) - (a < 0 ? b >>> 0 : 0); break; }
        case K.MULHU: x[rd] = mulhu(x[frs1[i]], x[frs2[i]]); break;
        case K.DIV: {
          const a = x[frs1[i]], b = x[frs2[i]];
          x[rd] = b === 0 ? -1 : a === -0x80000000 && b === -1 ? a : (a / b) | 0;
          if (sys) mt += DIV_CYCLES - 1;
          break;
        }
        case K.DIVU: { const b = x[frs2[i]] >>> 0; x[rd] = b === 0 ? -1 : (x[frs1[i]] >>> 0) / b; if (sys) mt += DIV_CYCLES - 1; break; }
        case K.REM: { const a = x[frs1[i]], b = x[frs2[i]]; x[rd] = b === 0 ? a : a % b; if (sys) mt += DIV_CYCLES - 1; break; }
        case K.REMU: { const a = x[frs1[i]] >>> 0, b = x[frs2[i]] >>> 0; x[rd] = b === 0 ? a : a % b; if (sys) mt += DIV_CYCLES - 1; break; }
        case K.AMOADD: case K.AMOSWAP: {
          addr = x[frs1[i]];
          this.mtime = mt; this.runRetired = retired; slow = true;
          const old = this.region[addr >>> 28] === RAM ? d32[(addr & dmask) >>> 2] : this.load(addr >>> 0, 2);
          const nv = kind[i] === K.AMOADD ? old + x[frs2[i]] : x[frs2[i]];
          if (this.region[addr >>> 28] === RAM) d32[(addr & dmask) >>> 2] = nv; else this.store(addr >>> 0, 2, nv);
          x[rd] = old;
          break;
        }
        case K.SYSTEM:
          this.mtime = mt; this.runRetired = retired; slow = true;
          next = this.sysInstr(i, pc);
          armed = sys && this.mie && (this.mtie || this.meie);
          break;
        case K.ILLEGAL:
          next = this.trapped(CAUSE.ILLEGAL, 0, pc);
          break;
      }
      x[0] = 0;
      if (next === TRAPPED) {
        // the instruction trapped before writing anything: not retired, the handler is this.pc
        pc = this.pc;
        armed = false;
      } else {
        retired++;
        const halt = next >>> 0 === pc;
        pc = next >>> 0;
        if (halt) { this.halted = true; if (sys) mt = (mt + 1) >>> 0; break; }
        this.halted = false;
      }
      if (sys) mt = (mt + 1) >>> 0;
      if (slow) { slow = false; if (this.yieldNow) { this.yieldNow = false; break; } }
    }
    this.pc = pc;
    this.mtime = mt >>> 0;
    this.steps += done;
    this.retired += retired;
    this.runRetired = 0;
    return done;
  }

  /** A trapping instruction (nothing written yet): enter the trap, this.pc = the handler. */
  private trapped(cause: number, tval: number, pc: number): number {
    this.pc = this.trap(cause, tval, pc);
    return TRAPPED;
  }

  private misaligned(cause: number, tval: number, pc: number): number {
    return this.trapped(cause, tval, pc);
  }

  private misfetch(tgt: number, pc: number): number {
    return this.trapped(CAUSE.MISALIGNED_FETCH, tgt, pc);
  }

  private branch(pc: number, imm: number, sys: boolean): number {
    const t = (pc + imm) | 0;
    return sys && t & 3 ? this.misfetch(t, pc) : t;
  }
}
