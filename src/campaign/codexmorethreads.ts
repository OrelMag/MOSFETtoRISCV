// The fuller codex texts for chapter 'threads''s entries (codexvm.ts: thread, race, critsec, lock, condvar, semaphore, deadlock). Every number
// is the chapter's own, measured on the threads kernel and pinned by tests/content-threads.test.ts.

import type { CodexMore } from './codexmore';

const th = (step: number, label: string) => ({ chapter: 'threads', step, label });

export const MORETHREADS: Record<string, CodexMore> = {
  thread: {
    idea: `A process is an address space and the state to run in it; a thread is only the second half: registers, a PC and a stack. Give a process two and both run the same code over the same data, taking turns on one core or running at once on two. Nothing in the hardware marks a thread: the kernel keeps a control block for it as for a process, and the difference is that two blocks hold the same <code>satp</code>.<br>That is also what makes a thread cheaper to switch to. The kernel sees that the next block's satp is the one already in the CSR, skips the write and the TLB flush, and the thread returns to warm translations.`,
    example: {
      title: 'The chapter\'s two threads against two processes',
      body: `<pre>spawn: 323 cycles (the caller's block copied, then the new PC, stack, return address)
timer switch, thread to thread:   98 kernel cycles, 0 walks after it
timer switch, process to process: 98 kernel cycles, 2 walks after it</pre>`,
    },
    mistakes: [
      'Expecting a thread\'s stack to be private by protection: it is private only by agreement. Both threads can reach every page, the other\'s stack included.',
      'Calling the GPU\'s threads the same thing: a SIMT thread is a lane of a warp, sharing one PC with its neighbours, not a separately scheduled flow.',
    ],
    chapters: [th(0, 'Two threads, one address space'), th(8, 'Threads in Python')],
  },
  race: {
    idea: `An update of shared data is a load, a change and a store. If another thread's update lands between them, the store writes over it. Nothing in the program says it cannot: the order comes from where the timer interrupts (on one core) or from which core gets there first (on several), and both change from run to run.<br>The sign of a race is a result that changes with the timing and is right only sometimes, which is why a test that passes proves little.`,
    example: {
      title: 'Two threads, 100 increments each',
      body: `<pre>slice (instructions)   100   200   400   800   1600
final count            108   112   122   100   130     (right: 200)</pre>The same program in Python, 200 increments each: 340, 300, 253, 200 and 400 at the same slices; the 400 is luck.`,
    },
    mistakes: [
      'Believing one core is safe: one thread runs at a time, but a switch can fall inside the update.',
      'Believing count = count + 1 is one step because it is one line: it compiles to a load, an add and a store.',
    ],
    chapters: [th(1, 'A race on one core'), th(8, 'Threads in Python')],
  },
  critsec: {
    idea: `A critical section is defined by what may not happen: no second thread inside it at the same time. Everything else is mechanism. On one core the kernel's own code is a critical section by construction, since a trap turns interrupts off until the <code>mret</code>; that is why a lock call can test the lock and take it with no gap. A user thread gets the same guarantee for its code through the lock.<br>The price is serialisation: while one thread is inside, the others that want in wait, so long sections throw away the parallelism threads were for.`,
    example: {
      title: 'The count, locked',
      body: `<pre>without the lock: 5566 cycles, count wrong
with lock(0) and unlock(0) around the update: 53 391 cycles, count 200
cost: about 239 cycles per increment, two system calls</pre>Both at a 1600-instruction slice.`,
    },
    mistakes: [
      'Locking only the store: the load must be inside too, or the value stored is stale.',
      'Doing slow work (a print, a long loop) inside the section: every other thread that wants the lock waits for it.',
    ],
    chapters: [th(2, 'A critical section, made indivisible by the kernel')],
  },
  lock: {
    idea: `A lock is a word with an owner. Taking it is a test and a store that must not be split, so something has to make them one step: interrupts off on one core (here, the kernel), an atomic instruction such as <code>amoswap</code> on several. Waiting for it can be a loop (a <b>spin lock</b>) or a request to the kernel to park the thread until the unlock (a <b>sleeping lock</b>); the second is right when the holder needs the core the waiter is spinning on.<br>This kernel's unlock hands the lock straight to a waiting thread instead of freeing it, so a thread that waited is not overtaken by the one that just let go.`,
    example: {
      title: 'Spinning against sleeping, B holding the lock for about 2000 instructions',
      body: `<pre>slice          100   200   400   800   1600
trylock tries   48    27    25    15    16
spinning wasted 44 % of its cycles at a 200-instruction slice (against the sleeping run)</pre>`,
    },
    mistakes: [
      'Locking a lock twice in one thread: it is not recursive, so the thread waits for itself (the chapter\'s kernel reports a deadlock).',
      'Forgetting the unlock on one path out of the section: the next thread to ask waits for ever.',
    ],
    chapters: [th(2, 'A critical section, made indivisible by the kernel'), th(3, 'Spinning wastes the slice'), th(4, 'Sleep and wake')],
  },
  condvar: {
    idea: `A lock says who may touch the data; a condition variable lets a thread wait until the data is in a state it can use. The danger it removes is the lost wake-up: a thread that unlocks and then sleeps can miss a signal sent between the two. wait(c, l) does both inside one kernel call. The signal moves the waiter from waiting on c to waiting for l, so it wakes holding the lock.<br>Because the signaller keeps running, the state the waiter woke for may be gone by the time it runs, which is why the test is a while loop.`,
    example: {
      title: 'The chapter\'s ring',
      body: `<pre>producer: 1 .. 20 into a ring of 4 words; consumer: sums them, slower
condition 0 "not full", condition 1 "not empty", both under lock 0
sum 210, the producer waited 12 times, 28 998 cycles at a 200-instruction slice</pre>`,
    },
    mistakes: [
      'if instead of while around the wait: the state is tested once, before another thread may have changed it again.',
      'Signalling before the waiter waits and expecting it to be remembered: a condition variable has no count; a semaphore has.',
    ],
    chapters: [th(5, 'Waiting for a condition')],
  },
  semaphore: {
    idea: `A semaphore remembers what a condition variable forgets: an up with nobody waiting is a count that a later down will find. That makes it the natural tool for counting resources (free slots, full slots, connections) and for passing a permission from one thread to another.<br>A lock is the special case of one permission. With one producer and one consumer a ring needs no lock at all, since each index is written by one thread only and the counts are the kernel's.`,
    example: {
      title: 'The same ring on two semaphores',
      body: `<pre>semaphore 0: free slots, starts at 4     semaphore 1: full slots, starts at 0
producer: down(0), write, up(1)     consumer: down(1), read, up(0)
sum 210 in 22 706 cycles, against 28 998 with a lock and conditions</pre>`,
    },
    mistakes: [
      'Swapping the order of down and the lock in a version with both: a thread holding the lock waits in down, and the thread that would up needs the lock.',
      'Starting the free-slot count at 0: the producer waits for ever.',
    ],
    chapters: [th(6, 'Semaphores')],
  },
  deadlock: {
    idea: `Coffman's four conditions are all needed, so any one of them is a way out: share instead of locking, take every lock at once, let the system take a lock away, or break the cycle. The last is the one programs use: number the locks and take them in increasing order only. A thread holding lock k then waits only for locks above k, and no chain of waits can come back round.<br>A deadlock usually depends on timing, as a race does, so a run that finishes says little. Here the bad order deadlocked at every slice tried.`,
    example: {
      title: 'Two locks, two orders',
      body: `<pre>A: lock(0), work, lock(1)     B: lock(1), work, lock(0)
slices 100, 200, 400, 800, 1600: deadlock at 5 of 5
B: lock(0), work, lock(1): finished at 5 of 5</pre>`,
    },
    mistakes: [
      'Releasing in the reverse order to fix it: the order of unlocks is not the problem, the order of the waits is.',
      'Fixing it with a longer slice: the window gets rarer, not closed.',
    ],
    chapters: [th(7, 'Deadlock')],
  },
};
