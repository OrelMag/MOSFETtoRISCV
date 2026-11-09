// Instruction-set simulator: the golden model. It executes RV32I exactly as the
// specification says, with the same memory organisation as our CPUs (separate instruction
// and data memories; the data memory wraps around its size), so the gate-level processors
// can be checked against it instruction by instruction.
//
// With `system: true` it also models the full machine-mode system of the complete CPU:
// memory-mapped I/O, CSRs, exceptions and interrupts (one step = one clock cycle; a cycle in
// which an interrupt is taken executes no instruction).
//
// `vm: true` (with system) adds privilege modes and Sv32 virtual memory; without it every line below is dead and the
// machine is what it always was (mstatus.MPP wired to 11, the system CPU of lib/system.ts runs in lock step with it).
//   - Modes M, S, U (ISS.priv 3, 1, 0). Decision D1 of docs/PLAN-VM-OS.md: every trap is taken in M (medeleg / mideleg
//     read zero, writes ignored), so S never runs a handler of its own; the S CSRs exist for S-mode software and for sret.
//     ecall is cause 8 / 9 / 11 from U / S / M. An interrupt is taken when priv < M or MIE (mip.MTIP from mtime).
//   - mstatus: SIE MIE SPIE MPIE SPP MPP(2 bits, WARL: 2 reads back as U) SUM MXR FS(2 bits, storage only) SD. TVM, TW, TSR and
//     MPRV read zero (a deviation from the specification, which makes MPRV writable once U exists: M never translates here).
//     Reset: priv M, MPP = U, like Spike with U. mret (M only) goes to MPP, sets MPP = U; sret (S or M) goes to SPP, sets SPP = U.
//     sstatus is the view of SIE SPIE SPP SUM MXR FS SD. wfi is illegal in U; sfence.vma is a no-op (no TLB) and illegal in U.
//   - CSR access above the current mode, a write to a read-only CSR (address bits 11:10 = 11) and the cycle counter below M
//     (mcounteren and scounteren read zero) are illegal instructions (cause 2, mtval 0 as ever).
//   - satp: MODE (bit 31), ASID (stored, ignored) and a 22-bit PPN. Sv32 applies to fetches, loads and stores in S and U while
//     MODE = 1; M never translates. The walk is the specification's: two levels, V / R W X / U / SUM / MXR checks, a misaligned
//     superpage faults, and (decision D2) A = 0, or D = 0 on a store, is a page fault, so software keeps A and D and the walker
//     never writes. Page faults are causes 12 (fetch), 13 (load), 15 (store / AMO) with mtval = the faulting virtual address.
//   - Physical memory is the ISS's own: instruction fetches index the instruction memory, loads and stores the data memory, both
//     wrapping around their size, I/O at bit 31 as before. A walk reads its PTEs from the DATA memory (or the bus). An access
//     fault (cause 1 / 5 / 7 for a fetch / load / store, mtval = the virtual address, as the specification wants for a PTE
//     read: the access fault of the ORIGINAL access) happens when a PTE address, or the final physical address, is not
//     below 2^32 (Sv32 physical addresses are 34 bits), and when a PTE is read from I/O space (bit 31 set).
//   - ISS.lastWalk is the last translation (virtual address, its fields, the PTE addresses and values read, the physical
//     address or the fault); StepInfo.walks lists the ones a step made, StepInfo.priv the mode it ran in.

import type { BusMemory } from '../bus/model';
import { accAfter, MAC_F3, raccOf } from '../dsp/mac';
import { aluCtlOf, aluOp, branchTaken, FMT_FIELDS, type CustomRow } from './custom';
import { F32, fpAddX, fpClass, fpCmpX, fpDivX, fpFmaX, fpFromIntX, fpMinMaxX, fpMulX, fpSqrtX, fpToIntX, type FpResult } from '../sim/fpref';
import { CSRS, decode, disasm, OPCODES } from './isa';
import { disasmC, expand16 } from './rvc';

export interface IssOptions {
  /** Data memory size in 32-bit words (power of two). */
  dmemWords?: number;
  /** Instruction memory size in words (power of two). */
  imemWords?: number;
  /** Model I/O, CSRs, traps and interrupts. */
  system?: boolean;
  /**
   * Memory-mapped I/O without the rest of the system (no CSRs, traps or timer): the console, LEDs
   * and switches at IO.CONSOLE / LEDS / SWITCHES, decoded exactly; any other address with bit 31 set
   * is a device the model does not know (a screen): stores to it are dropped, loads read 0.
   */
  mmio?: boolean;
  /** Implement the M extension (otherwise its encodings are illegal in system mode). */
  m?: boolean;
  /** Implement the F subset (otherwise illegal in system mode). */
  f?: boolean;
  /** Hart id read by csrr mhartid (multi-core). */
  hartid?: number;
  /**
   * Memory over a bus (chapter 38's computer): instructions beyond the ROM's imemWords are fetched from
   * it, and every load and store that is not I/O goes to it instead of dmem.
   */
  bus?: BusMemory;
  /** The CPU's custom instructions (riscv/custom.ts): each executes its control row. */
  custom?: readonly CustomRow[];
  /** The MAC core (dsp/mac.ts, chapter "A MAC on the RV32"): mac, mac2, clracc and racc on custom-2, one 40-bit accumulator. */
  mac?: boolean;
  /** Tests only (tests/dsp-mac-mutants.test.ts): the MAC's arithmetic replaced by a deliberately wrong one, to show that the lock-step comparison notices. */
  macMutant?: { accAfter?: typeof accAfter; raccOf?: typeof raccOf };
  /** The C extension (riscv/rvc.ts): instructions are fetched as 16-bit parcels at any even address. */
  c?: boolean;
  /** Privilege modes M / S / U and Sv32 (see the header; needs `system`). Off: the machine-mode-only system. */
  vm?: boolean;
}

/** Privilege levels (the encoding of mstatus.MPP and the commit log's first digit). */
export const PRIV = { U: 0, S: 1, M: 3 } as const;

/** One Sv32 translation, for the widgets that draw a walk. */
export interface Walk {
  va: number;
  access: 'fetch' | 'load' | 'store';
  priv: number;
  /** The PTEs read, root first: the physical address, its value and the level (1 = root table, 0 = leaf table). */
  ptes: { addr: number; pte: number; level: number }[];
  /** The physical address (a number: Sv32 has 34 bits); absent on a fault. */
  pa?: number;
  /** A 4 MiB superpage ended the walk at level 1. */
  superpage?: boolean;
  /** The trap cause when it faulted (page fault 12 / 13 / 15, access fault 1 / 5 / 7). */
  fault?: number;
}


/** Cycles a div / divu / rem / remu occupies on the iterative divider (1 load + 32 steps + 1 write). */
export const DIV_CYCLES = 34;
/** Cycles fdiv.s and fsqrt.s occupy on the iterative units of the single-cycle FPU (1 load + 27 or 26 steps + 1 write). */
export const FDIV_CYCLES = 29, FSQRT_CYCLES = 28;

/** RV32M arithmetic, exactly as specified (including division by zero and overflow). */
export function mExec(f3: number, a: number, b: number): number {
  const sa = BigInt(a | 0), sb = BigInt(b | 0), ua = BigInt(a >>> 0), ub = BigInt(b >>> 0);
  const lo = (v: bigint) => Number(BigInt.asUintN(32, v));
  const hi = (v: bigint) => Number(BigInt.asUintN(32, v >> 32n));
  switch (f3) {
    case 0: return lo(sa * sb);
    case 1: return hi(sa * sb);
    case 2: return hi(sa * ub);
    case 3: return hi(ua * ub);
    case 4: if (b === 0) return 0xffffffff; if ((a | 0) === -0x80000000 && (b | 0) === -1) return 0x80000000; return lo(sa / sb);
    case 5: if (b === 0) return 0xffffffff; return lo(ua / ub);
    case 6: if (b === 0) return a >>> 0; if ((a | 0) === -0x80000000 && (b | 0) === -1) return 0; return lo(sa % sb);
    default: if (b === 0) return a >>> 0; return lo(ua % ub);
  }
}

export interface StepInfo {
  pc: number;
  /** The instruction executed: a 16-bit one's expansion. */
  word: number;
  /** A 16-bit instruction's own bits (C extension). */
  half?: number;
  text: string;
  /** Register written (0 = none). */
  rd: number;
  value?: number;
  store?: { addr: number; value: number };
  /** Floating-point register written (RV32F). */
  fwrite?: { rd: number; value: number };
  trap?: { cause: number; interrupt: boolean; tval?: number };
  halted: boolean;
  /** vm: the privilege level the step ran in (before a trap changed it). */
  priv?: number;
  /** vm: the Sv32 walks of this step (fetch, then the data access), when translation was on. */
  walks?: Walk[];
}

/** I/O addresses (bit 31 set selects I/O; bits 4:2 select the device register). */
export const IO = { CONSOLE: 0x80000000, LEDS: 0x80000004, SWITCHES: 0x80000008, MTIME: 0x80000010, MTIMECMP: 0x80000014 } as const;

export const CAUSE = {
  MISALIGNED_FETCH: 0, FETCH_ACCESS: 1, ILLEGAL: 2, BREAKPOINT: 3, MISALIGNED_LOAD: 4, LOAD_ACCESS: 5, MISALIGNED_STORE: 6, STORE_ACCESS: 7,
  ECALL_U: 8, ECALL_S: 9, ECALL: 11, FETCH_PAGE: 12, LOAD_PAGE: 13, STORE_PAGE: 15,
  TIMER_IRQ: 0x80000007, EXTERNAL_IRQ: 0x8000000b,
} as const;

/** mstatus bits of the vm option. */
const MS = { SIE: 1 << 1, MIE: 1 << 3, SPIE: 1 << 5, MPIE: 1 << 7, SPP: 1 << 8, MPP: 3 << 11, FS: 3 << 13, SUM: 1 << 18, MXR: 1 << 19, SD: 1 << 31 };
const SSTATUS_MASK = MS.SIE | MS.SPIE | MS.SPP | MS.FS | MS.SUM | MS.MXR | MS.SD;
const TWO32 = 2 ** 32;

class Trap {
  constructor(readonly cause: number, readonly tval = 0) {}
}

export class ISS {
  readonly x = new Uint32Array(32);
  pc = 0;
  readonly imem: number[];
  /** Data memory; harts of a multi-core system share one array. */
  dmem: Uint32Array;
  readonly hartid: number;
  /** Memory over a bus (IssOptions.bus). */
  readonly bus: BusMemory | undefined;
  halted = false;
  steps = 0;
  /** lr.w / sc.w: the reservation, on the 16-byte line (the granule of the coherent caches) of the lr.w's address. */
  resValid = false;
  resLine = 0;
  readonly system: boolean;
  /** I/O at 0x8000_0000 (system or mmio). */
  readonly io: boolean;
  readonly m: boolean;
  readonly custom: readonly CustomRow[];
  /** IssOptions.vm. */
  readonly vm: boolean;
  /** Current privilege level (PRIV): always M without vm. */
  priv: number = PRIV.M;
  /** The last Sv32 translation made by a step (null: none yet). */
  lastWalk: Walk | null = null;
  /** The MAC core's instructions are legal (IssOptions.mac), and the accumulator they share (40 bits, signed). */
  readonly mac: boolean;
  acc = 0n;
  /** (not enumerable: save() and structuredClone see fields only) */
  private readonly macFns!: { accAfter: typeof accAfter; raccOf: typeof raccOf };
  readonly fext: boolean;
  /** The C extension: 16-bit instructions, PC + 2 after one, jumps to any even address. */
  readonly c: boolean;
  /** Floating-point registers (raw float32 bits). */
  readonly f = new Uint32Array(32);
  /** fcsr: accrued exception flags (NV DZ OF UF NX) and the dynamic rounding mode. */
  fflags = 0;
  frm = 0;
  private readonly imemWords: number;

  // machine-mode state
  mie = false; // mstatus.MIE
  mpie = false; // mstatus.MPIE
  mtie = false; // mie.MTIE
  meie = false; // mie.MEIE
  mtvec = 0;
  mscratch = 0;
  mepc = 0;
  mcause = 0;
  mtval = 0;
  // vm: mstatus fields beyond MIE / MPIE, the S CSRs and satp
  mpp: number = PRIV.U;
  spp = false;
  sie = false;
  spie = false;
  sum = false;
  mxr = false;
  fs = 0;
  satp = 0;
  stvec = 0;
  sscratch = 0;
  sepc = 0;
  scause = 0;
  stval = 0;
  // devices
  mtime = 0;
  mtimecmp = 0;
  leds = 0;
  switches = 0;
  irq = false;
  console = '';
  /** Instructions retired (excludes trap-entry cycles and trapping instructions). */
  retired = 0;

  /** Every field, for stepping back (see restore). */
  save(): ModelState {
    return saveFields(this);
  }

  restore(s: ModelState): void {
    restoreFields(this, s);
  }

  constructor(program: number[], opts: IssOptions = {}) {
    this.imem = program.slice();
    this.dmem = new Uint32Array(opts.dmemWords ?? 32);
    this.imemWords = opts.imemWords ?? 64;
    this.system = !!opts.system;
    this.vm = !!opts.vm;
    if (this.vm && !this.system) throw new Error('ISS: vm needs system');
    if (!this.vm) this.mpp = PRIV.M;
    this.io = this.system || !!opts.mmio;
    this.m = !!opts.m;
    this.custom = opts.custom ?? [];
    this.mac = !!opts.mac;
    Object.defineProperty(this, 'macFns', { value: { accAfter, raccOf, ...opts.macMutant }, enumerable: false });
    this.fext = !!opts.f;
    this.c = !!opts.c;
    this.hartid = opts.hartid ?? 0;
    this.bus = opts.bus;
  }

  fetch(pc: number): number {
    if (this.bus && pc >>> 0 >= 4 * this.imemWords) return this.bus.read((pc & ~3) >>> 0);
    return this.imem[(pc >>> 2) % this.imemWords] ?? 0x00000013;
  }

  /** The 16-bit parcel at an even address of the instruction memory. */
  private half(a: number): number {
    return (this.fetch((a & ~3) >>> 0) >>> ((a & 2) * 8)) & 0xffff;
  }

  /** Is Sv32 on for an access at this privilege level (S or U with satp.MODE = 1)? */
  translating(priv = this.priv): boolean {
    return this.vm && priv !== PRIV.M && this.satp >>> 31 === 1;
  }

  /**
   * The Sv32 walk of one access, without side effects (the widgets and instrAt use it; step records it). A PTE is read as
   * a data-memory word (or from the bus); see the header for the access faults.
   */
  walk(va: number, access: Walk['access'], priv = this.priv): Walk {
    va >>>= 0;
    const w: Walk = { va, access, priv, ptes: [] };
    const page = access === 'fetch' ? CAUSE.FETCH_PAGE : access === 'load' ? CAUSE.LOAD_PAGE : CAUSE.STORE_PAGE;
    const acc = access === 'fetch' ? CAUSE.FETCH_ACCESS : access === 'load' ? CAUSE.LOAD_ACCESS : CAUSE.STORE_ACCESS;
    if (!this.translating(priv)) { w.pa = va; return w; }
    let table = (this.satp & 0x3fffff) * 4096;
    for (let level = 1; level >= 0; level--) {
      const addr = table + ((va >>> (12 + 10 * level)) & 0x3ff) * 4;
      if (addr >= TWO32 || (this.io && addr >= 0x80000000)) { w.fault = acc; return w; }
      const pte = this.readWord(addr >>> 0);
      w.ptes.push({ addr, pte, level });
      const v = pte & 1, r = (pte >>> 1) & 1, wr = (pte >>> 2) & 1, x = (pte >>> 3) & 1, u = (pte >>> 4) & 1, a = (pte >>> 6) & 1, d = (pte >>> 7) & 1;
      if (!v || (!r && wr)) { w.fault = page; return w; }
      const ppn = pte >>> 10;
      if (!r && !x) {
        // a pointer to the next table: A, D and U are reserved there; none at the last level
        if (level === 0 || (pte & 0xd0)) { w.fault = page; return w; }
        table = ppn * 4096;
        continue;
      }
      if (level === 1 && (ppn & 0x3ff)) { w.fault = page; return w; } // misaligned superpage
      if (u ? priv === PRIV.S && (access === 'fetch' || !this.sum) : priv !== PRIV.S) { w.fault = page; return w; }
      if (access === 'fetch' ? !x : access === 'load' ? !(r || (this.mxr && x)) : !wr) { w.fault = page; return w; }
      if (!a || (access === 'store' && !d)) { w.fault = page; return w; }
      const pa = (level === 1 ? (ppn | ((va >>> 12) & 0x3ff)) : ppn) * 4096 + (va & 0xfff);
      w.superpage = level === 1;
      if (pa >= TWO32) { w.fault = acc; return w; }
      w.pa = pa;
      return w;
    }
    w.fault = page;
    return w;
  }

  /** The physical address of an access, or the trap it raises (the walk recorded in lastWalk and the step's list). */
  private translate(va: number, access: Walk['access']): number {
    if (!this.translating()) return va >>> 0;
    const w = this.walk(va, access);
    this.lastWalk = w;
    this.stepWalks.push(w);
    if (w.fault !== undefined) throw new Trap(w.fault, va >>> 0);
    return w.pa! >>> 0;
  }
  private stepWalks: Walk[] = [];

  private wordIndex(addr: number): number {
    return (addr >>> 2) & (this.dmem.length - 1);
  }

  private isIo(addr: number): boolean {
    return this.io && addr >= 0x80000000;
  }

  /** mmio without system: the device register at addr (0 console, 1 LEDs, 2 switches; -1 none). */
  private mmioReg(addr: number): number {
    const a = (addr & ~3) >>> 0;
    return a === IO.CONSOLE ? 0 : a === IO.LEDS ? 1 : a === IO.SWITCHES ? 2 : -1;
  }

  private ioRead(addr: number): number {
    if (!this.system) {
      const r = this.mmioReg(addr);
      return r === 1 ? this.leds : r === 2 ? this.switches : 0;
    }
    switch ((addr >>> 2) & 7) {
      case 1: return this.leds;
      case 2: return this.switches;
      case 4: return this.mtime;
      case 5: return this.mtimecmp;
      default: return 0;
    }
  }

  /** Read the 32-bit word containing addr (memory or I/O). */
  private readWord(addr: number): number {
    if (this.isIo(addr)) return this.ioRead(addr) >>> 0;
    return this.bus ? this.bus.read((addr & ~3) >>> 0) >>> 0 : this.dmem[this.wordIndex(addr)];
  }

  /** When set, every data-memory access (not I/O) is appended here: for cache studies. */
  memTrace: { addr: number; write: boolean }[] | null = null;

  load(addr: number, f3: number): number {
    addr = this.translate(addr, 'load');
    if (this.memTrace && !this.isIo(addr)) this.memTrace.push({ addr: addr >>> 0, write: false });
    const w = this.readWord(addr);
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
    addr = this.translate(addr, 'store');
    if (this.isIo(addr)) {
      // The bus sees the lane-replicated store data, like the hardware's store-alignment unit.
      const wd = f3 === 0 ? ((v & 0xff) * 0x01010101) >>> 0 : f3 === 1 ? ((v & 0xffff) * 0x10001) >>> 0 : v >>> 0;
      switch (this.system ? (addr >>> 2) & 7 : this.mmioReg(addr)) {
        case 0: this.console += String.fromCharCode(wd & 0xff); break;
        case 1: this.leds = wd & 0xff; break;
        case 5: this.mtimecmp = wd; break;
        default: break;
      }
      return;
    }
    if (this.memTrace) this.memTrace.push({ addr: addr >>> 0, write: true });
    if (this.bus) {
      // the bus sees the lane-aligned data and a byte strobe per lane (lib/lsu.ts STORE_ALIGN)
      const sh = (addr & 3) * 8, strb = f3 === 0 ? 1 << (addr & 3) : f3 === 1 ? 3 << (addr & 2) : 15;
      this.bus.write((addr & ~3) >>> 0, (v << sh) >>> 0, strb);
      return;
    }
    const i = this.wordIndex(addr);
    if (f3 === 2) this.dmem[i] = v >>> 0;
    else {
      const bytes = f3 === 0 ? 1 : 2;
      const sh = (addr & (f3 === 0 ? 3 : 2)) * 8;
      const m = ((2 ** (bytes * 8) - 1) << sh) >>> 0;
      this.dmem[i] = ((this.dmem[i] & ~m) | ((v << sh) & m)) >>> 0;
    }
  }

  get mip(): number {
    return (this.mtime >>> 0 >= this.mtimecmp >>> 0 ? 1 << 7 : 0) | (this.irq ? 1 << 11 : 0);
  }

  /** mstatus as the vm option holds it. */
  private get mstatusVm(): number {
    const v = (this.sie ? MS.SIE : 0) | (this.mie ? MS.MIE : 0) | (this.spie ? MS.SPIE : 0) | (this.mpie ? MS.MPIE : 0) | (this.spp ? MS.SPP : 0)
      | (this.mpp << 11) | (this.fs << 13) | (this.sum ? MS.SUM : 0) | (this.mxr ? MS.MXR : 0);
    return (this.fs === 3 ? v | MS.SD : v) >>> 0;
  }

  private setMstatus(v: number, mask: number): void {
    if (mask & MS.SIE) this.sie = !!(v & MS.SIE);
    if (mask & MS.MIE) this.mie = !!(v & MS.MIE);
    if (mask & MS.SPIE) this.spie = !!(v & MS.SPIE);
    if (mask & MS.MPIE) this.mpie = !!(v & MS.MPIE);
    if (mask & MS.SPP) this.spp = !!(v & MS.SPP);
    if (mask & MS.MPP) { const p = (v >>> 11) & 3; this.mpp = p === 2 ? PRIV.U : p; }
    if (mask & MS.FS) this.fs = (v >>> 13) & 3;
    if (mask & MS.SUM) this.sum = !!(v & MS.SUM);
    if (mask & MS.MXR) this.mxr = !!(v & MS.MXR);
  }

  csrRead(a: number): number | null {
    if (this.vm) {
      switch (a) {
        case CSRS.mstatus: return this.mstatusVm;
        case CSRS.sstatus: return (this.mstatusVm & SSTATUS_MASK) >>> 0;
        case CSRS.misa: return ((this.m ? 0x40001100 : 0x40000100) | (this.c ? 4 : 0) | 0x140000) >>> 0;
        case CSRS.satp: return this.satp >>> 0;
        case CSRS.stvec: return this.stvec;
        case CSRS.sscratch: return this.sscratch;
        case CSRS.sepc: return this.sepc;
        case CSRS.scause: return this.scause;
        case CSRS.stval: return this.stval;
        case CSRS.sie: case CSRS.sip: case CSRS.medeleg: case CSRS.mideleg: case CSRS.mcounteren: case CSRS.scounteren: return 0;
        default: break;
      }
    }
    switch (a) {
      case CSRS.mstatus: return (this.mie ? 8 : 0) | (this.mpie ? 0x80 : 0) | 0x1800;
      case CSRS.misa: return (this.m ? 0x40001100 : 0x40000100) | (this.c ? 4 : 0);
      case CSRS.mie: return (this.mtie ? 0x80 : 0) | (this.meie ? 0x800 : 0);
      case CSRS.mtvec: return this.mtvec;
      case CSRS.mscratch: return this.mscratch;
      case CSRS.mepc: return this.mepc;
      case CSRS.mcause: return this.mcause;
      case CSRS.mtval: return this.mtval;
      case CSRS.mip: return this.mip;
      case CSRS.mcycle: case CSRS.cycle: return this.mtime;
      case CSRS.mhartid: case CSRS.mvendorid: case CSRS.marchid: case CSRS.mimpid: case CSRS.mstatush: return 0;
      case CSRS.fflags: return this.fext ? this.fflags : null;
      case CSRS.frm: return this.fext ? this.frm : null;
      case CSRS.fcsr: return this.fext ? (this.frm << 5) | this.fflags : null;
      default: return null;
    }
  }

  private csrWrite(a: number, v: number): void {
    v >>>= 0;
    if (this.vm) {
      switch (a) {
        case CSRS.mstatus: this.setMstatus(v, MS.SIE | MS.MIE | MS.SPIE | MS.MPIE | MS.SPP | MS.MPP | MS.FS | MS.SUM | MS.MXR); return;
        case CSRS.sstatus: this.setMstatus(v, MS.SIE | MS.SPIE | MS.SPP | MS.FS | MS.SUM | MS.MXR); return;
        case CSRS.satp: this.satp = v; return;
        case CSRS.stvec: this.stvec = (v & ~2) >>> 0; return;
        case CSRS.sscratch: this.sscratch = v; return;
        case CSRS.sepc: this.sepc = (v & (this.c ? ~1 : ~3)) >>> 0; return;
        case CSRS.scause: this.scause = v; return;
        case CSRS.stval: this.stval = v; return;
        case CSRS.sie: case CSRS.sip: case CSRS.medeleg: case CSRS.mideleg: case CSRS.mcounteren: case CSRS.scounteren: return;
        default: break;
      }
    }
    switch (a) {
      case CSRS.mstatus: this.mie = !!(v & 8); this.mpie = !!(v & 0x80); break;
      case CSRS.mie: this.mtie = !!(v & 0x80); this.meie = !!(v & 0x800); break;
      case CSRS.mtvec: this.mtvec = (v & ~3) >>> 0; break;
      case CSRS.mscratch: this.mscratch = v; break;
      case CSRS.mepc: this.mepc = (v & (this.c ? ~1 : ~3)) >>> 0; break;
      case CSRS.mcause: this.mcause = v; break;
      case CSRS.mtval: this.mtval = v; break;
      case CSRS.fflags: this.fflags = v & 31; break;
      case CSRS.frm: this.frm = v & 7; break;
      case CSRS.fcsr: this.fflags = v & 31; this.frm = (v >>> 5) & 7; break;
      default: break; // read-only (misa, mip, mcycle, cycle, mhartid, ids) and mstatush (all its fields zero): writes ignored
    }
  }

  private enterTrap(t: Trap, pc: number): void {
    this.mepc = pc >>> 0;
    this.mcause = t.cause >>> 0;
    this.mtval = t.tval >>> 0;
    this.mpie = this.mie;
    this.mie = false;
    if (this.vm) { this.mpp = this.priv; this.priv = PRIV.M; }
    this.pc = this.mtvec;
  }

  /**
   * The instruction at pc as step() runs it. With C, a parcel whose low bits are not 11 is a 16-bit instruction: it
   * runs as its expansion (an illegal one as 0, which decodes to nothing); otherwise it is this parcel and the next.
   */
  instrAt(pc: number): { word: number; size: 2 | 4; half?: number; fault?: Trap } {
    if (this.translating()) return this.instrAtVm(pc);
    if (!this.c) return { word: this.fetch(pc), size: 4 };
    const lo = this.half(pc);
    if ((lo & 3) !== 3) return { word: expand16(lo) ?? 0, size: 2, half: lo };
    return { word: (lo | (this.half(pc + 2) << 16)) >>> 0, size: 4 };
  }

  /** instrAt with Sv32: each parcel (or the word) is translated on its own page; a fault carries the address that failed. */
  private instrAtVm(pc: number): { word: number; size: 2 | 4; half?: number; fault?: Trap } {
    const at = (va: number, width: 2 | 4): { v: number } | { fault: Trap } => {
      const w = this.walk(va, 'fetch');
      this.lastWalkSeen = w;
      if (w.fault !== undefined) return { fault: new Trap(w.fault, va >>> 0) };
      const pa = w.pa!;
      return { v: width === 4 ? this.fetch(pa >>> 0) : this.half(pa >>> 0) };
    };
    if (!this.c) {
      const r = at(pc, 4);
      return 'fault' in r ? { word: 0, size: 4, fault: r.fault } : { word: r.v, size: 4 };
    }
    const lo = at(pc, 2);
    if ('fault' in lo) return { word: 0, size: 4, fault: lo.fault };
    if ((lo.v & 3) !== 3) return { word: expand16(lo.v) ?? 0, size: 2, half: lo.v };
    const hi = at(pc + 2, 2);
    if ('fault' in hi) return { word: 0, size: 4, fault: hi.fault };
    return { word: (lo.v | (hi.v << 16)) >>> 0, size: 4 };
  }
  private lastWalkSeen: Walk | null = null;

  step(): StepInfo {
    const pc = this.pc;
    if (this.system) {
      // Interrupts are taken at instruction boundaries, before the instruction executes.
      const mip = this.mip;
      if ((this.vm ? this.priv < PRIV.M || this.mie : this.mie) && ((this.meie && mip & 0x800) || (this.mtie && mip & 0x80))) {
        const cause = this.meie && mip & 0x800 ? CAUSE.EXTERNAL_IRQ : CAUSE.TIMER_IRQ;
        const before = this.priv;
        this.enterTrap(new Trap(cause), pc);
        this.mtime = (this.mtime + 1) >>> 0;
        this.steps++;
        this.halted = false;
        return { pc, word: 0, text: 'interrupt', rd: 0, trap: { cause, interrupt: true }, halted: false, ...(this.vm ? { priv: before } : {}) };
      }
    }
    this.stepWalks = [];
    const privBefore = this.priv;
    const { word, size, half, fault } = this.instrAt(pc);
    if (this.translating() && this.lastWalkSeen) { this.lastWalk = this.lastWalkSeen; this.stepWalks.push(this.lastWalkSeen); }
    const d = decode(word, this.custom, 32, this.mac);
    const x = this.x;
    const a = x[d.rs1] | 0, b = x[d.rs2] | 0, ua = x[d.rs1], ub = x[d.rs2];
    let next = (pc + size) >>> 0;
    let rd = 0, value: number | undefined, store: StepInfo['store'];
    let trap: Trap | null = null;
    const write = (v: number) => {
      rd = d.rd;
      value = v >>> 0;
    };
    const jumpTo = (t: number) => {
      t >>>= 0;
      if (this.system && t & (this.c ? 1 : 3)) trap = new Trap(CAUSE.MISALIGNED_FETCH, t);
      else next = t;
    };
    const isM = d.opcode === OPCODES.OP && d.funct7 === 1;
    const isF = !!d.spec?.fp;
    let extraCycles = 0;
    let fWrite: number | undefined;
    try {
    if (fault) trap = fault;
    else if (this.system && (!d.spec || (isM && !this.m) || (isF && !this.fext) || (!this.vm && (d.name === 'sret' || d.name === 'sfence.vma')))) trap = new Trap(CAUSE.ILLEGAL);
    else if (d.spec?.mac) {
      // The MAC core (dsp/mac.ts): racc reads the accumulator, the others change it; rs1 is racc's shift, rs2 mac's second operand
      if (d.funct3 === MAC_F3.racc) write(this.macFns.raccOf(this.acc, ua).y);
      else this.acc = this.macFns.accAfter(this.acc, d.funct3, ua, ub);
    } else if (d.spec?.custom) {
      // A custom instruction: its control row, as the single-cycle CPU's data path runs it (riscv/custom.ts).
      const r = d.spec.custom;
      const A = r.srcA === 'pc' ? pc | 0 : a, B = r.srcB === 'imm' ? d.imm | 0 : b;
      const y = aluOp(aluCtlOf(r, word), A, B);
      const old = r.regWrite && r.result === 'mem' ? this.load(y >>> 0, 2) : 0;
      if (r.memWrite) { this.store(y >>> 0, 2, b); store = { addr: y >>> 0, value: b >>> 0 }; }
      if (r.regWrite && FMT_FIELDS[r.fmt].rd) write({ alu: y, mem: old, pc4: pc + size, imm: d.imm }[r.result]);
      if (r.next === 'branch') { if (branchTaken(d.funct3, a, b)) jumpTo(pc + d.imm); }
      else if (r.next === 'jump') jumpTo(pc + d.imm);
      else if (r.next === 'jalr') jumpTo(y & ~1);
    } else if (isF) {
      const fa = this.f[d.rs1], fb = this.f[d.rs2];
      // rounding mode: the instruction's rm field, or frm when rm = 7 (dynamic)
      const rm = d.funct3 === 7 ? this.frm : d.funct3;
      const fr = (r: FpResult) => { this.fflags |= r.fl; return r.y >>> 0; };
      switch (d.name) {
        case 'flw': fWrite = this.load((a + d.imm) >>> 0, 2) >>> 0; break;
        case 'fsw': { const addr = (a + d.imm) >>> 0; this.store(addr, 2, fb); store = { addr, value: fb }; break; }
        case 'fadd.s': fWrite = fr(fpAddX(fa, fb, false, F32, rm)); break;
        case 'fsub.s': fWrite = fr(fpAddX(fa, fb, true, F32, rm)); break;
        case 'fmul.s': fWrite = fr(fpMulX(fa, fb, F32, rm)); break;
        case 'fdiv.s': fWrite = fr(fpDivX(fa, fb, F32, rm)); break;
        case 'fsqrt.s': fWrite = fr(fpSqrtX(fa, F32, rm)); break;
        case 'fmadd.s': case 'fmsub.s': case 'fnmsub.s': case 'fnmadd.s': {
          const neg = (d.opcode >> 2) & 3; // fmadd 0, fmsub 1, fnmsub 2, fnmadd 3: bit 0 negates c, bit 1 the product
          fWrite = fr(fpFmaX(fa, fb, this.f[d.rs3], !!(neg & 2), !!(neg & 1), F32, rm));
          break;
        }
        case 'fsgnj.s': fWrite = ((fa & 0x7fffffff) | (fb & 0x80000000)) >>> 0; break;
        case 'fsgnjn.s': fWrite = ((fa & 0x7fffffff) | (~fb & 0x80000000)) >>> 0; break;
        case 'fsgnjx.s': fWrite = (fa ^ (fb & 0x80000000)) >>> 0; break;
        case 'fmin.s': fWrite = fr(fpMinMaxX(fa, fb, false, F32)); break;
        case 'fmax.s': fWrite = fr(fpMinMaxX(fa, fb, true, F32)); break;
        case 'feq.s': write(fr(fpCmpX(fa, fb, 'eq', F32))); break;
        case 'flt.s': write(fr(fpCmpX(fa, fb, 'lt', F32))); break;
        case 'fle.s': write(fr(fpCmpX(fa, fb, 'le', F32))); break;
        case 'fcvt.w.s': write(fr(fpToIntX(fa, true, F32, rm))); break;
        case 'fcvt.wu.s': write(fr(fpToIntX(fa, false, F32, rm))); break;
        case 'fmv.x.w': write(fa); break;
        case 'fclass.s': write(fpClass(fa, F32)); break;
        case 'fcvt.s.w': fWrite = fr(fpFromIntX(ua, true, F32, rm)); break;
        case 'fcvt.s.wu': fWrite = fr(fpFromIntX(ua, false, F32, rm)); break;
        case 'fmv.w.x': fWrite = ua >>> 0; break;
        default: break;
      }
    } else if (isM) {
      write(mExec(d.funct3, ua, ub));
      if (d.funct3 >= 4) extraCycles = DIV_CYCLES - 1;
    } else switch (d.opcode) {
      case OPCODES.LUI: write(d.imm); break;
      case OPCODES.AUIPC: write(pc + d.imm); break;
      case OPCODES.JAL: jumpTo(pc + d.imm); if (!trap) write(pc + size); break;
      case OPCODES.JALR: jumpTo((a + d.imm) & ~1); if (!trap) write(pc + size); break;
      case OPCODES.BRANCH: {
        const take = [a === b, a !== b, false, false, a < b, a >= b, ua < ub, ua >= ub][d.funct3];
        if (take) jumpTo(pc + d.imm);
        break;
      }
      case OPCODES.LOAD: {
        const addr = (a + d.imm) >>> 0;
        if (this.system && ((d.funct3 & 3) === 1 ? addr & 1 : (d.funct3 & 3) === 2 ? addr & 3 : 0)) trap = new Trap(CAUSE.MISALIGNED_LOAD, addr);
        else write(this.load(addr, d.funct3));
        break;
      }
      case OPCODES.STORE: {
        const addr = (a + d.imm) >>> 0;
        if (this.system && (d.funct3 === 1 ? addr & 1 : d.funct3 === 2 ? addr & 3 : 0)) trap = new Trap(CAUSE.MISALIGNED_STORE, addr);
        else {
          this.store(addr, d.funct3, b);
          store = { addr, value: b >>> 0 };
        }
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
      case OPCODES.AMO: {
        // the read and the write happen in the same memory access: nothing can come in between
        if (this.system) { trap = new Trap(CAUSE.ILLEGAL); break; }
        const addr = ua >>> 0;
        if (d.name === 'lr.w') { const v = this.load(addr, 2) >>> 0; this.resValid = true; this.resLine = addr >>> 4; write(v); break; }
        if (d.name === 'sc.w') {
          // stores only while the reservation holds; rd = 0 on success, 1 on failure; any sc.w clears it
          const ok = this.resValid && this.resLine === addr >>> 4;
          this.resValid = false;
          if (ok) { this.store(addr, 2, ub >>> 0); store = { addr, value: ub >>> 0 }; }
          write(ok ? 0 : 1);
          break;
        }
        const old = this.load(addr, 2) >>> 0;
        const nv = d.name === 'amoadd.w' ? (old + ub) >>> 0 : ub >>> 0;
        this.store(addr, 2, nv);
        store = { addr, value: nv };
        write(old);
        break;
      }
      case OPCODES.SYSTEM: {
        if (!this.system) {
          // user-level programs: csrr rd, mhartid (multi-core) and the F CSRs fflags, frm, fcsr
          const csrA = (word >>> 20) & 0xfff;
          if (d.funct3 === 2 && csrA === 0xf14 && d.rs1 === 0) write(this.hartid);
          else if (d.funct3 & 3 && csrA >= 1 && csrA <= 3) {
            const old = csrA === 1 ? this.fflags : csrA === 2 ? this.frm : (this.frm << 5) | this.fflags;
            const src = d.funct3 & 4 ? d.rs1 : ua, op = d.funct3 & 3;
            if (op === 1 || d.rs1 !== 0) {
              const v = op === 1 ? src : op === 2 ? old | src : old & ~src;
              if (csrA !== 2) this.fflags = v & 31;
              if (csrA === 2) this.frm = v & 7;
              if (csrA === 3) this.frm = (v >>> 5) & 7;
            }
            write(old);
          }
          break;
        }
        if (d.name === 'ecall') trap = new Trap([CAUSE.ECALL_U, CAUSE.ECALL_S, CAUSE.ECALL, CAUSE.ECALL][this.priv]);
        else if (d.name === 'ebreak') trap = new Trap(CAUSE.BREAKPOINT);
        else if (d.name === 'mret') {
          if (this.vm && this.priv !== PRIV.M) trap = new Trap(CAUSE.ILLEGAL);
          else {
            next = this.mepc; this.mie = this.mpie; this.mpie = true;
            if (this.vm) { this.priv = this.mpp; this.mpp = PRIV.U; }
          }
        }
        else if (d.name === 'sret') {
          if (this.priv < PRIV.S) trap = new Trap(CAUSE.ILLEGAL);
          else { next = this.sepc; this.sie = this.spie; this.spie = true; this.priv = this.spp ? PRIV.S : PRIV.U; this.spp = false; }
        }
        else if (d.name === 'sfence.vma') { if (this.priv < PRIV.S) trap = new Trap(CAUSE.ILLEGAL); /* no TLB: nothing to flush */ }
        else if (d.name === 'wfi') { if (this.vm && this.priv < PRIV.S) trap = new Trap(CAUSE.ILLEGAL); }
        else {
          const csrA = (word >>> 20) & 0xfff;
          const old = this.vm && (this.priv < ((csrA >>> 8) & 3) || (this.priv < PRIV.M && csrA === CSRS.cycle)) ? null : this.csrRead(csrA);
          if (old === null) { trap = new Trap(CAUSE.ILLEGAL); break; }
          const src = d.funct3 & 4 ? d.rs1 : ua;
          const op = d.funct3 & 3;
          const writes = op === 1 || d.rs1 !== 0;
          if (this.vm && writes && csrA >>> 10 === 3) { trap = new Trap(CAUSE.ILLEGAL); break; }
          if (writes) this.csrWrite(csrA, op === 1 ? src : op === 2 ? (old | src) : (old & ~src));
          write(old);
        }
        break;
      }
      default:
        break; // fence: no architectural effect here
    }
    } catch (e) {
      if (!(e instanceof Trap)) throw e;
      trap = e;
    }
    if (trap) {
      rd = 0;
      this.enterTrap(trap, pc);
    } else {
      if (rd !== 0 && value !== undefined) x[rd] = value;
      else rd = 0;
      if (fWrite !== undefined) this.f[d.rd] = fWrite;
      this.halted = next === pc;
      this.pc = next;
      this.retired++;
    }
    if (this.system) this.mtime = (this.mtime + 1 + extraCycles) >>> 0;
    this.steps++;
    const t = trap as Trap | null;
    const fwrite = !t && fWrite !== undefined ? { rd: d.rd, value: fWrite >>> 0 } : undefined;
    const text = half !== undefined ? disasmC(half, pc) : disasm(word, pc, this.custom, 32, this.mac);
    return {
      pc, word, ...(half !== undefined ? { half } : {}), text, rd, value, store, fwrite,
      trap: t ? { cause: t.cause, interrupt: false, ...(this.vm ? { tval: t.tval >>> 0 } : {}) } : undefined, halted: this.halted,
      ...(this.vm ? { priv: privBefore, ...(this.stepWalks.length ? { walks: this.stepWalks } : {}) } : {}),
    };
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

/** A model's fields, arrays copied (ISS.save, MultiISS.save). */
export type ModelState = Record<string, unknown>;

export function saveFields(o: object): ModelState {
  const s: ModelState = {};
  for (const [k, v] of Object.entries(o)) s[k] = ArrayBuffer.isView(v) ? (v as Uint32Array).slice() : Array.isArray(v) ? v.slice() : v;
  return s;
}

/** Put saved fields back. Arrays are refilled in place: the harts of a multi-core model share one memory. */
export function restoreFields(o: object, s: ModelState): void {
  const t = o as Record<string, unknown>;
  for (const [k, v] of Object.entries(s)) {
    const cur = t[k];
    if (ArrayBuffer.isView(cur)) (cur as Uint32Array).set(v as Uint32Array);
    else if (Array.isArray(cur)) cur.splice(0, cur.length, ...(v as unknown[]));
    else t[k] = v;
  }
}
