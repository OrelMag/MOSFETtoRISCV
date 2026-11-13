// Appendix E: the Manchester Baby (SSEM, 21 June 1948) in gates (lib/baby.ts), its golden model (ssem/), Kilburn's
// highest-factor routine from Tootill's notebook, and the Williams tube store. Every scene is the gate-level machine
// with the Baby panel (widgets/baby.ts). Sources: docs/PLAN-BABY.md.

import { BEAT_US, DIGIT_US, HOLD_BEATS, HOLD_S, REFRESH_BEATS } from '../lib/baby';
import { BABY_SERIAL, SERIAL_DIGITS } from '../lib/babyserial';
import { SPOT_HALFLIFE } from '../lib/babytube';
import { ssemWords } from '../ssem/asm';
import { tubeLineScene, TUBE_K } from '../widgets/babytubeview';
import { williams3d } from '../widgets/williams3d';
import { groupDigits } from '../sim/numfmt';
import { kilburnSource, timesSource } from '../ssem/programs';
import { babyScene } from '../widgets/baby';
import { storeLine } from '../widgets/babymon';
import { SAP_COST } from './ch-sap';
import type { Chapter } from './types';
import { numOf } from './order';

const k = groupDigits;

/** Kilburn's routine on 2^18 on the golden model (tests/baby.test.ts measures these). */
export const BABY_RUN = { instrs: 2_097_154, accesses: 3_801_090, answer: 131_072, tried: 131_072 } as const;
/** NANDs (tests/baby.test.ts holds these to lib/baby.ts). */
export const BABY_COST = { timing: 151, decode: 57, control: 1036, acc: 1068, all: 22_694 } as const;
/** The store's share: ram(5, 32), 1024 flip-flops with decoder and multiplexers. */
export const BABY_STORE_NANDS = 19_653;
/** Kilburn's routine on 1000 with regeneration off: the faded Stop on line 13 runs as JMP 0 (tests/baby.test.ts). */
export const REGEN_OFF = { instrs: 8002, beats: 32_008 } as const;
/** The serial subtractor against the word-wide one, in NANDs (tests/baby.test.ts). */
export const SERIAL_COST = { stage: 28, addSub32: 420, serial: 2256 } as const;

const MS_1948 = (4 * BEAT_US) / 1000;
const MIN_1948 = (BABY_RUN.instrs * MS_1948) / 60000, MIN_BURTON = (BABY_RUN.instrs * 1.44) / 60000;
const REFRESH_MS = (REFRESH_BEATS * BEAT_US) / 1000;
const FULL = kilburnSource();
const small = (a: number) => kilburnSource(a);

export const chAppendixBaby: Chapter = {
  id: 'appendix-baby', num: numOf('appendix-baby'), appendix: 'E', title: 'The Manchester Baby, 1948', level: 'Valves, 1948',
  blurb: 'The first machine to run a program from read-write electronic memory, in gates: 32 words on a cathode-ray tube that forgets within a fifth of a second unless it is rewritten, seven instructions, and Kilburn\'s first program run to the end.',
  goals: [
    'read a word the way the Baby\'s display showed it, and decode its seven instructions from two fields',
    'trace an instruction through its four beats, and say what the store does on the beats in between',
    'explain why a Williams tube must be regenerated, and what happens when it is not',
    'run Kilburn\'s highest-factor routine to the end, and price it against 1948 and against this site\'s CPUs',
  ],
  builds: ['registers', 'memory', 'cpu', 'multicycle', 'dram'],
  recap: {
    keep: [
      'The Baby\'s program sat in the same read-write store as its data: 32 lines of 32 digits. An instruction is a line number (digits 0–4) and a function (digits 13–15); the rest of the word is ignored.',
      'It could only subtract. LDN loads the negative of a line, SUB subtracts, CMP skips the next line when A is negative. Addition, multiplication and division are all built from these.',
      `Each instruction takes four beats: S1 (CI + 1), A1 (fetch), S2 (the operand's line), A2 (execute). On the scan beats the tube rewrites one line, so all ${32} lines come round every ${REFRESH_BEATS / 4} instructions, ${REFRESH_MS.toFixed(1)} ms.`,
      `A Williams tube holds a bit as charge for something of the order of ${HOLD_S} s. Without regeneration the store forgets, the same rule DRAM obeys today.`,
    ],
    practise: [],
    check: [
      {
        question: 'Line 8 of Kilburn\'s routine is JRP 20, and line 20 holds −3. Which line runs next?',
        options: ['Line 6', 'Line 5', 'Line 20', 'Line 9'],
        answer: 0,
        explain: 'JRP adds line 20\'s number to CI: 8 + (−3) = 5. CI is then incremented before the next fetch, so line 6 runs: the subtraction again.',
        why: ['', 'That forgets the increment before every fetch: CI holds the last instruction\'s line.', 'JRP adds the number held in line 20; it does not jump to line 20.', 'That is where it would go if the test had skipped it.'],
      },
      {
        question: 'Regeneration is switched off while Kilburn\'s routine runs. What goes wrong first?',
        options: [`A line the program has not touched for about ${HOLD_BEATS} beats reads its dashes as dots: here the Stop on line 13, which then runs as JMP 0`, 'The accumulator loses its value', 'The machine stops at once', 'Nothing: the program keeps every line busy'],
        answer: 0,
        explain: `Only rewriting restores the charge. A line the program reads or writes is rewritten by its action beat, but the Stop on line 13 is skipped until the very end; after ${HOLD_BEATS} beats untouched its dashes have leaked away, it reads as 0, and 0 is JMP 0.`,
        why: ['', 'In this model A is a register; in 1948 it was a tube too, regenerated by its own circuit every beat.', 'Nothing stops it: it runs on with a wrong instruction.', 'The program reads most lines often, but not the Stop.'],
      },
      {
        question: 'Why does Kilburn\'s routine load −(a − 1) and then negate it again, instead of loading a − 1?',
        options: ['The Baby has no instruction that loads a line unchanged: LDN loads its negative', 'To test the sign bit', 'Because a − 1 does not fit in 32 digits', 'To clear the test flip-flop'],
        answer: 0,
        explain: 'With only LDN, a value goes in negated. Two LDNs through a store line (LDN, STO, LDN) bring it back. The Mark 1 later added a plain load.',
        why: ['', 'No test is involved.', 'It fits easily: 2^18 is far below 2^31.', 'The test flip-flop clears at every S1 on its own.'],
      },
    ],
  },
  steps: [
    {
      title: 'Meet the Baby',
      body: `
        <p>On 21 June 1948 a machine in a laboratory of Manchester University ran a program held in its own read-write
        electronic store. That makes it the first stored-program computer to run. It was built as a test of that store,
        so its official name is the Small-Scale Experimental Machine (SSEM); its makers called it the Baby. F. C. Williams,
        Tom Kilburn and Geoff Tootill built it.</p>
        <p>It holds <strong>32 words of 32 binary digits</strong> on the face of a cathode-ray tube, has an accumulator A,
        a control register CI that names the line of the current instruction, and seven instructions. On the right is the
        store's face as the operators saw it on a display tube: a dash is a 1, a dot a 0. The program running is
        Kilburn's highest-factor routine, at the speed of 1948.</p>
        <p>Everything here is the machine built in our NANDs: ${k(BABY_COST.all)} of them, ${k(BABY_STORE_NANDS)} for
        the store alone. The Baby used about 550 valves; Appendix C's breadboard computer has ${k(SAP_COST.logic)} NANDs
        of logic for 16 bytes.</p>
        <div class="try">Watch lines 25 to 27 at the bottom of the face: they are the remainder, −b and b, changing as the
        program tries every number.</div>`,
      scene: () => babyScene({ source: FULL }),
      more: {
        real: `<p>Sources for this appendix: G. C. Tootill's notebook (July 1948), Kilburn's report on the storage system
          (December 1947), F. C. Williams, T. Kilburn and G. C. Tootill in <i>Proc. IEE</i> (1951), S. H. Lavington's
          <i>A History of Manchester Computers</i> (1998), B. Napper's pages on the University's Computer50 site, and C. P.
          Burton's Programmer's Reference Manual for the replica built in 1998, now at the Science and Industry Museum in
          Manchester.</p>`,
      },
    },
    {
      title: 'A bit is a charge',
      body: `
        <p>The store is a cathode-ray tube. Where the beam strikes the screen it knocks electrons out of the phosphor and
        leaves a small patch of charge; drawing a short dash instead of a dot leaves a different charge. A metal plate in
        front of the screen, the <strong>pick-up plate</strong>, sees a small pulse when the beam returns to a spot and
        the charge changes, and the pulse is different for a dot and a dash. So one tube face holds a raster of bits, 32
        lines of 32.</p>
        <p>The charge does not stay. Kilburn's report of December 1947 gives the screen a memory "of the order of 0.2
        seconds". At the beat of Kilburn's 1947 design, ${BEAT_US} µs (32 digits of ${DIGIT_US} µs and four of fly-back; the replica's manual gives 10 µs digits), that is
        about ${HOLD_BEATS} beats. Reading also disturbs the charge, so a read must be followed by a rewrite.</p>
        <p>The model shows the store tube with Kilburn's program on its face: the gun, the plates that steer the beam to a
        line and a digit, and the wire-mesh pick-up plate in front of the glass with its lead to the amplifier. That plate
        covered the face, so nobody saw the bits on a store tube: the operators read them on a separate display tube that
        copied the store, and the model draws the pattern on the store's face only so that you can. The tube was a
        commercial CV1131 (the sources disagree on the size of its face, 6 or 12 inches); its dimensions here are estimates.</p>`,
      widget: () => williams3d(ssemWords(FULL)),
    },
    {
      title: 'Regeneration',
      body: `
        <p>The store keeps its bits by rewriting them before they fade. On every beat that is not reading or writing for
        the program (the <strong>scan</strong> beats) the tube reads the next line in turn and writes it back: the
        <span data-show="wr">rewrite</span> path sends what was read straight back in. Two scan beats an instruction and
        32 lines make a full round every ${REFRESH_BEATS / 4} instructions, ${REFRESH_BEATS} beats or
        ${REFRESH_MS.toFixed(1)} ms, well inside the 0.2 s.</p>
        <p>This is the job DRAM's refresh does today, in the chapter on DRAM: a capacitor that leaks, a sense amplifier
        that reads it, a rewrite before the charge is lost. The Baby did it in 1948 with a line of phosphor.</p>
        <p>Without it, a line survives only while the program itself keeps reading or writing it, because an action beat
        rewrites the line it touches too. Here Kilburn's routine runs on a = 1000. Its loops keep reading lines 5 to 12, 14 to
        23 and 25 to 27; lines 1 to 4 and 24 are needed only at the start. Line 13, the Stop, is skipped every time until a
        remainder is 0. With regeneration off, by then its
        charge has leaked away: it reads as all dots, 0, which is JMP 0, and the machine jumps instead of stopping. That
        happens after ${k(REGEN_OFF.instrs)} instructions, ${k(REGEN_OFF.beats)} beats, about
        ${Math.round((REGEN_OFF.beats * BEAT_US) / 1e6)} seconds at the design's speed.</p>
        <p>The face is drawn as <strong>charge</strong> here: each line fades from the moment it was last written and comes
        back to full brightness when it is rewritten.</p>
        <div class="try">Press <strong>Regeneration on</strong> to turn it off, watch line 13 fade, and wait for the panel
        to name the instruction where the machine and the model part ways.</div>`,
      scene: () => babyScene({ source: small(1000), view: 'charge', highlight: ['wr', 'timing'] }),
      tries: [(st) => st.getInput('regen') === 0],
    },
    {
      title: 'Inside the tube',
      body: `
        <p>Open the store and it is flip-flops: that is what it behaves like. To see the charge itself, here is one line of
        ${2 ** TUBE_K} spots at switch level, built like the DRAM chapter's column: each spot a capacitor that leaks with a
        half-life of ${SPOT_HALFLIFE} beats, the pick-up plate a sense amplifier that compares it with a reference at half
        charge, and a write driver.</p>
        <p>The <span data-show="scan">scanner</span> visits the spots in turn, four beats each: precharge, beam on, sense,
        rewrite. The <span data-show="beam">beam</span> decoder picks the spot. What the pick-up read is held in a
        flip-flop and driven back, so every spot is restored once every ${4 * 2 ** TUBE_K} beats. With <code>wr</code> = 1
        the digit <code>d</code> is written in place of what was read when the beam reaches spot <code>wa</code>.</p>
        <div class="try">Set <code>wr</code> to 1 and Pulse until the scanner has passed spot <code>wa</code>: its bar
        fills. Then press <strong>Wait 700</strong>: with the scanner stopped the charge falls below the line, and the next
        visit reads a dot.</div>`,
      scene: () => tubeLineScene({ highlight: ['scan', 'beam'] }),
    },
    {
      title: 'Words, numbers, instructions',
      body: `
        <p>The display shows a word with <strong>digit 0 on the left</strong>, and digit 0 is the least significant: the
        Baby's operators read numbers backwards from the way we write them. A number is two's complement, digit 31 the
        sign.</p>
        <p>An instruction uses two fields: the <strong>line number</strong> in digits 0–4 (which of the 32 lines) and the
        <strong>function number</strong> in digits 13–15. The other 24 digits are ignored. Tootill's notebook writes both
        fields least significant first too: <code>00011 010</code> is line 24 (8 + 16), function 2 (LDN).</p>`,
      scene: () => babyScene({ source: FULL, paused: true, highlight: ['pi', 'dec'] }),
      challenge: {
        kind: 'quiz',
        question: 'A line reads <code>11011 110</code> in the notebook\'s two fields (line digits 0–4, then function digits 13–15). What is it?',
        options: ['STO 27', 'LDN 27', 'CMP 27', 'SUB 27'],
        answer: 0,
        explain: 'Digits 0–4 are 1, 1, 0, 1, 1: 1 + 2 + 8 + 16 = 27. The function digits 1, 1, 0 are 1 + 2 = 3, STO.',
        why: ['', 'LDN is function 2: 0, 1, 0.', 'That reads the function digits 1, 1, 0 in our order, most significant first: 6, CMP. The notebook puts digit 0 first, so they are 1 + 2 = 3. (The line digits read the same both ways.)', 'SUB is function 4: 0, 0, 1.'],
      },
    },
    {
      title: 'Seven instructions',
      body: `
        <p>The Baby had a subtractor and nothing else for arithmetic, so its instructions are:</p>
        <table class="data"><tr><th>function</th><th>modern</th><th>1948 (Tootill)</th><th>does</th></tr>
        <tr><td>0</td><td>JMP S</td><td>S to Cl</td><td>CI = the number in line S</td></tr>
        <tr><td>1</td><td>JRP S</td><td>Add S to Cl</td><td>CI = CI + the number in line S</td></tr>
        <tr><td>2</td><td>LDN S</td><td>−S to C</td><td>A = −(line S)</td></tr>
        <tr><td>3</td><td>STO S</td><td>c to S</td><td>line S = A</td></tr>
        <tr><td>4, 5</td><td>SUB S</td><td>Sub S</td><td>A = A − line S</td></tr>
        <tr><td>6</td><td>CMP</td><td>Test</td><td>skip the next line if A &lt; 0</td></tr>
        <tr><td>7</td><td>STP</td><td>Stop</td><td>light the stop lamp and halt</td></tr></table>
        <p>Two details trip every newcomer. CI is incremented <em>before</em> each fetch, so it holds the line of the
        instruction running, and a jump must aim one line short of its target. And both jumps are indirect: JMP 22 does not
        go to line 22, it goes to the line after the number <em>held in</em> line 22.</p>`,
      scene: () => babyScene({ source: FULL, paused: true, highlight: ['dec', 'ctl', 'acc'] }),
      challenge: {
        kind: 'quiz',
        question: 'Line 19 is JMP 22 and line 22 holds 4. Which line runs next?',
        options: ['Line 5', 'Line 4', 'Line 22', 'Line 23'],
        answer: 0,
        explain: 'JMP sets CI to the number in line 22, 4; the next fetch increments it first, so line 5 runs.',
        why: ['', 'CI = 4, then + 1 before the fetch.', 'JMP is indirect: line 22 holds the target, it is not the target.', 'Nothing adds 1 to 22.'],
      },
    },
    {
      title: 'Four beats',
      body: `
        <p>The machine works in <strong>beats</strong>, one per clock edge here, ${BEAT_US} µs in Kilburn's 1947 design (${(BEAT_US / DIGIT_US) * 10} µs at the 10 µs digit of the replica's manual). An instruction is
        four, and the panel lights the one the next edge ends:</p>
        <ul>
          <li><b>S1</b> (scan 1): CI = CI + 1, the <span data-show="stat">staticisor</span> (five flip-flops that hold a
          line number for the tube's deflection) takes it;</li>
          <li><b>A1</b> (action 1): the tube reads that line into <span data-show="pi">PI</span>, the present instruction;</li>
          <li><b>S2</b> (scan 2): the staticisor takes PI's line number;</li>
          <li><b>A2</b> (action 2): the <span data-show="dec">decoder</span> enables one function, which acts on that line.</li>
        </ul>
        <p>On S1 and S2 the tube is not needed by the program, and those are the scan beats that regenerate a line each.
        Four beats of ${BEAT_US} µs make ${MS_1948.toFixed(3)} ms an instruction, about ${Math.round(1000 / MS_1948)} a
        second.</p>
        <div class="try">Press <strong>Beat</strong> four times and watch the beats, the highlighted line on the face (pale
        for a scan beat, amber for an action beat) and PI.</div>`,
      scene: () => babyScene({ source: FULL, paused: true, highlight: ['timing', 'stat'] }),
      tries: [(st) => st.value('beat') === 0 && st.value('ci') > 0],
    },
    {
      title: 'The machine in gates',
      body: `
        <p>Each block on the stage opens down to NAND gates:</p>
        <table class="data"><tr><th>block</th><th>what it holds or does</th><th>NANDs</th></tr>
        <tr><td><span data-show="timing">beats</span></td><td>the 2-bit beat counter and the 5-bit scan counter</td><td>${BABY_COST.timing}</td></tr>
        <tr><td><span data-show="dec">decode</span></td><td>a 3-to-8 decoder on the function digits, enabled in A2</td><td>${BABY_COST.decode}</td></tr>
        <tr><td><span data-show="ctl">CI</span></td><td>the control register and its 32-bit adder</td><td>${k(BABY_COST.control)}</td></tr>
        <tr><td><span data-show="acc">A</span></td><td>the accumulator, its subtractor, the test and stop flip-flops</td><td>${k(BABY_COST.acc)}</td></tr>
        <tr><td><span data-show="store">store</span></td><td>32 × 32 digits, drawn as flip-flops</td><td>${k(BABY_STORE_NANDS)}</td></tr>
        <tr><td colspan="2">the whole machine</td><td>${k(BABY_COST.all)}</td></tr></table>
        <p>The store is almost all of it. In 1948 it was one tube and its circuits; that is why a tube store made the
        machine possible at all. The rest is small because a word-wide adder, a subtractor and a few registers are all a
        stored-program computer strictly needs.</p>`,
      scene: () => babyScene({ source: FULL, paused: true }),
    },
    {
      title: 'One digit at a time',
      body: `
        <p>Our machine adds and subtracts a whole word in one clock. The Baby did not: its words came off the tubes one
        digit at a time, digit 0 first, every ${DIGIT_US} µs, so its subtractor was a single
        <span data-show="st">stage</span>: a full adder for a + ¬b, and a flip-flop that carries from one digit to the
        next. The first digit gets a carry in of 1, the +1 of two's complement.</p>
        <p>Here that stage sits between two shift registers that hand it a digit of a and of b each clock, and a third
        register that collects the result. Pulse <code>load</code> for one clock, then hold <code>run</code> for
        ${SERIAL_DIGITS} clocks: <code>r</code> becomes a − b, the same answer as the word-wide subtractor.</p>
        <p>The price is time against gates. The stage is ${SERIAL_COST.stage} NANDs; a 32-digit ripple subtractor is
        ${k(SERIAL_COST.addSub32)}, so the digit stage is ${Math.round(SERIAL_COST.addSub32 / SERIAL_COST.stage)} times
        smaller and ${SERIAL_DIGITS} times slower. The whole unit here is ${k(SERIAL_COST.serial)} because our shift
        registers are flip-flops; on the Baby the words circulated on the tubes themselves, so the shifting cost nothing
        extra.</p>
        <div class="try">Set <code>load</code> to 1, Pulse once, set it back to 0, set <code>run</code> to 1 and Pulse until
        <code>r</code> shows 963.</div>`,
      scene: () => ({ root: BABY_SERIAL, clock: 'clk', inputs: { a: 1000, b: 37, load: 0, run: 0 }, autoClock: false, highlight: ['st'] }),
      tries: [(st) => st.value('r') === 963],
    },
    {
      title: 'Kilburn\'s program',
      body: `
        <p>The first program was Tom Kilburn's: find the highest proper factor of a number a, by trying every b downward
        from a − 1 and dividing by repeated subtraction. The 17 instructions that ran on 21 June are lost. What survives is
        the amended routine in Geoff Tootill's notebook, dated 18 July 1948, two instructions longer so it can be run again
        on the same number. The listing in the panel is that page, line for line.</p>
        <p>On a = 2<sup>18</sup> the golden model takes <strong>${k(BABY_RUN.instrs)} instructions</strong> and stops with
        ${k(BABY_RUN.answer)} = 2<sup>17</sup> in line 27, after trying ${k(BABY_RUN.tried)} values of b. The sources give
        "about 2.1 million instructions" and a run of 52 minutes. At ${MS_1948.toFixed(3)} ms an instruction our count is
        ${MIN_1948.toFixed(1)} minutes; at the 10 µs digit the replica's manual assumes, ${MIN_BURTON.toFixed(1)}. Counting a
        fetch and an operand for every instruction but CMP and STP, the store is accessed ${k(BABY_RUN.accesses)} times
        (the sources: "about 3½ million"; how they counted is not recorded).</p>
        <div class="try">Press <strong>Run to the end</strong>. The gates run flat out, checked against the golden model
        after every instruction, and the bar shows how far they are. It takes a few minutes here, faster than the Baby
        itself ran it.</div>`,
      scene: () => babyScene({ source: FULL, paused: true }),
      tries: [(st) => st.value('stop') === 1],
      challenge: {
        kind: 'quiz',
        question: 'Lines 6 to 8 subtract b until A goes negative. Why does line 9 then subtract line 26?',
        options: ['Line 26 holds −b, so subtracting it adds b back: A becomes the remainder', 'To try the next b', 'To clear A', 'To set the test flip-flop'],
        answer: 0,
        explain: 'The loop overshoots by one b. A − (−b) = A + b, the remainder, which is 0 exactly when b divides a.',
        why: ['', 'The next b is made in lines 14 to 18.', 'A is overwritten by line 11, not cleared here.', 'Only CMP sets the test flip-flop.'],
      },
    },
    {
      title: 'Your own program',
      body: `
        <p>Programs were written on paper in the notebook's notation, converted to binary and set into the store line by
        line, each digit on one of a row of 32 buttons. Here you type them. The program in the box multiplies: with no adder, t + x is
        written −(−t − x), so every addition is five instructions: LDN, SUB, STO into a spare line, then LDN and STO again. A counter in line
        29 runs up from −y to 0 the same way, and CMP skips the Stop while it is still negative.</p>
        <p>As loaded, it leaves 7 × 6 = 42 in line 31. Lines 14 to 25 are never reached: an unused line holds 0, which is
        JMP 0.</p>`,
      scene: () => babyScene({ source: timesSource(), editable: true, paused: true }),
      challenge: {
        kind: 'reach',
        goal: 'Make the Baby leave 12 × 11 = 132 in line 31 and light its stop lamp.',
        check: (st) => !!st.sim && st.value('stop') === 1 && storeLine(st.sim, 31) === 132,
        hints: ['Only the numbers need to change: x is in line 30, and line 29 holds the counter\'s start, the negative of y.', 'Set line 30 to 12 and line 29 to −11, Assemble and load, then Run to the end.'],
        answer: '<p>Change <code>29: NUM -6</code> to <code>29: NUM -11</code> and <code>30: NUM 7</code> to <code>30: NUM 12</code>, then Assemble and load and run to the stop lamp: line 31 reads 132.</p>',
        solve: (st) => {
          st.load(babyScene({ source: timesSource(12, 11), editable: true, paused: true }));
          st.runCycles(10_000, () => st.value('stop') === 1);
        },
      },
    },
    {
      title: 'What 1948 bought',
      body: `
        <p>The Baby did about ${Math.round(1000 / MS_1948)} instructions a second with about 550 valves and drew about
        3.5 kW. It proved the store: a program and its data in one read-write memory, changed by the program itself.
        Within months it grew into the Manchester Mark 1, with a magnetic drum behind the tubes, and in 1951 into the
        Ferranti Mark 1, the first computer sold.</p>
        <p>In this site's terms it has ${k(BABY_COST.all)} NANDs, ${k(BABY_STORE_NANDS)} of them memory. Its seven
        instructions have the same shape as RISC-V's: a fetch from the same memory that holds data, a register that
        names the next instruction, a branch on a sign. What it lacked was an adder for A, an index register (the Mark 1's
        B-tube), and a store larger than one tube.</p>`,
      scene: () => babyScene({ source: FULL, paused: true }),
    },
  ],
};
