// The fuller codex texts for the number-form entries (codexnum.ts). The numbers are worked from the definitions and pinned by
// tests/content-codexnum.test.ts.

import type { CodexMore } from './codexmore';

const at = (chapter: string, step: number, label: string) => ({ chapter, step, label });

export const MORENUM: Record<string, CodexMore> = {
  signforms: {
    idea: `Two's complement is the usual way to give a fixed-width pattern a sign, but three others were built into real machines. <b>Sign-magnitude</b> keeps a sign bit and the size in the other bits, as we write −5. <b>One's complement</b> negates by inverting every bit. <b>Excess-K</b> (a <i>bias</i>) stores x + K and reads the unsigned value minus K. The first two have two zeros (+0 and −0) and a plain adder gets them wrong: sign-magnitude needs a compare-and-subtract when the signs differ, one's complement an <i>end-around carry</i>, the carry out added back at bit 0. Excess-K needs K subtracted after every addition, but it has one property the others lack: the stored patterns order like unsigned numbers, so comparing two biased values is an unsigned comparison.`,
    example: {
      title: 'One byte, four readings',
      body: `<pre>pattern 1000 0101 = 0x85 = 133 unsigned

sign-magnitude   sign 1, size 000 0101      → −5
one's complement invert → 0111 1010 = 122   → −122
two's complement 133 − 256                  → −123
excess-128       133 − 128                  → +5

8-bit range:  sign-magnitude −127 … 127   one's complement −127 … 127
              two's complement −128 … 127 excess-128      −128 … 127</pre>`,
    },
    mistakes: [
      'Testing for zero with one pattern: sign-magnitude and one\'s complement have two (0000 0000 and the sign bit set, or all ones), and a comparison must treat them as equal.',
      'Reading a bias-encoded field as two\'s complement: a float32 exponent field of 127 means 2⁰, not 2¹²⁷.',
      'Forgetting the end-around carry when adding in one\'s complement: without it the sum is off by one whenever a carry leaves the top.',
    ],
    chapters: [at('binary', 2, 'Why two\'s complement: four ways to sign a number')],
  },
  gray: {
    idea: `In plain binary, counting from 0111 to 1000 changes four bits at once, and anything reading the bits at that instant can see any mixture of old and new. The <b>binary-reflected Gray code</b> numbers the values so that consecutive ones, the wrap from the last back to the first included, differ in exactly one bit. Then a reader that samples mid-change gets the old value or the new one, never a third. The code of b is <code>g = b ⊕ (b ≫ 1)</code>: each bit XOR the bit above it, one level of XOR gates. Going back, each binary bit is the XOR of its Gray bit and all the Gray bits above it: a chain as long as the word. It is used where a value is read while it moves: shaft encoders, the axes of a Karnaugh map (so touching cells differ in one variable), the pointers of an asynchronous FIFO crossing between two unrelated clocks, and Gray-labelled constellations in radio.`,
    example: {
      title: 'Four bits, the whole code',
      body: `<pre>b     g          b     g
0000  0000       1000  1100
0001  0001       1001  1101
0010  0011       1010  1111
0011  0010       1011  1110
0100  0110       1100  1010
0101  0111       1101  1011
0110  0101       1110  1001
0111  0100       1111  1000   → back to 0000: one bit again</pre>0111 → 1000 in binary flips four bits; in Gray it is 0100 → 1100, one bit.`,
    },
    mistakes: [
      'Doing arithmetic on Gray values: they are labels, not quantities. Convert back to binary to add, compare or index memory.',
      'Using a Gray code for a counter that wraps before 2ⁿ: the one-bit-per-step property then breaks at the wrap. A FIFO whose depth is not a power of two needs another scheme.',
      'Expecting it to cover a jump of two: a value that moves by two steps changes two bits.',
    ],
    chapters: [at('binary', 2, 'Why two\'s complement: four ways to sign a number'), at('clocks', 7, 'A bus is not synchronized bit by bit')],
  },
  bcd: {
    idea: `Binary-coded decimal keeps one decimal digit in each four bits: values 0–9, the codes 1010–1111 unused. Read a BCD number in hex and it looks decimal, 0x38 being thirty-eight. Nothing needs converting to print it, and money stays exact: 0.1 is a single digit, where in binary it is a repeating fraction. The cost is in the arithmetic. A plain binary add of two digits is right up to 9; above that the sum must skip six unused codes, so the digit adder adds 6 whenever the binary sum exceeds 9 (a carry out, or a result 1010–1111) and passes a decimal carry to the next digit. Ten of the sixteen codes carry information, so a digit holds log₂10 = 3.32 bits in four, about 83 % of binary's density.`,
    example: {
      title: '38 + 45 in packed BCD',
      body: `<pre>   0x38        low digit: 8 + 5 = 1101 = 13 > 9 → + 6 = 1 0011 → digit 3, carry 1
 + 0x45        high digit: 3 + 4 + 1 = 8
 ------
   0x83        thirty-eight plus forty-five is eighty-three; plain binary would give 0x7D</pre>`,
    },
    mistakes: [
      'Adding BCD with a binary adder and no correction: 0x38 + 0x45 comes out as 0x7D, which is not a BCD number.',
      'Assuming a 4-bit digit holds 0–15: only 0–9 are valid, and a corrected sum must never leave a digit above 9.',
    ],
    chapters: [at('adders', 8, 'Decimal: the BCD adder')],
  },
  endian: {
    idea: `A 32-bit value is four bytes, and memory is addressed by byte, so the bytes must be put in some order. <b>Little-endian</b> stores the least significant byte at the lowest address; <b>big-endian</b> stores the most significant first, which is how a hex dump of the number reads. The names come from Gulliver's Travels, where two nations fight over which end of an egg to crack. RISC-V and x86 are little-endian, and the Internet's <i>network byte order</i> is big-endian, so a program that builds a packet reverses every multi-byte field. Inside a register there is no order: the issue appears only when a value is split into bytes (a byte or halfword load or store, a file, a wire) and put back together. In hardware little-endian is convenient: the byte at offset o of a word is always bits 8o + 7 … 8o, whatever the access size.`,
    example: {
      title: '0x12345678 at address 0x100',
      body: `<pre>address        0x100  0x101  0x102  0x103
little-endian     78     56     34     12     lb at 0x102 → 0x34
big-endian        12     34     56     78     lb at 0x102 → 0x56

lhu at 0x102:  little 0x1234   big 0x5678</pre>`,
    },
    mistakes: [
      'Reading a memory dump as if the first byte were the most significant: on a little-endian machine a word\'s digits appear reversed, byte by byte.',
      'Byte-swapping a single byte, or twice: the swap belongs at the boundary where the value is split or rebuilt, once.',
      'Sending a struct or a word straight onto a network or into a file: the receiver may read the bytes in the other order.',
    ],
    chapters: [at('io', 2, 'Loading a byte'), at('network', 4, 'Bytes in the subset')],
  },
};
