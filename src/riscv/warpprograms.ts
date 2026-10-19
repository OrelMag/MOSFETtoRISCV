// Programs for the warp cores (chapter 29): warp 0 starts the others with wspawn, then every thread
// (tid = warp · lanes + lane) takes every T-th element, T = nwarps · nlanes. Their input is in data
// memory from the start (`data`); `expect` gives result words computed here, independently of the
// models and the hardware.

import { GFX, type Mesh, MESHES, meshData, packVertex, transformed, vertexKernel } from './gfxprograms';

export interface WarpProgram {
  id: string;
  title: string;
  /** Assembly for n lanes per warp (T = nwarps << log2 n: the lanes have no multiplier). */
  source: (n: number) => string;
  /** Data memory words at power-on (128 words: data memory of 2^7). */
  data: () => number[];
  /** Expected data-memory words after the run (word index → value). */
  expect: () => Map<number, number>;
  /** Chapter 30's core only: it uses shared memory, bar or amoadd.w. */
  lsu?: boolean;
  /** It uses shared memory. */
  shared?: boolean;
  /** It multiplies (the lanes need multipliers). */
  mul?: boolean;
  /** It is written for exactly this many threads (warps × lanes). */
  threads?: number;
}

export const WARP_DMEM_K = 7;
/** Shared memory of chapter 30's core: 2^6 words, 4 banks of 16. */
export const WARP_SMEM_K = 6;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** Warp 0 starts the other warps; then each thread: t0 = tid, t2 = T. */
const start = (n: number) => `        csrr  t0, nwarps
        la    t1, start
        wspawn t0, t1           # warps 1 … nwarps − 1 begin at start
start:  csrr  t0, tid
        csrr  t2, nwarps
        slli  t2, t2, ${Math.round(Math.log2(n))}         # T = nwarps · ${n} lanes threads`;

export const WARP_PROGRAMS: WarpProgram[] = [
  {
    id: 'saxpy64',
    title: 'y = 3·x + y on 64 elements',
    source: (n) => `# x[i] at word i, y[i] at word 64 + i; thread tid takes i = tid, tid + T, …
${start(n)}
        li    t6, 64
        mv    t3, t0
loop:   slli  t4, t3, 2
        lw    t5, 0(t4)         # x[i]: 8 cycles away
        lw    a1, 256(t4)       # y[i]: issued right behind it
        slli  a0, t5, 1         # the first use of x[i]: waits here
        add   a0, a0, t5
        add   a0, a0, a1
        sw    a0, 256(t4)
        add   t3, t3, t2
        blt   t3, t6, loop
end:    j     end`,
    data: () => [...range(64).map((i) => i + 1), ...range(64).map((i) => 100 - i)],
    expect: () => new Map(range(64).map((i) => [64 + i, 3 * (i + 1) + 100 - i])),
  },
  {
    id: 'sum4',
    title: 'Each thread sums four words (dependent adds)',
    source: (n) => `# s[tid] = a[4·tid] + … + a[4·tid + 3]: four loads in flight, then a chain of adds
${start(n)}
        li    t6, 24            # 24 sums of 4 words
        mv    t3, t0
loop:   slli  t4, t3, 4         # 4 words = 16 bytes per sum
        lw    t5, 0(t4)
        lw    a0, 4(t4)
        lw    a1, 8(t4)
        lw    a2, 12(t4)
        add   t5, t5, a0
        add   t5, t5, a1
        add   t5, t5, a2
        slli  t4, t3, 2
        sw    t5, 384(t4)       # s[tid] at word 96 + tid
        add   t3, t3, t2
        blt   t3, t6, loop
end:    j     end`,
    data: () => range(96).map((i) => (i * 37 + 11) % 1000),
    expect: () => {
      const d = range(96).map((i) => (i * 37 + 11) % 1000);
      return new Map(range(24).map((s) => [96 + s, d[4 * s] + d[4 * s + 1] + d[4 * s + 2] + d[4 * s + 3]]));
    },
  },
  // ---- chapter 30 ----
  groupSum('rows'),
  groupSum('cols'),
  reduce('seq'),
  reduce('int'),
  {
    id: 'hist',
    title: 'A histogram of 64 values in 16 bins with amoadd.w',
    lsu: true,
    source: (n) => `# value v at word i (0 … 63) adds 1 to bin v at word 64 + v; thread tid takes i = tid, tid + T, …
${start(n)}
        li    t6, 64
        li    a1, 1
        mv    t3, t0
loop:   slli  t4, t3, 2
        lw    a0, 0(t4)         # the value: 0 … 15
        slli  a0, a0, 2
        addi  a0, a0, 256       # &bin[v]
        amoadd.w x0, a1, (a0)   # one lane at a time: lanes on one bin all count
        add   t3, t3, t2
        blt   t3, t6, loop
end:    j     end`,
    data: () => HIST,
    expect: () => {
      const bins = Array(16).fill(0);
      for (const v of HIST) bins[v]++;
      return new Map(bins.map((c, b) => [64 + b, c]));
    },
  },
  {
    id: 'matmul',
    title: 'C = A · B (8 × 4 by 4 × 8), every operand from global memory',
    lsu: true, mul: true,
    source: (n) => `# A (8 × 4) at word 0, B (4 × 8) at word 32, C (8 × 8) at word 64; thread tid computes C[i][j]
# for e = tid, tid + T, … (i = e / 8, j = e mod 8): row i of A, column j of B
${start(n)}
        li    t6, 64
        mv    t3, t0
loop:   srli  a0, t3, 3         # i
        andi  a1, t3, 7         # j
        slli  a2, a0, 4         # &A[i][0]: 16 bytes a row
        slli  a3, a1, 2         # &B[0][j] − 128
        lw    a4, 0(a2)         # A[i][0 … 3]: one word for the whole warp
        lw    a5, 4(a2)
        lw    a6, 8(a2)
        lw    a7, 12(a2)
        lw    s2, 128(a3)       # B[0 … 3][j]: the warp's four j side by side
        lw    s3, 160(a3)
        lw    s4, 192(a3)
        lw    s5, 224(a3)
        mul   a4, a4, s2
        mul   a5, a5, s3
        mul   a6, a6, s4
        mul   a7, a7, s5
        add   a4, a4, a5
        add   a6, a6, a7
        add   a4, a4, a6
        slli  t4, t3, 2
        sw    a4, 256(t4)       # C[i][j]
        add   t3, t3, t2
        blt   t3, t6, loop
end:    j     end`,
    data: matData,
    expect: matExpect,
  },
  {
    id: 'matmulTiled',
    title: 'C = A · B through shared memory, a 4 × 4 tile at a time',
    lsu: true, mul: true, shared: true, threads: 16,
    source: (n) => `# The same product. Thread tid = 4 r + c copies one element of an A tile and one of a B tile into shared
# memory, bar, computes C's element (r, c) of the output tile from the tiles, bar. A tile (4 rows of A) serves
# two output tiles, so A is read from global memory once, B twice: 96 words instead of 512.
${start(n)}
        li    s0, 0x1000        # shared memory: As at word 0, Bs at word 16
        csrr  s1, nwarps
        srli  a0, t0, 2         # r
        andi  a1, t0, 3         # c
        slli  t4, t0, 2
        add   s6, s0, t4        # &As[r][c]; &Bs[r][c] is 64 bytes on
        slli  a2, a0, 4
        add   s7, s0, a2        # &As[r][0]
        slli  a3, a1, 2
        add   s8, s0, a3        # &Bs[0][c] − 64
        slli  a4, a0, 5
        add   s9, a4, a3        # 32 r + 4 c: B[r][c] − 128, C[r][c] − 256
        li    t5, 0             # 64 · ti: A tile ti is 16 words
tileA:  add   a5, t4, t5
        lw    a6, 0(a5)         # A[4 ti + r][c]
        sw    a6, 0(s6)         # As[r][c]
        li    t6, 0             # 16 · tj
tileB:  add   a5, s9, t6
        lw    a6, 128(a5)       # B[r][4 tj + c]
        sw    a6, 64(s6)        # Bs[r][c]
        bar   x0, s1            # both tiles complete
        lw    a4, 0(s7)         # As[r][0 … 3]: one word for the whole warp (broadcast)
        lw    a5, 4(s7)
        lw    a6, 8(s7)
        lw    a7, 12(s7)
        lw    s2, 64(s8)        # Bs[0 … 3][c]: four banks
        lw    s3, 80(s8)
        lw    s4, 96(s8)
        lw    s5, 112(s8)
        mul   a4, a4, s2
        mul   a5, a5, s3
        mul   a6, a6, s4
        mul   a7, a7, s5
        add   a4, a4, a5
        add   a6, a6, a7
        add   a4, a4, a6
        add   a5, s9, t6
        add   a5, a5, t5
        add   a5, a5, t5        # 32 r + 4 c + 16 tj + 128 ti
        sw    a4, 256(a5)       # C[4 ti + r][4 tj + c]
        bar   x0, s1            # every thread done with the tiles
        addi  t6, t6, 16
        li    a7, 32
        blt   t6, a7, tileB
        addi  t5, t5, 64
        li    a7, 128
        blt   t5, a7, tileA
end:    j     end`,
    data: matData,
    expect: matExpect,
  },
  ...MESHES.map(vertexProgram),
];

/** Chapter 32's vertex kernel for one mesh, frame 0: one warp of four lanes, the vertex buffer as its result. */
function vertexProgram(m: Mesh): WarpProgram {
  return {
    id: m.id === 'cube' ? 'vertexCube' : 'vertexTri',
    title: m.id === 'cube' ? 'Vertex kernel: the cube, frame 0' : 'Vertex kernel: the triangle, frame 0',
    mul: true, threads: 4,
    source: () => vertexKernel(m),
    data: () => meshData(m),
    expect: () => new Map([...transformed(m, 0).map((v, i) => [GFX.vbuf + i, packVertex(v)] as [number, number]), [GFX.frame, 1]]),
  };
}

/** 64 values in 0 … 15, some bins much fuller than others. */
const HIST = range(64).map((i) => ((i * i * 7 + i * 3) >> 2) % 16);

function matData(): number[] {
  const A = range(32).map((i) => ((i * 5 + 3) % 9) - 2);
  const B = range(32).map((i) => ((i * 7 + 1) % 11) - 4);
  return [...A, ...B].map((v) => v >>> 0);
}

function matExpect(): Map<number, number> {
  const d = matData().map((v) => v | 0);
  const A = (i: number, k: number) => d[4 * i + k], B = (k: number, j: number) => d[32 + 8 * k + j];
  const out = new Map<number, number>();
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) out.set(64 + 8 * i + j, [0, 1, 2, 3].reduce((s, k) => s + A(i, k) * B(k, j), 0) >>> 0);
  return out;
}

/**
 * 16 groups of 4 values, thread tid summing groups tid, tid + T, …: by rows (group g at words 4g … 4g + 3,
 * so the lanes' addresses are 16 bytes apart: a line each) or by columns (group g at words g, g + 16, g + 32,
 * g + 48: the lanes' addresses side by side, one line).
 */
function groupSum(layout: 'rows' | 'cols'): WarpProgram {
  const v = (g: number, j: number) => (g * 13 + j * 29 + 7) % 100;
  const rows = layout === 'rows';
  return {
    id: layout,
    title: rows ? 'Sixteen sums of four, stored by rows' : 'Sixteen sums of four, stored by columns',
    lsu: true,
    source: (n) => `# group g's values at ${rows ? 'words 4g … 4g + 3' : 'words g, g + 16, g + 32, g + 48'}; its sum at word 64 + g
${start(n)}
        li    t6, 16
        mv    t3, t0
loop:   slli  t4, t3, ${rows ? 4 : 2}
        lw    a0, 0(t4)
        lw    a1, ${rows ? 4 : 64}(t4)
        lw    a2, ${rows ? 8 : 128}(t4)
        lw    a3, ${rows ? 12 : 192}(t4)
        add   a0, a0, a1
        add   a2, a2, a3
        add   a0, a0, a2
        slli  t4, t3, 2
        sw    a0, 256(t4)
        add   t3, t3, t2
        blt   t3, t6, loop
end:    j     end`,
    data: () => {
      const d = Array(64).fill(0);
      for (let g = 0; g < 16; g++) for (let j = 0; j < 4; j++) d[rows ? 4 * g + j : 16 * j + g] = v(g, j);
      return d;
    },
    expect: () => new Map(range(16).map((g) => [64 + g, v(g, 0) + v(g, 1) + v(g, 2) + v(g, 3)])),
  };
}

/**
 * The sum of 64 words: each of 16 threads adds four (coalesced), writes its sum into shared memory, then
 * a tree of bar-separated levels halves the partial sums: s[i] += s[i + s]. seq: i = t for t < s
 * (neighbouring lanes, neighbouring banks); int: i = 2 s t (lanes 2 s words apart: bank conflicts).
 */
function reduce(kind: 'seq' | 'int'): WarpProgram {
  const d = range(64).map((i) => (i * 11 + 5) % 97);
  const seq = kind === 'seq';
  return {
    id: `reduce${seq ? 'Seq' : 'Int'}`,
    title: seq ? 'A sum of 64 words: a tree in shared memory, neighbours adding' : 'A sum of 64 words: a tree in shared memory, strided pairs',
    lsu: true, shared: true, threads: 16,
    source: (n) => `# 16 threads: s[tid] = x[tid] + x[tid + 16] + x[tid + 32] + x[tid + 48], then s[i] += s[i + s], ${seq ? 'i = tid < s, s = 8, 4, 2, 1' : 'i = 2 s tid < 16, s = 1, 2, 4, 8'}
${start(n)}
        li    s0, 0x1000        # shared memory
        csrr  s1, nwarps
        slli  t4, t0, 2
        lw    a0, 0(t4)
        lw    a1, 64(t4)
        lw    a2, 128(t4)
        lw    a3, 192(t4)
        add   a0, a0, a1
        add   a2, a2, a3
        add   a0, a0, a2
        add   t5, s0, t4        # &s[tid]
        sw    a0, 0(t5)
        li    t3, ${seq ? 8 : 1}             # s
        li    t4, ${seq ? 0 : 1}             # i = tid << t4${seq ? '' : ' = 2 s tid'}
        li    a7, 16
level:  bar   x0, s1            # the level below is written
        sll   a5, t0, t4        # i
        add   a6, a5, t3        # j = i + s
        sltu  t6, a5, ${seq ? 't3        # i < s' : 'a7        # i < 16'}
        split t6
        beqz  t6, skip
        slli  a5, a5, 2
        add   a5, s0, a5        # &s[i]
        slli  a6, a6, 2
        add   a6, s0, a6        # &s[j]
        lw    a0, 0(a5)
        lw    a1, 0(a6)
        add   a0, a0, a1
        sw    a0, 0(a5)         # s[i] += s[j]
skip:   join
${seq ? `        srli  t3, t3, 1
        bnez  t3, level` : `        slli  t3, t3, 1
        addi  t4, t4, 1
        blt   t3, a7, level`}
        bar   x0, s1
        seqz  t6, t0            # thread 0 stores the total
        split t6
        beqz  t6, done
        lw    a0, 0(s0)
        sw    a0, 256(x0)
done:   join
end:    j     end`,
    data: () => d,
    expect: () => new Map([[64, d.reduce((a, b) => a + b, 0)]]),
  };
}
