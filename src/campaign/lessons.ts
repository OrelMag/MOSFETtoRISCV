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
exhaustively, real enough to run loops, functions, a stack and interrupt handlers.</p>
<h4>How the campaign works</h4>
<ul>
  <li>Every level builds one block from blocks you already have. It starts as a chip in the
  sandbox with its pins in place; <b>Check</b> runs the complete test set (every input
  combination, a clocked sequence, or whole programs against a golden model).</li>
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
beyond 4–5 variables, <b>Quine–McCluskey</b>.</p>`,

  mem: `
<p>You built memory from flip-flops: 9 NANDs per bit, a decoder and a mux per array. Real memories
use 6-transistor SRAM cells (caches, register files) or 1-transistor-1-capacitor DRAM cells (main
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
</table>
<p>op: 1 OP, 2 OPX (sub, sra), 4 ADDI, 5 SHI, 6 LW, x111 LUI, 8–11 BEQ BNE BLT BGE, 12 JAL, 13 JALR,
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
fetched from the wrong path: <b>flush</b> them. CPI rises above 1; the shorter period more than pays.</p>`,

  traps: `
<p>Programs make mistakes (an illegal instruction), ask for help (<code>ecall</code>), and the world
interrupts them (a timer, a device). In each case the CPU must stop what it is doing <b>between two
instructions</b>, remember where it was, and run a <b>handler</b>.</p>
<p>The trap machinery is a handful of <b>CSRs</b>: <code>mtvec</code> (the handler's address),
<code>mepc</code> (where to come back), <code>mcause</code> (why; bit 15 = interrupt),
<code>mstatus</code> (MIE: interrupts enabled; MPIE: its saved copy) and <code>mie</code> / <code>mip</code>
(which interrupts are enabled / pending). A trap does, atomically: mepc ← pc, mcause ← cause,
MPIE ← MIE, MIE ← 0, pc ← mtvec. <code>mret</code> undoes it: pc ← mepc, MIE ← MPIE.</p>
<p>An exception's mepc is the faulting instruction (the handler adds 1 to skip it); an interrupt's
is the next instruction to run. In a pipeline, traps must be <b>precise</b>: everything older
completes, nothing younger leaves a trace.</p>`,
};
