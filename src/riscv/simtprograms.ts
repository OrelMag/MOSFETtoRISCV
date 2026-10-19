// Programs for the lane cores (chapters 28–29). Every lane runs the same code; csrr lane / tid /
// nlanes tell them apart. Each program writes its results to memory, where `expect` checks them
// (computed here in TypeScript, independently of both the golden model and the hardware).

export interface SimtProgram {
  id: string;
  title: string;
  source: string;
  /** Expected data-memory words (word index → value) for n lanes. */
  expect: (n: number) => Map<number, number>;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export const SIMT_PROGRAMS: SimtProgram[] = [
  {
    id: 'saxpy',
    title: 'y = 3·x + y on 16 elements',
    source: `# Each lane takes every n-th element: i = tid, tid + n, …
        csrr  t0, tid
        csrr  t1, nlanes
        li    t2, 16
        mv    t3, t0
init:   slli  t4, t3, 2         # x[i] = i + 1, y[i] = 100 − i
        addi  t5, t3, 1
        sw    t5, 0(t4)
        li    t6, 100
        sub   t6, t6, t3
        sw    t6, 64(t4)
        add   t3, t3, t1
        blt   t3, t2, init
        mv    t3, t0
loop:   slli  t4, t3, 2         # y[i] = 3·x[i] + y[i]
        lw    t5, 0(t4)
        lw    t6, 64(t4)
        slli  a0, t5, 1
        add   a0, a0, t5
        add   a0, a0, t6
        sw    a0, 64(t4)
        add   t3, t3, t1
        blt   t3, t2, loop
end:    j     end`,
    expect: () => new Map(range(16).flatMap((i) => [[i, i + 1], [16 + i, 3 * (i + 1) + 100 - i]])),
  },
  {
    id: 'diverge',
    title: 'Odd lanes triple, even lanes halve',
    source: `        csrr  t0, lane
        andi  t1, t0, 1
        split t1                # odd lanes first; the even ones wait
        beqz  t1, even          # uniform: every active lane agrees
        slli  t2, t0, 1
        add   t2, t2, t0        # odd: 3·lane
        j     done
even:   srli  t2, t0, 1         # even: lane / 2
done:   join                    # 1st: the even lanes run from after split; 2nd: all
        slli  t3, t0, 2
        sw    t2, 0(t3)
end:    j     end`,
    expect: (n) => new Map(range(n).map((i) => [i, i & 1 ? 3 * i : i >> 1])),
  },
  {
    id: 'nested',
    title: 'An if inside an if',
    source: `        csrr  t0, lane
        andi  t1, t0, 1
        andi  t2, t0, 2
        split t1
        beqz  t1, e1
        li    a0, 10            # odd lanes
        split t2
        beqz  t2, e2
        addi  a0, a0, 1         # lane & 2
        j     j2
e2:     addi  a0, a0, 2
j2:     join
        j     j1
e1:     li    a0, 20            # even lanes
j1:     join
        slli  t3, t0, 2
        sw    a0, 0(t3)
end:    j     end`,
    expect: (n) => new Map(range(n).map((i) => [i, !(i & 1) ? 20 : i & 2 ? 11 : 12])),
  },
  {
    id: 'pred',
    title: 'Loops of different lengths (pred)',
    source: `# lane l adds l + 1, l, …, 1; lanes that finish stop (pred), the rest go on
        csrr  s0, tmask         # every lane, to come back to
        csrr  t0, lane
        addi  t1, t0, 1
        li    a0, 0
loop:   add   a0, a0, t1
        addi  t1, t1, -1
        pred  t1, s0            # lanes with t1 = 0 stop; when none is left: mask = s0
        bnez  t1, loop
        slli  t3, t0, 2
        sw    a0, 0(t3)
end:    j     end`,
    expect: (n) => new Map(range(n).map((i) => [i, ((i + 1) * (i + 2)) / 2])),
  },
  {
    id: 'tmc',
    title: 'One lane sums what all of them wrote (tmc)',
    source: `        csrr  t0, lane
        csrr  t2, nlanes
        slli  t3, t0, 2
        addi  t1, t0, 5
        sw    t1, 0(t3)         # v[lane] = lane + 5
        li    t4, 1
        tmc   t4                # only lane 0 from here
        slli  t6, t2, 2
        li    a0, 0
        li    t5, 0
sum:    lw    t1, 0(t5)
        add   a0, a0, t1
        addi  t5, t5, 4
        blt   t5, t6, sum
        sw    a0, 64(zero)
        li    t4, -1
        tmc   t4                # every lane again
end:    j     end`,
    expect: (n) => new Map([...range(n).map((i): [number, number] => [i, i + 5]), [16, range(n).reduce((s, i) => s + i + 5, 0)]]),
  },
  {
    id: 'nosplit',
    title: 'Forgetting split: the leader decides',
    source: `# The same if as "diverge", without split / join: the lanes disagree at beqz,
# the warp follows its leader (lane 0, even), and the odd lanes compute the wrong value.
        csrr  t0, lane
        andi  t1, t0, 1
        beqz  t1, even
        slli  t2, t0, 1
        add   t2, t2, t0
        j     done
even:   srli  t2, t0, 1
done:   slli  t3, t0, 2
        sw    t2, 0(t3)
end:    j     end`,
    expect: (n) => new Map(range(n).map((i) => [i, i >> 1])),
  },
];

/**
 * saxpy for the multi-core (chapter 26's cores, MultiISS): the same work split the same way, each core
 * finding its index with csrr mhartid instead of tid. For the lanes-against-cores comparison.
 */
export const SAXPY_CORES = SIMT_PROGRAMS[0].source
  .replace('csrr  t0, tid', 'csrr  t0, mhartid')
  .replace('csrr  t1, nlanes', 'li    t1, 4');
