// Side channels: a secret read through time. A password check that stops early, a cache that remembers which line was
// touched, and Spectre variant 1 on our out-of-order core: the gates hold the secret on a wrong path, and the model in
// spec mode (riscv/ooomodel.ts) shows the cache keeping its trace and the attacker program reading it back. Every
// number here is computed (tests/sidechan-chapter.test.ts). Teaching code on a modelled machine only.

import { groupDigits } from '../sim/numfmt';
import { GATE_SOURCE } from '../riscv/sideprograms';
import { cpuScene } from '../widgets/cpupanel';
import { defenceTable, probeWidget, pwWidget, spectreWidget } from '../widgets/sidechan';
import { numOf } from './order';
import type { Chapter } from './types';

const ch = (id: Parameters<typeof numOf>[0], step = 0, text = `chapter ${numOf(id)}`) => `<a href="#/c/${id}/${step}">${text}</a>`;

export const chSidechan: Chapter = {
  id: 'sidechan', num: numOf('sidechan'), title: 'Side channels', level: 'Processor',
  blurb: 'A program can be correct and still leak. Time a password check, read the cache without reading it, and watch our out-of-order core load a secret on a path it throws away. Then three defences and what each costs.',
  goals: [
    'recover a secret from how long a program takes, and write code whose time does not depend on it',
    'use the cache as a record of which line was touched: evict, let the victim run, reload and time',
    'follow Spectre variant 1 on our out-of-order core, from the misprediction to the line the flush leaves behind',
    'compare a fence, an index mask and fill-at-commit by whether the attack still works and what each costs in cycles',
  ],
  builds: ['cpu', 'cache', 'ooo'],
  recap: {
    keep: [
      'A side channel is an output nobody meant the program to have: its time, the lines it left in the cache, its power. The program can be correct, checked against the golden model instruction by instruction, and still leak through one.',
      'The flush after a misprediction restores registers and the rename table. It does not restore the cache: a line filled on the wrong path stays filled, and a later reload\'s time shows which one.',
      'Spectre variant 1 needs a branch that resolves late, a load the wrong path is allowed to make, and a second load whose address depends on the first. Breaking any link stops it: a fence stops speculation there, a mask makes the address wait for the check, fill-at-commit keeps wrong-path loads out of the cache.',
      'On our model the fence costs the most per call, the mask a little less, and fill-at-commit nothing on this victim and almost nothing on a program that streams through memory. Each lands its cost somewhere different, and that decides who uses which.',
    ],
    check: [
      {
        question: 'The golden model and the out-of-order core agree on every register after every instruction of the attack. How did the secret get out?',
        options: ['Through which cache line the wrong path filled, read back by timing', 'Through a register the flush forgot to restore', 'Through a store the wrong path made to memory', 'Through the branch predictor\'s table'],
        answer: 0,
        explain: 'Nothing architectural leaked: the registers and memory are right. The wrong path loaded a probe line chosen by the secret, the flush did not unload it, and the attacker found it by timing reloads.',
        why: ['', 'The flush restores every register: that is why the golden model agrees.', 'A wrong-path store never reaches memory (in our model, or any real core).', 'The predictor is what let the wrong path run; the secret goes through the cache.'],
      },
      {
        question: 'Why does masking the index stop the attack?',
        options: ['The load\'s address now waits for len, so the wrong path cannot load out of bounds before the flush', 'The mask stops the branch from being predicted', 'The mask flushes the cache', 'The mask makes the load slower than a miss'],
        answer: 0,
        explain: 'The address is x AND (x < len ? all ones : 0). Until len arrives, the AND cannot run, nor the loads after it; by then the branch has resolved and the wrong path is gone.',
        why: ['', 'The branch is still predicted, and still mispredicted; it just has nothing to leak through.', 'Nothing is flushed: the probe lines are simply never touched.', 'The load is not slower; it cannot start until its address is known.'],
      },
      {
        question: 'Fill-at-commit cost the out-of-order chapter\'s benchmarks nothing on our model. Why is that not proof it is free?',
        options: ['Their data was written before it was read, so their loads hit anyway; a program whose loads miss pays', 'The benchmarks have no branches', 'The benchmarks run on the in-order core', 'Fill-at-commit only applies to stores'],
        answer: 0,
        explain: 'Each benchmark writes its data and then reads it, and a store fills its line, so no load misses. Summing a 4 KB array, four times the cache, does miss, and there fill-at-commit costs cycles.',
        why: ['', 'They are full of branches and mispredictions.', 'The same out-of-order model ran them.', 'It is about loads: a store fills its line at commit anyway.'],
      },
    ],
  },
  steps: [
    {
      title: 'Time tells',
      body: `
        <p>This chapter is about programs that are correct and still leak. Every CPU here is checked against the golden model instruction by instruction, the way ${ch('verify')} showed, and nothing in this chapter breaks that. The leak is through something no specification mentions: how long the program takes, which lines it left in the cache.</p>
        <p>Start with a password check written the obvious way: compare the guess with the password byte by byte, and return as soon as two bytes differ. It answers only yes or no. On the single-cycle CPU of ${ch('cpu')}, one instruction a cycle, a guess whose first letter is wrong takes 8 cycles in the check. Each letter that matches takes the loop round once more: 7 cycles more. The right password takes 33.</p>
        <p>That time is a second output, one nobody meant the check to have: a <b>side channel</b>. Try every first letter, keep the one that took longer, then do the same for the second. With 16 possible letters, that is at most 16 tries a position, 64 in all, where guessing the whole password blind could take ${groupDigits(65536)}.</p>
        <p>The fix is to make the time independent of the guess: compare every byte, OR the differences together, and answer once at the end. That check takes 38 cycles for every guess. It is slower than the early exit every time here, and that is its price: <b>constant-time code</b> spends the worst case every time.</p>
        <div class="try">Find the password from the bars alone. Then switch to the constant-time check and try again.</div>`,
      widget: pwWidget,
      more: {
        real: 'Paul Kocher showed in 1996 that the time an RSA or Diffie-Hellman implementation takes reveals its private key, from many timed operations. Library authors now write such code to be constant-time, and check that a compiler has not undone it: an optimizer that sees the result is already decided may add the early exit back.',
        pitfall: 'Constant time means no branch and no memory address that depends on the secret. A loop that always runs four times but loads a table entry chosen by the secret still leaks, through the cache: that is the next step.',
      },
      challenge: {
        kind: 'quiz', question: 'A guess with the first two letters right takes how many cycles in the early-exit check?',
        options: ['22', '15', '8', '33'], answer: 0,
        explain: 'A first letter that is wrong takes 8 cycles; each matching letter adds a trip round the loop, 7 cycles. Two matches: 8 + 7 + 7 = 22.',
        why: ['', 'That is one matching letter.', 'That is none.', 'That is the right password: all four, and the yes.'],
      },
    },
    {
      title: 'The cache remembers',
      body: `
        <p>The cache of ${ch('cache')} keeps recently used lines so the next load to them is fast. It does that for every program that shares it, and its state is nobody's to read. But it can be measured.</p>
        <p>Our cache here holds 64 lines of 16 bytes and is direct-mapped; a load that hits takes 2 cycles, one that misses 20. The attacker owns 16 <b>probe lines</b>, one per value a secret nibble can have. It evicts all 16 by loading other addresses that map to the same sets. The victim then loads one probe line, chosen by its secret: <code>probe[s · 16]</code>. The attacker reloads all 16 and times each with <code>csrr t5, cycle</code> before and after.</p>
        <p>One reload comes back in 5 cycles, the other fifteen in 23 (the load plus reading the counter twice). The fast one is the line the victim touched, and its number is the secret. This is <b>evict + reload</b>: the attacker never read the victim's data, only its own lines, and the cache told it which one the victim had used.</p>
        <div class="try">Change the secret and watch the fast bar move with it.</div>`,
      widget: probeWidget,
      more: {
        derive: 'The cache is direct-mapped: an address\'s set is its line number modulo 64. The probe array starts at 0x400, so probe line i is in set i; the eviction lines at 0x800 + 16 i are in the same sets with a different tag. Loading them pushes the probe lines out without touching any other set.',
        real: 'On real processors the attacker usually flushes the lines with an instruction (flush + reload, x86\'s clflush) or fills whole sets of a shared cache (prime + probe). The timer is a cycle counter or, where that is hidden, a counting thread; browsers coarsened their timers after 2018 for this reason.',
      },
      challenge: {
        kind: 'quiz', question: 'Why does the attacker evict the probe lines before the victim runs?',
        options: ['So that only the line the victim loads is fast when reloaded', 'So that the victim\'s load misses and takes longer', 'So that the victim cannot load its secret', 'To clear the branch predictor'],
        answer: 0,
        explain: 'If a probe line were already in the cache, its reload would be fast whether or not the victim touched it. Starting with all 16 out, the one fast reload is the victim\'s.',
        why: ['', 'The victim\'s own time is not what is measured.', 'The victim loads its secret either way; it is the probe line that matters.', 'Eviction touches the cache only.'],
      },
    },
    {
      title: 'The path the core throws away',
      body: `
        <p>Now the out-of-order core of ${ch('ooo')}, in gates, unchanged. The program plants four words in an array and a fifth after it, the <span data-show="dm">secret</span> 0x5EC. Then it checks an index against the array's length the way any bounds-checked access does: <code>bgeu a0, t1, out</code>, skip the load when x ≥ len. Here x is 4, one past the end, so the branch is taken and the load must never happen.</p>
        <p>But the length comes out of a divide, 19 cycles, so the check cannot resolve for a while, and the predictor has never seen this branch taken: it predicts "in bounds". Fetch carries on into the load, and the core runs it, as it runs anything on a predicted path. Watch the <span data-show="rob">reorder buffer</span>: the wrong-path <code>lw</code> holds 0x5EC for 16 cycles, and the add after it, which doubles it, holds 0xBD8. Then the branch commits, the core finds the misprediction and flushes everything after it.</p>
        <p>Architecturally nothing happened: no register, no memory word ever had the value, and the golden model, stepping only on the correct path, never ran the load at all. This is <b>transient execution</b>. It is safe as long as nothing the wrong path did can be seen afterwards. The next step shows what can.</p>
        <div class="try">Step the clock and find the cycle the secret appears in the reorder buffer, then the cycle it is gone.</div>`,
      scene: () => cpuScene({ source: GATE_SOURCE, ooo: true, highlight: ['rob', 'dm'] }),
      challenge: {
        kind: 'quiz', question: 'Why does the core load the secret at all?',
        options: ['The bounds check has not resolved and the predictor guessed "in bounds"', 'The bounds check is wrong', 'The divide gave the wrong length', 'Loads always run before branches'],
        answer: 0,
        explain: 'An out-of-order core runs the predicted path while the branch waits for its operands. The check is right; it is just late, and the guess was wrong.',
        why: ['', 'The branch is taken, as it should be, and the core does skip the load in the end.', 'The divide gives 4, the right length.', 'A load waits for its own operands, not for older branches: that is the point of speculation.'],
      },
    },
    {
      title: 'What the flush forgets',
      body: `
        <p>Our gates have no data cache, so from here on the steps run on the cycle-level model of ${ch('ooo')} in a mode built for this chapter. It has the same core (a 2-wide, 16-entry reorder buffer) and the same predictor, plus three things a real core has: wrong-path instructions compute real values, loads go through the cache of the step “The cache remembers” (2 cycles for a hit, 20 for a miss), and <code>csrr cycle</code> reads its cycle counter. Its timing on everything else is the model's, cycle for cycle.</p>
        <p>The victim is now <code>if (x &lt; len) y = probe[array1[x] · 16]</code>, and the attacker has evicted <code>len</code>, so the check waits 20 cycles for memory. In the timeline the branch is fetched, then waits. Behind it, on the wrong path, the load of <code>array1[x]</code> reads the secret, a shift turns it into a probe line's address, and the second load starts 8 cycles after the branch was fetched: a miss, so a line is requested.</p>
        <p>The branch resolves, commits and the core flushes 24 cycles after it was fetched. The flush takes back every register the wrong path wrote. The request for the probe line is already out, and the line arrives in the cache anyway: nothing in a cache records which path asked for a line.</p>
        <div class="try">Find the wrong-path load of the probe line in the timeline, and the cycle the flush removes it.</div>`,
      widget: () => spectreWidget({ show: 'timeline' }),
      challenge: {
        kind: 'quiz', question: 'The flush restores the registers. Why not the cache too?',
        options: ['A cache line has no record of which path asked for it, and undoing fills would cost a buffer and time', 'The cache is not part of the core', 'The line is filled after the flush, so it cannot be flushed', 'Caches cannot be written by loads'],
        answer: 0,
        explain: 'Registers are renamed, so a flush can drop the wrong path\'s copies. A cache has one copy of each line and fills it as soon as the data arrives. Undoing that means holding wrong-path lines apart until commit: step 10 does exactly that, and measures the cost.',
        why: ['', 'It is in the core\'s path to memory; the model keeps it beside the core.', 'In our model the line is in the cache from the moment its request goes out.', 'A load that misses fills its line: that is what makes the next one hit.'],
      },
    },
    {
      title: 'Bounds check bypass',
      body: `
        <p>Put the two halves together. Called in bounds, the victim does what its code says. Called with x past the end, the check is late, the wrong path loads <code>array1[x]</code>, the byte after the array, and touches the probe line it names. The flush hides the load of <code>array1[x]</code>, not the probe line the second load filled.</p>
        <p>The attacker then reloads its 16 probe lines as in the cache step: one comes back in 5 cycles, the rest in 23, and the fast one is the secret nibble. The program stores what it found, and that is what the widget shows as printed: the leak is read by the attacker program itself, not by this page looking into the model.</p>
        <p>This is <b>Spectre</b> variant 1, bounds check bypass (Kocher et al., 2019). It needs three things: a branch that resolves late, a load the wrong path is allowed to make, and a second load whose address depends on the first. The next steps take those links one at a time.</p>
        <div class="try">Change the nibble and check that the fast bar, and what the program printed, follow it.</div>`,
      widget: () => spectreWidget({ show: 'both' }),
      more: {
        real: 'The published attacks used exactly this shape in a browser\'s JavaScript engine and in the Linux kernel, with the eviction and the timing done from the attacker\'s side. Real attacks repeat each measurement and vote, because a real cache is noisy; our model has no noise, so one run is enough.',
        pitfall: 'Spectre is not a bug in the bounds check. The check is right and the core honours it in the end. What it does not honour is that the cache is visible: speculation was only ever invisible in the registers.',
      },
      challenge: {
        kind: 'quiz', question: 'Which of these is not needed for the attack to work?',
        options: ['A store on the wrong path', 'A branch that resolves late', 'A wrong-path load of the secret', 'A second load whose address depends on the secret'],
        answer: 0,
        explain: 'Nothing is written. The secret travels from the first load into the second load\'s address, and the cache keeps the second load\'s line.',
        why: ['', 'Without a late branch there is no window: the core would know it had to skip the body.', 'Without it there is nothing to leak.', 'Without it the secret never reaches anything the flush leaves behind.'],
      },
    },
    {
      title: 'Reading a whole secret',
      body: `
        <p>One nibble per attack is enough to read anything the victim can reach past its array: the program repeats the attack with x = 16, 17, 18 … and stores each nibble it finds. Below, the secret is six nibbles; the program prints all six.</p>
        <p>Each round trains, evicts, attacks and probes: about 750 cycles here. Our model has no noise, so one round a nibble is enough. A real cache has other programs in it, interrupts and prefetchers, so a real attack repeats each round many times and takes the line that came back fast most often.</p>
        <div class="try">Check that the printed string matches the secret, nibble for nibble.</div>`,
      widget: () => spectreWidget({ secret: [0xc, 0x0, 0xf, 0xf, 0xe, 0xe], show: 'chart' }),
      challenge: {
        kind: 'quiz', question: 'Why must the attacker evict len before every attack, not just once?',
        options: ['The victim\'s check loads len, so after one call it is in the cache and the check resolves at once', 'len changes after every call', 'Evicting len trains the predictor', 'The probe lines are in len\'s set'],
        answer: 0,
        explain: 'The window is the time the check waits for len. Once len is cached, the check takes 2 cycles and the wrong path has no time to reach the second load.',
        why: ['', 'len is always 16.', 'The predictor learns from committed branches, not from the cache.', 'len is in a set of its own; the probe lines are in sets 0 to 15.'],
      },
    },
    {
      title: 'The predictor learns back',
      body: `
        <p>After an attack, the bounds check has committed taken. The predictor of ${ch('ooo')} learns from committed branches: a 2-bit counter per branch, and once a branch is taken its entry says "taken" (counter 2). The next out-of-bounds call is then predicted correctly, so there is no wrong path to leak from.</p>
        <p>So the attacker <b>trains</b> it first: two calls with x in bounds, which commit not taken and bring the counter back down to "not taken". Switch the training off and only the first nibble leaks: from the second on, the predictor is right and the program prints dots.</p>
        <div class="try">Switch the training off and count how many nibbles still leak.</div>`,
      widget: () => spectreWidget({ secret: [0x3, 0xa, 0x5, 0xc], trainSwitch: true, show: 'chart' }),
      more: {
        pitfall: 'Our predictor has 16 entries, picked by the branch\'s address, and a branch that lands on a taken entry\'s place replaces it. In the first version of this program one of the attacker\'s own loop branches shared the bounds check\'s entry, threw out its "taken", and so did the training without being asked: every nibble leaked with training off. The program now starts the victim a few nops later, so the check has an entry of its own. Real predictors are larger and share entries in subtler ways, and attackers use that too.',
      },
      challenge: {
        kind: 'quiz', question: 'Without training, why does the first nibble still leak?',
        options: ['The branch has never been taken, so the predictor has no entry and guesses fall-through', 'The first call is always in bounds', 'The cache is empty at the start', 'The first nibble is stored in the cache already'],
        answer: 0,
        explain: 'A branch with no entry is predicted not taken. Only once an attack commits does the entry say "taken", and every attack after that is predicted right.',
        why: ['', 'The first attack call has x = 16, past the end.', 'The probe lines are evicted before every attack anyway.', 'The secret is read from memory each time; it is the probe line that leaks it.'],
      },
    },
    {
      title: 'A fence',
      body: `
        <p>The first defence goes where speculation hurts: a <code>fence</code> right after the check, which in this model is a <b>speculation barrier</b>. Nothing after it dispatches until every older branch has left the reorder buffer. The wrong path still exists, but it stops at the fence, before the load.</p>
        <p>The attacker program runs unchanged and prints nothing: every probe line reloads in 23 cycles. The price is paid on every call, attack or not. In bounds with a warm cache, the victim took 8.5 cycles a call; with the fence it takes 14, because the load behind it now waits for the branch to commit instead of running beside it.</p>
        <div class="try">Switch between no defence and the fence, and compare the probe charts.</div>`,
      widget: () => spectreWidget({ guards: ['fence', 'none'], show: 'both' }),
      more: { real: 'RISC-V has no standard speculation barrier yet; x86 uses lfence and Arm has CSDB and SB. Compilers place them only where a bounds check guards data that matters, because each one costs what you see here, in every call.' },
      challenge: {
        kind: 'quiz', question: 'Why does the fence slow down calls that are in bounds, where there is nothing to leak?',
        options: ['The core cannot know that, so the load always waits for the check to commit', 'The fence flushes the cache', 'The fence is a slow instruction to decode', 'It makes the branch mispredict'],
        answer: 0,
        explain: 'Speculation was what let the load run beside the check. The fence turns that off for this branch, every time.',
        why: ['', 'It touches no cache line.', 'It decodes like any other instruction; it is the waiting that costs.', 'The prediction is unchanged; the core just waits for it to be confirmed.'],
      },
    },
    {
      title: 'A mask',
      body: `
        <p>The second defence is in the data, not the control: keep the branch, but compute the index without trusting it. <code>sltu</code> gives 1 when x &lt; len, <code>neg</code> turns that into all ones or zero, and <code>and</code> makes the index x or 0. Three instructions.</p>
        <p>Now the load's address depends on <code>len</code>. On the wrong path, len is still on its way from memory, so the and cannot run, nor the loads after it; by the time len arrives, the branch has resolved and the wrong path is gone. When x is in bounds nothing changes but the three instructions: 12 cycles a call against 8.5.</p>
        <div class="try">Switch between no defence and the mask; then compare the cycles a call with the fence's.</div>`,
      widget: () => spectreWidget({ guards: ['mask', 'none'], show: 'both' }),
      more: { real: 'This is what Linux\'s array_index_nospec and the JavaScript engines\' index masking do. It needs no new instruction, only care: every load that a bounds check guards needs its own mask.' },
      challenge: {
        kind: 'quiz', question: 'With the mask, what does the wrong path load when x is out of bounds?',
        options: ['Nothing before the flush: its address waits for len', 'array1[0]', 'The secret, but into a register only', 'probe line 0'],
        answer: 0,
        explain: 'The mask needs len, and len is the miss the window is made of. By the time the mask is computed, the branch has resolved.',
        why: ['', 'It would load array1[0] if len were already there, which is harmless; here it is not even that far.', 'The load cannot start without its address.', 'No probe line is touched: the chart is flat.'],
      },
    },
    {
      title: 'Fix it in hardware',
      body: `
        <p>The third defence changes the core, not the program: a load fills its line only when it <b>commits</b>. A wrong-path load still gets its value, so the core runs as fast as before, but its line never enters the cache, because it never commits. The real thing needs a buffer to hold such lines until then.</p>
        <p>The attack, unchanged, prints nothing. The victim's cycles a call do not move: 8.5. Every program pays instead, wherever a load that missed is followed, before it commits, by another load to the same line: that one misses too, where it would have hit. On the benchmarks of ${ch('ooo')} that never happens, and they run in exactly as many cycles: each writes its data before reading it, so its loads hit. Summing a 4 KB array, four times the cache, does miss, and takes 7981 cycles against 7972. The extra misses overlap with the first one, so they cost little here.</p>
        <div class="try">Switch fill-at-commit on and off; the program and the victim are the same in both.</div>`,
      widget: () => spectreWidget({ guards: ['fill', 'none'], show: 'both' }),
      more: { real: 'Research designs of this kind (InvisiSpec, 2018, and those after it) hold speculative fills apart until they are safe. Others partition the cache between security domains, or flush it when switching between them; those need the domains of an operating system to mean anything, and protect against attackers outside, not a victim tricked from inside.' },
      challenge: {
        kind: 'quiz', question: 'Why does fill-at-commit not slow the victim down?',
        options: ['Its loads hit in a warm cache, so nothing waits for a fill', 'The victim has no loads', 'Fill-at-commit only applies to wrong-path loads', 'The victim runs without speculation'],
        answer: 0,
        explain: 'Called in bounds with a warm cache, every load the victim makes hits. Fill-at-commit only delays fills, and a hit needs none.',
        why: ['', 'It loads len, array1[x] and a probe line.', 'Correct-path loads also fill at commit; on a hit there is nothing to fill.', 'It speculates as before.'],
      },
    },
    {
      title: 'What it costs, side by side',
      body: `
        <p>The three defences against the same attack. "Leaks" is not a judgement: it is whether the attacker program printed any of the secret.</p>
        <p>The fence is the most expensive per call and needs to be put in by hand where it matters. The mask costs a little less, also by hand, and is what compilers and JavaScript engines chose. Fill-at-commit costs the victim nothing and must be designed into the core, and every program pays the little it costs. Who pays is a large part of which one a system picks.</p>
        <p>None of them is a fix for side channels in general: the password check of the first step leaks through time on any of these cores. A side channel is whatever a design lets an observer measure; each defence closes one.</p>`,
      widget: defenceTable,
      challenge: {
        kind: 'quiz', question: 'Which defence would you choose for one bounds check in code you cannot recompile?',
        options: ['Fill-at-commit: it needs no change to the program', 'A fence', 'A mask', 'None works without recompiling'],
        answer: 0,
        explain: 'The fence and the mask are changes to the program. Fill-at-commit is a change to the core, and the program runs as it is.',
        why: ['', 'Putting a fence in means changing the program.', 'So does the mask.', 'The hardware defence works on the program as it is.'],
      },
    },
  ],
};
