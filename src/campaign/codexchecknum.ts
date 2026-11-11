// Check yourself for the number-form codex entries (codexnum.ts): two questions each, the answer first (quizBox shuffles),
// a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKNUM: Record<string, Quiz[]> = {
  signforms: [
    {
      question: 'The 8-bit pattern 1000 0001 read as sign-magnitude, one\'s complement and two\'s complement?',
      options: ['−1, −126, −127', '−127, −126, −1', '−1, −127, −126', '−126, −1, −127'],
      answer: 0,
      explain: 'Sign-magnitude: sign 1, size 1, so −1. One\'s complement: invert to 0111 1110 = 126, so −126. Two\'s complement: 129 − 256 = −127.',
      why: ['', 'That lists the three readings in reverse.', 'That swaps one\'s and two\'s complement: one\'s complement inverts every bit, giving size 126.', 'Sign-magnitude keeps the size bits as they are, so its size is 1, not 126.'],
    },
    {
      question: 'Why does a floating-point exponent use a bias rather than two\'s complement?',
      options: ['Biased patterns order like unsigned numbers, so exponents compare with an unsigned comparator', 'A bias gives two zeros', 'A bias lets the adder skip the carry', 'Two\'s complement cannot hold negative exponents'],
      answer: 0,
      explain: 'With x + K stored, the smallest value is the all-zero pattern and the largest all ones, so bigger numbers have bigger patterns. Two\'s-complement negatives have their top bit set and so look larger than positives.',
      why: ['', 'It is the sign-based forms that have two zeros; a bias has one.', 'A bias makes addition need a correction, not less.', 'It can; it just orders badly as unsigned.'],
    },
  ],
  gray: [
    {
      question: 'What is the 4-bit Gray code of binary 0110?',
      options: ['0101', '0011', '0111', '1001'],
      answer: 0,
      explain: 'g = b ⊕ (b ≫ 1) = 0110 ⊕ 0011 = 0101.',
      why: ['', 'That is 0010 ⊕ 0001: the code of 0010, not of 0110.', 'That is the Gray code of 0101; you took the wrong input.', 'That is the Gray code of 1110.'],
    },
    {
      question: 'A counter goes 0111 → 1000 while a slow reader samples it. Why is the Gray-coded counter safer?',
      options: ['Only one bit changes, so the reader sees the old value or the new one', 'Gray code has fewer bits', 'Gray code changes more slowly', 'Gray values can be added without converting'],
      answer: 0,
      explain: 'In Gray 0111 → 1000 is 0100 → 1100: one bit flips, so a sample taken during the change is one of the two values the counter really held. Binary flips four bits and any mixture can be read.',
      why: ['', 'Both have the same width.', 'The speed is the same; only the number of simultaneous changes differs.', 'Gray values are labels: convert back before doing arithmetic.'],
    },
  ],
  bcd: [
    {
      question: 'Packed BCD 0x57 + 0x26. After the digit corrections, what is the result?',
      options: ['0x83', '0x7D', '0x83 with a carry out', '0x73'],
      answer: 0,
      explain: 'Low digit: 7 + 6 = 13 > 9, add 6: 1 0011, digit 3 and a carry. High digit: 5 + 2 + 1 = 8. So 0x83: fifty-seven plus twenty-six is eighty-three.',
      why: ['', 'That is the plain binary sum, 87 + 38 = 125, with no correction.', 'There is no carry out: the high digit 8 is within 0–9.', 'The carry out of the low digit was dropped: the high digit is 5 + 2 + 1, not 5 + 2.'],
    },
    {
      question: 'Why does a BCD adder add 6 when a digit sum exceeds 9?',
      options: ['To skip the six unused codes 1010–1111', 'To convert to binary', 'To round the result', 'To generate the sign'],
      answer: 0,
      explain: 'A binary add counts through all sixteen codes, but BCD digits stop at 1001. Adding 6 jumps over 1010–1111 and sets the carry into the next decimal digit.',
      why: ['', 'The result stays in BCD, not in binary.', 'Nothing is rounded: the sum is exact.', 'BCD digits here carry no sign.'],
    },
  ],
  endian: [
    {
      question: 'On a little-endian machine, 0xAABBCCDD is stored at address 0x200. What byte is at address 0x201?',
      options: ['0xCC', '0xBB', '0xDD', '0xAA'],
      answer: 0,
      explain: 'Least significant byte first: 0x200 holds DD, 0x201 holds CC, 0x202 BB, 0x203 AA.',
      why: ['', 'That is the byte at 0x201 on a big-endian machine.', 'That is the byte at 0x200.', 'That is the byte at 0x203.'],
    },
    {
      question: 'When does byte order matter to a program?',
      options: ['When a value is split into bytes, such as a byte load, a file or a network packet', 'Whenever two registers are added', 'Whenever a value is shifted', 'Only for negative numbers'],
      answer: 0,
      explain: 'Inside a register there is no byte order. It exists only once a value is cut into bytes and put somewhere that numbers them.',
      why: ['', 'An add works on whole registers.', 'A shift works on bits of a whole register.', 'Sign has nothing to do with it.'],
    },
  ],
};
