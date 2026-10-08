// The RV16 golden model: one instruction per step, exact 16-bit arithmetic, memory-mapped I/O at
// the top of data memory, and (with `system`) CSRs, traps and interrupts taken between
// instructions. Every step reports what it changed (register write, store, trap), which is what
// the core checks compare a learner's processor against. Halts on `jal x0, 0` (halt) or a store
// to EXIT.

import {
  CAUSE, CSR16, decode16, MIP_MEIP, MIP_MTIP, MMIO16, MMIO_BASE, MSTATUS_MIE, MSTATUS_MPIE, sext,
} from './isa16';

export interface Iss16Options {
  /** Data memory words (default 65536: the whole address space). */
  dmemWords?: number;
  /** The MD opcode (mul / div / rem) is legal. */
  m?: boolean;
  /** CSRs, ecall / ebreak / mret / wfi, traps and interrupts (otherwise SYSTEM is illegal). */
  system?: boolean;
  /** Reading a register that was never written is an error (tests: the hardware powers up unknown). */
  strictInit?: boolean;
}

export interface Step16 {
  pc: number;
  instr: number;
  /** Register written (never x0). */
  reg?: { rd: number; value: number };
  /** Store (data memory or MMIO). */
  store?: { addr: number; value: number };
  /** A trap taken instead of executing (cause), or after executing (ecall, ebreak, illegal). */
  trap?: number;
}

const M16 = 0xffff;
const s16 = (v: number) => sext(v, 16);

export class Iss16 {
  pc = 0;
  x = new Uint16Array(8);
  imem: Uint16Array;
  dmem: Uint16Array;
  csr = new Uint16Array(8);
  steps = 0;
  halted = false;
  /** Why it stopped, when not by a clean halt (an illegal instruction without `system`, …). */
  error: string | null = null;
  exitCode: number | null = null;
  // MMIO
  console = '';
  out: number[] = [];
  input: number[] = [];
  leds = 0;
  switches = 0;
  /** External interrupt line (also set by a store of 1 to IRQ). */
  irq = 0;
  mtime = 0;
  mtimecmp = 0xffff;
  written = 0b1;
  readonly opts: Required<Iss16Options>;

  constructor(program: ArrayLike<number>, opts: Iss16Options = {}, data?: Map<number, number>) {
    this.opts = { dmemWords: 65536, m: false, system: false, strictInit: false, ...opts };
    this.imem = new Uint16Array(Math.max(1, program.length));
    this.imem.set(Array.from(program, (w) => w & M16));
    this.dmem = new Uint16Array(this.opts.dmemWords);
    for (const [a, v] of data ?? []) if (a < this.dmem.length) this.dmem[a] = v & M16;
  }

  private rd(r: number): number {
    if (this.opts.strictInit && !((this.written >> r) & 1)) throw new Error(`x${r} read before it was written`);
    return this.x[r];
  }

  private wr(r: number, v: number, info: Step16): void {
    if (!r) return;
    this.x[r] = v & M16;
    this.written |= 1 << r;
    info.reg = { rd: r, value: v & M16 };
  }

  private load(a: number): number {
    a &= M16;
    if (a >= MMIO_BASE) {
      switch (a) {
        case MMIO16.IN: return this.input.length ? this.input.shift()! & M16 : 0;
        case MMIO16.LEDS: return this.leds;
        case MMIO16.SWITCHES: return this.switches & M16;
        case MMIO16.IRQ: return this.irq;
        case MMIO16.MTIME: return this.mtime & M16;
        case MMIO16.MTIMECMP: return this.mtimecmp;
        default: return 0;
      }
    }
    return a < this.dmem.length ? this.dmem[a] : 0;
  }

  private store(a: number, v: number, info: Step16): void {
    a &= M16;
    v &= M16;
    info.store = { addr: a, value: v };
    if (a >= MMIO_BASE) {
      switch (a) {
        case MMIO16.EXIT: this.exitCode = v; this.halted = true; break;
        case MMIO16.CONSOLE: this.console += String.fromCharCode(v & 0xff); break;
        case MMIO16.OUT: this.out.push(v); break;
        case MMIO16.LEDS: this.leds = v; break;
        case MMIO16.IRQ: this.irq = v & 1; break;
        case MMIO16.MTIMECMP: this.mtimecmp = v; break;
      }
      return;
    }
    if (a < this.dmem.length) this.dmem[a] = v;
  }

  /** Pending interrupt cause, if any is enabled. */
  private pendingIrq(): number | null {
    if (!this.opts.system) return null;
    let mip = this.csr[CSR16.mip] & ~(MIP_MTIP | MIP_MEIP);
    if (this.mtime >= this.mtimecmp) mip |= MIP_MTIP;
    if (this.irq) mip |= MIP_MEIP;
    this.csr[CSR16.mip] = mip;
    if (!(this.csr[CSR16.mstatus] & MSTATUS_MIE)) return null;
    const p = mip & this.csr[CSR16.mie];
    if (p & MIP_MEIP) return CAUSE.external;
    if (p & MIP_MTIP) return CAUSE.timer;
    return null;
  }

  private trap(cause: number, epc: number): void {
    const st = this.csr[CSR16.mstatus];
    this.csr[CSR16.mepc] = epc & M16;
    this.csr[CSR16.mcause] = cause;
    this.csr[CSR16.mstatus] = (st & ~(MSTATUS_MIE | MSTATUS_MPIE)) | (st & MSTATUS_MIE ? MSTATUS_MPIE : 0);
    this.pc = this.csr[CSR16.mtvec];
  }

  private fail(msg: string): void {
    this.error = msg;
    this.halted = true;
  }

  step(): Step16 {
    const pc = this.pc;
    const instr = pc < this.imem.length ? this.imem[pc] : 0;
    const info: Step16 = { pc, instr };
    if (this.halted) return info;
    const irq = this.pendingIrq();
    if (irq !== null) {
      this.trap(irq, pc);
      info.trap = irq;
      this.steps++;
      return info;
    }
    const d = decode16(instr);
    const s = d.spec;
    let next = (pc + 1) & M16;
    const illegal = () => {
      if (this.opts.system) {
        this.trap(CAUSE.illegal, pc);
        info.trap = CAUSE.illegal;
        next = this.pc;
      } else this.fail(`illegal instruction 0x${instr.toString(16).padStart(4, '0')} at 0x${pc.toString(16)}`);
    };
    try {
      if (!s || (s.ext === 'm' && !this.opts.m) || (s.ext === 'system' && !this.opts.system)) illegal();
      else {
        const a = () => this.rd(d.rs1), b = () => this.rd(d.rs2);
        switch (s.name) {
          case 'add': this.wr(d.rd, a() + b(), info); break;
          case 'sub': this.wr(d.rd, a() - b(), info); break;
          case 'sll': this.wr(d.rd, a() << (b() & 15), info); break;
          case 'slt': this.wr(d.rd, s16(a()) < s16(b()) ? 1 : 0, info); break;
          case 'sltu': this.wr(d.rd, a() < b() ? 1 : 0, info); break;
          case 'xor': this.wr(d.rd, a() ^ b(), info); break;
          case 'srl': this.wr(d.rd, a() >>> (b() & 15), info); break;
          case 'sra': this.wr(d.rd, s16(a()) >> (b() & 15), info); break;
          case 'or': this.wr(d.rd, a() | b(), info); break;
          case 'and': this.wr(d.rd, a() & b(), info); break;
          case 'mul': this.wr(d.rd, Math.imul(a(), b()), info); break;
          case 'mulh': this.wr(d.rd, (s16(a()) * s16(b())) >> 16, info); break;
          case 'mulhsu': this.wr(d.rd, (s16(a()) * b()) >> 16, info); break;
          case 'mulhu': this.wr(d.rd, (a() * b()) >>> 16, info); break;
          case 'div': { const x = s16(a()), y = s16(b()); this.wr(d.rd, y === 0 ? -1 : x === -32768 && y === -1 ? x : Math.trunc(x / y), info); break; }
          case 'divu': { const x = a(), y = b(); this.wr(d.rd, y === 0 ? M16 : Math.floor(x / y), info); break; }
          case 'rem': { const x = s16(a()), y = s16(b()); this.wr(d.rd, y === 0 ? x : x === -32768 && y === -1 ? 0 : x % y, info); break; }
          case 'remu': { const x = a(), y = b(); this.wr(d.rd, y === 0 ? x : x % y, info); break; }
          case 'addi': this.wr(d.rd, a() + d.imm, info); break;
          case 'slli': this.wr(d.rd, a() << d.imm, info); break;
          case 'srli': this.wr(d.rd, a() >>> d.imm, info); break;
          case 'srai': this.wr(d.rd, s16(a()) >> d.imm, info); break;
          case 'lui': this.wr(d.rd, d.imm, info); break;
          case 'lw': this.wr(d.rd, this.load(a() + d.imm), info); break;
          case 'sw': this.store(a() + d.imm, b(), info); break;
          case 'beq': if (a() === b()) next = (pc + d.imm) & M16; break;
          case 'bne': if (a() !== b()) next = (pc + d.imm) & M16; break;
          case 'blt': if (s16(a()) < s16(b())) next = (pc + d.imm) & M16; break;
          case 'bge': if (s16(a()) >= s16(b())) next = (pc + d.imm) & M16; break;
          case 'jal': this.wr(d.rd, pc + 1, info); next = (pc + d.imm) & M16; break;
          case 'jalr': { const t = (a() + d.imm) & M16; this.wr(d.rd, pc + 1, info); next = t; break; }
          case 'ecall': this.trap(CAUSE.ecall, pc); info.trap = CAUSE.ecall; next = this.pc; break;
          case 'ebreak': this.trap(CAUSE.breakpoint, pc); info.trap = CAUSE.breakpoint; next = this.pc; break;
          case 'mret': {
            const st = this.csr[CSR16.mstatus];
            this.csr[CSR16.mstatus] = (st & ~MSTATUS_MIE) | (st & MSTATUS_MPIE ? MSTATUS_MIE : 0) | MSTATUS_MPIE;
            next = this.csr[CSR16.mepc];
            break;
          }
          case 'wfi': break;
          case 'csrrw': case 'csrrs': case 'csrrc': {
            const old = d.csr === CSR16.mcycle ? this.steps & M16 : d.csr === CSR16.mip ? (this.pendingIrq(), this.csr[CSR16.mip]) : this.csr[d.csr];
            const src = this.rd(d.rs1);
            const val = s.name === 'csrrw' ? src : s.name === 'csrrs' ? old | src : old & ~src;
            // csrrs / csrrc with rs1 = x0 do not write; mcycle and mip's interrupt bits are read-only.
            if ((s.name === 'csrrw' || d.rs1 !== 0) && d.csr !== CSR16.mcycle) this.csr[d.csr] = d.csr === CSR16.mip ? old : val & M16;
            this.wr(d.rd, old, info);
            break;
          }
        }
      }
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return info;
    }
    if (this.halted) {
      this.steps++;
      return info;
    }
    // halt = jal x0, 0. A branch to itself is a spin (waiting for an interrupt), not a halt.
    if (s?.name === 'jal' && d.imm === 0 && !info.trap) this.halted = true;
    this.pc = next;
    this.steps++;
    this.mtime = (this.mtime + 1) & M16;
    return info;
  }

  /** Run to a halt or `max` steps; returns the steps executed. */
  run(max = 100000): number {
    const s0 = this.steps;
    while (!this.halted && this.steps - s0 < max) this.step();
    return this.steps - s0;
  }

  save(): Iss16State {
    return {
      pc: this.pc, x: this.x.slice(), dmem: this.dmem.slice(), csr: this.csr.slice(), steps: this.steps, halted: this.halted, error: this.error,
      exitCode: this.exitCode, console: this.console, out: [...this.out], input: [...this.input], leds: this.leds, switches: this.switches,
      irq: this.irq, mtime: this.mtime, mtimecmp: this.mtimecmp, written: this.written,
    };
  }

  restore(v: Iss16State): void {
    Object.assign(this, { ...v, x: v.x.slice(), dmem: v.dmem.slice(), csr: v.csr.slice(), out: [...v.out], input: [...v.input] });
  }
}

export interface Iss16State {
  pc: number; x: Uint16Array; dmem: Uint16Array; csr: Uint16Array; steps: number; halted: boolean; error: string | null;
  exitCode: number | null; console: string; out: number[]; input: number[]; leds: number; switches: number;
  irq: number; mtime: number; mtimecmp: number; written: number;
}
