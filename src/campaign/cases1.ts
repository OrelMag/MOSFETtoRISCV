// Level cases, acts 4–8 (the instruction set, the single-cycle core, the pipeline, the system, side
// quests): every build, core and program level, the optional ones included. The numbers are measured
// on the reference designs: NANDs and depth (sim/stats), clock periods by static timing (cores with
// the bench's 8-delay memories, corecheck corePeriod), cycles on the core bench's programs
// (coretests) and instructions on the puzzles' reference solutions. See cases.ts.

import type { LevelCase } from './cases';

export const CASES1: Record<string, LevelCase> = {
  // ---- Act 4: programs ------------------------------------------------------------------------
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
    cost: '23 words, 47 to 150 instructions (mean 78): at most nine subtractions per digit. On the divide core (Act 8) a <code>divu</code> and a <code>remu</code> per digit would cost 36 cycles at 18 per divide, more than the subtraction loop needs on average for the whole number.',
  },

  // ---- Act 5: the single-cycle core -----------------------------------------------------------
  c_imm: {
    problem: 'Constants travel inside instructions, in four formats: <b>I</b> = instr[15:10] (<code>addi</code>, <code>lw</code>, <code>jalr</code>), <b>S/B</b> = {instr[15:13], instr[6:4]}, in the f3 and rd positions (<code>sw</code> and the branch offsets), <b>J</b> = instr[15:7] (<code>jal</code>), <b>U</b> = {instr[15:7], instr[3]} &lt;&lt; 6 (<code>lui</code>). The generator delivers all four, sign-extended to 16 bits, and the core\'s 4:1 bus mux, steered by the control unit\'s <code>isel</code>, picks one. The sign bit is instr[15] in every format, so sign extension is a fan-out.',
    without: 'No instruction can carry a constant: no <code>addi</code>, no load or store offset, no branch or jump target.',
    cost: 'Zero NANDs, depth 0: splitters, mergers and the sign bit fanned out. Four formats do cost something, in the core: the 4:1 16-bit format mux, 192 NANDs. RV32\'s generator is also wiring per format, but picks among five 32-bit formats: 896 NANDs with its mux.',
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
    cost: '335 NANDs, depth 49. The less-than is a subtraction (217 NANDs, depth 44) and sets the depth; equality is 12 deep. In the pipelines the comparator runs in E behind the forwarding muxes, on Pipeline IV\'s critical path (period 82), and with fast adders it bounds the single-cycle core too. A magnitude comparator tree gives signed less-than in depth 23 for 237 NANDs.',
    alts: [{ name: 'Signed magnitude comparator (tree), less-than only', lib: 'cmp16s' }],
  },
  c_npc: {
    problem: 'Each cycle the PC loads one of three values: pc + 1 (the next word), pc + imm (a taken branch, or <code>jal</code>), or rs1 + imm (<code>jalr</code>: returns through ra, function pointers). <code>ld</code> = jal | jalr | (br &amp; take) tells the PC to load the target instead of counting. pc + 1 also feeds the result mux, because <code>jal</code> and <code>jalr</code> write it to rd as the return address.',
    without: 'The PC only counts: straight-line code, no loops, no calls.',
    cost: '440 NANDs, depth 38: two 16-bit ripple adders (144 NANDs, depth 36 each), the incrementer (80, depth 33) and a bus mux. Kogge–Stone adders double it to 884 NANDs for depth 33: the ripple incrementer then sets the depth.',
    alts: [{ name: 'Next PC with Kogge–Stone adders', lib: 'rv16_nextpc_ks' }],
  },
  c_core1: {
    problem: 'The first loop that runs by itself. The PC addresses the instruction memory; the control unit and the immediate generator decode the word; the register file reads rs1 = instr[9:7] and rs2 = instr[12:10]; the ALU computes on rs1 and rs2 or the immediate; the result mux writes rd = instr[6:4] at the clock edge. One instruction per cycle: R-type, <code>addi</code>, the immediate shifts and <code>lui</code>. No branches yet, so the PC only counts.',
    cost: '4 973 NANDs: the register file is 2 627 of them (53%), the ALU 1 250, the PC 448, control 200, and the three bus muxes (immediate format, ALU b, result) 448. Period 98 NAND delays with the bench\'s 8-delay memories: in one cycle the path runs PC → instruction memory → control → immediate mux → ALU → data memory → result mux → register file, and every instruction pays for the longest one.',
  },
  c_core2: {
    problem: '<code>lw</code> and <code>sw</code> reach the data memory. The ALU adds rs1 and the 6-bit offset (bimm = 1, operation add); a load writes <code>drdata</code> back through the result mux\'s second input, a store puts rs2 on <code>dwdata</code> and raises <code>dwe</code> for one clock edge. Addresses count 16-bit words, and the top nine (0xFFF7–0xFFFF) are devices, reached as negative offsets from x0.',
    without: 'Eight registers are all the data a program has: no arrays, no stack, no I/O.',
    cost: 'No new NANDs over Core I in the reference (4 973): the address is the ALU\'s add, and the load uses an input the result mux already had. The price is time: the data memory read sits behind the ALU in the same cycle, and fetch and load both read memory in that cycle, which is why a single-cycle core has separate instruction and data memories (Harvard).',
  },
  c_core3: {
    problem: 'Branches and jumps complete RV16I. The branch comparator reads rs1 and rs2, the next-PC logic loads the PC with pc + imm (a taken branch, <code>jal</code>) or rs1 + imm (<code>jalr</code>), and <code>jal</code> / <code>jalr</code> write pc + 1 to rd through the result mux\'s third input. Loops, calls and the stack of Act 4 now run on hardware built from NANDs, one instruction per cycle.',
    without: 'Straight-line code: each instruction runs once, and a loop of n iterations has to be written out n times.',
    cost: '+775 NANDs over Core II (branch comparator 335, next PC 440): 5 748 in all, period unchanged at 98 (the load path stays the longest). The 28 test programs take 1 236 cycles, 121 128 NAND delays. The five-stage pipeline of Act 6 runs them in 1 495 cycles at period 82, the multicycle core in 3 865 at period 78.',
    alts: [{ name: 'Single-cycle, Kogge–Stone adders', lib: 'rv16_cpu_ks' }, { name: 'Multicycle core', lib: 'rv16_mc' }, { name: 'Five-stage pipeline', lib: 'rv16_pipe_111' }],
  },
  c_computer: {
    problem: 'The core\'s pins expect memories that answer in the same cycle; so far the bench has provided them. Here they become parts: a 32-word ROM on pc[4:0] holds the program, a 64-word RAM on daddr[5:0] the data, and a 16-bit LED register is the output device. daddr[15] alone tells I/O from RAM (partial decoding): a store with bit 15 set writes the LEDs and leaves the RAM alone.',
    without: 'The core runs only on a test bench that serves its memory from outside.',
    cost: '28 143 NANDs, of which the 64-word RAM is 20 166 (72%): about 79 transistors per stored bit, decoder and read mux included, against 6 in an SRAM cell. Partial decoding costs a NOT and two ANDs, and every address with bit 15 set aliases the LED register. Period 110, against 98 on the core bench\'s 8-delay memories.',
  },
  c_fast: {
    problem: 'Every instruction pays Core III\'s slowest path: PC → instruction memory → control → ALU → data memory → result mux → register file, 98 delays, of which the ripple ALU is 50. Static timing names the path; Kogge–Stone adders, carries in logarithmic depth instead of a chain, shorten it without changing a single instruction or cycle.',
    without: 'The same 1 236 cycles at period 98.',
    cost: 'The reference swaps the ALU and both next-PC adders: 6 410 NANDs (+662, +12%) for period 81 (−17%), so the 28 programs take 100 116 NAND delays instead of 121 128. The critical path then moves to the branch: instruction memory → register file → comparator (49 deep: its less-than is a subtraction) → next PC → PC.',
    alts: [{ name: 'Kogge–Stone ALU', lib: 'alu16ks' }, { name: 'Ripple ALU', lib: 'alu16' }],
  },

  // ---- Act 6: the pipeline --------------------------------------------------------------------
  pi_reg: {
    problem: 'The four pipeline registers (F/D, D/E, E/M, M/W) carry what later stages need of the instruction they hold: the word, pc, operands, immediate, control bits, rd. Two hazards need more than a plain register. A load-use stall holds the PC and F/D (en = 0) so the waiting instruction is decoded again; a stall or a taken branch clears D/E (and a branch also F/D) to an all-zero bubble, whose control bits write no register and store nothing.',
    without: 'A plain register can neither hold nor bubble: the hazard unit and the branch redirect would have nothing to act on, and only code padded with nops by hand would run.',
    cost: '307 NANDs, period 8: a 16-bit register (240) behind a 2:1 bus mux that picks 0 (64), and an OR so that clr loads even when en = 0. The finished RV16 has 17 of them, 5 219 NANDs, 35% of the chip: the price of five instructions in flight.',
    alts: [{ name: 'Plain 16-bit register', lib: 'reg16' }],
  },
  pi_core0: {
    problem: 'Cut the datapath in five: F fetches, D decodes and reads registers, E computes, M reaches memory, W writes back. Each stage works on a different instruction, so the period is set by the slowest stage instead of the whole path. These programs keep every producer two instructions from its user and have no branches, and the register file writes at the falling edge, so an instruction three behind its producer reads the new value: no stage needs to know about another.',
    without: 'One instruction per 98-delay cycle, as in Core II.',
    cost: '10 290 NANDs, twice Core II, for period 65 instead of 98; the 15 pipeline registers are 4 605 of it. The stages are unbalanced: E needs 65 (the ripple ALU is 55 of it), the PC loop 43, every other stage 28 or less. The hazard-free code pays in nops: the 19 programs take 2 508 cycles with two after every instruction, where Core II runs them unpadded in 824. 163 020 NAND delays against 80 752.',
  },
  pi_fwd: {
    problem: 'An ALU result exists at the end of E but reaches the register file only from W, two cycles later. When the instruction in E reads a register that the one in M or W is about to write (rwe set, rd ≠ x0), the forwarding unit selects that value instead of the stale one read in D: <code>fa</code> / <code>fb</code> = 1 from M, 2 from W, 0 from the register file. M wins over W because it holds the newer write.',
    without: 'Two independent instructions or nops between every producer and its user: the 19 test programs take 2 508 cycles padded that way, 970 with forwarding (and a nop after each load).',
    cost: '110 NANDs, depth 13: four 3-bit equality comparators (19 NANDs each), two zero tests, a few gates. It sits in E in front of the ALU, so its 13 delays add to the slowest stage: Pipeline II runs at period 78 against 65. Comparing in D against the instructions then in E and M, and registering the selects, takes the comparators off that path.',
  },
  pi_core1: {
    problem: 'Now an instruction may use the result of the one just before it. Two 3:1 bus muxes in front of E pick each operand from the register file, from M (the result before memory: ALU, pc + 1 or immediate) or from W (the value being written back), steered by the forwarding unit. rs2 is forwarded too: stores write it and branches compare it.',
    without: 'Two nops after every instruction: 2 508 cycles on these programs instead of 970.',
    cost: '+686 NANDs (10 976) and the period rises from 65 to 78, but the 19 programs fall from 2 508 cycles to 970: 75 660 NAND delays, against 163 020 for Pipeline I and 80 752 for Core II. The pipeline now beats the single-cycle core, by 6%.',
  },
  pi_haz: {
    problem: 'A load\'s word comes out of memory at the end of M. If the very next instruction reads it, that instruction is already in E when the word appears, one cycle too early for forwarding. The hazard unit, in D, compares rs1 and rs2 with the rd of a load in E (rwe and wb = memory, rd ≠ x0) and raises <code>stall</code>: the PC and F/D hold, D/E takes a bubble, and a cycle later W forwards the loaded word.',
    without: 'The user reads the stale register, unless the program puts an independent instruction or a nop after every load.',
    cost: '53 NANDs, depth 12: two 3-bit comparators, a zero test and four gates. It is conservative: rs2 counts even for instructions that do not read it (<code>addi</code>, <code>lw</code>), which occasionally costs a needless stall and spares decoding which sources each opcode reads.',
  },
  pi_core2: {
    problem: 'Loads used at once. On a stall the PC and F/D keep their values, D/E clears to a bubble and the load moves on to M; the next cycle it is in W and the forwarding unit hands its word to the instruction waiting in E. One lost cycle per load-use pair, none for any other dependence.',
    without: 'A nop after every load instead: 970 cycles on these programs, against 917 with the stall.',
    cost: '+129 NANDs (11 105), period unchanged at 78. The stall is paid only when the next instruction reads the loaded register, where a nop is paid after every load. The 19 programs take 71 526 NAND delays, 11% less than on Core II.',
  },
  pi_core3: {
    problem: 'A branch or jump resolves in E, where the comparator and the next-PC logic run on forwarded operands. By then F and D hold the next two words, fetched on the guess that the branch falls through. On a taken branch or any jump, E loads the PC with the target and clears F/D and D/E, so the two wrong-path instructions never write anything.',
    without: 'The two instructions after a taken branch execute anyway: wrong-path code changes registers and memory.',
    cost: '+67 NANDs (11 172), period 82 (+4): forwarding → comparator → next PC → PC is now the critical path. Every taken branch and jump costs two cycles: the 28 Core III programs take 1 495 cycles against 1 236, and at period 82 against 98 the pipeline ends 1% slower than Core III (122 590 against 121 128 NAND delays). Branch prediction and earlier resolution are what make it pay.',
  },
  o_bpred: {
    problem: 'Loops take their closing branch almost every time, and Pipeline IV flushes two instructions for each one. Guessing in F avoids most of that: decode the fetched word (the immediate generator is wiring), and if it is <code>jal</code> or a branch with a negative offset (instr[15] = 1), fetch from pc + imm at once. E compares the guess with the outcome and redirects only on a miss: to the target, or back to pc + 1 when a predicted branch falls through.',
    without: 'Two flushed cycles per taken branch or jump: 2 653 cycles on the prediction programs.',
    cost: '+663 NANDs (11 835) for an adder and a decoder in F, period 85 (+3). Cycles fall 13% over the 31 programs (2 653 → 2 303) and 25% on the three loop programs (1 158 → 872). A dynamic predictor also learns forward branches, from per-branch history; its logic is small (a 2-bit counter\'s next state is 28 NANDs), its storage is not: RV32\'s 16-entry branch target buffer is 22 849 NANDs, twice this whole pipeline.',
    alts: [{ name: '2-bit saturating counter, next-state logic', lib: 'satctr' }, { name: '16-entry branch target buffer (RV32)', lib: 'btb16' }],
  },

  // ---- Act 7: the system ----------------------------------------------------------------------
  y_csr: {
    problem: 'The trap machinery keeps its state in control and status registers, read and written by <code>csrrw</code> / <code>csrrs</code> / <code>csrrc</code> with the CSR number in the rs2 field: mstatus (MIE bit 3, MPIE bit 7), mie (MEIE bit 11), mtvec (the handler\'s address), mepc (where the trap happened), mcause, mscratch; mip shows the interrupt line and mcycle reads 0. A trap writes three of them on one edge (mepc ← pc, mcause ← cause, MPIE ← MIE, MIE ← 0), and <code>mret</code> moves MPIE back into MIE.',
    without: 'Nowhere to keep the return address and the cause: a trap would destroy the state needed to resume, so neither exceptions nor interrupts can exist.',
    cost: '2 156 NANDs, period 19: six 16-bit registers (1 440) and the 8:1 read mux (448) are most of it. mepc and mcause each add a 2:1 mux (the written value or the trap\'s pc and cause); mstatus has its own next-value logic for MIE and MPIE. RISC-V addresses 4 096 CSRs with 12 bits; RV16\'s 3-bit field keeps eight.',
  },
  y_trap: {
    problem: 'Three events stop an instruction from running: <code>ecall</code> (a request to the system, cause 11), <code>ebreak</code> (a breakpoint, 3) and an illegal word (2): a SYSTEM, OPX or shift variant RV16 does not define, or any MD instruction without the M extension. The core then writes no register and stores nothing, saves pc in mepc and the cause in mcause, and loads mtvec into the PC; <code>mret</code> jumps back to mepc. The CSR instructions write the old value to rd as they update the CSR.',
    without: 'An undefined word executes as whatever its bits happen to select, and a program has no way to call the system or stop for a debugger.',
    cost: '9 004 NANDs, +3 256 over Core III: the CSR file 2 156, system decode 533 (it also computes the CSR write value: rs1, old | rs1 or old &amp; ¬rs1), the illegal detector 158, and the muxes for the cause, the target and the CSR result. Period 100 (+2): the CSR read joins the result mux.',
  },
  y_irq: {
    problem: 'A timer or a device raises <code>irq</code> between two instructions of a program that does not expect it. When intr = MIE · MEIE · irq is 1, the instruction at pc does not run: mepc ← pc, mcause ← 0x800B (bit 15: an interrupt; 11: external), pc ← mtvec, and MIE drops to 0 so the handler is not interrupted in turn. <code>mret</code> restores MIE and re-runs the instruction at mepc.',
    without: 'The program polls the device in a loop, spending cycles and missing anything that happens between two polls.',
    cost: 'Zero NANDs over Exceptions: the CSR file already computes intr and the cause mux had an input for it; the core only wires the pin in (9 004 NANDs, period 100). Checking before the instruction is simple in a single-cycle core; the pipeline takes the interrupt in E, on a valid instruction, like an exception.',
  },
  p_handler: {
    problem: 'An interrupt can land between any two instructions of main, so the handler must leave every register as it found it: push what it uses, read the device\'s word from IN, write it doubled to OUT, acknowledge the device (a store of 0 to IRQ, 0xFFF9), pop, <code>mret</code>. Main enables in order: mtvec, then mie bit 11 (MEIE), then mstatus bit 3 (MIE) last, so no interrupt arrives before there is a handler to take it.',
    without: 'Without the acknowledge, irq is still high when <code>mret</code> restores MIE, and the interrupt is taken again at once, forever. Without the save, main\'s t0 changes under it at an unpredictable instruction.',
    cost: '22 words, 10 of them the handler, which runs in full on every interrupt, whatever main was doing; <code>push</code> and <code>pop</code> are two instructions each (an <code>addi</code> of sp and a store or load).',
  },
  y_final: {
    problem: 'The pipeline with precise traps: when an instruction traps, every older instruction completes and no younger one has changed anything. Traps are taken in E, where the instruction has written nothing yet: M and W finish, F/D and D/E are flushed, the PC loads mtvec. A valid bit travels with every instruction, because a bubble\'s all-zero word is an illegal SYSTEM encoding; a CSR instruction reads and writes in E, and its old value travels down as the result.',
    without: 'An imprecise trap: mepc points near the culprit, a younger instruction may already have written a register, and the handler cannot resume the program.',
    cost: '15 050 NANDs, +3 878 over Pipeline IV: the CSR file, system decode, illegal detector and two more pipeline registers (F/D valid, D/E instr). Period 88 (+6): trap and <code>mret</code> join the redirect path to the PC. The 45 programs take 2 399 cycles, 211 112 NAND delays, against 197 600 on the single-cycle core with traps (1 976 cycles at period 100): with a ripple ALU and the branch comparator in E, a period of 88 against 100 does not cover the extra cycles.',
  },

  // ---- Act 8: side quests ---------------------------------------------------------------------
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
    cost: '9 125 NANDs (+3 377: the MD multiplier is 3 302, its array 2 672) and period 191 against 98: the multiplier\'s 166-deep path now runs register file → multiplier → register file within one cycle, and every instruction, <code>add</code> included, pays for it. Code without a multiply runs 1.95 times slower. Real cores give the multiplier pipeline stages of its own (the pipelined Booth multiplier: period 41, four cycles of latency) or a shallower tree.',
    alts: [{ name: 'Wallace-tree multiplier', lib: 'wmul16' }, { name: 'Booth radix-4 multiplier (signed)', lib: 'bmul16' }, { name: 'Pipelined Booth multiplier', lib: 'pmul16' }],
  },
  o_div: {
    problem: 'Long division in binary, one quotient bit per clock: shift the remainder left, bring in the next dividend bit, subtract the divisor; if the difference is not negative keep it and set the quotient bit, else keep the old remainder. An iteration counter runs the 16 steps: start loads a and b, done rises 18 cycles later. RISC-V\'s rule for b = 0 falls out of the hardware: every subtraction succeeds, so q = 0xFFFF and r = a.',
    without: 'Division in software: the same 16 steps as a loop, several instructions each.',
    cost: '1 490 NANDs, period 31, 18 cycles: 558 delays per division. Unrolled into an array divider the 16 steps cost 4 464 NANDs and a 613-deep path, each subtraction waiting on the previous one\'s borrow. Non-restoring division replaces the restore with an add-or-subtract and a final correction (1 878 NANDs, same cycles); radix-2 SRT keeps the remainder in carry-save form so the period no longer grows with the width (4 698, period 29); radix 4 retires two bits per cycle (6 815 NANDs, period 44, 11 cycles).',
    alts: [{ name: 'Array divider', lib: 'adiv16' }, { name: 'Non-restoring iterative divider', lib: 'nrsdiv16' }, { name: 'Radix-2 SRT divider', lib: 'srtdiv16' }, { name: 'Radix-4 SRT divider', lib: 'srt4div16' }],
  },
  o_dcore: {
    problem: 'A divide does not finish in one cycle. The core starts the divider when the instruction is a divide, then holds the PC on that instruction and writes nothing until done, 18 cycles later, when the result is written and the PC moves on: the single-cycle core\'s version of a stall. <code>div</code>, <code>divu</code>, <code>rem</code> and <code>remu</code> (f3 4–7) share one unsigned divider: |a| and |b| go in, the quotient takes the sign a XOR b (unless b = 0), the remainder the sign of a.',
    without: 'The core would write a quotient that is not ready, or stretch its clock to an array divider\'s 613-deep path.',
    cost: '11 724 NANDs (+2 599: the MD divider is 2 460, the unsigned divider 1 490 of it plus four 16-bit add / subtractors that take the signs off and put them back), period 193. The 23 test programs take 1 859 cycles for 959 instructions, each divide holding the core 18 cycles. A radix-4 SRT divider would take 11, for 6 815 NANDs.',
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
    cost: '264 NANDs, depth 21, for 13 bits and four levels: the adder places this one, and normalize &amp; round a 15-bit one (296) for results below the smallest normal. The ALU\'s 16-bit barrel shifter, without sticky logic but shifting both ways, is 389 NANDs, depth 14.',
    alts: [{ name: '16-bit barrel shifter (no sticky)', lib: 'shift16' }],
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
    cost: '2 058 NANDs, depth 86 for the adder\'s 15-bit significand (2 666, depth 90 for the multiplier\'s 22 bits): more than half of the binary16 adder (3 785). Once it exists, the adder, the multiplier and the converter are mostly wiring around it.',
  },
  o_fpadd: {
    problem: 'a + b in binary16: unpack both, swap so that |a| ≥ |b|, shift b right by the exponent difference keeping a sticky bit, add or subtract the significands (<code>sub</code> flips b\'s sign), then normalize &amp; round. The special cases wrap around it: a NaN in, or ∞ − ∞, gives the canonical NaN 0x7E00, and x − x is +0, except −0 when rounding down.',
    without: 'Floating-point addition in software: field extraction, shifts, compares and adds, dozens of integer instructions per operation.',
    cost: '3 785 NANDs, depth 163, normalize &amp; round 2 058 of them. The same design in binary32 (8-bit exponent, 23-bit fraction) is 8 218 NANDs, depth 181: area roughly doubles, depth grows by 18.',
    alts: [{ name: 'binary32 adder', lib: 'fpadd8_23' }],
  },
  o_fpmul: {
    problem: 'Multiplying floats needs no alignment: XOR the signs, add the exponents (less one bias), multiply the 11-bit significands into a 22-bit product, then normalize &amp; round. Two significands in [1, 2) give a product in [1, 4), so its top bit decides a shift by one place.',
    cost: '4 965 NANDs, depth 150: the 11 × 11 Wallace multiplier is 1 696 and the 22-bit normalize &amp; round 2 666. Shallower than the adder (163), which must align before it adds. An 11 × 11 array multiplier is smaller (1 232) but 100 deep against 48; binary32 takes 14 913 NANDs, the significand multiplier growing with the square of the width.',
    alts: [{ name: 'binary32 multiplier', lib: 'fpmul8_23' }],
  },
  o_fpcmp: {
    problem: '<code>feq</code>, <code>flt</code> and <code>fle</code>. The exponent sits above the fraction, so two non-negative floats order like 15-bit unsigned integers: compare |a| and |b| once. The signs then decide: two negatives reverse the order, different signs make the negative one smaller unless both are zeros (−0 = +0), and any NaN makes every comparison false (<code>unord</code>), a signaling one also raising <code>snan</code>.',
    cost: '682 NANDs, depth 25: two unpacks, a 15-bit Kogge–Stone subtractor and a 15-bit equality test for the magnitudes, and the sign and NaN logic. A 15-bit integer magnitude comparator alone is 222 NANDs, depth 23: the format keeps its special cases off the critical path.',
    alts: [{ name: '16-bit magnitude comparator (integers)', lib: 'cmp16' }],
  },
  o_fpcvt: {
    problem: '<code>fcvt</code> from a 16-bit integer: an integer is already a significand, its top bit worth 2<sup>15</sup>. Take the magnitude (a conditional negate when signed and negative), hand it to normalize &amp; round with exponent 15 + bias, and the leading-zero shift and the rounding do the rest. Integers above 2048 lose low bits (inexact); unsigned 65 535 lies past 65 504, the largest finite, and rounds to ∞ in some modes (overflow).',
    cost: '2 840 NANDs, depth 109: the 16-bit normalize &amp; round and a 16-bit conditional negate. No new arithmetic: the level is wiring around blocks already built.',
  },
  o_cache: {
    problem: 'Main memory is far slower than the core, and programs reuse the same words (locality). A cache keeps recent ones close: here eight one-word lines, index = addr[2:0], each holding its word, a 5-bit tag (addr[7:3]) and a valid bit. hit = valid and tag match; a read hit answers from the line, a miss from main memory, filling the line at the clock edge; a write fills the line and goes through to memory.',
    without: 'Every load waits for main memory, tens to hundreds of core cycles for DRAM. The RV16 bench answers in the same cycle, so here the cache is graded on its own cost.',
    cost: '3 527 NANDs, period 36, for 128 data bits: the data RAM (8 × 16) is 2 419 NANDs, the tag RAM (8 × 6) 939, the tag comparator 33. Tag and valid add 6 bits to every 16-bit line; longer lines share one tag among more words but fetch more on a miss. Direct mapping makes addresses with the same low three bits evict each other; two ways, two tags compared at once, avoid that.',
  },
  o_mc: {
    problem: 'Before pipelines, processors ran each instruction as several short steps under a state machine. A one-hot FSM steps F → E → (M) → W: F loads an instruction register, E registers the ALU result, M (loads and stores only) uses memory, W writes the register file and the PC. Two registers cut the single-cycle path, and the data memory gets a step of its own.',
    without: 'The single-cycle core: one instruction per 98-delay cycle.',
    cost: '6 223 NANDs (+475 over Core III), period 78 against 98, but 3 or 4 cycles per instruction: Core III\'s programs take 3 865 cycles instead of 1 236, 2.5 times slower overall (301 470 against 121 128 NAND delays). The period falls only 20% because E still holds the whole ripple ALU. Multicycle designs paid by sharing one ALU and one memory between the steps; this one shares nothing, keeping the separate memories and the next-PC adders.',
    alts: [{ name: 'Single-cycle core', lib: 'rv16_cpu' }],
  },
};
