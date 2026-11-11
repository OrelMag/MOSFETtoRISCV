import { compilePy } from '../lang/compile';
import { THREAD_STACK } from '../lang/codegen';
import { counter, osImage, PY_DMEM_WORDS, THREAD_SYS, LOCKS, NREGS } from '../riscv/osprograms';
import { runOs, tripsOf, type OsRun } from '../riscv/osrun';
import { WALK_CYCLES } from '../riscv/vmprograms';
import { counting, prodCons, RING, semRing, SHARED, SP_B, twoThreads, waiting } from '../riscv/threadprograms';
import { groupDigits } from '../sim/numfmt';
import { osScene } from '../widgets/os';
import { deadlockFixed, deadlockWidget, deadRows, fixDeadlock, HOLD, lockedRows, printed, RACE_N, raceRows, raceWidget, ROUNDS, runThreads, sliceTax, THREAD_SLICES, waitRows, waitWidget } from '../widgets/threads';
import type { Scene } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

const n = groupDigits;
/** The slice of the chapter's scenes and of the single runs it quotes. */
export const SCENE_SLICE = 200;
/** The producer's and the consumer's work per word: the consumer is the slower, so the ring fills. */
export const PUT_WORK = 4, TAKE_WORK = 120, RING_N = 20;
/** Increments per thread in the Python step. */
export const PY_N = 200;

/** The Python step's program: two threads add to one global, with or without lock 0 around the update. */
export const pyRace = (locked: boolean): string => `count = 0

def worker():
    global count
    for i in range(${PY_N}):
${locked ? '        lock(0)\n' : ''}        count = count + 1
${locked ? '        unlock(0)\n' : ''}
spawn(worker)
for i in range(${PY_N}):
${locked ? '    lock(0)\n' : ''}    count = count + 1
${locked ? '    unlock(0)\n' : ''}join()
print(count)
`;
export const pyThreads = (locked: boolean): string => {
  const c = compilePy(pyRace(locked), { dmemWords: PY_DMEM_WORDS, user: true });
  if (c.error) throw new Error(`threads chapter: ${c.error.message}`);
  return c.asm;
};

/** The numbers the prose quotes, all measured on the golden model running the threads kernel (tests/content-threads.test.ts pins them). */
export interface ThreadFigures {
  /** Instructions of a slice the kernel spends after re-arming the timer: a slice this short reaches no user code. */
  tax: number;
  /** spawn's trip, an uncontended lock and unlock (cycles, the least seen), join. */
  spawn: number; lock: number; unlock: number;
  /** A switch between two threads and one between two processes (timer, kernel cycles), and the walks each pays after it. */
  threadSwitch: number; procSwitch: number; threadWalks: number; procWalks: number;
  /** The race: counts per THREAD_SLICES, the lowest and highest. */
  race: number[]; raceLow: number; raceHigh: number;
  /** Cycles of the count with and without the lock, at the longest slice, and the lock's cost per increment. */
  plainCycles: number; lockedCycles: number; perIncrement: number;
  /** Spinning against sleeping: tries and cycles per slice, and the share spinning wastes at the scene's slice. */
  spinTries: number[]; spinWaste: number; spinWasteAt: number;
  /** The ring: the sum, cycles with conditions and with semaphores at the scene's slice, waits the producer made. */
  ringSum: number; condCycles: number; semCycles: number; condWaits: number;
  /** The deadlock: rounds; how many slices deadlock as written and with the fix. */
  deadAll: number; fixedAll: number;
  /** Python: counts without a lock per slice, cycles with and without the lock at the scene's slice. */
  py: { race: number[]; plain: number; locked: number; sp: number };
}

const least = (r: OsRun, call: number) => Math.min(...tripsOf(r, call).map((t) => t.kernelCycles));

let figs: ThreadFigures | undefined;
export function threadFigures(): ThreadFigures {
  if (figs) return figs;
  const lockRun = runThreads(counting(20, { lock: true }), 600);
  const th = runThreads(twoThreads(6), SCENE_SLICE), pr = runOs(osImage([counter(1, 6, 60), counter(10, 6, 60)], { slice: SCENE_SLICE }));
  const timerSwitches = (r: OsRun) => r.trips.filter((t) => t.from !== t.to && t.cause !== 8);
  const tsw = timerSwitches(th), psw = timerSwitches(pr);
  const race = raceRows().map((r) => r.count), locked = lockedRows(), plain = raceRows();
  const last = THREAD_SLICES.length - 1;
  const waits = waitRows(), atScene = waits.find((w) => w.slice === SCENE_SLICE)!;
  const cond = runThreads(prodCons(RING_N, PUT_WORK, TAKE_WORK), SCENE_SLICE), sem = runThreads(semRing(RING_N, PUT_WORK, TAKE_WORK), SCENE_SLICE);
  const pyRun = (locked: boolean, s: number) => runOs(osImage([pyThreads(locked)], { threads: true, slice: s }), 400000);
  figs = {
    tax: sliceTax(),
    spawn: least(lockRun, THREAD_SYS.spawn), lock: least(lockRun, THREAD_SYS.lock), unlock: least(lockRun, THREAD_SYS.unlock),
    threadSwitch: Math.min(...tsw.map((t) => t.kernelCycles)), procSwitch: Math.min(...psw.map((t) => t.kernelCycles)),
    threadWalks: Math.max(...tsw.map((t) => t.userWalks)), procWalks: Math.max(...psw.map((t) => t.userWalks)),
    race, raceLow: Math.min(...race), raceHigh: Math.max(...race),
    plainCycles: plain[last].cycles, lockedCycles: locked[last].cycles, perIncrement: Math.round((locked[last].cycles - plain[last].cycles) / (2 * RACE_N)),
    spinTries: waits.map((w) => w.spinTries), spinWaste: Math.round((100 * (atScene.spinCycles - atScene.sleepCycles)) / atScene.spinCycles), spinWasteAt: SCENE_SLICE,
    ringSum: printed(cond)!, condCycles: cond.cycles, semCycles: sem.cycles, condWaits: tripsOf(cond, THREAD_SYS.wait).filter((t) => t.from === 1).length,
    deadAll: deadRows([1, 0]).filter((r) => !r.done).length, fixedAll: deadRows([0, 1]).filter((r) => r.done).length,
    py: { race: THREAD_SLICES.map((s) => printed(pyRun(false, s))!), plain: pyRun(false, SCENE_SLICE).cycles, locked: pyRun(true, SCENE_SLICE).cycles, sp: PY_DMEM_WORDS * 4 - THREAD_STACK },
  };
  return figs;
}
const F = threadFigures();
const slices = THREAD_SLICES.map((s) => n(s)).join(', ');

const scenes = {
  two: (): Scene => osScene({ procs: [twoThreads(6)], threads: true, slice: SCENE_SLICE, highlight: ['csr', 'mmu'], keep: 'open' }),
  locked: (): Scene => osScene({ procs: [counting(20, { lock: true })], threads: true, slice: SCENE_SLICE, highlight: ['csr'], keep: 'open' }),
  sleep: (): Scene => osScene({ procs: [waiting(HOLD, 'sleep')], threads: true, slice: SCENE_SLICE, highlight: ['csr'], keep: 'open' }),
  cond: (): Scene => osScene({ procs: [prodCons(RING_N, PUT_WORK, TAKE_WORK)], threads: true, slice: SCENE_SLICE, highlight: ['csr'], keep: 'open' }),
  sem: (): Scene => osScene({ procs: [semRing(RING_N, PUT_WORK, TAKE_WORK)], threads: true, slice: SCENE_SLICE, highlight: ['csr'], keep: 'open' }),
  python: (): Scene => osScene({ procs: [pyThreads(true)], threads: true, slice: SCENE_SLICE, highlight: ['csr', 'mmu'], keep: 'open' }),
};

export const chThreads: Chapter = {
  id: 'threads', num: numOf('threads'), title: 'Threads on one core', level: 'System',
  blurb: 'Two threads in one address space on the kernel of the last chapter: a race with no second core, locks, sleeping and waking, conditions, semaphores and a deadlock, all measured on the gates.',
  goals: [
    'start a second thread in a process\'s address space and say what a thread switch saves',
    'find a race on one core, and close it with a critical section the kernel makes indivisible',
    'choose between spinning and sleeping, and wait for a condition with a lock, a condition variable or semaphores',
    'recognise a deadlock and break it by the order locks are taken in',
  ],
  builds: ['os', 'python'],
  recap: {
    keep: [
      `A thread is a set of registers and a stack running in a process's address space: two threads share every page, so one store is seen by the other at once. Here the second is started with spawn (${F.spawn} cycles: a control block filled from the caller's), and a switch between them keeps satp and the TLBs: ${F.threadWalks} walks after it where a process switch pays ${F.procWalks}.`,
      `A race needs no second core. The timer can take the CPU between a thread's load and its store, and the other thread's updates in between are lost: two threads adding 1 to one word ${RACE_N} times each ended at ${F.raceLow} to ${F.raceHigh}, not ${2 * RACE_N}, over slices of ${slices} instructions.`,
      `A critical section is code only one thread may be in. On one core the kernel makes it so: it runs with interrupts off, so a lock call is indivisible. The price is two system calls per update: about ${F.perIncrement} cycles per increment here.`,
      `A thread that cannot go on should sleep, not spin: the kernel parks it (state waiting) and the scheduler skips it until an unlock, a signal or an up wakes it. Spinning on trylock wasted ${F.spinWaste} % of the cycles at a ${F.spinWasteAt}-instruction slice.`,
      `A condition variable lets a thread wait for a state of shared data: wait(c, l) lets the lock go and sleeps in one step, and the woken thread holds the lock again and tests the condition again (while, not if). Semaphores count instead: the ring of ${RING} words needs one for its free slots and one for its full ones.`,
      `A deadlock is a cycle of threads each waiting for a lock the next holds. It needs mutual exclusion, hold and wait, no preemption and the cycle; taking locks in one global order breaks the cycle: as written it deadlocked at ${F.deadAll} of ${THREAD_SLICES.length} slices, with the order fixed it finished at ${F.fixedAll} of ${THREAD_SLICES.length}.`,
    ],
    practise: ['p_critical', 'p_switch'],
    check: [
      {
        question: 'Two threads on one core each run count = count + 1 a hundred times. How can an update be lost when only one thread runs at a time?',
        options: ['The timer can switch threads between the load and the store, so the other\'s updates in between are written over', 'The two threads use different copies of count', 'The cache holds a stale copy for each thread', 'It cannot: on one core every update arrives'],
        answer: 0,
        explain: 'The update is three instructions: load, add, store. A switch after the load lets the other thread run with the same old value; when the first thread stores, it writes over every increment made in the meantime.',
        why: ['', 'Threads share the address space: count is one word in one frame.', 'This core has no cache in the way, and a cache would not change the order of the two threads\' loads and stores.', 'One runs at a time, but they take turns inside the update: that is enough.'],
      },
      {
        question: 'Why should a thread that must wait for a lock call lock() rather than loop on trylock()?',
        options: ['lock() parks it until the unlock, so the slice goes to the thread that holds the lock; trylock in a loop spends the slice asking', 'trylock() is slower than lock() per call', 'lock() takes the lock even if the other thread holds it', 'trylock() can let two threads hold the lock'],
        answer: 0,
        explain: 'On one core the holder cannot make progress while the waiter runs. A loop on trylock burns the rest of every slice it gets; a sleeping thread is skipped by the scheduler until the unlock hands it the lock.',
        why: ['', 'Per call they cost about the same; the difference is how many calls, and the slices they eat.', 'A lock is never held by two threads: lock() waits for it.', 'Both are system calls the kernel runs with interrupts off: neither can hand the lock out twice.'],
      },
      {
        question: 'Thread A takes lock 0, then lock 1. Thread B takes lock 1, then lock 0. Which change removes the deadlock?',
        options: ['B takes lock 0 first, then lock 1, as A does', 'B releases its locks in the other order', 'A gets a longer time slice', 'Both use trylock for the first lock'],
        answer: 0,
        explain: 'A deadlock needs a cycle of waiting. If every thread takes the locks in one global order, the thread holding the higher one never waits for the lower one, and no cycle can form.',
        why: ['', 'The order of the unlocks does not matter: the deadlock happens while both are still taking locks.', 'A longer slice makes the deadlock rarer, not impossible: a switch can still fall between the two lock calls.', 'trylock for the first lock changes nothing: it is the second lock each waits for.'],
      },
    ],
  },
  steps: [
    {
      title: 'Two threads, one address space',
      body: `
        <p>The processes of chapter ${numOf('os')} share nothing but the CPU: each has its own page table, so a store by one is invisible to the other. That is what protection means, and it is what a program that wants to do two things at once does not want. A text editor that saves a file while the learner keeps typing, a server that serves one request while it waits for another's disk:
        both want two flows of control over one set of data. That is a <strong>thread</strong>: a set of registers, a PC and a stack, running in an address space it shares with the process's other threads.</p>
        <p>The kernel of this chapter is the last chapter's with ${THREAD_SYS.seminit - THREAD_SYS.spawn + 1} more system calls. It starts only process A. A's program asks for a second thread with <code>spawn</code> (${THREAD_SYS.spawn} in a7): a0 the address of the code it should run, a1 its stack pointer, a2 where it should return to when its code ends. The kernel fills the second control block from A's own: the same ${NREGS} registers, the same <code>satp</code>, then the new PC, stack and
        return address. That costs <strong>${F.spawn} cycles</strong>, mostly the copy. From then on the scheduler has two ready blocks, as before, and the timer takes turns between them, as before. The difference is in the switch: the kernel compares the next block's <code>satp</code> with the one in the CSR and, when they are equal, skips the write and the TLB flush.</p>
        <p>The scene runs thread A counting 1, 2, 3 … and thread B counting 10, 20, 30 …, the two counters of chapter ${numOf('os')} as two threads. The switch is the same ${F.threadSwitch} kernel cycles (against ${F.procSwitch} for two processes); what it saves comes after: <strong>${F.threadWalks} page walks</strong> on return where a process switch pays ${F.procWalks}, ${WALK_CYCLES} cycles each, because the TLB still holds the right translations. Thread B's stack is at 0x${SP_B.toString(16)} in A's page 0; both see the same word at 0x${SHARED.toString(16)}.</p>
        <div class="try">Run to halt and read the panel: both control blocks hold the same satp, and B's sp is 0x${SP_B.toString(16)}.</div>`,
      scene: scenes.two,
      lit: 'The CSR unit and the MMU',
      challenge: {
        kind: 'quiz',
        question: 'Thread A stores 5 to address 0x1000. Thread B then loads 0x1000. What does it read, and why?',
        options: ['5: both threads use the same page table, so 0x1000 is the same frame', 'Whatever B stored there last: each thread has its own frame', '0: the kernel clears shared pages at every switch', 'It faults: a thread may not read another\'s data'],
        answer: 0,
        explain: 'Both control blocks hold the same satp. The address is translated by the same table to the same frame, so a thread sees every store the other made; nothing is copied or cleared.',
        why: ['', 'That is two processes. Threads were made to share.', 'The kernel touches no user page at a switch; it only saves and loads registers.', 'Protection is between address spaces. Inside one, every thread may use every page.'],
      },
    },
    {
      title: 'A race on one core',
      body: `
        <p>Sharing has a price. Two threads each run, ${RACE_N} times, the three instructions that add 1 to the shared word: <code>lw</code>, <code>addi</code>, <code>sw</code>, with a little other work between the load and the store, as real code has. The right answer is ${2 * RACE_N}. The table runs it at five slices.</p>
        <p>Not one is right: ${F.race.join(', ')}. There is only one core, and only one thread runs at a time, but the timer does not care where a thread is. When it takes the CPU after A's load and before A's store, B runs a whole slice of increments, and when A gets the CPU back it stores its old value plus one over all of them. That is a <strong>race condition</strong>: the result depends on the timing of the switches. A different slice moves the switches, and the result moves with it, with no pattern: the program is not wrong at some slices and right at others, it is wrong.</p>
        <p>The slices start at ${n(THREAD_SLICES[0])} for a reason worth knowing: the kernel re-arms the timer early in a switch, and <code>mtime</code> counts its instructions too, so the last ${F.tax} instructions of every switch are paid from the new slice. A slice of ${F.tax} or less ends before the thread runs a single instruction, and the machine does nothing but switch.</p>`,
      widget: () => raceWidget(),
      challenge: {
        kind: 'quiz',
        question: `The race lost about ${2 * RACE_N - F.raceHigh} or more updates at every slice. Which change would make it lose none?`,
        options: ['Keep the switch out of the load-add-store: no other thread may run between them', 'Use a longer slice', 'Put the load and the store next to each other', 'Run the threads on two cores'],
        answer: 0,
        explain: 'The lost update needs a switch between one thread\'s load and its store. Remove that possibility and the updates cannot interleave. That is the next step.',
        why: ['', `The ${n(THREAD_SLICES[THREAD_SLICES.length - 1])}-instruction slice lost ${2 * RACE_N - F.race[F.race.length - 1]}: fewer switches, still some inside the window.`, 'A smaller window makes a switch inside it rarer, not impossible.', 'Two cores race worse: the other thread runs at the same time, not only when the timer fires.'],
      },
    },
    {
      title: 'A critical section, made indivisible by the kernel',
      body: `
        <p>The three instructions must be a <strong>critical section</strong>: code that one thread at a time may be in. On one core there is a simple way to make anything indivisible: run it with interrupts off. A user thread may not turn them off (it would keep the CPU for ever), but the kernel runs that way: a trap clears <code>MIE</code>, and nothing interrupts the kernel until its <code>mret</code>.</p>
        <p>So the kernel offers a <strong>lock</strong>. Four of them, words at 0x${LOCKS.toString(16)} in its frame, each holding the control block of the thread that owns it, or 0. <code>lock(i)</code> (${THREAD_SYS.lock} in a7) takes a free lock and returns; <code>unlock(i)</code> (${THREAD_SYS.unlock}) gives it back. Between the two, the other thread may be switched in, but if it asks for the lock it cannot get it. The test and the take are one system call, so no switch can fall between them.</p>
        <p>The scene runs the count with <code>lock(0)</code> and <code>unlock(0)</code> around the update, and the panel shows the lock table under the control blocks. The widget adds the lock to every row: <strong>${2 * RACE_N}</strong> at every slice. The price is in the right-hand columns. The count took ${n(F.plainCycles)} cycles without the lock and ${n(F.lockedCycles)} with it, at the longest slice: two system calls per update, ${F.lock} and ${F.unlock} cycles uncontended, <strong>about ${F.perIncrement} cycles per increment</strong> for a section of a few instructions. Keep critical sections few and short.</p>`,
      scene: scenes.locked,
      lit: 'The CSR unit: the trap that keeps interrupts off',
      challenge: {
        kind: 'quiz',
        question: 'What makes the kernel\'s lock call indivisible on this one-core machine?',
        options: ['The kernel runs with interrupts off, so no switch can come between testing the lock and taking it', 'The lock word is in the kernel\'s frame', 'The lock call is one instruction', 'The scheduler never switches during a lock call because it checks the lock first'],
        answer: 0,
        explain: 'A trap clears MIE: from the ecall to the mret the timer cannot interrupt. The test and the store that takes the lock are both inside, so on one core they are one indivisible step.',
        why: ['', 'Where the word lives protects it from user stores, not from a switch between two kernel instructions.', 'The ecall is one instruction; the kernel runs dozens after it, and they are safe because nothing can interrupt them.', 'The scheduler runs only when the kernel is entered; inside a call, the timer waits.'],
      },
    },
    {
      title: 'Spinning wastes the slice',
      body: `
        <p>A lock that is held makes a thread wait. There are two ways to wait. A thread can <strong>spin</strong>: ask again and again until the answer changes. Here that is <code>trylock(i)</code> (${THREAD_SYS.trylock}), which takes the lock if it is free and answers 1, or answers 0 and does not wait, in a loop. Or it can <strong>sleep</strong>: tell the kernel what it is waiting for and let the kernel run it again when that has happened.</p>
        <p>On one core, spinning is the wrong choice, and the widget measures why. Thread B takes lock 0 and works for about ${n(HOLD)} instructions; thread A then wants it. While A spins, B cannot be running, since there is one core: every one of A's tries is wasted, and so is the rest of each slice it spends trying. A asked ${F.spinTries.join(', ')} times at the five slices, and at a ${F.spinWasteAt}-instruction slice <strong>${F.spinWaste} % of the cycles</strong> the spinning run took were wasted: the sleeping run did the same work without them. Sleeping costs one call.</p>
        <p>Spinning is not always wrong. On several cores, the holder runs <em>while</em> the waiter spins, and a short wait is cheaper spun than slept, because sleeping costs two trips through the kernel. That is the subject of chapter ${numOf('multicore')}'s locks.</p>`,
      widget: waitWidget,
      challenge: {
        kind: 'quiz',
        question: 'On this one-core machine, thread A spins on trylock while B holds the lock. When can B release it?',
        options: ['Only after the timer takes the CPU from A and gives it to B', 'At any time: B runs alongside A', 'Never: spinning stops B for ever', 'Only when A calls yield'],
        answer: 0,
        explain: 'One core runs one thread. While A spins, B is not running, so the lock cannot be released until a switch. Every try A makes before that is wasted.',
        why: ['', 'Alongside needs a second core. Here they take turns.', 'The timer still interrupts A, so B does run eventually, and releases the lock.', 'A yield would help, and this spinner does not call one: the timer does the switching.'],
      },
    },
    {
      title: 'Sleep and wake',
      body: `
        <p>Sleeping is a fourth state for a control block. Next to free, ready and gone there is <strong>waiting</strong>, and the block records what for. When <code>lock(i)</code> finds the lock taken, the kernel writes "lock i" in the caller's block, sets its state to waiting and runs the scheduler, which skips blocks that are not ready. The thread does not run, so it wastes nothing.</p>
        <p>Someone has to wake it. <code>unlock(i)</code> looks at the other block: if it waits for lock i, the kernel hands the lock straight to it (the lock's owner becomes the waiter) and makes it ready. The waiter does not have to try again: when it next runs, it returns from its <code>lock</code> call holding the lock. Handing over, rather than freeing and letting the two race for it, means the thread that waited cannot be overtaken by the one that just released.</p>
        <p>The scene is the right-hand column of the last widget: B holds the lock and works, A calls <code>lock(0)</code> once. Run it and watch the panel: A's state reads <em>waiting</em>, for lock 0, through B's slices, until B's unlock makes it ready. A prints 1, the number of times it asked.</p>
        <p>If every block is waiting, no thread can ever wake another. The kernel checks for that when nobody is ready: it prints <code>deadlock</code> and stops. A thread that asks for a lock it already holds waits for itself, and gets the same message.</p>
        <div class="try">Step to A's lock call (Next switch) and read A's block: waiting, for lock 0.</div>`,
      scene: scenes.sleep,
      lit: 'The CSR unit',
      challenge: {
        kind: 'quiz',
        question: 'Thread A is waiting for lock 0, which B holds. B calls unlock(0). What does the kernel do?',
        options: ['Makes A the owner of lock 0 and A ready; B carries on', 'Frees the lock and switches to A at once', 'Frees the lock; A must call lock again', 'Nothing until the timer fires'],
        answer: 0,
        explain: 'The kernel hands the lock to the waiter and marks it ready. B keeps the rest of its slice; when A runs, its lock call returns with the lock held.',
        why: ['', 'Nothing forces a switch: B\'s slice continues. A will run at the next switch, already holding the lock.', 'A waiting thread is not asking again: it is parked inside its call, and the call completes when it is handed the lock.', 'The unlock itself wakes A; the timer only decides when A runs.'],
      },
    },
    {
      title: 'Waiting for a condition',
      body: `
        <p>A lock protects data. Often a thread has to wait for the data to be in some <em>state</em>: a producer with nowhere to put a word, a consumer with nothing to take. The scene has both: thread B produces 1, 2, …, ${RING_N} into a <strong>ring buffer</strong> of ${RING} words, thread A takes them out and adds them up, slower than B makes them, so the ring fills. Two counters under lock 0 say how many words were put and taken; the ring is full when they differ by ${RING} and empty when they are equal.</p>
        <p>Spinning on the counters would waste slices, as before, and holding the lock while waiting would stop the other thread from ever changing them. A <strong>condition variable</strong> does both things at once: <code>wait(c, l)</code> (${THREAD_SYS.wait}) lets lock l go and sleeps on condition c in one system call, so no wake-up can be missed between them; <code>signal(c)</code> (${THREAD_SYS.signal}) wakes the thread waiting on c, which returns from its wait holding the lock again. Here condition 0 is "not full" and 1 is "not empty". A signal with nobody waiting is lost: a condition variable has no memory.</p>
        <p>The waiter tests again when it wakes: <code>while</code> the ring is full, wait. Not <code>if</code>. The thread that signalled carries on running, and by the time the waiter runs, other code may have changed the state again; with more than two threads, another taker may have emptied the slot. A woken thread knows only that the state <em>was</em> right at some moment. A sum of ${F.ringSum} (1 + 2 + … + ${RING_N}) says nothing was lost or taken twice; the producer waited ${F.condWaits} times in ${n(F.condCycles)} cycles.</p>`,
      scene: scenes.cond,
      lit: 'The CSR unit',
      challenge: {
        kind: 'quiz',
        question: 'Why does wait(c, l) release the lock and go to sleep in one system call rather than unlock(l) followed by a separate sleep?',
        options: ['A signal that came between the two calls would be lost, and the thread would sleep for ever', 'One call is faster, and that is all', 'The lock must stay held while the thread sleeps', 'A thread may not sleep while it holds a lock'],
        answer: 0,
        explain: 'If the lock were released first, the other thread could change the state and signal before this one slept; the signal would find nobody waiting and vanish. Inside one kernel call, with interrupts off, nothing can run in between.',
        why: ['', 'It is faster, but the reason is correctness: the gap between the two would lose wake-ups.', 'If the lock stayed held, the thread that should change the state could never take it.', 'It may; that is what wait is for, as long as the release and the sleep are one step.'],
      },
    },
    {
      title: 'Semaphores',
      body: `
        <p>A <strong>semaphore</strong> is a counter with two operations: <code>down</code> (${THREAD_SYS.down}) takes one, and waits while there is none; <code>up</code> (${THREAD_SYS.up}) gives one back, or hands it straight to the thread waiting for it. Dijkstra named them P and V in 1965. A lock is a semaphore that starts at 1; a semaphore that starts at k lets k threads in.</p>
        <p>The ring needs two, and no lock. Semaphore 0 counts the free slots and starts at ${RING}; semaphore 1 counts the full ones and starts at 0. The producer downs a free slot, writes, and ups a full one; the consumer downs a full one, reads, and ups a free one. With one producer and one consumer, each index is touched by one thread only, so the count in the semaphore is the only shared state, and the kernel keeps it.</p>
        <p>The scene runs it with the same work as the last step. It gives the same ${F.ringSum}, in ${n(F.semCycles)} cycles against ${n(F.condCycles)}: one call per word on each side instead of lock, signal and unlock. The panel's bottom row shows the two counts move.</p>`,
      scene: scenes.sem,
      lit: 'The CSR unit',
      challenge: {
        kind: 'quiz',
        question: `The free-slot semaphore starts at ${RING}. What happens when the producer downs it a ${RING + 1}th time before the consumer has taken anything?`,
        options: ['The producer waits until the consumer ups a free slot', 'It goes to -1 and the producer overwrites a word', 'The kernel returns an error', 'It wraps round to the largest count'],
        answer: 0,
        explain: 'A count of 0 means no free slot: down parks the caller. The consumer\'s up hands the slot straight to it.',
        why: ['', 'A semaphore never goes below zero: that is exactly the wait.', 'Waiting is the answer, not an error.', 'Nothing wraps: the count stops at 0 and down waits.'],
      },
    },
    {
      title: 'Deadlock',
      body: `
        <p>Locks fix races and bring a failure of their own. Thread A takes lock 0, does some work, takes lock 1; thread B takes lock 1, then lock 0. If a switch falls between A's two calls, B gets lock 1 and waits for lock 0; A wakes up and waits for lock 1. Each waits for the other, for ever: a <strong>deadlock</strong>. Here the kernel notices that no thread is ready and some still wait, prints <code>deadlock</code> and stops; most systems do not notice, and the program simply hangs.</p>
        <p>A deadlock needs four things at once (Coffman, 1971): <em>mutual exclusion</em> (a lock has one owner), <em>hold and wait</em> (a thread holds one lock while it asks for another), <em>no preemption</em> (nobody takes a lock away) and a <em>cycle</em> of threads each waiting for the next. Remove any one and it cannot happen. The cheapest to remove is the cycle: give the locks an order and take them only in that order. Then whoever holds the higher lock never waits for a lower one, and the chain of waiting cannot close.</p>
        <p>The widget runs ${ROUNDS} rounds of each thread at every slice. As written, it deadlocked at ${F.deadAll} of ${THREAD_SLICES.length}. Change the order in which B takes its locks so that both threads finish at every slice.</p>
        <div class="try">Pick B's lock numbers so that every row of the table finishes.</div>`,
      widget: deadlockWidget,
      challenge: {
        kind: 'reach',
        goal: `Change the order of B's lock calls so that both threads finish at every slice (${slices}).`,
        check: () => deadlockFixed(),
        hints: ['Look at the order: A takes 0 then 1. What order does B use?', 'Make B take its locks in A\'s order: one global order means no cycle.'],
        answer: `B's first call becomes lock(0) and its second lock(1): both take lock 0 first. Whoever holds lock 1 then already holds lock 0, so it never waits for it, and every run finishes (${F.fixedAll} of ${THREAD_SLICES.length}).`,
        solve: () => fixDeadlock(),
      },
      tries: [() => deadlockFixed()],
    },
    {
      title: 'Threads in Python',
      body: `
        <p>The compiler of chapter ${numOf('python')} knows the kernel's thread calls when it targets user mode: <code>spawn(f)</code> starts the function <code>f</code> as the second thread (its stack ${n(THREAD_STACK)} bytes below A's, at 0x${F.py.sp.toString(16)}; returning from <code>f</code> ends the thread), <code>join()</code> waits for it to end, and <code>lock(i)</code>, <code>unlock(i)</code>, <code>wait(c, i)</code>, <code>signal(c)</code> are the calls of this chapter, each an <code>ecall</code>. A global variable that a function touches lives in memory, so both threads see one <code>count</code>.</p>
        <pre class="os-code">${pyRace(true).replace(/</g, '&lt;')}</pre>
        <p>Without the two lock lines the program prints ${F.py.race.join(', ')} at the five slices, where ${2 * PY_N} is right. ${F.py.race.filter((v) => v === 2 * PY_N).length ? `The ${F.py.race.filter((v) => v === 2 * PY_N).length === 1 ? 'one right answer is' : 'right answers are'} luck: the switches happened to miss every window, and a run that comes out right proves nothing. ` : ''}It is the same race, now hidden inside <code>count = count + 1</code>, which compiles to a load, an add and a store like the assembly before. With them it prints ${2 * PY_N} every time, in ${n(F.py.locked)} cycles against ${n(F.py.plain)} at a ${SCENE_SLICE}-instruction slice. The scene runs the locked program on the gates, the golden model in lock step.</p>
        <p>Python's own threads are the same idea with more machinery: CPython's global interpreter lock is one lock around the whole interpreter, taken and given back between bytecodes, which is why its threads take turns on one core much as these do.</p>`,
      scene: scenes.python,
      lit: 'The CSR unit and the MMU',
      challenge: {
        kind: 'quiz',
        question: 'In the Python program, why must count be updated inside lock(0) … unlock(0)?',
        options: ['count = count + 1 is a load, an add and a store: a switch between them loses the other thread\'s updates', 'Python forbids two threads from reading one global', 'Without the lock the compiler gives each thread its own count', 'The lock makes the loop run faster'],
        answer: 0,
        explain: 'One line of Python is several instructions. The lock turns the load-add-store into a critical section; without it the update races exactly as the assembly did.',
        why: ['', 'Reading is allowed; the problem is two load-add-store sequences interleaving.', 'Both threads share the global: that is why the race happens.', 'The lock costs cycles: two system calls per update.'],
      },
    },
  ],
};
