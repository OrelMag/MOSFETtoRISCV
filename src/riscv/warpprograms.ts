// Programs for the warp cores (chapter 28): warp 0 starts the others with wspawn, then every thread
// (tid = warp · lanes + lane) takes every T-th element, T = nwarps · nlanes. Their input is in data
// memory from the start (`data`); `expect` gives result words computed here, independently of the
// models and the hardware.

export interface WarpProgram {
  id: string;
  title: string;
  /** Assembly for n lanes per warp (T = nwarps << log2 n: the lanes have no multiplier). */
  source: (n: number) => string;
  /** Data memory words at power-on (128 words: data memory of 2^7). */
  data: () => number[];
  /** Expected data-memory words after the run (word index → value). */
  expect: () => Map<number, number>;
}

export const WARP_DMEM_K = 7;

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
];
