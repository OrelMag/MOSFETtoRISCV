// Codex entries for the number forms the binary, adders and I/O chapters teach beside plain two's complement: the other
// signed forms, Gray code, binary-coded decimal and byte order. Same shape as codex.ts, appended to CODEX there; the fuller
// texts are codexmorenum.ts, the questions codexchecknum.ts, the numbers pinned by tests/content-codexnum.test.ts.
// No DOM, no library import: the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_NUM: CodexEntry[] = [
  E('signforms', 'Signed forms beyond two\'s complement', 'concept', 'Sign-magnitude (top bit the sign, the rest the size) and one\'s complement (negate by inverting every bit) both have two zeros and need extra logic to add; excess-K (bias) stores x + K, so values compare as unsigned numbers. 0x85 reads −5, −122, −123 or +5 (excess-128) depending on the form. Floating point uses sign-magnitude for its significand and a bias for its exponent; the Internet checksum is a one\'s-complement sum.', ['twos', 'overflow']),
  E('gray', 'Gray code', 'trick', 'Number the values so that consecutive ones differ in exactly one bit: g = b ⊕ (b ≫ 1), back by b = g ⊕ (g ≫ 1) ⊕ (g ≫ 2) ⊕ … A reader that samples while a bit flips gets the old value or the new one, never a third. Used for shaft encoders, the axes of a Karnaugh map and the pointers of an asynchronous FIFO.', ['positional', 'kmap', 'cdc', 'asyncfifo']),
  E('bcd', 'Binary-coded decimal', 'concept', 'One decimal digit per four bits, the codes 1010–1111 unused, so 0x38 reads thirty-eight. A digit adder adds 6 whenever the binary sum exceeds 9 and sends a decimal carry on. No conversion to print, and cents stay exact; the price is a larger adder and 10 of 16 codes used per digit.', ['hex', 'bin2dec']),
  E('endian', 'Endianness', 'concept', 'The order a multi-byte value takes in memory. Little-endian (RISC-V, x86) puts the least significant byte at the lowest address: 0x12345678 is stored 78 56 34 12. Big-endian (the Internet\'s network byte order, many older machines) stores 12 34 56 78. Matters whenever bytes cross a boundary: a halfword load, a network packet, a file.', ['positional', 'hex']),
];

/** No campaign level teaches these: the test that wants every entry in a level skips them (tests/campaign.test.ts). */
export const NUM_AWAITING_LEVELS: ReadonlySet<string> = new Set(CODEX_NUM.map((e) => e.id));
