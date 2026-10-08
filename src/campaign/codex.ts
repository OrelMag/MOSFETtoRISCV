// The codex: what the campaign teaches, as reference entries the learner collects. Components
// (what you built), laws (Boolean algebra), tools (methods: K-maps, Quine–McCluskey), concepts
// (numbers, timing, architecture) and tricks (the moves that reach par). Entries unlock with
// the levels that list them (progress.ts codexUnlocked). No DOM.

export type CodexKind = 'component' | 'law' | 'tool' | 'concept' | 'trick';

export interface CodexEntry {
  id: string;
  title: string;
  kind: CodexKind;
  /** HTML. Dense: definitions, formulas, costs. */
  body: string;
  related?: string[];
}

export const CODEX_KINDS: { id: CodexKind; title: string }[] = [
  { id: 'component', title: 'Components' }, { id: 'law', title: 'Laws' }, { id: 'tool', title: 'Tools' },
  { id: 'trick', title: 'Tricks' }, { id: 'concept', title: 'Concepts' },
];

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX: CodexEntry[] = [
  // ---- the big picture
  E('cpu', 'Processor (CPU)', 'concept', 'A finite-state machine that interprets a program stored in memory. Its state: the <b>PC</b> (address of the next instruction), the <b>registers</b> and <b>memory</b>. Every cycle it applies one instruction to that state. RV16: 16-bit words, 8 registers, separate instruction and data memories.', ['fde', 'datapath', 'control']),
  E('fde', 'Fetch, decode, execute', 'concept', '<b>Fetch</b>: instr = imem[pc]. <b>Decode</b>: split the fields, read rs1 and rs2, build the immediate, set the control signals. <b>Execute</b>: the ALU computes. <b>Memory</b>: load or store. <b>Write back</b>: rd ← result. <b>Next PC</b>: pc + 1 or a target. A single-cycle CPU does all of it between two clock edges; a pipeline gives each step its own stage.', ['cpu', 'pipeline']),
  E('abstraction', 'Abstraction', 'concept', 'Each level is built only from the one below and then used as a black box: transistor → gate → adder → ALU → datapath → CPU. You may open any box. Cost (gates, delay) adds up through the levels, so an optimisation low down pays everywhere above.', ['cpu']),

  // ---- transistors
  E('mosfet', 'MOSFET', 'component', 'A voltage-controlled switch. <b>NMOS</b> conducts when its gate is 1 and passes a strong 0; <b>PMOS</b> conducts when its gate is 0 and passes a strong 1. Switch-level simulation here: rails > transistors > resistors > stored charge.', ['cmos']),
  E('cmos', 'CMOS', 'concept', 'Complementary MOS: a PMOS pull-up network to VDD and its dual NMOS pull-down network to GND. For every input exactly one conducts, so the output is always driven and no static current flows. Series in one network ⇔ parallel in the other. CMOS gates are naturally <b>inverting</b>.', ['mosfet', 'duality', 'nand']),
  E('inverter', 'Inverter', 'component', 'y = ¬a. One PMOS (VDD → y), one NMOS (y → GND), gates on a. 2 transistors. Built from NAND: 1 NAND with both inputs tied (4 transistors: why cell libraries keep a real inverter).', ['not', 'cmos']),
  E('nand', 'NAND', 'component', 'y = ¬(a·b). NMOS in series (pull down only if a = b = 1), PMOS in parallel. 4 transistors, 1 delay. On this site the unit of area is the NAND and the unit of time is a NAND delay.', ['universality']),
  E('nor', 'NOR', 'component', 'y = ¬(a + b). NMOS in parallel, PMOS in series. Also universal, but its series PMOS (holes are 2–3× less mobile) make it slower or bigger than the NAND.', ['duality', 'nand']),
  E('universality', 'Functional completeness', 'law', 'NAND alone implements every Boolean function: NOT a = NAND(a, a); AND = NOT(NAND); OR = NAND(¬a, ¬b). Since any function is a sum of products, any circuit is NANDs. NOR is complete too; AND and OR alone are not (no inversion).', ['nand', 'nandnand']),
  E('duality', 'Duality', 'law', 'Swap AND ↔ OR and 0 ↔ 1 in a true identity and you get another true identity. In CMOS: the pull-up network is the dual (series ↔ parallel) of the pull-down.', ['identities', 'cmos']),

  // ---- algebra and gates
  E('truthtable', 'Truth table', 'tool', 'The complete specification of a combinational function: one row per input combination, 2^n rows. Every combinational level here is checked against its truth table (exhaustively up to 16 input bits).', ['sop']),
  E('identities', 'Boolean identities', 'law', '<code>a + 0 = a, a·1 = a</code> (identity) · <code>a + 1 = 1, a·0 = 0</code> (null) · <code>a + a = a</code> (idempotence) · <code>a + ¬a = 1, a·¬a = 0</code> (complement) · <code>¬¬a = a</code> · <code>a + a·b = a, a·(a + b) = a</code> (absorption) · <code>a·b + ¬a·c + b·c = a·b + ¬a·c</code> (consensus) · <code>a·(b + c) = a·b + a·c</code> and <code>a + b·c = (a + b)(a + c)</code> (distributivity, both ways).', ['demorgan', 'duality']),
  E('demorgan', "De Morgan's laws", 'law', '<code>¬(a·b) = ¬a + ¬b</code> and <code>¬(a + b) = ¬a·¬b</code>. An inversion moves through a gate by flipping AND ↔ OR. A NAND is an OR with inverted inputs: the basis of NAND–NAND logic and of bubble pushing.', ['bubble', 'nandnand']),
  E('bubble', 'Bubble pushing', 'trick', 'Draw inversions as bubbles and slide them along wires with De Morgan. Two bubbles on one wire cancel. Goal: every gate becomes a NAND (or NOR) and no inverter is left. AND–OR becomes NAND–NAND for free.', ['demorgan', 'nandnand']),
  E('sop', 'Sum of products (SoP)', 'tool', 'Any function = OR of the minterms where it is 1 (canonical SoP). Minimise it (K-map, Quine–McCluskey), then build two levels: ANDs then an OR. Dually, product of sums (PoS) from the 0s. A PLA is a programmable SoP.', ['kmap', 'qm', 'nandnand']),
  E('nandnand', 'NAND–NAND logic', 'trick', 'An SoP f = p1 + p2 + … is ¬(¬p1 · ¬p2 · …): first-level NANDs make the ¬pi, one NAND combines them. Two gate levels, no inverters except for complemented literals.', ['sop', 'bubble']),
  E('kmap', 'Karnaugh map', 'tool', 'The truth table drawn in Gray-code order so that neighbours differ in one variable (edges wrap around). Circle rectangles of 1, 2, 4, 8 ones: each rectangle is a product term without the variables that change inside it. Cover every 1 with the fewest, largest rectangles. Practical up to 4–5 variables.', ['sop', 'qm', 'dontcare']),
  E('qm', 'Quine–McCluskey', 'tool', 'The K-map as an algorithm: merge minterms differing in one bit into implicants, repeat until no merge is possible (prime implicants), then choose a minimum cover (essential primes first). Exact, exponential in the worst case; the site\'s PLA uses it (lib/storage.ts minimize).', ['kmap']),
  E('dontcare', "Don't-cares", 'trick', 'Inputs that never occur, or outputs nobody reads (a control signal of an instruction that ignores it), may be 0 or 1: put them in a K-map group when it makes the group larger. The control unit is full of them.', ['kmap', 'control']),
  E('not', 'NOT', 'component', '1 NAND (inputs tied), depth 1.', ['inverter']),
  E('and', 'AND', 'component', 'NAND + NOT: 2 NANDs, depth 2. Every enable in the CPU.', ['nand']),
  E('or', 'OR', 'component', '¬(¬a·¬b): 3 NANDs, depth 2.', ['demorgan']),
  E('xor', 'XOR', 'component', 'a ⊕ b = 1 when the inputs differ. 4 NANDs: n = ¬(a·b), y = ¬(¬(a·n)·¬(b·n)). Sum bit of an adder, controlled inverter (b ⊕ sub), one-bit inequality. XNOR = ¬XOR.', ['halfadder', 'comparator']),
  E('mux', 'Multiplexer', 'component', 'y = s ? b : a = s·b + ¬s·a. 4 NANDs, depth 3. A wide mux is one per bit sharing ¬s; an N:1 mux is a tree of log2 N levels. Muxes are where the control unit steers the datapath.', ['bus', 'control']),
  E('fanin', 'Fan-in and fan-out', 'concept', 'Fan-in: inputs of a gate (a 4-input NAND has 4 series NMOS: slower). Fan-out: inputs a net drives (more load: slower). Here every NAND costs one delay whatever its load; real cells do not.', ['depth']),
  E('depth', 'Logic depth', 'concept', 'The longest input → output path, in gate delays. It sets how fast a combinational block settles. A chain of n 2-input gates has depth n − 1; a balanced tree log2 n.', ['criticalpath']),
  E('decoder', 'Decoder', 'component', 'n inputs → 2^n outputs, exactly one 1 (one-hot). Output k = AND of the address bits or their complements. With an enable: AND it in. Selects the register to write, the memory word, the MMIO device.', ['regfile', 'ram']),
  E('bus', 'Bus', 'concept', 'A bundle of wires carrying one value (16 bits in RV16). Splitters and mergers only rename wires: they cost nothing. Operations on buses are a gate per bit.', ['mux']),
  E('comparator', 'Equality comparator', 'component', 'a = b ⇔ every bit of a ⊕ b is 0: n XORs and an n-input NOR tree (depth ≈ 3 + 2·log2 n). Branches (beq / bne), forwarding (register numbers), cache tags.', ['xor', 'fanin']),

  // ---- numbers and arithmetic
  E('positional', 'Positional notation', 'concept', 'Bits b(n−1)…b0 mean Σ bk·2^k. n bits: 0 … 2^n − 1. Converting: repeated division by 2 (or subtract the largest power). Doubling is a left shift.', ['hex']),
  E('hex', 'Hexadecimal', 'concept', 'Base 16, one digit per 4 bits: 0x3C = 0011 1100. Used for addresses and machine words because it maps exactly onto bits.', ['positional']),
  E('twos', "Two's complement", 'concept', 'The top bit weighs −2^(n−1): range −2^(n−1) … 2^(n−1) − 1 (−32768 … 32767 at 16 bits). −x = ¬x + 1. The same adder adds signed and unsigned numbers; only comparison and overflow differ.', ['overflow', 'signext', 'subtract']),
  E('overflow', 'Overflow', 'concept', 'Unsigned: a carry out of the top bit. Signed: both operands have the same sign and the sum has the other (V = carry into the top bit ⊕ carry out). RISC-V does not trap on overflow: software checks if it cares.', ['twos', 'flags']),
  E('signext', 'Sign extension', 'concept', 'Widen a two\'s-complement number by copying its sign bit: 6-bit 111011 (−5) → 16-bit 0xFFFB. Every RV16 immediate is sign-extended (wiring only: the sign bit fans out).', ['twos', 'immediates']),
  E('halfadder', 'Half adder', 'component', 's = a ⊕ b, c = a·b: 5 NANDs (the XOR\'s first NAND inverted gives the carry).', ['fulladder']),
  E('fulladder', 'Full adder', 'component', 's = a ⊕ b ⊕ cin, cout = maj(a, b, cin). 9 NANDs, depth 6 (two XORs share their first NANDs with the carry).', ['majority', 'ripple']),
  E('majority', 'Majority', 'concept', 'maj(a, b, c) = a·b + a·c + b·c = a·b + cin·(a ⊕ b): 1 when at least two inputs are. The carry of a full adder.', ['fulladder']),
  E('ripple', 'Ripple-carry adder', 'component', 'n full adders, carry from bit k to k + 1. 9n NANDs, depth ≈ 2n + 4: the carry chain is the critical path of most simple CPUs.', ['cla', 'criticalpath']),
  E('incrementer', 'Incrementer', 'component', 'a + 1: half adders only (b = 0, cin = 1). Cheaper than an adder; the PC uses one.', ['halfadder', 'pc']),
  E('subtract', 'Subtraction', 'trick', 'a − b = a + ¬b + 1: XOR each b bit with sub, feed sub into the carry in. One adder/subtractor serves add, sub, slt, sltu and the branch comparisons.', ['twos', 'xor']),
  E('flags', 'Comparison from subtraction', 'trick', 'From a + ¬b + 1: unsigned a < b ⇔ carry out = 0; equal ⇔ result = 0; signed a < b ⇔ N ⊕ V (the result\'s sign, corrected for overflow).', ['overflow', 'subtract']),
  E('shifter', 'Barrel shifter', 'component', 'log2 n levels of muxes; level k shifts by 2^k when shamt bit k = 1. 16 bits: 4 levels × 16 muxes. Right arithmetic shifts fill with the sign bit.', ['mux']),
  E('alu', 'ALU', 'component', 'The arithmetic-logic unit computes every operation in parallel and selects one. RV16 control = {OPX, f3}: add, sub, sll, slt, sltu, xor, srl, sra, or, and.', ['subtract', 'shifter', 'flags']),
  E('cla', 'Carry lookahead', 'tool', 'Per bit: generate g = a·b, propagate p = a ⊕ b; carry c(k+1) = gk + pk·ck. Expanding the recurrence computes carries in parallel. Prefix adders (Kogge–Stone, Brent–Kung) do it in log2 n levels.', ['prefix', 'ripple']),
  E('prefix', 'Prefix adder', 'tool', '(G, P) pairs combine associatively: (g1, p1) ∘ (g0, p0) = (g1 + p1·g0, p1·p0). A parallel-prefix tree computes every carry in log2 n levels. Kogge–Stone: minimum depth, most wires.', ['cla']),

  // ---- state
  E('feedback', 'Feedback', 'concept', 'An output fed back to an input makes a circuit with state: its output depends on its past. Two inverters in a ring hold a bit; an odd ring oscillates.', ['latch']),
  E('latch', 'SR latch', 'component', 'Two cross-coupled NANDs, active-low set and reset. Releasing both at once races (metastability). 2 NANDs.', ['dlatch']),
  E('dlatch', 'D latch', 'component', 'Transparent while e = 1, holding while e = 0. 4 NANDs.', ['dff']),
  E('dff', 'D flip-flop', 'component', 'Master–slave: two latches on opposite clock phases capture d at the rising edge. 9 NANDs here; clk-to-q 3 delays, setup 3.', ['edge', 'setuphold']),
  E('edge', 'Edge triggering', 'concept', 'State changes only at clock edges, so all registers update together and every combinational path has a whole cycle to settle. This discipline is what makes large synchronous designs tractable.', ['dff']),
  E('setuphold', 'Setup and hold', 'concept', 'd must be stable for setup before the edge and hold after it. Period ≥ clk-to-q + logic delay + setup. Hold violations (paths too short) cannot be fixed by slowing the clock.', ['criticalpath']),
  E('register', 'Register', 'component', 'n flip-flops sharing a clock, each with a mux feeding q back when en = 0.', ['clockgating']),
  E('clockgating', 'Never gate the clock', 'trick', 'clk AND en glitches when en changes while clk is high, and delays the clock (skew). Use a mux (load enable) instead. Real clock gating uses a latch-based cell.', ['register']),
  E('counter', 'Counter', 'component', 'Register + incrementer: q ← q + 1 every edge (with enable and synchronous reset).', ['incrementer']),
  E('pc', 'Program counter', 'component', 'The register holding the current instruction\'s address. Next value: 0 on reset, pc + 1, a branch target, or a jump target (next-PC logic).', ['fde']),
  E('fsm', 'Finite-state machine', 'tool', 'A state register plus next-state and output logic. Design: list states, draw transitions, encode (binary, one-hot), write tables, minimise. Moore outputs depend on the state, Mealy on state and inputs.', ['microcode']),
  E('ram', 'RAM', 'component', 'Words of registers: a decoder enables the word written, a mux selects the word read. Real RAM is an array of 6T SRAM or 1T1C DRAM cells with sense amplifiers.', ['decoder']),
  E('regfile', 'Register file', 'component', 'RV16: 8 × 16 bits, two read ports (combinational 8:1 bus muxes), one write port (decoder ∧ we → register enables). x0 has no storage: it reads 0.', ['decoder', 'mux']),
  E('rom', 'ROM', 'component', 'Read-only memory: a function from address to word (a mux tree over constants, or a PLA). The program memory.', ['harvard']),
  E('harvard', 'Harvard architecture', 'concept', 'Separate instruction and data memories, so fetch and a load happen in the same cycle. RV16 here is Harvard and word-addressed; von Neumann machines share one memory (and one port).', ['rom']),

  // ---- ISA and software
  E('isa', 'Instruction set architecture', 'concept', 'The contract: registers, instructions, encodings, memory model, traps. Software depends only on it; hardware implements it any way it likes (single-cycle, pipelined, out of order).', ['rv16']),
  E('rv16', 'RV16', 'concept', '16-bit RISC-V-like ISA. 8 registers (x0 = 0, x1 ra, x2 sp, x3–x5 a0–a2, x6–x7 t0–t1). Word-addressed. Opcodes: SYSTEM, OP, OPX, MD, ADDI, SHI, LW, LUI, BEQ/BNE/BLT/BGE, JAL, JALR, SW. See docs/CAMPAIGN.md §3.', ['formats', 'immediates']),
  E('formats', 'Instruction formats', 'concept', 'RV16 fields never move: op [3:0], rd [6:4], rs1 [9:7], rs2 [12:10], f3 [15:13]. R uses all; I puts imm6 in [15:10]; S/B split imm6 around rs2; J and U use [15:7]. Fixed positions mean the register file can be read before the instruction is fully decoded.', ['immediates']),
  E('immediates', 'Immediates', 'concept', 'Constants inside the instruction: I imm6 = instr[15:10]; S/B imm6 = {instr[15:13], instr[6:4]}; J imm9 = instr[15:7]; U imm10 = {instr[15:7], instr[3]} << 6. All sign-extended except U. li v = lui %hi(v) + addi %lo(v).', ['signext', 'formats']),
  E('assembly', 'Assembly language', 'tool', 'One line per instruction, with labels for addresses and pseudo-instructions (li, mv, j, call, ret, beqz…) that expand to real ones. The assembler is two-pass: first label addresses, then encodings.', ['isa']),
  E('branches', 'Branches and jumps', 'concept', 'beq/bne/blt/bge: pc ← pc + imm6 if the condition holds. jal: rd ← pc + 1, pc ← pc + imm9. jalr: rd ← pc + 1, pc ← rs1 + imm6 (returns, function pointers). Loops are backward branches.', ['pc']),
  E('loadstore', 'Load / store', 'concept', 'Only lw and sw touch memory: address = rs1 + imm6. Every other instruction works on registers. This keeps the datapath simple and the pipeline regular.', ['harvard']),
  E('callconv', 'Calling convention', 'concept', 'Arguments in a0–a2, result in a0, return address in ra, sp the stack pointer. The callee saves what it changes beyond the scratch registers. call f = jal ra, f; ret = jalr x0, 0(ra).', ['stack']),
  E('stack', 'Stack', 'concept', 'Memory below sp used last-in first-out: push = addi sp, sp, −1; sw r, 0(sp). Saves ra and locals across calls, so functions can call functions.', ['callconv']),
  E('shiftadd', 'Shift and add', 'tool', 'Multiplication in binary: for each 1 bit of b, add a shifted left by its position. n iterations of add and shift. The same loop in hardware is the sequential multiplier.', ['arraymul']),
  E('mmio', 'Memory-mapped I/O', 'concept', 'Devices appear as memory addresses: a store to 0xFFFB sets the LEDs, a load from 0xFFFA reads the switches. A decoder on the address picks memory or a device; no new instructions needed.', ['decoder']),

  // ---- the CPU
  E('datapath', 'Datapath', 'concept', 'The blocks that hold and transform data (PC, memories, register file, immediate generator, ALU, muxes) and the buses between them.', ['control']),
  E('control', 'Control unit', 'component', 'Combinational logic from the opcode (and f3) to the control signals: register write, ALU source, ALU operation, memory write, result source, branch, jump. A table first, then logic (with plenty of don\'t-cares).', ['dontcare', 'sop']),
  E('singlecycle', 'Single-cycle CPU', 'concept', 'Each instruction completes in one clock cycle. CPI = 1, but the period must fit the slowest instruction (a load: fetch + register read + ALU + memory + write back).', ['cpi']),
  E('cpi', 'CPI and the iron law', 'law', 'Time = instructions × CPI × clock period. A single-cycle CPU has CPI 1 and a long period; a pipeline a short period and CPI slightly above 1 (stalls, flushes). Optimise the product, not one factor.', ['criticalpath', 'pipeline']),
  E('criticalpath', 'Critical path', 'concept', 'The slowest register-to-register path; it sets the minimum clock period. Speeding up anything else changes nothing. Static timing finds it without simulating.', ['setuphold', 'depth']),
  E('pipeline', 'Pipelining', 'concept', 'Registers between the stages (F, D, E, M, W) let five instructions overlap. The period drops to the slowest stage plus register overhead; latency per instruction does not improve. Hazards are the price.', ['hazards', 'cpi']),
  E('hazards', 'Hazards', 'concept', '<b>Data</b> (RAW): an instruction needs a result not yet written back. <b>Control</b>: the next PC is unknown until a branch resolves. <b>Structural</b>: two stages want one resource. WAR and WAW cannot happen in an in-order 5-stage pipeline.', ['forwarding', 'loaduse', 'controlhazard']),
  E('forwarding', 'Forwarding', 'trick', 'Take an operand from the E/M or M/W pipeline register when its rd equals the instruction\'s rs (and rd ≠ x0), newest first. Resolves most RAW hazards without stalling.', ['hazards', 'comparator']),
  E('loaduse', 'Load-use hazard', 'concept', 'A load\'s data exists only after M; the next instruction needs it in E. Stall one cycle (hold F and D, bubble into E), then forward.', ['stall']),
  E('stall', 'Stall', 'concept', 'Hold the PC and the F/D register (enable = 0) and inject a bubble (a nop) into the next stage. Costs a cycle.', ['flush']),
  E('flush', 'Flush', 'concept', 'Turn wrongly fetched instructions into bubbles (clear their pipeline registers\' valid / control bits). After a taken branch resolved in E: two instructions flushed.', ['controlhazard']),
  E('controlhazard', 'Control hazard', 'concept', 'The pipeline fetches before knowing where a branch goes. Options: stall, predict not taken and flush, resolve earlier (in D), predict.', ['bpred', 'flush']),
  E('bpred', 'Branch prediction', 'tool', 'Guess the next PC at fetch: static (backward taken), 2-bit saturating counters per branch, a branch target buffer for the target. Misprediction costs a flush.', ['controlhazard']),
  E('traps', 'Traps', 'concept', 'An exception (ecall, ebreak, illegal instruction) or an interrupt makes the CPU save the PC in mepc, the reason in mcause, disable interrupts and jump to mtvec. mret returns: pc ← mepc, interrupts restored.', ['csr', 'interrupts']),
  E('csr', 'Control and status registers', 'component', 'mstatus (MIE, MPIE), mie, mip, mtvec, mepc, mcause, mscratch, mcycle; read and written atomically by csrrw / csrrs / csrrc.', ['traps']),
  E('interrupts', 'Interrupts', 'concept', 'An external event (timer, device) taken between two instructions when enabled (mstatus.MIE and the mie bit). The handler saves what it uses, services the device, mret.', ['traps', 'precise']),
  E('precise', 'Precise exceptions', 'concept', 'Every instruction before the trapping one has completed, none after it has changed state. In a pipeline: take traps in one stage, in program order, and flush younger instructions.', ['flush', 'traps']),

  // ---- side quests
  E('arraymul', 'Array multiplier', 'component', 'All n² partial-product bits (ANDs) summed by rows of adders (or a Wallace tree of 3:2 compressors). One cycle, about n² full adders.', ['shiftadd']),
  E('mext', 'M extension', 'concept', 'mul, mulh(su/u), div(u), rem(u). In RV16 the MD opcode. Division by zero returns all ones (quotient) and the dividend (remainder): no trap.', ['division']),
  E('division', 'Division', 'tool', 'Restoring: shift the remainder left, subtract the divisor, keep the result if non-negative (quotient bit 1). One bit per cycle; SRT and radix 4 do more per step.', ['fsm']),
  E('ieee754', 'IEEE 754', 'concept', 'Sign, biased exponent, fraction with an implicit leading 1. binary16: 1 + 5 + 10 bits, bias 15. Special values: ±0, subnormals, ±∞, NaN.', ['rounding']),
  E('rounding', 'Rounding', 'concept', 'Round to nearest, ties to even, using guard, round and sticky bits. Every FP operation is exact then rounded once.', ['ieee754']),
  E('cache', 'Cache', 'component', 'A small fast memory of recently used lines: index → set, tag compare → hit. Misses fetch from the next level. Direct-mapped, set-associative; write-through or write-back.', ['comparator']),
  E('microcode', 'Microcode', 'tool', 'Control as a program: each state is a ROM word of control signals and a next-state field. Easier to change than hardwired logic, usually slower.', ['fsm', 'control']),
  E('multicycle', 'Multicycle processor', 'concept', 'One instruction over several short cycles (fetch, execute, memory, write back), with registers between the steps and a state machine (or microcode) in charge. The period shrinks to the slowest step, but CPI grows to 3–5: it wins only when the steps share hardware (one memory, one ALU for pc + 1 and the address). Pipelining keeps the short period and brings CPI back to about 1.', ['fsm', 'microcode', 'cpi', 'pipeline']),
  E('signedmul', 'Signed products from an unsigned multiplier', 'trick', 'As unsigned, a negative 16-bit a is worth a + 2^16. So (a + 2^16) · b = a · b + b · 2^16: the low half is the same either way, and the signed high half is the unsigned one <b>minus b when a &lt; 0</b> (minus a when b &lt; 0, both when both are signed). One multiplier, two subtractors: mul, mulh, mulhsu and mulhu.', ['mext', 'twos']),
];

export const codexById = (id: string): CodexEntry | undefined => CODEX.find((e) => e.id === id);
