// The RV16 golden model: one instruction per step, exact 16-bit arithmetic, memory-mapped I/O at
// the top of data memory, and (with `system`) CSRs, traps and interrupts taken between
// instructions. Every step reports what it changed (register write, store, trap), which is what
// the core checks compare a learner's processor against. Halts on `jal x0, 0` (halt) or a store
// to EXIT.

import {
  CAUSE, CSR16, decode16, MIP_MEIP, CSR16_UNUSED, MMIO16, MMIO_BASE, MSTATUS_MIE, MSTATUS_MPIE, SCREEN16_IO, sext,
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
  /** Data addresses below MMIO wrap around dmemWords, like a small RAM decoded on its low bits only. */
  wrap?: boolean;
  /**
   * Act 10's boot puzzle: a DMA engine (registers at DMA_DEV16.SRC … DMA_DEV16.CLEAR) copying a word every DMA_DEV16.WORD cycles
   * while the program runs, raising the interrupt line when done, and flash at DMA_DEV16.FLASH … DMA_DEV16.FLASH_END: read-only,
   * each load stalling the processor DMA_DEV16.STALL cycles. Steps then count cycles, stalls included.
   */
  dma?: boolean;
  /**
   * The core benches' screen (SCREEN16_IO): a store to BASE … BASE + 1023 paints pixel (x, y) = (a & 31, (a >> 5) & 31)
   * of `screen` instead of writing the data memory; a load there reads the data memory as at any other address.
   */
  screen?: boolean;
}

/** The boot puzzle's devices (Iss16Options.dma): DMA registers below the MMIO block, flash in the upper half. */
export const DMA_DEV16 = { SRC: 0xfff0, DST: 0xfff1, LEN: 0xfff2, CLEAR: 0xfff3, WORD: 4, FLASH: 0x8000, FLASH_END: 0xbfff, STALL: 8 } as const;

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
  written = 0b1;
  /** The DMA engine (opts.dma): its pointers, the words left, the cycles towards the next word. */
  dma = { src: 0, dst: 0, left: 0, acc: 0 };
  /** The screen's pixels (opts.screen), RGB565, row by row. */
  screen = new Uint16Array(SCREEN16_IO.SIZE * SCREEN16_IO.SIZE);
  /** Cycles the current instruction stalls (a flash load). */
  private stall = 0;
  readonly opts: Required<Iss16Options>;

  constructor(program: ArrayLike<number>, opts: Iss16Options = {}, data?: Map<number, number>) {
    this.opts = { dmemWords: 65536, m: false, system: false, strictInit: false, wrap: false, dma: false, screen: false, ...opts };
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
    if (this.opts.dma) {
      if (a === DMA_DEV16.LEN) return this.dma.left;
      if (a >= DMA_DEV16.SRC && a <= DMA_DEV16.CLEAR) return 0;
      if (a >= DMA_DEV16.FLASH && a <= DMA_DEV16.FLASH_END) this.stall += DMA_DEV16.STALL;
    }
    if (a >= MMIO_BASE) {
      switch (a) {
        case MMIO16.IN: return this.input.length ? this.input.shift()! & M16 : 0;
        case MMIO16.LEDS: return this.leds;
        case MMIO16.SWITCHES: return this.switches & M16;
        case MMIO16.IRQ: return this.irq;
        default: return 0;
      }
    }
    if (this.opts.wrap) a %= this.dmem.length;
    return a < this.dmem.length ? this.dmem[a] : 0;
  }

  private store(a: number, v: number, info: Step16): void {
    a &= M16;
    v &= M16;
    info.store = { addr: a, value: v };
    if (this.opts.dma) {
      const d = this.dma;
      switch (a) {
        case DMA_DEV16.SRC: d.src = v; return;
        case DMA_DEV16.DST: d.dst = v; return;
        case DMA_DEV16.LEN: d.left = v; d.acc = 0; if (!v) this.irq = 1; return;
        case DMA_DEV16.CLEAR: this.irq = 0; return;
      }
      if (a >= DMA_DEV16.FLASH && a <= DMA_DEV16.FLASH_END) throw new Error(`a store to flash (0x${a.toString(16)}): flash is not written by stores`);
    }
    if (this.opts.screen && a >= SCREEN16_IO.BASE && a < SCREEN16_IO.BASE + this.screen.length) {
      this.screen[a - SCREEN16_IO.BASE] = v;
      return;
    }
    if (a >= MMIO_BASE) {
      switch (a) {
        case MMIO16.EXIT: this.exitCode = v; this.halted = true; break;
        case MMIO16.CONSOLE: this.console += String.fromCharCode(v & 0xff); break;
        case MMIO16.OUT: this.out.push(v); break;
        case MMIO16.LEDS: this.leds = v; break;
        case MMIO16.IRQ: this.irq = v & 1; break;
      }
      return;
    }
    if (this.opts.wrap) a %= this.dmem.length;
    if (a < this.dmem.length) this.dmem[a] = v;
  }

  /** Pending interrupt cause, if any is enabled. */
  private pendingIrq(): number | null {
    if (!this.opts.system) return null;
    let mip = this.csr[CSR16.mip] & ~MIP_MEIP;
    if (this.irq) mip |= MIP_MEIP;
    this.csr[CSR16.mip] = mip;
    if (!(this.csr[CSR16.mstatus] & MSTATUS_MIE)) return null;
    const p = mip & this.csr[CSR16.mie];
    if (p & MIP_MEIP) return CAUSE.external;
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
    if (!this.opts.dma) return this.exec();
    const s0 = this.steps;
    this.stall = 0;
    const info = this.exec();
    this.steps += this.stall;
    this.runDma(this.steps - s0);
    return info;
  }

  /** The DMA engine over `cycles` cycles: a word every DMA_DEV16.WORD, the interrupt line raised after the last. */
  private runDma(cycles: number): void {
    const d = this.dma;
    if (!d.left) return;
    d.acc += cycles;
    while (d.left && d.acc >= DMA_DEV16.WORD) {
      d.acc -= DMA_DEV16.WORD;
      this.dmem[d.dst] = this.dmem[d.src];
      d.src = (d.src + 1) & M16;
      d.dst = (d.dst + 1) & M16;
      if (!--d.left) { this.irq = 1; d.acc = 0; }
    }
  }

  private exec(): Step16 {
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
      // SIMT instructions are the lane cores' (simt16.ts runs them): on a scalar core they are illegal.
      if (!s || (s.ext === 'm' && !this.opts.m) || (s.ext === 'system' && !this.opts.system) || s.ext === 'simt') illegal();
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
            const old = d.csr === CSR16_UNUSED ? 0 : d.csr === CSR16.mip ? (this.pendingIrq(), this.csr[CSR16.mip]) : this.csr[d.csr];
            const src = this.rd(d.rs1);
            const val = s.name === 'csrrw' ? src : s.name === 'csrrs' ? old | src : old & ~src;
            // csrrs / csrrc with rs1 = x0 do not write; CSR 7 (none) and mip's interrupt bits are read-only.
            if ((s.name === 'csrrw' || d.rs1 !== 0) && d.csr !== CSR16_UNUSED) this.csr[d.csr] = d.csr === CSR16.mip ? old : val & M16;
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
    return info;
  }

  /** The data address the next step loads from (null: it is no load, or the machine halts or takes an interrupt first). */
  nextLoad(): number | null {
    if (this.halted) return null;
    const c = this.csr;
    if (this.opts.system && this.irq && c[CSR16.mstatus] & MSTATUS_MIE && c[CSR16.mie] & MIP_MEIP) return null;
    const d = decode16(this.pc < this.imem.length ? this.imem[this.pc] : 0);
    return d.spec?.name === 'lw' ? (this.x[d.rs1] + d.imm) & M16 : null;
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
      irq: this.irq, written: this.written, dma: { ...this.dma }, screen: this.screen.slice(),
    };
  }

  restore(v: Iss16State): void {
    Object.assign(this, { ...v, x: v.x.slice(), dmem: v.dmem.slice(), csr: v.csr.slice(), out: [...v.out], input: [...v.input], dma: { ...v.dma }, screen: v.screen.slice() });
  }
}

export interface Iss16State {
  pc: number; x: Uint16Array; dmem: Uint16Array; csr: Uint16Array; steps: number; halted: boolean; error: string | null;
  exitCode: number | null; console: string; out: number[]; input: number[]; leds: number; switches: number;
  irq: number; written: number; dma: { src: number; dst: number; left: number; acc: number }; screen: Uint16Array;
}
