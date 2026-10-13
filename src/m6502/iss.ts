// A cycle-exact NMOS 6502: the golden model a transistor-level 6502 is run against, bus cycle by bus
// cycle. Every cycle is one memory access (the 6502 reads or writes on every clock), in the order the
// chip makes them, dummy accesses included: the read of the next byte by one-byte instructions, the
// read at the un-carried address of an indexed access, the read-modify-write's write of the unmodified
// value, the stack reads of PLA / PLP / RTS / RTI / JSR, the branch's reads of the next opcode.
//
// The CPU is a per-cycle state machine (`flow`: which sequence, `t`: the next cycle in it, and the
// latched address / operand bytes), so it can stop between any two cycles, sample its interrupt inputs
// every cycle and be snapshotted with save() / restore().
//
// Bus conventions (BusCycle, and the busAddr / busData / busWrite / busSync fields after each cycle):
//   addr   the address bus during the cycle
//   data   the data bus: the byte read (as the memory returned it) or the byte written
//   rw     'r' read (the R/W pin high), 'w' write (R/W low)
//   sync   1 on an opcode fetch: every instruction's first cycle, and the first cycle of an IRQ / NMI
//          sequence (an opcode fetch whose byte the CPU replaces by BRK); 0 otherwise, the reset
//          sequence included
//
// Interrupts (inputs `irq` and `nmi`: true = asserted, i.e. the active-low pin is LOW). Set them before
// cycle(); the value holds for that cycle. Following the NMOS chip (nesdev "CPU interrupts", visual6502):
//   - at the end of every cycle (φ2) the inputs are sampled: irqSig := irq (a level), and an NMI edge
//     (nmi not asserted in the previous cycle, asserted in this one) sets nmiSig, which stays set until
//     an interrupt sequence takes the NMI vector;
//   - an instruction polls on its last cycle, before that cycle's own effects, from the signals sampled
//     at the end of the cycle before: interrupt := nmiSig || (irqSig && I = 0). So CLI / SEI / PLP change
//     I one instruction late, RTI's restored I counts at once (it pulls P before its last cycle);
//   - branches poll during their operand fetch (their second cycle); a taken branch that crosses a page
//     polls again at its PCH fix-up (the last cycle), and that later poll replaces the first; a taken
//     branch within a page does not poll on its last cycle, so an interrupt that arrives there waits
//     one more instruction;
//   - an interrupt sequence (IRQ or NMI) takes 7 cycles: a fetch at PC (sync 1, PC not incremented), a
//     read at PC, PCH, PCL and P pushed (B = 0; BRK pushes B = 1), the vector read; I is set. The vector
//     is chosen during the P push (4th cycle after the fetch), from nmiSig as sampled by the end of the
//     cycle before: an NMI detected by then hijacks a BRK or an IRQ sequence (vector $FFFA, the pushed B
//     unchanged). The sequence's last cycle does not poll: the handler's first instruction always runs.
//
// Reset: reset() starts the 7-cycle reset sequence, delivered by the next 7 cycle() calls: two reads at
// PC, three reads at $0100+S with S decrementing (the pushes with writes suppressed), the vector read at
// $FFFC / $FFFD (I set); then the first opcode fetch. A, X, Y, the other flags and S's start value are
// whatever they were: a new Cpu6502 starts with A = X = Y = S = PC = 0 and P = $20, so its reset reads
// $0000 twice and the stack at $0100, $01FF, $01FE, and leaves S = $FD, P = $24.
//
// Undocumented opcodes are not implemented: fetching one sets `illegal` to the opcode, leaves PC on it,
// and every later cycle reads that same address (sync 0, cycles still counted) until reset() / restore().
//
// Decimal mode is the NMOS one: ADC / SBC correct the accumulator; ADC's N and V come from the
// intermediate (half-corrected) sum, Z from the binary sum; SBC's flags all come from the binary
// difference (Bruce Clark, "Decimal Mode", 6502.org).

import { OPCODES } from './isa';

/** The memory and devices: every bus access goes through it, in order. read() must return a byte. */
export interface Bus6502 {
  read(addr: number): number;
  write(addr: number, value: number): void;
}

export interface BusCycle {
  addr: number;
  data: number;
  rw: 'r' | 'w';
  sync: 0 | 1;
}

/** 64 KiB of RAM: the simplest Bus6502. */
export class Ram64 implements Bus6502 {
  readonly mem = new Uint8Array(0x10000);
  read(addr: number): number { return this.mem[addr]; }
  write(addr: number, value: number): void { this.mem[addr] = value; }
  /** Copies `bytes` to `addr` (wrapping at $FFFF). */
  load(bytes: ArrayLike<number>, addr: number): void {
    for (let i = 0; i < bytes.length; i++) this.mem[(addr + i) & 0xffff] = bytes[i];
  }
}

/** Status flags. B (bit 4) exists only on the stack; bit 5 always reads 1. */
export const FLAG = { C: 0x01, Z: 0x02, I: 0x04, D: 0x08, B: 0x10, U: 0x20, V: 0x40, N: 0x80 } as const;

/** Everything a Cpu6502 is: registers, the position inside an instruction, interrupt latches, last bus cycle. */
export interface Cpu6502State {
  a: number; x: number; y: number; s: number; p: number; pc: number; cycles: number;
  ir: number; flow: number; t: number; seq: number;
  ea: number; tmp: number; cross: boolean; vec: number;
  irq: boolean; nmi: boolean; irqSig: boolean; nmiSig: boolean; nmiPrev: boolean; intPending: boolean;
  illegal: number | null;
  busAddr: number; busData: number; busWrite: boolean; busSync: 0 | 1;
}

// Sequences (flow). The addressing flows compute `ea`, then hand over to an access flow.
const F_IMPL = 0, F_IMM = 1, F_ZP = 2, F_ZPX = 3, F_ZPY = 4, F_ABS = 5, F_ABX = 6, F_ABY = 7, F_IZX = 8, F_IZY = 9,
  F_BRANCH = 10, F_JMP = 11, F_JMPI = 12, F_JSR = 13, F_RTS = 14, F_RTI = 15, F_BRK = 16, F_PUSH = 17, F_PULL = 18,
  F_READ = 19, F_WRITE = 20, F_RMW = 21, F_ILLEGAL = -1;
const MODE_FLOW: Record<string, number> = {
  impl: F_IMPL, acc: F_IMPL, imm: F_IMM, zp: F_ZP, zpx: F_ZPX, zpy: F_ZPY, abs: F_ABS, abx: F_ABX, aby: F_ABY,
  izx: F_IZX, izy: F_IZY, rel: F_BRANCH,
};
// What the interrupt-style sequence (F_BRK) is doing: a BRK, an IRQ / NMI, or reset.
const SEQ_BRK = 0, SEQ_INT = 1, SEQ_RESET = 2;
// t value that starts the reset sequence (its first cycle is not an opcode fetch).
const T_RESET = 8;

const C = 0x01, Z = 0x02, I = 0x04, D = 0x08, B = 0x10, U = 0x20, V = 0x40, N = 0x80;

const FLOW = new Int8Array(256).fill(F_ILLEGAL);
const ACCESS = new Uint8Array(256); // 0 read, 1 write, 2 rmw
for (const info of OPCODES) {
  if (!info) continue;
  const { op, mnemonic, mode } = info;
  FLOW[op] = mnemonic === 'JMP' ? (mode === 'ind' ? F_JMPI : F_JMP) : mnemonic === 'JSR' ? F_JSR : mnemonic === 'RTS' ? F_RTS
    : mnemonic === 'RTI' ? F_RTI : mnemonic === 'BRK' ? F_BRK : mnemonic === 'PHA' || mnemonic === 'PHP' ? F_PUSH
    : mnemonic === 'PLA' || mnemonic === 'PLP' ? F_PULL : MODE_FLOW[mode];
  ACCESS[op] = info.access === 'w' ? 1 : info.access === 'm' ? 2 : 0;
}
// Flag tested by a branch, from the opcode's top two bits: N, V, C, Z.
const BRANCH_BIT = [7, 6, 0, 1];

export class Cpu6502 {
  a = 0; x = 0; y = 0; s = 0; pc = 0;
  /** Status register; bit 5 always 1, bit 4 (B) always 0 here. */
  p = U;
  /** Clock cycles executed. */
  cycles = 0;
  /** IRQ input: true = asserted (/IRQ pin low). Level-triggered, masked by I. */
  irq = false;
  /** NMI input: true = asserted (/NMI pin low). Edge-triggered (not asserted → asserted). */
  nmi = false;
  /** The undocumented opcode the CPU stopped on, or null. */
  illegal: number | null = null;

  /** The last cycle's bus (see the file comment). */
  busAddr = 0; busData = 0; busWrite = false; busSync: 0 | 1 = 0;

  /** Opcode being executed (0 during an interrupt or reset sequence). */
  ir = 0;
  private flow = F_IMPL;
  /** Next cycle within the instruction: 0 = the next cycle is an opcode fetch. */
  private t = 0;
  private seq = SEQ_BRK;
  private ea = 0;
  private tmp = 0;
  private cross = false;
  private vec = 0xfffe;
  private irqSig = false;
  private nmiSig = false;
  private nmiPrev = false;
  private intPending = false;

  constructor(readonly bus: Bus6502) {}

  /** The cycle within the current instruction the next cycle() runs (0: an opcode fetch). */
  get instrCycle(): number { return this.t === T_RESET ? 0 : this.t; }
  /** True between instructions (the next cycle is an opcode fetch or the start of an interrupt sequence). */
  get atBoundary(): boolean { return this.t === 0; }
  /** An interrupt sequence will start at the next instruction boundary. */
  get interruptPending(): boolean { return this.intPending; }

  /** Starts the reset sequence: the next 7 cycles are it. Clears pending interrupts and `illegal`. */
  reset(): void {
    this.flow = F_BRK; this.seq = SEQ_RESET; this.t = T_RESET; this.ir = 0;
    this.illegal = null; this.intPending = false; this.nmiSig = false; this.irqSig = false;
  }

  /** One clock cycle; returns its bus access. */
  cycle(): BusCycle {
    this.tick();
    return { addr: this.busAddr, data: this.busData, rw: this.busWrite ? 'w' : 'r', sync: this.busSync };
  }

  /** Runs to the end of the current instruction (or interrupt / reset sequence); returns the cycles taken. */
  step(): number {
    const c0 = this.cycles;
    do this.tick(); while (this.t !== 0 && this.illegal === null);
    return this.cycles - c0;
  }

  /** Runs whole instructions until at least `n` cycles have passed (or an illegal opcode); returns the cycles run. */
  run(n: number): number {
    const c0 = this.cycles, end = c0 + n;
    while (this.cycles < end && this.illegal === null) this.step();
    return this.cycles - c0;
  }

  save(): Cpu6502State {
    const { a, x, y, s, p, pc, cycles, ir, flow, t, seq, ea, tmp, cross, vec, irq, nmi, irqSig, nmiSig, nmiPrev, intPending,
      illegal, busAddr, busData, busWrite, busSync } = this;
    return { a, x, y, s, p, pc, cycles, ir, flow, t, seq, ea, tmp, cross, vec, irq, nmi, irqSig, nmiSig, nmiPrev, intPending,
      illegal, busAddr, busData, busWrite, busSync };
  }

  restore(st: Cpu6502State): void {
    Object.assign(this, st);
  }

  /** Same as cycle() without allocating: the result is in busAddr / busData / busWrite / busSync. */
  tick(): void {
    this.busSync = 0;
    if (this.illegal !== null) this.rd(this.pc);
    else if (this.t === 0) this.fetch();
    else this.exec();
    this.cycles++;
    // φ2 sampling of the interrupt inputs (see the file comment).
    if (this.nmi && !this.nmiPrev) this.nmiSig = true;
    this.nmiPrev = this.nmi;
    this.irqSig = this.irq;
  }

  private rd(addr: number): number {
    const v = this.bus.read(addr) & 0xff;
    this.busAddr = addr; this.busData = v; this.busWrite = false;
    return v;
  }

  private wr(addr: number, v: number): void {
    this.busAddr = addr; this.busData = v; this.busWrite = true;
    this.bus.write(addr, v);
  }

  private poll(): void {
    this.intPending = this.nmiSig || (this.irqSig && (this.p & I) === 0);
  }

  private fetch(): void {
    this.busSync = 1;
    if (this.intPending) {
      this.rd(this.pc);
      this.intPending = false;
      this.ir = 0; this.flow = F_BRK; this.seq = SEQ_INT; this.t = 1;
      return;
    }
    const op = this.rd(this.pc);
    const f = FLOW[op];
    if (f === F_ILLEGAL) { this.illegal = op; return; }
    this.pc = (this.pc + 1) & 0xffff;
    this.ir = op; this.flow = f; this.seq = SEQ_BRK; this.t = 1;
  }

  private setNZ(v: number): void { this.p = (this.p & ~(N | Z)) | (v & N) | (v === 0 ? Z : 0); }

  private push(v: number): void { this.wr(0x100 | this.s, v); this.s = (this.s - 1) & 0xff; }

  /** After the effective address: the access flow for this opcode, starting next cycle. */
  private toAccess(): void {
    const k = ACCESS[this.ir];
    this.flow = k === 0 ? F_READ : k === 1 ? F_WRITE : F_RMW;
    this.t = 1;
  }

  private exec(): void {
    const t = this.t;
    switch (this.flow) {
      case F_IMPL:
        this.poll();
        this.rd(this.pc);
        this.implied(this.ir);
        this.t = 0;
        return;
      case F_IMM: {
        this.poll();
        const v = this.rd(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        this.readOp(this.ir, v);
        this.t = 0;
        return;
      }
      case F_ZP:
        this.ea = this.rd(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        this.toAccess();
        return;
      case F_ZPX: case F_ZPY:
        if (t === 1) {
          this.ea = this.rd(this.pc);
          this.pc = (this.pc + 1) & 0xffff;
          this.t = 2;
        } else {
          this.rd(this.ea);
          this.ea = (this.ea + (this.flow === F_ZPX ? this.x : this.y)) & 0xff;
          this.toAccess();
        }
        return;
      case F_ABS: case F_ABX: case F_ABY:
        if (t === 1) {
          this.ea = this.rd(this.pc);
          this.pc = (this.pc + 1) & 0xffff;
          this.t = 2;
        } else if (t === 2) {
          const hi = this.rd(this.pc);
          this.pc = (this.pc + 1) & 0xffff;
          if (this.flow === F_ABS) { this.ea |= hi << 8; this.toAccess(); return; }
          const lo = this.ea + (this.flow === F_ABX ? this.x : this.y);
          this.cross = lo > 0xff;
          this.ea = (hi << 8) | (lo & 0xff);
          // A read that does not carry goes straight to the right address; otherwise a dummy read first.
          if (!this.cross && ACCESS[this.ir] === 0) this.toAccess();
          else this.t = 3;
        } else {
          this.rd(this.ea);
          if (this.cross) this.ea = (this.ea + 0x100) & 0xffff;
          this.toAccess();
        }
        return;
      case F_IZX:
        switch (t) {
          case 1: this.tmp = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; this.t = 2; return;
          case 2: this.rd(this.tmp); this.tmp = (this.tmp + this.x) & 0xff; this.t = 3; return;
          case 3: this.ea = this.rd(this.tmp); this.t = 4; return;
          default: this.ea |= this.rd((this.tmp + 1) & 0xff) << 8; this.toAccess(); return;
        }
      case F_IZY:
        switch (t) {
          case 1: this.tmp = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; this.t = 2; return;
          case 2: this.ea = this.rd(this.tmp); this.t = 3; return;
          case 3: {
            const hi = this.rd((this.tmp + 1) & 0xff);
            const lo = this.ea + this.y;
            this.cross = lo > 0xff;
            this.ea = (hi << 8) | (lo & 0xff);
            if (!this.cross && ACCESS[this.ir] === 0) this.toAccess();
            else this.t = 4;
            return;
          }
          default:
            this.rd(this.ea);
            if (this.cross) this.ea = (this.ea + 0x100) & 0xffff;
            this.toAccess();
            return;
        }
      case F_READ:
        this.poll();
        this.readOp(this.ir, this.rd(this.ea));
        this.t = 0;
        return;
      case F_WRITE: {
        this.poll();
        const op = this.ir;
        // STA / STX / STY: bits 1-0 = 01 / 10 / 00.
        this.wr(this.ea, (op & 3) === 1 ? this.a : (op & 3) === 2 ? this.x : this.y);
        this.t = 0;
        return;
      }
      case F_RMW:
        if (t === 1) { this.tmp = this.rd(this.ea); this.t = 2; }
        else if (t === 2) { this.wr(this.ea, this.tmp); this.tmp = this.modify(this.ir, this.tmp); this.t = 3; }
        else { this.poll(); this.wr(this.ea, this.tmp); this.t = 0; }
        return;
      case F_BRANCH:
        if (t === 1) {
          this.poll();
          this.tmp = this.rd(this.pc);
          this.pc = (this.pc + 1) & 0xffff;
          const op = this.ir;
          const taken = ((this.p >> BRANCH_BIT[op >> 6]) & 1) === ((op >> 5) & 1);
          this.t = taken ? 2 : 0;
        } else if (t === 2) {
          this.rd(this.pc);
          const target = (this.pc + ((this.tmp << 24) >> 24)) & 0xffff;
          this.cross = (target & 0xff00) !== (this.pc & 0xff00);
          this.ea = target;
          this.pc = (this.pc & 0xff00) | (target & 0xff);
          this.t = this.cross ? 3 : 0;
        } else {
          this.poll();
          this.rd(this.pc);
          this.pc = this.ea;
          this.t = 0;
        }
        return;
      case F_JMP:
        if (t === 1) { this.tmp = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; this.t = 2; }
        else { this.poll(); this.pc = this.tmp | (this.rd(this.pc) << 8); this.t = 0; }
        return;
      case F_JMPI:
        switch (t) {
          case 1: this.ea = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; this.t = 2; return;
          case 2: this.ea |= this.rd(this.pc) << 8; this.pc = (this.pc + 1) & 0xffff; this.t = 3; return;
          case 3: this.tmp = this.rd(this.ea); this.t = 4; return;
          // The pointer's high byte comes from the same page: JMP ($12FF) reads $12FF and $1200.
          default:
            this.poll();
            this.pc = this.tmp | (this.rd((this.ea & 0xff00) | ((this.ea + 1) & 0xff)) << 8);
            this.t = 0;
            return;
        }
      case F_JSR:
        switch (t) {
          case 1: this.tmp = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; this.t = 2; return;
          case 2: this.rd(0x100 | this.s); this.t = 3; return;
          case 3: this.push(this.pc >> 8); this.t = 4; return;
          case 4: this.push(this.pc & 0xff); this.t = 5; return;
          // The high byte is read after the pushes (they can overwrite it when the code sits in page 1).
          default: this.poll(); this.pc = this.tmp | (this.rd(this.pc) << 8); this.t = 0; return;
        }
      case F_RTS:
        switch (t) {
          case 1: this.rd(this.pc); this.t = 2; return;
          case 2: this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff; this.t = 3; return;
          case 3: this.tmp = this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff; this.t = 4; return;
          case 4: this.pc = this.tmp | (this.rd(0x100 | this.s) << 8); this.t = 5; return;
          default: this.poll(); this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff; this.t = 0; return;
        }
      case F_RTI:
        switch (t) {
          case 1: this.rd(this.pc); this.t = 2; return;
          case 2: this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff; this.t = 3; return;
          case 3: this.p = (this.rd(0x100 | this.s) & ~B) | U; this.s = (this.s + 1) & 0xff; this.t = 4; return;
          case 4: this.tmp = this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff; this.t = 5; return;
          default: this.poll(); this.pc = this.tmp | (this.rd(0x100 | this.s) << 8); this.t = 0; return;
        }
      case F_PUSH:
        if (t === 1) { this.rd(this.pc); this.t = 2; }
        else { this.poll(); this.push(this.ir === 0x48 ? this.a : this.p | B | U); this.t = 0; }
        return;
      case F_PULL:
        if (t === 1) { this.rd(this.pc); this.t = 2; }
        else if (t === 2) { this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff; this.t = 3; }
        else {
          this.poll();
          const v = this.rd(0x100 | this.s);
          if (this.ir === 0x68) { this.a = v; this.setNZ(v); } else this.p = (v & ~B) | U;
          this.t = 0;
        }
        return;
      case F_BRK:
        this.brk(t);
        return;
    }
  }

  // BRK, IRQ / NMI and reset share one sequence; reset suppresses the writes (they become stack reads).
  private brk(t: number): void {
    const seq = this.seq;
    switch (t) {
      case T_RESET: this.rd(this.pc); this.t = 1; return;
      case 1:
        this.rd(this.pc);
        if (seq === SEQ_BRK) this.pc = (this.pc + 1) & 0xffff;
        this.t = 2;
        return;
      case 2: case 3: case 4:
        if (t === 4) {
          // The vector is chosen here: an NMI detected by now takes over (hijacking BRK or IRQ).
          if (seq === SEQ_RESET) this.vec = 0xfffc;
          else if (this.nmiSig) { this.vec = 0xfffa; this.nmiSig = false; }
          else this.vec = 0xfffe;
        }
        if (seq === SEQ_RESET) { this.rd(0x100 | this.s); this.s = (this.s - 1) & 0xff; }
        else this.push(t === 2 ? this.pc >> 8 : t === 3 ? this.pc & 0xff : this.p | U | (seq === SEQ_BRK ? B : 0));
        this.t = t + 1;
        return;
      case 5:
        this.tmp = this.rd(this.vec);
        this.p |= I;
        this.t = 6;
        return;
      default:
        this.pc = this.tmp | (this.rd(this.vec + 1) << 8);
        this.intPending = false;
        this.t = 0;
        return;
    }
  }

  // One-byte instructions; the accumulator shifts reuse modify().
  private implied(op: number): void {
    switch (op) {
      case 0x0a: case 0x4a: case 0x2a: case 0x6a: this.a = this.modify(op, this.a); return;
      case 0x18: this.p &= ~C; return;
      case 0x38: this.p |= C; return;
      case 0x58: this.p &= ~I; return;
      case 0x78: this.p |= I; return;
      case 0xb8: this.p &= ~V; return;
      case 0xd8: this.p &= ~D; return;
      case 0xf8: this.p |= D; return;
      case 0xaa: this.x = this.a; this.setNZ(this.x); return;
      case 0xa8: this.y = this.a; this.setNZ(this.y); return;
      case 0xba: this.x = this.s; this.setNZ(this.x); return;
      case 0x8a: this.a = this.x; this.setNZ(this.a); return;
      case 0x9a: this.s = this.x; return;
      case 0x98: this.a = this.y; this.setNZ(this.a); return;
      case 0xe8: this.x = (this.x + 1) & 0xff; this.setNZ(this.x); return;
      case 0xc8: this.y = (this.y + 1) & 0xff; this.setNZ(this.y); return;
      case 0xca: this.x = (this.x - 1) & 0xff; this.setNZ(this.x); return;
      case 0x88: this.y = (this.y - 1) & 0xff; this.setNZ(this.y); return;
      default: return; // NOP
    }
  }

  // Shift / rotate / increment / decrement: the operation from aaa (bits 7-5).
  private modify(op: number, v: number): number {
    let r: number;
    switch (op >> 5) {
      case 0: r = (v << 1) & 0xff; this.p = (this.p & ~C) | (v >> 7); break; // ASL
      case 1: r = ((v << 1) | (this.p & C)) & 0xff; this.p = (this.p & ~C) | (v >> 7); break; // ROL
      case 2: r = v >> 1; this.p = (this.p & ~C) | (v & 1); break; // LSR
      case 3: r = (v >> 1) | ((this.p & C) << 7); this.p = (this.p & ~C) | (v & 1); break; // ROR
      case 6: r = (v - 1) & 0xff; break; // DEC
      default: r = (v + 1) & 0xff; break; // INC
    }
    this.setNZ(r);
    return r;
  }

  private readOp(op: number, v: number): void {
    switch (op & 3) {
      case 1: // the ALU group: ORA AND EOR ADC (STA) LDA CMP SBC
        switch (op >> 5) {
          case 0: this.a |= v; this.setNZ(this.a); return;
          case 1: this.a &= v; this.setNZ(this.a); return;
          case 2: this.a ^= v; this.setNZ(this.a); return;
          case 3: this.adc(v); return;
          case 5: this.a = v; this.setNZ(v); return;
          case 6: this.compare(this.a, v); return;
          default: this.sbc(v); return;
        }
      case 2: this.x = v; this.setNZ(v); return; // LDX
      default:
        switch (op >> 5) {
          case 1: // BIT
            this.p = (this.p & ~(N | V | Z)) | (v & (N | V)) | ((this.a & v) === 0 ? Z : 0);
            return;
          case 5: this.y = v; this.setNZ(v); return; // LDY
          case 6: this.compare(this.y, v); return; // CPY
          default: this.compare(this.x, v); return; // CPX
        }
    }
  }

  private compare(r: number, v: number): void {
    const d = r - v;
    this.p = (this.p & ~C) | (d >= 0 ? C : 0);
    this.setNZ(d & 0xff);
  }

  private adc(v: number): void {
    const a = this.a, c = this.p & C;
    if (!(this.p & D)) {
      const s = a + v + c;
      this.p = (this.p & ~(C | V)) | (s > 0xff ? C : 0) | (~(a ^ v) & (a ^ s) & 0x80 ? V : 0);
      this.a = s & 0xff;
      this.setNZ(this.a);
      return;
    }
    let al = (a & 0x0f) + (v & 0x0f) + c;
    if (al >= 0x0a) al = ((al + 0x06) & 0x0f) + 0x10;
    let s = (a & 0xf0) + (v & 0xf0) + al;
    const signed = ((a & 0xf0) << 24 >> 24) + ((v & 0xf0) << 24 >> 24) + al;
    let p = this.p & ~(N | V | Z | C);
    if (s & 0x80) p |= N;
    if (signed < -128 || signed > 127) p |= V;
    if (((a + v + c) & 0xff) === 0) p |= Z;
    if (s >= 0xa0) s += 0x60;
    if (s >= 0x100) p |= C;
    this.p = p;
    this.a = s & 0xff;
  }

  private sbc(v: number): void {
    const a = this.a, c = this.p & C;
    const d = a - v - (1 - c);
    this.p = (this.p & ~(C | V)) | (d >= 0 ? C : 0) | ((a ^ v) & (a ^ d) & 0x80 ? V : 0);
    this.setNZ(d & 0xff);
    if (!(this.p & D)) { this.a = d & 0xff; return; }
    let al = (a & 0x0f) - (v & 0x0f) + c - 1;
    if (al < 0) al = ((al - 0x06) & 0x0f) - 0x10;
    let s = (a & 0xf0) - (v & 0xf0) + al;
    if (s < 0) s -= 0x60;
    this.a = s & 0xff;
  }
}
