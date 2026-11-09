// Check yourself for the side-channels chapter's codex entries (codexside.ts): two questions each, the answer first
// (quizBox shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKSIDE: Record<string, Quiz[]> = {
  sidechannel: [
    {
      question: 'A program passes every test against its golden model. Can it still leak a secret?',
      options: ['Yes, through something the tests do not compare, such as its time', 'No: the golden model would differ', 'Only if it has a bug', 'Only on a multi-core CPU'],
      answer: 0,
      explain: 'Tests compare outputs and state. Time, cache lines touched and power are not outputs of the program, and they can depend on the secret.',
      why: ['', 'The golden model has no notion of time or caches.', 'The early-exit check is correct and leaks.', 'One core is enough: the chapter\'s attacks use one.'],
    },
    {
      question: 'A wrong guess with the first letter right takes 15 cycles, other wrong guesses 8. What has the attacker learnt?',
      options: ['The first letter', 'The whole password', 'Nothing: both guesses were wrong', 'The password\'s length'],
      answer: 0,
      explain: 'The check went round its loop once more for the matching letter: 7 cycles. The attacker keeps that letter and moves on to the next.',
      why: ['', 'Only the letters already matched are revealed.', 'The time says how far the comparison got.', 'The length is fixed here; the time measures matching letters.'],
    },
  ],
  consttime: [
    {
      question: 'Why does the constant-time check take 38 cycles even for a guess whose first letter is wrong?',
      options: ['It compares every byte and answers once at the end', 'It is a slower algorithm by accident', 'It waits on purpose', 'It loads the password twice'],
      answer: 0,
      explain: 'Doing the same work for every guess is what makes the time say nothing. The early exit was faster because it stopped, and stopping is the leak.',
      why: ['', 'The extra time is the price of the property, not an accident.', 'It has no delay loop: it just does all four bytes.', 'It loads each byte of both once.'],
    },
    {
      question: 'A loop runs a fixed number of times but loads table[secret] each time. Is it constant-time?',
      options: ['No: which cache line it loads depends on the secret', 'Yes: the loop count is fixed', 'Yes, if the table fits in the cache', 'No, because loops are never constant-time'],
      answer: 0,
      explain: 'Its time may not vary, but its memory addresses do, and evict + reload reads those.',
      why: ['', 'A fixed count removes one channel, not the cache.', 'Fitting in the cache does not hide which line was used once the attacker evicts it.', 'A loop with fixed bounds and fixed addresses is fine.'],
    },
  ],
  evictreload: [
    {
      question: 'After evicting its 16 probe lines and letting the victim run, the attacker sees line 9 reload in 5 cycles and the rest in 23. What does that mean?',
      options: ['The victim loaded probe line 9', 'Line 9 was never evicted', 'The victim stored to line 9', 'Line 9 is the slowest line'],
      answer: 0,
      explain: 'Only a line someone loaded since the eviction can hit. The victim chose line 9 with its secret.',
      why: ['', 'The attacker evicted all 16 first; that is why the others miss.', 'A load is enough; nothing was written.', '5 cycles is a hit: the fastest.'],
    },
    {
      question: 'Why does a reload measure 23 cycles when a miss takes 20?',
      options: ['Reading the cycle counter before and after adds to it', 'The cache is slower when shared', 'The line is filled twice', 'A miss takes 23 cycles here'],
      answer: 0,
      explain: 'The measurement includes the two csrr instructions around the load. A hit measures 5 for the same reason.',
      why: ['', 'Nothing else shares this model\'s cache.', 'It is filled once.', 'The miss itself is 20; the rest is the timer.'],
    },
  ],
  transient: [
    {
      question: 'On the gate-level core, the wrong-path load held the secret in the reorder buffer for 16 cycles. Why did the golden model never see it?',
      options: ['The golden model steps only on the correct path, and the load never committed', 'The golden model has no memory', 'The secret was in a register the golden model ignores', 'It saw it, but discarded it'],
      answer: 0,
      explain: 'Transient instructions run and are flushed; only committed ones change architectural state, which is what the golden model computes.',
      why: ['', 'It has a memory, and the secret is in it; the program just never reads it on the correct path.', 'The reorder buffer is not architectural state: nothing there is visible to software.', 'It never executed the load at all.'],
    },
    {
      question: 'What does the flush after a misprediction not undo?',
      options: ['Lines filled in the cache', 'Registers written on the wrong path', 'The rename table', 'Entries in the reorder buffer'],
      answer: 0,
      explain: 'Renaming keeps wrong-path register values apart, so they can be dropped. A cache has one copy of each line and fills it as soon as the data arrives.',
      why: ['', 'Those are restored: that is what renaming is for.', 'It is rebuilt from the committed state.', 'Those are exactly what the flush removes.'],
    },
  ],
  spectre: [
    {
      question: 'Which link of Spectre variant 1 does masking the index break?',
      options: ['The wrong-path load of the secret: its address now waits for len', 'The misprediction', 'The cache fill', 'The attacker\'s timer'],
      answer: 0,
      explain: 'The masked index needs the result of x < len, so the load cannot start until len has arrived, by which time the branch has resolved.',
      why: ['', 'The branch is still mispredicted; the wrong path just cannot reach the load.', 'Nothing is loaded, so nothing fills.', 'The attacker still times its reloads; all come back slow.'],
    },
    {
      question: 'Why is len evicted before every attack?',
      options: ['So the check waits for memory and the wrong path has time to run', 'So the victim cannot read it', 'To train the predictor', 'Because len shares a set with the probe lines'],
      answer: 0,
      explain: 'The window is the time the check waits for len: a 20-cycle miss. With len cached, the check resolves in 2 cycles, before the second load can start.',
      why: ['', 'The victim reads it either way; it is just late.', 'The predictor learns from committed branches, not from the cache.', 'It is in a set of its own.'],
    },
  ],
  specbarrier: [
    {
      question: 'Why does a fence after the check cost cycles even on calls that are in bounds?',
      options: ['The loads after it wait for the check to resolve on every call', 'It flushes the cache', 'It makes the branch mispredict', 'Decoding it takes long'],
      answer: 0,
      explain: 'The core cannot tell an attack from a normal call ahead of time, so it waits every time: 14 cycles a call against 8.5 on our model.',
      why: ['', 'It touches no cache line.', 'The prediction is unchanged.', 'It decodes like any other instruction.'],
    },
    {
      question: 'Which defence costs this victim nothing per call on our model?',
      options: ['Fill at commit', 'A fence', 'An index mask', 'None of them'],
      answer: 0,
      explain: 'Fill at commit changes the core, not the program: in bounds with a warm cache every load hits, so nothing waits for a fill. It costs programs whose loads miss instead.',
      why: ['', '14 cycles a call against 8.5.', '12 cycles a call against 8.5.', 'Fill at commit stays at 8.5.'],
    },
  ],
};
