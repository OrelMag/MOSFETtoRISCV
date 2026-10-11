// Authored walkthroughs, acts 0–3 (the main path). See walks.ts for the conventions.

import type { WalkScript } from './walk';

export const WALKS1: Record<string, WalkScript> = {
  t_inv: [
    {
      title: 'The rails',
      text: 'VDD is logic 1 and GND logic 0. A static CMOS gate connects its output to exactly one of them for every input: PMOS transistors pull up to VDD, NMOS transistors pull down to GND.',
      parts: ['vdd', 'gnd'], codex: ['cmos'],
    },
    {
      title: 'PMOS pull-up',
      text: 'p1 runs from VDD to y with its gate on a. It conducts when a = 0 and passes a strong 1, so the a = 0 row is right. For a = 1 nothing drives y yet: it floats (Z) and the row fails.',
      parts: ['p1'], codex: ['mosfet'],
    },
    {
      title: 'NMOS pull-down',
      text: 'n1 runs from y to GND with its gate on a. It conducts when a = 1 and passes a strong 0. Exactly one transistor conducts for each a, so y is always driven and no current flows from VDD to GND at rest. Two transistors, half the cost of NAND(a, a).',
      parts: ['n1'], codex: ['inverter'],
    },
  ],
  t_nand: [
    {
      title: 'First PMOS',
      text: 'p1 runs from VDD to y with its gate on a: y = 1 whenever a = 0. The two rows with a = 1 still float.',
      parts: ['vdd', 'p1'], codex: ['mosfet'],
    },
    {
      title: 'Second PMOS, in parallel',
      text: 'p2 sits beside p1 with its gate on b. The pull-up now conducts when a = 0 or b = 0, which is ¬a + ¬b = ¬(a·b) by De Morgan. Only the a = b = 1 row still floats.',
      parts: ['p2'], codex: ['demorgan'],
    },
    {
      title: 'First NMOS',
      text: 'n1 runs from y down to an internal node, gate on a. It does not reach GND yet, so a = b = 1 still leaves y floating.',
      parts: ['n1'],
    },
    {
      title: 'Second NMOS, in series',
      text: 'n2 joins the internal node to GND, gate on b. The pull-down conducts only when a = b = 1, exactly when the pull-up is off: series in one network, parallel in its dual. Four transistors. The series pair is NMOS, the faster type; a NOR puts it in the PMOS network, 2 to 3 times weaker per width, which is why CMOS libraries build on the NAND.',
      parts: ['n2', 'gnd'], codex: ['cmos', 'duality', 'nand'],
    },
  ],
  g_sop: [
    {
      title: 'Minimize, then complement',
      text: 'The K-map of the primes 2, 3, 5, 7, 11, 13 has four essential prime implicants: y = ¬a3¬a2a1 + ¬a3a2a0 + ¬a2a1a0 + a2¬a1a0, each covering two minterms. a0 only appears true, so three inverters suffice: u1 = ¬a3, u2 = ¬a2, u3 = ¬a1.',
      parts: ['u0', 'u1', 'u2', 'u3'], codex: ['kmap', 'sop'],
    },
    {
      title: 'Pairs of literals',
      text: 'With 2-input gates a 3-literal product is an AND of two literals, then a NAND with the third. u4 = ¬a3·¬a2, u5 = ¬a3·a2, u6 = ¬a2·a1, u7 = a2·¬a1: no pair is shared between terms, so all four are needed.',
      parts: ['u4', 'u5', 'u6', 'u7'],
    },
    {
      title: 'The inverted products',
      text: 'u8 to u11 NAND each pair with its third literal (a1, a0, a0, a0). Each is 0 exactly on the minterms of its term: the first level of NAND–NAND logic produces the products already inverted.',
      parts: ['u8', 'u9', 'u10', 'u11'], codex: ['nandnand'],
    },
    {
      title: 'One wide NAND',
      text: 'y = ¬(t1·t2·t3·t4) is the OR of the four terms. Without a 4-input NAND it is two ANDs (u12, u13) and a NAND (u14). 20 NANDs, depth 7 (1 + 2 + 1 + 2 + 1): par.',
      parts: ['u12', 'u13', 'u14'], codex: ['universality'],
    },
  ],
  g_wide: [
    {
      title: 'Eight ORs on bit pairs',
      text: 'u1 to u8 OR the bits in pairs (a0, a1), (a2, a3) and so on. Each OR is a NAND of its two inverted inputs: 3 NANDs, depth 2.',
      parts: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'], codex: ['or'],
    },
    {
      title: 'Pairs of pairs',
      text: 'u9 to u12 OR the first level\'s outputs in pairs: four signals, each the OR of four bits. Every level halves the count and adds 2 to the depth.',
      parts: ['u9', 'u10', 'u11', 'u12'],
    },
    {
      title: 'The top of the tree',
      text: 'u13 and u14 cover eight bits each, u15 all sixteen: any is done at depth 8, four levels of ORs. A chain of the same 15 ORs costs the same 45 NANDs but is 30 deep.',
      parts: ['u13', 'u14', 'u15'], codex: ['depth'],
    },
    {
      title: 'Zero is not any',
      text: 'u16 = ¬any drives zero: one more NAND and one more level. 46 NANDs, depth 9: par.',
      parts: ['u16'], codex: ['not'],
    },
  ],
  g_dec: [
    {
      title: 'Shared complements',
      text: 'u1, u2 and u3 make ¬a0, ¬a1 and ¬a2 once. All eight outputs draw on them, so three NANDs serve the whole decoder.',
      parts: ['u0', 'u1', 'u2', 'u3'], codex: ['decoder'],
    },
    {
      title: 'Output 0',
      text: 'u4 = ¬a0·¬a1·¬a2·en: the minterm of address 0, with en as a fourth input. A 4-input AND is three 2-input ANDs in a tree: 6 NANDs, depth 4.',
      parts: ['u4'], codex: ['and'],
    },
    {
      title: 'Outputs 1 to 3',
      text: 'Output k takes a_i where bit i of k is 1 and ¬a_i where it is 0: u5 = a0·¬a1·¬a2·en, u6 = ¬a0·a1·¬a2·en, u7 = a0·a1·¬a2·en. Any two outputs differ in at least one literal, so at most one is 1.',
      parts: ['u5', 'u6', 'u7'],
    },
    {
      title: 'Outputs 4 to 7',
      text: 'u8 to u11 repeat the pattern with a2 true, and the merger gathers the eight lines into y. 8 × 6 + 3 = 51 NANDs, depth 5 (an inverter, then the AND tree): par.',
      parts: ['u8', 'u9', 'u10', 'u11', 'u12'], codex: ['bus'],
    },
  ],
  g_mux8: [
    {
      title: 'One inverter on s',
      text: 'The splitters cut a and b into bits for free. inv = ¬s, once for all sixteen bits: your 1-bit mux inverts s for itself, and sixteen copies of it would spend 16 NANDs on the same signal.',
      parts: ['sa', 'sb', 'inv'], codex: ['mux', 'bus'],
    },
    {
      title: 'Bits 0 to 3',
      text: 'Per bit, ta = ¬(a[k]·¬s), tb = ¬(b[k]·s) and y = ¬(ta·tb) = a[k]·¬s + b[k]·s: your 2:1 mux without its inverter, 3 NANDs. Depth 3 from s (through inv), 2 from the data.',
      parts: ['ta0', 'tb0', 'y0', 'ta1', 'tb1', 'y1', 'ta2', 'tb2', 'y2', 'ta3', 'tb3', 'y3'],
    },
    {
      title: 'One select for every bit',
      text: 's and ¬s fan out to every bit, so all bits switch together: y is either all of a or all of b, never a mix. Operations on buses are one gate per bit sharing their control.',
      parts: ['ta4', 'tb4', 'y4', 'ta5', 'tb5', 'y5', 'ta6', 'tb6', 'y6', 'ta7', 'tb7', 'y7'], codex: ['fanin'],
    },
    {
      title: 'Bits 8 to 11',
      text: 'inv now drives sixteen gates. Real cells pay for that fan-out with delay (or a buffer), which the unit-delay model here ignores.',
      parts: ['ta8', 'tb8', 'y8', 'ta9', 'tb9', 'y9', 'ta10', 'tb10', 'y10', 'ta11', 'tb11', 'y11'],
    },
    {
      title: 'Merge the result',
      text: 'Bits 12 to 15 complete the row and the merger joins the sixteen outputs into y. 3 × 16 + 1 = 49 NANDs, depth 3: par. Sixteen copies of your 2:1 mux (the library\'s mux2x16) cost 64 at the same depth.',
      parts: ['ta12', 'tb12', 'y12', 'ta13', 'tb13', 'y13', 'ta14', 'tb14', 'y14', 'ta15', 'tb15', 'y15', 'my'],
    },
  ],
  g_eq16: [
    {
      title: 'Does bit 0 differ?',
      text: 'u2 = a[0] ⊕ b[0] is 1 when the bits differ. a = b exactly when every bit\'s XOR is 0.',
      parts: ['u0', 'u1', 'u2'], codex: ['xor', 'comparator'],
    },
    {
      title: 'The other fifteen bits',
      text: 'u3 to u17 compare bits 1 to 15. All sixteen XORs work in parallel: 64 NANDs, depth 3.',
      parts: ['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17'],
    },
    {
      title: 'Zero detect',
      text: 'The merger bundles the sixteen differences and your zero detect (u19) reports whether they are all 0: a balanced OR tree and an inverter, 46 NANDs, depth 9. Its any output stays unused. 110 NANDs, depth 3 + 9 = 12: par.',
      parts: ['u18', 'u19'], codex: ['depth'],
    },
  ],
  a_add4: [
    {
      title: 'Bit 0',
      text: 'fa0 adds a[0], b[0] and cin: s[0] and a carry into bit 1. From a[0] to its carry out is 5 NAND delays, from cin only 2 (g5, then g9).',
      parts: ['sa', 'sb', 'fa0'], codex: ['fulladder'],
    },
    {
      title: 'Bit 1',
      text: 'fa1 adds a[1], b[1] and fa0\'s carry. Its own a and b arrive at once, so the carry from bit 0 is what it waits for: 2 more delays on the carry.',
      parts: ['fa1'], codex: ['ripple'],
    },
    {
      title: 'Bit 2',
      text: 'fa2 continues the chain: the carry into bit 3 settles at depth 5 + 2 + 2 = 9.',
      parts: ['fa2'],
    },
    {
      title: 'Bit 3 and cout',
      text: 'fa3 makes s[3] (3 delays after its carry in: depth 12) and cout (depth 11); the merger gathers s. 36 NANDs, depth 12: par. Each extra bit adds 2 to the depth, so 16 bits take 36.',
      parts: ['fa3', 'ms'], codex: ['criticalpath'],
    },
  ],
  a_add16: [
    {
      title: 'The low nibble',
      text: 'The splitters cut a and b into 4-bit fields for free. u2, your 4-bit adder, adds bits 3 to 0 with cin. Its carry out settles at depth 11.',
      parts: ['u0', 'u1', 'u2'], codex: ['ripple'],
    },
    {
      title: 'Chain the next nibble',
      text: 'u3 adds bits 7 to 4 with u2\'s carry. Inside a 4-bit adder the carry crosses four full adders at 2 delays each, so every nibble adds 8 to the carry\'s depth.',
      parts: ['u3'],
    },
    {
      title: 'Bits 11 to 8',
      text: 'u4 continues the chain: the carry into bit 12 settles at depth 27.',
      parts: ['u4'],
    },
    {
      title: 'The top nibble',
      text: 'u5 adds bits 15 to 12; the merger gathers s. 144 NANDs, the cost of sixteen full adders. Depth 36 on s[15], 35 on cout: hierarchy changes the drawing, not the carry chain.',
      parts: ['u5', 'u6'], codex: ['criticalpath'],
    },
  ],
  a_inc16: [
    {
      title: 'Bit 0: a NOT and a wire',
      text: 'With b = 0 and cin = 1, bit k of a + 1 is a half adder of a[k] and the carry in. For bit 0 the carry in is the constant 1: the sum is ¬a0 and the carry out is a0 itself. n0 = ¬a0 costs 1 NAND, where a half adder on a constant 1 costs 5.',
      parts: ['sa', 'n0'], codex: ['incrementer'],
    },
    {
      title: 'Bit 1',
      text: 'ha1 adds a[1] and a0, taken straight from the splitter. Its carry a0·a1 is the AND that ends a half adder: the carry into bit k is a0·…·a(k−1).',
      parts: ['ha1'], codex: ['halfadder'],
    },
    {
      title: 'The carry chain',
      text: 'ha2 to ha14 repeat it. Each carry costs 2 NAND delays (NAND, then NOT) from depth 0 at a0, so the carry into bit 15 settles at depth 28.',
      parts: ['ha2', 'ha3', 'ha4', 'ha5', 'ha6', 'ha7', 'ha8', 'ha9', 'ha10', 'ha11', 'ha12', 'ha13', 'ha14'], codex: ['ripple'],
    },
    {
      title: 'Bit 15 and cout',
      text: 'ha15 makes y[15] (depth 31) and cout (30), 1 only for a = 0xFFFF; the merger gathers y. 1 + 15 × 5 = 76 NANDs, depth 31: par, about half a 144-NAND adder. The library\'s inc16 keeps a half adder on the constant 1 for bit 0: 80 NANDs, depth 33.',
      parts: ['ha15', 'my'],
    },
  ],
  a_addsub16: [
    {
      title: 'Invert b on demand',
      text: 'x_k = b[k] ⊕ sub: b passes unchanged when sub = 0 and is inverted when sub = 1. An XOR is a controlled inverter; sixteen cost 64 NANDs.',
      parts: ['sb', 'x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15'], codex: ['xor', 'subtract'],
    },
    {
      title: 'sub is the carry in',
      text: 'fa0 adds a[0], b[0] ⊕ sub and cin = sub. With sub = 1 the adder computes a + ¬b + 1 = a − b in two\'s complement, and the + 1 costs no gate.',
      parts: ['sa', 'fa0'], codex: ['twos'],
    },
    {
      title: 'The carry chain',
      text: 'fa1 to fa14 ripple the carry upwards. The XORs on b add 3 delays before the first full adder; after that each bit adds 2.',
      parts: ['fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7', 'fa8', 'fa9', 'fa10', 'fa11', 'fa12', 'fa13', 'fa14'], codex: ['ripple'],
    },
    {
      title: 'Top bit and cout',
      text: 'fa15 makes s[15] (depth 39) and cout (depth 38); the merger gathers s. In a subtraction cout = 1 means no borrow: a ≥ b as unsigned numbers.',
      parts: ['fa15', 'ms'],
    },
    {
      title: 'Signed overflow',
      text: 'vx = c15 ⊕ c16, the carry into the sign bit against the carry out of it. They differ exactly when both addends have the same sign and the sum has the other. 212 NANDs, depth 41 on v: par.',
      parts: ['vx'], codex: ['overflow'],
    },
  ],
  a_slt: [
    {
      title: 'Invert b',
      text: 'Both answers come from a − b = a + ¬b + 1, and here b is always inverted. u2 to u17 are sixteen NOTs: 16 NANDs, where your subtractor\'s XORs, which invert only on demand, cost 64. The splitter and the merger are free.',
      parts: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18'], codex: ['subtract', 'not'],
    },
    {
      title: 'Add, keep the carry',
      text: 'u19, your 16-bit adder, computes a + ¬b + 1 with its carry in tied to 1 (u0). Only cout is read: the 48 NANDs that form the sixteen sum bits compute values nobody uses. A carry-only chain drawn from NANDs would drop them; the adder part cannot.',
      parts: ['u0', 'u19'], codex: ['twos'],
    },
    {
      title: 'Unsigned: no carry',
      text: 'ltu = ¬cout (u22): a + ¬b + 1 carries out of bit 15 exactly when a ≥ b as unsigned numbers. cout settles at depth 36 (a NOT, then the 35-deep carry chain), ltu at 37.',
      parts: ['u22'], codex: ['flags'],
    },
    {
      title: 'Do the signs differ?',
      text: 'The [15, 1] splitters take the sign bits and u23 = a15 ⊕ b15. When the signs agree, a and b lie in the same half of the range, a − b cannot overflow, and signed order is unsigned order: lt = ltu.',
      parts: ['u20', 'u21', 'u23'], codex: ['overflow'],
    },
    {
      title: 'Choose',
      text: 'When the signs differ the negative one is smaller: lt = a15. lt = differ ? a15 : ltu is a 2:1 mux drawn as 4 NANDs (u24 to u27; the mux part is not unlocked here). 169 NANDs, depth 39: par. The textbook N ⊕ V needs the sum\'s sign and the overflow flag, so your whole subtractor: 217 NANDs, depth 44.',
      parts: ['u24', 'u25', 'u26', 'u27'], codex: ['mux'],
    },
  ],
  a_shift16: [
    {
      title: 'Reverse for left shifts',
      text: 'A left shift is a right shift of the bit-reversed word, reversed back. rin reverses a (wiring, 0 NANDs) and mr selects it when left = 1. One right-shift datapath then serves sll, srl and sra, for two 64-NAND muxes instead of a second 256-NAND shifter.',
      parts: ['rin', 'mr'], codex: ['shifter'],
    },
    {
      title: 'The fill bit',
      text: 'Bits entering at the top are f2 = a[15]·arith·¬left: the sign for sra, 0 for srl, and 0 for sll even when arith = 1. f2 settles at depth 4 and starts the critical path.',
      parts: ['sa', 'nl', 'f1', 'f2'],
    },
    {
      title: 'Shift by 1, then by 2',
      text: 'Level k shifts by 2^k when sh[k] = 1. w0 and w1 are wiring (bits moved down, f2 entering at the top); m0 and m1 choose shifted or not. Each level costs 64 NANDs and 2 delays on the data.',
      parts: ['ss', 'w0', 'm0', 'w1', 'm1'],
    },
    {
      title: 'Shift by 4, then by 8',
      text: 'w2, m2, w3 and m3 complete the four levels, which compose any shift from 0 to 15. log2 16 levels of 16 muxes is 64 muxes; a 16:1 selector per output bit would need 240.',
      parts: ['w2', 'm2', 'w3', 'm3'], codex: ['depth'],
    },
    {
      title: 'Reverse back',
      text: 'rout reverses the result again and mo selects it when left = 1. 6 × 49 + 5 = 299 NANDs. Depth 14: a[15] through f1 and f2 (4), then five mux data inputs at 2 each. Par.',
      parts: ['rout', 'mo'],
    },
  ],
  a_alu16: [
    {
      title: 'The bitwise units',
      text: 'xor, or and and compute a ⊕ b, a + b and a·b on every bit: 64 + 48 + 32 NANDs, depth 3 at most. Every unit computes all the time; the multiplexer chooses later.',
      parts: ['xor', 'or', 'and'], codex: ['alu'],
    },
    {
      title: 'Decode the control',
      text: 'ctl = {OPX, f3}. The adder must subtract for sub, slt and sltu: sub = ctl[3] + f1·¬f2 (f3 = 2 or 3). It also subtracts for sra, whose adder output nobody selects. ¬f2 doubles as the shifter\'s left input: f3 = 1 is sll, f3 = 5 srl or sra.',
      parts: ['sc', 'sf', 'nf2', 'g_and', 'g_or'], codex: ['control'],
    },
    {
      title: 'The shared adder',
      text: 'add computes a + b or a − b. One 212-NAND unit serves add, sub, slt and sltu. Its control arrives at depth 5, so its slowest output, v, settles at 46.',
      parts: ['add'], codex: ['subtract'],
    },
    {
      title: 'Comparisons from the adder',
      text: 'The adder already subtracts for slt and sltu, so its flags answer both: slt = n ⊕ v, sltu = ¬cout. zslt and zsltu zero-extend each bit to 16 for free. 5 NANDs buy two instructions; your 169-NAND less-than unit pays for its own adder.',
      parts: ['slt', 'zslt', 'sltu', 'zsltu'], codex: ['flags'],
    },
    {
      title: 'The shifter',
      text: 'shift shifts a by b[3:0] (the split keeps the low four bits), left on ¬f2, arithmetic on ctl[3]. 299 NANDs, 40% more than the adder.',
      parts: ['sb', 'shift'], codex: ['shifter'],
    },
    {
      title: 'Select by f3',
      text: 'The 8:1 multiplexer picks a result by f3 alone: 0 add/sub, 1 and 5 the shifter, 2 slt, 3 sltu, 4 xor, 6 or, 7 and. OPX only modifies an operation, so it never reaches the mux. Seven 16-bit muxes, 343 NANDs: the biggest block.',
      parts: ['mux'], codex: ['mux'],
    },
    {
      title: 'The zero flag',
      text: 'zero detects y = 0: 46 NANDs, 9 delays. 1055 NANDs, depth 64: par. The critical path is ctl → sub (5) → adder → v (46) → slt (49) → mux (55) → zero (64).',
      parts: ['zero'], codex: ['criticalpath'],
    },
  ],
  s_dff: [
    {
      title: 'Invert the clock',
      text: 'inv = NAND(clk, clk) = ¬clk, the master\'s enable. The two latches must be open on opposite clock phases.',
      parts: ['inv'], codex: ['not'],
    },
    {
      title: 'Master, open while clk = 0',
      text: 'The master latch follows d while clk is low. At the rising edge it closes and holds the value d had just before.',
      parts: ['master'], codex: ['dlatch'],
    },
    {
      title: 'Slave, open while clk = 1',
      text: 'The slave copies the master while clk is high and holds while it is low, so q changes only just after a rising edge. 9 NANDs: par. The inverter closes the master one delay after the slave opens, so d must stay put just after the edge: a hold time.',
      parts: ['slave'], codex: ['dff', 'edge', 'setuphold'],
    },
  ],
  s_reg4: [
    {
      title: 'Bit 0 with enable',
      text: 'ff0 is your DFFE: a mux in front of a D flip-flop feeds q back while en = 0, so the flip-flop reloads its own value. The clock reaches every flip-flop untouched. 13 NANDs: 4 for the mux, 9 for the flip-flop.',
      parts: ['sd', 'ff0'], codex: ['clockgating'],
    },
    {
      title: 'Bits 1 and 2',
      text: 'ff1 and ff2 take their own data bits and share en and clk with ff0: all bits load or hold together on the same edge.',
      parts: ['ff1', 'ff2'], codex: ['register'],
    },
    {
      title: 'Bit 3',
      text: 'ff3 completes the word and the merger gathers q. 4 × 13 = 52 NANDs: par.',
      parts: ['ff3', 'mq'],
    },
  ],
  s_reg16: [
    {
      title: 'Bits 3 to 0',
      text: 'The splitter cuts d into four nibbles for free. u1 is your 4-bit register on the low nibble: four enable flip-flops sharing en and clk, 52 NANDs.',
      parts: ['u0', 'u1'], codex: ['register'],
    },
    {
      title: 'Bits 7 to 4',
      text: 'u2 takes the next nibble and the same en and clk, so every bit loads or holds on the same edge. The enable mux, not a gated clock, decides whether a bit reloads d or its own q.',
      parts: ['u2'], codex: ['clockgating'],
    },
    {
      title: 'Bits 11 to 8',
      text: 'u3: the bits share nothing but en and clk, so a register of registers is the same sixteen cells, wired by a splitter and a merger that cost nothing.',
      parts: ['u3'],
    },
    {
      title: 'Bits 15 to 12',
      text: 'u4 completes the word and the merger gathers q. 4 × 52 = 208 NANDs: par. The library\'s reg16 costs 240: its D latches have 5 NANDs (an inverter on d) where yours have 4. Period 8: clk-to-q (3), the enable mux on the q → d loop (2), setup (3).',
      parts: ['u4', 'u5'], codex: ['setuphold'],
    },
  ],
  s_pc: [
    {
      title: 'The register',
      text: 'u4 holds pc: sixteen of your flip-flops, 144 NANDs, with no enable. The PC loads at every edge and its next value is chosen in front of it, so enable muxes would always pick d: your 16-bit register would cost 64 NANDs more.',
      parts: ['u4'], codex: ['pc', 'register'],
    },
    {
      title: 'pc + 1',
      text: 'u1, your incrementer (76 NANDs, depth 31), computes pc + 1 from the register\'s output. It wraps from 0xFFFF to 0 by itself: its cout is left open.',
      parts: ['u1'], codex: ['incrementer'],
    },
    {
      title: 'Load a jump',
      text: 'u2, your bus multiplexer (49 NANDs), selects d instead of pc + 1 when ld = 1.',
      parts: ['u2'], codex: ['mux'],
    },
    {
      title: 'Reset wins',
      text: 'u3 selects the constant 0 when rst = 1. It is the mux nearest the register, so rst overrides ld. 144 + 76 + 2 × 49 = 318 NANDs: par. Period 41: clk-to-q (3), incrementer (31), two muxes (2 each on the data), setup (3).',
      parts: ['u0', 'u3'], codex: ['criticalpath'],
    },
  ],
  m_rf: [
    {
      title: 'Write select',
      text: 'u0, your decoder, turns wa into a one-hot word, enabled by we: at most one register sees en = 1. 51 NANDs.',
      parts: ['u0'], codex: ['decoder'],
    },
    {
      title: 'Register x1',
      text: 'u3, your 16-bit register (208 NANDs), loads wd with its enable on decoder output 1. The decoder drives enables, never the clock: every register sees the same clk.',
      parts: ['u2', 'u3'], codex: ['register', 'clockgating'],
    },
    {
      title: 'Registers x2 to x7',
      text: 'u4 to u9 take decoder outputs 2 to 7. Output 0 drives nothing: a write to x0 reaches no register, so it is ignored. The seven registers cost 1456 NANDs, 61% of the file.',
      parts: ['u4', 'u5', 'u6', 'u7', 'u8', 'u9'],
    },
    {
      title: 'Read port 1',
      text: 'u10, an 8:1 tree of seven of your 49-NAND bus muxes (343 NANDs, depth 7), selects x[ra1]; the library\'s tree of 64-NAND muxes would be 448. Input 0 is the constant 0: x0 always reads 0 and costs no register, which saves 208 NANDs.',
      parts: ['u1', 'u10'], codex: ['regfile', 'mux'],
    },
    {
      title: 'Read port 2',
      text: 'u11 is a second tree on the same eight words, selected by ra2. Reads are combinational and independent, so an instruction reads rs1 and rs2 in the same cycle. 2193 NANDs: par. Period 11: wa through the decoder (5) and an enable mux (3), plus setup (3).',
      parts: ['u11'],
    },
  ],
};
