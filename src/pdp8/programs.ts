// Programs for the PDP-8 front panel, in the PDP-8 table's syntax (isa/presets.ts PDP8_PRESET: octal, PAL-style
// operands, labels with a colon, ';' comments). Each says what it should print, so tests/pdp8.test.ts checks the model
// against text written here, not against the model itself.

import { PDP8_PRESET } from '../isa/presets';
import { tableOf } from '../isa/table';

export interface Pdp8Program { id: string; name: string; src: string; start: number; prints: string }

/** Hello, world the way PDP-8 programs printed: an auto-index register walks the text, a subroutine (JMS, and a
 *  return through the address JMS left) prints a character and waits for the teleprinter's flag. */
export const PDP8_HELLO: Pdp8Program = {
  id: 'hello', name: 'Hello, world on the teletype', start: 0o200, prints: 'HELLO, WORLD!\r\n',
  src: `; Hello, world on the console teletype. LOAD ADD 0200, START.
.org 200
start:  CLA CLL         ; AC = 0, L = 0
        TAD ptr         ; AC = the address just before the text
        DCA 10          ; into 0010, an auto-index register
next:   TAD I 10        ; 0010 + 1, then AC = the word it points at
        SNA             ; skip unless AC = 0
        JMP done        ; a 0 ends the text
        JMS type        ; print AC
        JMP next
done:   HLT             ; stopped; CONT prints it again
        JMP start
type:   .word 0         ; JMS leaves the return address here
        TLS             ; print AC (its low 7 bits)
wait:   TSF             ; skip when the teleprinter is ready
        JMP wait
        CLA
        JMP I type      ; return: jump to the address JMS left
ptr:    .word text0
text0:  .word 0
text:   .word 'H', 'E', 'L', 'L', 'O', ',', ' ', 'W', 'O', 'R', 'L', 'D', '!', 15, 12, 0
`,
};

export const PDP8_PROGRAMS = [PDP8_HELLO];

/** A program's core image (4096 words) and its listing. */
export function assemblePdp8(src: string) {
  return tableOf(PDP8_PRESET).assemble(src);
}
