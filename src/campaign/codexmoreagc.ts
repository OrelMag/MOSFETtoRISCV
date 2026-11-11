// The fuller codex texts for Appendix F's entries (codexagc.ts). Numbers are R-700 vol. III's (E. C. Hall, 1972) or the
// chapter's, pinned by tests/content-agc.test.ts.

import type { CodexMore } from './codexmore';

const at = (step: number, label: string) => ({ chapter: 'appendix-agc', step, label });

export const MOREAGC: Record<string, CodexMore> = {
  corerope: {
    idea: `A ROM can be a table of constants in gates, a mask in silicon or a pattern of fuses. Core rope puts the table in the <b>routing of wires</b>. A row of magnetic cores is threaded by a set of sense wires; to read, one core is switched, and its changing flux induces a pulse in every wire that passes through its hole. A wire that passes outside the core sees nothing. So each wire, in each core, stores one bit: through for a 1, around for a 0.<br>One core holds many bits, which is where the density comes from. In the AGC's Block II each core stores 12 words of 16 bits, 192 sense wires through or past it, and a diode switching network in the module passes only the addressed word's 16 to the sense amplifiers; a second stage picks one of the six modules. Choosing the core is done inside the rope too: a set current would switch every core, and <b>inhibit</b> wires, driven from the address bits, cancel it in all but one (R-700 sec. 3.5.2).<br>The price is that the contents are manufacturing. A program change means weaving a new rope from a punched tape on a weaving machine, and testing it; the modules were plugged into the computer from outside its sealed case.`,
    example: {
      title: 'The Block II rope, in numbers',
      body: `<pre>12 words a core × 16 bits       = 192 sense wires per core
36 864 words / 6 modules        = 6144 words a module
6144 words / 12 words a core    = 512 cores a module
density (R-700): about 1500 bits per cubic inch, electronics included</pre>The first two lines are R-700's; the third follows from them.`,
    },
    mistakes: [
      'Calling the cores ferrite: the AGC\'s erasable memory used ferrite cores, but a rope core is permalloy ribbon wound on a steel bobbin (K. Shirriff, 2019).',
      'Thinking a core stores one bit: it stores one bit per wire through or past it, 192 in Block II.',
      'Thinking a 0 is a core magnetized the other way: every core switches the same way when read; a 0 is a wire that does not thread it.',
    ],
    chapters: [at(5, 'A program woven into wire'), at(6, 'Inside a rope module')],
  },
  agc: {
    idea: `The Apollo Guidance Computer was designed at the MIT Instrumentation Laboratory for the command and lunar modules. Block II, the version that flew to the Moon, has <b>15-bit words in one's complement</b> (two zeros, an end-around carry) with <b>16-bit central registers</b>: a word from memory enters both top columns of A, so after an addition the two differ exactly when the sum overflowed, and the top one keeps the true sign.<br>Its memory is 36 864 words of core rope and 2048 of erasable core memory, one memory cycle (MCT) of 11.7 µs. The instruction word is a 3-bit code and a 12-bit address; partial codes (instructions that only address erasable memory need 10 bits, freeing two) and EXTEND (the next instruction is from a second set) stretch that to 34 instructions. CCS counts a loop down and branches four ways in one instruction; TS skips when it stores an overflowed sum; INDEX adds a word to the next instruction.<br>All its logic is one circuit, a three-input NOR in resistor-transistor logic: Block I used one gate type because qualifying "even a second circuit type would have outweighed the advantages" (R-700 p. 10); Block II put two gates on a chip, about 5600 gates in 2800 packages, 70 pounds and 55 watts (Table 2-1).`,
    example: {
      title: 'What an instruction costs',
      body: `<pre>AD, CA, TS, CCS …   2 MCT = 23.4 µs   (Table 2-1: addition time)
DAS                 3 MCT = 35.1 µs   (double-precision addition)
EXTEND + MP         4 MCT = 46.8 µs   (multiplication)
TC, TCF             1 MCT = 11.7 µs</pre>The chapter's table sum, five words: 44 instructions, 77 MCT, 900.9 µs on the golden model.`,
    },
    mistakes: [
      'Reading its numbers as two\'s complement: 77777 (octal) is −0, not −1.',
      'Expecting a register as wide as a word: A, L and Q have 16 bits, one more than memory, to hold an overflow.',
      'Thinking of it as one chip: about 5600 NOR gates, two to a flatpack, welded into logic modules.',
    ],
    chapters: [at(0, 'Meet the AGC'), at(7, 'Thirty-four instructions')],
  },
};
