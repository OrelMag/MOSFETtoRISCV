import { groupDigits } from '../sim/numfmt';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { W_ALU } from '../lib/cpu64';
import { C_EXPAND, cFetch } from '../lib/rvc';
import { XLEN_COSTS } from '../lib/xlencosts';
import { PROGRAMS64 } from '../riscv/programs64';
import { cpu64Scene } from '../widgets/cpu64panel';
import { cpuScene } from '../widgets/cpupanel';
import { codeSizeWidget, cExplorer, RVC_COSTS } from '../widgets/rvc';
import { WIDTH_COSTS, widthCostWidget } from '../widgets/rv64';
import type { Chapter } from './types';
import { numOf } from './order';

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
const fmt = groupDigits;
/** Share of a program's size left when a fraction f of its instructions shrink from 4 bytes to 2. */
const sizeLeft = (f: number) => 1 - f / 2;
const pctLeft = (f: number) => (100 * sizeLeft(f)).toFixed(0);
/** Parcels (16-bit patterns) that are whole 16-bit instructions: bits 1:0 are not 11. */
const SHORT_PARCELS = 3 * 2 ** 14;
const ratio = (a: number, b: number, d = 2) => (a / b).toFixed(d);

export const chWidths: Chapter = {
  id: 'widths', num: numOf('widths'), title: 'Sixteen bits and sixty-four', level: 'Processor',
  blurb: 'The C extension: two thirds of real instructions in 16 bits, an expander in gates in front of the decoder, fetching at any halfword, and what that costs. Then the other way: the same core at 64 bits, the W instructions RV64 kept, and what width costs.',
  goals: [
    'measure how much of a program has a 16-bit form, and say what the saving buys (ROM, cache lines, fetch bandwidth)',
    'read a 16-bit parcel: its quadrant and funct3, its 3-bit register fields (x8–x15), its scattered immediate, and the 32-bit instruction it stands for',
    'explain why an expander is mostly wiring, and fetch a 32-bit instruction that straddles two words',
    'say what 64 bits cost block by block, why RV64 kept 32-bit arithmetic (the W instructions), and weigh each core in NANDs and clock period',
  ],
  builds: ['cpu', 'python', 'fastadd', 'muldiv', 'cache', 'float'],
  recap: {
    keep: [
      'Most instructions are short in what they say: copy a register, load a small constant, add a small number, touch the stack. The C extension gives those a 16-bit form. On our programs: 68 % of the compiled Python samples\' instructions, 34 % fewer bytes; the hand-written benchmarks 15–31 % fewer.',
      'A parcel is compressed when bits 1:0 ≠ 11, which leaves a quarter of the 16-bit space to the 32-bit instructions. The price of 16 bits: 3-bit register fields (x8–x15: s0, s1, a0–a5), the destination doubling as a source, 6-bit immediates, offsets scaled by the access size.',
      'Every 16-bit instruction is exactly one 32-bit instruction, so the hardware rewrites it before the decoder. The rewrite only moves bits and adds constants: the gates recognize which of the 30 forms it is and pick each field.',
      `The C single-cycle core: ${groupDigits(K.c.nands)} NANDs against ${groupDigits(K.plain.nands)} (+${((100 * (K.c.nands - K.plain.nands)) / K.plain.nands).toFixed(1)} %), period ${K.c.period} against ${K.plain.period} NAND delays (+${pct(K.c.period, K.plain.period)} %): the expander (${K.expander.depth} deep) and the second bank's index sit in series with decode. With a ROM per program, C saves storage and costs speed; it pays where instruction bytes are the bottleneck, a cache or a narrow memory.`,
      'RV64 widens the registers, the PC and every ALU result to 64 bits and keeps every RV32I and M encoding (C is the exception: c.jal becomes c.addiw, c.flw becomes c.ld). Per block: once per bit doubles (registers, the register file, multiplexers), a tree over the bits doubles and adds a level (adders, shifter), the multiplier quadruples, the iterative divider doubles in area and in time.',
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
        <p>The saving is linear in the share of short instructions. If a fraction f of them have a 16-bit form, the program keeps
        1 − f / 2 of its size: f = 2 / 3 leaves ${pctLeft(2 / 3)} %, and even a program with every instruction compressible would still leave ${pctLeft(1)} %. Nothing else
        changes: the same instructions execute in the same order, so a core that fetches a word a cycle takes as many cycles as before. Size is the whole benefit.</p>
        <p class="try">Pick a Python program, then a benchmark: compare the share of 16-bit lines.</p>`,
      widget: codeSizeWidget,
      more: {
        derive: `<p>A program of N instructions, a fraction f of them with a 16-bit form, takes 4N(1 − f) + 2Nf = 4N(1 − f / 2) bytes, against 4N: a ratio of
          1 − f / 2. At f = 0.2 that is ${pctLeft(0.2)} %, at f = 0.5 ${pctLeft(0.5)} %, at f = 2 / 3 ${pctLeft(2 / 3)} %. Each extra point of f buys half a point of size.</p>`,
        real: `<p>Embedded cores were where C paid first: a microcontroller's flash and its wait states are most of its area and power, and a third more code in the same
          flash is a cheaper part. Application cores take it for the instruction cache: a 16-byte fetch carries more instructions, and the same cache holds more of
          the working set. Linux distributions for RISC-V are built with C.</p>`,
        pitfall: `<p>Reading "30 forms" as "30 instructions". A 16-bit form exists only when the operands fit: a register outside x8–x15 or an
          immediate that is too large silently gives the 32-bit encoding. The widget counts per line, and the same source compresses less
          when its values live in t0–t6.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why does compiled Python compress better than the hand-written benchmarks?',
        options: ['It is full of register copies, small constants and stack accesses', 'The compiler emits c.* mnemonics', 'Its loops are shorter, so branches reach'],
        answer: 0,
        why: ['', 'The compiler writes plain RV32I; the assembler picks the 16-bit form wherever one exists.', 'Branches are a small share of either; the difference is in the moves, constants and stack traffic.'],
        explain: 'Among the top forms in its output are c.mv, c.li, c.addi and the stack loads and stores (c.lwsp / c.swsp): what a simple compiler does between the useful instructions.',
      },
    },
    {
      title: 'What 16 bits give up',
      body: `
        <p>Bits 1:0 are the <strong>quadrant</strong>. 00, 01 and 10 are 16-bit instructions, 11 is the first half of a 32-bit one, so the
        decoder knows the length from the first two bits it sees. Bits 15:13 (funct3) and a few others pick the form within the
        quadrant, one of 30 in all.</p>
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
        <p>The encoding space makes the trade explicit. Of the 2<sup>16</sup> parcels, the three quadrants other than 11 hold ${fmt(SHORT_PARCELS)} patterns for 16-bit
        instructions, and ${fmt(2 ** 16 - SHORT_PARCELS)} (a quarter) are left as the first halves of 32-bit ones. Every bit a form gives up in register number or immediate
        is paid for by that quarter: the 32-bit instructions keep the room they need.</p>
        <p class="try">Flip bit 12 of <code>c.lw a0, 8(s0)</code> and watch which bit of the 32-bit instruction follows it.</p>`,
      widget: cExplorer,
      more: {
        derive: `<p>What each limit reaches. A 3-bit register field names 2<sup>3</sup> = 8 registers: x8–x15. A 5-bit offset scaled by 4 reaches 0 to ${(2 ** 5 - 1) * 4}
          bytes (<code>c.lw</code>, <code>c.sw</code>); scaled by 8 it reaches ${(2 ** 5 - 1) * 8} (<code>c.ld</code> on RV64). A 6-bit signed immediate runs from ${-(2 ** 5)} to ${2 ** 5 - 1}.
          A stack-pointer offset has 6 bits scaled by 4: 0 to ${(2 ** 6 - 1) * 4}. Beyond these the assembler uses the 32-bit form, whose 12-bit immediate reaches ${-(2 ** 11)} to ${2 ** 11 - 1}.</p>`,
        real: `<p>The forms come from measuring compiled code: which instructions, with which register and immediate distributions, make up most of a binary. The
          3-bit fields and the scaled offsets are where those statistics landed. ARM's Thumb-2 makes the same trade with a mix of 16- and 32-bit encodings; RISC-V
          keeps the 16-bit ones as a strict subset, each exactly one 32-bit instruction, so no mode switch is needed.</p>`,
        pitfall: `<p>Treating the destination as a free register. In <code>c.addi a0, 5</code> the destination is also the source; to add into another
          register the compiler needs a <code>c.mv</code> first, or the 32-bit <code>addi</code>. In the explorer, change rd and watch rs1 follow it.</p>`,
      },
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
      reading: {
        source: 'RISC-V Unprivileged ISA (current AsciiDoc, riscv-isa-manual)', section: 'Extension for Integer Compressed Instructions (Zca)',
        quote: [
          'The compressed extensions use a simple compression scheme that offers shorter 16-bit versions of common 32-bit RISC-V instructions when: the immediate or address offset is small, or one of the registers is the zero register (x0), the ABI link register (x1), or the ABI stack pointer (x2), or the destination register and the first source register are identical, or the registers used are the 8 most popular ones.',
          'The Zca extension allows 16-bit instructions to be freely intermixed with 32-bit instructions, with the latter now able to start on any 16-bit boundary, i.e., IALIGN=16.'],
        note: 'Each clause is a reason the assembler can pick a short form. The expander undoes it with wiring: a 3-bit register gets 01 in front, a short immediate is sign-extended, rd is sent to rs1 too.',
        quizzes: [
          { question: 'Which of these has a 16-bit form?', options: ['addi a0, a0, 1', 'addi a0, a1, 1', 'addi a0, a0, 100', 'add a0, a1, a2'], answer: 0,
          why: ['', 'The destination and the first source differ, and neither is sp.', 'The immediate does not fit the 6-bit signed field.', 'Three different registers fit none of the clauses.'],
          explain: 'c.addi needs rd = rs1 and an immediate in −32 … 31: two clauses of the quote at once.' },
          { question: 'The 3-bit register fields of the compressed forms name which registers?', options: ['x0–x7', 'x8–x15', 'x16–x23', 'The 8 least recently used'], answer: 1,
          why: ['x0–x7 include zero, ra and sp, which have forms of their own.', '', 'Nothing singles out x16–x23.', 'The set is fixed in the encoding, not adaptive.'],
          explain: 'x8–x15 (s0, s1, a0–a5) are the "8 most popular" registers; a value kept in t0–t6 gives the 32-bit form.' },
          { question: 'A 32-bit instruction can now start at an address that is a multiple of 2 but not of 4. What does the fetch have to cope with?', options: ['Nothing: it fetches a word at the PC', 'An instruction straddling two words', 'An alignment trap on every such jump', 'A second program counter'], answer: 1,
          why: ['A word fetch at a 2-byte address would be misaligned.', '', 'With C the 2-byte alignment is legal.', 'One PC is enough; it counts in units of 2.'],
          explain: 'The instruction\'s halves can sit in two consecutive words, which is why the fetch unit reads two banks and swaps them.' },
        ],
      },
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
        <p>${groupDigits(K.expander.nands)} NANDs, ${K.expander.depth} deep. The recipes come from the specification: the generator reads, for every one of the
        65 536 parcels, where each bit of the expansion comes from, and a test checks the gates on all of them.</p>
        <p>Spread over the 32 output bits that is about ${Math.round(K.expander.nands / 32)} NANDs a bit: not much logic, but a long path: ${K.expander.depth} levels, against ${X.alu[32].depth} for the whole 32-bit ALU.
        The form decode, the one-hot select and the OR across forms are in series, and the result still has to go through the ordinary decoder.</p>`,
      scene: () => ({ root: C_EXPAND, inputs: { w: 0x4408 } }),
      tour: {
        beats: [
          { title: 'A load', set: { w: 0x4408 }, show: ['form', 'opcode'], expect: { instr: 0x00842503, c: 1 },
            say: '<p>The parcel is <code>c.lw a0, 8(s0)</code>. <code>form</code> recognizes it; the expander puts out <code>lw a0, 8(x8)</code>, {v:instr} as a 32-bit word, and raises <code>c</code>: the PC will step by 2.</p>' },
          { title: 'Fields from the parcel', show: ['rd', 'rs1'],
            say: '<p>Both registers were 3 bits in the parcel (rd′ = 010, rs1′ = 000). The expander writes <code>01</code> in front: rd = 01010 = a0, rs1 = 01000 = s0. Two constant bits and wires, no logic.</p>' },
          { title: 'In place', set: { w: 0x1141 }, show: ['form', 'rd', 'rs1'], expect: { instr: 0xff010113, c: 1 },
            say: '<p><code>c.addi sp, −16</code> names sp once. The expander sends the same five bits to rd <em>and</em> rs1, and sign-extends the 6-bit immediate: <code>addi sp, sp, −16</code> = {v:instr}.</p>' },
          { title: 'A 32-bit instruction passes', set: { w: 0x00000013 }, show: ['form'], expect: { instr: 0x13, c: 0 },
            say: '<p>Bits 1:0 = 11 mean a 32-bit instruction. No form matches, <code>c</code> stays 0 and the window goes through unchanged: {v:instr} is <code>nop</code>.</p>' },
          { title: 'The illegal parcel', set: { w: 0 }, show: ['form'], expect: { illegal: 1, c: 1 },
            say: '<p>The all-zero parcel is defined illegal: <code>illegal</code> = {v:illegal}, so a jump into zeroed memory traps.</p>' },
        ],
      },
      more: {
        derive: `<p>A field of the output is a one-hot multiplexer: with F forms asserted one at a time and recipes r(f) for the field, bit i is the OR over forms of
          (form f AND the source bit r(f, i)). Forms that fill the field the same way share a recipe, so the OR is over recipes, not forms. In NANDs: one NAND per
          (recipe, bit) input, then one NAND across them. ${groupDigits(K.expander.nands)} NANDs for 32 bits, ${K.expander.depth} deep.</p>`,
        real: `<p>Shipping cores with C do the same thing in a module in front of decode (Rocket's RVCExpander, Ibex's compressed decoder). The expander is on the
          critical path of the fetch stage in a pipelined core, and some cores cut the path by predecoding the instruction lengths when the cache line is filled.</p>`,
        pitfall: `<p>Running the expander on the wrong window. The expander sees 32 bits starting at the PC; it must first decide, from bits 1:0 alone, whether the
          first parcel is a whole instruction. If that decision uses the wrong parcel (after a jump to a halfword address), the expander decodes the
          second half of a 32-bit instruction as if it were a 16-bit one.</p>`,
      },
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
        <p>The cost of this is ${K.fetch} NANDs (the increment and the swaps) in series in front of the expander, and a new class of event: an instruction that crosses a word,
        and in a real memory system a cache line or a page. The sequence below walks the program's addresses through it.
        The pipelined CPU takes C with this same unit in its fetch stage: the expanded instruction is what enters decode and PC + 2 rides along as the link value,
        so the hazard unit and the forwarding paths do not change.</p>
        <p class="try">Set addr to 2: both banks light up for one instruction.</p>`,
      scene: () => ({ root: cFetch(straddle, 6), inputs: { addr: 0 } }),
      tour: {
        beats: [
          { title: 'A parcel on a word boundary', set: { addr: 0 }, show: ['lo', 'hi'], expect: { data: 0x00100513, c: 1 },
            say: '<p>At 0x000 sits <code>c.li a0, 1</code>: the low bank gives the parcel, the expander widens it to <code>addi a0, zero, 1</code> = {v:data}, and <code>c</code> = {v:c}: step by 2.</p>' },
          { title: 'Straddling two words', set: { addr: 2 }, show: ['lo', 'hi', 'ix', 'p0', 'p1'], expect: { data: 0x123455b7, c: 0 },
            say: '<p>The next instruction, <code>lui a1, 0x12345</code>, starts at address 2: its first half is the high half of word 0, its second half the low half of word 1. <code>pc[1] = 1</code>, so the increment makes the low bank read word 1 and the swaps put the halves in order: {v:data}, a 32-bit instruction (<code>c</code> = {v:c}).</p>' },
          { title: 'Back to 16 bits', set: { addr: 6 }, show: ['lo', 'hi', 'cx'], expect: { data: 0x00250513, c: 1 },
            say: '<p>At 6 a <code>c.addi a0, 2</code> again, in the high half of word 1: expanded to <code>addi a0, a0, 2</code> = {v:data}.</p>' },
          { title: 'Aligned again', set: { addr: 8 }, show: ['lo', 'hi'], expect: { data: 0x00a58633, c: 0 },
            say: '<p>At 8 a 32-bit <code>add a2, a1, a0</code> that starts on a word boundary: both banks read word 2, no increment, no swap. {v:data}.</p>' },
        ],
      },
      more: {
        derive: `<p>The program lays out as: 0x000 <code>c.li</code> (2 bytes), 0x002 <code>lui</code> (4), 0x006 <code>c.addi</code> (2), 0x008 <code>add</code> (4),
          0x00c <code>c.mv</code> (2), 0x00e <code>c.j</code> (2). Each instruction is addressed by the sum of the sizes before it. The PC next is pc + 2 or pc + 4
          depending on <code>c</code>, which costs ${K.next} NANDs over the plain core's fixed +4. The low bank's word index is pc[7:2] + pc[1]: the 6-bit increment.</p>`,
        real: `<p>Real fetch units read an aligned block of 16 or 32 bytes into a buffer and assemble instructions from the buffer, so a straddling instruction costs a
          cycle only when it crosses the block. A 32-bit instruction can also straddle a cache line, or a page: the second half may then miss, or fault, after
          the first half was fetched without trouble.</p>`,
        pitfall: `<p>Branch targets. With C a jump may land on any even address, so the target of <code>jal</code> or a branch is a multiple of 2, not 4: bit 0 of the
          offset is always 0 and bit 1 is live. A core that still clears the two low bits of the target fetches the wrong instruction, and one that traps on bit 1
          set raises a misaligned-fetch exception that a core with C must not raise.</p>`,
      },
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
            <tr><td>RV32I (chapter 14, ripple adders)</td><td class="num">${groupDigits(K.plain.nands)}</td><td class="num">${K.plain.period}</td></tr>
            <tr><td>RV32IC</td><td class="num">${groupDigits(K.c.nands)}</td><td class="num">${K.c.period}</td></tr>
            <tr><td>… expander</td><td class="num">${groupDigits(K.expander.nands)}</td><td class="num">${K.expander.depth} deep</td></tr>
            <tr><td>… bank index and swaps</td><td class="num">${K.fetch}</td><td class="num"></td></tr>
          </tbody>
        </table>
        <p>The area is small (+${((100 * (K.c.nands - K.plain.nands)) / K.plain.nands).toFixed(1)} %), but the clock is not: every instruction now passes the
        increment, the swap and the expander before decode, +${K.c.period - K.plain.period} NAND delays (+${pct(K.c.period, K.plain.period)} %). The Timing panel
        shows the path. On this machine, with a ROM that delivers a full window every cycle, C makes the program a quarter to a third smaller and the computer a quarter
        slower. It pays where bytes are what limits: an instruction cache that holds a third more of the program, a flash or a bus that delivers 16 bits at a
        time, or a chip whose ROM is most of its area. A pipeline also hides the depth: the expander becomes part of fetch or decode, a stage of its own.</p>
        <p>Next: the other direction, a 64-bit core from the same width-parametric parts.</p>`,
      scene: () => cpuScene({ source: PROGRAMS[0].source, c: true, timing: true }),
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['pc', 'imem'], expect: { pcOut: 0 },
            say: '<p>The program starts at 0 with the window of ROM words from there. The first instruction is 16 bits long.</p>' },
          { title: 'Steps of 2', cycles: 1, show: ['pc'], expect: { pcOut: 2 },
            say: '<p>One cycle later the PC is {v:pcOut}: a 16-bit instruction retired and the next one starts two bytes on. On the plain core every step is 4.</p>' },
          { title: 'Three in six bytes', cycles: 2, show: ['pc', 'imem'], expect: { pcOut: 6 },
            say: '<p>After two more cycles the PC is {v:pcOut}: three instructions in six bytes. The same three would have taken twelve on the plain core.</p>' },
          { title: 'A loop closes', cycles: 3, expect: { pcOut: 6 },
            say: '<p>The PC went 6, 8, 10 and is back at {v:pcOut}: a branch at the end of the loop. Cycles are one per instruction, as before: C changed the bytes, not the count.</p>' },
        ],
      },
      more: {
        derive: `<p>Time per instruction = period × CPI, with CPI = 1 on both cores. The plain core: ${K.plain.period} NAND delays. The C core: ${K.c.period},
          that is ${K.c.period - K.plain.period} more: the ${K.expander.depth}-deep expander and the bank index and swaps in front of it. The ratio ${ratio(K.c.period, K.plain.period)} is what
          fetching must win back to break even. With a ROM that delivers a full window every cycle it wins nothing: a program with two thirds of its instructions compressible is
          ${pctLeft(2 / 3)} % of its size and runs ${ratio(K.c.period, K.plain.period)} times slower.</p>`,
        real: `<p>Pipelined cores hide most of this: the expander sits in fetch or decode and adds a stage or a few gates to a stage that had slack. That is why shipping
          cores take C almost for free in clock, and why the single-cycle number here overstates the cost.</p>`,
        pitfall: `<p>Judging C by NANDs: +${((100 * (K.c.nands - K.plain.nands)) / K.plain.nands).toFixed(1)} % looks like nothing. The price is in the clock, because every instruction now passes
          the new logic before decode. The Timing panel's critical path starts in the fetch.</p>`,
        numbers: `<table class="mini"><thead><tr><th>Single-cycle core</th><th>NANDs (no ROM)</th><th>Period</th></tr></thead><tbody>
          <tr><td>RV32I</td><td>${fmt(K.plain.nands)}</td><td>${K.plain.period}</td></tr>
          <tr><td>RV32IC</td><td>${fmt(K.c.nands)}</td><td>${K.c.period}</td></tr>
          <tr><td>difference</td><td>+${fmt(K.c.nands - K.plain.nands)}</td><td>+${K.c.period - K.plain.period}</td></tr></tbody></table>`,
      },
      challenge: {
        kind: 'quiz', question: 'The incrementer that gives the low bank its index sits in series with the ROM. How could it leave the path?',
        options: ['Keep pc >> 2 + 1 in a register of its own, computed from the next PC before the clock edge', 'Use a faster adder in the ALU', 'Make the low bank twice as large'],
        answer: 0,
        why: ['', 'The ALU is not on this part of the path; the fetch is.', 'The bank\'s size does not change which word it must read.'],
        explain: 'The next PC is known a few gates before the edge; adding one to its word index then, into a second register, moves the incrementer off the fetch and onto the end of the PC update. On this core the branch path through the ALU into the PC is itself critical, so the delay largely comes back there; it pays where the next PC is known early, as in a fetch stage with its own PC register. The fetch then starts both banks at once.',
      },
    },
    {
      title: 'Sixty-four bits',
      body: `
        <p>RV64 keeps every RV32I and M instruction and its encoding (the C extension is the exception: c.jal becomes c.addiw, c.flw becomes c.ld). What changes is <em>XLEN</em>, the width of the registers, the PC and every
        value the ALU computes: 64 bits, so an address reaches 16 EiB and a counter never wraps. <code>add</code> now adds 64 bits; <code>lw</code>
        still loads 32, sign-extended into 64. A handful of instructions are new (next step).</p>
        <p>Our generators take the width as a parameter: <code>regfile(5, n)</code>, <code>alu(n)</code>, the adders, the shifter, the multiplier.
        So the question "what does a 64-bit core cost?" has an exact answer, block by block, and the blocks fall into four kinds:</p>
        <ul>
          <li><strong>Once per bit</strong>: registers, the register file, multiplexers. Twice the bits, twice the gates, the same delay. The register
          file alone is ${groupDigits(C64('rf')!.nands[1] - C64('rf')!.nands[0])} more NANDs.</li>
          <li><strong>A tree over the bits</strong>: the Kogge–Stone adder, the shifter, the zero test. A little over twice the gates, one more level:
          the 64-bit ALU is ${C64('alu')!.depth![1] - C64('alu')!.depth![0]} NAND delays slower than the 32-bit one. A ripple adder would have doubled its delay.</li>
          <li><strong>Every bit with every bit</strong>: the multiplier's partial products. Four times the gates.</li>
          <li><strong>One bit per cycle</strong>: the iterative divider. Twice the gates and twice the time.</li>
        </ul>
        <p>The immediate generator does not grow at all: a 12- or 20-bit immediate becomes 64 bits by copying its sign bit, and copies are wires.</p>
        <p>The same split tells where to spend effort. The register file and the memories are the bulk of the area and scale linearly, so they are paid for in
        silicon but never in time. The adder and the shifter scale in time by a level. The multiplier and the divider are where width hurts, and each has a
        remedy of its own (a tree of fewer levels, a divider that retires more bits per cycle) that costs more area.</p>
        <p class="try">Pick the multiplier, then the divider: which one would you rather make faster, and at what price?</p>`,
      widget: widthCostWidget,
      more: {
        derive: `<p>Why each grows as it does. A ripple adder passes the carry through every bit: ${C64('rca')!.depth![0]} → ${C64('rca')!.depth![1]} delays for n = 32 → 64. A prefix adder has
          log<sub>2</sub> n levels: ${Math.log2(32)} → ${Math.log2(64)} levels of cells, ${C64('ks')!.depth![0]} → ${C64('ks')!.depth![1]} delays with the input and output stages. A multiplier forms n × n partial-product
          bits: ${32 * 32} → ${64 * 64}, a factor 4 in the AND array and the adders that sum it, for ${ratio(C64('mul')!.nands[1], C64('mul')!.nands[0], 1)}× the NANDs in the measured tree. A restoring divider retires one quotient bit a
          step: n + 2 cycles (the load, n steps, the result), so ${C64('div')!.depth![0]} → ${C64('div')!.depth![1]} cycles.</p>`,
        real: `<p>Wide cores keep the 64-bit multiplier but pipeline it (three cycles is common) and divide with a higher radix so that a divide takes far fewer than ${C64('div')!.depth![1]} cycles.
          Few designs use a ripple adder anywhere on the critical path; the prefix adder is the default and its extra level is invisible next to the multiplier's.</p>`,
        pitfall: `<p>"64-bit means twice as slow and twice as big." The gates of a bit-parallel block double and its delay does not change; only blocks that
          are serial along the bits (a ripple carry, the iterative divider) slow down, and only the multiplier's area quadruples. Read the table row by row.</p>`,
        numbers: `<table class="mini"><thead><tr><th>Block</th><th>NANDs, 32 bits</th><th>64 bits</th><th>×</th><th>Depth</th></tr></thead><tbody>${WIDTH_COSTS.map((r) =>
          `<tr><td>${r.name}</td><td>${fmt(r.nands[0])}</td><td>${fmt(r.nands[1])}</td><td>${ratio(r.nands[1], r.nands[0])}</td><td>${r.depth ? `${r.depth[0]} → ${r.depth[1]}` : '·'}</td></tr>`).join('')}</tbody></table>`,
      },
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
        32-bit wrap-around now sees bits above bit 31. Our sort benchmark's random generator (xorshift32) shifts left by 13, right by 17 and left by 5;
        on 64-bit registers the bits shifted past bit 31 come back down, and the program sorts different numbers. Our CRC-32 shifts its register
        right, and on RV64 the ones of a sign-extended value walk into bit 31.</p>
        <p>RV64 therefore kept 32-bit arithmetic as instructions of their own, on two new opcodes: <code>addw</code>, <code>subw</code>,
        <code>sllw</code>, <code>srlw</code>, <code>sraw</code>, their immediate forms (<code>addiw</code>, <code>slliw</code> …) and, with M,
        <code>mulw</code>, <code>divw</code>, <code>divuw</code>, <code>remw</code>, <code>remuw</code>. Each computes on the low 32 bits and
        <em>sign-extends</em> the result into 64, so a 32-bit value always sits in a register the same way, whatever produced it: <code>lw</code>
        sign-extends too (<code>lwu</code> is the new zero-extending load), and so does <code>lui</code>. Our two benchmarks need four W shifts
        between them to run correctly on RV64: the generator's three, in both, and the CRC's one.</p>
        <p>In hardware this is not a second ALU. The <span data-show="wu">W unit</span> sits around the 64-bit <span data-show="alu">ALU</span>:
        when <code>w = 1</code> it cuts each operand to 32 bits and extends it again (zeros for <code>srlw</code>, the sign for <code>sraw</code>),
        clears the shift amount's bit 5, and sign-extends the result's low half. Three multiplexers and wiring:
        ${fmt(X.wUnit.nands)} NANDs, ${X.wUnit.depth} levels. The decoder recognizes OP-32 and OP-IMM-32 by one opcode bit and hands
        them to the control unit as OP and OP-IMM.</p>
        <p>Why sign-extension rather than zero-extension: it is the one rule that keeps comparisons honest. A signed compare, a branch on
        <code>blt</code> and an <code>slt</code> all look at the full 64 bits, so a 32-bit value must already be a correct 64-bit signed number. With the extension done once, at the end of every
        32-bit operation, nothing downstream has to know that the value started as an <code>int</code>.</p>
        <p class="try">Start from 0x7FFF_FFFF + 1 with w = 0, then set w = 1: y64 stays, y turns negative.</p>`,
      scene: () => ({ root: W_ALU, inputs: { a: 0x7fffffff, b: 1, w: 0, funct3: 0, alt: 0 } }),
      tour: {
        beats: [
          { title: 'A 64-bit add', show: ['alu'], expect: { y64: 2 ** 31 },
            say: '<p>With <code>w</code> = 0 this is <code>add</code>: 0x7FFF_FFFF + 1 = {v:y64} = 0x8000_0000 in 64 bits, a positive number.</p>' },
          { title: 'The same add, W', set: { w: 1 }, show: ['wu', 'alu'], expect: { y64: 2 ** 31 },
            say: '<p>With <code>w</code> = 1 this is <code>addw</code>. The ALU is the same and <code>y64</code> still reads {v:y64}, but the result now passes the W unit: bit 31 is 1, so the upper half fills with ones and <code>y</code> is 0xFFFF_FFFF_8000_0000, −2<sup>31</sup>, the wrap-around an <code>int</code> has.</p>' },
          { title: 'A shift past bit 31', set: { a: 0x80000000, b: 1, funct3: 1, w: 0 }, show: ['alu'], expect: { y64: 2 ** 32, y: 2 ** 32 },
            say: '<p>Now <code>sll</code> of 0x8000_0000 by 1: the 64-bit result is {v:y64}, the one bit that moved past bit 31 is kept.</p>' },
          { title: 'sllw drops it', set: { w: 1 }, show: ['wu', 'alu'], expect: { y64: 2 ** 32, y: 0 },
            say: '<p>With <code>w</code> = 1 (<code>sllw</code>) the W unit keeps the low 32 bits, 0, and sign-extends them: <code>y</code> = {v:y}. The ALU still produced {v:y64}; the W unit threw the top half away, as an <code>int</code> shift does.</p>' },
        ],
      },
      more: {
        derive: `<p>The W unit's three multiplexers. Operand: a<sub>W</sub> = w ? ext(a[31:0]) : a, with ext the sign extension (zero for <code>srlw</code>, whose input must not
          carry bit 31 into the shift). Shift amount: bit 5 forced to 0 when w = 1, so <code>sllw</code> shifts by 0–31. Result: y = w ? sext(y64[31:0]) : y64. That is ${fmt(X.wUnit.nands)} NANDs and
          ${X.wUnit.depth} levels around an ALU of ${fmt(X.alu[64].nands)} NANDs: ${(100 * X.wUnit.nands / X.alu[64].nands).toFixed(0)} % extra.</p>`,
        real: `<p>On RV64 Linux an <code>int</code> is 32 bits, so compilers emit W instructions all the time (<code>addw</code>, <code>addiw</code>, <code>sext.w</code> is
          <code>addiw rd, rs, 0</code>). That is the price of keeping every 32-bit result a canonical sign-extended 64-bit one: code written for 32-bit machines runs as it did.</p>`,
        pitfall: `<p>Using <code>addi</code> where the C source adds <code>int</code>s. Both compile and agree until the sum crosses 2<sup>31</sup>; then <code>addi</code> leaves 0x8000_0000 as a
          positive 64-bit number and the next signed compare says it is larger than 0. In the scene, change w and watch the sign.</p>`,
      },
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
        <p>Both columns are one drawing built at two widths, with Kogge–Stone adders and a 32-word data memory, so the 32-bit column is not chapter ${numOf('cpu')}'s ripple core (${fmt(RVC_COSTS.plain.nands)} NANDs, ${RVC_COSTS.plain.period} delays) that the C extension was measured against.</p>
        <p>×${(X.rv64im.nands / X.rv32im.nands).toFixed(2)} the gates, the largest share in the multiplier (×${(X.mUnit[64] / X.mUnit[32]).toFixed(1)}) and in storage
        that simply doubles. The period grows by ${pct(X.rv64im.period, X.rv32im.period)} %. The Timing panel shows the critical path running through the
        multiplier, whose tree gained levels and whose final adder doubled; without M the core goes from ${X.rv32i.period} to ${X.rv64i.period} delays,
        because the adders and the shifter gained a level and a W instruction's result passes the W unit. The benchmarks compute on 32-bit values, so the RV64 core runs the same loops (the generator's shifts and CRC-32's
        as W shifts), and sort and CRC-32 run two more instructions each, once: an <code>li</code> of a constant above 2³¹, which is a positive number on
        RV64 and no longer fits lui + addiw. It is ${(X.rv64im.period / X.rv32im.period).toFixed(2)} times slower on them and buys nothing.</p>
        <p>It pays when the values are 64 bits wide: F(90) and 20! in the samples need one <code>add</code> or <code>mul</code> per step here.
        On RV32 a 64-bit add is four instructions (add, sltu for the carry, add, add), and the low 64 bits of a product take four multiplies (mul, mulhu and two cross products) and two adds.
        And it pays when memory is larger than 4 GiB, which is why desktop and phone processors went to 64 bits.</p>
        <p class="try">Run "20! with mul" to its halt, then pick "Benchmark: CRC-32" and run it too.</p>`,
      scene: () => cpu64Scene({ source: PROGRAMS64[0].source, timing: true }),
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['pc', 'imem'], expect: { pcOut: 0, retire: 1 },
            say: '<p>A 64-bit PC and register file, a 32-bit instruction word: the encodings are RV32\'s. This core retires one instruction every cycle (retire = {v:retire}).</p>' },
          { title: 'A constant', cycles: 2, show: ['alu', 'rf'], expect: { pcOut: 8, aluOut: 90 },
            say: '<p>The instruction at {v:pcOut} is <code>li t0, 90</code>: the 64-bit ALU adds 90 to zero, <code>aluOut</code> = {v:aluOut}. The upper 32 bits are zero here.</p>' },
          { title: 'Straight on', cycles: 5, show: ['pc'], expect: { pcOut: 28, retire: 1 },
            say: `<p>Seven cycles, seven instructions: the PC is {v:pcOut}. The 32-bit core would take as many cycles on this code, but each of its cycles is shorter: ${X.rv32im.period} NAND delays against ${X.rv64im.period} here.</p>` },
        ],
      },
      more: {
        derive: `<p>The ratios, from the measurement above. Whole core: ${fmt(X.rv64im.nands)} / ${fmt(X.rv32im.nands)} = ${ratio(X.rv64im.nands, X.rv32im.nands)}. Of the ${fmt(X.rv64im.nands - X.rv32im.nands)} NANDs added, the M unit
          is ${fmt(X.mUnit[64] - X.mUnit[32])} (${(100 * (X.mUnit[64] - X.mUnit[32]) / (X.rv64im.nands - X.rv32im.nands)).toFixed(0)} %), the register file ${fmt(X.regfile[64] - X.regfile[32])}, the data memory ${fmt(X.dmem[64] - X.dmem[32])},
          the ALU ${fmt(X.alu[64].nands - X.alu[32].nands)}, loads and stores ${fmt(X.lsu[64] - X.lsu[32])}, the W unit ${fmt(X.wUnit.nands)}; the rest
          (${fmt(X.rv64im.nands - X.rv32im.nands - (X.mUnit[64] - X.mUnit[32]) - (X.regfile[64] - X.regfile[32]) - (X.dmem[64] - X.dmem[32]) - (X.alu[64].nands - X.alu[32].nands) - (X.lsu[64] - X.lsu[32]) - X.wUnit.nands)}) is the PC, the next-PC adder, the decode and the muxes between them. Without M the ratio is ${ratio(X.rv64i.nands, X.rv32i.nands)}.</p>`,
        real: `<p>A phone or desktop core is 64-bit for the address space and the data it moves, not for arithmetic speed; its multiplier is pipelined and its 64-bit
          add fits one cycle at several GHz. The 32-bit RISC-V cores that remain are small embedded ones, where the register file and the multiplier are the area.</p>`,
        pitfall: `<p>Comparing the two cores' cycle counts and concluding they are equal. One instruction a cycle on both, but the period is ${X.rv64im.period} against ${X.rv32im.period}
          (+${pct(X.rv64im.period, X.rv32im.period)} %), so time per instruction is not. Compare time, not cycles.</p>`,
      },
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
