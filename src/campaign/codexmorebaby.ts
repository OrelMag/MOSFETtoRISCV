// The fuller codex texts for Appendix E's entries (codexbaby.ts). Numbers are the chapter's, pinned by
// tests/content-codexbaby.test.ts.

import type { CodexMore } from './codexmore';
import { groupDigits as k } from '../sim/numfmt';

const at = (step: number, label: string) => ({ chapter: 'appendix-baby', step, label });

export const MOREBABY: Record<string, CodexMore> = {
  williamstube: {
    idea: `Before the transistor a computer's memory was whatever could be made to hold a state: a delay line, a drum, a relay. F. C. Williams and Tom Kilburn found one in the cathode-ray tube. The beam strikes the phosphor and knocks electrons out of it, leaving a small patch of charge; a short <b>dash</b> leaves a different charge from a <b>dot</b>. A metal plate in front of the screen sees a small pulse each time the beam comes back to a spot, and the pulse differs for the two. So one tube face holds a raster of bits, and reading one is aiming the beam at it.<br>Two things make it a memory with a rule rather than a miracle. The charge leaks away, "of the order of 0.2 seconds" (Kilburn's report, December 1947). And reading disturbs the spot. So the machine reads every line and writes it back before it fades, at "a frequency greater than 5 cycles/second": <b>regeneration</b>, which is what a DRAM's refresh later became. The Baby does it on the beats the program is not using, a line each scan beat, so the whole store is rewritten every 16 instructions.`,
    example: {
      title: 'The margin, in beats',
      body: `<pre>digit   = 8.5 µs
beat    = 36 digits = 306 µs      (32 digits and 4 of fly-back)
0.2 s   = 654 beats               (the charge, in beats)
refresh = every 64 beats = 19.6 ms (a line a scan beat, 32 lines, two scan beats an instruction)
→ every line is rewritten about ten times inside its hold time</pre>Turn the regeneration off and every line fades: in the chapter's run of the routine on 1000 the Stop on line 13 reads as JMP 0 and the machine runs on past it.`,
    },
    mistakes: [
      'Thinking the screen is a display of the memory: the tube is the memory, and a second tube beside it shows what the first holds.',
      'Forgetting that a read destroys what it reads: every read must be followed by a rewrite of the same line, or the data is gone.',
      'Comparing it with a flip-flop: a flip-flop holds its bit as long as the power is on; a spot holds it for a fraction of a second.',
    ],
    chapters: [at(1, 'A bit is a charge'), at(2, 'Regeneration'), at(3, 'Inside the tube')],
  },
  ssem: {
    idea: `The SSEM was not meant to be a useful computer. It was a test of the Williams tube as a store, and the smallest machine that could show the store worked as a computer's memory: it holds its program and its data in the same 32 lines, and an instruction can overwrite a line another instruction will fetch. That is what <b>stored-program</b> means, and it first ran on 21 June 1948.<br>It has an accumulator A and a control register CI that names the line of the instruction under way (it is stepped before the fetch, so the program starts at line 1). A word is 32 digits, digit 0 the least significant and written on the left as the tube shows it; an instruction uses the line number in digits 0 to 4 and the function in digits 13 to 15 and ignores the rest. Seven instructions: <b>JMP</b> and <b>JRP</b> set CI from a line (absolute or relative), <b>LDN</b> loads the negative of a line, <b>STO</b> stores A, <b>SUB</b> subtracts, <b>CMP</b> skips the next line if A is negative, <b>STP</b> stops. There is no add: the machine can only subtract, so division is repeated subtraction and addition is two subtractions through zero.<br>Each instruction takes four beats of ${k(306)} µs, 1.2 ms. In our gates the machine is ${k(22694)} NANDs, of which ${k(19653)} are the store; the Baby itself used about 550 valves.`,
    example: {
      title: 'Kilburn\'s highest-factor routine',
      body: `<pre>try b = a − 1, a − 2, … ; for each b subtract b from a until the
remainder is negative, add b back, and test it: stop when it is 0
on a = 2^18:  ${k(2097154)} instructions, answer ${k(131072)} = 2^17 (measured on the golden model)
              at 1.224 ms an instruction: about 43 minutes of 1948</pre>Napper's account of the original run says "about 2.1 million" instructions; the golden model counts them exactly.`,
    },
    mistakes: [
      'Looking for the program counter: CI holds the line of the instruction just fetched and is stepped before the next fetch, so the line a JMP names holds the target minus one.',
      'Expecting an immediate or a load: every operand is a line of the store, and constants live in lines of their own (the routine keeps 1, 4 and −3 in lines 20 to 22).',
      'Treating it as slow because it is old: at 4 beats of 306 µs it runs about 800 instructions a second; the routine on 2^18 simply needs two million of them.',
    ],
    chapters: [at(0, 'Meet the Baby')],
  },
};
