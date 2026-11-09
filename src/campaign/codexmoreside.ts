// The fuller codex texts for the side-channels chapter's entries (codexside.ts). Numbers are the chapter's, pinned by
// tests/sidechan-chapter.test.ts.

import type { CodexMore } from './codexmore';

const at = (step: number, label: string) => ({ chapter: 'sidechan', step, label });

export const MORESIDE: Record<string, CodexMore> = {
  sidechannel: {
    idea: `A specification says what a program computes. It does not say how long that takes, which cache lines it leaves behind or how much power it draws, and anyone who can measure those learns something. A <b>side channel</b> is such an output. Correctness says nothing about it: every CPU in this book is checked against the golden model, and the attacks in the chapter run on CPUs that pass that check.`,
    example: {
      title: 'A password check that talks',
      body: `<pre>wrong first letter         8 cycles
each letter that matches  +7 cycles
the right password        33 cycles
→ 16 tries a letter, 4 × 16 = 64 in all, against 16⁴ = 65 536 blind</pre>The time of each guess says how many letters were right.`,
    },
    mistakes: [
      'Thinking a program that passes every test cannot leak: tests check the outputs it is meant to have.',
      'Fixing one channel and calling it done: the constant-time check still leaks if it loads a table entry the secret chooses, through the cache.',
    ],
    chapters: [at(0, 'Time tells'), at(10, 'What it costs, side by side')],
  },
  consttime: {
    idea: `Make the time independent of the secret: no branch on it and no memory address chosen by it. For a comparison that means looking at every byte, ORing the differences and deciding once at the end. It always costs the worst case, 38 cycles here against 8 to 33, and that is the point.`,
    example: {
      title: 'The two checks side by side',
      body: `<pre>early exit:     lbu, lbu, bne → no      (leaves at the first difference)
constant time:  lbu, lbu, xor, or       (every byte, every time)
                seqz a0, a2             (one answer at the end)</pre>`,
    },
    mistakes: [
      'Trusting the source: an optimizing compiler that sees the answer is already decided may put the early exit back. Check the machine code.',
      'Removing the branch but keeping a table lookup indexed by the secret: the time is constant, the cache lines touched are not.',
    ],
    chapters: [at(0, 'Time tells')],
  },
  evictreload: {
    idea: `The cache is shared by every program and records which lines were used recently. The attacker cannot read the victim's data, but it can arrange that its own probe lines are out of the cache, let the victim run, and time a reload of each. The one the victim touched is fast.`,
    example: {
      title: 'Hit against miss, as the program measured them',
      body: `<pre>csrr t5, cycle
lw   t2, 0(t1)        probe line i
csrr t6, cycle
sub  t6, t6, t5       5 cycles: a hit · 23 cycles: a miss (20) + the timer</pre>`,
    },
    mistakes: [
      'Forgetting to evict before every measurement: a line already in the cache reloads fast whoever touched it.',
      'Putting the probe lines in sets something else uses: their own traffic then evicts or refills them.',
    ],
    chapters: [at(1, 'The cache remembers'), at(4, 'Bounds check bypass')],
  },
  transient: {
    idea: `An out-of-order core does not wait for a branch to resolve: it runs the predicted path, and when the guess was wrong it flushes everything after the branch. Those instructions ran, and their values sat in the reorder buffer, but none of them commits. That is <b>transient execution</b>. It is invisible in the registers by design, and nothing guarantees it is invisible anywhere else.`,
    mistakes: [
      'Believing a bounds check stops the load: it stops it from committing, not from running.',
      'Assuming the flush undoes everything: it restores registers and the rename table, not the cache.',
    ],
    chapters: [at(2, 'The path the core throws away'), at(3, 'What the flush forgets')],
  },
  spectre: {
    idea: `Bounds check bypass puts the two ideas together: transient execution reads a byte it must not, and the cache keeps a trace of it that evict + reload can read. Three links make it work: a branch that resolves late (len had to come from memory), a wrong-path load of the secret, and a second load whose address depends on it. On our model the attacker program prints every secret nibble it was pointed at.`,
    example: {
      title: 'One attack, cycle by cycle',
      body: `<pre>check fetched                    cycle  0
second load (probe) picked             8   (a miss: the line is requested)
check commits, core flushes           24
reload probe[0…15]: one in 5 cycles, fifteen in 23</pre>`,
    },
    mistakes: [
      'Calling it a bug in the bounds check: the check is right and the core honours it in the end.',
      'Expecting the second attack to work like the first: once an attack commits, the predictor says "taken" and must be trained back with in-bounds calls.',
    ],
    chapters: [at(4, 'Bounds check bypass'), at(5, 'Reading a whole secret'), at(6, 'The predictor learns back')],
  },
  specbarrier: {
    idea: `Where speculation would leak, stop it: after a speculation barrier nothing dispatches until every older branch has resolved. The wrong path still starts, but cannot reach the load. It costs every call, attack or not, so it goes only where a check guards data that matters. A mask on the index (sltu, neg, and) does the same job through a data dependency, and fill-at-commit does it in hardware for every program.`,
    example: {
      title: 'Three defences against one attack (our model)',
      body: `<pre>                     leaks   cycles a call
none                  yes      8.5
fence (barrier)       no      14
index mask            no      12
fill at commit        no       8.5</pre>`,
    },
    mistakes: [
      'Putting the barrier before the check instead of after it: the wrong path starts at the check.',
      'Assuming it fixes other side channels: the password check leaks through time with or without it.',
    ],
    chapters: [at(7, 'A fence'), at(8, 'A mask'), at(9, 'Fix it in hardware'), at(10, 'What it costs, side by side')],
  },
};
