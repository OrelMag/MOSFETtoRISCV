// Chapter 'threads' (DOM-free): the programs that run on the threads kernel (osprograms.ts kernelSource({ threads: true })).
// Every program is process A's code; it starts thread B in its own address space with spawn. Both threads share data page 1 (VA 0x1000):
// the variables they share live there, and each thread's stack is its own piece of data page 0 (A's at the top, B's from SP_B down).
// tests/content-threads.test.ts pins what each prints at every slice the chapter quotes; tests/threads-kernel.test.ts runs them on the gates.

import { SYS, THREAD_SYS as T, VA } from './osprograms';

/** The shared variables: the count, the ring buffer of the producer / consumer, its two indices. */
export const SHARED = VA.data1;
/** Thread B's stack pointer (A's sp is whatever its program sets; these programs keep A's near the top of page 0). */
export const SP_A = 0x1000, SP_B = 0x0800;
/** The ring buffer's slots. */
export const RING = 4;

const call = (n: number) => `  li a7, ${n}\n  ecall`;
const sys = (name: keyof typeof T, a0?: number, a1?: number) => `${a0 === undefined ? '' : `  li a0, ${a0}\n`}${a1 === undefined ? '' : `  li a1, ${a1}\n`}${call(T[name])}`;
const spin = (n: number, l: string) => (n > 0 ? `  li t1, ${n}\n${l}:\n  addi t1, t1, -1\n  bnez t1, ${l}` : '');

/** The start of every program: A's stack, then spawn B at `worker`, returning to `texit`. */
const prologue = `  li sp, ${SP_A}
  la a0, worker
  li a1, ${SP_B}
  la a2, texit
${call(T.spawn)}`;
const epilogue = `texit:
${call(SYS.exit)}`;
/** Print the shared word at off with write, then exit. */
const printAndExit = (off = 0) => `  li s0, ${SHARED}
  lw a0, ${off}(s0)
${call(SYS.write)}
${call(SYS.exit)}`;

/**
 * The count: each thread adds 1 to the shared word n times: load, `work` instructions of other work, add, store. With `lock`, the three
 * are a critical section between lock(0) and unlock(0). A joins B, then prints the count.
 */
export function counting(n: number, o: { lock?: boolean; work?: number } = {}): string {
  const work = o.work ?? 8;
  const body = (t: string) => `  li s0, ${SHARED}
  li s1, ${n}
${t}loop:
${o.lock ? sys('lock', 0) + '\n' : ''}  lw t0, 0(s0)
${spin(work, `${t}work`)}
  addi t0, t0, 1
  sw t0, 0(s0)
${o.lock ? sys('unlock', 0) + '\n' : ''}  addi s1, s1, -1
  bnez s1, ${t}loop`;
  return `${prologue}
${body('a_')}
${call(T.join)}
${printAndExit()}
worker:
${body('b_')}
${epilogue}
`;
}

/**
 * Waiting for the other thread's lock. B takes lock 0 at once and holds it for `hold` instructions; A, once B has it, wants it too. `spin`:
 * A asks with trylock in a loop (a spin lock: every try is a system call, and the rest of A's slice goes on asking). `sleep`: A calls lock and
 * is parked until B's unlock hands it over. A then prints how many times it asked.
 */
export function waiting(hold: number, how: 'spin' | 'sleep'): string {
  return `${prologue}
${call(SYS.yield)}
  li s2, 0
${how === 'spin' ? `a_try:
  addi s2, s2, 1
${sys('trylock', 0)}
  beqz a0, a_try` : `  addi s2, s2, 1
${sys('lock', 0)}`}
  mv a0, s2
${call(SYS.write)}
${sys('unlock', 0)}
${call(T.join)}
${call(SYS.exit)}
worker:
${sys('lock', 0)}
${spin(Math.max(1, Math.round(hold / 2)), 'b_hold')}
${sys('unlock', 0)}
${epilogue}
`;
}

/**
 * The producer and the consumer: B puts 1, 2, .., n into a ring of RING words; A takes them out and adds them up, then prints the sum.
 * Shared: the ring at SHARED + 16, `put` at SHARED + 4 and `got` at SHARED + 8 (counts of words put and taken). Both wait on a condition
 * under lock 0: condition 0 "not full", condition 1 "not empty", re-tested in a while loop when they wake.
 */
export function prodCons(n: number, work = 20): string {
  return `${prologue}
  li s0, ${SHARED}
  li s1, ${n}
  li s3, 0
a_next:
${sys('lock', 0)}
a_test:
  lw t0, 4(s0)
  lw t1, 8(s0)
  bne t0, t1, a_take
  li a0, 1
  li a1, 0
${call(T.wait)}
  j a_test
a_take:
  andi t2, t1, ${RING - 1}
  slli t2, t2, 2
  add t2, t2, s0
  lw t3, 16(t2)
  add s3, s3, t3
  addi t1, t1, 1
  sw t1, 8(s0)
${sys('signal', 0)}
${sys('unlock', 0)}
${spin(work, 'a_work')}
  addi s1, s1, -1
  bnez s1, a_next
  mv a0, s3
${call(SYS.write)}
${call(T.join)}
${call(SYS.exit)}
worker:
  li s0, ${SHARED}
  li s1, 1
b_next:
${spin(work, 'b_work')}
${sys('lock', 0)}
b_test:
  lw t0, 4(s0)
  lw t1, 8(s0)
  sub t2, t0, t1
  li t3, ${RING}
  bltu t2, t3, b_put
  li a0, 0
  li a1, 0
${call(T.wait)}
  j b_test
b_put:
  andi t2, t0, ${RING - 1}
  slli t2, t2, 2
  add t2, t2, s0
  sw s1, 16(t2)
  addi t0, t0, 1
  sw t0, 4(s0)
${sys('signal', 1)}
${sys('unlock', 0)}
  addi s1, s1, 1
  li t0, ${n + 1}
  bne s1, t0, b_next
${epilogue}
`;
}

/**
 * The same ring with two semaphores and no lock: semaphore 0 counts the free slots (RING at the start), semaphore 1 the full ones (0).
 * One producer and one consumer touch different indices, so no lock is needed.
 */
export function semRing(n: number, work = 20): string {
  return `  li sp, ${SP_A}
${sys('seminit', 0, RING)}
${sys('seminit', 1, 0)}
  la a0, worker
  li a1, ${SP_B}
  la a2, texit
${call(T.spawn)}
  li s0, ${SHARED}
  li s1, ${n}
  li s3, 0
  li s4, 0
a_next:
${sys('down', 1)}
  andi t2, s4, ${RING - 1}
  slli t2, t2, 2
  add t2, t2, s0
  lw t3, 16(t2)
  add s3, s3, t3
  addi s4, s4, 1
${sys('up', 0)}
${spin(work, 'a_work')}
  addi s1, s1, -1
  bnez s1, a_next
  mv a0, s3
${call(SYS.write)}
${call(T.join)}
${call(SYS.exit)}
worker:
  li s0, ${SHARED}
  li s1, 1
  li s4, 0
b_next:
${spin(work, 'b_work')}
${sys('down', 0)}
  andi t2, s4, ${RING - 1}
  slli t2, t2, 2
  add t2, t2, s0
  sw s1, 16(t2)
  addi s4, s4, 1
${sys('up', 1)}
  addi s1, s1, 1
  li t0, ${n + 1}
  bne s1, t0, b_next
${epilogue}
`;
}

/** The line of B the deadlock challenge is about: the first lock B takes. */
export const B_FIRST = 'b_first';
/**
 * Two locks, two threads, `rounds` times each: A takes lock 0 then lock 1, B takes them in the order `bOrder`. Each holds the first for
 * `gap` instructions before asking for the second. A prints the number of rounds it finished; the kernel says "deadlock" when both wait.
 */
export function twoLocks(rounds: number, bOrder: [number, number] = [1, 0], gap = 30): string {
  const body = (t: string, first: number, second: number) => `  li s1, ${rounds}
${t}round:
${t === 'b_' ? `${B_FIRST}:\n` : ''}${sys('lock', first)}
${spin(gap, `${t}gap`)}
${sys('lock', second)}
${sys('unlock', second)}
${sys('unlock', first)}
  addi s1, s1, -1
  bnez s1, ${t}round`;
  return `${prologue}
${body('a_', 0, 1)}
  li a0, ${rounds}
${call(SYS.write)}
${call(T.join)}
${call(SYS.exit)}
worker:
${body('b_', bOrder[0], bOrder[1])}
${epilogue}
`;
}

/** Two threads, each printing its own count: how a thread switch differs from a process switch (the same work in two processes). */
export function twoThreads(n: number, work = 60): string {
  const body = (t: string, step: number) => `  li s1, ${n}
  li s2, 0
${t}loop:
  addi s2, s2, ${step}
  mv a0, s2
${call(SYS.write)}
${spin(work, `${t}work`)}
  addi s1, s1, -1
  bnez s1, ${t}loop`;
  return `${prologue}
${body('a_', 1)}
${call(T.join)}
${call(SYS.exit)}
worker:
${body('b_', 10)}
${epilogue}
`;
}
