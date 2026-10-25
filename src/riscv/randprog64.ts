// Seeded random RV64I / M programs, for fuzzing chapter 25's 64-bit core against its golden model (iss64.ts) and
// that model against Spike (tests/verify/spike64.ts). Drawn the way randprog32.ts draws RV32 ones: every register
// written before it is read, branches and jumps forward, loops a bounded count, loads and stores inside a window of
// the data memory, a jump to itself at the end; sources are often the last few destinations (forwarding, load-use).
// What is new at 64 bits gets most of the weight: 64-bit constants loaded with li (lui / addiw / slli / addi
// chains), the W operations (addw … sraw, addiw, slliw / srliw / sraiw, mulw, divw, divuw, remw, remuw), 6-bit shift
// amounts, ld / sd / lwu beside the byte, halfword and word accesses, and edge values around both 2^31 and 2^63.
// Every access is aligned to its size (the core, like ISS64, keeps an access inside its doubleword; Spike would trap
// on a misaligned one). Assemble with assemble(src, undefined, { xlen: 64 }). One seed, one program.

import { rng } from './randprog32';

export interface Rand64Options {
  /** Body length in units (an instruction, or a short sequence: a loop, a jalr, an address computation). */
  n?: number;
  m?: boolean;
  /** Data-memory size the window covers, in 32-bit words (power of two, 4 to 512; default 64: 32 doublewords). */
  dmemWords?: number;
  /** Where the data window starts (a multiple of its size; default 0): the data memory wraps, so any base reads the
   * same words, and a von Neumann machine (Spike) needs it clear of the code. */
  dataBase?: number;
}

const R_OPS = ['add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and'];
const RW_OPS = ['addw', 'subw', 'sllw', 'srlw', 'sraw'];
const I_OPS = ['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi'];
const SH_OPS = ['slli', 'srli', 'srai'];
const SHW_OPS = ['slliw', 'srliw', 'sraiw'];
const B_OPS = ['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'];
const M_OPS = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'];
const MW_OPS = ['mulw', 'divw', 'divuw', 'remw', 'remuw'];
/** Loads and stores by size in bytes. */
const LOADS: Record<number, string[]> = { 1: ['lb', 'lbu'], 2: ['lh', 'lhu'], 4: ['lw', 'lwu'], 8: ['ld'] };
const STORES: Record<number, string> = { 1: 'sb', 2: 'sh', 4: 'sw', 8: 'sd' };
/** Body registers; x24–x31 are kept for the loop counter, memory base and address / jump temporaries. */
const POOL = ['ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
const LOOP = 's10', BASE = 's11', ADDR = 't6', JR = 't5';
/** Where 64-bit datapaths break: around 2^31 (the W operations' sign) and 2^63, all-ones halves, shift amounts. */
const EDGE: readonly bigint[] = [0n, 1n, -1n, 2n, 0x7fffffffn, -0x80000000n, 0x80000000n, 0xffffffffn, 0x100000000n,
  0x7fffffffffffffffn, -0x8000000000000000n, -0x7fffffffffffffffn, 0xffffffff00000000n, 0x00000000ffffffffn,
  0x80000000ffffffffn, 0xffffn, 0x8000n, 0xffn, 0x80n, 31n, 32n, 63n, 64n, 0x123456789abcdef0n];

const lit = (v: bigint) => (v < 0n ? `${v}` : `0x${v.toString(16)}`);

export function randomProgram64(seed: number, o: Rand64Options = {}): string {
  const r = rng(seed * 2654435761 + 6464);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const rand64 = () => (BigInt(Math.floor(r() * 2 ** 32)) << 32n) | BigInt(Math.floor(r() * 2 ** 32));
  // a 64-bit value: an edge, a random word sign- or zero-extended (the W operations' shapes), or 64 random bits
  const value = (): bigint => {
    const v = r();
    if (v < 0.4) return pick(EDGE);
    if (v < 0.6) { const w = BigInt(Math.floor(r() * 2 ** 32)); return r() < 0.5 ? BigInt.asIntN(32, w) : w; }
    return BigInt.asIntN(64, rand64());
  };
  const n = o.n ?? 60, W = o.dmemWords ?? 64, B = 4 * W, D = o.dataBase;
  if (B < 16 || B > 2048 || B & (B - 1)) throw new Error('dmemWords: a power of two from 4 to 512');
  const out: string[] = [];
  const emit = (s: string) => out.push(`        ${s}`);
  const recent: string[] = [];
  const src = () => (recent.length && r() < 0.55 ? pick(recent.slice(-3)) : r() < 0.06 ? 'zero' : pick(POOL));
  const dst = () => {
    const d = r() < 0.04 ? 'zero' : pick(POOL);
    recent.push(d);
    if (recent.length > 6) recent.shift();
    return d;
  };

  for (const x of POOL) emit(`li ${x}, ${lit(value())}`);
  emit(`li ${BASE}, ${(D ?? 0) + B / 2}`);
  for (let i = 0; i < 4; i++) emit(`sd ${pick(POOL)}, ${8 * int(-B / 16, B / 16 - 1)}(${BASE})`);

  const pending: { label: string; at: number }[] = [];
  let label = 0;
  /** A load or store of `size` bytes: base + offset in the window, or an address computed from a register. */
  const mem = (op: string, reg: string, size: number) => {
    if (r() < 0.3) {
      emit(`andi ${ADDR}, ${src()}, ${(B - 1) & ~(size - 1)}`);
      if (D === undefined) emit(`${op} ${reg}, 0(${ADDR})`);
      else {
        emit(`add ${ADDR}, ${ADDR}, ${BASE}`);
        emit(`${op} ${reg}, ${-B / 2}(${ADDR})`);
      }
    } else emit(`${op} ${reg}, ${size * int(-B / 2 / size, B / 2 / size - 1)}(${BASE})`);
  };
  for (let i = 0; i < n; i++) {
    for (const p of pending.filter((q) => q.at === i)) out.push(`${p.label}:`);
    const u = r();
    if (u < 0.09) {
      // forward branch or jal over 1–4 units
      const l = `L${label++}`;
      pending.push({ label: l, at: i + int(1, 4) });
      if (r() < 0.8) emit(`${pick(B_OPS)} ${src()}, ${src()}, ${l}`);
      else emit(`jal ${dst()}, ${l}`);
    } else if (u < 0.12) {
      // jalr over the next instruction, its base forwarded from the auipc
      emit(`auipc ${JR}, 0`);
      emit(`jalr ${dst()}, 12(${JR})`);
      emit(`addi ${dst()}, ${src()}, 1`);
    } else if (u < 0.15) {
      // a short loop: a backward branch taken k − 1 times
      const l = `B${label++}`;
      emit(`li ${LOOP}, ${int(1, 4)}`);
      out.push(`${l}:`);
      for (let k = int(1, 3); k > 0; k--) emit(`${pick(r() < 0.5 ? R_OPS : RW_OPS)} ${dst()}, ${src()}, ${src()}`);
      emit(`addi ${LOOP}, ${LOOP}, -1`);
      emit(`bnez ${LOOP}, ${l}`);
    } else if (u < 0.3) {
      const size = pick([1, 2, 4, 8, 8]);
      if (r() < 0.55) mem(pick(LOADS[size]), dst(), size);
      else mem(STORES[size], src(), size);
    } else if (o.m && u < 0.42) {
      emit(`${pick(r() < 0.6 ? M_OPS : MW_OPS)} ${dst()}, ${src()}, ${src()}`);
    } else if (u < 0.47) {
      // a 64-bit constant mid-program (up to eight instructions), or the W pseudo-instructions
      if (r() < 0.75) emit(`li ${dst()}, ${lit(value())}`);
      else emit(`${pick(['sext.w', 'negw'])} ${dst()}, ${src()}`);
    } else {
      const v = r();
      if (v < 0.25) emit(`${pick(R_OPS)} ${dst()}, ${src()}, ${src()}`);
      else if (v < 0.45) emit(`${pick(RW_OPS)} ${dst()}, ${src()}, ${src()}`);
      else if (v < 0.6) emit(`${pick(I_OPS)} ${dst()}, ${src()}, ${r() < 0.3 ? pick([0, -1, 2047, -2048, 1]) : int(-2048, 2047)}`);
      else if (v < 0.68) emit(`addiw ${dst()}, ${src()}, ${r() < 0.3 ? pick([0, -1, 2047, -2048, 1]) : int(-2048, 2047)}`);
      else if (v < 0.8) emit(`${pick(SH_OPS)} ${dst()}, ${src()}, ${r() < 0.4 ? pick([0, 1, 31, 32, 63]) : int(0, 63)}`);
      else if (v < 0.9) emit(`${pick(SHW_OPS)} ${dst()}, ${src()}, ${r() < 0.3 ? pick([0, 1, 31]) : int(0, 31)}`);
      else emit(`${pick(['lui', 'auipc'])} ${dst()}, ${int(0, 0xfffff)}`);
    }
  }
  for (const p of pending.filter((q) => q.at >= n)) out.push(`${p.label}:`);
  out.push('halt:');
  emit('j halt');
  return `${out.join('\n')}\n`;
}
