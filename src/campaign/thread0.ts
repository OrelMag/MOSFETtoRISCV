// The thread (thread.ts), acts 0, P, 1 and 2: where each level's part ends up, how the next levels use
// it, and the mistakes made building it. Numbers are measured (libCost, the levels' pars, copiesIn on the
// reference answers) and pinned by tests/thread.test.ts. No DOM.

import type { NodeThread } from './thread';

export const THREAD0: Record<string, NodeThread> = {
  // ---- Act 0 ----------------------------------------------------------------------------------
  intro: { // a lesson about the whole machine: every block
    uses: ['all'],
    usedFor: {
      t_inv: 'the switch every block on the diagram is made of, built first',
      l_bool: 'the control unit, the decoders and the next-PC logic are logic: algebra makes them cheap',
      n_bin: 'the PC, the registers and every memory word are 16-bit numbers',
      r_pull: 'the same logic in relays, what the Z3 was built from',
      v_inv: 'the same logic in vacuum tubes, what ENIAC was built from',
      h_card: 'how the program got into a machine before there was a ROM',
    },
    pitfalls: [
      'RV16 counts in words: the next instruction is at pc + 1, where RISC-V\'s is pc + 4.',
      'x0 is not a register: it always reads 0 and a write to it is dropped.',
    ],
  },
  t_nor: { // optional and in no block: RV16 has no NOR cell
    pitfalls: [
      'NMOS in series is the NAND again: the 01 and 10 rows give 1 instead of 0.',
      'Each PMOS passes a good 1 only from VDD\'s side: one placed between y and GND pulls y to a weak L.',
    ],
  },
  t_inv: {
    uses: ['all'],
    usedFor: {
      t_nand: 'the same rule with two inputs: NMOS in series, PMOS in parallel',
      t_nor: 'the dual: PMOS in series, NMOS in parallel',
    },
    pitfalls: [
      'PMOS between VDD and y, NMOS between y and GND: swapped, each passes only a weak level (an NMOS passes a poor 1).',
      'Both gates on a: a gate left open reads X and so does y.',
    ],
  },
  t_nand: {
    uses: ['all'],
    usedFor: { g_not: 'from here the only brick: a NOT is one with its inputs tied' },
    pitfalls: [
      'NMOS in series, PMOS in parallel: the other way round is a NOR.',
      'With the PMOS in series too, a = 1, b = 0 leaves y floating (Z): no network conducts.',
    ],
  },

  // ---- Act P: optional, beside act 0; no block of RV16 is built from relays, tubes or cards, so no `uses` ---------
  r_pull: {
    usedFor: { r_nand: 'every relay level counts time in its 8.2 ms steps' },
    pitfalls: [
      'Pull-in and drop-out differ: the relay pulled in at 15.2 V stays in down to 3.6 V.',
      'First touch is not rest: the contact bounces 3 times before it settles.',
    ],
  },
  r_nand: {
    usedFor: {
      r_xor: 'the same relays, both contacts of the changeover used: a multiplexer',
      r_latch: 'a make contact feeding its own coil instead of an output',
    },
    pitfalls: [
      'Break contacts in parallel from the supply: in series they make a NOR, y lost when either coil pulls.',
      'y that nothing drives reads Z: end it on a load, the next coil drawn as its resistance.',
    ],
  },
  r_xor: {
    usedFor: { r_adder: 'its two lines chosen by b, then one by a: the sum bit; the carry runs the same way' },
    pitfalls: [
      'b\'s contacts go to a\'s lines crossed over: wired straight they give XNOR.',
      'VDD on relay a\'s common, not on b\'s: then exactly one of a\'s lines carries the supply.',
    ],
  },
  r_adder: {
    pitfalls: [
      'A contact cannot invert: the carry needs its own ¬c line, and carry in 0 means c open and ¬c on VDD.',
      'Every sum line and the carry out end on a load, or they read Z wherever no contact drives them.',
    ],
  },
  r_latch: {
    usedFor: { r_clock: 'a relay switching its own coil again, through a break contact: it cannot rest' },
    pitfalls: [
      'The holding line comes through the reset relay\'s break contact: through a make contact k never holds.',
      'k\'s make contact connects q to the holding line, not to VDD: wired to VDD, reset can never let go.',
    ],
  },
  r_clock: {
    usedFor: { h_loader: 'a counter bit on a beat: the loader\'s address counter does the same at eight bits' },
    pitfalls: [
      'One line from t to its own coil makes t follow k: halving needs two, chosen by a pole of k.',
      'en goes on the common of k\'s break contact: wired straight to k\'s coil, k pulls in and stays in.',
    ],
  },
  v_inv: {
    usedFor: { v_ff: 'two of these, each grid reading the other\'s plate through the same divider' },
    pitfalls: [
      'A plate wired straight to the next grid holds it at 81 V or more: the second tube conducts whatever the first says.',
      'The bias resistor goes to −150 V, not to GND: only then does the divider take the grid below −12.5 V.',
    ],
  },
  v_ff: {
    pitfalls: [
      'set turns on the tube whose plate is nq, so q rises.',
      'A wire from set to its grid also holds that grid at 0 V while set is 0: steer it through a diode.',
    ],
  },
  h_card: {
    usedFor: { h_loader: 'its deck: one object card per 16-bit instruction' },
    pitfalls: [
      'Rows run 12, 11, 0, 1–9 from the top: 0 is a zone for S–Z and a digit on its own.',
      'On an object card column 1 holds the word\'s most significant bit, not bit 0.',
    ],
  },
  h_loader: {
    pitfalls: [
      'run must not rise while clk is high: the CPU would see half a pulse. Take empty into a flip-flop clocked on the falling edge.',
      'The RAM\'s address is the counter while loading and pc after: without the mux the CPU fetches from the counter.',
      'ready is the write enable and the counter\'s enable: the word and the next address move at the same edge.',
    ],
  },

  // ---- Act 1 ----------------------------------------------------------------------------------
  l_bool: {
    uses: ['ctl'],
    usedFor: {
      g_or: 'De Morgan: a + b = ¬(¬a · ¬b), an OR from one NAND and two NOTs',
      g_mux: 'y = s·b + ¬s·a is a sum of products: NAND–NAND makes it 4 NANDs',
      d_kmap: 'a K-map is x·y + x·¬y = x drawn: neighbouring cells merge',
    },
    pitfalls: [
      'De Morgan flips the operator and complements each term: ¬(a·b) = ¬a + ¬b, not ¬a·¬b.',
      'a + a·b absorbs to a, and a + ¬a·b to a + b: forgetting either leaves a gate too many.',
    ],
  },
  g_not: {
    uses: ['all'],
    usedFor: {
      g_and: 'AND is a NAND followed by this NOT',
      g_or: 'OR is this NOT on both inputs, then a NAND',
      g_mux: 'the select\'s complement ¬s',
      s_sr: 'the same two-NAND budget, each output fed back to the other\'s input instead of tied',
    },
    pitfalls: ['An open second input reads X, not 1: tie both inputs to a (or one to a constant 1).'],
  },
  g_and: {
    uses: ['rf', 'ctl', 'npc', 'alu'],
    usedFor: {
      g_xor: 'its products, with the NOT dropped: two NAND products into one NAND',
      g_sop: 'each product term (NAND–NAND then removes the NOTs)',
      g_wide: 'the and3 … and8 it unlocks are balanced trees of it',
      a_shift16: 'two ANDs gate the fill bit: the sign only for an arithmetic right shift',
    },
    pitfalls: ['The NOT goes after the NAND, not before it: ¬a NAND ¬b is a + b.'],
  },
  g_or: {
    uses: ['ctl', 'npc', 'alu'],
    usedFor: {
      g_xor: 'one textbook XOR is (a + b) · ¬(a·b), 6 NANDs; par is 4',
      g_sop: 'the sum of the products: an OR of ANDs is NAND–NAND once the inversions cancel',
      g_wide: 'fifteen of them in a balanced tree: the 16-input zero detect',
      pi_reg: 'one OR loads the register on en or clr (a flush loads the zeros)',
    },
    pitfalls: ['Invert the inputs, not the output: a NOT after a NAND makes AND.'],
  },
  g_xor: {
    uses: ['br', 'alu'],
    usedFor: {
      g_eq16: 'sixteen of them: a bit that differs reads 1, then a zero detect',
      a_ha: 'the sum bit; its first NAND ¬(a·b) also gives the carry',
    },
    pitfalls: [
      'XOR is not OR: a = b = 1 gives 0.',
      'Build ¬(a·b) once and feed it to both halves: two copies make 5 NANDs and miss par.',
    ],
  },
  g_mux: {
    uses: ['all'],
    usedFor: {
      g_mux8: 'sixteen of it sharing one select and one ¬s',
      s_reg4: 'the enable: a mux feeds each flip-flop d or its own q',
      c_br: 'picks equality or less-than by the condition\'s bit 1',
    },
    pitfalls: [
      's = 1 selects b; swapping a and b passes only half the table.',
      'The AND–OR form with its own NOT is 8 NANDs, depth 5: par folds it into NAND–NAND, 4 NANDs, depth 3.',
    ],
  },
  d_kmap: {
    uses: ['ctl'],
    usedFor: {
      g_sop: 'map the prime function and read off a minimal sum',
      s_fsm: 'the next-state and output logic, from their tables',
      c_ctl: 'each of its 14 output bits is a function of opcode and f3, minimised with don\'t-cares',
    },
    pitfalls: [
      'Rows and columns run in Gray order (00, 01, 11, 10): cells next to each other in binary order are not neighbours.',
      'Groups are 1, 2, 4 or 8 cells and wrap around the edges: a group of 3 is two groups.',
    ],
  },
  g_sop: {
    uses: ['ctl'],
    usedFor: { c_ctl: 'the same method for each of its outputs: table, minimal sum, NAND–NAND, then what the sums share' },
    pitfalls: [
      '1 is not prime: a = 1 must give 0.',
      'A 4-input OR of products is not one cell here: its NAND costs 3 NANDs (two ANDs and a NAND).',
      'The minimal sum of products is 20 NANDs; par 8 comes from factoring, not from a better grouping.',
    ],
  },
  g_wide: {
    uses: ['alu', 'br'],
    usedFor: {
      g_dec: 'each output is a 4-input AND, best built from shared pairs',
      g_eq16: 'the 16-input zero detect after the XORs: 46 of its 110 NANDs',
      a_alu16: 'a 16-bit zero detect on the result sets the zero output',
    },
    pitfalls: [
      'A chain of fifteen ORs has the right count but depth 31: pair, then pair the pairs (depth 9).',
      'zero = ¬any: one NOT at the end, not sixteen at the inputs.',
    ],
  },
  g_dec: {
    uses: ['rf', 'ctl', 'csr'],
    usedFor: {
      m_rf: 'turns rd into the eight write enables, with rwe as en',
      m_ram: 'a 2→4 version picks the word to write',
      c_ctl: 'a 4→16 decoder on the opcode is its first stage',
      y_csr: 'a 3→8 decoder picks the CSR to write',
    },
    pitfalls: [
      'Forgetting en fails every en = 0 row: all outputs must be 0 then.',
      'a0 is the least significant bit: output 1 is a = 001, not 100.',
    ],
  },
  g_mux8: {
    uses: ['rf', 'alu', 'npc', 'wb', 'pc'],
    usedFor: {
      a_shift16: 'six of them: four shift levels and a bit reversal on each side',
      s_pc: 'two: pc + 1 or a loaded target, then 0 on reset',
      m_rf: 'trees of it are the two 8:1 read ports, 343 NANDs each',
      m_ram: 'a 4:1 tree reads the selected word',
      c_imm: 'not inside it (it is wiring only): the core\'s 4:1 bus mux picks one of its four immediates',
      c_npc: 'chooses the target: pc + imm or rs1 + imm',
      pi_reg: 'puts 0 in front of the flip-flops on clr: a bubble',
      y_csr: 'selects the CSR that is read',
    },
    pitfalls: [
      'One ¬s for all sixteen bits: an inverter per bit costs 15 NANDs over par.',
      'Keep each bit on its own mux: two bits crossed at a splitter pass most rows and fail the rest.',
    ],
  },
  g_eq16: {
    uses: ['br', 'fwd', 'haz'],
    usedFor: {
      c_br: 'beq / bne: 110 of the comparator\'s 287 NANDs',
      pi_fwd: '3-bit versions compare each source register with rd in M and W',
      pi_haz: 'a 3-bit version compares a load\'s rd with the next instruction\'s sources',
    },
    pitfalls: [
      'eq is 1 when no bit differs: XOR, then zero detect; an OR of the XORs is ≠.',
      'XNORs into a 16-input AND cost the same 110 NANDs; XNORs into an OR do not test equality.',
    ],
  },

  n_bin: { // act 1 since the reorder: the decoder and the prime detector read numbers
    uses: ['alu'],
    usedFor: {
      g_sop: 'its input is a 4-bit number: the table is 0 to 15, the primes 2, 3, 5, 7, 11, 13',
      g_dec: 'the 3-bit address is a number: output k lights for a = k',
      n_twos: 'the same bit patterns, with bit 15 weighing −2^15',
      a_ha: 'one column of binary addition: 1 + 1 = 10',
    },
    pitfalls: [
      'Group bits in fours from bit 0, not from the left: 1 1111 is 0x1F, not 0xF1.',
      'Bit k weighs 2^k counting from 0: the top bit of a 16-bit word is bit 15 (32 768).',
    ],
  },
  // ---- Act 2 ----------------------------------------------------------------------------------
  n_twos: {
    uses: ['alu', 'br'],
    usedFor: {
      a_addsub16: 'a − b = a + ¬b + 1: subtraction on the same adder',
      a_shift16: 'sra fills with the sign bit, so a negative number stays negative',
      i_isa: 'immediates are two\'s complement, sign-extended to 16 bits',
      n_float: 'floats use a sign bit and a biased exponent instead',
    },
    pitfalls: [
      '−x is ¬x + 1, not ¬x (that is one\'s complement).',
      '0x8000 (−32 768) has no positive twin: negating it gives 0x8000 again.',
      'Overflow is about signs, not the carry out: 0xFFFF + 1 carries out and is right as −1 + 1 = 0.',
    ],
  },
  a_ha: {
    uses: ['plus1', 'npc'],
    usedFor: {
      a_fa: 'two of them and an OR are the textbook full adder (13 NANDs; par 9)',
      a_inc16: 'fifteen of them and a NOT add 1',
    },
    pitfalls: ['The carry is a·b, not a + b. Invert the XOR\'s first NAND for it instead of building an AND (6 NANDs, par 5).'],
  },
  a_fa: {
    uses: ['alu', 'npc', 'br'],
    usedFor: { a_add4: 'four in a row, carry out into the next carry in' },
    pitfalls: [
      'cout is the majority of a, b and cin: (a ⊕ b)·cin alone misses a = b = 1.',
      'Par shares both XORs\' first NANDs with the carry: a separate majority circuit is 13 or more.',
    ],
  },
  a_add4: {
    uses: ['alu', 'npc', 'br'],
    usedFor: { a_add16: 'four of them, carries chained' },
    pitfalls: [
      'Watch the splitter\'s bit order: bit 0 is the one that gets cin.',
      'An open cin reads X, not 0: every sum it reaches is X.',
    ],
  },
  a_add16: {
    uses: ['alu', 'npc', 'br'],
    usedFor: {
      a_addsub16: 'wraps one in XORs: b ⊕ sub, with sub on cin',
      c_npc: 'holds two: pc + imm and rs1 + imm',
      o_fastadd: 'the ripple chain it replaces: depth 36 against 14',
      o_mulseq: 'adds the multiplicand, ANDed with the multiplier\'s bit, at every step',
      o_mularr: 'the same ripple adders, 8 bits wide, sum its partial products',
    },
    pitfalls: [
      'Watch the splitter\'s bit order: the low nibble\'s adder takes cin and feeds the next one up.',
      'An open cin reads X, not 0.',
    ],
  },
  a_inc16: {
    uses: ['plus1', 'npc'],
    usedFor: {
      s_pc: 'pc + 1, every cycle, inside the PC\'s loop',
      c_npc: 'pc + 1: the next PC, and the link value of jal / jalr',
    },
    pitfalls: [
      'Bit 0 is ¬a0 and needs no half adder: sixteen of them cost 4 NANDs over par.',
      'cout comes out of bit 15\'s half adder: left open, the 0xFFFF row fails.',
    ],
  },
  a_addsub16: {
    uses: ['alu'],
    usedFor: {
      a_slt: 'the same a + ¬b + 1 with NOTs in place of the XORs: only its carry is read',
      a_alu16: 'add and sub; slt and sltu read its flags (N ⊕ V, ¬cout)',
      o_div: 'subtracts the divisor at every step',
    },
    pitfalls: [
      'sub must also feed cin: ¬b alone gives a − b − 1.',
      'v is the carry into bit 15 ⊕ the carry out, not the carry out (that is unsigned).',
    ],
  },
  a_slt: {
    uses: ['br'],
    usedFor: {
      c_br: 'blt / bge: 169 of the comparator\'s 287 NANDs',
    },
    pitfalls: [
      'ltu is ¬cout, not cout: a + ¬b + 1 carries out when a ≥ b.',
      'The sign of the difference alone fails 0x7FFF vs 0x8000: the subtraction overflows.',
    ],
  },
  a_shift16: {
    uses: ['alu'],
    usedFor: {
      a_alu16: 'sll, srl and sra: 299 of its 1 055 NANDs',
      o_fpsticky: 'a right shifter again, ORing the bits that fall off into a sticky bit',
    },
    pitfalls: [
      'Shift by sh mod 16: level k shifts by 2^k when bit k is 1.',
      'Never apply the arithmetic fill to a left shift: it fills with 0 from the right.',
      'A left shift reverses the word before the right shifter and again after it: one reversal mirrors the result.',
    ],
  },
  a_alu16: {
    uses: ['alu'],
    usedFor: {
      c_lesson: 'the datapath puts it in the execute stage, b from rs2 or the immediate',
      c_core1: 'executes every arithmetic instruction, register and immediate forms',
    },
    pitfalls: [
      'Decode {OPX, f3}, not f3 alone: ctl 8 is sub, 13 is sra.',
      'Shift by b mod 16, b\'s low four bits; the upper twelve are ignored.',
      'zero is about the result y, not about b.',
    ],
  },
  o_fastadd: {
    uses: ['alu'],
    usedFor: { c_fast: 'its Kogge–Stone ALU takes the core\'s period from 98 to 76' },
    pitfalls: [
      'The combine (g, p) ∘ (g′, p′) = (g + p·g′, p·p′) is not commutative: the higher group goes on the left.',
      'cin enters as a generate below bit 0: dropping it passes every cin = 0 case.',
    ],
  },
};
