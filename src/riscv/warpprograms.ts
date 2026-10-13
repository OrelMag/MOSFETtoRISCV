// Programs for the warp cores (chapter 28): warp 0 starts the others with wspawn, then every thread
// (tid = warp · lanes + lane) takes every T-th element, T = nwarps · nlanes. Each writes its results
// to memory, where `expect` checks them (computed here, independently of the models and the hardware).

export interface WarpProgram {
  id: string;
  title: string;
  source: string;
  /** Expected data-memory words (word index → value), whatever the warps and lanes. */
  expect: () => Map<number, number>;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

/** The prologue every kernel shares: start the other warps, then T = nwarps · nlanes in t2 (no multiplier in the lanes). */
const START = `        csrr  t0, nwarps
        la    t1, start
        wspawn t0, t1           # warps 1 … nwarps − 1 begin at start
start:  csrr  t0, tid
        csrr  t1, nlanes
        csrr  t3, nwarps
        li    t2, 0
tsum:   add   t2, t2, t1        # T = nwarps · nlanes threads
        addi  t3, t3, -1
        bnez  t3, tsum`;

export const WARP_PROGRAMS: WarpProgram[] = [
  {
    id: 'saxpy32',
    title: 'y = 3·x + y on 32 elements',
    source: `# Every thread takes elements i = tid, tid + T, … (T threads in all)
${START}
        li    t6, 32
        mv    t3, t0
init:   slli  t4, t3, 2         # x[i] = i + 1, y[i] = 100 − i
        addi  t5, t3, 1
        sw    t5, 0(t4)
        li    a1, 100
        sub   a1, a1, t3
        sw    a1, 128(t4)
        add   t3, t3, t2
        blt   t3, t6, init
        mv    t3, t0
loop:   slli  t4, t3, 2         # y[i] = 3·x[i] + y[i]
        lw    t5, 0(t4)
        lw    a1, 128(t4)
        slli  a0, t5, 1
        add   a0, a0, t5
        add   a0, a0, a1
        sw    a0, 128(t4)
        add   t3, t3, t2
        blt   t3, t6, loop
end:    j     end`,
    expect: () => new Map(range(32).flatMap((i) => [[i, i + 1], [32 + i, 3 * (i + 1) + 100 - i]])),
  },
];
