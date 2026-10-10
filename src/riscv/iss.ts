// Instruction-set simulator: the golden model. It executes RV32I exactly as the
// specification says, with the same memory organisation as our CPUs (separate instruction
// and data memories; the data memory wraps around its size), so the gate-level processors
// can be checked against it instruction by instruction.
//
// With `system: true` it also models the full machine-mode system of the complete CPU:
// memory-mapped I/O, CSRs, exceptions and interrupts (one step = one clock cycle; a cycle in
// which an interrupt is taken executes no instruction).

import { F32, fpAddX, fpClass, fpCmpX, fpDivX, fpFmaX, fpFromIntX, fpMinMaxX, fpMulX, fpSqrtX, fpToIntX, type FpResult } from '../sim/fpref';
import { CSRS, decode, disasm, OPCODES } from './isa';

export interface IssOptions {
  /** Data memory size in 32-bit words (power of two). */
  dmemWords?: number;
  /** Instruction memory size in words (power of two). */
  imemWords?: number;
  /** Model I/O, CSRs, traps and interrupts. */
  system?: boolean;
  /** Implement the M extension (otherwise its encodings are illegal in system mode). */
  m?: boolean;
  /** Implement the F subset (otherwise illegal in system mode). */
  f?: boolean;
  /** Hart id read by csrr mhartid (multi-core). */
  hartid?: number;
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
  word: number;
  text: string;
  /** Register written (0 = none). */
  rd: number;
  value?: number;
  store?: { addr: number; value: number };
  /** Floating-point register written (RV32F). */
  fwrite?: { rd: number; value: number };
  trap?: { cause: number; interrupt: boolean };
  halted: boolean;
}

/** I/O addresses (bit 31 set selects I/O; bits 4:2 select the device register). */
export const IO = { CONSOLE: 0x80000000, LEDS: 0x80000004, SWITCHES: 0x80000008, MTIME: 0x80000010, MTIMECMP: 0x80000014 } as const;

export const CAUSE = {
  MISALIGNED_FETCH: 0, ILLEGAL: 2, BREAKPOINT: 3, MISALIGNED_LOAD: 4, MISALIGNED_STORE: 6, ECALL: 11,
  TIMER_IRQ: 0x80000007, EXTERNAL_IRQ: 0x8000000b,
} as const;

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
  halted = false;
  steps = 0;
  readonly system: boolean;
  readonly m: boolean;
  readonly fext: boolean;
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
    this.m = !!opts.m;
    this.fext = !!opts.f;
    this.hartid = opts.hartid ?? 0;
  }

  fetch(pc: number): number {
    return this.imem[(pc >>> 2) % this.imemWords] ?? 0x00000013;
  }

  private wordIndex(addr: number): number {
    return (addr >>> 2) & (this.dmem.length - 1);
  }

  private isIo(addr: number): boolean {
    return this.system && addr >= 0x80000000;
  }

  private ioRead(addr: number): number {
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
    return this.isIo(addr) ? this.ioRead(addr) >>> 0 : this.dmem[this.wordIndex(addr)];
  }

  /** When set, every data-memory access (not I/O) is appended here: for cache studies. */
  memTrace: { addr: number; write: boolean }[] | null = null;

  load(addr: number, f3: number): number {
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
    if (this.isIo(addr)) {
      // The bus sees the lane-replicated store data, like the hardware's store-alignment unit.
      const wd = f3 === 0 ? ((v & 0xff) * 0x01010101) >>> 0 : f3 === 1 ? ((v & 0xffff) * 0x10001) >>> 0 : v >>> 0;
      switch ((addr >>> 2) & 7) {
        case 0: this.console += String.fromCharCode(wd & 0xff); break;
        case 1: this.leds = wd & 0xff; break;
        case 5: this.mtimecmp = wd; break;
        default: break;
      }
      return;
    }
    if (this.memTrace) this.memTrace.push({ addr: addr >>> 0, write: true });
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
      case CSRS.mhartid: case CSRS.mvendorid: case CSRS.marchid: case CSRS.mimpid: return 0;
      case CSRS.fflags: return this.fext ? this.fflags : null;
      case CSRS.frm: return this.fext ? this.frm : null;
      case CSRS.fcsr: return this.fext ? (this.frm << 5) | this.fflags : null;
      default: return null;
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
      case CSRS.fflags: this.fflags = v & 31; break;
      case CSRS.frm: this.frm = v & 7; break;
      case CSRS.fcsr: this.fflags = v & 31; this.frm = (v >>> 5) & 7; break;
      default: break; // read-only (misa, mip, mcycle, cycle, mhartid, ids): writes ignored
    }
  }

  private enterTrap(t: Trap, pc: number): void {
    this.mepc = pc >>> 0;
    this.mcause = t.cause >>> 0;
    this.mtval = t.tval >>> 0;
    this.mpie = this.mie;
    this.mie = false;
    this.pc = this.mtvec;
  }

  step(): StepInfo {
    const pc = this.pc;
    if (this.system) {
      // Interrupts are taken at instruction boundaries, before the instruction executes.
      const mip = this.mip;
      if (this.mie && ((this.meie && mip & 0x800) || (this.mtie && mip & 0x80))) {
        const cause = this.meie && mip & 0x800 ? CAUSE.EXTERNAL_IRQ : CAUSE.TIMER_IRQ;
        this.enterTrap(new Trap(cause), pc);
        this.mtime = (this.mtime + 1) >>> 0;
        this.steps++;
        this.halted = false;
        return { pc, word: 0, text: 'interrupt', rd: 0, trap: { cause, interrupt: true }, halted: false };
      }
    }
    const word = this.fetch(pc);
    const d = decode(word);
    const x = this.x;
    const a = x[d.rs1] | 0, b = x[d.rs2] | 0, ua = x[d.rs1], ub = x[d.rs2];
    let next = (pc + 4) >>> 0;
    let rd = 0, value: number | undefined, store: StepInfo['store'];
    let trap: Trap | null = null;
    const write = (v: number) => {
      rd = d.rd;
      value = v >>> 0;
    };
    const jumpTo = (t: number) => {
      t >>>= 0;
      if (this.system && t & 3) trap = new Trap(CAUSE.MISALIGNED_FETCH, t);
      else next = t;
    };
    const isM = d.opcode === OPCODES.OP && d.funct7 === 1;
    const isF = !!d.spec?.fp;
    let extraCycles = 0;
    let fWrite: number | undefined;
    if (this.system && (!d.spec || (isM && !this.m) || (isF && !this.fext))) trap = new Trap(CAUSE.ILLEGAL);
    else if (isF) {
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
      case OPCODES.JAL: jumpTo(pc + d.imm); if (!trap) write(pc + 4); break;
      case OPCODES.JALR: jumpTo((a + d.imm) & ~1); if (!trap) write(pc + 4); break;
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
        if (d.name === 'ecall') trap = new Trap(CAUSE.ECALL);
        else if (d.name === 'ebreak') trap = new Trap(CAUSE.BREAKPOINT);
        else if (d.name === 'mret') { next = this.mepc; this.mie = this.mpie; this.mpie = true; }
        else if (d.name === 'wfi') { /* no-op */ }
        else {
          const csrA = (word >>> 20) & 0xfff;
          const old = this.csrRead(csrA);
          if (old === null) { trap = new Trap(CAUSE.ILLEGAL); break; }
          const src = d.funct3 & 4 ? d.rs1 : ua;
          const op = d.funct3 & 3;
          const writes = op === 1 || d.rs1 !== 0;
          if (writes) this.csrWrite(csrA, op === 1 ? src : op === 2 ? (old | src) : (old & ~src));
          write(old);
        }
        break;
      }
      default:
        break; // fence: no architectural effect here
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
    return { pc, word, text: disasm(word, pc), rd, value, store, fwrite, trap: t ? { cause: t.cause, interrupt: false } : undefined, halted: this.halted };
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
