import { alu, addSub, bitwise, regfile, shifter } from '../lib';
import { cpuState } from '../riscv/cosim';
import { PROGRAMS } from '../riscv/programs';
import { pack } from '../sim/values';
import { cpuScene } from '../widgets/cpupanel';
import { memGridPanel } from '../widgets/memgrid';
import { assemblerWorkspace, instructionExplorer } from '../widgets/riscv';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;

function reg(st: Stage, i: number): number {
  const n = st.rootCtx?.node.children?.get(`w${i}`);
  return n ? pack(st.rootCtx!.sim.getBits(n.ports.q)) : -1;
}

export const chAlu: Chapter = {
  id: 'alu', num: 11, title: 'The ALU', level: 'Computing',
  blurb: 'Every RV32I integer operation in one block, selected by the instruction\'s own bits.',
  steps: [
    {
      title: 'Bitwise operations are free parallelism',
      body: `
        <p>AND, OR and XOR on words are just n independent gates: no carries, no interaction between bit positions,
        depth 2–3 NANDs regardless of width. They cost O(n) area and O(1) delay.</p>
        <p>In RV32I they implement masking (<code>andi</code>), setting bits (<code>ori</code>), toggling and comparing
        (<code>xor</code>), and <code>not</code> as <code>xori rd, rs, -1</code>.</p>`,
      scene: () => ({ root: bitwise('xor', 8), inputs: { a: 0b1100_1010, b: 0b1010_0110 } }),
    },
    {
      title: 'The barrel shifter',
      body: `
        <p>Shifting by a variable amount <em>s</em> in one cycle: decompose <em>s</em> in binary and build log₂(n) stages,
        stage <em>j</em> shifting by 2<sup>j</sup> or passing through. The "shift by 2<sup>j</sup>" itself is pure wiring;
        each stage is a row of 2:1 muxes. A 32-bit shifter is 5 stages, 160 MUX2.</p>
        <p>Two tricks keep it to one right-shifter: a left shift is a right shift of the bit-reversed word, reversed back,
        and an arithmetic right shift fills the vacated bits with the sign bit instead of 0 (<code>fill = arith ∧ a[n−1]</code>).</p>
        <div class="try">Set a = 0x96, sh = 3 and toggle <code>left</code> and <code>arith</code>. Open a stage to see the wiring box and the muxes.</div>`,
      scene: () => ({ root: shifter(8), inputs: { a: 0x96, sh: 3, left: 0, arith: 1 } }),
    },
    {
      title: 'Comparison is subtraction',
      body: `
        <p>The ALU never contains a comparator. To evaluate a &lt; b it computes a − b and reads flags from the adder:</p>
        <ul><li><strong>Z</strong>: result is zero ⇒ a = b (beq/bne)</li>
        <li><strong>N ⊕ V</strong>: the true sign of a − b ⇒ a &lt; b signed (slt, blt). N alone is wrong when the subtraction overflows.</li>
        <li><strong>¬C</strong>: no carry out of a + ¬b + 1 ⇒ a &lt; b unsigned (sltu, bltu)</li></ul>
        <div class="try">Try a = 0x80 (−128), b = 0x01, sub = 1: the result 0x7F looks positive (N = 0) but V = 1, so N ⊕ V = 1: −128 &lt; 1. Correct.</div>`,
      scene: () => ({ root: addSub(8), inputs: { a: 0x80, b: 0x01, sub: 1 } }),
      challenge: {
        kind: 'quiz', question: 'For unsigned a < b, the ALU computes a + NOT b + 1 and looks at…',
        options: ['the sign bit of the result', 'carry out = 0', 'overflow = 1', 'zero = 0'], answer: 1,
        explain: 'a + (2ⁿ − 1 − b) + 1 = a − b + 2ⁿ. That reaches 2ⁿ (carry out = 1) exactly when a ≥ b. No carry means a < b. That is why bltu/sltu use ¬C.',
      },
    },
    {
      title: 'The complete ALU',
      body: `
        <p>All units compute in parallel on every cycle; an 8:1 multiplexer driven by funct3 picks the result.
        The control code is <code>ctl = {funct7[5], funct3}</code>, the instruction's own bits, so the ALU decoder is almost
        empty. ctl[3] selects SUB over ADD and SRA over SRL; SLT and SLTU also force subtraction.</p>
        <p>Note the cost structure in the Info tab: the shifter and mux trees dominate area; the ripple adder dominates delay.
        That is why a later chapter replaces it with a parallel-prefix adder.</p>
        <div class="note">ctl: 0000 ADD · 1000 SUB · 0001 SLL · 0010 SLT · 0011 SLTU · 0100 XOR · 0101 SRL · 1101 SRA · 0110 OR · 0111 AND</div>`,
      scene: () => ({ root: alu(8), inputs: { a: 0x80, b: 3, ctl: 0b1101 } }),
      challenge: {
        kind: 'reach', goal: 'Make the ALU compute 0x80 shifted right arithmetically by 3 (result 0xF0).',
        check: (st) => st.getInput('ctl') === 0b1101 && st.getInput('a') === 0x80 && st.getInput('b') === 3 && st.value('y') === 0xf0,
        answer: 'a = 0x80, b = 3, ctl = 0b1101 (SRA). The sign bit (1) is copied into the three vacated positions: 1111_0000.',
        solve: (st) => st.setInputs({ a: 0x80, b: 3, ctl: 0b1101 }),
      },
    },
  ],
};

export const chRegfile: Chapter = {
  id: 'regfile', num: 12, title: 'The register file', level: 'Computing',
  blurb: '32 registers, two read ports, one write port, and x0 wired to zero.',
  steps: [
    {
      title: 'A memory with two read ports',
      body: `
        <p>An R-type instruction needs two operands and produces one result per cycle, so the register file has
        <strong>two asynchronous read ports</strong> and <strong>one synchronous write port</strong>. Structurally it is the
        memory array from Chapter 10 with a second mux tree.</p>
        <p>All register outputs are bundled into one wide bus feeding both read ports; that is the usual way to draw
        "every word reaches every port". Register x0 does not exist: its slot is a constant 0, and writes to it go nowhere.
        That gives you <code>mv</code>, <code>li</code>, <code>nop</code>, <code>j</code> and <code>beqz</code> for free as pseudo-instructions.</p>
        <div class="try">Write a value: set wa, wd, we = 1, Pulse. Then point ra1 / ra2 at it.</div>`,
      scene: () => ({ root: regfile(3, 8), inputs: { wa: 5, wd: 0x42, we: 1, clk: 0, ra1: 5, ra2: 0 }, panels: [memGridPanel] }),
      challenge: {
        kind: 'reach', goal: 'Store 0x42 in register 5 and read it on read port 2 (rd2 = 0x42).',
        check: (st) => reg(st, 5) === 0x42 && st.getInput('ra2') === 5 && st.value('rd2') === 0x42,
        answer: 'wa = 5, wd = 0x42, we = 1, Pulse; then ra2 = 5.',
        solve: (st) => { st.setInputs({ wa: 5, wd: 0x42, we: 1 }); st.pulse(); st.setInputs({ ra2: 5 }); },
      },
    },
    {
      title: 'The real thing: 32 × 32',
      body: `
        <p>RV32I's register file: 31 × 32 flip-flops with enable, a 5→32 write decoder and two 32:1 multiplexer trees of
        32-bit words. At this site's construction (15 NANDs per bit) that is ~23 000 NANDs, roughly half of the whole CPU.</p>
        <p>Real designs use custom multi-ported SRAM cells: an extra read port costs two transistors per bit, not a whole
        mux tree. Register-file port count is a first-order cost in superscalar cores for exactly this reason.</p>`,
      scene: () => ({ root: regfile(5, 32), inputs: { wa: 10, wd: 0xcafe, we: 1, clk: 0, ra1: 10, ra2: 0 } }),
    },
  ],
};

export const chIsa: Chapter = {
  id: 'isa', num: 13, title: 'Instructions & assembly', level: 'ISA',
  blurb: 'RV32I encodings, an in-browser assembler, and a golden model to run programs on.',
  steps: [
    {
      title: 'Six formats, fixed register fields',
      body: `
        <p>Every RV32I instruction is 32 bits. The opcode (bits 6:0) selects one of six formats. The design rule that shapes
        everything: <strong>rs1, rs2 and rd are always in the same bit positions</strong>, so register-file reads start in
        parallel with decoding.</p>
        <p>Immediates pay for that. The S format splits its immediate around rs2; B and J scramble theirs so that the sign
        is always bit 31 and most immediate bits sit in the same place across formats. The immediate generator then needs
        fewer multiplexer inputs per bit.</p>
        <p>Under the fields, the immediate is rebuilt bit by bit the way the hardware does it: each result bit is a wire
        from one instruction bit (the number below it), a sign copy of bit 31 (<code>s</code>), or ground. No gates.</p>
        <div class="try">Try <code>beq a0, zero, 16</code> and <code>jal ra, 2048</code>: watch where the offset bits go.
        Point at a bit of the immediate to see its source.</div>`,
      widget: () => instructionExplorer(),
      challenge: {
        kind: 'quiz', question: 'Why is the branch offset stored in units of 2 bytes, not 4, even though RV32I instructions are 4 bytes?',
        options: ['To reach farther', 'To support the 16-bit compressed (C) extension without a new encoding', 'Because bit 0 is used for the condition'], answer: 1,
        explain: 'With the C extension instructions can sit on 2-byte boundaries. Encoding offsets in halfwords keeps one branch format for both.',
      },
    },
    {
      title: 'The assembler',
      body: `
        <p>The assembler turns text into those words in two passes: pass 1 assigns addresses to labels (pseudo-instructions
        like <code>li</code> may expand to two words, <code>lui</code> + <code>addi</code>), pass 2 encodes.</p>
        <p>The result runs immediately on the <strong>golden model</strong>, an instruction-set simulator written directly
        from the specification. The gate-level CPU in the next chapter is checked against it after every clock cycle.</p>
        <div class="try">Edit the program: errors show up with their line numbers, and the machine code updates as you type.</div>`,
      widget: () => assemblerWorkspace(src('sum')),
    },
  ],
};

const RTYPE = `# R-type and I-type: rd = rs1 op rs2 / imm
        li   a0, 7
        li   a1, 5
        add  a2, a0, a1     # 12
        sub  a3, a0, a1     # 2
        and  a4, a0, a1     # 5
        slli a5, a0, 3      # 56
        slt  a6, a1, a0     # 1
halt:   j    halt`;

const MEMOPS = `# loads and stores
        li   t0, 42
        sw   t0, 8(zero)    # mem[8] = 42
        lw   t1, 8(zero)    # t1 = mem[8]
        addi t1, t1, 1
        sw   t1, 12(zero)
halt:   j    halt`;

export const chSingleCycle: Chapter = {
  id: 'cpu', num: 14, title: 'A single-cycle CPU', level: 'Processor',
  blurb: 'Every block from the previous chapters, wired into a complete RV32I processor.',
  steps: [
    {
      title: 'The datapath',
      body: `
        <p>This is a complete RV32I processor, all 48 000 NANDs of it simulated at gate level. Each <strong>Pulse</strong>
        executes one instruction:</p>
        <ul><li><strong>Fetch</strong>: PC addresses the instruction memory; +4 computes the next sequential address.</li>
        <li><strong>Decode</strong>: the splitter fans the instruction fields out; the register file reads rs1/rs2 while the
        control unit and immediate generator work on the opcode.</li>
        <li><strong>Execute</strong>: SrcA/SrcB muxes feed the ALU.</li>
        <li><strong>Memory / write-back</strong>: the data memory is addressed by the ALU result; the result mux picks ALU,
        memory, PC+4 or immediate, and it is written to rd on the next rising edge.</li></ul>
        <p>Control signals are drawn as <em>net labels</em> (tags). Hover one to highlight every place that net goes.
        The panel shows the program, registers and memory, and checks every cycle against the golden model.</p>
        <p>Click a program line: its <strong>fields</strong> appear in the panel and the wires that carry them take the
        same colours (opcode to the control unit, rd to the write address, and so on). Point at a field to follow only
        its wires; open <code>imm</code> or <code>ctl</code> and the colours follow you inside.</p>
        <p><strong>Slow</strong> runs the program at the speed you set, keeping the current instruction's hardware lit
        and logging each retired instruction in the trace. At the <em>gate</em> level each rising edge plays out one
        NAND delay at a time: the new PC leaves its register, fetches the next instruction, which is decoded and
        executed until the result waits at the register file's inputs. That longest ripple sets the clock period.</p>`,
      scene: () => cpuScene({ source: src('sum') }),
    },
    {
      title: 'ALU instructions',
      body: `
        <p>For <code>add</code>: RegWrite = 1, ALUSrcB = 0 (rs2), ResultSrc = ALU, ALUControl = {funct7[5], funct3}.
        For <code>addi</code> the only difference is ALUSrcB = 1 with ImmSrc = I.</p>
        <div class="try">Pulse through the program and watch the highlighted path: register file → ALU → result mux → back into the register file.</div>`,
      scene: () => cpuScene({ source: RTYPE, highlight: ['rf', 'srcA', 'srcB', 'alu', 'res', 'imm'] }),
    },
    {
      title: 'Loads and stores',
      body: `
        <p><code>sw</code>: ALU computes rs1 + imm<sub>S</sub>, MemWrite = 1, data = rs2. Nothing is written back.
        <code>lw</code>: same address computation, ResultSrc = memory. That is the longest path in the machine:
        clock → PC → instruction memory → register file → ALU (32-bit ripple add) → data-memory read mux → result mux → register
        file input.</p>
        <div class="try">Pulse to the <code>lw</code> and compare the status bar's "settled in N gate delays" with an <code>addi</code>.</div>`,
      scene: () => cpuScene({ source: MEMOPS, highlight: ['alu', 'dm', 'res'] }),
      challenge: {
        kind: 'quiz', question: 'Which instruction class sets the clock period of a single-cycle CPU?',
        options: ['R-type (two register reads)', 'lw (ALU, then memory, then write-back)', 'beq (subtract and compare)', 'jal (no register read)'], answer: 1,
        explain: 'Every cycle must be long enough for the slowest instruction, and lw chains the ALU and the memory read. The other instructions waste the slack. That is the motivation for multicycle and pipelined designs.',
      },
    },
    {
      title: 'Branches and jumps',
      body: `
        <p>Branches use the ALU to subtract (ALUControl = SUB) and the next-PC logic reads the flags: beq Z, bne ¬Z,
        blt N⊕V, bge ¬(N⊕V), bltu ¬C, bgeu C. If taken, PCSrc selects PC + imm<sub>B</sub> from a dedicated adder.</p>
        <p><code>jal</code> writes PC+4 to rd and jumps to PC + imm<sub>J</sub>; <code>jalr</code> jumps to (rs1 + imm) with bit 0 cleared:
        a wiring box that ties bit 0 to ground. This program calls a function with <code>jal</code> and returns with <code>ret</code>
        (= <code>jalr zero, 0(ra)</code>).</p>`,
      scene: () => cpuScene({ source: src('gcd'), highlight: ['npc', 'target', 'pcmux', 'clr0'] }),
    },
    {
      title: 'Run real programs',
      body: `
        <p>Pick a program in the panel, or write your own with <strong>Edit</strong>. <strong>Run to halt</strong> clocks the
        gate-level machine as fast as your browser allows, about 200 cycles per second for ~200 000 transistors.</p>
        <p>Supported: all of RV32I except byte/halfword loads and stores, <code>fence</code>, <code>ecall</code>, <code>ebreak</code>.
        A jump to itself is treated as halt.</p>`,
      scene: () => cpuScene({ source: src('fib'), editable: true }),
      challenge: {
        kind: 'reach', goal: 'Run the Fibonacci program until it halts (fib[11] = 89 in memory).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).dmem[11] === 89 : false; } catch { return false; } },
        answer: 'Press "Run to halt" in the panel (or Pulse about 75 times). The 12th word, at address 0x2C, becomes 89.',
        solve: (st) => { st.runCycles(200, () => { try { return st.sim ? cpuState(st.sim).dmem[11] === 89 : false; } catch { return false; } }); },
      },
    },
  ],
};
