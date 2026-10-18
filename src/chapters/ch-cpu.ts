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
  goals: [
    'say why bitwise operations cost n gates and constant depth at any width',
    'build a barrel shifter from log₂ n mux stages, with one right-shifter serving all three shifts',
    'read signed and unsigned less-than from one subtraction (N ⊕ V, ¬C)',
    'decode the ALU control straight from the instruction\'s funct7[5] and funct3 bits',
  ],
  builds: ['adders', 'routing'],
  recap: {
    keep: [
      'Bitwise AND / OR / XOR: n independent gates, 2–3 NAND delays at any width. <code>not</code> is <code>xori rd, rs, -1</code>.',
      'Barrel shifter: log₂ n stages of 2:1 muxes, stage j shifting by 2<sup>j</sup> (the shift itself is wiring). Left = reverse, shift right, reverse back; an arithmetic shift fills with <code>arith ∧ a[n−1]</code>. 32 bits: 901 NANDs, 16 delays deep.',
      'No comparator: a − b gives Z (equal), N ⊕ V (signed less-than: N alone lies on overflow) and ¬C (unsigned less-than: no carry out of a + ¬b + 1).',
      'Every unit computes every cycle and an 8:1 mux on funct3 picks the result. <code>ctl = {funct7[5], funct3}</code>: ctl[3] selects SUB over ADD and SRA over SRL; SLT and SLTU force subtraction.',
      'At 32 bits: 2 610 NANDs, 98 NAND delays deep. The ripple adder sets the depth, the shifter and the result mux take most of the area.',
    ],
    practise: ['a_addsub16', 'a_slt', 'a_shift16', 'a_alu16'],
    check: [
      {
        question: '8-bit a = 0x7F (127), b = 0x80 (−128). The ALU computes a − b = 0xFF. Is a &lt; b, signed?',
        options: ['No: N ⊕ V = 0, because the subtraction overflowed', 'Yes: N = 1', 'Yes: there is no carry out', 'The flags cannot tell; a comparator is needed'],
        answer: 0,
        explain: '127 − (−128) = 255 does not fit in 8 signed bits. The result 0xFF reads as −1 (N = 1), but V = 1, so N ⊕ V = 0: a ≥ b, which is right.',
        why: ['', 'N alone is the sign of a wrapped result. Here the subtraction overflowed, so the sign bit lies.', 'No carry out answers the unsigned question: 0x7F &lt; 0x80 unsigned is true, but the signed answer is the opposite.', 'The adder\'s flags hold both answers. That is why the ALU contains no comparator.'],
      },
      {
        question: 'How many mux stages does the shift itself need in a 64-bit barrel shifter?',
        options: ['6', '64', '32', '5'],
        answer: 0,
        explain: 'The shift amount has log₂ 64 = 6 bits; stage j shifts by 2<sup>j</sup> or passes through. 6 rows of 64 MUX2, plus the reversal rows for left shifts.',
        why: ['', 'That is one stage per possible shift amount. Decomposing the amount in binary needs one stage per bit of it.', 'Stage count follows the bits of the shift amount, not half the width.', 'Five stages reach shifts up to 31: enough for RV32, not for 64-bit words.'],
      },
      {
        question: '<code>srl</code> and <code>sra</code> share funct3 = 101. What tells the ALU which one to do?',
        options: ['funct7[5], wired straight in as ctl[3]', 'The opcode', 'A decoder reading all seven funct7 bits', 'The sign of rs2'],
        answer: 0,
        explain: 'ctl = {funct7[5], funct3}: 0101 is SRL, 1101 SRA. The same bit picks SUB (1000) over ADD (0000).',
        why: ['', 'Both are R-type (or both OP-IMM for the immediate forms): the opcode says where the operand comes from, not which shift.', 'Only bit 5 of funct7 differs between them, and the ALU takes it as is: no decoder.', 'rs2 gives the shift amount. The fill bit comes from a, and only when ctl says arithmetic.'],
      },
    ],
  },
  steps: [
    {
      title: 'Bitwise operations are free parallelism',
      body: `
        <p>AND, OR and XOR on words are just <span data-show="g0 g1 g2 g3 g4 g5 g6 g7">n independent gates</span>: no carries, no interaction between bit positions,
        depth 2–3 NANDs regardless of width. They cost O(n) area and O(1) delay.</p>
        <p>In RV32I they implement masking (<code>andi</code>), setting bits (<code>ori</code>), toggling and comparing
        (<code>xor</code>), and <code>not</code> as <code>xori rd, rs, -1</code>.</p>`,
      scene: () => ({ root: bitwise('xor', 8), inputs: { a: 0b1100_1010, b: 0b1010_0110 } }),
    },
    {
      title: 'The barrel shifter',
      body: `
        <p>Shifting by a variable amount <em>s</em> in one cycle: decompose <em>s</em> in binary and build log₂(n)
        <span data-show="m0 m1 m2">stages</span>, stage <em>j</em> shifting by 2<sup>j</sup> or passing through. The
        "shift by 2<sup>j</sup>" itself is <span data-show="w0 w1 w2">pure wiring</span>; each stage is a row of 2:1 muxes.
        A 32-bit shifter is 5 stages, 160 MUX2.</p>
        <p>Two tricks keep it to one right-shifter: a left shift is a right shift of the
        <span data-show="rin mr rout mo">bit-reversed word, reversed back</span>, and an arithmetic right shift fills the
        vacated bits with the sign bit instead of 0 (<span data-show="f1 f2"><code>fill = arith ∧ a[n−1]</code></span>).</p>
        <div class="try">Set a = 0x96, sh = 3 and toggle <code>left</code> and <code>arith</code>. Open a stage to see the wiring box and the muxes.</div>`,
      scene: () => ({ root: shifter(8), inputs: { a: 0x96, sh: 3, left: 0, arith: 1 } }),
      tries: [(st) => st.getInput('left') === 1 || st.getInput('arith') === 0],
    },
    {
      title: 'Comparison is subtraction',
      body: `
        <p>The ALU never contains a comparator. To evaluate a &lt; b it computes a − b
        (<span data-show="x0 x1 x2 x3 x4 x5 x6 x7">b inverted</span>, carry-in 1, through the
        <span data-show="fa0 fa1 fa2 fa3 fa4 fa5 fa6 fa7">full adders</span>) and reads flags from the adder:</p>
        <ul><li><strong>Z</strong>: result is zero ⇒ a = b (beq/bne)</li>
        <li><strong><span data-show="pin:n">N</span> ⊕ <span data-show="vx">V</span></strong>: the true sign of a − b ⇒ a &lt; b signed (slt, blt). N alone is wrong when the subtraction overflows.</li>
        <li><strong>¬<span data-show="pin:cout">C</span></strong>: no carry out of a + ¬b + 1 ⇒ a &lt; b unsigned (sltu, bltu)</li></ul>
        <div class="try">Try a = 0x80 (−128), b = 0x01, sub = 1: the result 0x7F looks positive (N = 0) but V = 1, so N ⊕ V = 1: −128 &lt; 1. Correct.</div>`,
      scene: () => ({ root: addSub(8), inputs: { a: 0x80, b: 0x01, sub: 1 } }),
      challenge: {
        kind: 'quiz', question: 'For unsigned a < b, the ALU computes a + NOT b + 1 and looks at…',
        options: ['the sign bit of the result', 'carry out = 0', 'overflow = 1', 'zero = 0'], answer: 1,
        why: ['The sign bit answers a signed question, and even then only when the subtraction does not overflow.', '', 'Overflow is a signed notion: it flags a result that does not fit in two\'s complement.', 'zero = 0 only says a ≠ b; it cannot tell which one is smaller.'],
        explain: 'a + (2ⁿ − 1 − b) + 1 = a − b + 2ⁿ. That reaches 2ⁿ (carry out = 1) exactly when a ≥ b. No carry means a < b. That is why bltu/sltu use ¬C.',
      },
    },
    {
      title: 'The complete ALU',
      body: `
        <p>All units (<span data-show="add">adder</span>, <span data-show="shift">shifter</span>,
        <span data-show="slt sltu">set-less-than</span>, <span data-show="xor or and">bitwise</span>) compute in parallel on
        every cycle; an <span data-show="mux">8:1 multiplexer</span> driven by funct3 picks the result.
        The control code is <code>ctl = {funct7[5], funct3}</code>, the instruction's own bits, so the ALU decoder is almost
        empty. ctl[3] selects SUB over ADD and SRA over SRL; SLT and SLTU also force subtraction.</p>
        <p>Note the cost structure in the Info tab: the shifter and mux trees dominate area; the ripple adder dominates delay.
        That is why <a href="#/c/fastadd/0">a later chapter</a> replaces it with a parallel-prefix adder.</p>
        <div class="note">ctl: 0000 ADD · 1000 SUB · 0001 SLL · 0010 SLT · 0011 SLTU · 0100 XOR · 0101 SRL · 1101 SRA · 0110 OR · 0111 AND</div>`,
      scene: () => ({ root: alu(8), inputs: { a: 0x80, b: 3, ctl: 0b0101 } }),
      challenge: {
        kind: 'reach', goal: 'Make the ALU compute 0x80 shifted right arithmetically by 3 (result 0xF0).',
        check: (st) => st.getInput('ctl') === 0b1101 && st.getInput('a') === 0x80 && st.getInput('b') === 3 && st.value('y') === 0xf0,
        hints: [
          'The note under the text lists every control code. Which operation fills the vacated bits from the sign?',
          'ctl[3] = 1 turns a logical right shift (0101) into an arithmetic one; b is the shift amount.',
        ],
        answer: 'a = 0x80, b = 3, ctl = 0b1101 (SRA). The sign bit (1) is copied into the three vacated positions: 1111_0000.',
        solve: (st) => st.setInputs({ a: 0x80, b: 3, ctl: 0b1101 }),
      },
    },
  ],
};

export const chRegfile: Chapter = {
  id: 'regfile', num: 12, title: 'The register file', level: 'Computing',
  blurb: '32 registers, two read ports, one write port, and x0 wired to zero.',
  goals: [
    'say why an R-type instruction needs two read ports and one write port, and what each port costs',
    'explain how a constant x0 gives mv, li, nop, j and beqz for free',
    'price the 32 × 32 register file in NANDs against the rest of the CPU',
  ],
  builds: ['registers', 'memory'],
  recap: {
    keep: [
      'Two asynchronous read ports and one synchronous write port: two operands in, one result out, every cycle.',
      'Structure: a write decoder, one register with enable per word, every word bundled onto one bus, and a mux tree per read port.',
      'x0 has no flip-flops: its slot is a constant 0 and writes to it go nowhere. <code>mv</code>, <code>li</code>, <code>nop</code>, <code>j</code> and <code>beqz</code> are pseudo-instructions built on it.',
      'RV32I: 31 × 32 flip-flops, a 5→32 decoder, two 32:1 trees of 32-bit words: 23 141 NANDs, nearly half of the single-cycle CPU (about 48 000 without its program ROM).',
      'Here every read port is a whole mux tree: a third would add 3 968 NANDs. A custom SRAM cell adds a port for about two transistors per bit.',
    ],
    practise: ['m_rf'],
    check: [
      {
        question: 'Why does the register file have two read ports?',
        options: ['An R-type instruction reads rs1 and rs2 in the same cycle', 'One port reads while the other writes', 'One of them serves x0', 'To read 64-bit values'],
        answer: 0,
        explain: '<code>add rd, rs1, rs2</code> needs both operands at once in a single-cycle machine. One port would take two cycles; one result per instruction needs only one write port.',
        why: ['', 'Writes have their own synchronous port; both read ports only read.', 'x0 needs no port: it is a constant on the bundled bus, selected like any other word.', 'RV32I registers are 32 bits, and each port returns one register.'],
      },
      {
        question: '<code>addi x0, x5, 1</code> executes. What happens?',
        options: ['Nothing visible: the write to x0 goes nowhere', 'x0 holds x5 + 1 until the next write', 'An illegal-instruction trap', 'x5 is incremented'],
        answer: 0,
        explain: 'x0 has no storage, so the result is lost and x0 still reads 0. <code>addi x0, x0, 0</code> is the canonical <code>nop</code>.',
        why: ['', 'There is nothing to hold the value: x0\'s slot on the read bus is wired to 0.', 'Writing x0 is legal; RISC-V relies on it for nop and for discarding results (j is jal x0).', 'rd is x0; rs1 = x5 is only read.'],
      },
      {
        question: 'A third read port on this 32 × 32 register file adds about…',
        options: ['4 000 NANDs: one more 32:1 tree of 32-bit words', 'two transistors per bit', 'nothing: the bundled bus already reaches every register', 'a second set of 31 registers'],
        answer: 0,
        explain: '31 MUX2 per bit × 32 bits × 4 NANDs = 3 968 NANDs. Port count is a first-order cost, which is why wide superscalar cores fight over register-file ports.',
        why: ['', 'That is the price with custom multi-ported SRAM cells, not with a mux tree built from NANDs.', 'The bus brings every word to the port, but each port still needs its own selector to pick one.', 'Ports share the storage; only the selection logic is duplicated.'],
      },
    ],
  },
  steps: [
    {
      title: 'A memory with two read ports',
      body: `
        <p>An R-type instruction needs two operands and produces one result per cycle, so the register file has
        <strong>two asynchronous <span data-show="rp1 rp2">read ports</span></strong> and <strong>one synchronous write
        port</strong> (<span data-show="dec">a decoder</span> enabling one register). Structurally it is the
        memory array from <a href="#/c/memory/0">chapter 10</a> with a second mux tree.</p>
        <p>All register outputs are bundled into <span data-show="bundle">one wide bus</span> feeding both read ports; that is the usual way to draw
        "every word reaches every port". Register <span data-show="x0">x0</span> does not exist: its slot is a constant 0, and writes to it go nowhere.
        That gives you <code>mv</code>, <code>li</code>, <code>nop</code>, <code>j</code> and <code>beqz</code> for free as pseudo-instructions.</p>
        <div class="try">Write a value: set wa, wd, we = 1, Pulse. Then point ra1 / ra2 at it.</div>`,
      scene: () => ({ root: regfile(3, 8), inputs: { wa: 5, wd: 0x42, we: 1, clk: 0, ra1: 5, ra2: 0 }, panels: [memGridPanel] }),
      tries: [(st) => st.getInput('ra2') !== 0 && st.value('rd2') > 0],
      challenge: {
        kind: 'reach', goal: 'Store 0x42 in register 5 and read it on read port 2 (rd2 = 0x42).',
        check: (st) => reg(st, 5) === 0x42 && st.getInput('ra2') === 5 && st.value('rd2') === 0x42,
        hints: [
          'A write needs an address, data and the enable, and happens only at a rising clock edge.',
          'A read port needs no clock: it shows whichever register its address selects, at once.',
        ],
        answer: 'wa = 5, wd = 0x42, we = 1, Pulse; then ra2 = 5.',
        solve: (st) => { st.setInputs({ wa: 5, wd: 0x42, we: 1 }); st.pulse(); st.setInputs({ ra2: 5 }); },
      },
    },
    {
      title: 'The real thing: 32 × 32',
      body: `
        <p>RV32I's register file: <span data-show="w1 w2 w3 w31">31 × 32 flip-flops</span> with enable, a
        <span data-show="dec">5→32 write decoder</span> and two <span data-show="rp1 rp2">32:1 multiplexer trees</span> of
        32-bit words. At this site's construction (15 NANDs per bit) that is ~23 000 NANDs, roughly half of the whole CPU.</p>
        <p>Real designs use custom multi-ported SRAM cells: an extra read port costs two transistors per bit, not a whole
        mux tree. Register-file port count is a first-order cost in superscalar cores for exactly this reason.</p>`,
      scene: () => ({ root: regfile(5, 32), inputs: { wa: 10, wd: 0xcafe, we: 1, clk: 0, ra1: 10, ra2: 0 } }),
    },
  ],
};

export const chIsa: Chapter = {
  id: 'isa', num: 13, title: 'Instructions & assembly', level: 'ISA',
  blurb: 'RV32I encodings, an in-browser assembler, and an instruction-set simulator to run programs on.',
  goals: [
    'name the six RV32I formats and say why rs1, rs2 and rd never move',
    'rebuild an immediate from instruction bits the way the hardware does: wires, sign copies and ground',
    'explain why branch and jump offsets count halfwords',
    'assemble a program in two passes and run it on an instruction-set simulator',
  ],
  builds: ['binary', 'regfile'],
  recap: {
    keep: [
      'Every instruction is 32 bits; the opcode (bits 6:0) picks one of six formats: R, I, S, B, U, J.',
      'rs1 (19:15), rs2 (24:20) and rd (11:7) never move, so register reads start in parallel with decoding.',
      'Immediates pay for it: S splits its immediate around rs2, B and J scramble theirs so the sign is always bit 31. Each immediate bit is a wire, a copy of bit 31, or 0: no gates.',
      'Branch and jump offsets count 2-byte units (bit 0 is not stored), so the 16-bit C extension needs no new format.',
      'The assembler works in two passes: labels first (<code>li</code> may grow to <code>lui</code> + <code>addi</code>), then encoding. The instruction-set simulator, written from the specification, is the reference every gate-level CPU is checked against.',
    ],
    practise: ['i_enc', 'p_add', 'p_loop', 'p_call'],
    check: [
      {
        question: 'In <code>sw a1, 8(a0)</code>, what occupies bits 11:7, where an R-type keeps rd?',
        options: ['imm[4:0]', 'rs2', 'rd', 'funct3'],
        answer: 0,
        explain: 'S format: imm[11:5] in bits 31:25, imm[4:0] in 11:7. Splitting the immediate keeps rs1 and rs2 where every other format has them.',
        why: ['', 'rs2 stays at 24:20 in every format that has one: that is the point of the layout.', 'A store writes no register, so S has no rd; its slot carries the low immediate bits.', 'funct3 stays at 14:12 in every format that has one.'],
      },
      {
        question: 'How does <code>jal ra, 2048</code> store its offset?',
        options: ['As imm[20:1], scrambled: bit 11 of the offset lands in instruction bit 20', 'As 2048 in bits 31:20, like an I-type immediate', 'As 512 words', 'It cannot: jal reaches only ±2 KiB'],
        answer: 0,
        explain: 'J stores imm[20|10:1|11|19:12] in bits 31:12; bit 0 is always 0 and not stored. 2048 sets only imm[11], which sits in instruction bit 20. Range: ±1 MiB.',
        why: ['', 'An I-type immediate is 12 bits signed (−2048 … 2047): 2048 would not even fit, and J has 20 bits to spend.', 'Offsets count halfwords, not words, so that 2-byte compressed instructions can be targets.', 'That is the range of a 12-bit immediate. J\'s 20 bits of halfwords reach ±1 MiB.'],
      },
      {
        question: '<code>li a0, 0x12345</code> assembles to how many words?',
        options: ['Two: lui, then addi', 'One: li is an instruction', 'One addi, since the value is positive', 'Three'],
        answer: 0,
        explain: '<code>lui a0, 0x12</code> sets the upper 20 bits, <code>addi a0, a0, 0x345</code> adds the low 12. Pass 1 must know the size to place every label after it.',
        why: ['', 'li is a pseudo-instruction: RV32I has no li opcode.', 'addi\'s immediate is 12 bits signed (−2048 … 2047); 0x12345 = 74 565 does not fit.', 'lui supplies 20 bits and addi 12: two instructions cover any 32-bit constant.'],
      },
    ],
  },
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
        why: ['Halfword units do reach farther than byte units, but word units would reach farther still: range is not why it stops at 2.', '', 'The condition is in funct3. Bit 0 of the offset is simply not stored, since it is always 0.'],
        explain: 'With the C extension instructions can sit on 2-byte boundaries. Encoding offsets in halfwords keeps one branch format for both.',
      },
    },
    {
      title: 'The assembler',
      body: `
        <p>The assembler turns text into those words in two passes: pass 1 assigns addresses to labels (pseudo-instructions
        like <code>li</code> may expand to two words, <code>lui</code> + <code>addi</code>), pass 2 encodes.</p>
        <p>The result runs immediately on an <strong>instruction-set simulator</strong>, written directly from the
        specification. The gate-level CPU in the next chapter is checked against it after every clock cycle.</p>
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
  goals: [
    'trace one instruction through fetch, decode, execute, memory and write-back on the gate-level datapath',
    'set the control signals for add, addi, lw, sw, beq and jal',
    'say why every instruction of a single-cycle CPU gets the time of the slowest',
    'run a real program on the gates and check it against the instruction-set simulator',
  ],
  builds: ['alu', 'regfile', 'isa'],
  recap: {
    keep: [
      'One instruction per clock: PC → instruction memory → decode and register read → ALU → data memory → result mux → register file, written at the next rising edge.',
      'Control comes from the opcode: RegWrite, ALUSrcB, ResultSrc, MemWrite, ImmSrc, and ALUControl = {funct7[5], funct3}. add and addi differ only in ALUSrcB and ImmSrc.',
      'Branches subtract in the ALU and read its flags (beq Z, bne ¬Z, blt N⊕V, bge ¬(N⊕V), bltu ¬C, bgeu C); a separate adder computes PC + imm<sub>B</sub>.',
      '<code>jal</code> writes PC + 4 and jumps to PC + imm<sub>J</sub>; <code>jalr</code> jumps to rs1 + imm with bit 0 cleared by wiring.',
      'About 48 000 NANDs without the program ROM, 155 NAND delays per cycle with ripple adders, and the clock must fit the slowest instruction.',
    ],
    practise: ['c_imm', 'c_ctl', 'c_br', 'c_npc', 'c_core1', 'c_core2', 'c_core3'],
    check: [
      {
        question: 'For <code>sw t0, 8(a0)</code>, which control settings are right?',
        options: ['MemWrite = 1, ALUSrcB = immediate, RegWrite = 0', 'MemWrite = 1, RegWrite = 1, ResultSrc = memory', 'RegWrite = 1, ALUSrcB = rs2', 'MemWrite = 0, ResultSrc = ALU'],
        answer: 0,
        explain: 'The ALU adds rs1 and imm<sub>S</sub> for the address, rs2 is the data, and nothing is written back.',
        why: ['', 'A store writes no register: RegWrite = 1 would overwrite whichever register the immediate bits in 11:7 happen to name.', 'That is add: an R-type whose result is written back.', 'MemWrite = 0 makes it no store at all.'],
      },
      {
        question: '<code>jal ra, f</code>: which value does the result mux send to the register file?',
        options: ['PC + 4', 'PC + imm<sub>J</sub>', 'The ALU result', 'The immediate'],
        answer: 0,
        explain: 'ra gets the return address from the +4 adder; the target PC + imm<sub>J</sub> goes to the PC.',
        why: ['', 'That is the jump target: it goes to the PC, not to ra.', 'The return address comes from the +4 adder; nothing the ALU computes is written back.', 'The result mux passes the immediate for lui, not for jal.'],
      },
      {
        question: 'A program of mostly <code>addi</code> runs on the single-cycle CPU. Why is each instruction no faster than a load?',
        options: ['The clock period is fixed by the longest path any instruction can take', 'addi uses the data memory too', 'The register-file write takes the whole cycle', 'It is faster: each instruction takes its own time'],
        answer: 0,
        explain: 'One instruction per cycle at one period: the cycle must fit the slowest instruction, and addi wastes the slack. Multicycle and pipelined designs exist to recover it.',
        why: ['', 'addi never touches the data memory; its path ends at the result mux.', 'The write happens at the clock edge; it is not what makes the cycle long.', 'A synchronous design has one clock period for every instruction.'],
      },
    ],
  },
  steps: [
    {
      title: 'The datapath',
      body: `
        <p>This is a complete RV32I processor, all 48 000 NANDs of it simulated at gate level. Each <strong>Pulse</strong>
        executes one instruction:</p>
        <ul><li><strong>Fetch</strong>: <span data-show="pc">PC</span> addresses the <span data-show="imem">instruction memory</span>; +4 computes the next sequential address.</li>
        <li><strong>Decode</strong>: the splitter fans the instruction fields out; the <span data-show="rf">register file</span> reads rs1/rs2 while the
        <span data-show="ctl">control unit</span> and <span data-show="imm">immediate generator</span> work on the opcode.</li>
        <li><strong>Execute</strong>: SrcA/SrcB muxes feed the <span data-show="alu">ALU</span>.</li>
        <li><strong>Memory / write-back</strong>: the <span data-show="dm">data memory</span> is addressed by the ALU result; the result mux picks ALU,
        memory, PC+4 or immediate, and it is written to rd on the next rising edge.</li></ul>
        <p>Control signals are drawn as <em>net labels</em> (tags). Hover one to highlight every place that net goes.
        The panel shows the program, registers and memory, and checks every cycle against the instruction-set simulator.</p>
        <p>Click a program line: its <strong>fields</strong> appear in the panel and the wires that carry them take the
        same colours (opcode to the control unit, rd to the write address, and so on). Point at a field to follow only
        its wires; open <code>imm</code> or <code>ctl</code> and the colours follow you inside.</p>
        <details class="deeper"><summary>Deeper: Slow, and a clock edge one gate at a time</summary>
        <p><strong>Slow</strong> runs the program at the speed you set, keeping the current instruction's hardware lit
        and logging each retired instruction in the trace. At the <em>gate</em> level each rising edge plays out one
        NAND delay at a time: the new PC leaves its register, fetches the next instruction, which is decoded and
        executed until the result waits at the register file's inputs. That longest ripple sets the clock period.</p></details>`,
      scene: () => cpuScene({ source: src('sum') }),
    },
    {
      title: 'ALU instructions',
      body: `
        <p>For <code>add</code>: RegWrite = 1 (write rd), ALUSrcB = 0 (the <span data-show="srcB">second ALU operand</span>
        is rs2; the <span data-show="srcA">first</span> is rs1), ResultSrc = ALU (the <span data-show="res">result mux</span>
        writes back the ALU's output), ALUControl = {funct7[5], funct3} (the <span data-show="alu">ALU</span>'s operation).
        For <code>addi</code> the only difference is ALUSrcB = 1 with ImmSrc = I (the
        <span data-show="imm">immediate generator</span> builds an I-type immediate).</p>
        <div class="try">Pulse through the program and watch the highlighted path: <span data-show="rf">register file</span> → ALU → result mux → back into the register file.</div>`,
      scene: () => cpuScene({ source: RTYPE, highlight: ['rf', 'srcA', 'srcB', 'alu', 'res', 'imm'] }),
      tries: [(st) => { try { return st.sim ? cpuState(st.sim).x[16] === 1 : false; } catch { return false; } }],
    },
    {
      title: 'Loads and stores',
      body: `
        <p><code>sw</code>: the <span data-show="alu">ALU</span> computes rs1 + imm<sub>S</sub>, MemWrite = 1 (the
        <span data-show="dm">data memory</span> writes), data = rs2. Nothing is written back.
        <code>lw</code>: same address computation, ResultSrc = memory (the <span data-show="res">result mux</span> passes the loaded word). On paper that is the longest path:
        clock → PC → instruction memory → register file → ALU (32-bit ripple add) → data-memory read mux → result mux → register
        file input. <a href="#/c/fastadd/0">Chapter 15</a> measures this machine and finds a surprise.</p>
        <div class="try">Pulse to the <code>lw</code> and compare the status bar's "settled in N gate delays" with an <code>addi</code>.</div>`,
      scene: () => cpuScene({ source: MEMOPS, highlight: ['alu', 'dm', 'res'] }),
      challenge: {
        kind: 'quiz', question: 'Which instruction class sets the clock period of a single-cycle CPU?',
        options: ['R-type (two register reads)', 'lw (ALU, then memory, then write-back)', 'beq (subtract and compare)', 'jal (no register read)'], answer: 1,
        why: ['Both register reads happen in parallel, and an R-type skips the data memory entirely.', '', 'With a realistic memory, a branch ends at the next-PC logic and never waits for a data-memory read. (This site\'s memories are fast mux trees, so chapter 15\'s static timing finds a branch path on top: a surprise only cheap memory allows.)', 'jal reads no register, and its path through an adder to the result mux is shorter still.'],
        explain: 'Every cycle must be long enough for the slowest instruction, and lw chains the ALU and the memory read. The other instructions waste the slack. That is the motivation for multicycle and pipelined designs.',
      },
    },
    {
      title: 'Branches and jumps',
      body: `
        <p>Branches use the ALU to subtract (ALUControl = SUB) and the <span data-show="npc">next-PC logic</span> reads the flags: beq Z, bne ¬Z,
        blt N⊕V, bge ¬(N⊕V), bltu ¬C, bgeu C. If taken, PCSrc (the <span data-show="pcmux">next-PC select</span>) picks
        PC + imm<sub>B</sub> from a <span data-show="target">dedicated adder</span>.</p>
        <p><code>jal</code> writes PC+4 to rd and jumps to PC + imm<sub>J</sub>; <code>jalr</code> jumps to (rs1 + imm) with bit 0 cleared:
        a <span data-show="clr0">wiring box</span> that ties bit 0 to ground. This program calls a function with <code>jal</code> and returns with <code>ret</code>
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
        hints: [
          'The program halts on a jump to itself; until then the clock has to keep running.',
          'The panel can clock the machine for you. Watch the memory view: each Fibonacci number is stored as it is computed.',
        ],
        answer: 'Press "Run to halt" in the panel (or Pulse about 75 times). The 12th word, at address 0x2C, becomes 89.',
        solve: (st) => { st.runCycles(200, () => { try { return st.sim ? cpuState(st.sim).dmem[11] === 89 : false; } catch { return false; } }); },
      },
    },
  ],
};
