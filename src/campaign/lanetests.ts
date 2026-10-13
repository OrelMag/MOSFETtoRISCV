// The programs the lane core levels run: directed ones (every lane its own data, memory per lane,
// tmc, branches the leader decides, and for the SIMT core split / join), then random scalar
// programs made lane-dependent by mixing tid into their registers. Each is checked on the lane golden
// model with strict register initialisation (tests/campaign-lanes.test.ts). No DOM.

import { randomProgram } from '../riscv/rv16/randprog';
import type { CoreTest } from './corecheck';

const TID_ALU = `# every lane computes with its own thread number
        csrr t0, tid
        addi a0, t0, 1
        slli a1, t0, 3
        add  a2, a0, a1
        sub  ra, a2, t0
        xor  sp, a2, a1
        or   t1, a0, a1
        and  a0, t1, a2
        slt  a1, t0, a0
        sltu a2, a1, t0
        sll  ra, a0, t0
        srl  sp, ra, t0
        li   t1, -8
        sra  t1, t1, t0
        sub  a0, x0, t0
        srai a1, a0, 1
        lui  a2, 513
        add  a2, a2, t0
        halt
`;

const MEMORY = `# each lane loads its own element, doubles it, stores it to its own slot; then all store one word
        csrr t0, tid
        la   a0, src
        add  a0, a0, t0
        lw   a1, 0(a0)
        add  a1, a1, a1
        sw   a1, 8(a0)        # dst[tid]
        lw   a2, 8(a0)
        sw   t0, 20(zero)     # four stores to one word: lane 3's lands last
        lw   ra, 20(zero)
        sw   a2, -3(zero)     # OUT, lane by lane
        halt
        .data
src:    .word 5, -7, 0x4000, 0x1234
`;

const LOOP = `# a loop every lane runs the same number of times: a uniform branch
        csrr t0, tid
        la   a0, n
        lw   a1, 0(a0)        # n = 6
        li   a2, 0
loop:   add  a2, a2, t0
        addi a2, a2, 1
        addi a1, a1, -1
        bnez a1, loop
        sw   a2, 1(a0)
        halt
        .data
n:      .word 6
`;

const CALLS = `# call and return: every lane writes ra, the leader's ra decides where ret goes
        li   sp, 0x100
        csrr a0, tid
        call twice
        call twice
        mv   t1, a0
        jal  ra, skip
        li   t1, 99           # skipped
skip:   addi t1, t1, 1
        halt
twice:  add  a0, a0, a0
        addi a0, a0, 3
        ret
`;

const TMC = `# turn lanes off and on: the mask is the leader's register
        csrr t0, tid
        li   a0, 10
        li   t1, 3            # lanes 0 and 1
        tmc  t1
        add  a0, a0, t0       # only lanes 0, 1 write
        sw   a0, 30(t0)
        li   t1, 12           # lanes 2 and 3 (lane 0 leads and is turned off too)
        tmc  t1
        li   t1, 15           # now lane 2 leads: back to all four
        tmc  t1
        addi a0, a0, 30
        sw   a0, 26(t0)
        li   a1, 5            # lanes 0 and 2
        tmc  a1
        addi a2, t0, 7
        tmc  x0               # the end: no lane left
        addi a2, a2, 1        # never runs
        halt
`;

const LEADER = `# a branch the lanes disagree on follows the leader (lane 0, then lane 1)
        csrr t0, tid
        li   a0, 1
        bnez t0, l1           # the leader (tid 0) falls through: everyone does
        li   a0, 2
l1:     li   t1, 14           # lanes 1–3
        tmc  t1
        li   a1, 1
        beq  t0, a1, l2       # the leader (tid 1) branches: everyone does
        li   a0, 3
l2:     addi a0, a0, 10
        li   t1, 15
        tmc  t1
        blt  t0, a0, l3       # agreed: every tid < 12
        li   a0, 4
l3:     sw   a0, 4(t0)
        halt
`;

const SPLIT_IF = `# if / else on bit 0 of tid: odd lanes triple, even lanes halve
        csrr t0, tid
        slli t1, t0, 15
        split t1
        beqz t1, even
        slli a0, t0, 1
        add  a0, a0, t0
        j    done
even:   srli a0, t0, 1
done:   join
        sw   a0, 16(t0)
        addi a0, a0, 1
        halt
`;

const SPLIT_NEST = `# nested ifs: two entries on the stack
        csrr t0, tid
        li   a0, 0
        srli t1, t0, 1        # bit 1
        split t1
        beqz t1, lo
        addi a0, a0, 10
        slli a1, t0, 15       # bit 0
        split a1
        beqz a1, j1
        addi a0, a0, 1
j1:     join
        addi a0, a0, 30
lo:     join
        sw   a0, 8(t0)
        halt
`;

const SPLIT_UNIFORM = `# splits the lanes agree on park nobody; a split with no then-lane runs the else side
        csrr t0, tid
        li   t1, 1
        split t1              # every lane: then
        addi a0, t0, 5
        join
        split x0              # no lane: the mask stays, the branch goes to else
        beqz x0, e
        li   a0, 99
e:      addi a0, a0, 1
        join
        li   a1, 2
        sub  a1, a1, t0       # 2, 1, 0, -1
        split a1              # lanes 0, 1, 3 then; lane 2 else
        beqz a1, e2
        addi a0, a0, 20
        j    d2
e2:     addi a0, a0, 25
d2:     join
        sw   a0, 12(t0)
        halt
`;

const SPLIT_LOOP = `# an if inside a uniform loop: the stack empties every iteration
        csrr t0, tid
        li   a2, 0
        li   a1, 4
loop:   sub  t1, a1, t0       # lanes with tid < count take the then side
        slt  t1, x0, t1
        split t1
        beqz t1, skip
        add  a2, a2, a1
skip:   join
        addi a1, a1, -1
        bnez a1, loop
        sw   a2, 24(t0)
        halt
`;

const SPLIT_TMC = `# tmc inside a split: the join restores the mask saved at the split
        csrr t0, tid
        li   a1, 0            # lane 1 is turned off before it writes a1
        slli t1, t0, 15
        split t1              # odd lanes first
        beqz t1, ev
        li   a0, 2            # lane 1 leads: keep lane 3 only
        slli a0, a0, 2
        tmc  a0
        addi a1, t0, 20
        j    jn
ev:     addi a1, t0, 30
jn:     join
        addi a1, a1, 1
        sw   a1, 2(t0)
        halt
`;

/** Random scalar programs with tid mixed into their registers: the lanes compute different values. */
function laneRandom(count: number, from: number): CoreTest[] {
  return Array.from({ length: count }, (_, i) => {
    const lines = randomProgram(from + i, 3, 30 + 5 * (i % 4)).split('\n');
    // the seven li's come first: then every register gets the lane's number mixed in
    lines.splice(7, 0, '        csrr t1, tid', '        add  a0, a0, t1', '        slli t1, t1, 5', '        xor  a1, a1, t1', '        sub  t0, t0, t1', '        or   sp, sp, t1');
    return { name: `random lanes.${from + i}`, src: lines.join('\n') };
  });
}

/** The SIMD core's programs (no split / join). */
export function simdTests(): CoreTest[] {
  return [
    { name: 'tid and the ALU', src: TID_ALU }, { name: 'memory per lane', src: MEMORY }, { name: 'uniform loop', src: LOOP },
    { name: 'calls', src: CALLS }, { name: 'tmc', src: TMC }, { name: 'the leader decides', src: LEADER },
    ...laneRandom(14, 1),
  ];
}

/** The SIMT core's: the SIMD programs and the split / join ones. */
export function simtTests(): CoreTest[] {
  return [
    ...simdTests(),
    { name: 'split: if / else', src: SPLIT_IF }, { name: 'split: nested', src: SPLIT_NEST }, { name: 'split: the lanes agree', src: SPLIT_UNIFORM },
    { name: 'split in a loop', src: SPLIT_LOOP }, { name: 'tmc in a split', src: SPLIT_TMC },
  ];
}
