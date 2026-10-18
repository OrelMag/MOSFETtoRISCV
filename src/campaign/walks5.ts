// Authored walkthroughs, group 5 (see walks.ts for the conventions): Act 8's multiply / divide side
// quests and the floating-point ladder. No DOM.

import type { WalkScript } from './walk';

export const WALKS5: Record<string, WalkScript> = {
  // ---- multiply and divide ------------------------------------------------------------------------
  o_mulseq: [
    {
      title: 'The control',
      text: 'The given iteration control (145 NANDs): load = start while idle, step = load or busy, done = busy and the 5-bit count has reached 16. A rising edge with start = 1 loads; the next 16 edges each add and shift; p is valid while done = 1, after the 17th edge.',
      parts: ['ctl'], codex: ['counter', 'fsm'],
    },
    {
      title: 'The multiplicand',
      text: 'ra holds a for the whole multiplication: it loads only on load and is never written again. 240 NANDs for 16 flip-flops with enable.',
      parts: ['ra'], codex: ['register'],
    },
    {
      title: 'The product register',
      text: 'rh and rl are one 32-bit register {H, L}, both enabled by step. L starts as b, the multiplier: its lowest bit picks each step\'s addend, and each shift retires one bit of b. H starts at 0 and accumulates.',
      parts: ['rh', 'rl'], codex: ['shiftadd'],
    },
    {
      title: 'Add a, or 0',
      text: 'sel ANDs a with L[0] fanned out to 16 bits (32 NANDs): a when the bit is 1, else 0, so no mux is needed. add is a 16-bit ripple adder, H + addend (144 NANDs, depth 36): most of the 48-delay period.',
      parts: ['sel', 'add'], codex: ['ripple'],
    },
    {
      title: 'Load, or shift right',
      text: 'mh and ml (64 NANDs each) choose between loading {0, b} and the next value: the 17-bit {carry, sum} and L shifted right one place as a whole, so H = {carry, sum[15:1]} and L = {sum[0], L[15:1]}. The shift costs nothing: it is the wiring into the muxes. 1 169 NANDs in all, against 2 672 for a 16 × 16 array, for 17 edges instead of one.',
      parts: ['mh', 'ml'], codex: ['mux'],
      ask: {
        question: 'After the add, the register shifts right one place. Where does the sum\'s lowest bit go?',
        options: ['Into the top of L, where the L bit just used made room', 'Nowhere: it is shifted out', 'Into the bottom of H'],
        answer: 0,
        explain: 'That bit of the product is final: later addends are added to H only, so none reaches it. L[0] has just chosen the addend and falls off, so L fills from the top with product bits as b drains out.',
        why: ['', 'It is a product bit: after 16 steps L holds the low half of a × b, one such bit per step.', 'H\'s bottom bit becomes the sum\'s bit 1 after the shift. The sum\'s bit 0 leaves H, since the next add starts at H[0].'],
      },
    },
  ],

  o_mularr: [
    {
      title: 'Eight partial products',
      text: 'Row k is a AND b[k]: eight 8-bit ANDs (16 NANDs each, depth 2), all computed at once. Row k weighs 2^k, so the rows only have to be summed with the right offsets.',
      parts: ['pp0', 'pp1', 'pp2', 'pp3', 'pp4', 'pp5', 'pp6', 'pp7'], codex: ['arraymul'],
    },
    {
      title: 'The first adder',
      text: 'Row 0\'s bit 0 is already p[0]: nothing else has weight 1. add1 adds row 0\'s other seven bits, with a 0 on top, to row 1 (an 8-bit ripple adder, 72 NANDs, depth 20). Its bit 0 is p[1].',
      parts: ['add1'], codex: ['ripple'],
    },
    {
      title: 'Rows 2 to 6',
      text: 'Each adder takes the previous sum without its bit 0, with the previous carry out as its top bit, and adds the next row. Each retires one product bit, p[2] to p[6].',
      parts: ['add2', 'add3', 'add4', 'add5', 'add6'],
    },
    {
      title: 'The last row',
      text: 'add7 gives p[7] and, with its carry, the top eight bits p[15:8]. 8 × 16 + 7 × 72 = 632 NANDs, no clock and no control. Cells grow as n², depth as n: 16 × 16 is 2 672 NANDs, 150 deep.',
      parts: ['add7'],
      ask: {
        question: 'Each 8-bit ripple adder is 20 NANDs deep, and seven of them are chained. How deep is the multiplier?',
        options: ['70', '140', '20'],
        answer: 0,
        explain: 'Row k + 1\'s low bits need only row k\'s low sum bits, which come out early. The slow paths overlap along a diagonal, so the seven carry chains do not add up in full.',
        why: ['', 'That assumes each row waits for the whole carry chain above it. Its low bits start as soon as the row above has produced its low bits.', 'The rows are not side by side: each takes the previous row\'s sum as an operand, so depth grows with the number of rows.'],
      },
    },
  ],

  o_mcore: [
    {
      title: 'Core III, as before',
      text: 'Control, immediates, register file, ALU, branch comparator, next PC, result mux and PC: Core III unchanged, 4 741 NANDs at period 98. Its control unit writes nothing for opcode 0011, so MD needs a decode, a datapath and a write of its own.',
      parts: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u20', 'u22', 'u23'], codex: ['singlecycle'],
    },
    {
      title: 'Decode MD',
      text: 'MD = op0 · op1 · ¬(op2 + op3), opcode 0011, from the four opcode bits: an AND, an OR, a NOT and an AND, 8 NANDs. f3 is not decoded here: the multiplier takes its low two bits and picks mul, mulh, mulhsu or mulhu itself.',
      parts: ['u13', 'u14', 'u16', 'u17'], codex: ['mext', 'decoder'],
    },
    {
      title: 'The multiplier',
      text: 'The MD multiplier (3 257 NANDs, depth 166) reads rs1 and rs2 straight from the register file. Inside, one unsigned 16 × 16 array (2 672) serves all four: a signed high half is the unsigned one minus b when a < 0, and minus a when b < 0.',
      parts: ['u15'], codex: ['arraymul', 'signedmul'],
      ask: {
        question: 'The multiplier is 166 deep and sits between the register file\'s read and write ports. Core III ran at period 98. What happens?',
        options: ['Every instruction now takes a period of about 191', 'Multiplies take longer; other instructions keep period 98', 'Nothing: the multiplier runs beside the ALU'],
        answer: 0,
        explain: 'A single-cycle core has one clock, and its period is the longest path any instruction can take: 191 here. Code without a multiply runs 1.95 times slower.',
        why: ['', 'There is one clock for every cycle: the period cannot change with the instruction being executed.', 'Beside the ALU, yes, but its path is far longer than the ALU\'s (depth 64): the slowest of the parallel paths sets the period.'],
      },
    },
    {
      title: 'Write the product',
      text: 'rwe = rwe + MD, and one more 16-bit mux puts the product on the write-back path when MD: 52 NANDs. 8 058 NANDs in all, +3 317 over Core III.',
      parts: ['u18', 'u19'], codex: ['datapath'],
    },
  ],

  o_div: [
    {
      title: 'Busy and load',
      text: 'run is a flip-flop: busy. load = start · ¬busy, so a start while dividing is ignored. load is high for the one cycle in which the registers take a and b.',
      parts: ['run', 'nbusy', 'load'], codex: ['fsm', 'dff'],
    },
    {
      title: 'Step and count',
      text: 'step = load + busy enables the registers. The 5-bit count is cleared by load and counts the steps: 16 needs bit 4, so five bits. 75 NANDs for the register, 25 for the incrementer.',
      parts: ['en', 'mcnt', 'cnt', 'inc'], codex: ['counter'],
    },
    {
      title: 'Done',
      text: 'done = busy · count[4]: the count has reached 16, after the 17th edge. load sets busy, and it stays set while not done: busy\' = load + busy · ¬done.',
      parts: ['dn', 'ndn', 'keep', 'nrun'],
    },
    {
      title: 'The divisor',
      text: 'rd loads b on load and holds it for the 16 steps: 240 NANDs.',
      parts: ['rd'], codex: ['register'],
    },
    {
      title: 'Remainder and quotient',
      text: 'rr starts at 0 and rq at a, through two 16-bit muxes (49 NANDs each). rq does two jobs: the dividend\'s bits leave at its top, one per step, while the quotient bits enter at its bottom.',
      parts: ['mr', 'rr', 'mq', 'rq'], codex: ['division'],
    },
    {
      title: 'One step',
      text: 'The given division step (482 NANDs, depth 21) shifts the remainder left with rq\'s top bit and subtracts b: if the difference is not negative it is the new remainder and the quotient bit is 1, else the remainder is just shifted and the bit is 0. Its path is most of the period, 31; 1 445 NANDs in all.',
      parts: ['step'],
      ask: {
        question: 'Each step keeps the difference and sets the quotient bit when (remainder shifted in) − b is not negative. With b = 0, what are q and r after the 16 steps?',
        options: ['q = 0xFFFF, r = a', 'q = 0, r = 0', 'q = 0, r = a', 'They stay X: the hardware needs a divide-by-zero check'],
        answer: 0,
        explain: 'Subtracting 0 never goes negative, so every quotient bit is 1 and the remainder is a, shifted in bit by bit. That is exactly RISC-V\'s rule for division by zero, at no cost.',
        why: ['', 'Every subtraction succeeds, so every quotient bit is 1, and the remainder collects all of a.', 'The remainder is right, but a quotient bit is 1 whenever the subtraction does not go negative, and x − 0 never does.', 'Nothing in the datapath depends on b ≠ 0: the same subtract-and-keep runs and gives defined bits.'],
      },
    },
  ],

  o_dcore: [
    {
      title: 'Core III, as before',
      text: 'Control, immediates, register file, ALU, branch comparator, next PC, result mux, the PC\'s load and reset muxes, and the PC: unchanged from Core III.',
      parts: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u29', 'u31', 'u32'], codex: ['singlecycle'],
    },
    {
      title: 'Multiply, as in the last level',
      text: 'MD = opcode 0011, decoded from the opcode bits (8 NANDs), and the MD multiplier (3 257 NANDs) on f3[1:0].',
      parts: ['u13', 'u14', 'u16', 'u17', 'u15'], codex: ['mext'],
    },
    {
      title: 'Start the divider',
      text: 'divide = MD · f3[2]: div, divu, rem and remu are f3 4 to 7. It drives the MD divider\'s start (2 400 NANDs: the 1 445-NAND unsigned divider with the signs taken off and put back around it). The divider loads on the first cycle and ignores start while busy.',
      parts: ['u18', 'u19'], codex: ['division'],
    },
    {
      title: 'Hold',
      text: 'hold = divide · ¬done. While it is 1 the PC loads itself: ld becomes ld + hold, and the target becomes hold ? pc : target (an OR and a 16-bit mux). When done rises the instruction completes and the PC moves on: the single-cycle core\'s stall.',
      parts: ['u20', 'u21', 'u27', 'u28'], codex: ['stall'],
      ask: {
        question: 'The divider needs 18 cycles. How does a single-cycle core wait for it?',
        options: ['Load the PC with its own value until done, and write no register meanwhile', 'Stop the clock until done', 'Lengthen the clock period until the divider fits', 'Run the next instructions and write the quotient when it is ready'],
        answer: 0,
        explain: 'Holding the PC repeats the same instruction every cycle while the divider counts; masking the write keeps the half-finished quotient out of the register file.',
        why: ['', 'The divider itself needs clock edges to step: a stopped clock stops it too. Gating the clock is also a timing hazard.', 'An iterative divider has no single long path to cover: it needs its edges. Only an array divider (a 613-deep path) would fit one long cycle.', 'A later instruction may read rd before the quotient arrives: that needs a scoreboard, which this core does not have.'],
      },
    },
    {
      title: 'Write once, at the end',
      text: 'A 16-bit mux picks the multiplier or the divider by f3[2], and the MD mux puts it on write-back. rwe = rwe + MD · ¬hold: nothing is written until the last cycle. 10 567 NANDs, period 193; every divide holds the core 18 cycles.',
      parts: ['u22', 'u23', 'u24', 'u25', 'u26'], codex: ['datapath'],
    },
  ],

  // ---- the floating-point ladder ------------------------------------------------------------------
  o_fpunpack: [
    {
      title: 'Test the exponent field',
      text: 'Two tests on x[14:10] decide what the rest means: field = 0 (a 5-bit zero detect, 13 NANDs) and field = 31 (a 5-input AND, 8 NANDs). Every output but sign uses one of them.',
      parts: ['u1', 'u3'], codex: ['ieee754'],
    },
    {
      title: 'Hidden bit and exponent',
      text: 'The hidden bit is ¬(field = 0): mant = {hidden, x[9:0]}, 11 bits. A subnormal\'s exponent counts as 1, and one OR does it: exp[0] = x[10] + (field = 0).',
      parts: ['u6', 'u8'], codex: ['subnormal'],
      ask: {
        question: 'exp must be the field, except 1 when the field is 0. What is the cheapest circuit?',
        options: ['One OR: exp[0] = x[10] + (field = 0)', 'A 5-bit mux choosing between the field and 00001', 'A 5-bit incrementer on the field when it is 0'],
        answer: 0,
        explain: 'When the field is 0 every bit is 0, so setting bit 0 gives exactly 1; when it is not, (field = 0) is 0 and the OR leaves the field alone. 3 NANDs.',
        why: ['', 'It works, for 20 NANDs: the upper four bits are already right in both cases, so only bit 0 needs anything.', 'Correct too, but an incrementer plus the mux to use it costs far more than one OR for a value that is always 0 + 1.'],
      },
    },
    {
      title: 'Test the fraction',
      text: 'frac = 0 is a 10-bit zero detect (28 NANDs, depth 9), with its inverse. Only the classes need it: zero against subnormal, ∞ against NaN.',
      parts: ['u4', 'u9'],
    },
    {
      title: 'The classes',
      text: 'zero = (field = 0) · (frac = 0), inf = (field = 31) · (frac = 0), nan = (field = 31) · (frac ≠ 0), and snan = nan · ¬x[9]: a NaN whose quiet bit is 0. 63 NANDs, depth 14 (the fraction test, its inverse, nan, snan).',
      parts: ['u13', 'u14', 'u15', 'u10', 'u16'],
    },
  ],

  o_fpround: [
    {
      title: 'Decode the mode',
      text: 'Three NOTs and four 3-input ANDs give one line each for RNE (000), RDN (010), RUP (011) and RMM (100): 19 NANDs. RTZ (001) needs no line: rounding toward zero never rounds up, so nothing has to recognize it, and modes 5 to 7 behave as RTZ for free.',
      parts: ['u1', 'u2', 'u3', 'u6', 'u7', 'u8', 'u9'], codex: ['rounding', 'decoder'],
    },
    {
      title: 'Shared terms',
      text: 'g + s: anything dropped at all, the inexact test the directed modes use. s + lsb for ties to even. ¬sign for rounding up.',
      parts: ['u5', 'u10', 'u4'],
    },
    {
      title: 'Each mode\'s rule',
      text: 'RNE: g · (s + lsb). RDN: sign · (g + s), away from zero when negative. RUP: ¬sign · (g + s). RMM: g, ties away. One small AND per mode, gated by its mode line.',
      parts: ['u11', 'u12', 'u13', 'u14'],
      ask: {
        question: 'RNE, with lsb = 0, g = 1, s = 0. Does it round up?',
        options: ['No: an exact tie goes to the even neighbour, and lsb = 0 is already even', 'Yes: g = 1 means the dropped part is half or more', 'Yes: ties round away from zero'],
        answer: 0,
        explain: 'g = 1 with s = 0 is exactly halfway. Ties to even rounds up only if that makes the kept bits even, that is if lsb = 1: hence g · (s + lsb).',
        why: ['', 'Half or more, but exactly half is a tie, and RNE breaks ties toward an even last bit.', 'That is RMM, round to nearest with ties to max magnitude. RNE, the IEEE default, breaks ties to even to avoid a bias.'],
      },
    },
    {
      title: 'up and toInf',
      text: 'up is the OR of the four rules (a 4-input OR, 9 NANDs). toInf = RNE + RMM + RDN · sign + RUP · ¬sign: an overflow becomes ∞ in the nearest modes and when rounding toward it, else the largest finite. 62 NANDs, depth 13.',
      parts: ['u17', 'u15', 'u16', 'u18'],
    },
  ],

  o_fpsticky: [
    {
      title: 'Level 1: by 1',
      text: 'A 13-bit 2:1 mux (52 NANDs) picks x or x >> 1 with a 0 in from the left, on s[0]. The one bit it can drop is x[0]: its sticky term is s[0] · x[0].',
      parts: ['u5', 'u4'], codex: ['shifter', 'sticky'],
    },
    {
      title: 'Level 2: by 2',
      text: 'The same mux on s[1], fed by level 1. Its sticky term is s[1] · (its input\'s two low bits ≠ 0): a 2-bit zero detect, a NOT and an AND.',
      parts: ['u12', 'u9', 'u10', 'u11'],
      ask: {
        question: 'Level 2 shifts by 2 when s[1] = 1. Which bits does its sticky term test?',
        options: ['The two low bits of its own input, level 1\'s output', 'x[1:0], the two low bits of the shifter\'s input', 'x[3:2]'],
        answer: 0,
        explain: 'The bits a level drops are the low bits of what it receives. Bits dropped earlier were counted by the earlier levels, so each level tests only its own and the four terms are ORed.',
        why: ['', 'If level 1 shifted, x[0] is gone (level 1 counted it) and x[2] now sits in bit 1: testing x[1:0] would miss it.', 'Those are dropped only when the total shift reaches 4, and they may have moved already: each level sees its input, not x.'],
      },
    },
    {
      title: 'Level 3: by 4',
      text: 'On s[2]; its term tests the four bits it drops (a 4-bit zero detect, 10 NANDs).',
      parts: ['u19', 'u16', 'u17', 'u18'],
    },
    {
      title: 'Level 4: by 8',
      text: 'On s[3]; an 8-bit zero detect (22 NANDs) over the eight bits it drops. Its mux gives y.',
      parts: ['u26', 'u23', 'u24', 'u25'],
    },
    {
      title: 'One sticky bit',
      text: 'sticky is the OR of the four level terms (9 NANDs). 264 NANDs, depth 21: four 52-NAND muxes are 208 of them, the sticky logic 56.',
      parts: ['u27'],
    },
  ],

  o_fplzc: [
    {
      title: 'Two halves',
      text: 'Two 8-bit counters (44 NANDs each), one per half, each giving a 3-bit count c and v = the half has a 1. Each is itself two 4-bit counters, and each of those two 2-bit ones (c = ¬a1, v = a1 + a0, 4 NANDs): the chips you build are the recursion.',
      parts: ['hi', 'lo'], codex: ['lzc'],
    },
    {
      title: 'Pick a count',
      text: 'If the upper half has a 1, the count is its count, else 8 plus the lower one. A 3-bit mux on hi.v picks the low three bits (12 NANDs), and c[3] = ¬hi.v.',
      parts: ['mx', 'n'], codex: ['mux'],
      ask: {
        question: 'The upper half is all zeros and the lower half\'s count is 5: c = 8 + 5 = 13. What does the + 8 cost?',
        options: ['One NOT: c[3] = ¬hi.v, and the low three bits are lo.c', 'A 4-bit adder', 'A 3-bit incrementer and a carry'],
        answer: 0,
        explain: 'A half\'s count is at most 7, so adding 8 never carries: it only sets bit 3, which is 1 exactly when the upper half is empty.',
        why: ['', '8 is a single bit above anything a 3-bit count can hold: nothing to add.', 'Nothing carries into bit 3: the low bits pass through unchanged.'],
      },
    },
    {
      title: 'Valid',
      text: 'v = hi.v + lo.v (3 NANDs); with v = 0 the count is a don\'t-care. 104 NANDs, depth 9: four levels of halving, so the depth grows with log n.',
      parts: ['o'],
    },
  ],

  o_fpnorm: [
    {
      title: 'Where the first 1 is',
      text: 'A 16-bit leading-zero counter (104 NANDs) on mant with a constant 1 below it: the count lz is at most 15 and always defined, so a zero mant needs no case of its own.',
      parts: ['u2'], codex: ['lzc', 'normalize'],
    },
    {
      title: 'How far the exponent allows',
      text: 'exp − 1 (an 8-bit Kogge–Stone adder adding 0xFF, 150 NANDs), then exp − 1 − lz (182). Its sign says whether all lz zeros can go: the exponent may fall to 1 and no lower.',
      parts: ['u7', 'u9', 'u10'], codex: ['prefix'],
    },
    {
      title: 'The left shift',
      text: 'Shift by lz if exp − 1 − lz ≥ 0; else by exp − 1, or by 0 when exp − 1 is negative. Two 4-bit muxes: min(lz, exp − 1), clamped at 0.',
      parts: ['u16', 'u17'], codex: ['subnormal'],
      ask: {
        question: 'lz = 12 and exp = 3. How far does mant shift left?',
        options: ['2', '12', '3', '0'],
        answer: 0,
        explain: 'Shifting by exp − 1 = 2 brings the exponent down to 1, the smallest there is. The result stays subnormal: hidden bit 0, field 0.',
        why: ['', 'That would need exponent 3 − 12 = −9, below anything binary16 encodes: the bits must stop where exponent 1 puts them.', 'Exponent 0 is not a smaller exponent: a field of 0 means a subnormal, which still counts as 1. So the stop is exp − 1.', 'Two leading zeros can still go before the exponent reaches 1: stopping now loses precision for nothing.'],
      },
    },
    {
      title: 'The right shift',
      text: 'When exp < 1 the value is below the smallest normal: shift right by 1 − exp (another 182-NAND subtractor), saturated at 15 when its upper bits are not all 0, and forced to 0 by a 4-bit AND whenever exp ≥ 1.',
      parts: ['u14', 'u19', 'u20', 'u22', 'u24'],
    },
    {
      title: 'The exponent after the shift',
      text: 'exp − lz (an incrementer on exp − 1 − lz, 63 NANDs) when every leading zero went, else 1. A subnormal result also gets 1 here; its field becomes 0 at the end, when its hidden bit is seen to be 0.',
      parts: ['u25', 'u27'],
    },
    {
      title: 'Shift',
      text: 'A 15-bit left shifter (240 NANDs) by the left amount, then the 15-bit sticky shifter (296, depth 21) by the right amount; at most one of them moves. The top 11 bits are the kept significand, bit 3 is the guard bit.',
      parts: ['u35', 'u36'], codex: ['shifter', 'sticky'],
    },
    {
      title: 'Guard and sticky',
      text: 's = bit 2 + bits 1:0 + the shifter\'s sticky + stin: everything below the guard bit in one bit. g + s is the inexact test.',
      parts: ['u39', 'u40', 'u41', 'u42', 'u46'], codex: ['rounding'],
    },
    {
      title: 'Round',
      text: 'The rounding decision (62 NANDs) on lsb, g, s, sign and rm says up; an 11-bit incrementer (99 NANDs) and a mux apply it. Rounding 1.11…1 up carries out: the kept bits become 0 and carry = up · cout.',
      parts: ['u45', 'u51', 'u52', 'u53'],
    },
    {
      title: 'Exponent and overflow',
      text: 'The carry bumps the exponent (an incrementer and a mux). Overflow: the exponent is already 31 or more (a subtractor\'s sign), or it is 30 and the rounding carries (an 8-bit equality test).',
      parts: ['u28', 'u57', 'u31', 'u32', 'u34', 'u61', 'u62'], codex: ['overflow'],
    },
    {
      title: 'Tiny after rounding',
      text: 'UF is tiny and inexact. Tiny means the hidden bit is 0, unless rounding with an unbounded exponent would reach the smallest normal anyway: a second rounding decision, one place further down with lsb tied to 1, ANDed with the guard bit and a 10-bit AND (fraction all 1s).',
      parts: ['u48', 'u50', 'u54', 'u58', 'u59', 'u60', 'u80'],
    },
    {
      title: 'Assemble the encoding',
      text: 'normal = hidden bit + carry; the field is the exponent if normal, else 0. OF = normal · overflow; then the field is 31 and the fraction 0 (∞), or 30 and all 1s (the largest finite) when toInf is 0. NX = inexact + OF. 2 058 NANDs, depth 86.',
      parts: ['u56', 'u63', 'u64', 'u65', 'u68', 'u70', 'u72', 'u73', 'u74', 'u76', 'u78', 'u81'],
    },
  ],

  o_fpadd: [
    {
      title: 'Unpack both',
      text: 'Two float unpacks (63 NANDs each): sign, exponent (a subnormal\'s as 1), the 11-bit significand with its hidden bit, and the classes the special cases need.',
      parts: ['u0', 'u1'], codex: ['ieee754'],
    },
    {
      title: 'Subtract is add',
      text: 'sub XORs b\'s sign: a − b = a + (−b). From here on the unit only adds signed values.',
      parts: ['u4'],
    },
    {
      title: 'Which is larger',
      text: 'A 15-bit Kogge–Stone subtractor (399 NANDs, depth 17) on the patterns without their sign bits: its carry out is |a| ≥ |b|.',
      parts: ['u6'], codex: ['flags'],
      ask: {
        question: 'How does the adder find the operand with the larger magnitude?',
        options: ['A 15-bit integer compare of the patterns without the sign bit', 'Compare the exponents, then the fractions if the exponents are equal', 'Compare the 11-bit significands'],
        answer: 0,
        explain: 'The exponent field sits above the fraction, so for non-negative values the bit patterns are in numeric order, subnormals and ∞ included. One subtractor compares exponent and fraction at once.',
        why: ['', 'That is what the integer compare already does in one pass: the exponent bits are its high-order bits, so they decide first.', 'The significands ignore the exponents: 1.5 × 2^0 has the larger significand, 1.0 × 2^3 the larger value.'],
      },
    },
    {
      title: 'Swap',
      text: 'Muxes on |a| ≥ |b| route the larger operand\'s exponent and significand to one side and the smaller\'s to the other (two 5-bit and two 11-bit muxes), and the result takes the larger one\'s sign. Only one operand ever needs aligning, and a subtraction never goes negative.',
      parts: ['u7', 'u8', 'u9', 'u10', 'u11'], codex: ['mux'],
    },
    {
      title: 'Exponent difference',
      text: 'big − small exponent (a 5-bit subtractor, 104 NANDs). A difference of 16 or more is saturated to 15: by then all of the smaller operand falls into the sticky bit anyway.',
      parts: ['u14', 'u16', 'u17', 'u19'],
    },
    {
      title: 'Align',
      text: 'The sticky shifter (264 NANDs) moves the smaller significand, with two 0s below it, right by the difference. The bits that fall off become one sticky bit at the bottom of the word.',
      parts: ['u22'], codex: ['sticky'],
    },
    {
      title: 'Add or subtract',
      text: 'subtract = a\'s sign XOR b\'s effective sign. A 14-bit fast adder / subtractor (368 NANDs) on {big, 000} and {aligned, sticky}: the significands sit at bits 13..3, with guard and sticky below. The carry out is a 15th bit only when adding; subtracting, it is the no-borrow bit and is masked.',
      parts: ['u12', 'u27', 'u28', 'u29'], codex: ['subtract'],
    },
    {
      title: 'x − x',
      text: 'An exact cancellation gives +0, except −0 in RDN: a 15-bit zero detect on the sum, ANDed with subtract, switches the sign to rm = 2 (a 3-bit equality test).',
      parts: ['u31', 'u32', 'u34', 'u35'],
    },
    {
      title: 'Normalize and round',
      text: 'The 15-bit word has a carry place above the significand, so normalize & round gets the larger exponent + 1 (an incrementer, 63 NANDs) and does the rest: 2 058 NANDs, more than half the unit.',
      parts: ['u38', 'u40'], codex: ['normalize'],
    },
    {
      title: 'Special cases',
      text: 'invalid = a signaling NaN, or ∞ − ∞ (both infinite and subtracting). Any NaN or invalid gives the canonical NaN 0x7E00; else an infinite operand gives ∞ with its sign; else the rounded sum. Two 16-bit muxes on the output, one on the flags. 3 755 NANDs, depth 163.',
      parts: ['u41', 'u42', 'u43', 'u44', 'u45', 'u49', 'u51', 'u52', 'u58'],
    },
  ],

  o_fpmul: [
    {
      title: 'Unpack both',
      text: 'Two float unpacks (63 NANDs each). Multiplying needs no alignment and no swap: the fields go straight to their own units.',
      parts: ['u0', 'u1'], codex: ['ieee754'],
    },
    {
      title: 'The sign',
      text: 'One XOR. The sign is right for zeros and infinities too, so the special cases reuse it.',
      parts: ['u2'],
    },
    {
      title: 'The significands',
      text: 'The given 11 × 11 Wallace-tree multiplier (1 696 NANDs, depth 48) gives a 22-bit product. Two significands in [1, 2) multiply to [1, 4): the product\'s top bit weighs 2, not 1.',
      parts: ['u3'], codex: ['arraymul'],
    },
    {
      title: 'The exponents',
      text: 'ea + eb (an 8-bit Kogge–Stone adder, 150 NANDs), then + 0xF2 = −14 (another 150): one bias off and one place for the top bit\'s weight.',
      parts: ['u9', 'u12'], codex: ['prefix'],
      ask: {
        question: 'Normalize & round takes the biased exponent of the product\'s top bit. What does the second adder add to ea + eb?',
        options: ['−14', '−15', '−30', '+15'],
        answer: 0,
        explain: 'ea + eb carries two biases and the result needs one: −15. The top bit of the 22-bit product weighs 2: +1. Together −14.',
        why: ['', 'Right for the biases, but the product\'s top bit weighs 2^1 times the significands\' scale, not 2^0.', 'The sum carries two biases and the result keeps one of them.', 'The bias was added when each number was encoded: it has to come off, not go on.'],
      },
    },
    {
      title: 'Normalize and round',
      text: 'The 22-bit normalize & round (2 666 NANDs, depth 90) shifts out the product\'s leading zeros (one when its top bit is 0, more when an input was subnormal) and rounds the bits that do not fit in 11 on guard and sticky.',
      parts: ['u14'], codex: ['normalize'],
    },
    {
      title: 'Special cases',
      text: 'invalid = a signaling NaN, or ∞ × 0 either way round; any NaN or invalid gives 0x7E00; else an infinite operand gives ∞ with the XORed sign. A zero needs no case: a zero significand rounds to a signed zero. 4 935 NANDs, depth 150, shallower than the adder\'s 163.',
      parts: ['u15', 'u16', 'u17', 'u18', 'u19', 'u23', 'u25', 'u26', 'u32'],
    },
  ],

  o_fpcmp: [
    {
      title: 'Unpack both',
      text: 'Two float unpacks (63 NANDs each), here only for sign, zero, nan and snan: the magnitudes are compared as raw patterns.',
      parts: ['u0', 'u1'], codex: ['ieee754'],
    },
    {
      title: 'Compare magnitudes',
      text: 'The patterns without their sign bits order like 15-bit integers: a Kogge–Stone subtractor\'s carry out is |a| ≥ |b| (399 NANDs, depth 17), and a 15-bit equality test gives |a| = |b| (103).',
      parts: ['u5', 'u6'], codex: ['fpcompare', 'comparator'],
    },
    {
      title: 'NaN',
      text: 'unord = a NaN on either side: then eq, lt and le are all forced to 0. snan = a signaling NaN on either side.',
      parts: ['u7', 'u14', 'u25'],
    },
    {
      title: 'Equal',
      text: 'eq = ¬unord · (both zero + same sign · |a| = |b|): equal patterns, or −0 against +0.',
      parts: ['u8', 'u9', 'u15', 'u16', 'u22'],
    },
    {
      title: 'Less than',
      text: 'lt is three cases, ORed and gated by ¬unord: signs differ and a is negative (unless both are zeros); both non-negative and |a| < |b|; both negative and |a| > |b| (≥ and not =).',
      parts: ['u17', 'u11', 'u18', 'u10', 'u13', 'u19', 'u12', 'u20', 'u21', 'u23'],
      ask: {
        question: 'a = −0 (0x8000), b = +0 (0x0000). The signs differ and a is negative. What must lt be?',
        options: ['0: −0 = +0, so the different-signs term needs its own both-zero test', '1: the negative one is smaller', '0, and the magnitude compare gives it for free'],
        answer: 0,
        explain: 'IEEE 754 makes the two zeros equal, so neither is less. The different-signs case ignores the magnitudes, so it is gated by ¬(both zero).',
        why: ['', 'True for every other pair with different signs: the zeros are the exception, equal despite their signs.', 'The magnitudes are indeed equal, but the different-signs term does not look at them: without its own test it would say 1.'],
      },
    },
    {
      title: 'Less or equal',
      text: 'le = eq + lt, one OR. 682 NANDs, depth 25; the subtractor and the equality test are 502 of them.',
      parts: ['u24'],
    },
  ],

  o_fpcvt: [
    {
      title: 'The sign',
      text: 'negative = x[15] · signed: an unsigned integer is never negative, whatever its top bit.',
      parts: ['u1'],
    },
    {
      title: 'The magnitude',
      text: 'A 16-bit conditional negate (430 NANDs, depth 17): |x| when negative, else x. −32 768 becomes 32 768, which fits in 16 unsigned bits.',
      parts: ['u2'], codex: ['subtract'],
    },
    {
      title: 'Normalize and round',
      text: 'The 16-bit normalize & round (2 258 NANDs, depth 90) finds the leading 1, shifts it to the top and rounds what does not fit in 11 bits: integers above 2 048 can be inexact. The exponent is the constant 30 and stin is 0. 2 690 NANDs, depth 109.',
      parts: ['u5'], codex: ['normalize', 'rounding'],
      ask: {
        question: 'The integer\'s top bit weighs 2^15. Which exponent does normalize & round get?',
        options: ['30', '15', '0', '16'],
        answer: 0,
        explain: 'Normalize & round takes the biased exponent of the top bit: 15 + the bias of 15 = 30.',
        why: ['', '15 is the unbiased exponent; normalize & round works with biased ones, like the exponent field.', '2^0 is the weight of the lowest bit. The exponent input names the top bit\'s weight.', 'There are 16 bits, but the top one weighs 2^15, and the bias still has to be added.'],
      },
    },
  ],
};
