// Level cases, acts 4–10 (the instruction set, the single-cycle core, the pipeline, the system, side
// quests, the lanes, memory): every build, core and program level, the optional ones included. The numbers are
// measured on the reference designs: NANDs and depth (sim/stats), clock periods by static timing (cores
// with the bench's 8-delay memories, corecheck corePeriod / lanecheck lanePeriod), cycles on the core
// bench's programs (coretests, lanetests), instructions on the puzzles' reference solutions and lane
// utilization on the lane golden model (riscv/rv16/simt16.ts). See cases.ts.

import type { LevelCase } from './cases';

export const CASES1: Record<string, LevelCase> = {
  // ---- Act 4: the instruction set and programs ------------------------------------------------
  i_isa: {
    problem: 'Hardware needs a specification before it can be built: which state exists (pc, x0–x7, 64 K words of data), what each instruction does to it, and how it is spelled in bits. RV16 is RISC-V cut to 16 bits: load / store (only <code>lw</code> and <code>sw</code> touch memory), fixed field positions (rs1, rs2 and rd never move, so the register file is read while the opcode is still being decoded) and x0 = 0 (a constant and a discard target, which makes <code>mv</code>, <code>nop</code>, <code>j</code> and <code>beqz</code> pseudo-instructions with no opcode of their own).',
    without: 'Act 5\'s blocks would have nothing to be checked against: the golden model every core bench compares with, register write by register write, is this specification run in software.',
    cost: '23 instructions in 16-bit words. The width sets the costs downstream: three-bit register fields mean eight registers, so the register file is 2 172 NANDs; immediates that never move make the immediate generator 0 NANDs; a 4-bit opcode makes the control unit\'s first stage a 4→16 decoder, 100 of its 200 NANDs. The price is paid in instructions: 6-bit offsets, no <code>andi</code>, no <code>bltu</code>, no bytes.',
  },
  i_enc: {
    problem: 'Decoding is reading a word\'s fields. op[3:0] names the format, and the format says which of the other fields are registers and which are pieces of an immediate. The register file and the immediate generator take their fields without asking, since they never move; only the control unit has to look at the opcode. Encoding is the assembler\'s half of the same table.',
    cost: 'Six right answers pass; ★★★ allows two mistakes. In hardware this decode is the Control unit level: 200 NANDs and 13 delays at par, of which the 4→16 opcode decoder is 100 NANDs and 5 delays.',
  },
  p_add: {
    problem: 'The smallest complete program: <code>lw a0, -4(x0)</code> twice reads two words from the input device, <code>add</code> sums them, <code>sw a0, -3(x0)</code> hands the sum to the output device, <code>halt</code> (<code>jal x0, 0</code>, a jump to itself) stops. The devices sit at the top of the address space (IN = 0xFFFC, OUT = 0xFFFD), so a device address is computed like any other: x0 plus the sign-extended offset, in the ALU. Loads, ALU operations, stores and a jump: every class the core must implement except conditional branches.',
    cost: 'Five words, five cycles on the single-cycle core, one per instruction. Nothing shorter exists: two inputs need two loads, then one add, one store and the halt.',
  },
  p_loop: {
    problem: 'A branch with a negative offset makes a loop: sum 1 … n by adding n, decrementing it and branching back while it is not zero, with the test at the top (<code>beqz a0, done</code>) so that n = 0 runs no iteration. Most of a processor\'s time is spent in loops like this one, which is why the branch closing them is the instruction the pipeline levels work hardest to make cheap.',
    without: 'Straight-line code only: summing to 300 means writing 300 adds.',
    cost: 'The reference spends 4 instructions per iteration (<code>beqz</code>, <code>add</code>, <code>addi</code>, <code>j</code>): 1 205 for n = 300, a mean of 330 over the tests. Testing at the bottom (one <code>beqz</code> before the loop, <code>bnez</code> at its end) needs 3. On Pipeline IV every taken branch or jump also flushes two instructions, so the <code>j</code> costs 3 cycles there.',
  },
  p_mem: {
    problem: 'Data beyond eight registers lives in memory, and only <code>lw</code> and <code>sw</code> reach it. Their offsets are 6 bits (−32 … 31), so an array is walked with its address in a register: <code>lw t1, 0(t0)</code> loads a[i], <code>addi t0, t0, 1</code> steps one word (RV16 is word addressed), a signed <code>bge</code> keeps the larger. The address goes through the ALU\'s adder, as for <code>add</code>.',
    without: 'Eight registers are all the data a program can hold: no arrays, no tables, no stack.',
    cost: '14 words, 77 instructions on average. The loop loads t1 and compares it in the very next instruction: on Pipeline III that pair stalls one cycle, since the loaded word exists only after M. Loading with <code>lw t1, 1(t0)</code> before the <code>addi</code> puts an independent instruction between them and removes the stall.',
  },
  p_call: {
    problem: '<code>call</code> (<code>jal ra, target</code>) jumps and saves pc + 1 in ra; <code>ret</code> (<code>jalr x0, 0(ra)</code>) jumps back through it, so one copy of gcd serves every caller. Arguments and the result travel in a0 and a1 by convention. A function that calls another overwrites ra and must save it first: <code>push ra</code> / <code>pop ra</code> keep it on a stack in memory, sp counting down.',
    without: 'The function body is copied at every call site, and recursion is impossible.',
    cost: '15 words. Euclid by subtraction runs one round per subtraction: gcd(1000, 1) takes 999, so the test set containing it runs 4 036 instructions and the mean is 1 388. Euclid with remainders needs a divider (Act 8). Each <code>call</code> and <code>ret</code> is a jump: two flushed cycles apiece on Pipeline IV.',
  },
  p_mul: {
    problem: 'RV16I has no multiply instruction. Shift and add does it one bit of b at a time: when b\'s low bit is 1, add a to the product; shift a left and b right; stop when b = 0. There is no <code>andi</code>, so the bit test needs a 1 in a register and an <code>and</code>. The shift-and-add multiplier of Act 8 runs the same loop in hardware, one bit per clock.',
    cost: '13 words, 28 to 134 instructions per product (mean 74): up to 8 per bit of b, and the loop stops as soon as b\'s remaining bits are 0. The reference reloads the 1 every iteration; hoisting <code>li t1, 1</code> out of the loop saves an instruction per bit. The MD opcode (Act 8) does it in one instruction, at the price of nearly doubling the core\'s clock period.',
  },
  p_sort: {
    problem: 'Bubble sort in place: n − 1 passes, each loading neighbours a[i] and a[i+1] (offsets 0 and 1 of one pointer) and swapping them with two stores when they are out of order. Nested loops, branches that depend on the data, and loads used by the very next instruction: the mix that exercises every hazard path of the pipeline at once.',
    cost: '17 words, 353 instructions on average over the five arrays; the comparisons grow as n². Each inner iteration compares the word it has just loaded (a load-use stall on Pipeline III), and its forward <code>bge</code> is taken or not by the data, which a static backward-taken predictor cannot guess.',
  },
  p_print: {
    problem: 'Numbers are binary inside; the console wants decimal characters (<code>sw ch, -2(x0)</code> prints one). Without a divider, each digit is the number of times its power of ten (10000, 1000, 100, 10, read from a <code>.data</code> table) can be subtracted before the remainder drops below it. There is no <code>bltu</code>, so the unsigned test is <code>sltu</code> then <code>bnez</code>. Leading zeros are skipped, the last digit is always printed, and \'0\' + digit is its ASCII code.',
    cost: '23 words, 47 to 150 instructions (mean 78): at most nine subtractions per digit. On the divide core (Act 8) a <code>divu</code> and a <code>remu</code> per digit would cost 36 cycles at 18 per divide, up to 180 for five digits: more than the subtraction loop needs on average (78 instructions) for the whole number.',
  },

  // ---- Act 5: the single-cycle core -----------------------------------------------------------
  c_lesson: {
    problem: 'Acts 1–3 built blocks that compute and remember; Act 4\'s programs say what to compute. The datapath is the wiring between them: one loop through the PC, the instruction memory, the register file, the ALU and the data memory, the same for every instruction, with muxes whose settings differ by instruction class. Only three things change at the clock edge: the PC, x[rd] and the memory word a store writes.',
    without: 'A path per instruction class: separate adders for addresses and branch targets beside the ALU, separate write paths into the register file. Sharing one path and switching it is what keeps the core small.',
    cost: 'Core III, the whole of RV16I: 4 720 NANDs, of which the register file is 2 172, the ALU 1 055, next PC 421, the branch comparator 287 and control 200; the other 585 are bus muxes and the PC\'s flip-flops. Its period, 98 NAND delays, is set by a load\'s path, and 50 of those delays are the ripple ALU: the act ends with Core IV, which shortens exactly that.',
  },
  c_imm: {
    problem: 'Constants travel inside instructions, in four formats: <b>I</b> = instr[15:10] (<code>addi</code>, <code>lw</code>, <code>jalr</code>), <b>S/B</b> = {instr[15:13], instr[6:4]}, in the f3 and rd positions (<code>sw</code> and the branch offsets), <b>J</b> = instr[15:7] (<code>jal</code>), <b>U</b> = {instr[15:7], instr[3]} &lt;&lt; 6 (<code>lui</code>). The generator delivers all four, sign-extended to 16 bits, and the core\'s 4:1 bus mux, steered by the control unit\'s <code>isel</code>, picks one. The sign bit is instr[15] in every format, so sign extension is a fan-out.',
    without: 'No instruction can carry a constant: no <code>addi</code>, no load or store offset, no branch or jump target.',
    cost: 'Zero NANDs, depth 0: splitters, mergers and the sign bit fanned out. Four formats do cost something, in the core: the 4:1 16-bit format mux, 147 NANDs. RV32\'s generator is also wiring per format, but picks among five 32-bit formats: 896 NANDs with its mux.',
    alts: [{ name: 'RV32 immediate generator (with its format mux)', lib: 'immgen' }],
  },
  c_ctl: {
    problem: 'Every cycle the datapath needs nine control outputs set: <code>rwe</code>, <code>bimm</code>, <code>isel</code>, the 4-bit ALU operation, <code>mwe</code>, <code>wb</code>, <code>br</code>, <code>jal</code>, <code>jalr</code>. All are functions of the opcode instr[3:0] (and f3, for the ALU operation): a 4→16 decoder gives one line per opcode, and each signal is the OR of the lines that need it. The ALU operation is {OPX, f3} for R-type, add for <code>addi</code> / <code>lw</code> / <code>sw</code>, and 1, 5 or 13 for the three immediate shifts.',
    without: 'The muxes and write enables have nothing to set them: every word would drive the datapath the same way.',
    cost: '200 NANDs, depth 13, and the 4→16 decoder is half of it (100 NANDs, depth 5). Don\'t-cares (<code>bimm</code> for <code>lui</code>, the ALU operation for <code>jal</code>) keep the OR terms short. In the single-cycle core it is the first block after the instruction memory: the ALU cannot start until control settles, 13 delays in.',
  },
  c_br: {
    problem: '<code>beq</code>, <code>bne</code>, <code>blt</code> and <code>bge</code> (opcodes 8–11) differ only in op[1:0]: bit 1 picks equality or signed less-than, bit 0 inverts. The comparator reads rs1 and rs2 from the register file and gives <code>take</code>, which the next-PC logic ANDs with the control unit\'s <code>br</code>. One 16-bit equality test, one signed less-than, a mux and an XOR cover all four; <code>bne</code> and <code>bge</code> are free inversions.',
    without: 'Only unconditional jumps: no loop can end on a condition, no <code>if</code> can be compiled.',
    cost: '287 NANDs, depth 44. The less-than (169 NANDs, depth 39: a + ¬b + 1, of which only the carry is read) sets the depth; equality is 12 deep. In the pipelines the comparator runs in E behind the forwarding muxes: the redirect path through it reaches F/D one delay inside Pipeline IV\'s period of 78, and is the critical path once prediction or traps add to it. With fast adders it comes within two delays of bounding the single-cycle core (74 against 76). A magnitude comparator tree gives signed less-than in depth 23 for 237 NANDs.',
    alts: [{ name: 'Signed magnitude comparator (tree), less-than only', lib: 'cmp16s' }],
  },
  c_npc: {
    problem: 'Each cycle the PC loads one of three values: pc + 1 (the next word), pc + imm (a taken branch, or <code>jal</code>), or rs1 + imm (<code>jalr</code>: returns through ra, function pointers). <code>ld</code> = jal | jalr | (br &amp; take) tells the PC to load the target instead of counting. pc + 1 also feeds the result mux, because <code>jal</code> and <code>jalr</code> write it to rd as the return address.',
    without: 'The PC only counts: straight-line code, no loops, no calls.',
    cost: '421 NANDs, depth 38: two 16-bit ripple adders (144 NANDs, depth 36 each), the incrementer (76, depth 31) and a bus mux (49). Kogge–Stone adders double it to 865 NANDs for depth 31: the ripple incrementer then sets the depth. In the complete core its pc + 1 also feeds the PC, which therefore needs no incrementer of its own.',
    alts: [{ name: 'Next PC with Kogge–Stone adders', lib: 'rv16_nextpc_ks' }],
  },
  c_core1: {
    problem: 'The first loop that runs by itself. The PC addresses the instruction memory; the control unit and the immediate generator decode the word; the register file reads rs1 = instr[9:7] and rs2 = instr[12:10]; the ALU computes on rs1 and rs2 or the immediate; the result mux writes rd = instr[6:4] at the clock edge. One instruction per cycle: R-type, <code>addi</code>, the immediate shifts and <code>lui</code>. No branches yet, so the PC only counts.',
    cost: '3 892 NANDs: the register file is 2 172 of them (56%), the ALU 1 055, the PC 318, control 200, and the three 2:1 bus muxes (immediate I or U, ALU b, result: the ALU\'s or lui\'s immediate) 147. Period 84 NAND delays with the bench\'s 8-delay memories: in one cycle the path runs PC → instruction memory → control → ALU → result mux → register file, and every instruction pays for the longest one.',
  },
  c_core2: {
    problem: '<code>lw</code> and <code>sw</code> reach the data memory. The ALU adds rs1 and the 6-bit offset (bimm = 1, operation add); a load writes <code>drdata</code> back through the result mux\'s second input, a store puts rs2 on <code>dwdata</code> and raises <code>dwe</code> for one clock edge. Addresses count 16-bit words, and the top seven (0xFFF9–0xFFFF) are devices, reached as negative offsets from x0.',
    without: 'Eight registers are all the data a program has: no arrays, no stack, no I/O.',
    cost: '+98 NANDs over Core I (3 990): the address is the ALU\'s add, but stores bring the S/B immediate format and loads the memory\'s word, so the immediate and the result each choose among three and gain a second 2:1 mux (49 NANDs; 4:1 bus muxes come with jumps). The price is mostly time: the data memory read sits behind the ALU in the same cycle (period 98 against 84), and fetch and load both read memory in that cycle, which is why a single-cycle core has separate instruction and data memories (Harvard).',
  },
  c_core3: {
    problem: 'Branches and jumps complete RV16I. The branch comparator reads rs1 and rs2, the next-PC logic loads the PC with pc + imm (a taken branch, <code>jal</code>) or rs1 + imm (<code>jalr</code>), and <code>jal</code> / <code>jalr</code> write pc + 1 to rd through the result mux\'s third input. The loops and calls of Act 4 now run on hardware built from NANDs, one instruction per cycle.',
    without: 'Straight-line code: each instruction runs once, and a loop of n iterations has to be written out n times.',
    cost: '+730 NANDs over Core II: the branch comparator (287) and next PC (421), less the PC\'s own incrementer (76), since next PC\'s pc + 1 now feeds the PC, and the J format and pc + 1 make the immediate and result muxes 4:1 (+98). 4 720 in all, period unchanged at 98 (the load path stays the longest). The 28 test programs take 1 236 cycles, 121 128 NAND delays. The five-stage pipeline of Act 6 runs them in 1 495 cycles at period 78 (116 610), the multicycle core in 3 865 at period 76 (293 740).',
    alts: [{ name: 'Single-cycle, Kogge–Stone adders', lib: 'rv16_cpu_ks' }, { name: 'Multicycle core', lib: 'rv16_mc' }, { name: 'Five-stage pipeline', lib: 'rv16_pipe_111' }],
  },
  c_computer: {
    problem: 'The core\'s pins expect memories that answer in the same cycle; so far the bench has provided them. Here they become parts: a 32-word ROM on pc[4:0] holds the program, a 64-word RAM on daddr[5:0] the data, and a 16-bit LED register is the output device. daddr[15] alone tells I/O from RAM (partial decoding): a store with bit 15 set writes the LEDs and leaves the RAM alone.',
    without: 'The core runs only on a test bench that serves its memory from outside.',
    cost: '27 083 NANDs, of which the 64-word RAM is 20 166 (74%): about 79 transistors per stored bit, decoder and read mux included, against 6 in an SRAM cell. Partial decoding costs a NOT and two ANDs, and every address with bit 15 set aliases the LED register. Reading the LEDs back would need read decoding too, a 16-bit 2:1 mux on drdata steered by daddr[15] (49 NANDs): here a load from an I/O address returns RAM data. Period 110, against 98 on the core bench\'s 8-delay memories.',
  },
  c_fast: {
    problem: 'Every instruction pays Core III\'s slowest path: PC → instruction memory → control → ALU → data memory → result mux → register file, 98 delays, of which the ripple ALU is 50. Static timing names the path; Kogge–Stone adders, carries in logarithmic depth instead of a chain, shorten it without changing a single instruction or cycle.',
    without: 'The same 1 236 cycles at period 98.',
    cost: 'The reference swaps only the ALU: 4 938 NANDs (+218, +5%) for period 76 (−22%), so the 28 programs take 93 936 NAND delays instead of 121 128. The load path stays the longest, now with the branch two delays behind it: instruction memory → register file → comparator (44 deep: its less-than waits for the carry chain) → next PC → PC, 74. Kogge–Stone adders in next PC would add 444 NANDs and leave the period at 76: speed up only what lies on the critical path.',
    alts: [{ name: 'Kogge–Stone ALU', lib: 'rv16_alu16ks' }, { name: 'Ripple ALU', lib: 'rv16_alu16' }],
  },

  // ---- Act 6: the pipeline --------------------------------------------------------------------
  pi_lesson: {
    problem: 'A single-cycle core does one instruction at a time, and each one must cross the whole datapath before the next may start: most of the hardware sits idle most of the cycle. A pipeline keeps every stage busy with a different instruction, so the period only has to fit the slowest stage, and pays for it in pipeline registers and in the hazard logic that keeps the overlap correct.',
    without: 'Core IV: 93 936 NAND delays on the 28 programs, one instruction per 76-delay cycle.',
    cost: 'Pipeline IV is 9 218 NANDs against Core IV\'s 4 938, the 15 pipeline registers 3 900 of it, and with ripple adders in E it is slower than Core IV: 1 495 cycles at period 78, 116 610 NAND delays. Kogge–Stone adders in E (10 102 NANDs) bring the period to 56 and the time to 83 720.',
    alts: [{ name: 'Core IV (single-cycle)', lib: 'rv16_cpu_ks' }, { name: 'Pipeline IV', lib: 'rv16_pipe_111' }],
  },
  pi_reg: {
    problem: 'The four pipeline registers (F/D, D/E, E/M, M/W) carry what later stages need of the instruction they hold: the word, pc, operands, immediate, control bits, rd. Two hazards need more than a plain register. A load-use stall holds the PC and F/D (en = 0) so the waiting instruction is decoded again; a stall or a taken branch clears D/E (and a branch also F/D) to an all-zero bubble, whose control bits write no register and store nothing.',
    without: 'A plain register can neither hold nor bubble: the hazard unit and the branch redirect would have nothing to act on, and only code padded with nops by hand would run.',
    cost: '260 NANDs, period 8: a 16-bit register (208) behind a 2:1 bus mux that picks 0 (49), and an OR so that clr loads even when en = 0. The finished RV16 has 16 of them, 4 160 NANDs, a third of the chip: the price of five instructions in flight.',
    alts: [{ name: 'Plain 16-bit register', lib: 'rv16_reg16' }],
  },
  pi_core0: {
    problem: 'Cut the datapath in five: F fetches, D decodes and reads registers, E computes, M reaches memory, W writes back. Each stage works on a different instruction, so the period is set by the slowest stage instead of the whole path. These programs keep every producer two instructions from its user and have no branches, and the register file writes at the falling edge, so an instruction three behind its producer reads the new value: no stage needs to know about another.',
    without: 'One instruction per 98-delay cycle, as in Core II.',
    cost: '7 062 NANDs, three quarters more than Core II, for period 65 instead of 98; the 12 pipeline registers are 3 120 of it. These pipelines do not branch, so they carry no pc past F and have no comparator or next PC yet. The stages are unbalanced: E needs 65 (the ripple ALU is 55 of it), the PC loop 39, every other stage 28 or less. The hazard-free code pays in nops: the 19 programs take 2 508 cycles with two after every instruction, where Core II runs them unpadded in 824. 163 020 NAND delays against 80 752.',
  },
  pi_fwd: {
    problem: 'An ALU result exists at the end of E but reaches the register file only from W, two cycles later. When the instruction in E reads a register that the one in M or W is about to write (rwe set, rd ≠ x0), the forwarding unit selects that value instead of the stale one read in D: <code>fa</code> / <code>fb</code> = 1 from M, 2 from W, 0 from the register file. M wins over W because it holds the newer write.',
    without: 'Two independent instructions or nops between every producer and its user: the 19 test programs take 2 508 cycles padded that way, 970 with forwarding (and a nop after each load).',
    cost: '110 NANDs, depth 13: four 3-bit equality comparators (19 NANDs each), two zero tests, a few gates. It sits in E in front of the ALU, so its 13 delays add to the slowest stage: Pipeline II runs at period 78 against 65. They arrive by the operand muxes\' select inputs: fa and fb settle 13 delays after the pipeline registers launch rd and rs, while the operands they choose between are there after 4, and every bit of each mux waits for its select. Comparing in D against the instructions then in E and M, and registering the selects, takes the comparators off that path.',
  },
  pi_core1: {
    problem: 'Now an instruction may use the result of the one just before it. Two 3:1 bus muxes in front of E pick each operand from the register file, from M (the result before memory: the ALU\'s, or the immediate for lui) or from W (the value being written back), steered by the forwarding unit. rs2 is forwarded too: stores write it, and from Pipeline IV on branches compare it (with pc + 1 joining M\'s result for the jumps).',
    without: 'Two nops after every instruction: 2 508 cycles on these programs instead of 970.',
    cost: '+355 NANDs (7 417) and the period rises from 65 to 78, but the 19 programs fall from 2 508 cycles to 970: 75 660 NAND delays, against 163 020 for Pipeline I and 80 752 for Core II. The pipeline now beats Core II, by 6%, but not Core IV: with fast adders the single-cycle core runs these programs in 62 624 (824 cycles at period 76).',
  },
  pi_haz: {
    problem: 'A load\'s word comes out of memory at the end of M. If the very next instruction reads it, that instruction is already in E when the word appears, one cycle too early for forwarding. The hazard unit, in D, compares rs1 and rs2 with the rd of a load in E (rwe and wb = memory, rd ≠ x0) and raises <code>stall</code>: the PC and F/D hold, D/E takes a bubble, and a cycle later W forwards the loaded word.',
    without: 'The user reads the stale register, unless the program puts an independent instruction or a nop after every load.',
    cost: '53 NANDs, depth 12: two 3-bit comparators, a zero test and four gates. It is conservative: rs2 counts even for instructions that do not read it (<code>addi</code>, <code>lw</code>), which occasionally costs a needless stall and spares decoding which sources each opcode reads.',
  },
  pi_core2: {
    problem: 'Loads used at once. On a stall the PC and F/D keep their values, D/E clears to a bubble and the load moves on to M; the next cycle it is in W and the forwarding unit hands its word to the instruction waiting in E. One lost cycle per load-use pair, none for any other dependence.',
    without: 'A nop after every load instead: 970 cycles on these programs, against 917 with the stall.',
    cost: '+114 NANDs (7 531), period unchanged at 78. The stall is paid only when the next instruction reads the loaded register, where a nop is paid after every load. The 19 programs take 71 526 NAND delays, 11% less than on Core II and still 14% more than on Core IV (62 624).',
  },
  pi_core3: {
    problem: 'A branch or jump resolves in E, where the comparator and the next-PC logic run on forwarded operands. By then F and D hold the next two words, fetched on the guess that the branch falls through. On a taken branch or any jump, E loads the PC with the target and clears F/D and D/E, so the two wrong-path instructions never write anything.',
    without: 'The two instructions after a taken branch execute anyway: wrong-path code changes registers and memory.',
    cost: '+1 687 NANDs (9 218): the branch comparator (287), next PC (421), a redirect mux on the PC, three pipeline registers carrying pc and pc + 1 (780), and the J format and pc + 1 widening the immediate, value and result muxes (+147). Period unchanged at 78: forwarding → comparator → next PC → flush reaches F/D at 77, one delay inside the ALU path. Every taken branch and jump costs two cycles: the 28 Core III programs take 1 495 cycles against 1 236, and at period 78 against 98 the pipeline ends 4% faster than Core III (116 610 against 121 128 NAND delays). The flushes eat most of the 20% the shorter period gained, and Core IV (93 936) beats it outright. Branch prediction wins back cycles (1 431 here) but adds period (80): 114 480. Kogge–Stone adders in E win back the period instead: 56, 83 720 NAND delays, 11% faster than Core IV.',
    alts: [{ name: 'Core IV (single-cycle, Kogge–Stone ALU)', lib: 'rv16_cpu_ks' }, { name: 'Pipeline IV, Kogge–Stone adders in E', nand: 10102, note: 'period 56, the same 1 495 cycles: 83 720 NAND delays' }],
  },
  o_bpred: {
    problem: 'Loops take their closing branch almost every time, and Pipeline IV flushes two instructions for each one. Guessing in F avoids most of that: decode the fetched word (the immediate generator is wiring), and if it is <code>jal</code> or a branch with a negative offset (instr[15] = 1), fetch from pc + imm at once. E compares the guess with the outcome and redirects only on a miss: to the target, or back to pc + 1 when a predicted branch falls through.',
    without: 'Two flushed cycles per taken branch or jump: 2 653 cycles on the prediction programs.',
    cost: '+571 NANDs (9 789) for an adder and a decoder in F and the guess carried to E, period 80 (+2). Cycles fall 13% over the 31 programs (2 653 → 2 303) and 25% on the three loop programs (1 158 → 872). A dynamic predictor also learns forward branches, from per-branch history; its logic is small (a 2-bit counter\'s next state is 28 NANDs), its storage is not: RV32\'s 16-entry branch target buffer is 22 849 NANDs, more than twice this whole pipeline. Against the single-cycle core the guess alone is not enough: Core IV runs these programs in 149 112 NAND delays (1 962 cycles at period 76), this pipeline in 184 240. With Kogge–Stone adders in E and in F\'s target adder as well it is 10 895 NANDs at period 58: 133 574, 10% faster than Core IV.',
    alts: [{ name: '2-bit saturating counter, next-state logic', lib: 'satctr' }, { name: '16-entry branch target buffer (RV32)', lib: 'btb16' }, { name: 'Pipeline IV, no prediction', lib: 'rv16_pipe_111' }, { name: 'Core IV (single-cycle)', lib: 'rv16_cpu_ks' }],
  },

  // ---- Act 7: the system ----------------------------------------------------------------------
  y_lesson: {
    problem: 'Three events cannot be handled inline: a word that is no instruction, a request to the system (<code>ecall</code>), and a device that needs service now. Each one stops the program between two instructions, saves where it was and why, runs a handler at mtvec and comes back with <code>mret</code>. The state lives in CSRs, apart from the program\'s registers, so the handler can run without destroying what it must restore.',
    without: 'An undefined word runs as whatever its bits select, and a device is polled in a loop that spends cycles and still misses what happens between two polls.',
    cost: 'On the single-cycle core: the CSR file 1 765 NANDs, exceptions 2 537 over Core III in all, interrupts nothing more. In the pipeline: 2 813 over Pipeline IV for precise exceptions, then 7 for the interrupt. The finale is 12 038 NANDs.',
    alts: [{ name: 'Single-cycle core with traps and interrupts', lib: 'rv16_cpu_irq' }, { name: 'The finale: pipeline with traps and interrupts', lib: 'rv16_pipe_111s' }],
  },
  y_csr: {
    problem: 'The trap machinery keeps its state in control and status registers, read and written by <code>csrrw</code> / <code>csrrs</code> / <code>csrrc</code> with the CSR number in the rs2 field: mstatus (MIE bit 3, MPIE bit 7), mie (MEIE bit 11), mtvec (the handler\'s address), mepc (where the trap happened), mcause, mscratch; mip shows the interrupt line, and CSR 7 has no register: it reads 0 and ignores writes. A trap writes three of them on one edge (mepc ← pc, mcause ← cause, MPIE ← MIE, MIE ← 0), and <code>mret</code> moves MPIE back into MIE.',
    without: 'Nowhere to keep the return address and the cause: a trap would destroy the state needed to resume, so neither exceptions nor interrupts can exist.',
    cost: '1 765 NANDs, period 17: five 16-bit registers with enable (1 040), mstatus (16 flip-flops, 144: its next value is computed every cycle, so it needs no enable) and the 8:1 read mux (343) are most of it. mepc and mcause each add a 2:1 mux (the written value or the trap\'s pc and cause); mstatus has its own next-value logic for MIE and MPIE. RISC-V addresses 4 096 CSRs with 12 bits; RV16\'s 3-bit field keeps eight.',
  },
  y_trap: {
    problem: 'Three events stop an instruction from running: <code>ecall</code> (a request to the system, cause 11), <code>ebreak</code> (a breakpoint, 3) and an illegal word (2): a SYSTEM, OPX or shift variant RV16 does not define, or any MD instruction without the M extension. The core then writes no register and stores nothing, saves pc in mepc and the cause in mcause, and loads mtvec into the PC; <code>mret</code> jumps back to mepc. The CSR instructions write the old value to rd as they update the CSR.',
    without: 'An undefined word executes as whatever its bits happen to select, and a program has no way to call the system or stop for a debugger.',
    cost: '7 257 NANDs, +2 537 over Core III: the CSR file 1 765, system decode 439 (it also computes the CSR write value: rs1, old | rs1 or old &amp; ¬rs1), the illegal detector 158, and the muxes for the target and the CSR result. The cause needs no mux of constants: bit 1 is always 1, bit 15 is intr, bits 0 and 3 are five NANDs of intr, ill and ecall. Period 100 (+2): the CSR read joins the result mux.',
  },
  y_irq: {
    problem: 'A device raises <code>irq</code> between two instructions of a program that does not expect it. When intr = MIE · MEIE · irq is 1, the instruction at pc does not run: mepc ← pc, mcause ← 0x800B (bit 15: an interrupt; 11: external), pc ← mtvec, and MIE drops to 0 so the handler is not interrupted in turn. <code>mret</code> restores MIE and re-runs the instruction at mepc.',
    without: 'The program polls the device in a loop, spending cycles and missing anything that happens between two polls.',
    cost: 'Zero NANDs over Exceptions: the CSR file already computes intr and the cause logic already has its term; the core only wires the pin in (7 257 NANDs, period 100). Checking before the instruction is simple in a single-cycle core; the pipeline takes the interrupt in E, on a valid instruction, like an exception.',
  },
  p_handler: {
    problem: 'An interrupt can land between any two instructions of main, so the handler must leave every register as it found it: push what it uses, read the device\'s word from IN, write it doubled to OUT, acknowledge the device (a store of 0 to IRQ, 0xFFF9), pop, <code>mret</code>. Main enables in order: mtvec, then mie bit 11 (MEIE), then mstatus bit 3 (MIE) last, so no interrupt arrives before there is a handler to take it.',
    without: 'Without the acknowledge, irq is still high when <code>mret</code> restores MIE, and the interrupt is taken again at once, forever. Without the save, main\'s t0 changes under it at an unpredictable instruction.',
    cost: '22 words, 10 of them the handler, which runs in full on every interrupt, whatever main was doing; <code>push</code> and <code>pop</code> are two instructions each (an <code>addi</code> of sp and a store or load).',
  },
  y_ptrap: {
    problem: 'The pipeline with precise exceptions: when an instruction traps, every older instruction completes and no younger one has changed anything. Traps are taken in E, where the instruction has written nothing yet: M and W finish, F/D and D/E are flushed, the PC loads mtvec. A valid bit travels with every instruction, because a bubble\'s all-zero word is an illegal SYSTEM encoding; a CSR instruction reads and writes in E, and its old value travels down as the result.',
    without: 'An imprecise trap: mepc points near the culprit, a younger instruction may already have written a register, and the handler cannot resume the program.',
    cost: '12 031 NANDs, +2 813 over Pipeline IV: the CSR file, system decode, illegal detector, one more pipeline register (D/E instr) and the F/D valid bit, one flip-flop that clears (15 NANDs). Period 81 (+3): trap and <code>mret</code> join the redirect path to the PC. The 44 programs take 2 361 cycles, 191 241 NAND delays, against 194 800 on the single-cycle core with traps (1 948 cycles at period 100): with ripple adders in E, a period of 81 against 100 only just covers the extra cycles (2% faster).',
    alts: [{ name: 'Single-cycle core with traps', lib: 'rv16_cpu_trap' }, { name: 'Pipeline IV (no traps)', lib: 'rv16_pipe_111' }],
  },
  y_final: {
    problem: 'Pipeline V plus the external interrupt. When intr = MIE · MEIE · irq is 1, the instruction in E does not run: it is taken like an exception, with mcause 0x800B and mepc its pc, older instructions completing and younger ones flushed; <code>mret</code> runs it again. The valid bit gates the interrupt too: a bubble carries no real pc (its D/E slot was cleared), so an interrupt taken on it would save a wrong mepc, and mret would resume somewhere the program never was.',
    without: 'A device must be polled, as on Pipeline V. Without the valid gate, an interrupt that lands on a bubble saves mepc = 0, and its mret restarts the program.',
    cost: '12 038 NANDs, 7 over Pipeline V: the interrupt\'s AND with valid (2), the trap OR (3) and the cause\'s interrupt terms (2). Period 81, unchanged. The 45 programs, the interrupt-driven one included, take 2 399 cycles, 194 319 NAND delays, against 197 600 on the single-cycle core with interrupts (1 976 cycles at period 100). A predicting Pipeline IV may keep its prediction here: 12 609 NANDs, period 84, 2 299 cycles, 193 116 NAND delays, about the same. What would make it pay is Kogge–Stone adders in E: 12 922 NANDs, period 59, 141 541, 28% faster than the single-cycle core.',
    alts: [{ name: 'Single-cycle core with traps and interrupts', lib: 'rv16_cpu_irq' }, { name: 'The finale with branch prediction', nand: 12609, note: 'period 84, 2 299 cycles: 193 116 NAND delays' }, { name: 'The finale with Kogge–Stone adders in E', nand: 12922, note: 'period 59, 2 399 cycles: 141 541 NAND delays' }],
  },

  // ---- Act 8: side quests ---------------------------------------------------------------------
  o_lesson: {
    problem: 'RV16I adds, subtracts, shifts and compares; it has no multiply, no divide and no floating point. Each can be done in software, in a unit that loops one step per clock, or in one combinational pass, and the choice moves a core\'s three graded numbers in different directions: NANDs, period and cycles.',
    without: 'Software: 28 to 134 instructions per 16-bit product in the Act 4 puzzle, 74 on average.',
    cost: 'Shift-and-add: 1 169 NANDs, 18 cycles a product. The 16 × 16 array: 2 672 NANDs, 150 deep, and in the core a period of 191 against 98 for every instruction. The FP adder is 3 732 NANDs, the FP multiplier 4 912; no RV16 core runs them.',
    alts: [{ name: 'Shift-and-add multiplier', lib: 'smul16' }, { name: '16 × 16 array multiplier', lib: 'amul16' }, { name: 'Pipelined Booth multiplier', lib: 'pmul16' }],
  },
  n_float: {
    problem: 'An integer\'s 16 bits are 65 536 evenly spaced values. Binary16 spends them on a sign, a 5-bit exponent (bias 15) and a 10-bit fraction behind a hidden 1: values from 2<sup>−24</sup> up to 65 504, always with 11 significant bits, the steps growing with the value. Every FP unit of this act reads those three fields, so the encoding comes first.',
    without: 'Fractions and large ranges only as fixed point: the programmer tracks the binary point by hand and loses either range or precision.',
    cost: 'Free in hardware: the format is a convention. Its price shows in the units: unpack (63 NANDs) recovers the hidden bit and the special values, and every result needs normalize &amp; round (2 058).',
  },
  o_mulseq: {
    problem: 'The Act 4 multiply loop in hardware. A 32-bit product register starts as {0, b}; each clock, if its lowest bit is 1, a is added to its upper half, then the whole register shifts right one place. Sixteen steps on one 16-bit adder, plus a load cycle and a done cycle: 18 cycles per product, run by an iteration counter.',
    without: 'Multiplication in software: 28 to 134 instructions per product in the Act 4 puzzle, 74 on average.',
    cost: '1 169 NANDs, period 48: 18 × 48 = 864 delays per product. The 16 × 16 array multiplier is 2 672 NANDs and 150 delays deep in one pass; a Wallace tree, 3 455 NANDs and 54 deep; the pipelined Booth multiplier, 7 703 NANDs at period 41, one product per cycle after four.',
    alts: [{ name: '16 × 16 array multiplier', lib: 'amul16' }, { name: 'Wallace-tree multiplier', lib: 'wmul16' }, { name: 'Pipelined Booth multiplier', lib: 'pmul16' }],
  },
  o_mularr: {
    problem: 'All partial products at once: row k is a AND b[k], shifted left k places, and rows of adders sum them, each row\'s carry out becoming the next row\'s top bit. No clock and no control: the product of two 8-bit numbers appears one combinational delay later. At 16 × 16 it is the multiplier the MD opcode uses in the core.',
    without: 'A multiply takes a loop: n + 2 cycles in a shift-and-add unit, tens of instructions in software.',
    cost: '632 NANDs, depth 70 at 8 × 8. Cells grow as n², depth as n: 16 × 16 is 2 672 NANDs and 150 deep, which nearly doubles the single-cycle core\'s period. A Wallace tree sums the rows with carry-save adders in logarithmic depth (911 NANDs, depth 40 at 8 × 8); radix-4 Booth recoding halves the rows of a signed product (1 062, depth 47).',
    alts: [{ name: 'Wallace-tree multiplier (8 × 8)', lib: 'wmul8' }, { name: 'Booth radix-4 multiplier (8 × 8, signed)', lib: 'bmul8' }, { name: 'Shift-and-add (8-bit, 10 cycles)', lib: 'smul8' }],
  },
  o_mcore: {
    problem: 'The MD opcode (0011) multiplies in one instruction: <code>mul</code> (low half), <code>mulh</code> (high half, both signed), <code>mulhsu</code>, <code>mulhu</code>, chosen by f3. One unsigned 16 × 16 array serves all four: a negative a is worth a − 2<sup>16</sup>, so the signed high half is the unsigned one minus b when a &lt; 0, and minus a when b &lt; 0. The result joins write back through one more mux, and MD\'s write is ORed into rwe.',
    without: 'Shift and add in software: 28 to 134 instructions per product.',
    cost: '8 037 NANDs (+3 317: the MD multiplier is 3 257, its array 2 672) and period 191 against 98: the multiplier\'s 166-deep path now runs register file → multiplier → register file within one cycle, and every instruction, <code>add</code> included, pays for it. Code without a multiply runs 1.95 times slower. Real cores give the multiplier pipeline stages of its own (the pipelined Booth multiplier: period 41, four cycles of latency) or a shallower tree.',
    alts: [{ name: 'Wallace-tree multiplier', lib: 'wmul16' }, { name: 'Booth radix-4 multiplier (signed)', lib: 'bmul16' }, { name: 'Pipelined Booth multiplier', lib: 'pmul16' }],
  },
  o_div: {
    problem: 'Long division in binary, one quotient bit per clock: shift the remainder left, bring in the next dividend bit, subtract the divisor; if the difference is not negative keep it and set the quotient bit, else keep the old remainder. An iteration counter runs the 16 steps: start loads a and b, done rises 18 cycles later. RISC-V\'s rule for b = 0 falls out of the hardware: every subtraction succeeds, so q = 0xFFFF and r = a.',
    without: 'Division in software: the same 16 steps as a loop, several instructions each.',
    cost: '1 445 NANDs, period 31, 18 cycles: 558 delays per division. Unrolled into an array divider the 16 steps cost 4 464 NANDs and a 613-deep path, each subtraction waiting on the previous one\'s borrow. Non-restoring division replaces the restore with an add-or-subtract and a final correction (1 878 NANDs, same cycles); radix-2 SRT keeps the remainder in carry-save form so the period no longer grows with the width (4 698, period 29); radix 4 retires two bits per cycle (6 815 NANDs, period 44, 11 cycles).',
    alts: [{ name: 'Array divider', lib: 'adiv16' }, { name: 'Non-restoring iterative divider', lib: 'nrsdiv16' }, { name: 'Radix-2 SRT divider', lib: 'srtdiv16' }, { name: 'Radix-4 SRT divider', lib: 'srt4div16' }],
  },
  o_dcore: {
    problem: 'A divide does not finish in one cycle. The core starts the divider when the instruction is a divide, then holds the PC on that instruction and writes nothing until done, 18 cycles later, when the result is written and the PC moves on: the single-cycle core\'s version of a stall. <code>div</code>, <code>divu</code>, <code>rem</code> and <code>remu</code> (f3 4–7) share one unsigned divider: |a| and |b| go in, the quotient takes the sign a XOR b (unless b = 0), the remainder the sign of a.',
    without: 'The core would write a quotient that is not ready, or stretch its clock to an array divider\'s 613-deep path.',
    cost: '10 546 NANDs (+2 509: the MD divider is 2 400, the unsigned divider 1 445 of it plus four 16-bit add / subtractors that take the signs off and put them back), period 193. The 23 test programs take 1 859 cycles for 959 instructions, each divide holding the core 18 cycles. A radix-4 SRT divider would take 11, for 6 815 NANDs.',
    alts: [{ name: 'Radix-4 SRT divider (11 cycles)', lib: 'srt4div16' }],
  },
  o_fpunpack: {
    problem: 'A binary16 word is a sign (bit 15), a 5-bit biased exponent and a 10-bit fraction, and the exponent field decides what the rest means: 1–30 a normal number with a hidden leading 1, 0 a subnormal or zero (no hidden bit, exponent counted as 1), 31 infinity or NaN. Unpack resolves this once: sign, effective exponent, the 11-bit significand with its hidden bit, and the classes zero, inf, nan and snan, so the adder, multiplier, comparator and converters see plain fields.',
    without: 'Every unit re-derives the hidden bit and the special cases, and a subnormal taken with exponent 0 is off by a factor of two.',
    cost: '63 NANDs, depth 14: tests of the exponent field (all zeros, all ones) and of the fraction (zero) are most of it. The adder, the multiplier and the comparator each place two.',
  },
  o_fpround: {
    problem: 'An exact sum or product has more bits than the 11 a binary16 significand keeps. Rounding it correctly, in any of the five modes, needs only three of them: the last kept bit (lsb), the first dropped bit (guard) and the OR of everything below it (sticky), plus the sign for the directed modes. <code>up</code> says add one unit in the last place; <code>toInf</code> says whether an overflow becomes ∞ or the largest finite number.',
    without: 'Truncation only (round toward zero): results biased toward zero, and not the IEEE 754 default, round to nearest with ties to even.',
    cost: '62 NANDs, depth 13: decode rm to one line per mode, then a small AND-OR per mode. Every FP result passes through it once, inside normalize &amp; round.',
  },
  o_fpsticky: {
    problem: 'Before two floats are added, the one with the smaller exponent is shifted right by the exponent difference so their binary points line up. The bits shifted out cannot just be dropped: rounding needs to know whether any of them was 1. The sticky shifter is a right barrel shifter (level k shifts by 2<sup>k</sup>) whose levels also OR the bits they drop into one sticky bit.',
    without: 'A plain shifter forgets the dropped bits: a sum just above a halfway point looks like a tie, rounds to even, and lands one unit in the last place off.',
    cost: '264 NANDs, depth 21, for 13 bits and four levels: the adder places this one, and normalize &amp; round a 15-bit one (296) for results below the smallest normal. The ALU\'s 16-bit barrel shifter, without sticky logic but shifting both ways, is 299 NANDs, depth 14.',
    alts: [{ name: '16-bit barrel shifter (no sticky)', lib: 'rv16_shift16' }],
  },
  o_fplzc: {
    problem: 'Subtracting two close numbers cancels their leading bits: 1.0001 − 1.0000 leaves 0.0001, and the result must be shifted left until its first 1 is back in the hidden-bit place. The shift is the number of leading zeros. A 16-bit counter is two 8-bit ones: the upper count when the upper half has a 1, else 8 plus the lower count, and so on down to 2 bits.',
    without: 'Normalizing one place at a time: up to 15 shift steps, or a 15-deep chain of priority decisions.',
    cost: '104 NANDs, depth 9: four levels of halving give logarithmic depth. A priority encoder, the same recursion asking for the index of the highest 1 (15 − the count), is 89 NANDs, depth 9.',
    alts: [{ name: '16-input priority encoder', lib: 'prienc16' }],
  },
  o_fpnorm: {
    problem: 'Add, multiply and int → float all end with a raw significand and exponent that must become a correctly rounded binary16 word. Normalize &amp; round shifts out the leading zeros as far as the exponent allows (stopping at a subnormal), or shifts right with sticky when the exponent is below 1; rounds on guard and sticky with the rounding decision; bumps the exponent when rounding carries out of 1.11…1; and turns a field past 30 into ∞ or the largest finite. It also raises the overflow, underflow and inexact flags.',
    without: 'Each unit carries its own normalizer and rounder, each copy another place to get a corner case wrong.',
    cost: '2 058 NANDs, depth 86 for the adder\'s 15-bit significand (2 666, depth 90 for the multiplier\'s 22 bits): more than half of the binary16 adder (3 732). Once it exists, the adder, the multiplier and the converter are mostly wiring around it.',
  },
  o_fpadd: {
    problem: 'a + b in binary16: unpack both, swap so that |a| ≥ |b|, shift b right by the exponent difference keeping a sticky bit, add or subtract the significands (<code>sub</code> flips b\'s sign), then normalize &amp; round. The special cases wrap around it: a NaN in, or ∞ − ∞, gives the canonical NaN 0x7E00, and x − x is +0, except −0 when rounding down.',
    without: 'Floating-point addition in software: field extraction, shifts, compares and adds, dozens of integer instructions per operation.',
    cost: '3 732 NANDs, depth 163, normalize &amp; round 2 058 of them. The same design in binary32 (8-bit exponent, 23-bit fraction) is 8 218 NANDs, depth 181: area roughly doubles, depth grows by 18. RV16 has no F registers or FP instructions, so no core here runs it; the RV32 chapters\' FPU32 is that adder, the multiplier and the rest inside a CPU, with a register file of their own.',
    alts: [{ name: 'binary32 adder', lib: 'fpadd8_23' }, { name: 'RV32F floating-point unit', lib: 'fpu32' }],
  },
  o_fpmul: {
    problem: 'Multiplying floats needs no alignment: XOR the signs, add the exponents (less one bias), multiply the 11-bit significands into a 22-bit product, then normalize &amp; round. Two significands in [1, 2) give a product in [1, 4), so its top bit decides a shift by one place.',
    without: 'Float products in software: an integer multiply of the significands (28 to 134 instructions by shift and add on RV16I), then exponent, normalization and rounding code around it.',
    cost: '4 912 NANDs, depth 150: the 11 × 11 Wallace multiplier is 1 696 and the 22-bit normalize &amp; round 2 666. Shallower than the adder (163), which must align before it adds. An 11 × 11 array multiplier is smaller (1 232) but 100 deep against 48; binary32 takes 14 913 NANDs, the significand multiplier growing with the square of the width. As with the adder, no RV16 core runs it: the RV32 chapters\' FPU32 is where a multiplier like it meets a register file.',
    alts: [{ name: 'binary32 multiplier', lib: 'fpmul8_23' }],
  },
  o_fpcmp: {
    problem: '<code>feq</code>, <code>flt</code> and <code>fle</code>. The exponent sits above the fraction, so two non-negative floats order like 15-bit unsigned integers: compare |a| and |b| once. The signs then decide: two negatives reverse the order, different signs make the negative one smaller unless both are zeros (−0 = +0), and any NaN makes every comparison false (<code>unord</code>), a signaling one also raising <code>snan</code>.',
    without: 'Comparing the patterns as signed integers orders every pair of negatives backwards, calls −0 smaller than +0, and calls a NaN equal to itself.',
    cost: '682 NANDs, depth 25: two unpacks, a 15-bit Kogge–Stone subtractor and a 15-bit equality test for the magnitudes, and the sign and NaN logic. A 16-bit integer magnitude comparator alone (listed below) is 237 NANDs, depth 23: the format keeps its special cases off the critical path.',
    alts: [{ name: '16-bit magnitude comparator (integers)', lib: 'cmp16' }],
  },
  o_fpcvt: {
    problem: '<code>fcvt</code> from a 16-bit integer: an integer is already a significand, its top bit worth 2<sup>15</sup>. Take the magnitude (a conditional negate when signed and negative), hand it to normalize &amp; round with exponent 15 + bias, and the leading-zero shift and the rounding do the rest. Integers above 2048 lose low bits (inexact); unsigned 65 535 lies past 65 504, the largest finite, and rounds to ∞ in some modes (overflow).',
    without: 'int → float in software: find the leading 1 a bit at a time, shift, and round by hand, a loop for every conversion.',
    cost: '2 690 NANDs, depth 109: the 16-bit normalize &amp; round and a 16-bit conditional negate. No new arithmetic: the level is wiring around blocks already built.',
  },
  o_cache: {
    problem: 'Main memory is far slower than the core, and programs reuse the same words (locality). A cache keeps recent ones close: here eight one-word lines, index = addr[2:0], each holding its word, a 5-bit tag (addr[7:3]) and a valid bit. hit = valid and tag match; a read hit answers from the line, a miss from main memory, filling the line at the clock edge; a write fills the line and goes through to memory.',
    without: 'Every load waits for main memory, tens to hundreds of core cycles for DRAM. The RV16 bench answers in the same cycle, so here the cache is graded on its own cost.',
    cost: '3 497 NANDs, period 36, for 128 data bits: the data RAM (8 × 16) is 2 419 NANDs, the tag RAM (8 × 6) 939, the tag comparator 33. Tag and valid add 6 bits to every 16-bit line; longer lines share one tag among more words but fetch more on a miss. Direct mapping makes addresses with the same low three bits evict each other; two ways, two tags compared at once, avoid that.',
  },
  o_mc: {
    problem: 'Before pipelines, processors ran each instruction as several short steps under a state machine. A one-hot FSM steps F → E → (M) → W: F loads an instruction register, E registers the ALU result, M (loads and stores only) uses memory, W writes the register file and the PC. Two registers cut the single-cycle path, and the data memory gets a step of its own.',
    without: 'The single-cycle core: one instruction per 98-delay cycle.',
    cost: '5 203 NANDs (+483 over Core III), period 76 against 98, but 3 or 4 cycles per instruction: Core III\'s programs take 3 865 cycles instead of 1 236, 2.4 times slower overall (293 740 against 121 128 NAND delays). The period falls only 22% because E still holds the whole ripple ALU. Multicycle designs paid by sharing one ALU and one memory between the steps; this one shares nothing, keeping the separate memories and the next-PC adders.',
    alts: [{ name: 'Single-cycle core', lib: 'rv16_cpu' }],
  },

  // ---- Act 9: throughput ----------------------------------------------------------------------
  k_lanes: {
    problem: 'One instruction, four results. A lane is the single-cycle core\'s execute step for one thread: the operand-b mux (its own rs2 or the shared immediate) and an ALU. All four lanes take the same <code>alu</code> operation, <code>bimm</code> and immediate from the one control unit; only their operands differ. <b>nz</b> has a bit per lane, rs1 ≠ 0: the predicate <code>split</code> will test, computed by every lane on its own register.',
    without: 'One result per instruction: a loop over n elements runs n iterations, where four lanes run n / 4.',
    cost: '4 596 NANDs, depth 55, the ALU\'s y (its depth 64 is the zero flag, unused here: nz tests rs1): per lane a 1 055-NAND ripple ALU, a 49-NAND bus mux and a 16-input OR for nz (45), 1 149 in all. Nothing inside the block is shared; the sharing is around it, where one control unit, one immediate generator and one PC feed all four. Kogge–Stone ALUs (1 273 NANDs each) would make the four lanes 5 468 NANDs.',
    alts: [{ name: 'Four lanes with Kogge–Stone ALUs', nand: 5468, note: '4 × (1 273 + 49 + 45): the measured rv16_alu16ks, bus mux and OR tree' }, { name: 'One lane\'s ripple ALU', lib: 'rv16_alu16' }],
  },
  k_vrf: {
    problem: 'Each lane runs the same instruction on its own thread\'s data, so each needs its own x1–x7. The four files share every address: <code>ra1</code>, <code>ra2</code> and <code>wa</code> are the instruction\'s rs1, rs2 and rd, the same for all lanes in the same cycle. Only the write enable is per lane: bit <i>i</i> of <code>we</code>, which the active mask will drive, decides whether lane <i>i</i> keeps its result.',
    without: 'Four lanes reading one register file read the same operands and compute the same results: single instruction, single data, four times.',
    cost: '8 688 NANDs, period 11: four 2 172-NAND register files, each 1 456 of flip-flops, 686 of read muxes and a 30-NAND write decoder. 55% of the SIMD core, its largest block: lanes share control, never storage. 448 stored bits in 34 752 transistors is 78 per bit, against 6 in an SRAM cell, which is why GPU register files are banked SRAM, and still the largest structure on the chip. The four write decoders all decode the same wa: one decoder, ANDed with each lane\'s enable, would decode it once.',
    alts: [{ name: 'One register file (8 × 16)', lib: 'rv16_rf' }],
  },
  k_mask: {
    problem: 'A lane with nothing to do must not write: the tail of an array whose length is not a multiple of four, one side of an if. The mask has a bit per lane, all ones after reset, loaded by <code>tmc</code> (and later by split and join), and it gates the write enables: we = mask when rwe, dwe = mask when mwe. A masked lane still reads, computes and drives its address; it only changes nothing. The mask also names the <b>leader</b>, the lowest active lane, whose registers speak for the warp where it needs one value.',
    without: 'Every lane writes every result: four lanes looping over 10 elements store 12, two past the end of the array, and no lane can sit out an instruction.',
    cost: '102 NANDs, period 8: the 4-bit register with enable (52), the reset ORs (15), the leader (10: bit 1 = ¬m0·¬m1, bit 0 = ¬m0·(m1 + ¬m2)), <i>any</i> (9) and the eight ANDs of we and dwe (16). In the core the binary leader steers a 16-bit 4:1 mux (147 NANDs) per operand; the RV32 lane core of chapter 29 makes it a one-hot word instead (18 NANDs, depth 7) for one-hot muxes.',
    alts: [{ name: 'Leader as a one-hot word (RV32 lane core)', lib: 'low1_4' }, { name: 'Priority encoder (highest lane, binary)', lib: 'prienc4' }],
  },
  k_simd: {
    problem: 'One fetch, one decode, four lanes. The single-cycle core\'s control unit, immediate generator, branch comparator, next-PC logic and PC stay single; its register file and ALU become the lane register file and the four lanes, and each lane gets its own memory port and result muxes. Where the warp needs one value the leader supplies it: two 16-bit 4:1 muxes pick the leader\'s rs1 and rs2 for the branch comparator, the <code>jalr</code> target and <code>tmc</code>\'s mask. The lane decoder adds <code>tmc</code> and <code>csrr rd, tid</code>, which writes each lane\'s own number.',
    without: 'Four cores: four fetches, four control units, four PCs and four instruction memories, for four instruction streams that are identical.',
    cost: '15 669 NANDs, period 100 (the load path, 2 delays longer than Core III\'s). Per lane 3 468 (registers 2 172, ALU, mux and nz 1 149, three result muxes 147); shared 1 797 (next PC 421, branch 287, control 200, PC 144, the leader and immediate 4:1 muxes 441, mask 102, lane decoder 52, the PC and pc + 1 / immediate muxes 147, an OR). Four single-cycle cores are 18 880 NANDs: the lane core saves 3 211 (17%), little, because RV16\'s front end is small. On 3·x + y over 16 words one lane runs 151 instructions, four lanes 43: 4 300 NAND delays against 14 798, 3.4× faster for 3.3× the NANDs of one core. The saving that grows with the lane count is the instruction stream: one instruction memory and one fetch for four results. The 20 test programs take 810 cycles.',
    alts: [{ name: 'Four single-cycle cores', nand: 18880, note: '4 × 4 720: the measured rv16_cpu' }, { name: 'One single-cycle core', lib: 'rv16_cpu' }, { name: 'One shared memory port: the RV32 lane core\'s sequencer', lib: 'memseq4' }],
    // The core is compared whole: the after-pass card must not price the given lane decoder against four cores.
    counts: 'rv16_simd',
  },
  k_stack: {
    problem: 'When the active lanes disagree on an if, one PC has to run both sides, one after the other, and then bring the lanes back together. <code>split rs1</code> divides the active lanes into <i>then</i> (rs1 ≠ 0) and <i>else</i> and pushes an entry: the mask before the split, the else lanes, the address after the split and <i>pending</i> (both sides have lanes). The first <code>join</code> on a pending entry switches the mask to the else lanes and jumps back; the second restores the saved mask and pops. Nested ifs push nested entries: a stack.',
    without: 'The SIMD core follows the leader: lanes that disagree with it run the wrong side of the if and write wrong results. Data-dependent control flow takes hand-written mask juggling with <code>tmc</code>.',
    cost: '1 995 NANDs, period 19. Four entries of 26 bits (mask 4, else 4, resume pc 16, pending, valid), each bit an enable flip-flop (104 × 13 = 1 352), with a 26-bit 2:1 mux in front of each entry that shifts down on a push and up on a pop; the then / else split and the join logic are the rest. As a shift register the top entry has a fixed place, so join reads it without a pointer or a read mux. Four entries are four nested ifs: a fifth split drops the bottom entry (the golden model stops with an error). The RV32 lane core\'s mask and stack together, with 32-bit resume addresses and its <code>pred</code> instruction, are 3 630 NANDs.',
  },
  k_simt: {
    problem: 'The SIMD core with the stack. split\'s predicate is the lanes\' nz (each lane\'s rs1 ≠ 0), its resume address the next-PC logic\'s pc + 1; the mask loads when <code>tmc</code> runs or the stack changes it, tmc winning; one more 16-bit mux sends the PC to jpc when a join jumps. Each lane can now run a scalar program with its own control flow: the lanes are threads, and only the time shows that they share a PC.',
    without: 'The SIMD core: correct only on programs whose branches every active lane agrees on.',
    cost: '17 732 NANDs, +2 063 over the SIMD core: the stack 1 995, the PC mux 49, a 4-bit mask mux 16, an OR. Period unchanged at 100: the stack sits beside the load path, not on it. The 25 programs take 919 cycles. Divergence now costs time instead of correctness: the if / else test runs 14 instructions at 71% lane utilization, two lanes on each side; the nested ifs 19 at 59%.',
    alts: [{ name: 'SIMD core (no split / join)', lib: 'rv16_simd' }],
  },
  k_coal: {
    problem: 'The lane cores give every lane a memory port: four memories, or one memory with four ports, which real SRAM does not have. One port as wide as a line (four RV16 words) serves several lanes at once when their words share the line. The coalescer decides each access: the leader (lowest active lane) picks the line, every active lane whose address has the same bits 15 … 2 rides along, and the lanes left over wait for the next access.',
    without: 'One port serves one lane per cycle: a load with four active lanes takes four cycles, which is what chapter 29\'s RV32 lane core does. With neighbouring threads on neighbouring words (thread i on element i, the usual layout), the coalescer makes it one.',
    cost: '467 NANDs, depth 27: a 4:1 bus mux for the leader\'s line (147), three 14-bit equality comparators (96 each: lane 0, when active, is the leader and needs none), the leader logic, an AND per lane and a 4-bit XOR for the lanes left. Its outputs drive a sequencer that loops over lines (one access, then mask := left) instead of over lanes. Chapter 32\'s RV32 access unit does the same over 16-byte lines, plus the bank picking of shared memory and the byte lanes of every word.',
    alts: [{ name: 'Chapter 32\'s access unit (RV32)', nand: 5870, depth: 58, note: 'accessUnit(4) in lib/warpmem.ts, measured: 30-bit byte addresses, the bank picker of shared memory, a word select per lane.' }],
  },
  k_warps: {
    problem: 'Real memory answers late: here one cycle (a synchronous RAM reads at the clock edge), in a GPU hundreds. Two warps that take turns hide it: warp 0\'s load goes out in its turn, the word comes back during warp 1\'s turn and is written then, through a second write port, and by warp 0\'s next turn it is in the register. Each warp needs its own state, PC, mask, stack and lane registers; fetch, decode, control and the lanes are shared, and a bit that toggles every cycle says whose turn it is. <code>bar</code> holds a warp until the other arrives, so warps can share data through memory.',
    without: 'One warp on the same memory waits a cycle after every load whose word its next instruction uses (no forwarding can deliver a word the memory has not read yet). The 31 test programs are mostly arithmetic, so the turns win little here: 2 160 turns for both warps against 2 229 cycles for one warp after the other with a stall per load. With memory 8 cycles late, as in chapter 31, a lone warp waits at such loads for 8 cycles, and more warps fill them: saxpy over 64 elements takes 266 cycles on one warp, 172 on four.',
    cost: '29 974 NANDs, period 95: +12 242 over the SIMT core, 8 688 of them the second set of lane registers and 1 995 the second stack; 16-bit 2:1 muxes pick the issuing warp\'s operands and feed each register file its warp\'s results or the returning word. The two lane register files are 58% of the core: a warp costs its registers, which is why a GPU\'s register file is its largest structure and why the registers a thread uses limit how many warps fit. The period falls from 100 to 95: the memory\'s read now ends at the clock edge (8 delays off the longest path), and the warp-select muxes put 3 back.',
    alts: [{ name: 'SIMT core (one warp, memory at once)', lib: 'rv16_simt' }],
  },
  k_edge: {
    problem: 'Deciding whether a pixel is inside a triangle takes three edge functions, E = A·(x − xᵢ) + B·(y − yᵢ), each a sum of two products. The rasterizer evaluates them for every pixel it visits, one a cycle. Because E is linear, the next pixel to the right is E + 4A and the one below E + 4B (quarter-pixel units): after the first pixel, every value is one addition away. The stepper keeps E and the start of the band, R, so that a new row of tiles can begin from R + 4B.',
    without: 'Evaluating E from scratch costs two 8 × 8 multiplications per edge per pixel: six multipliers of the side quest\'s kind (about 500 NANDs each) to keep one pixel a cycle, against three adders.',
    cost: '963 NANDs, period 58: the two 16-bit registers are 416, the five 16-bit muxes that choose the base (E, R or 2E) and the operand (a, 4a, b or 4b) 294, the adder / subtractor 212, the command decoder 30. Chapter 33\'s stepper is the same idea at 18 bits with the tile test built in; here the test is the rasterizer\'s.',
    alts: [{ name: 'Chapter 33\'s edge stepper (18 bits, with the tile test)', lib: 'edge_step' }],
  },
  k_tile: {
    problem: 'The rasterizer must visit every pixel that may be inside, one a cycle, and should visit as few others as possible. The tile walk covers the bounding box in 4 × 4-pixel tiles, band by band. One TEST cycle at a tile\'s top-left pixel decides the whole tile (the rasterizer checks each edge at the tile\'s best corner); an accepted tile\'s 16 pixels follow in a column serpentine, so each step is one pixel up, down or right and the edge steppers only ever add.',
    without: 'A plain scan of the bounding box spends a cycle on every pixel of the box, inside or not: about twice the triangle\'s area for a typical triangle, far more for a thin diagonal one. Chapter 33 measured 1 914 cycles against 3 368 for its large triangle and 888 against 3 848 for a sliver.',
    cost: '479 NANDs, period 26: twelve flip-flops of state (busy, TEST, the pixel counter, the tile x and y, 156 in registers), three 4-bit incrementers (108), two 3-bit comparators for the last tile, and the logic that turns the position into the steppers\' commands. One extra register per edge (the band start R) is the stepper\'s share of the scheme.',
    alts: [{ name: 'Chapter 33\'s tile walk (64 × 64, with the set-up phases)', lib: 'rast_walk' }],
  },
  k_raster: {
    problem: 'A triangle has to become pixel writes. Set-up turns the three vertices into what the walk needs: each edge\'s A and B, the top-left bias that keeps shared edges from being drawn twice, the box in tiles, the tile test\'s offsets, and each E at the first tile. That last value is a product, and act 9 has no multiplier: each stepper computes its own E by shift-and-add, a doubling per bit of Δx and Δy, on the adder it already has, in 17 cycles. Twice the area comes free as the sum of the three E, and culls back faces.',
    without: 'With a multiplier the set-up is faster (chapter 33\'s takes 8 cycles on one 10 × 10 Booth multiplier of 1 601 NANDs), but act 9 would then depend on the side quest that builds it. Per triangle the difference is 11 cycles; the walk itself is the same.',
    cost: '9 188 NANDs, period 145: the three steppers 2 889, the tile walk 479; the rest is set-up and testing, nearly all of it adders: 72 four-bit adders (2 592) for A, B, Δx, Δy, the box and the offsets, six 16-bit adders (864) for the tile tests and the cull, and the 16-bit muxes (735) that feed the steppers their set-up operands. The set-up path sets the period. 7 439 cycles for the bench\'s 64 triangles, 19 of them set-up per triangle.',
    alts: [{ name: 'Chapter 33\'s rasterizer (64 × 64, Booth set-up)', lib: 'rasterizer' }],
  },
  k_frame: {
    problem: 'Programmable lanes and fixed-function hardware have to work together. The two-warp core computes where the vertices go and hands each triangle to the rasterizer by storing to its registers; the rasterizer writes the screen, which is ordinary memory the lanes can also read and write. While it draws, an instruction that would change its registers or read the screen must wait, or it would see a half-drawn picture: the core holds that warp\'s turn.',
    without: 'Without the hold, a program has to wait for the rasterizer by itself (poll a status word, or count cycles), and every program that forgets reads stale pixels. The hold makes a load from the screen a fence: correct by construction, at the price of the turns it waits.',
    cost: '40 275 NANDs, period 147: the two-warp core\'s 29 974, the rasterizer\'s 9 188, and 1 113 for the device: six 7-bit vertex registers and a 16-bit colour register, the address decoders on lane 0\'s port and every lane\'s, and the hold. The period is the rasterizer\'s set-up path. On the bench\'s 36 programs, 7 635 cycles.',
    alts: [{ name: 'Two warps, no device', lib: 'rv16_warps' }],
  },
  // ---- Act 10: memory ---------------------------------------------------------------------------
  m_sense: {
    problem: 'A DRAM cell is a 25 fF capacitor behind one transistor: it cannot drive a wire, it can only share its charge with one. Shared with a 100 fF bit line at VDD/2, a stored 1 lifts the line to 0.6 VDD and a 0 drops it to 0.4, and the cell is left at the same level. The column turns that into a bit (the sense amplifier against a twin reference line) and puts the charge back (the amplifier drives the line to a rail while the word line is still up).',
    without: 'Read the bit line with a logic gate and 0.4 to 0.6 VDD is neither 0 nor 1; and the cell, read once, holds 0.6: a second read would find almost nothing to tell.',
    cost: '34 transistors: the amplifier 8, the write driver 22 (its gates are NANDs at switch level), the two cells one each, and two of your own: the precharge transistor and the equalizer, which precharges the reference line through the bit line. A real chip pays one amplifier per column, shared by every cell on it: hundreds of cells per amplifier.',
  },
  m_bank: {
    problem: 'Once a row is open its words are a cycle away, and every other row is draining: a bank needs someone who remembers which row is open, decides when to close it, and opens every row again before its charge is gone. Here the array leaves all of that to you, as the DRAMs of the 1970s did: RAS-only refresh, a row pointer and a timer in the controller.',
    without: 'Without refresh the first row nobody touched for 288 cycles is gone; the long-pause trace loses one before its first request. Without the open row, every access pays an ACT and a PRE.',
    cost: '319 NANDs, period 30: the state is 165 (a flip-flop and three 4-bit registers: open row, refresh pointer, timer), two incrementers and a row comparator 66, the decisions the rest. 5 917 cycles over the eight traces.',
  },
  m_ctrl: {
    problem: 'A DDR chip does the refreshing itself when asked and keeps a row buffer per bank, but it has rules: a column command only tRCD after its row opened, data tCAS after a read, a row open at least tRAS, tRP before the next. The controller turns each request into the shortest legal sequence of commands, and fits a refresh in before the chip forgets.',
    without: 'Commands one cycle early read garbage or corrupt a row: the chip does not check, so the controller is the only thing standing between a timing table and silent data loss.',
    cost: '779 NANDs, period 36. One request at a time keeps it small: two since-counters (cycles since the last ACT and the last PRE) cover every timing for both banks, a 4-stage shift register follows a read to its data, an 8-bit counter schedules refresh. A controller that overlaps requests needs counters per bank and a queue: chapter 36\'s FR-FCFS. 10 690 cycles over the eight traces.',
  },
  m_bus: {
    problem: 'Two masters, three slaves, one set of wires: the bus has to pick who goes, route the request to the right slave, and bring the answer back to the right master, with a handshake that lets either side take its time. The arbiter must be fair (round robin) and must not take the bus from a transfer still waiting on a slow slave.',
    without: 'Each master needs its own path to every slave: two masters and three slaves are six sets of address and data wires, and a slave with two ports.',
    cost: '282 NANDs, period 26: four 16-bit muxes (196) carry the address and data out and the read data back; three flip-flops and a few gates are the arbiter, and a few more decode the address.',
  },
  m_dma: {
    problem: 'Copying a buffer costs a processor a load, a store and the loop around them for every word. A DMA engine is a master on the bus that does it alone: three register writes start it, an interrupt says it is done, and the processor is free in between.',
    without: 'The processor copies every word itself, at least four instructions a word, each load waiting on memory.',
    cost: '1 366 NANDs, period 48: four 16-bit registers (src, dst, count, the word in flight) are 832, three incrementers and the load muxes most of the rest. The count holds NOT(words left) and counts up, so the incrementer\'s carry says done with no comparator. 2 079 cycles for the bench\'s 30 copies, wait states included.',
  },
  m_flash: {
    problem: 'Flash keeps its data without power but cannot overwrite: a page is programmed once, then its whole block must be erased, and erasing is slow and wears the block out. The page store makes it look like a memory you can rewrite: every write goes somewhere erased, a table remembers where each page lives, and a collector reclaims blocks full of stale copies.',
    without: 'Rewriting a page in place means erasing its block first, losing the block\'s other pages unless they are saved and written back: a read-modify-write of four pages and a 20-cycle erase for every rewrite, and the hot block wears out first.',
    cost: '1 049 NANDs, period 38: the mapping table is 416 (eight 4-bit registers), the head and the victim block and page another 104, the rest the state machine and the address and data muxes. 7 844 cycles over the five traces, collections included.',
  },
  p_boot: {
    problem: 'A program\'s table sits in flash, where every load stalls the processor for 8 cycles. The DMA engine copies a word every 4 cycles and leaves the processor free: the question is what to do while it runs.',
    without: 'Loading every word from flash: 845 cycles for 64 words.',
    cost: 'Waiting for the interrupt and then summing the copy: 595 cycles for 64 words. Summing each word as soon as it has landed (0xFFF2 says how many are left): 470. Then the loop is the limit, about 7 cycles a word against the copy\'s 4: a shorter loop is worth more than a faster engine.',
  },
};
