// Seeded random RV32 programs for fuzzing the CPUs against the golden model (tests/verify/fuzz.ts). Every
// register is written before it is read, branches and jumps go forward (loops run a bounded count), loads and
// stores stay in a window of the data memory, and the program ends in a jump to itself. Sources are often
// registers written just before, so forwarding, load-use stalls and branches right after loads come up all
// the time. Options switch on what a CPU implements: byte / halfword access, M, F, the system CPU's CSRs,
// traps and timer interrupt, the multi-core's atomics and hart id, a CPU's custom instructions. One seed, one program.

import { FMT_FIELDS, uses, type CustomRow } from './custom';

export interface Rand32Options {
  /** Body length in units (an instruction, or a short sequence: a loop, a jalr, an address computation). */
  n?: number;
  /** Byte and halfword loads and stores. */
  sub?: boolean;
  m?: boolean;
  f?: boolean;
  /** CSRs, ecall / ebreak, illegal instructions, misaligned accesses and jumps (all trapping to a handler
   * that skips them), and a timer interrupt. */
  system?: boolean;
  /** amoswap.w / amoadd.w and csrr mhartid (the multi-core). */
  mp?: boolean;
  /** Data-memory words the loads and stores use (power of two, default 32). */
  dmemWords?: number;
  /** Where the data window starts (a multiple of its size, below 0x8000_0000; default 0). Our data memories wrap
   * around their size, so any base reads the same words; a von Neumann machine (Spike) needs the window clear of
   * the code. Programs without it are unchanged. */
  dataBase?: number;
  /** The system mode's timer interrupt (default on): it needs our memory-mapped mtime / mtimecmp. */
  timer?: boolean;
  /** The C extension: assembled with .option rvc, and about a third of the units are C forms (registers x8–x15,
   * rd = rs1, short immediates, loads and stores off a prime register or sp, short jumps). Unchanged without it. */
  c?: boolean;
  /** Custom instructions (riscv/custom.ts): about a fifth of the units are one of the rows, set up so that every
   *  address they compute stays in the data window and every jump lands on an instruction (draws nothing without rows). */
  custom?: readonly CustomRow[];
  /**
   * Virtual memory (ISS option vm; needs system, dataBase = the window's virtual address, dmemWords = 4096 words, 4 pages):
   * the program starts in M, builds Sv32 page tables in the data region at physical `data` (the code region is at `code`),
   * drops to U or S with mret and runs the usual random body there. Its loads and stores range over 4 window pages whose
   * entries are good, read-only, wrong-mode, invalid, reserved, A = 0, D = 0 or execute-only, and over probe pages (a
   * superpage alias of physical memory, a misaligned superpage, a table or a page beyond 2^32, an unmapped one). The M handler
   * logs cause, mtval and mepc, maps the page and retries (for a page it was given a fix for), or skips the instruction;
   * a jump to a page without X comes back through ra; a last ecall (s9 = a magic number) ends in M at `halt`.
   */
  vm?: { code: number; data: number };
  /** The MAC core's mac, mac2, clracc and racc (about a quarter of the units), and now and then a word on custom-2 that is none of them (funct7 or funct3[2] set:
   *  it does nothing). Draws nothing without it. */
  mac?: boolean;
}

/** mulberry32: small, fast, good enough. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R_OPS = ['add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and'];
const I_OPS = ['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi'];
const SH_OPS = ['slli', 'srli', 'srai'];
const B_OPS = ['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'];
const M_OPS = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'];
const F_RR = ['fadd.s', 'fsub.s', 'fmul.s', 'fdiv.s'];
const F_SG = ['fsgnj.s', 'fsgnjn.s', 'fsgnjx.s', 'fmin.s', 'fmax.s'];
const F_CMP = ['feq.s', 'flt.s', 'fle.s'];
const F_FMA = ['fmadd.s', 'fmsub.s', 'fnmsub.s', 'fnmadd.s'];
const RM = ['rne', 'rtz', 'rdn', 'rup', 'rmm', 'dyn'];
/** Body registers; x24–x31 are kept for the loop counter, memory base, address temporary and trap handler. */
const POOL = ['ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
const FPOOL = ['ft0', 'ft1', 'ft2', 'ft3', 'ft4', 'ft5', 'ft6', 'ft7'];
/** The registers a 3-bit field reaches (x8–x15). */
const PRIME = ['s0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
const LOOP = 's10', BASE = 's11', ADDR = 't6', JR = 't5', H0 = 't3', H1 = 't4', T0 = 's8', T1 = 's9';
/** Interesting words: where datapaths break. */
const EDGE = [0, 1, -1, 2, 0x7fffffff, -0x80000000, 0x80000001, 0xffff, 0x8000, 0x7fff, 31, 32, 0xff, 0x80];
/** Float bit patterns: zeros, ones, infinities, NaNs (quiet, signalling), subnormals, extremes. */
const FEDGE = [0, 0x80000000, 0x3f800000, 0xbfc00000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0xffc00001,
  0x00000001, 0x807fffff, 0x7f7fffff, 0x00800000, 0x4f000000, 0xcf000000, 0x4b800000, 0x3effffff, 0x3f000000];
/** Words that are not RV32IM / Zicsr instructions (all-zero, all-one, slli with shamt[5], an unknown CSR, a 64-bit load). */
const ILLEGAL = [0x00000000, 0xffffffff, 0x02051513, 0x7c002573, 0x00053503];

/** The vm programs' page-table entry bits. */
const PV = 1, PR = 2, PW = 4, PX = 8, PU = 16, PA = 64, PD = 128;
export const VM_MAGIC = 0x5eed1234;
/** Virtual layout of the vm programs: the root-level slots of the probe pages and what they hold. */
export const VM_PROBES = { alias: 0x01400000, misaligned: 0x01800000, farTable: 0x01c00000, farPage: 0x02000000, unmapped: 0x02400000, emptyTable: 0x02800000 };
/** Offsets in the data region of the vm programs (bytes): root table, window leaf table, code leaf table, log, fix table, window pages, an empty table. */
export const VM_DATA = { root: 0, win: 0x1000, codeTable: 0x2000, log: 0x3000, fix: 0x3800, pages: 0x4000, empty: 0x8000 };

export function randomProgram32(seed: number, o: Rand32Options = {}): string {
  const r = rng(seed * 2654435761 + 12345);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const word = () => (r() < 0.5 ? pick(EDGE) : (r() * 2 ** 32) | 0);
  const n = o.n ?? 60, W = o.dmemWords ?? 32, B = 4 * W;
  const out: string[] = o.c ? ['        .option rvc'] : [];
  const emit = (s: string) => out.push(`        ${s}`);
  // a source register: often one written in the last few instructions (a hazard), sometimes x0
  const recent: string[] = [];
  const src = () => (recent.length && r() < 0.55 ? pick(recent.slice(-3)) : r() < 0.06 ? 'zero' : pick(POOL));
  const dst = () => {
    const d = r() < 0.04 ? 'zero' : pick(POOL);
    recent.push(d);
    if (recent.length > 6) recent.shift();
    return d;
  };
  const frecent: string[] = [];
  const fsrc = () => (frecent.length && r() < 0.5 ? pick(frecent.slice(-3)) : pick(FPOOL));
  const fdst = () => { const d = pick(FPOOL); frecent.push(d); if (frecent.length > 4) frecent.shift(); return d; };

  // prologue: trap handler (skips the trapping instruction; a timer interrupt is acknowledged by pushing
  // mtimecmp to the end of time), then every register gets a value and memory a few words
  const vm = o.vm;
  const D = o.dataBase;
  const SMODE = vm ? r() < 0.35 : false;
  const winPages = 4;
  const winVa = (k: number) => (D ?? 0) + 4096 * k;
  /** The window pages that may be jumped to: no X. */
  let noExec: number[] = [];
  if (vm) {
    const { code, data } = vm;
    const L = VM_DATA, uf = SMODE ? 0 : PU;
    const pte = (ppn: number, flags: number) => (ppn * 1024 + flags) >>> 0;
    const ppnOf = (pa: number) => pa / 4096;
    emit('j main');
    out.push('handler:');
    for (const l of [
      `csrr ${H0}, mcause`, `li ${H1}, ${VM_MAGIC}`, `bne s9, ${H1}, hnorm`, 'j halt',
    ]) emit(l);
    out.push('hnorm:');
    for (const l of [
      `li ${H1}, ${data + L.log}`, `lw s8, 0(${H1})`, `csrr s9, mtval`, `add ${H1}, ${H1}, s8`, `sw ${H0}, 16(${H1})`, `sw s9, 20(${H1})`,
      'csrr s9, mepc', `sw s9, 24(${H1})`, 'addi s8, s8, 16', 'andi s8, s8, 0x3ff', `li ${H1}, ${data + L.log}`, `sw s8, 0(${H1})`,
      `li ${H1}, 12`, `beq ${H0}, ${H1}, hfetch`, `li ${H1}, 1`, `beq ${H0}, ${H1}, hfetch`, `li ${H1}, 13`, `beq ${H0}, ${H1}, hfix`,
      `li ${H1}, 15`, `bne ${H0}, ${H1}, hskip`,
    ]) emit(l);
    out.push('hfix:');
    for (const l of [
      `csrr ${H0}, mtval`, `srli ${H0}, ${H0}, 12`, `li ${H1}, ${winVa(0) >>> 12}`, `sub ${H0}, ${H0}, ${H1}`, `li ${H1}, ${winPages}`,
      `bgeu ${H0}, ${H1}, hskip`, `slli ${H0}, ${H0}, 3`, `li ${H1}, ${data + L.fix}`, `add ${H0}, ${H0}, ${H1}`, `lw ${H1}, 0(${H0})`,
      `beqz ${H1}, hskip`, `lw ${H0}, 4(${H0})`, `sw ${H0}, 0(${H1})`, 'sfence.vma zero, zero', 'mret',
    ]) emit(l);
    out.push('hfetch:');
    emit('csrw mepc, ra');
    emit('mret');
    out.push('hskip:');
    for (const l of [`csrr ${H0}, mepc`, `addi ${H0}, ${H0}, 4`, `csrw mepc, ${H0}`, 'mret']) emit(l);
    out.push('main:');
    emit(`la ${H0}, handler`);
    emit(`csrw mtvec, ${H0}`);
    const setw = (pa: number, v: number) => { emit(`li ${H0}, ${pa}`); emit(`li ${H1}, ${v >>> 0}`); emit(`sw ${H1}, 0(${H0})`); };
    // the root: the code (one identity superpage, or 4 KiB pages), the window's leaf table, the probes
    if (r() < 0.5) setw(data + L.root, pte(0, PV | PR | PX | PA | uf));
    else {
      setw(data + L.root, pte(ppnOf(data + L.codeTable), PV));
      for (let i = 0; i < 8; i++) setw(data + L.codeTable + 4 * (((code >>> 12) & 0x3ff) + i), pte(ppnOf(code) + i, PV | PR | PX | PA | uf));
    }
    setw(data + L.root + 4 * 2, pte(ppnOf(data + L.win), PV));
    const slot = (va: number) => data + L.root + 4 * (va >>> 22);
    setw(slot(VM_PROBES.alias), pte(0, PV | PR | PW | PA | PD | uf));
    setw(slot(VM_PROBES.misaligned), pte(1, PV | PR | PW | PA | PD | uf));
    setw(slot(VM_PROBES.farTable), pte(0x300000, PV));
    setw(slot(VM_PROBES.farPage), pte(0x100000, PV | PR | PW | PA | PD | uf));
    setw(slot(VM_PROBES.emptyTable), pte(ppnOf(data + L.empty), PV));
    // the window: a physical page each (a permutation), a state each, and for some a fix the handler installs
    const perm = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) { const j = int(0, i); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    const physical = (k: number) => data + L.pages + 4096 * perm[k];
    const good = (k: number) => pte(ppnOf(physical(k)), PV | PR | PW | uf | PA | PD);
    const STATES: [string, number][] = [
      ['good', PV | PR | PW | uf | PA | PD], ['good', PV | PR | PW | uf | PA | PD], ['good', PV | PR | PW | uf | PA | PD],
      ['ro', PV | PR | uf | PA | PD], ['wrongmode', PV | PR | PW | (SMODE ? PU : 0) | PA | PD], ['invalid', PR | PW | uf | PA | PD],
      ['wonly', PV | PW | uf | PA | PD], ['a0', PV | PR | PW | uf | PD], ['d0', PV | PR | PW | uf | PA], ['xonly', PV | PX | uf | PA],
    ];
    noExec = [];
    const fixes: number[] = [];
    for (let k = 0; k < winPages; k++) {
      const [name, flags] = pick(STATES);
      setw(data + L.win + 4 * k, pte(ppnOf(physical(k)), flags));
      if (name !== 'xonly') noExec.push(k);
      if (name !== 'good' && r() < 0.65) fixes.push(k);
    }
    for (const k of fixes) { setw(data + L.fix + 8 * k, data + L.win + 4 * k); setw(data + L.fix + 8 * k + 4, good(k)); }
    // enter the mode: satp, mstatus (MPP, SUM, MXR), mepc
    emit(`li ${H0}, ${(0x80000000 | ppnOf(data)) >>> 0}`);
    emit(`csrw satp, ${H0}`);
    emit(`li ${H0}, ${((SMODE ? 1 : 0) << 11) | (r() < 0.4 ? 1 << 18 : 0) | (r() < 0.3 ? 1 << 19 : 0)}`);
    emit(`csrw mstatus, ${H0}`);
    emit(`la ${H0}, user`);
    emit(`csrw mepc, ${H0}`);
    emit('sfence.vma zero, zero');
    emit('mret');
    out.push('user:');
  } else if (o.system) {
    emit('j main');
    out.push('handler:');
    emit(`csrr ${H0}, mcause`);
    emit(`bltz ${H0}, irq`);
    emit(`csrr ${H1}, mepc`);
    emit(`addi ${H1}, ${H1}, 4`);
    emit(`csrw mepc, ${H1}`);
    emit('mret');
    out.push('irq:');
    emit(`li ${H1}, -1`);
    emit(`li ${H0}, 0x80000014`);
    emit(`sw ${H1}, 0(${H0})`);
    emit('mret');
    out.push('main:');
    emit(`la ${H0}, handler`);
    emit(`csrw mtvec, ${H0}`);
  }
  for (const x of POOL) emit(`li ${x}, ${word()}`);
  emit(`li ${BASE}, ${(D ?? 0) + B / 2}`);
  const WH = vm ? 400 : W / 2;
  for (let i = 0; i < 4; i++) emit(`sw ${pick(POOL)}, ${4 * int(-WH, WH - 1)}(${BASE})`);
  if (o.f) {
    for (const fr of FPOOL) { emit(`li ${T0}, ${r() < 0.7 ? pick(FEDGE) : word()}`); emit(`fmv.w.x ${fr}, ${T0}`); }
    emit(`fsrmi ${int(0, 4)}`);
  }
  if (o.system && r() < 0.7 && o.timer !== false) {
    // a timer interrupt some 10 to 60 cycles from now
    emit(`li ${T0}, 0x80000010`);
    emit(`lw ${T1}, 0(${T0})`);
    emit(`addi ${T1}, ${T1}, ${int(10, 60)}`);
    emit(`sw ${T1}, 4(${T0})`);
    emit(`li ${T1}, 0x80`);
    emit(`csrs mie, ${T1}`);
    emit('csrsi mstatus, 8');
  }

  const pending: { label: string; at: number }[] = [];
  let label = 0;
  /** A load or store of `size` bytes: base + offset in the window, or an address computed from a register. */
  const mem = (op: string, reg: string, size: number) => {
    const misalign = o.system && r() < 0.08 && size > 1;
    if (vm) {
      const kind = r();
      if (kind < 0.3) {
        const m = Math.floor(2040 / size);
        emit(`${op} ${reg}, ${size * int(-m, m) + (misalign ? 1 : 0)}(${BASE})`);
      } else if (kind < 0.7) {
        emit(`li ${ADDR}, ${winVa(int(0, winPages - 1)) + size * int(0, 4096 / size - 1) + (misalign ? 1 : 0)}`);
        emit(`${op} ${reg}, 0(${ADDR})`);
      } else {
        emit(`andi ${ADDR}, ${src()}, ${2047 & ~(misalign ? 0 : size - 1)}`);
        emit(`li ${T0}, ${winVa(int(0, winPages - 1))}`);
        emit(`add ${ADDR}, ${ADDR}, ${T0}`);
        emit(`${op} ${reg}, 0(${ADDR})`);
      }
      return;
    }
    if (r() < 0.3) {
      emit(`andi ${ADDR}, ${src()}, ${(B - 1) & ~(misalign ? 0 : size - 1)}`);
      if (D === undefined) emit(`${op} ${reg}, 0(${ADDR})`);
      else {
        // into the window: BASE is its middle
        emit(`add ${ADDR}, ${ADDR}, ${BASE}`);
        emit(`${op} ${reg}, ${-B / 2}(${ADDR})`);
      }
    } else {
      const off = size * int(-B / 2 / size, B / 2 / size - 1) + (misalign ? 1 : 0);
      emit(`${op} ${reg}, ${off}(${BASE})`);
    }
  };
  /** A C form with operands it accepts (o.c only: draws no random numbers otherwise). */
  const cUnit = (i: number) => {
    const note = (d: string) => { recent.push(d); if (recent.length > 6) recent.shift(); return d; };
    const pd = () => note(pick(PRIME));
    const ps = () => (recent.length && r() < 0.5 && PRIME.includes(recent[recent.length - 1]) ? recent[recent.length - 1] : pick(PRIME));
    const rd = () => note(pick(POOL));
    const nz6 = () => (r() < 0.5 ? int(-32, -1) : int(1, 31));
    const ahead = (): string => { const l = `L${label++}`; pending.push({ label: l, at: i + int(1, 3) }); return l; };
    const maxOff = Math.min(B / 2 - 4, 124);
    const v = r();
    if (v < 0.08) emit(`c.addi ${rd()}, ${nz6()}`);
    else if (v < 0.15) emit(`c.li ${rd()}, ${int(-32, 31)}`);
    else if (v < 0.19) emit(`c.lui ${note(pick(POOL.filter((x) => x !== 'sp')))}, ${r() < 0.5 ? int(1, 31) : int(0xfffe0, 0xfffff)}`);
    else if (v < 0.26) emit(`c.mv ${rd()}, ${pick(POOL)}`);
    else if (v < 0.32) emit(`c.add ${rd()}, ${pick(POOL)}`);
    else if (v < 0.36) emit(`c.slli ${rd()}, ${int(1, 31)}`);
    else if (v < 0.42) emit(`${pick(['c.srli', 'c.srai'])} ${pd()}, ${int(1, 31)}`);
    else if (v < 0.46) emit(`c.andi ${pd()}, ${int(-32, 31)}`);
    else if (v < 0.55) { const b = ps(); emit(`${pick(['c.sub', 'c.xor', 'c.or', 'c.and'])} ${pd()}, ${b}`); }
    else if (v < 0.63) {
      // off a prime register holding the window's middle
      const base = pick(PRIME);
      emit(`mv ${base}, ${BASE}`);
      if (r() < 0.5) emit(`c.lw ${pd()}, ${4 * int(0, maxOff / 4)}(${base})`);
      else emit(`c.sw ${ps()}, ${4 * int(0, maxOff / 4)}(${base})`);
    } else if (v < 0.7) {
      emit(`mv sp, ${BASE}`);
      if (r() < 0.5) emit(`c.lwsp ${rd()}, ${4 * int(0, maxOff / 4)}(sp)`);
      else emit(`c.swsp ${pick(POOL)}, ${4 * int(0, maxOff / 4)}(sp)`);
    } else if (v < 0.74) emit(`c.addi4spn ${pd()}, sp, ${4 * int(1, 255)}`);
    else if (v < 0.77) emit(`c.addi16sp sp, ${16 * (r() < 0.5 ? int(-32, -1) : int(1, 31))}`);
    else if (v < 0.84) emit(`${pick(['c.beqz', 'c.bnez'])} ${ps()}, ${ahead()}`);
    else if (v < 0.91) emit(`${pick(['c.j', 'c.jal'])} ${ahead()}`);
    else { emit(`la ${JR}, ${ahead()}`); emit(`${pick(['c.jr', 'c.jalr'])} ${JR}`); }
  };
  /** A custom instruction (riscv/custom.ts) with operands that keep the program well-formed: an address it computes
   *  is BASE (word-aligned) plus a small word-aligned offset; a jump lands one instruction on (jalr: from an auipc, as
   *  the jalr unit does) or on a forward label; a row the data path could not run safely this way becomes an addi. */
  const customUnit = (row: CustomRow, i: number) => {
    const u = uses(row), f = FMT_FIELDS[row.fmt], n = row.name;
    const ahead = (): string => { const l = `L${label++}`; pending.push({ label: l, at: i + int(1, 4) }); return l; };
    const form = (rd: string, rs1: string, rs2: string, imm: number | string) => {
      switch (row.fmt) {
        case 'R': return `${n} ${rd}, ${rs1}, ${rs2}`;
        case 'I': return `${n} ${rd}, ${rs1}, ${imm}`;
        case 'S': return `${n} ${rs2}, ${imm}(${rs1})`;
        case 'B': return `${n} ${rs1}, ${rs2}, ${imm}`;
        default: return `${n} ${rd}, ${imm}`;
      }
    };
    const rd = () => (f.rd && row.regWrite ? dst() : pick(POOL));
    const plain = () => emit(`addi ${dst()}, ${src()}, 1`);
    const mem = u.mem, addOnly = row.alu !== 'funct3' || row.funct3 === 0;
    if (row.next === 'jalr') {
      // target = (A op B) & ~1 = pc of the unit's second instruction + 8: A = the auipc (rs1) or the row's own pc
      const bval = (row.srcA === 'pc' ? 8 : 12) * (row.alu === 'sub' ? -1 : 1);
      if (mem || !addOnly || row.fmt === 'B' || row.fmt === 'U' || (row.srcA === 'rs1' && !f.rs1) || (row.srcB === 'rs2' ? !f.rs2 : !f.imm)) return plain();
      emit(`auipc ${JR}, 0`);
      if (row.srcB === 'rs2') emit(`li ${T1}, ${bval}`);
      emit(form(rd(), JR, T1, bval));
      emit(`addi ${dst()}, ${src()}, 1`);
    } else if (row.next === 'jump') {
      if (mem || row.fmt === 'R' || row.fmt === 'U') return plain();
      emit(form(rd(), src(), src(), row.fmt === 'B' ? ahead() : 8));
      if (row.fmt !== 'B') emit(`addi ${dst()}, ${src()}, 1`);
    } else if (row.next === 'branch') {
      emit(form('zero', src(), src(), ahead()));
    } else {
      if (row.fmt === 'B' || (mem && !addOnly)) return plain();
      const a = row.srcA === 'rs1' && mem ? T0 : src(), b = row.srcB === 'rs2' && mem ? T1 : src();
      if (a === T0) emit(`mv ${T0}, ${BASE}`);
      if (b === T1) emit(`andi ${T1}, ${src()}, 60`);
      const imm = row.fmt === 'U' ? (mem ? int(0, 0x7ffff) : int(0, 0xfffff)) : mem ? 4 * int(-16, 15) : r() < 0.3 ? pick([0, -1, 2047, -2048, 1]) : int(-2048, 2047);
      emit(form(rd(), a, b, imm));
    }
  };
  for (let i = 0; i < n; i++) {
    for (const p of pending.filter((q) => q.at === i)) out.push(`${p.label}:`);
    if (o.c && r() < 0.35) { cUnit(i); continue; }
    if (o.mac && r() < 0.28) {
      const v = r();
      if (v < 0.3) emit(`mac ${src()}, ${src()}`);
      else if (v < 0.6) emit(`mac2 ${src()}, ${src()}`);
      else if (v < 0.68) emit('clracc');
      else if (v < 0.93) {
        // a small shift often, so that the result is a number and the clamp acts now and then
        if (r() < 0.6) { emit(`li ${ADDR}, ${int(0, 20)}`); emit(`racc ${dst()}, ${ADDR}`); } else emit(`racc ${dst()}, ${src()}`);
      } else emit(`.word 0x${(((int(0, 7) << 12) | (int(0, 31) << 15) | (int(0, 31) << 20) | ((r() < 0.5 ? int(1, 127) : 0) << 25) | 0x5b) >>> 0).toString(16).padStart(8, '0')}`);
      continue;
    }
    const u = r();
    if (u < 0.1) {
      // forward branch or jal over 1–4 units
      const l = `L${label++}`;
      pending.push({ label: l, at: i + int(1, 4) });
      if (r() < 0.8) emit(`${pick(B_OPS)} ${src()}, ${src()}, ${l}`);
      else emit(`jal ${dst()}, ${l}`);
    } else if (u < 0.14) {
      // jalr over the next instruction (its base register forwarded from the auipc); misaligned in system mode
      if (o.c) emit('.option norvc'); // the offset counts 4-byte instructions
      emit(`auipc ${JR}, 0`);
      emit(`jalr ${dst()}, ${o.system && r() < 0.2 ? 10 : 12}(${JR})`);
      emit(`addi ${dst()}, ${src()}, 1`);
      if (o.c) emit('.option rvc');
    } else if (u < 0.17) {
      // a short loop: a backward branch taken k − 1 times
      const l = `B${label++}`;
      emit(`li ${LOOP}, ${int(1, 4)}`);
      out.push(`${l}:`);
      for (let k = int(1, 3); k > 0; k--) emit(`${pick(R_OPS)} ${dst()}, ${src()}, ${src()}`);
      emit(`addi ${LOOP}, ${LOOP}, -1`);
      emit(`bnez ${LOOP}, ${l}`);
    } else if (vm && u < 0.2) {
      // a probe page (a good alias, a misaligned superpage, a table or a page beyond 2^32, nothing at all) or a jump to a page without X
      const v = r();
      if (v < 0.6) {
        const base = pick([VM_PROBES.alias, VM_PROBES.alias, VM_PROBES.misaligned, VM_PROBES.farTable, VM_PROBES.farPage, VM_PROBES.unmapped, VM_PROBES.emptyTable]);
        // an alias reaches the window's physical pages; the others are tried at a small offset (a 32-bit machine would wrap the rest)
        const off = base === VM_PROBES.alias ? vm.data + VM_DATA.pages + 4 * int(0, 4 * 1024 - 1) : base === VM_PROBES.farPage ? 0x2000 + 4 * int(0, 0x3800) : 4 * int(0, 255);
        emit(`li ${ADDR}, ${base + off}`);
        if (r() < 0.55) emit(`lw ${dst()}, 0(${ADDR})`); else emit(`sw ${src()}, 0(${ADDR})`);
      } else {
        const target = r() < 0.5 && noExec.length ? winVa(pick(noExec)) + 4 * int(0, 1023) : pick(Object.values(VM_PROBES)) + 4 * int(0, 255);
        emit(`li s8, ${target}`);
        emit('jalr ra, 0(s8)');
      }
    } else if (u < 0.3) {
      const sizes = o.sub ? [1, 2, 4] : [4];
      const size = pick(sizes);
      if (r() < 0.55) mem(size === 4 ? 'lw' : size === 2 ? pick(['lh', 'lhu']) : pick(['lb', 'lbu']), dst(), size);
      else mem(size === 4 ? 'sw' : size === 2 ? 'sh' : 'sb', src(), size);
    } else if (o.m && u < 0.4) {
      emit(`${pick(M_OPS)} ${dst()}, ${src()}, ${src()}`);
    } else if (o.f && u < 0.55) {
      const v = r();
      if (v < 0.3) emit(`${pick(F_RR)} ${fdst()}, ${fsrc()}, ${fsrc()}, ${pick(RM)}`);
      else if (v < 0.38) emit(`${pick(F_FMA)} ${fdst()}, ${fsrc()}, ${fsrc()}, ${fsrc()}, ${pick(RM)}`);
      else if (v < 0.45) emit(`fsqrt.s ${fdst()}, ${fsrc()}, ${pick(RM)}`);
      else if (v < 0.55) emit(`${pick(F_SG)} ${fdst()}, ${fsrc()}, ${fsrc()}`);
      else if (v < 0.63) emit(`${pick(F_CMP)} ${dst()}, ${fsrc()}, ${fsrc()}`);
      else if (v < 0.7) emit(`${pick(['fcvt.w.s', 'fcvt.wu.s'])} ${dst()}, ${fsrc()}, ${pick(RM)}`);
      else if (v < 0.77) emit(`${pick(['fcvt.s.w', 'fcvt.s.wu'])} ${fdst()}, ${src()}, ${pick(RM)}`);
      else if (v < 0.82) emit(`${pick(['fmv.x.w', 'fclass.s'])} ${dst()}, ${fsrc()}`);
      else if (v < 0.86) emit(`fmv.w.x ${fdst()}, ${src()}`);
      else if (v < 0.93) { if (r() < 0.5) mem('flw', fdst(), 4); else mem('fsw', fsrc(), 4); }
      else emit(pick([`frflags ${dst()}`, `fsflags ${dst()}, ${src()}`, `fsrmi ${int(0, 4)}`, `frcsr ${dst()}`]));
    } else if (o.system && u < 0.42) {
      const v = r();
      const scr = vm && SMODE && r() < 0.5 ? 'sscratch' : 'mscratch';
      if (v < 0.35) emit(`${pick(['csrrw', 'csrrs', 'csrrc'])} ${dst()}, ${scr}, ${src()}`);
      else if (v < 0.5) emit(`${pick(['csrrwi', 'csrrsi', 'csrrci'])} ${dst()}, ${scr}, ${int(0, 31)}`);
      else if (v < 0.7) emit(`csrr ${dst()}, ${pick(['mcause', 'mepc', 'mtval', 'misa', 'mhartid', 'mvendorid', 'mstatus', 'mie', 'mscratch', ...(vm && SMODE ? ['sstatus', 'satp', 'sscratch', 'sepc', 'scause', 'stval', 'stvec', 'sie', 'sip'] : [])])}`);
      else if (v < 0.8) emit(pick(['ecall', 'ebreak']));
      else if (vm && v < 0.9) emit(pick(['mret', 'sfence.vma zero, zero', ...(SMODE ? [] : ['wfi', 'sret'])])); // (wfi in S: Spike would wait for an interrupt)
      else emit(`.word 0x${(pick(ILLEGAL) >>> 0).toString(16)}`);
    } else if (o.mp && u < 0.38) {
      const v = r();
      if (v < 0.7) {
        emit(`andi ${ADDR}, ${src()}, ${(B - 1) & ~3}`);
        if (D !== undefined) emit(`xor ${ADDR}, ${ADDR}, ${BASE}`); // no offset in an AMO: D | (ADDR ^ B / 2)
        emit(`${pick(['amoadd.w', 'amoswap.w'])} ${dst()}, ${src()}, (${ADDR})`);
      } else emit(`csrr ${dst()}, mhartid`);
    } else if (o.custom?.length && u < 0.5) {
      customUnit(pick(o.custom), i);
    } else {
      const v = r();
      if (v < 0.45) emit(`${pick(R_OPS)} ${dst()}, ${src()}, ${src()}`);
      else if (v < 0.7) emit(`${pick(I_OPS)} ${dst()}, ${src()}, ${r() < 0.3 ? pick([0, -1, 2047, -2048, 1]) : int(-2048, 2047)}`);
      else if (v < 0.88) emit(`${pick(SH_OPS)} ${dst()}, ${src()}, ${r() < 0.3 ? pick([0, 1, 31]) : int(0, 31)}`);
      else emit(`${pick(['lui', 'auipc'])} ${dst()}, ${int(0, 0xfffff)}`);
    }
  }
  for (const p of pending.filter((q) => q.at >= n)) out.push(`${p.label}:`);
  if (vm) {
    emit(`li s9, ${VM_MAGIC}`);
    emit('ecall');
  } else if (o.system) emit('csrci mstatus, 8');
  out.push('halt:');
  emit('j halt');
  return `${out.join('\n')}\n`;
}
