// Seeded random RV64I(M) programs for checking the 64-bit core against riscv/iss64.ts (tests/cpu64.test.ts). Like
// randprog32: every register is written before it is read (64-bit constants of every shape), branches and jumps go
// forward, loops run a bounded count, loads and stores stay in a window of the data memory at any byte offset (the
// golden model and the core both align an access to its own size inside its doubleword), and the program ends in a
// jump to itself. The W instructions, ld / sd / lwu and 6-bit shift amounts come up as often as the RV32 ones.

export interface Rand64Options {
  /** Body length in units (an instruction, or a short sequence: a loop, a skipped instruction). */
  n?: number;
  m?: boolean;
  /** Data-memory bytes the loads and stores use (power of two, default 256). */
  dmemBytes?: number;
}

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

const R_OPS = ['add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and', 'addw', 'subw', 'sllw', 'srlw', 'sraw'];
const I_OPS = ['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi', 'addiw'];
const SH_OPS = ['slli', 'srli', 'srai'];
const SHW_OPS = ['slliw', 'srliw', 'sraiw'];
const B_OPS = ['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu'];
const M_OPS = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu', 'mulw', 'divw', 'divuw', 'remw', 'remuw'];
const LOADS = ['lb', 'lh', 'lw', 'ld', 'lbu', 'lhu', 'lwu'];
const STORES = ['sb', 'sh', 'sw', 'sd'];
const POOL = ['ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
const LOOP = 's10', BASE = 's11';

/** A 64-bit constant of an interesting shape: small, ±2^31 edges, all ones, one bit, or random. */
function constant(r: () => number): bigint {
  const big = (k: number) => BigInt(Math.floor(r() * 2 ** k));
  switch (Math.floor(r() * 9)) {
    case 0: return BigInt(Math.floor(r() * 64) - 32);
    case 1: return [0x7fffffffn, 0x80000000n, 0xffffffffn, -0x80000000n, -1n, 0x8000000000000000n, 0x7fffffffffffffffn][Math.floor(r() * 7)];
    case 2: return 1n << BigInt(Math.floor(r() * 64));
    case 3: return big(32);
    case 4: return -big(31);
    default: return BigInt.asIntN(64, (big(32) << 32n) | big(32));
  }
}

export function randomProgram64(seed: number, o: Rand64Options = {}): string {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const bytes = o.dmemBytes ?? 256;
  const out: string[] = [`li ${BASE}, 0`];
  for (const x of POOL) out.push(`li ${x}, ${constant(r)}`);
  const n = o.n ?? 40;
  let label = 0;
  const pending: { label: string; at: number }[] = [];
  const reg = () => pick(POOL);
  const simple = (): string => {
    const k = int(0, o.m ? 11 : 9);
    switch (k) {
      case 0: case 1: return `${pick(R_OPS)} ${reg()}, ${reg()}, ${reg()}`;
      case 2: return `${pick(I_OPS)} ${reg()}, ${reg()}, ${int(-2048, 2047)}`;
      case 3: return r() < 0.5 ? `${pick(SH_OPS)} ${reg()}, ${reg()}, ${pick([0, 1, 31, 32, 33, 63, int(0, 63)])}` : `${pick(SHW_OPS)} ${reg()}, ${reg()}, ${pick([0, 1, 30, 31, int(0, 31)])}`;
      case 4: return r() < 0.5 ? `lui ${reg()}, ${int(0, 0xfffff)}` : `auipc ${reg()}, ${int(0, 0xfffff)}`;
      case 5: case 6: return `${pick(LOADS)} ${reg()}, ${int(0, bytes - 1)}(${BASE})`;
      case 7: case 8: return `${pick(STORES)} ${reg()}, ${int(0, bytes - 1)}(${BASE})`;
      case 9: return `li ${reg()}, ${constant(r)}`;
      default: return `${pick(M_OPS)} ${reg()}, ${reg()}, ${reg()}`;
    }
  };
  for (let i = 0; i < n; i++) {
    for (const p of pending.filter((q) => q.at === i)) out.push(`${p.label}:`);
    const u = r();
    if (u < 0.1) {
      const l = `L${label++}`;
      pending.push({ label: l, at: i + int(1, 3) });
      out.push(`${pick(B_OPS)} ${reg()}, ${reg()}, ${l}`);
    } else if (u < 0.13) {
      const l = `L${label++}`;
      pending.push({ label: l, at: i + int(1, 3) });
      out.push(`jal ${reg()}, ${l}`);
    } else if (u < 0.16) {
      const l = `L${label++}`;
      out.push(`li ${LOOP}, ${int(1, 4)}`, `${l}:`, simple(), `addi ${LOOP}, ${LOOP}, -1`, `bnez ${LOOP}, ${l}`);
    } else out.push(simple());
  }
  for (const p of pending.filter((q) => q.at >= n)) out.push(`${p.label}:`);
  out.push('halt: j halt');
  return out.join('\n');
}
