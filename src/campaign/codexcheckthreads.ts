// Check yourself for chapter 'threads''s entries (codexvm.ts): two questions each, the answer first (quizBox shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKTHREADS: Record<string, Quiz[]> = {
  thread: [
    {
      question: 'What do two threads of one process share, and what does each have of its own?',
      options: ['They share the address space; each has its own registers, PC and stack', 'They share the registers; each has its own pages', 'They share nothing; the kernel copies data between them', 'They share the stack; each has its own heap'],
      answer: 0,
      explain: 'A thread is a flow of control: registers, PC, stack. The pages, and so every global variable, belong to the process and are seen by all its threads.',
      why: ['', 'Registers are the one thing that cannot be shared: each thread is at its own place in its own code.', 'That describes two processes.', 'Each needs its own stack for its calls; sharing one would mix their return addresses.'],
    },
    {
      question: 'Why does a switch between two threads of one process cost fewer cycles after the return than a switch between two processes?',
      options: ['satp does not change, so the TLB keeps its translations and no walks are needed', 'Threads have fewer registers to save', 'The kernel skips the scheduler for threads', 'Threads run in machine mode'],
      answer: 0,
      explain: 'Both blocks hold the same satp. The kernel skips the write and the flush, and the thread finds its translations still cached: no refill walks.',
      why: ['', 'The same 31 registers are saved and loaded.', 'The scheduler runs the same way: it is the address space that does not change.', 'Threads run in user mode like processes.'],
    },
  ],
  race: [
    {
      question: 'Two threads each add 1 to a shared word 100 times on one core, without a lock. The result is 130. What happened?',
      options: ['Switches fell between a thread\'s load and its store, so the other thread\'s updates in between were written over', 'The CPU added wrongly', 'One thread ran only 30 times', 'The word overflowed'],
      answer: 0,
      explain: 'Each lost update is a stale store: a thread loaded the value, was switched out, the other thread incremented it, and the first stored its old value plus one.',
      why: ['', 'Every add was right; the stores overwrote each other.', 'Both loops ran to the end; their effects were lost, not their iterations.', '200 fits easily in a word.'],
    },
    {
      question: 'The same racy program prints the right answer at one slice. Is it correct at that slice?',
      options: ['No: the switches happened to miss the window this time; a race makes the result depend on timing', 'Yes, at that slice', 'Yes, at that slice and any longer one', 'Only on one core'],
      answer: 0,
      explain: 'A race does not make every run wrong, it makes the result depend on timing. Any change (more work, another program, an interrupt) moves the switches.',
      why: ['', 'Nothing in the program keeps the switches out of the window.', 'A longer slice gave a wrong answer in the chapter too.', 'Two cores race at least as badly.'],
    },
  ],
  critsec: [
    {
      question: 'How does the chapter\'s kernel make its lock call indivisible on one core?',
      options: ['A trap turns interrupts off until mret, so nothing can switch threads between the test and the take', 'It uses an atomic instruction', 'It checks the lock twice', 'It runs the call in the other thread'],
      answer: 0,
      explain: 'Inside the kernel, MIE is clear: the timer waits. Any sequence the kernel runs is a critical section by construction on one core.',
      why: ['', 'One core needs none: no other core can come in between.', 'Checking twice still leaves a gap between the check and the store.', 'Calls run in the caller\'s context.'],
    },
    {
      question: 'Which part of count = count + 1 must be inside the critical section?',
      options: ['All of it: the load, the add and the store', 'Only the store', 'Only the load', 'Only the add'],
      answer: 0,
      explain: 'The race is a switch between the load and the store. Protecting part of the sequence leaves that gap open.',
      why: ['', 'A protected store can still write a value loaded before another thread\'s update.', 'A protected load can still be followed by a stale store.', 'The add touches only a register.'],
    },
  ],
  lock: [
    {
      question: 'On one core, thread A spins on trylock while B holds the lock. Why is that wasteful?',
      options: ['B cannot run while A spins, so every try until the next switch is wasted', 'trylock is slower than lock', 'Spinning takes the lock from B', 'It is not: spinning is always faster'],
      answer: 0,
      explain: 'The holder needs the core to release the lock, and the spinner has it. Sleeping gives the core back at once.',
      why: ['', 'Per call the two cost about the same.', 'trylock never takes a held lock.', 'On several cores a short spin can win; on one core it cannot.'],
    },
    {
      question: 'The chapter\'s unlock hands the lock straight to a waiting thread. What does that prevent?',
      options: ['The releasing thread taking the lock again before the waiter runs', 'A deadlock', 'A race on the lock word', 'The waiter having to save its registers'],
      answer: 0,
      explain: 'If the lock were freed, the thread that just let it go could take it again in the same slice; the waiter would wake to find it held. Handing it over makes the waiter the owner at once.',
      why: ['', 'Lock order is what prevents deadlock.', 'The lock word is the kernel\'s, changed with interrupts off.', 'Registers are saved at every switch in any case.'],
    },
  ],
  condvar: [
    {
      question: 'Why is the test around wait() a while loop and not an if?',
      options: ['The state may have changed again before the woken thread runs, so it must test again', 'wait() returns at random', 'A while loop is faster', 'The compiler requires it'],
      answer: 0,
      explain: 'A signal says the state was right at some moment. The signaller keeps running, and other threads may run first; the woken thread must check the state it is about to use.',
      why: ['', 'It returns after a signal, but the signal is only a hint.', 'Speed is not the issue: correctness is.', 'Any loop or none compiles.'],
    },
    {
      question: 'A thread calls signal(c) while no thread waits on c. What happens?',
      options: ['Nothing: the signal is lost, and a later wait still sleeps', 'The next wait returns at once', 'The kernel reports an error', 'The signal wakes the next thread to call wait'],
      answer: 0,
      explain: 'A condition variable keeps no count. That is why the waiter tests the state under the lock before it waits: the state, not the signal, is the memory.',
      why: ['', 'That is a semaphore\'s behaviour, which remembers an up.', 'A signal with nobody waiting is legal and common.', 'Nothing remembers it.'],
    },
  ],
  semaphore: [
    {
      question: 'A semaphore starts at 1 and is only ever downed and then upped by the same thread. What is it?',
      options: ['A lock: one permission, held between the down and the up', 'A condition variable', 'A counter of free slots', 'A deadlock'],
      answer: 0,
      explain: 'One permission means one thread at a time between down and up: a critical section.',
      why: ['', 'A condition variable has no count.', 'It counts one thing: whether the section is free.', 'Nothing here waits in a cycle.'],
    },
    {
      question: 'A ring of 4 slots uses a free-slot semaphore starting at 4 and a full-slot semaphore starting at 0. Why does it need no lock with one producer and one consumer?',
      options: ['Each index is written by one thread only, and the counts are kept by the kernel', 'Semaphores are faster than locks', 'The ring is too small to race', 'The kernel runs both threads at once'],
      answer: 0,
      explain: 'The producer alone moves the put index, the consumer alone the take index; the semaphores make sure neither passes the other. With two producers the put index would be shared and need a lock.',
      why: ['', 'Speed is a consequence, not the reason.', 'Size has nothing to do with races.', 'One core runs one thread at a time.'],
    },
  ],
  deadlock: [
    {
      question: 'Which of these is not one of the four conditions for a deadlock?',
      options: ['A short time slice', 'Mutual exclusion', 'Hold and wait', 'A cycle of waiting'],
      answer: 0,
      explain: 'The four are mutual exclusion, hold and wait, no preemption and a cycle. The slice only changes how often the timing lines up.',
      why: ['', 'A lock has one owner: that is the first condition.', 'Holding one lock while asking for another is the second.', 'The cycle is the fourth, and the one programs break.'],
    },
    {
      question: 'Two threads deadlock on locks 0 and 1. Which fix works at every slice?',
      options: ['Both take lock 0 before lock 1', 'A longer slice', 'Unlock in the reverse order', 'Use trylock and give up after ten tries'],
      answer: 0,
      explain: 'A global order makes a cycle impossible: whoever holds lock 1 already holds lock 0 and never waits for it.',
      why: ['', 'A longer slice makes the window rarer, not closed.', 'Unlocks never wait, so their order cannot make or break a cycle.', 'That trades a deadlock for a program that fails sometimes.'],
    },
  ],
};
