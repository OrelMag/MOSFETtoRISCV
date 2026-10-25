// The benchmark set: one fixed set of programs run on every RV32 CPU the chapters build
// (scripts/benchmarks.ts). Each fits the smallest machine (128-word ROM, 64-word data memory),
// uses word access only and ends in a self-loop. Each comes with its result computed here, in
// TypeScript, independently of the golden model (tests/benchmarks.test.ts checks both agree).

export interface Benchmark {
  id: string;
  name: string;
  blurb: string;
  /** Extensions the program needs (it runs only on CPUs that have them). */
  needs?: { m?: boolean; f?: boolean };
  source: string;
  /** The program for RV64 (chapter 25), where it differs: its 32-bit arithmetic made explicit with the W instructions. */
  source64?: string;
  /** Data-memory words the program leaves behind (word index → value), computed in TypeScript. */
  expect(): Map<number, number>;
}

/** xorshift32 (Marsaglia), the programs' data generator: shifts and xors only, so RV32I runs it. */
export function xorshift32(seed: number, n: number): number[] {
  const out: number[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out.push(x);
  }
  return out;
}

const GEN = `gen:    slli t3, t0, 13      # xorshift32
        xor  t0, t0, t3
        srli t3, t0, 17
        xor  t0, t0, t3
        slli t3, t0, 5
        xor  t0, t0, t3
        sw   t0, 0(t1)
        addi t1, t1, 4
        bne  t1, t2, gen`;

/** The same generator on RV64: the shifts must stay within 32 bits (slliw / srliw), or bits shifted past bit 31 come back. */
const GEN64 = GEN.replace(/slli t3/g, 'slliw t3').replace('srli t3', 'srliw t3');

/** A benchmark's source for a CPU of this width. */
export const benchSource = (b: Benchmark, xlen: 32 | 64 = 32) => (xlen === 64 && b.source64) || b.source;

const words = (base: number, vs: number[]) => new Map(vs.map((v, i) => [base + i, v >>> 0]));

function fib(n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

/** CRC-32 (IEEE 802.3, reflected, as zlib) of the words' bytes, least significant first. */
export function crc32(ws: number[]): number {
  let c = 0xffffffff;
  for (const w of ws) for (let b = 0; b < 4; b++) {
    c ^= (w >>> (8 * b)) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** C = A · B for the 4 × 4 matrices of the matmul programs: A[k] = k + 1, B[k] = 16 − k (row-major). */
function matmul(): number[] {
  const A = Array.from({ length: 16 }, (_, k) => k + 1), B = Array.from({ length: 16 }, (_, k) => 16 - k);
  const C: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += A[4 * i + k] * B[4 * k + j];
    C.push(s);
  }
  return C;
}

const f32 = Math.fround;
const bitsOf = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0];

/** The float kernel's results: A, B, C = A · B (fused multiply-adds) and sqrt(trace C), as float32 bits. */
function fmatmul(): Map<number, number> {
  const A = Array.from({ length: 16 }, (_, k) => f32((k + 1) / 3)), B = Array.from({ length: 16 }, (_, k) => f32((16 - k) / 7));
  const C: number[] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    // fmadd rounds once: the product of two floats is exact in a double, the sum then rounds
    // to 53 bits before float32, which matches a single rounding unless the sum lands exactly
    // between two floats (it does not here: tests/benchmarks.test.ts checks against the golden model)
    let s = 0;
    for (let k = 0; k < 4; k++) s = f32(A[4 * i + k] * B[4 * k + j] + s);
    C.push(s);
  }
  const tr = f32(f32(f32(C[0] + C[5]) + C[10]) + C[15]);
  return new Map([...words(0, A.map(bitsOf)), ...words(16, B.map(bitsOf)), ...words(32, C.map(bitsOf)), [48, bitsOf(f32(Math.sqrt(tr)))]]);
}

/** The integer matrix multiply, with a software multiply (RV32I) or mul (M). */
function matmulSource(m: boolean): string {
  return `# C = A · B, 4 × 4 words: A at word 0, B at 16, C at 32
# init: A[k] = k + 1, B[k] = 16 - k
        li   t0, 0            # byte offset of element k
        li   t1, 64
        li   t2, 1            # k + 1
init:   sw   t2, 0(t0)        # A[k]
        li   t3, 17
        sub  t3, t3, t2
        sw   t3, 64(t0)       # B[k]
        addi t2, t2, 1
        addi t0, t0, 4
        bne  t0, t1, init
        li   s0, 0            # 16 i: row of A and C
row:    li   s1, 0            # 4 j: column of B and C
col:    li   s2, 0            # sum
        li   s3, 0            # 4 k
dot:    add  t0, s0, s3
        lw   a0, 0(t0)        # A[i][k]
        slli t0, s3, 2
        add  t0, t0, s1
        lw   a1, 64(t0)       # B[k][j]
${m ? '        mul  a0, a0, a1' : '        call mul'}
        add  s2, s2, a0
        addi s3, s3, 4
        li   t0, 16
        bne  s3, t0, dot
        add  t0, s0, s1
        sw   s2, 128(t0)      # C[i][j]
        addi s1, s1, 4
        li   t0, 16
        bne  s1, t0, col
        addi s0, s0, 16
        li   t0, 64
        bne  s0, t0, row
halt:   j    halt
${m ? '' : `
# a0 = a0 * a1 (a1 >= 0): shift and add, one step per bit of a1
mul:    li   t1, 0
mloop:  andi t2, a1, 1
        beqz t2, mskip
        add  t1, t1, a0
mskip:  slli a0, a0, 1
        srli a1, a1, 1
        bnez a1, mloop
        mv   a0, t1
        ret`}`;
}

export const BENCHMARKS: Benchmark[] = [
  {
    id: 'fib',
    name: 'Fibonacci',
    blurb: 'fib(12) by naive recursion: 465 calls, each saving ra and n on a stack in data memory. Calls, returns and loads dominate.',
    source: `# fib(12) = 144, recursively; the result at word 0
        li   sp, 256          # stack: top of the 64-word data memory
        li   a0, 12
        call fib
        sw   a0, 0(zero)
halt:   j    halt

# a0 = fib(a0)
fib:    li   t0, 2
        blt  a0, t0, done     # fib(0) = 0, fib(1) = 1
        addi sp, sp, -12
        sw   ra, 8(sp)
        sw   a0, 4(sp)
        addi a0, a0, -1
        call fib
        sw   a0, 0(sp)        # fib(n - 1)
        lw   a0, 4(sp)
        addi a0, a0, -2
        call fib
        lw   t0, 0(sp)
        add  a0, a0, t0
        lw   ra, 8(sp)
        addi sp, sp, 12
done:   ret`,
    expect: () => new Map([[0, fib(12)]]),
  },
  {
    id: 'sort',
    name: 'Insertion sort',
    blurb: '32 pseudo-random words (xorshift32) sorted in place, signed. Data-dependent branches and a load right before its use.',
    source: `# 32 words of xorshift32 at word 0, then sorted (signed, ascending)
        li   t0, 0x92d68ca2   # seed
        li   t1, 0            # byte address
        li   t2, 128          # 32 words
${GEN}
        li   t1, 4            # i = 1
outer:  lw   t3, 0(t1)        # key = a[i]
        mv   t4, t1           # j = i
inner:  beqz t4, place
        lw   t5, -4(t4)       # a[j - 1]
        ble  t5, t3, place
        sw   t5, 0(t4)        # move it up
        addi t4, t4, -4
        j    inner
place:  sw   t3, 0(t4)
        addi t1, t1, 4
        bne  t1, t2, outer
halt:   j    halt`,
    get source64() { return this.source.replace(GEN, GEN64); },
    expect: () => words(0, xorshift32(0x92d68ca2, 32).map((x) => x | 0).sort((a, b) => a - b)),
  },
  {
    id: 'matmul',
    name: 'Matrix multiply',
    blurb: '4 × 4 integer matrices, C = A · B: 64 products, each by a shift-and-add subroutine (RV32I has no multiply).',
    source: matmulSource(false),
    expect: () => new Map([...words(0, Array.from({ length: 16 }, (_, k) => k + 1)), ...words(16, Array.from({ length: 16 }, (_, k) => 16 - k)), ...words(32, matmul())]),
  },
  {
    id: 'matmul-m',
    name: 'Matrix multiply (mul)',
    blurb: 'The same matrices with the M extension\'s mul in place of the subroutine.',
    needs: { m: true },
    source: matmulSource(true),
    expect: () => new Map([...words(0, Array.from({ length: 16 }, (_, k) => k + 1)), ...words(16, Array.from({ length: 16 }, (_, k) => 16 - k)), ...words(32, matmul())]),
  },
  {
    id: 'crc',
    name: 'CRC-32',
    blurb: 'CRC-32 (as zlib) of 64 bytes, one bit at a time: a word enters the register whole, then 32 shift / conditional-xor steps.',
    source: `# CRC-32 of 16 words of xorshift32 (at word 0); the CRC at word 16
        li   t0, 0x2545f491   # seed
        li   t1, 0
        li   t2, 64           # 16 words
${GEN}
        li   a0, -1           # crc = 0xffffffff
        li   a1, 0xedb88320   # the reflected polynomial
        li   t1, 0
word:   lw   t3, 0(t1)
        xor  a0, a0, t3       # reflected CRC: bytes enter least significant first
        li   t4, 32
bit:    andi t5, a0, 1
        srli a0, a0, 1
        beqz t5, next
        xor  a0, a0, a1
next:   addi t4, t4, -1
        bnez t4, bit
        addi t1, t1, 4
        bne  t1, t2, word
        not  a0, a0
        sw   a0, 64(zero)
halt:   j    halt`,
    get source64() { return this.source.replace(GEN, GEN64).replace('srli a0, a0, 1', 'srliw a0, a0, 1  # the CRC is 32 bits: keep the shift there'); },
    expect: () => { const d = xorshift32(0x2545f491, 16); return new Map([...words(0, d), [16, crc32(d)]]); },
  },
  {
    id: 'fmatmul',
    name: 'Float kernel',
    blurb: 'Single precision: A[k] = (k + 1) / 3 and B[k] = (16 − k) / 7 by fdiv, C = A · B by fmadd, then sqrt of the trace.',
    needs: { f: true },
    source: `# float32: A at word 0, B at 16, C = A · B at 32, sqrt(trace C) at 48
        li   t0, 3
        fcvt.s.w fs0, t0
        li   t0, 7
        fcvt.s.w fs1, t0
        li   t0, 0            # byte offset of element k
        li   t1, 64
        li   t2, 1            # k + 1
init:   fcvt.s.w ft0, t2
        fdiv.s ft0, ft0, fs0  # A[k] = (k + 1) / 3
        fsw  ft0, 0(t0)
        li   t3, 17
        sub  t3, t3, t2
        fcvt.s.w ft0, t3
        fdiv.s ft0, ft0, fs1  # B[k] = (16 - k) / 7
        fsw  ft0, 64(t0)
        addi t2, t2, 1
        addi t0, t0, 4
        bne  t0, t1, init
        li   s0, 0            # 16 i
row:    li   s1, 0            # 4 j
col:    fcvt.s.w fs2, zero    # sum = 0
        li   s3, 0            # 4 k
dot:    add  t0, s0, s3
        flw  fa0, 0(t0)       # A[i][k]
        slli t0, s3, 2
        add  t0, t0, s1
        flw  fa1, 64(t0)      # B[k][j]
        fmadd.s fs2, fa0, fa1, fs2
        addi s3, s3, 4
        li   t0, 16
        bne  s3, t0, dot
        add  t0, s0, s1
        fsw  fs2, 128(t0)     # C[i][j]
        addi s1, s1, 4
        li   t0, 16
        bne  s1, t0, col
        addi s0, s0, 16
        li   t0, 64
        bne  s0, t0, row
        flw  ft0, 128(zero)   # trace
        flw  ft1, 148(zero)
        fadd.s ft0, ft0, ft1
        flw  ft1, 168(zero)
        fadd.s ft0, ft0, ft1
        flw  ft1, 188(zero)
        fadd.s ft0, ft0, ft1
        fsqrt.s ft0, ft0
        fsw  ft0, 192(zero)
halt:   j    halt`,
    expect: fmatmul,
  },
];

/** On a multi-core, every hart but hart 0 parks first (as the riscv-tests' environment does). */
export const PARK = `        csrr t0, mhartid
park:   bnez t0, park
`;
