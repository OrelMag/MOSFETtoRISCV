import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { C_EXPAND, cFetch, W_ALU } from '../lib';
import { XLEN_COSTS } from '../lib/xlencosts';
import { PROGRAMS64 } from '../riscv/programs64';
import { cpu64Scene } from '../widgets/cpu64panel';
import { cpuScene } from '../widgets/cpupanel';
import { codeSizeWidget, cExplorer, RVC_COSTS } from '../widgets/rvc';
import { WIDTH_COSTS, widthCostWidget } from '../widgets/rv64';
import type { Chapter } from './types';

/** A 32-bit instruction that starts mid-word (0x002) and ends in the next word. */
const STRADDLE = `        .option rvc
        c.li   a0, 1          # 0x000: 16 bits
        lui    a1, 0x12345    # 0x002: 32 bits, half in word 0, half in word 1
        c.addi a0, 2          # 0x006
        add    a2, a1, a0     # 0x008: 32 bits, word-aligned
        c.mv   a3, a2         # 0x00c
halt:   c.j    halt           # 0x00e`;
const straddle = assemble(STRADDLE).words;

const K = RVC_COSTS;
const C64 = (id: string) => WIDTH_COSTS.find((r) => r.id === id);
const pct = (a: number, b: number) => Math.round((100 * (a - b)) / b);
const X = XLEN_COSTS;
const fmt = (n: number) => n.toLocaleString('en-US');

export const chWidths: Chapter = {
  id: 'widths', num: 25, title: 'Sixteen bits and sixty-four', level: 'Processor',
  blurb: 'The C extension: two thirds of real instructions in 16 bits, an expander in gates in front of the decoder, fetching at any halfword, and what that costs. Then the other way: the same core at 64 bits, the W instructions RV64 kept, and what width costs.',
  goals: [
    'measure how much of a program has a 16-bit form, and say what the saving buys (ROM, cache lines, fetch bandwidth)',
    'read a 16-bit parcel: its quadrant and funct3, its 3-bit register fields (x8–x15), its scattered immediate, and the 32-bit instruction it stands for',
    'explain why an expander is mostly wiring, and fetch a 32-bit instruction that straddles two words',
    'say what 64 bits cost block by block, why RV64 kept 32-bit arithmetic (the W instructions), and weigh each core in NANDs and clock period',
  ],
  builds: ['cpu', 'python', 'cache', 'float'],
  recap: {
    keep: [
      'Most instructions are short in what they say: copy a register, load a small constant, add a small number, touch the stack. The C extension gives those a 16-bit form. On our programs: 68 % of the compiled Python samples\' instructions, 34 % fewer bytes; the hand-written benchmarks 15–31 % fewer.',
      'A parcel is compressed when bits 1:0 ≠ 11, which leaves a quarter of the 16-bit space to the 32-bit instructions. The price of 16 bits: 3-bit register fields (x8–x15: s0, s1, a0–a5), the destination doubling as a source, 6-bit immediates, offsets scaled by the access size.',
      'Every 16-bit instruction is exactly one 32-bit instruction, so the hardware rewrites it before the decoder. The rewrite only moves bits and adds constants: the gates recognize which of the 30 forms it is and pick each field.',
      `The C single-cycle core: ${K.c.nands.toLocaleString()} NANDs against ${K.plain.nands.toLocaleString()} (+${((100 * (K.c.nands - K.plain.nands)) / K.plain.nands).toFixed(1)} %), period ${K.c.period} against ${K.plain.period} NAND delays (+${pct(K.c.period, K.plain.period)} %): the expander (${K.expander.depth} deep) and the second bank's index sit in series with decode. With a ROM per program, C saves storage and costs speed; it pays where instruction bytes are the bottleneck, a cache or a narrow memory.`,
      'RV64 widens the registers, the PC and every ALU result to 64 bits and keeps every RV32 encoding. Per block: once per bit doubles (registers, the register file, multiplexers), a tree over the bits doubles and adds a level (adders, shifter), the multiplier quadruples, the iterative divider doubles in area and in time.',
      `The W instructions (addw, subw, sllw, srlw, sraw, addiw, the shift immediates, mulw, divw, remw …) keep RV32's 32-bit arithmetic: operands cut to 32 bits and extended, the result's low half sign-extended. In gates, ${fmt(X.wUnit.nands)} NANDs and ${X.wUnit.depth} levels around the 64-bit ALU. lw sign-extends, lwu does not; ld / sd move a doubleword.`,
      `The same single-cycle core at 64 bits: ${fmt(X.rv64im.nands)} NANDs against ${fmt(X.rv32im.nands)} (×${(X.rv64im.nands / X.rv32im.nands).toFixed(2)}), period ${X.rv64im.period} against ${X.rv32im.period}. On 32-bit programs it does the same instructions, slower; it pays when the values are 64 bits wide.`,
    ],
    check: [
      {
        question: 'A program\'s instructions are 60 % compressible. How large is it with C?',
        options: ['70 % of its size', '40 % of its size', '60 % of its size'],
        answer: 0,
        explain: '60 % of the instructions shrink from 4 bytes to 2, so they save half their space: 1 − 0.6 × 0.5 = 0.7.',
        why: ['', 'That removes the compressible instructions entirely; they still take 2 bytes each.', 'That takes the share of 16-bit instructions as the size; each of them still takes half of what it did.'],
      },
      {
        question: 'On RV64, a0 = 0x7FFF_FFFF. What does addiw a0, a0, 1 leave in a0?',
        options: ['0xFFFF_FFFF_8000_0000', '0x0000_0000_8000_0000', '0x0000_0000_0000_0000'],
        answer: 0,
        explain: 'addiw adds on 32 bits: 0x7FFF_FFFF + 1 = 0x8000_0000, whose bit 31 is 1, so the sign extension fills the upper half with ones: −2³¹, as on RV32. addi would give 0x0000_0000_8000_0000.',
        why: ['', 'That is addi\'s answer: the 64-bit sum, not sign-extended from bit 31.', 'Only the carry out of bit 31 would be lost, not the whole sum.'],
      },
      {
        question: `The C core runs at ${K.c.period} NAND delays, the plain one at ${K.plain.period}, both one instruction a cycle. Which is faster on the same program?`,
        options: ['The plain core, by about a quarter', 'The C core: the program is smaller', 'Neither: the work is the same'],
        answer: 0,
        explain: `Time is instructions × period. The instruction count is the same (each 16-bit instruction is one 32-bit one), so the C core is ${K.c.period} / ${K.plain.period} ≈ ${(K.c.period / K.plain.period).toFixed(2)} times slower. Its gain is in bytes, which matter when fetch is the limit.`,
        why: ['', 'A smaller program fetches fewer bytes, but this core reads a whole window from its ROM every cycle anyway: the bytes are not the bottleneck here.', 'The work is the same; the clock is not. The expander lengthens the path every instruction takes.'],
      },
    ],
  },
  steps: [
    {
      title: 'Two thirds fit in 16 bits',
      body: `
        <p>A 32-bit RISC-V instruction spends 7 bits on its opcode and 15 on three register names. Most instructions need far less: they
        copy a register (<code>mv</code>), load a small constant (<code>li</code>), add a small number in place (<code>addi a0, a0, 1</code>),
        or save and restore registers on the stack. The <strong>C extension</strong> gives exactly these a 16-bit form, chosen from statistics of
        compiled code.</p>
        <p>The widget assembles each program twice. Our Python compiler's output (<a href="#/c/python">chapter 15</a>) is the best case:
        it moves values between registers and the stack all the time, and two thirds of its instructions compress. Hand-written loops full of
        three-register arithmetic compress less.</p>
        <p>What the saving buys is <em>instruction bytes</em>: a smaller ROM or flash, more of the program in each cache line
        (<a href="#/c/cache">chapter 22</a>), fewer bytes fetched per instruction. It does not make an instruction do more.</p>
        <p class="try">Pick a Python program, then a benchmark: compare the share of 16-bit lines.</p>`,
      widget: codeSizeWidget,
      challenge: {
        kind: 'quiz', question: 'Why does compiled Python compress better than the hand-written benchmarks?',
        options: ['It is full of register copies, small constants and stack accesses', 'The compiler emits c.* mnemonics', 'Its loops are shorter, so branches reach'],
        answer: 0,
        why: ['', 'The compiler writes plain RV32I; the assembler picks the 16-bit form wherever one exists.', 'Branches are a small share of either; the difference is in the moves, constants and stack traffic.'],
        explain: 'The top forms in its output are c.mv, c.li, c.addi and the stack loads and stores (c.lwsp / c.swsp): what a simple compiler does between the useful instructions.',
      },
    },
    {
      title: 'What 16 bits give up',
      body: `
        <p>Bits 1:0 are the <strong>quadrant</strong>. 00, 01 and 10 are 16-bit instructions, 11 is the first half of a 32-bit one, so the
        decoder knows the length from the first two bits it sees. Bits 15:13 (funct3) and a few others pick one of 30 forms within the
        quadrant.</p>
        <p>To fit, a form gives something up:</p>
        <ul>
          <li><strong>Registers</strong>: many forms have 3-bit fields (rd′, rs1′, rs2′) that reach only x8–x15, the registers the calling convention
          uses most (s0, s1, a0–a5). Others keep 5 bits by using one register as source and destination (<code>c.addi rd, imm</code> is
          <code>addi rd, rd, imm</code>).</li>
          <li><strong>Immediates</strong>: 6 bits signed for constants. Offsets are unsigned and scaled by the access size, so <code>c.lw</code> reaches
          0…124 in steps of 4. The bits are scattered so that each bit sits in the same place in as many formats as possible: wiring the decoder
          does not have to choose.</li>
          <li><strong>Fixed registers</strong>: <code>c.lwsp</code> and <code>c.swsp</code> always use sp, <code>c.jal</code> always links ra.</li>
        </ul>
        <p>The all-zero parcel is defined illegal, so a jump into zeroed memory traps instead of running.</p>
        <p class="try">Flip bit 12 of <code>c.lw a0, 8(s0)</code> and watch which bit of the 32-bit instruction follows it.</p>`,
      widget: cExplorer,
      challenge: {
        kind: 'quiz', question: 'Why are the 3-bit register fields x8–x15 and not x0–x7?',
        options: ['x8–x15 are s0, s1 and a0–a5, the registers compiled code uses most', 'x0–x7 cannot be loaded from memory', 'The hardware adds 8 to save an adder elsewhere'],
        answer: 0,
        why: ['', 'Any register can be loaded; x0 just ignores the write.', '"+ 8" is no adder at all: rd′ = 101 becomes 01101, two constant bits in front of three wires.'],
        explain: 'x0–x7 are zero, ra, sp, gp, tp and t0–t2: zero and sp have forms of their own, gp and tp are rarely touched. The arguments and the first saved registers are where the traffic is.',
      },
    },
    {
      title: 'The expander',
      body: `
        <p>Each 16-bit instruction is exactly one 32-bit instruction, so the C core rewrites it in front of the decoder from
        <a href="#/c/cpu">chapter 14</a>, which never learns that compressed code exists. On the input, 32 bits: the parcel at the PC in bits 15:0
        (and, when it is a 32-bit instruction, its second half above).</p>
        <p>The rewrite only moves bits and adds constants: rd′ becomes <code>01</code> and three wires, an immediate bit lands in its 32-bit place.
        The gates are elsewhere. <span data-show="form">FORM</span> decodes the quadrant and funct3 and ANDs in the few extra bits a form looks at
        (rd ≠ 0, rs2 ≠ 0, bit 12), one wire per form. Then each field of the 32-bit instruction
        (<span data-show="opcode">opcode</span>, <span data-show="rd">rd</span>, <span data-show="funct3">funct3</span>, <span data-show="rs1">rs1</span>,
        <span data-show="rs2">rs2</span>, <span data-show="funct7">funct7</span>) is a one-hot multiplexer: forms that fill it the same way share an input,
        their wires ORed, and each bit is a NAND per input, then a NAND across them. A 32-bit instruction is one more input that passes straight through.</p>
        <p>${K.expander.nands.toLocaleString()} NANDs, ${K.expander.depth} deep. The recipes come from the specification: the generator reads, for every one of the
        65 536 parcels, where each bit of the expansion comes from, and a test checks the gates on all of them.</p>`,
      scene: () => ({ root: C_EXPAND, inputs: { w: 0x4408 } }),
      challenge: {
        kind: 'reach', goal: 'Make the expander output addi sp, sp, −16 (instr = 0xFF010113) from a 16-bit parcel.',
        check: (st) => (st.value('instr') >>> 0) === 0xff010113 && st.value('c') === 1,
        hints: [
          'Moving sp by a small amount in place is c.addi with rd = sp (x2): quadrant 01, funct3 000.',
          'c.addi sp, −16: bit 12 is imm[5] (1, negative), bits 11:7 are rd (00010), bits 6:2 are imm[4:0] (10000), bits 1:0 = 01.',
        ],
        answer: 'w = 0x1141: 000 1 00010 10000 01, c.addi sp, −16. (c.addi16sp sp, −16, 0x717D, works too: the same instruction, another form.)',
        solve: (st) => st.setInputs({ w: 0x1141 }),
      },
    },
    {
      title: 'Fetching on halfwords',
      body: `
        <p>With 16-bit instructions in the stream, an instruction can start at any even address, and a 32-bit one at <code>4k + 2</code> has its two halves
        in two different words. The plain core read one word per cycle; this one needs the 32 bits that start at the PC.</p>
        <p>The ROM is split into two banks of halfwords: <span data-show="lo">the low halves</span> and <span data-show="hi">the high halves</span> of each word.
        The high bank reads word <code>pc &gt;&gt; 2</code>. The low bank reads the same word, or the next one when <code>pc[1] = 1</code>:
        <span data-show="ix">a 6-bit increment by pc[1]</span>. Then <span data-show="p0 p1">two swaps</span> on pc[1] put the parcel at the PC in bits 15:0
        and the next above it, and <span data-show="cx">the expander</span> does the rest. Its <code>c</code> output tells the PC to step by 2 instead of 4.</p>
        <p>The program here starts with a 16-bit <code>c.li</code> at 0x000, so its 32-bit <code>lui</code> sits at 0x002–0x005.</p>
        <p class="try">Set addr to 2: both banks light up for one instruction.</p>`,
      scene: () => ({ root: cFetch(straddle, 6), inputs: { addr: 0 } }),
      tries: [(st) => st.getInput('addr') === 2],
      challenge: {
        kind: 'reach', goal: 'Show the 32-bit instruction that straddles two words: data = lui a1, 0x12345 (0x123455B7) with c = 0.',
        check: (st) => (st.value('data') >>> 0) === 0x123455b7 && st.value('c') === 0,
        hints: ['It starts right after the first, 16-bit, instruction.', 'addr = 2: the low bank reads word 1 (pc[1] = 1), the high bank word 0.'],
        answer: 'addr = 2. The parcel at 0x002 is the high half of word 0 (0x55B7: bits 1:0 = 11, so 32 bits); its second half is the low half of word 1 (0x1234).',
        solve: (st) => st.setInputs({ addr: 2 }),
      },
    },
    {
      title: 'Does it pay?',
      body: `
        <p>Here is the whole RV32IC single-cycle core running chapter 14's programs compressed, in lock-step with the golden model (which now fetches
        16-bit parcels too). It runs the riscv-tests and random programs with every C form, like every other core, and Spike checks the golden model's
        RV32IMC.</p>
        <table class="rvc-table">
          <thead><tr><th>Single-cycle core</th><th class="num">NANDs (no ROM)</th><th class="num">Period</th></tr></thead>
          <tbody>
            <tr><td>RV32I (chapter 14)</td><td class="num">${K.plain.nands.toLocaleString()}</td><td class="num">${K.plain.period}</td></tr>
            <tr><td>RV32IC</td><td class="num">${K.c.nands.toLocaleString()}</td><td class="num">${K.c.period}</td></tr>
            <tr><td>… expander</td><td class="num">${K.expander.nands.toLocaleString()}</td><td class="num">${K.expander.depth} deep</td></tr>
            <tr><td>… bank index and swaps</td><td class="num">${K.fetch}</td><td class="num"></td></tr>
          </tbody>
        </table>
        <p>The area is small (+${((100 * (K.c.nands - K.plain.nands)) / K.plain.nands).toFixed(1)} %), but the clock is not: every instruction now passes the
        increment, the swap and the expander before decode, +${K.c.period - K.plain.period} NAND delays (+${pct(K.c.period, K.plain.period)} %). The Timing panel
        shows the path. On this machine, with a ROM that delivers a full window every cycle, C makes the program a quarter smaller and the computer a quarter
        slower. It pays where bytes are what limits: an instruction cache that holds a third more of the program, a flash or a bus that delivers 16 bits at a
        time, or a chip whose ROM is most of its area. A pipeline also hides the depth: the expander becomes part of fetch or decode, a stage of its own.</p>
        <p>Next: the other direction, a 64-bit core from the same width-parametric parts.</p>`,
      scene: () => cpuScene({ source: PROGRAMS[0].source, c: true, timing: true }),
      challenge: {
        kind: 'quiz', question: 'The incrementer that gives the low bank its index sits in series with the ROM. How could it leave the path?',
        options: ['Keep pc >> 2 + 1 in a register of its own, computed from the next PC before the clock edge', 'Use a faster adder in the ALU', 'Make the low bank twice as large'],
        answer: 0,
        why: ['', 'The ALU is not on this part of the path; the fetch is.', 'The bank\'s size does not change which word it must read.'],
        explain: 'The next PC is known a few gates before the edge; adding one to its word index then, into a second register, moves the incrementer onto the PC-update path, which has slack. The fetch then starts both banks at once.',
      },
    },
    {
      title: 'Sixty-four bits',
      body: `
        <p>RV64 keeps every RV32 instruction and its encoding. What changes is <em>XLEN</em>, the width of the registers, the PC and every
        value the ALU computes: 64 bits, so an address reaches 16 EiB and a counter never wraps. <code>add</code> now adds 64 bits; <code>lw</code>
        still loads 32, sign-extended into 64. A handful of instructions are new (next step).</p>
        <p>Our generators take the width as a parameter: <code>regfile(5, n)</code>, <code>alu(n)</code>, the adders, the shifter, the multiplier.
        So the question "what does a 64-bit core cost?" has an exact answer, block by block, and the blocks fall into four kinds:</p>
        <ul>
          <li><strong>Once per bit</strong>: registers, the register file, multiplexers. Twice the bits, twice the gates, the same delay. The register
          file alone is ${(C64('rf')!.nands[1] - C64('rf')!.nands[0]).toLocaleString()} more NANDs.</li>
          <li><strong>A tree over the bits</strong>: the Kogge–Stone adder, the shifter, the zero test. A little over twice the gates, one more level:
          the 64-bit ALU is ${C64('alu')!.depth![1] - C64('alu')!.depth![0]} NAND delays slower than the 32-bit one. A ripple adder would have doubled its delay.</li>
          <li><strong>Every bit with every bit</strong>: the multiplier's partial products. Four times the gates.</li>
          <li><strong>One bit per cycle</strong>: the iterative divider. Twice the gates and twice the time.</li>
        </ul>
        <p>The immediate generator does not grow at all: a 12- or 20-bit immediate becomes 64 bits by copying its sign bit, and copies are wires.</p>
        <p class="try">Pick the multiplier, then the divider: which one would you rather make faster, and at what price?</p>`,
      widget: widthCostWidget,
      challenge: {
        kind: 'quiz', question: 'Going from 32 to 64 bits, which of these gets slower by the most?',
        options: ['A ripple-carry adder', 'A Kogge–Stone adder', 'A 2:1 multiplexer', 'The register file\'s write'],
        answer: 0,
        why: ['', `A prefix adder adds one level for twice the bits: ${C64('ks')!.depth![0]} → ${C64('ks')!.depth![1]} NAND delays.`, 'Each bit has its own selector; the width never reaches it.', 'Writing a register is the same for every bit at once.'],
        explain: `The ripple carry crosses every bit: ${C64('rca')!.depth![0]} → ${C64('rca')!.depth![1]} NAND delays. Width is cheap for anything bit-parallel and expensive for anything serial along the bits.`,
      },
    },
    {
      title: 'The W instructions',
      body: `
        <p>A program written for RV32 assembles for RV64 unchanged, and mostly runs the same. But not always: code that relies on
        32-bit wrap-around now sees bits above bit 31. Our sort benchmark's random generator (xorshift32) shifts left by 13 and right by 17;
        on 64-bit registers the bits shifted past bit 31 come back down, and the program sorts different numbers. Our CRC-32 shifts its register
        right, and on RV64 the ones of a sign-extended value walk into bit 31.</p>
        <p>RV64 therefore kept 32-bit arithmetic as instructions of their own, on two new opcodes: <code>addw</code>, <code>subw</code>,
        <code>sllw</code>, <code>srlw</code>, <code>sraw</code>, their immediate forms (<code>addiw</code>, <code>slliw</code> …) and, with M,
        <code>mulw</code>, <code>divw</code>, <code>divuw</code>, <code>remw</code>, <code>remuw</code>. Each computes on the low 32 bits and
        <em>sign-extends</em> the result into 64, so a 32-bit value always sits in a register the same way, whatever produced it: <code>lw</code>
        sign-extends too (<code>lwu</code> is the new zero-extending load), and so does <code>lui</code>. Our two benchmarks need four W shifts
        between them to run correctly on RV64: the generator's three and the CRC's one.</p>
        <p>In hardware this is not a second ALU. The <span data-show="wu">W unit</span> sits around the 64-bit <span data-show="alu">ALU</span>:
        when <code>w = 1</code> it cuts each operand to 32 bits and extends it again (zeros for <code>srlw</code>, the sign for <code>sraw</code>),
        clears the shift amount's bit 5, and sign-extends the result's low half. Three multiplexers and wiring:
        ${fmt(X.wUnit.nands)} NANDs, ${X.wUnit.depth} levels. The decoder recognizes OP-32 and OP-IMM-32 by one opcode bit and hands
        them to the control unit as OP and OP-IMM.</p>
        <p class="try">Start from 0x7FFF_FFFF + 1 with w = 0, then set w = 1: y64 stays, y turns negative.</p>`,
      scene: () => ({ root: W_ALU, inputs: { a: 0x7fffffff, b: 1, w: 0, funct3: 0, alt: 0 } }),
      tries: [(st) => st.getInput('w') === 1 && st.getInput('a') === 0x7fffffff && st.getInput('b') === 1],
      challenge: {
        kind: 'reach', goal: 'Make sll and sllw of the same operands disagree completely: w = 1, funct3 = 1 (sll), y = 0 while y64 ≠ 0.',
        check: (st) => st.getInput('w') === 1 && st.getInput('funct3') === 1 && st.value('y') === 0 && st.value('y64') !== 0,
        hints: [
          'sllw keeps only the low 32 bits of the shifted value; the 64-bit ALU result keeps the bits that moved past bit 31.',
          'Start from a value whose only 1 is bit 31, and shift it left by one.',
        ],
        answer: 'a = 0x8000_0000, b = 1, funct3 = 1 (sll), w = 1: the ALU gives 0x1_0000_0000 (y64); the W unit keeps the low 32 bits, 0, sign-extended (y = 0).',
        solve: (st) => st.setInputs({ a: 0x80000000, b: 1, funct3: 1, alt: 0, w: 1 }),
      },
    },
    {
      title: 'The cost of width',
      body: `
        <p>Here is the whole RV64IM single-cycle core, running in lock-step with the golden model. The same generator also builds it at
        32 bits. Both widths run the riscv-tests (rv64ui / rv64um, rv32ui / rv32um) and random programs, and Spike checks the RV64 golden model.</p>
        <table class="rvc-table">
          <thead><tr><th>Single-cycle core</th><th class="num">RV32IM</th><th class="num">RV64IM</th></tr></thead>
          <tbody>
            <tr><td>NANDs (no ROM)</td><td class="num">${fmt(X.rv32im.nands)}</td><td class="num">${fmt(X.rv64im.nands)}</td></tr>
            <tr><td>… register file</td><td class="num">${fmt(X.regfile[32])}</td><td class="num">${fmt(X.regfile[64])}</td></tr>
            <tr><td>… data memory (32 words)</td><td class="num">${fmt(X.dmem[32])}</td><td class="num">${fmt(X.dmem[64])}</td></tr>
            <tr><td>… M unit</td><td class="num">${fmt(X.mUnit[32])}</td><td class="num">${fmt(X.mUnit[64])}</td></tr>
            <tr><td>… ALU</td><td class="num">${fmt(X.alu[32].nands)}</td><td class="num">${fmt(X.alu[64].nands)}</td></tr>
            <tr><td>… loads and stores</td><td class="num">${fmt(X.lsu[32])}</td><td class="num">${fmt(X.lsu[64])}</td></tr>
            <tr><td>… W unit</td><td class="num">·</td><td class="num">${fmt(X.wUnit.nands)}</td></tr>
            <tr><td>Period (NAND delays)</td><td class="num">${X.rv32im.period}</td><td class="num">${X.rv64im.period}</td></tr>
            <tr><td>Without M: NANDs / period</td><td class="num">${fmt(X.rv32i.nands)} / ${X.rv32i.period}</td><td class="num">${fmt(X.rv64i.nands)} / ${X.rv64i.period}</td></tr>
            <tr><td>A divide</td><td class="num">34 cycles</td><td class="num">66 cycles</td></tr>
          </tbody>
        </table>
        <p>×${(X.rv64im.nands / X.rv32im.nands).toFixed(2)} the gates, most of it in the multiplier (×${(X.mUnit[64] / X.mUnit[32]).toFixed(1)}) and in storage
        that simply doubles. The period grows by ${pct(X.rv64im.period, X.rv32im.period)} %: the adders and the shifter gained a level, and a W instruction's
        result passes the W unit. The benchmarks compute on 32-bit values, so the RV64 core runs the same loops (the generator's shifts and CRC-32's
        as W shifts), and sort and CRC-32 run two more instructions each, once: an <code>li</code> of a constant above 2³¹, which is a positive number on
        RV64 and no longer fits lui + addiw. It is ${(X.rv64im.period / X.rv32im.period).toFixed(2)} times slower on them and buys nothing.</p>
        <p>It pays when the values are 64 bits wide: F(90) and 20! in the samples need one <code>add</code> or <code>mul</code> per step here.
        On RV32 a 64-bit add is four instructions (add, sltu for the carry, add, add), and the low 64 bits of a product take four multiplies (mul, mulhu and two cross products) and two adds.
        And it pays when memory is larger than 4 GiB, which is why desktop and phone processors went to 64 bits.</p>
        <p class="try">Run "20! with mul" to its halt, then pick "Benchmark: CRC-32" and run it too.</p>`,
      scene: () => cpu64Scene({ source: PROGRAMS64[0].source, timing: true }),
      challenge: {
        kind: 'quiz', question: 'Which block grew most from the 32-bit core to the 64-bit one?',
        options: ['The M unit', 'The register file', 'The ALU', 'The W unit'],
        answer: 0,
        why: ['', `It doubles: ${fmt(X.regfile[32])} → ${fmt(X.regfile[64])}.`, `A little over twice: ${fmt(X.alu[32].nands)} → ${fmt(X.alu[64].nands)}.`, `It is new but small: ${fmt(X.wUnit.nands)} NANDs.`],
        explain: `The M unit goes from ${fmt(X.mUnit[32])} to ${fmt(X.mUnit[64])} NANDs: the tree multiplier has a partial-product bit for every pair of operand bits, so twice the width is four times the partial products.`,
      },
    },
  ],
};
