// The fuller codex text for the PDP-8 (codexpdp8.ts): everything the sandbox's two PDP-8 examples take for granted. The
// encodings are isa/presets.ts PDP8_PRESET's, the rules src/pdp8/pdp8.ts's (tests/pdp8.test.ts); tests/content-pdp8.test.ts
// assembles the example words below and checks them.

import type { CodexMore } from './codexmore';

export const MOREPDP8: Record<string, CodexMore> = {
  pdp8: {
    idea: `Digital Equipment's PDP-8 (1965) is a whole computer built around one memory cycle: its core memory of 4096 words of 12 bits
      is read and rewritten in 1.5 µs, and every instruction is one to three such cycles, its <b>major states</b>. <b>Fetch</b> reads the
      instruction at PC. <b>Defer</b>, only for an indirect reference, reads the word that holds the real address. <b>Execute</b> reads or
      writes the operand. A JMP needs no Execute, and an operate or I/O instruction is Fetch alone. That is the multicycle idea with the
      memory setting the pace. The registers: PC, the accumulator <b>AC</b> with its <b>link</b> L (a carry bit), and MA / MB, the
      memory's address and data registers, which the front panel's lamps show.
      <br><br>An instruction word: 3 bits of opcode, an <b>I</b> bit (indirect), a page bit, and 7 bits of address. Opcodes 0–5 are AND,
      TAD (two's-complement add, the carry flipping L), ISZ (add 1, skip the next instruction if it reached 0), DCA (store AC, then clear
      it), JMS (store the return address in the subroutine's first word, continue after it) and JMP. There is no load: CLA, then TAD.
      An address reaches <b>page zero</b> (0000–0177) or the 128-word page the instruction sits on; anything else goes through a pointer
      with I. An indirect reference through 0010–0017 first adds 1 to the pointer there (<b>auto-index</b>), which is how a loop walks a table.
      <br><br>Opcode 7, <b>operate</b>, is a word of separate bits acting in a fixed order: group 1 clears, complements, increments and
      rotates AC and L (CLA CLL, CMA, IAC, RAL …), group 2 skips on a test of AC or L (SMA, SZA, SNL and their reverses) and holds HLT.
      Several bits of one group share a word: CLA CLL is 7300. Opcode 6, <b>IOT</b>, talks to a device: 03 the teleprinter's keyboard (KSF
      skips once a key is waiting, KRB reads it), 04 its printer (TSF skips once it is ready, TLS prints AC's low 7 bits).
      <br><br>Numbers are <b>octal</b>, 4 digits for 12 bits, because 12 splits into four 3-bit fields: the lamps and switches come in
      groups of three. The front panel runs a program by hand: set the switches, <b>LOAD ADD</b> copies them into PC, <b>DEP</b> stores
      them into core at PC and moves on, <b>EXAM</b> shows the word at PC and moves on, <b>START</b> clears AC and runs from PC, <b>STOP</b>
      and <b>CONT</b> pause and resume, SING INST runs one instruction.
      <br><br>What the site runs follows the later PDP-8/E's instruction set, a superset: BSW (swap the halves of AC) came later, and the
      1965 machine had the MQ register only with its optional EAE. Its assembler, PAL, wrote a label as PTR, where the sandbox writes PTR:.
      <br><br>Against the multicycle RV32I of the chapter: both take several short cycles an instruction, but a PDP-8 cycle is a whole memory
      cycle of core, so it is the memory, not the logic, that sets the pace.`,
    example: {
      title: 'Two words, read field by field',
      body: `<pre>TAD I 10   1410   001 1 0 0001000   TAD, indirect, page zero, address 0010
                                     → 0010 += 1, then AC += core[core[0010]]
CLA CLL    7300   111 0 11 000000   operate, group 1 (bit 8 = 0): clear AC, clear L
TLS        6046   110 000100 110    IOT, device 04 (printer), pulses 6: print AC
LOAD ADD 0200, START                 the examples' Hello, world begins at 0200</pre>
        The first is the heart of the examples' Hello, world: auto-index through 0010 to walk the message a character at a time.`,
    },
    mistakes: [
      'Reading its listings in decimal: 0200 is 128, and the lamps, switches and words are all octal.',
      'Looking for a load instruction: AC is cleared and added to (CLA, then TAD); DCA stores it and clears it.',
      'Expecting an address to reach all of memory: 7 bits reach page zero or the instruction\'s own page; a table elsewhere is reached through a pointer (TAD I PTR).',
    ],
    chapters: [{ chapter: 'multicycle', step: 1, label: 'The state table' }],
  },
};
