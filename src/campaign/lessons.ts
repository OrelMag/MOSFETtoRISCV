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
<ul>
  <li><b>OR</b>: a + b has no cell; ¬(¬a · ¬b), De Morgan: 3 NANDs.</li>
  <li><b>XOR</b>: ¬a·b + a·¬b: 5 NANDs; with n = ¬(a·b) shared, ¬(¬(a·n) · ¬(b·n)): 4.</li>
  <li><b>2:1 mux</b>: NOT, two ANDs, an OR: 8 NANDs, depth 5; ¬(¬(s·b) · ¬(¬s·a)), NAND–NAND: 4, depth 3.</li>
  <li><b>Full adder</b>: two half adders and an OR: 13 NANDs; the carry reuses both XORs' first NANDs: 9.</li>
</ul>
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
for 112 bits of state: some 20 NANDs, 80 transistors, a bit. A 64-word RAM built the same way is 20 166
NANDs, over four times the whole single-cycle core of Act 5.</p>
<p>Real memories are <b>arrays</b>: an SRAM bit is 6 transistors (caches, register files), a DRAM bit one
transistor and a capacitor (main memory), read through shared bit lines and sense amplifiers. Act 10
builds both. From here on they are given parts:</p>
<table class="cp-laws">
  <tr><th>ROM</th><td>the program</td><td>word = rom[addr], combinational: no clock</td></tr>
  <tr><th>RAM</th><td>the data</td><td>read combinationally; written at the rising edge when we = 1</td></tr>
</table>
<h4>Why two</h4>
<p>A single-cycle core fetches an instruction and loads a data word in the same cycle, so it needs two
ports: an instruction memory and a data memory (<b>Harvard</b>). On the core levels the bench plays both,
answering in the same cycle and counting 8 NAND delays each in the clock period. <i>A computer</i>, at the
end of Act 5, wires real ones to your core.</p>`,

  isa: `
<p>An <b>instruction set</b> is the contract between software and hardware: what state exists,
what each instruction does to it, and how instructions are encoded as bits. Software is written
against it; the hardware may implement it any way it likes (single-cycle, pipelined…). This act
programs RV16 on its golden model; Act 5 builds the hardware, one path per instruction class you used.</p>
<h4>RV16 in one table</h4>
<table class="cp-laws">
  <tr><th>State</th><td colspan="2">pc (16 bits, a word address) · x0…x7 (x0 = 0) · 64 K words of data memory</td></tr>
  <tr><th>Arithmetic</th><td>add sub and or xor sll srl sra slt sltu</td><td>rd ← rs1 op rs2</td></tr>
  <tr><th>Immediate</th><td>addi · slli srli srai · lui</td><td>rd ← rs1 + imm6 · shifts by 0…15 · rd ← imm10 &lt;&lt; 6</td></tr>
  <tr><th>Memory</th><td>lw rd, imm(rs1) · sw rs2, imm(rs1)</td><td>address = rs1 + imm6</td></tr>
  <tr><th>Branches</th><td>beq bne blt bge</td><td>pc ← pc + imm6 if the condition holds</td></tr>
  <tr><th>Jumps</th><td>jal rd, imm9 · jalr rd, imm(rs1)</td><td>rd ← pc + 1, then jump</td></tr>
</table>
<h4>Registers by name</h4>
<table class="cp-laws">
  <tr><th>x0</th><td>zero</td><td>always 0; writes are dropped</td></tr>
  <tr><th>x1</th><td>ra</td><td>return address: <code>call</code> writes it</td></tr>
  <tr><th>x2</th><td>sp</td><td>stack pointer, counts down, kept across calls</td></tr>
  <tr><th>x3–x5</th><td>a0–a2</td><td>arguments; a0 the result; a call may change them</td></tr>
  <tr><th>x6–x7</th><td>t0–t1</td><td>temporaries</td></tr>
</table>
<p>a0 is x3, not RISC-V's x10: three-bit register fields leave room for eight registers.</p>
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
<h4>Ranges</h4>
<table class="cp-laws">
  <tr><th>imm6</th><td>−32 … 31</td><td>addi, lw / sw offsets, jalr, branch distances (words)</td></tr>
  <tr><th>imm9</th><td>−256 … 255</td><td>jal distance (words)</td></tr>
  <tr><th>imm10</th><td>0 … 1023</td><td>lui: the value loaded is imm10 × 64</td></tr>
  <tr><th>shift</th><td>0 … 15</td><td>slli srli srai; sll srl sra use rs2's low four bits</td></tr>
</table>
<p>Farther than 32 words from a base, the address goes into a register first.</p>
<h4>Devices: the top of data memory</h4>
<p>Seven addresses are devices, reached from x0 with a negative offset (<code>lw a0, -4(x0)</code> reads IN):</p>
<table class="cp-laws">
  <tr><th>−1</th><td>0xFFFF</td><td>EXIT: a store ends the program</td></tr>
  <tr><th>−2</th><td>0xFFFE</td><td>CONSOLE: a store prints a character</td></tr>
  <tr><th>−3</th><td>0xFFFD</td><td>OUT: a store writes a word to the output</td></tr>
  <tr><th>−4</th><td>0xFFFC</td><td>IN: a load takes the next input word</td></tr>
  <tr><th>−5</th><td>0xFFFB</td><td>LEDS: a store sets the lights</td></tr>
  <tr><th>−6</th><td>0xFFFA</td><td>SWITCHES: a load reads them</td></tr>
  <tr><th>−7</th><td>0xFFF9</td><td>IRQ: a store of 1 raises the interrupt line, of 0 clears it (Act 7)</td></tr>
</table>
<h4>Assembly</h4>
<p>One instruction per line, <code>label:</code> names an address, <code>#</code> starts a comment,
<code>.data</code> / <code>.word</code> place data. Pseudo-instructions expand to real ones:</p>
<table class="cp-laws">
  <tr><th>li rd, v</th><td>1 word</td><td>addi rd, x0, v if v fits imm6; lui alone for a multiple of 64</td></tr>
  <tr><th></th><td>2 words</td><td>lui + addi otherwise; <code>la</code> always</td></tr>
  <tr><th>push r</th><td>2 words</td><td>addi sp, sp, −1 · sw r, 0(sp)</td></tr>
  <tr><th>pop r</th><td>2 words</td><td>lw r, 0(sp) · addi sp, sp, 1</td></tr>
  <tr><th>call f · ret</th><td>1 word each</td><td>jal ra, f · jalr x0, 0(ra)</td></tr>
  <tr><th>mv · j · beqz</th><td>1 word each</td><td>addi rd, rs, 0 · jal x0, t · beq rs, x0, t</td></tr>
  <tr><th>halt</th><td>0x000C</td><td>jal x0, 0: a jump to itself, which the golden model and the benches stop on</td></tr>
  <tr><th>nop</th><td>0x0004</td><td>addi x0, x0, 0</td></tr>
  <tr><th>seqz rd, rs</th><td>3 words</td><td>there is no sltiu</td></tr>
</table>
<h4>What is left out, and what it costs</h4>
<p>No <code>andi</code> / <code>ori</code> / <code>xori</code>: put the constant in a register first, one
instruction more. No <code>slti</code>, <code>bltu</code> or <code>bgeu</code>: <code>sltu</code> then
<code>bnez</code>. No bytes: memory is word addressed, so a pointer steps by 1. Each omission is decoder
logic and an immediate format the core does not have to pay for.</p>`,

  datapath: `
<p>A single-cycle core does one instruction between two rising edges. Everything in between is
combinational; only three things change at the edge: the PC, x[rd] (if <code>rwe</code>) and M[daddr]
(if <code>dwe</code>). So the datapath is one loop: PC → instruction memory → fields, control, immediate →
register file → ALU → data memory → result mux → back into the register file, and through next PC into
the PC.</p>
<p>Follow <code>add a0, a1, a2</code>: the PC addresses the ROM; the word's rs1 and rs2 fields go
straight to the register file's read ports; the control unit sees op = OP and sets the ALU to f3;
the ALU adds; the result goes back to the register file's write port with rd as its address and
we = 1; the PC becomes PC + 1 at the clock edge.</p>
<h4>One path, different settings</h4>
<div style="overflow-x: auto"><table class="cp-laws">
  <tr><th></th><td>ALU b</td><td>immediate</td><td>ALU op</td><td>rd ←</td><td>memory</td><td>next PC</td></tr>
  <tr><th>R-type</th><td>rs2</td><td>–</td><td>{OPX, f3}</td><td>ALU</td><td>–</td><td>pc + 1</td></tr>
  <tr><th>addi</th><td>imm</td><td>I</td><td>add</td><td>ALU</td><td>–</td><td>pc + 1</td></tr>
  <tr><th>slli srli srai</th><td>imm</td><td>I</td><td>sll srl sra</td><td>ALU</td><td>–</td><td>pc + 1</td></tr>
  <tr><th>lui</th><td>–</td><td>U</td><td>–</td><td>imm</td><td>–</td><td>pc + 1</td></tr>
  <tr><th>lw</th><td>imm</td><td>I</td><td>add</td><td>memory</td><td>read</td><td>pc + 1</td></tr>
  <tr><th>sw</th><td>imm</td><td>S/B</td><td>add</td><td>no write</td><td>write rs2</td><td>pc + 1</td></tr>
  <tr><th>branches</th><td>–</td><td>S/B</td><td>–</td><td>no write</td><td>–</td><td>take ? pc + imm : pc + 1</td></tr>
  <tr><th>jal</th><td>–</td><td>J</td><td>–</td><td>pc + 1</td><td>–</td><td>pc + imm</td></tr>
  <tr><th>jalr</th><td>–</td><td>I</td><td>–</td><td>pc + 1</td><td>–</td><td>rs1 + imm</td></tr>
</table></div>
<p>A dash is a don't-care. The table is the control unit; the rest is wiring between blocks you own:
the register file 2 172 NANDs, the ALU 1 055, the branch comparator 287, next PC 421, control 200.
Core III is 4 720 NANDs, nearly half of it the register file.</p>
<h4>Where the clock period goes</h4>
<p>The slowest instruction sets the period for all of them, and that is a load: PC → instruction memory →
control (13 delays) → ALU → data memory → result mux → register file, 98 NAND delays with the bench's
8-delay memories, 50 of them in the ripple ALU. An <code>add</code> needs less and waits anyway; Core I,
with no loads, runs at 84. There are two ways out: shorten the path (fast adders: Core IV, period 76,
the last level of this act) or cut it into stages (Act 6's pipeline, period 78).</p>
<h4>In this act</h4>
<p>The immediate generator, the control unit and the branch comparator first, then next PC; then three
cores, each the last one grown: Core I runs arithmetic, Core II adds loads and stores, Core III branches
and jumps. <i>A computer</i> puts real memories and LEDs around Core III, and Core IV shortens its
critical path.</p>
<p>The usual mistakes: <code>sw</code> writing a register (its bits 6:4 are imm[2:0], so rwe must be 0); a
branch target taken from the ALU; <code>jal</code> writing pc + imm instead of pc + 1; <code>lui</code>
sent through the ALU.</p>`,

  pipe: `
<p>A single-cycle CPU's clock period must fit the slowest instruction end to end: a load, through
the instruction ROM, decode and the register file, the ALU, the data RAM and back to the register file.
That is 98 delays on Core III and 76 on Core IV, and while a load crosses the data RAM the decoder and
the ALU sit idle. Cut the datapath into five <b>stages</b> (fetch, decode, execute, memory, write back)
with <b>pipeline registers</b> between them, and each clock period only has to fit the slowest stage,
with five instructions in flight.</p>
<p>"Up to five times faster" needs five equal stages, and RV16's are not. E holds the whole ALU: in
Pipeline I it is the slowest stage by far, 65 delays, most of them the ripple ALU, so the period falls
from 98 to 65, not to a fifth of it. The registers are not free either: 260 NANDs each, twelve in
Pipeline I (3 120 NANDs), sixteen in the finished chip (4 160, a third of it).</p>
<h4>The hazards, one level each</h4>
<p>Five instructions in flight see each other's unfinished work. This act pays for that one hazard at
a time, and every level runs real programs against the golden model:</p>
<ul>
  <li><b>Pipeline I</b> handles none: its programs keep every producer two instructions from its user and
  never branch. The register file writes at the falling edge, so an instruction three behind its producer
  already reads the new value. Two nops after every instruction: 2 508 cycles on 19 programs.</li>
  <li><b>Data hazards</b>: a result exists at the end of E but reaches the register file from W, two
  cycles later. <b>Forwarding</b> (Pipeline II) takes it from M or W: the unit is 110 NANDs, but its
  13 delays land on E (period 65 → 78), and the nops go: 970 cycles.</li>
  <li>A load's word exists only after M, so its very next user must <b>stall</b> one cycle
  (Pipeline III: a 53-NAND hazard unit, 917 cycles). The stall is paid only when the next instruction
  reads the loaded register; a nop after every load was paid always.</li>
  <li><b>Control hazards</b>: a branch resolves in E, after two younger words were fetched on the guess
  "not taken". They are <b>flushed</b> when it is taken (Pipeline IV), so every taken branch or jump
  costs two cycles: 1 495 cycles on Core III's 28 programs against its 1 236.</li>
</ul>
<h4>The bill</h4>
<p>CPI rises above 1, and the shorter period has to pay for it. In RV16 it pays only once E is short too. E holds the forwarding muxes and then the ALU, the branch
comparator and next PC side by side: with ripple adders that is 78 delays, and the pipeline is 4% faster
than Core III but slower than Core IV. With Kogge–Stone adders in E (the ALU, the comparator's less-than,
next PC) its period falls to 56, and it beats Core IV by 11%, for 10 102 NANDs against 4 938.
Branch prediction, the act's optional level, attacks the cycles instead: 13% fewer on its loop
programs, at period 80, still slower than Core IV on its own. Real pipelines do both, and resolve
branches earlier.</p>
<h4>This act</h4>
<p>The pipeline register first (hold and clear), then Pipeline I; then each hazard as a unit and the
core that wires it in: forwarding and Pipeline II, the hazard unit and Pipeline III, then the flush,
Pipeline IV. Act 7 builds on Pipeline IV: precise traps, then interrupts. The multicycle core, before this
lesson on the map, is the older answer to the same long path, and shows why this one replaced it.</p>`,

  traps: `
<p>Core III runs any correct program. A real processor also meets three events it cannot handle
inline: a word that is no instruction (today it executes as whatever its bits select), a request to the
system (<code>ecall</code>), and a device that needs service now, which polling either catches late or
wastes cycles waiting for. In each case the CPU stops <b>between two instructions</b>, remembers where it
was and why, and runs a <b>handler</b>.</p>
<h4>The state: CSRs</h4>
<p>The trap machinery keeps its state in <b>CSRs</b>, apart from the eight registers the program owns:
<code>mtvec</code> (the handler's address), <code>mepc</code> (where to come back), <code>mcause</code>
(why: 2 an illegal instruction, 3 <code>ebreak</code>, 11 <code>ecall</code>, 0x800B the external
interrupt; bit 15 marks an interrupt), <code>mstatus</code> (MIE: interrupts on; MPIE: its saved copy)
and <code>mie</code> / <code>mip</code> (which interrupts are enabled / pending).</p>
<p>A trap does, on one edge: mepc ← pc, mcause ← cause, MPIE ← MIE, MIE ← 0 (so the handler is not
interrupted in turn), pc ← mtvec. <code>mret</code> undoes it: pc ← mepc, MIE ← MPIE.</p>
<h4>The protocol</h4>
<ul>
  <li>An exception's mepc is the faulting instruction, so an <code>ecall</code> handler adds 1 before
  returning (RV16 is word-addressed). An interrupt's mepc is the instruction that has not run yet, and the
  handler returns there unchanged.</li>
  <li>Software enables in order: mtvec, then mie, then MIE last, so no interrupt arrives before the handler
  exists.</li>
  <li>The handler acknowledges the device before <code>mret</code>, or the line is still high when MIE
  comes back on and the same interrupt is taken again at once. It saves every register it touches: main
  never knew it was there.</li>
</ul>
<h4>This act</h4>
<p>It builds the machinery twice. First on the single-cycle core: the CSR file (1 765 NANDs), exceptions
(2 537 over Core III) and the interrupt (0 more NANDs: what that level adds is the protocol above). Then in
the pipeline, where a trap must be <b>precise</b>: every older instruction completes and no younger one
leaves a trace. Pipeline V takes exceptions precisely (2 813 over Pipeline IV); the finale adds the
interrupt for 7 more, 12 038 NANDs in all. The interrupt handler, a program, is written in between.</p>`,

  arith: `
<p>Act 4 multiplied in software: a shift-and-add loop of 28 to 134 instructions per product. This act
builds that arithmetic in hardware, more than one way, and every level measures the result: the unit's
NANDs and its depth or period, and on the core levels the cycles your programs take.</p>
<h4>Multiply and divide</h4>
<p>The <b>shift-and-add multiplier</b> is the Act 4 loop as a circuit: one adder used once a clock,
18 cycles a product on 1 169 NANDs. The <b>array multiplier</b> forms every partial product at once:
16 × 16 is 2 672 NANDs and 150 delays deep, a product in one pass. Put the array in your single-cycle
core and every instruction pays for it: the period goes from 98 to 191, so a program without a single
multiply runs 1.95 times slower. A <b>divider</b> in one pass is 4 464 NANDs on a 613-deep path, so it
iterates (1 445 NANDs, 18 cycles), and the core must hold its PC until the quotient is ready: its first
instruction that takes more than one cycle.</p>
<h4>Floating point</h4>
<p>Binary16 by hand first, then its units one rung each: unpack, the rounding decision, the sticky
shifter, the leading-zero counter, and normalize &amp; round (2 058 NANDs), which every operation ends
in. On those the adder is 3 732 NANDs and the multiplier 4 912. They stay units of their own: RV16 has
no F registers and no FP instructions, so no core here runs them. The chapters' RV32 FPU is where such
units meet a register file.</p>
<h4>Two tracks</h4>
<ul>
  <li><b>Multiply and divide</b>, into the core: shift-and-add or the array multiplier (either first), then
  Multiply in the core (on the array), the divider, Divide in the core. The core levels are graded on your
  core's NANDs, period and cycles, so the trade shows where it lands.</li>
  <li><b>Floating point</b>, units only: the binary16 drill, then unpack, the rounding decision, the sticky
  shifter and the leading-zero counter in any order; normalize &amp; round from the last three; then the
  adder, the multiplier, the comparator and int → float. Each block, once built, is a part of the next.</li>
</ul>`,

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
<p>The control is cheap: the SIMD core you will build is 15 669 NANDs, 10 949 more than your
single-cycle core for three extra lanes, and four single-cycle cores would be 18 880. Most of the
difference is <b>registers</b>: four register files are 8 688 NANDs. A real GPU is the same, with its
register file the largest structure on the chip.</p>
<h4>Five new instructions</h4>
<p>Everything else is RV16 unchanged. <code>csrr rd, tid</code> reads CSR 7, the thread's number
(warp · 4 + lane). The other four take SYSTEM's free funct3 values 4 to 7: <code>split rs1</code> and
<code>join</code> (an if whose lanes disagree, on the reconvergence stack), <code>tmc rs1</code> (the
mask := the leader's rs1) and <code>bar</code> (wait for the other warp). A lane decoder you are
given recognizes the first four; <code>bar</code> comes with the two-warp core.</p>
<h4>Why the single-cycle core</h4>
<p>A pipeline speeds up one instruction stream by overlapping its instructions, and pays in
forwarding muxes on the operands, which here would sit in every lane. A GPU overlaps different
threads instead: while one warp waits, another issues, and a warp's own instructions never overlap.
That comes second.</p>
<h4>The hard part</h4>
<p>One PC cannot go two ways. When the lanes disagree on a branch, something has to give: an
<b>active mask</b> turns lanes off (they compute, but write nothing), and a <b>stack</b> remembers
the lanes waiting for the other side of an if. Each side then runs with some lanes idle:
<b>lane utilization</b>, not the clock, becomes the number to watch.</p>
<h4>The act in three parts</h4>
<ul>
  <li><b>Lanes</b>: the four lanes, their register file and the mask, then the SIMD core; the
  reconvergence stack, then the SIMT core, on which every lane runs like a thread of its own.</li>
  <li><b>Warps</b>: a memory that answers a cycle late, and a second warp that issues while the
  first waits: +12 242 NANDs, 8 688 of them its lane registers. A warp costs its state.</li>
  <li><b>Pixels</b>: an edge stepper, a tile walk and a rasterizer (9 188 NANDs), fixed-function
  hardware beside the lanes, with the screen as memory both write.</li>
</ul>
<p>Four kernels run on the golden model of the core each part ends with: saxpy (SIMD), a
reduction (SIMT), a histogram (two warps) and a spinning square (the frame). Each is graded on
cycles and on lane-ops, the lane-steps that did work.</p>`,
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
<h4>What it costs a processor</h4>
<p>Behind a cache, DRAM's latency is paid on misses only. The RV32I single-cycle core with chapter
22's 2-way write-back cache misses 73 times on matmul whatever is behind it. With a fixed line fill
(8 cycles, 12 when a dirty line goes back first) those misses stall it 676 cycles, 3 029 in all; over
chapter 36's DRAM controller with open pages 1 022 (3 375); with closed pages 1 341 (3 694). The cache
decides how often the core goes to DRAM; the controller, how long each trip takes.</p>
<h4>Other masters, other memories</h4>
<p>A display, a DMA engine or a second core want memory too, so the data port becomes a <b>bus</b>:
a handshake either side can stretch, and an arbiter that starves nobody. Copying is what a processor
is worst at, a load and a store per word, so a <b>DMA engine</b> does it as a second master. And DRAM
forgets at power-off, so the program starts in <b>flash</b>: non-volatile, but programmed a page at a
time, only after its whole block is erased, a few thousand times.</p>
<h4>This act</h4>
<ul>
  <li>A DRAM column at switch level, a bank that keeps its row open and refreshes around a cell
  array, then a controller that issues DDR-style commands at the earliest legal cycle, and a cache in
  front of it.</li>
  <li>A bus for two masters and three slaves, and a DMA engine on it.</li>
  <li>A flash page store that never writes in place.</li>
  <li>A boot from flash: a program that sums a table the DMA engine is still copying.</li>
</ul>`,
};
