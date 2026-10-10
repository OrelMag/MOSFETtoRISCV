// Seeded random RV32 programs for fuzzing the CPUs against the golden model (tests/verify/fuzz.ts). Every
// register is written before it is read, branches and jumps go forward (loops run a bounded count), loads and
// stores stay in a window of the data memory, and the program ends in a jump to itself. Sources are often
// registers written just before, so forwarding, load-use stalls and branches right after loads come up all
// the time. Options switch on what a CPU implements: byte / halfword access, M, F, the system CPU's CSRs,
// traps and timer interrupt, the multi-core's atomics and hart id. One seed, one program.

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
}

/** mulberry32: small, fast, good enough. */
function rng(seed: number): () => number {
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
const LOOP = 's10', BASE = 's11', ADDR = 't6', JR = 't5', H0 = 't3', H1 = 't4', T0 = 's8', T1 = 's9';
/** Interesting words: where datapaths break. */
const EDGE = [0, 1, -1, 2, 0x7fffffff, -0x80000000, 0x80000001, 0xffff, 0x8000, 0x7fff, 31, 32, 0xff, 0x80];
/** Float bit patterns: zeros, ones, infinities, NaNs (quiet, signalling), subnormals, extremes. */
const FEDGE = [0, 0x80000000, 0x3f800000, 0xbfc00000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 0xffc00001,
  0x00000001, 0x807fffff, 0x7f7fffff, 0x00800000, 0x4f000000, 0xcf000000, 0x4b800000, 0x3effffff, 0x3f000000];
/** Words that are not RV32IM / Zicsr instructions (all-zero, all-one, slli with shamt[5], an unknown CSR, a 64-bit load). */
const ILLEGAL = [0x00000000, 0xffffffff, 0x02051513, 0x7c002573, 0x00053503];

export function randomProgram32(seed: number, o: Rand32Options = {}): string {
  const r = rng(seed * 2654435761 + 12345);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const word = () => (r() < 0.5 ? pick(EDGE) : (r() * 2 ** 32) | 0);
  const n = o.n ?? 60, W = o.dmemWords ?? 32, B = 4 * W;
  const out: string[] = [];
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
  if (o.system) {
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
  emit(`li ${BASE}, ${B / 2}`);
  for (let i = 0; i < 4; i++) emit(`sw ${pick(POOL)}, ${4 * int(-W / 2, W / 2 - 1)}(${BASE})`);
  if (o.f) {
    for (const fr of FPOOL) { emit(`li ${T0}, ${r() < 0.7 ? pick(FEDGE) : word()}`); emit(`fmv.w.x ${fr}, ${T0}`); }
    emit(`fsrmi ${int(0, 4)}`);
  }
  if (o.system && r() < 0.7) {
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
    if (r() < 0.3) {
      emit(`andi ${ADDR}, ${src()}, ${(B - 1) & ~(misalign ? 0 : size - 1)}`);
      emit(`${op} ${reg}, 0(${ADDR})`);
    } else {
      const off = size * int(-B / 2 / size, B / 2 / size - 1) + (misalign ? 1 : 0);
      emit(`${op} ${reg}, ${off}(${BASE})`);
    }
  };
  for (let i = 0; i < n; i++) {
    for (const p of pending.filter((q) => q.at === i)) out.push(`${p.label}:`);
    const u = r();
    if (u < 0.1) {
      // forward branch or jal over 1–4 units
      const l = `L${label++}`;
      pending.push({ label: l, at: i + int(1, 4) });
      if (r() < 0.8) emit(`${pick(B_OPS)} ${src()}, ${src()}, ${l}`);
      else emit(`jal ${dst()}, ${l}`);
    } else if (u < 0.14) {
      // jalr over the next instruction (its base register forwarded from the auipc); misaligned in system mode
      emit(`auipc ${JR}, 0`);
      emit(`jalr ${dst()}, ${o.system && r() < 0.2 ? 10 : 12}(${JR})`);
      emit(`addi ${dst()}, ${src()}, 1`);
    } else if (u < 0.17) {
      // a short loop: a backward branch taken k − 1 times
      const l = `B${label++}`;
      emit(`li ${LOOP}, ${int(1, 4)}`);
      out.push(`${l}:`);
      for (let k = int(1, 3); k > 0; k--) emit(`${pick(R_OPS)} ${dst()}, ${src()}, ${src()}`);
      emit(`addi ${LOOP}, ${LOOP}, -1`);
      emit(`bnez ${LOOP}, ${l}`);
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
      if (v < 0.35) emit(`${pick(['csrrw', 'csrrs', 'csrrc'])} ${dst()}, mscratch, ${src()}`);
      else if (v < 0.5) emit(`${pick(['csrrwi', 'csrrsi', 'csrrci'])} ${dst()}, mscratch, ${int(0, 31)}`);
      else if (v < 0.7) emit(`csrr ${dst()}, ${pick(['mcause', 'mepc', 'mtval', 'misa', 'mhartid', 'mvendorid', 'mstatus', 'mie', 'mscratch'])}`);
      else if (v < 0.8) emit(pick(['ecall', 'ebreak']));
      else emit(`.word 0x${(pick(ILLEGAL) >>> 0).toString(16)}`);
    } else if (o.mp && u < 0.38) {
      const v = r();
      if (v < 0.7) {
        emit(`andi ${ADDR}, ${src()}, ${(B - 1) & ~3}`);
        emit(`${pick(['amoadd.w', 'amoswap.w'])} ${dst()}, ${src()}, (${ADDR})`);
      } else emit(`csrr ${dst()}, mhartid`);
    } else {
      const v = r();
      if (v < 0.45) emit(`${pick(R_OPS)} ${dst()}, ${src()}, ${src()}`);
      else if (v < 0.7) emit(`${pick(I_OPS)} ${dst()}, ${src()}, ${r() < 0.3 ? pick([0, -1, 2047, -2048, 1]) : int(-2048, 2047)}`);
      else if (v < 0.88) emit(`${pick(SH_OPS)} ${dst()}, ${src()}, ${r() < 0.3 ? pick([0, 1, 31]) : int(0, 31)}`);
      else emit(`${pick(['lui', 'auipc'])} ${dst()}, ${int(0, 0xfffff)}`);
    }
  }
  for (const p of pending.filter((q) => q.at >= n)) out.push(`${p.label}:`);
  if (o.system) emit('csrci mstatus, 8');
  out.push('halt:');
  emit('j halt');
  return `${out.join('\n')}\n`;
}
