// The campaign's lesson texts (HTML), by the `body` key of their node. Dense and concrete: what
// the thing is, what it costs, why the CPU needs it. No DOM.

export const LESSONS: Record<string, string> = {
  intro: `
<p>A processor is a <b>loop</b> around a little state: a <b>program counter</b> (PC), eight
<b>registers</b> and a <b>memory</b>. Each turn of the loop executes one instruction:</p>
<ol>
  <li><b>Fetch</b>: read the instruction word at address PC from the instruction ROM.</li>
  <li><b>Decode</b>: split it into fields; the <b>control unit</b> turns the opcode into the signals
  that steer every multiplexer; the <b>register file</b> reads the two source registers; the
  <b>immediate generator</b> extracts the constant.</li>
  <li><b>Execute</b>: the <b>ALU</b> computes (a sum, a comparison, an address); the
  <b>branch unit</b> decides whether to jump.</li>
  <li><b>Memory</b>: a load reads the <b>data RAM</b>, a store writes it (or a device, memory-mapped).</li>
  <li><b>Write back</b>: the result goes into the destination register. The <b>next-PC</b> logic
  picks PC + 1 or the jump target, and the loop goes round.</li>
</ol>
<p>The diagram is the machine you finish with: the five steps as a <b>pipeline</b>, five
instructions in flight, with the <b>forwarding</b> and <b>hazard</b> units that keep it correct and
the <b>CSRs</b> that handle traps and interrupts. Click a block: what it does, and the levels that
build it. Built blocks light up.</p>
<h4>Why this machine</h4>
<p><b>RV16</b> is RISC-V shrunk to 16 bits: 16-bit data and instructions, 8 registers with
x0 = 0, load / store, fixed field positions. Small enough to build by hand and test
thoroughly, real enough to run loops, functions, a stack and interrupt handlers. It counts in
<b>words</b>, not bytes: an address names a 16-bit word, so the next instruction is at <b>pc + 1</b>
(RISC-V's is pc + 4).</p>
<h4>Why in this order</h4>
<p>Each act supplies what the next one needs; nothing is placed before it is built.</p>
<ol>
  <li><b>Act 0</b> makes the one primitive, a CMOS NAND: 4 transistors, 1 delay, the unit every
  cost is counted in. <b>Act P</b>, optional beside it, builds the same logic in relays and tubes and loads a program from cards.</li>
  <li><b>Act 1, logic</b>: the gates, then what the control and the datapath are made of. Multiplexers
  route operands, a decoder picks the register to write (30 NANDs), an equality test decides
  <code>beq</code> (110).</li>
  <li><b>Act 2, arithmetic</b>: bits get a meaning, so one adder does add, sub, comparisons and every
  address. The ALU is 1 055 NANDs, depth 64; the fast adder (362 NANDs, depth 14 against the ripple
  adder's 36) waits for Core IV.</li>
  <li><b>Act 3, state</b>: feedback is the only way to remember. Latches, flip-flops, the PC, the register
  file: 2 172 NANDs, nearly half the core to come.</li>
  <li><b>Act 4, the instruction set</b>: what the hardware must do, learnt by programming it on the
  golden model before any of it is wired.</li>
  <li><b>Act 5, the single-cycle CPU</b>: your blocks wired into Cores I, II and III (4 720 NANDs, one
  instruction per 98-delay cycle) and a computer around them. It ends with <b>Core IV</b>, the fast adder
  on the critical path: period 76.</li>
  <li><b>Act 6</b> overlaps five instructions in a pipeline (9 218 NANDs, period 78); <b>act 7</b> lets it
  survive its own errors and listen to devices: traps and interrupts, 12 038 NANDs, the finale.</li>
  <li>Acts 8, 9 and 10 are optional: arithmetic units, a GPU, the memory behind the data port.</li>
</ol>
<h4>How the campaign works</h4>
<ul>
  <li>Every level builds one block from blocks you already have. It starts as a chip in the
  sandbox with its pins in place; <b>Check</b> runs the level's test set: every input
  combination up to 16 input bits, 4 096 random ones (after the level's edge cases) above that; a
  clocked sequence; or whole programs against a golden model.</li>
  <li>What you may use: NAND, wiring, your own chips, and the <b>parts unlocked</b> by the
  levels below. Solve a level and its block becomes a library part for the levels above.</li>
  <li><b>Grades</b>: ★ passes, ★★ within 1.5 × par, ★★★ at or under par on every metric
  (NANDs, depth, clock period, cycles…). Par is a target, never required.</li>
  <li>Stuck? Tips come one at a time, then <b>Show solution</b>. You may <b>skip</b> a level:
  its part unlocks as if you had built it. <b>Unlock all</b> opens every level at once.</li>
  <li>The <b>codex</b> collects every component, law and tool you meet. Your progress and your
  chips <b>export</b> to one file and import anywhere.</li>
</ul>`,

  bool: `
<p>Boolean algebra has two values and three operations: AND (·), OR (+), NOT (¬, or a bar). A
circuit and an expression are the same object; algebra rewrites one into a cheaper equivalent.</p>
<table class="cp-laws">
  <tr><th>Identity</th><td>a + 0 = a</td><td>a · 1 = a</td></tr>
  <tr><th>Null</th><td>a + 1 = 1</td><td>a · 0 = 0</td></tr>
  <tr><th>Idempotence</th><td>a + a = a</td><td>a · a = a</td></tr>
  <tr><th>Complement</th><td>a + ¬a = 1</td><td>a · ¬a = 0</td></tr>
  <tr><th>Absorption</th><td>a + a·b = a</td><td>a · (a + b) = a</td></tr>
  <tr><th>Distributivity</th><td>a·(b + c) = a·b + a·c</td><td>a + b·c = (a + b)(a + c)</td></tr>
  <tr><th>De Morgan</th><td>¬(a·b) = ¬a + ¬b</td><td>¬(a + b) = ¬a · ¬b</td></tr>
  <tr><th>Consensus</th><td colspan="2">a·b + ¬a·c + b·c = a·b + ¬a·c</td></tr>
</table>
<p>Each law has a <b>dual</b> (swap + ↔ · and 0 ↔ 1). Three moves reach most pars in this campaign:</p>
<ul>
  <li><b>Sum of products → NAND–NAND.</b> f = p1 + p2 = ¬(¬p1 · ¬p2): a NAND per product, one NAND
  to combine. Two levels, no OR gates.</li>
  <li><b>Bubble pushing.</b> Move an inversion through a gate with De Morgan (AND ↔ OR); two bubbles on
  one wire cancel. Aim for every gate a NAND and no inverters.</li>
  <li><b>Sharing.</b> A sub-expression computed once feeds several outputs. XOR in 4 NANDs shares
  ¬(a·b) between both halves; the full adder's carry reuses the XORs' first NANDs.</li>
</ul>
<p>To get a minimal sum of products from a truth table, use a <b>Karnaugh map</b> (next level) or,
beyond 4–5 variables, <b>Quine–McCluskey</b>.</p>
<h4>What the laws buy, worked</h4>
<table class="cp-laws">
  <tr><th>Block</th><th>As read off the table</th><th>Rewritten</th></tr>
  <tr><td>OR</td><td>a + b: no OR cell</td><td>¬(¬a · ¬b), De Morgan: 3 NANDs</td></tr>
  <tr><td>XOR</td><td>¬a·b + a·¬b: 5 NANDs</td><td>n = ¬(a·b) shared: ¬(¬(a·n) · ¬(b·n)), 4</td></tr>
  <tr><td>2:1 mux</td><td>NOT, two ANDs, an OR: 8 NANDs, depth 5</td><td>¬(¬(s·b) · ¬(¬s·a)), NAND–NAND: 4, depth 3</td></tr>
  <tr><td>Full adder</td><td>two half adders and an OR: 13 NANDs</td><td>the carry reuses both XORs' first NANDs: 9</td></tr>
</table>
<p>The single-cycle core has 705 bits of 2:1 mux and 64 full adders: rewrites at this scale are
thousands of NANDs.</p>
<h4>This act</h4>
<p>Act 1 builds, in this order: <b>NOT, AND, OR, XOR</b> (every later block is made of them); the
<b>2:1 multiplexer</b> (choosing between two values); <b>K-maps</b> and the <b>prime detector</b> (the
method the control unit of act 5 is built with); the <b>zero detect</b> (a wide gate, where depth
first matters: 31 delays as a chain, 9 as a tree); and three blocks the datapath reads: the
<b>decoder</b> (which register is written), the <b>bus multiplexer</b> (16 bits chosen at once) and
<b>equality</b> (<code>beq</code>, <code>bne</code>). Binary numbers come alongside, because the decoder and the prime
detector read their inputs as numbers.</p>`,

  mem: `
<p>You built memory from flip-flops: 13 NANDs per bit (a 9-NAND flip-flop and its 4-NAND enable
mux), a decoder on the write port and an 8:1 bus mux per read port. Your register file is about 2 200 NANDs
for 112 bits of state: some 20 NANDs, 80 transistors, a bit. Real memories use 6-transistor SRAM cells (caches, register files) or 1-transistor-1-capacitor DRAM cells (main
memory), with sense amplifiers to read them. From here on, memories are given as parts: the
instruction <b>ROM</b> (the program) and the data <b>RAM</b>.</p>`,

  isa: `
<p>An <b>instruction set</b> is the contract between software and hardware: what state exists,
what each instruction does to it, and how instructions are encoded as bits. Software is written
against it; the hardware may implement it any way it likes (single-cycle, pipelined…).</p>
<h4>RV16 in one table</h4>
<table class="cp-laws">
  <tr><th>State</th><td colspan="2">pc (16 bits, a word address) · x0…x7 (x0 = 0) · 64 K words of data memory</td></tr>
  <tr><th>Arithmetic</th><td>add sub and or xor sll srl sra slt sltu</td><td>rd ← rs1 op rs2</td></tr>
  <tr><th>Immediate</th><td>addi · slli srli srai · lui</td><td>rd ← rs1 + imm6 · shifts by 0…15 · rd ← imm10 &lt;&lt; 6</td></tr>
  <tr><th>Memory</th><td>lw rd, imm(rs1) · sw rs2, imm(rs1)</td><td>address = rs1 + imm6</td></tr>
  <tr><th>Branches</th><td>beq bne blt bge</td><td>pc ← pc + imm6 if the condition holds</td></tr>
  <tr><th>Jumps</th><td>jal rd, imm9 · jalr rd, imm(rs1)</td><td>rd ← pc + 1, then jump</td></tr>
</table>
<h4>Encoding: fields never move</h4>
<table class="cp-laws">
  <tr><th>bits</th><td>15:13</td><td>12:10</td><td>9:7</td><td>6:4</td><td>3:0</td></tr>
  <tr><th>R</th><td>f3</td><td>rs2</td><td>rs1</td><td>rd</td><td>op</td></tr>
  <tr><th>I</th><td colspan="2">imm[5:0]</td><td>rs1</td><td>rd</td><td>op</td></tr>
  <tr><th>S / B</th><td>imm[5:3]</td><td>rs2</td><td>rs1</td><td>imm[2:0]</td><td>op</td></tr>
  <tr><th>J</th><td colspan="3">imm[8:0]</td><td>rd</td><td>op</td></tr>
  <tr><th>U</th><td colspan="3">imm[9:1]</td><td>rd</td><td>imm[0] · 111</td></tr>
</table>
<p>op: 1 OP, 2 OPX (sub, sra), 4 ADDI, 5 SHI, 6 LW, x111 LUI (7 and 15: bit 3 is imm[0]), 8–11 BEQ BNE BLT BGE, 12 JAL, 13 JALR,
14 SW, 0 SYSTEM, 3 MD (multiply / divide, optional). The ALU control is just {op = OPX, f3}. Because
rs1 and rs2 are always in the same place, the register file is read while the control unit is still
decoding.</p>
<h4>Assembly</h4>
<p>One instruction per line, <code>label:</code> names an address, <code>#</code> starts a comment.
Pseudo-instructions expand to real ones: <code>li a0, 1000</code> (lui + addi), <code>mv</code>,
<code>j</code>, <code>call</code> / <code>ret</code>, <code>beqz</code>, <code>push</code> / <code>pop</code>,
<code>halt</code> (<code>jal x0, 0</code>). Memory-mapped I/O sits at the top of data memory:
<code>lw a0, -4(x0)</code> reads IN, <code>sw a0, -3(x0)</code> writes OUT, <code>-2</code> is the console.</p>`,

  datapath: `
<p>Follow <code>add a0, a1, a2</code>: the PC addresses the ROM; the word's rs1 and rs2 fields go
straight to the register file's read ports; the control unit sees op = OP and sets the ALU to f3;
the ALU adds; the result goes back to the register file's write port with rd as its address and
we = 1; the PC becomes PC + 1 at the clock edge. Everything happens between two edges.</p>
<p>Other instructions reuse the same path with different <b>mux settings</b>: ADDI takes the ALU's
second operand from the immediate; LW sends the ALU result to the data memory and writes back what
it reads; SW writes rs2 to memory and nothing to a register; branches compare rs1 and rs2 and load
the PC with PC + imm; JAL writes PC + 1 and jumps. The control unit is the table of those settings.</p>`,

  pipe: `
<p>A single-cycle CPU's clock period must fit the slowest instruction end to end. Cut the datapath
into five <b>stages</b> (fetch, decode, execute, memory, write back) with <b>pipeline registers</b>
between them, and each clock period only has to fit the slowest stage: up to five times faster,
with five instructions in flight.</p>
<p>The price is <b>hazards</b>. A <b>data hazard</b>: an instruction needs a register its predecessor
has not written back yet. <b>Forwarding</b> takes the value from the E/M or M/W register instead.
A load's value only exists after M, so a dependent instruction right behind it must <b>stall</b> one
cycle. A <b>control hazard</b>: by the time a branch is resolved in E, two younger instructions were
fetched from the wrong path: <b>flush</b> them. CPI rises above 1, and the shorter period has to pay for it.</p>
<p>In RV16 it pays only once E is short too. E holds the forwarding muxes and then the ALU, the branch
comparator and next PC side by side: with ripple adders that is 78 delays, and the pipeline is 4% faster
than Core III but slower than Core IV. With Kogge–Stone adders in E (the ALU, the comparator's less-than,
next PC) its period falls to 56, and it beats Core IV by 11%, for 10 102 NANDs against 4 938.</p>`,

  traps: `
<p>Programs make mistakes (an illegal instruction), ask for help (<code>ecall</code>), and the world
interrupts them (a device raises a line). In each case the CPU must stop what it is doing <b>between two
instructions</b>, remember where it was, and run a <b>handler</b>.</p>
<p>The trap machinery is a handful of <b>CSRs</b>: <code>mtvec</code> (the handler's address),
<code>mepc</code> (where to come back), <code>mcause</code> (why; bit 15 = interrupt),
<code>mstatus</code> (MIE: interrupts enabled; MPIE: its saved copy) and <code>mie</code> / <code>mip</code>
(which interrupts are enabled / pending). A trap does, atomically: mepc ← pc, mcause ← cause,
MPIE ← MIE, MIE ← 0, pc ← mtvec. <code>mret</code> undoes it: pc ← mepc, MIE ← MPIE.</p>
<p>An exception's mepc is the faulting instruction (the handler adds 1 to skip it); an interrupt's
is the next instruction to run. In a pipeline, traps must be <b>precise</b>: everything older
completes, nothing younger leaves a trace.</p>`,

  arith: `
<p>Act 4 multiplied in software: a shift-and-add loop of 28 to 134 instructions per product. This act
builds that arithmetic in hardware, more than one way, and every level measures the result: the unit's
NANDs and its depth or period, and on the core levels the cycles your programs take.</p>
<h4>Multiply and divide</h4>
<p>The <b>shift-and-add multiplier</b> is the Act 4 loop as a circuit: one adder used once a clock,
18 cycles a product on 1 169 NANDs. The <b>array multiplier</b> forms every partial product at once:
16 × 16 is 2 672 NANDs and 150 delays deep, a product in one pass. Put the array in your single-cycle
core and every instruction pays for it: the period goes from 98 to 191, so a program without a single
multiply runs 1.95 times slower. A <b>divider</b> is iterative however you build it, so the core must
hold its PC until the quotient is ready: its first instruction that takes more than one cycle.</p>
<h4>Floating point</h4>
<p>Binary16 by hand first, then its units one rung each: unpack, the rounding decision, the sticky
shifter, the leading-zero counter, and normalize &amp; round (2 058 NANDs), which every operation ends
in. On those the adder is 3 732 NANDs and the multiplier 4 912. They stay units of their own: RV16 has
no F registers and no FP instructions, so no core here runs them.</p>`,

  gpu: `
<p>Your core is built for <b>latency</b>: one program, each instruction done as soon as
possible. The pipeline of Act 6 goes further the same way: forwarding, stalls, flushes and
prediction all serve that one instruction stream. But
much of computing is the <b>same short program over many data</b>: every pixel of a frame, every
element of an array. There the useful number is <b>throughput</b>, results per second, and the
instructions of different data do not depend on each other at all.</p>
<p>So share what is the same and replicate what is not. One PC, one instruction memory, one control
unit; four <b>lanes</b>, each with its own registers, ALU and memory port. Every lane runs every
instruction on its own operands: four results per cycle for one fetch and one decode.
<code>csrr rd, tid</code> gives each lane its <b>thread number</b>, the only thing that tells them
apart at the start.</p>
<h4>What it costs</h4>
<p>The control is cheap: the SIMD core you will build adds about 11 000 NANDs to your single-cycle
core for three extra lanes. Most of that is <b>registers</b>: four register files are 8 688 NANDs.
A real GPU is the same, with its register file the largest structure on the chip.</p>
<h4>The hard part</h4>
<p>One PC cannot go two ways. When the lanes disagree on a branch, something has to give: an
<b>active mask</b> turns lanes off (they compute, but write nothing), and a <b>stack</b> remembers
the lanes waiting for the other side of an if. Each side then runs with some lanes idle:
<b>lane utilization</b>, not the clock, becomes the number to watch.</p>
<p>This act builds the lanes, their register file, the mask, then a SIMD core; then the
reconvergence stack and the SIMT core, on which every lane runs like a thread of its own.</p>`,
  memwall: `
<p>Every core of this campaign reads its data memory in the cycle it asks. A real main memory
cannot: it is <b>DRAM</b>, one transistor and one capacitor per bit, and a bit is a few tens of
femtofarads, too little to drive anything. Reading means sharing that charge with a <b>bit line</b>
precharged to VDD/2, which moves by a tenth of the supply, and letting a <b>sense amplifier</b>
decide which way it moved. The amplifier then drives the line to a rail, which writes the cell back:
every read destroys and restores.</p>
<p>A word line opens a whole <b>row</b> at once, so a chip has an amplifier per column, and those
amplifiers hold the open row: the <b>row buffer</b>. A word of the open row is a column access away
(tCAS); any other row needs the open one closed (tRP) and the new one opened (tRCD) first. At
DDR4-3200 and our clock those are 4 cycles each: a row hit costs 4, a row conflict 12, before any
data moves.</p>
<h4>Forgetting</h4>
<p>The capacitors leak. Every row must be opened again within its retention time (64 ms in a real
chip), and nothing in the processor does it: the <b>controller</b> does, row by row, in cycles taken
from the requests. Early chips (the 4116) left the row counter to the controller; from the mid-1980s
chips kept it inside (CAS-before-RAS refresh, then SDRAM's and DDR's auto refresh), so today's only need
a <b>REF</b> command every 7.8 µs (tREFI), with every bank closed.</p>
<p>This act builds that path: a column at switch level, a bank that refreshes itself around a cell
array, then a controller that turns requests into commands at the earliest cycle a chip's timing
rules allow, and decides how long a row stays open.</p>`,
};
