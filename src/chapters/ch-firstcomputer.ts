// "A first computer": an eight-instruction 8-bit accumulator machine (acc8/acc8.ts the ISA and golden model, lib/acc8.ts
// the gates, widgets/acc8.ts the panel), built only from parts the chapters before it open: a register, a counter's
// incrementer, the adder / subtractor, multiplexers, a ROM and the RAM of the last chapter. One instruction per clock,
// program ROM apart from data RAM, as the single-cycle RV32I chapters will be. Every number below is computed from the
// golden model or pinned to the gates by tests/firstcomputer.test.ts.

import { ACC_OPS, ACC_PROGRAMS, AccISS, accAssemble } from '../acc8/acc8';
import { RESULTS } from '../bench/summary';
import { accControl, ACC_CTL_OUTS } from '../lib/acc8';
import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { groupDigits as k } from '../sim/numfmt';
import type { Stage } from '../view/stage';
import { accHw, accScene } from '../widgets/acc8';
import { numOf } from './order';
import type { Chapter } from './types';

/**
 * What the machine costs in NANDs, part by part (stats of lib/acc8.ts's instances; tests/firstcomputer.test.ts holds
 * every one to the gates), and its period in NAND delays (sim/timing.ts on the whole machine).
 */
export const ACC_COST = {
  acc: 120, out: 120, pc: 75, inc: 25, jmux: 20, alu: 108, mux: 32, zero: 22, ctl: 49, halt: 35,
  rom: 992, ram: 5157, total: 6787, period: 61,
  /** Arrival times along the critical path, in NAND delays: PC's clock-to-q, ROM, RAM read, adder, the two muxes, A. */
  path: { pc: 3, rom: 18, ram: 29, alu: 52, mux2: 56, acc: 58 },
} as const;
/** NANDs of everything but the two memories. */
export const ACC_LOGIC = ACC_COST.total - ACC_COST.rom - ACC_COST.ram;

const RV32I = RESULTS.cpus.find((c) => c.id === 'sc')!;

const run = (src: string) => new AccISS(accAssemble(src)).run();
const MUL = (() => {
  const m = run(ACC_PROGRAMS.mul), words = accAssemble(ACC_PROGRAMS.mul).length;
  return { words, clocks: m.steps, outAt: m.outs[0].clock, value: m.outs[0].value };
})();
const SUM = run(ACC_PROGRAMS.sum);
const COUNT = run(ACC_PROGRAMS.countdown);

/** The same 6 × 7 loop in RV32I: count in a register, the sum in another; instructions retired to the result. */
export const MUL_RV = (() => {
  const src = `li t0, 6
li t1, 0
loop: beqz t0, done
addi t1, t1, 7
addi t0, t0, -1
j loop
done: j done`;
  const iss = new ISS(assemble(src).words);
  let n = 0;
  while (iss.x[6] !== 42 || iss.x[5] !== 0) { iss.step(); n++; if (n > 1000) break; }
  return { src, instrs: n + 1, loop: 4 };
})();
/** The accumulator machine's 6 × 7: instructions in one round of the loop, and loads + stores in the whole run. */
const MUL_LOOP = 8;
const MUL_MEM = (() => {
  const w = accAssemble(ACC_PROGRAMS.mul), m = new AccISS(w);
  let mem = 0;
  while (!m.halted) { const op = ACC_OPS[m.word >> 5]; if (op === 'LDA' || op === 'STA' || op === 'ADD' || op === 'SUB') mem++; m.step(); }
  return mem;
})();

const COPY = `# copy M[3] to M[4]
      LDI 9
      STA 3         # M[3] = 9
      LDA 3         # A = M[3]
      STA 4         # M[4] = A
halt: JMP halt`;

/** The answer to step 7's challenge: 3 × 9 by repeated addition. */
const MUL27 = ACC_PROGRAMS.mul.replace('# 6 x 7', '# 3 x 9').replace('LDI 6', 'LDI 3').replace('LDI 7', 'LDI 9').replace('sum + 7', 'sum + 9');

const out = (st: Stage) => (st.sim && st.scene?.root.id.startsWith('acc8_') ? accHw(st.sim).out : -1);
const mem = (st: Stage, i: number) => (st.sim && st.scene?.root.id.startsWith('acc8_') ? accHw(st.sim).mem[i] : -1);

/** The control table: one row per instruction, a column per line, as the decoder's OR gates make it (Z = 1 for JZ). */
const ctlTable = () => {
  const cols = ACC_CTL_OUTS.filter((c) => c !== 'jmp');
  const head = `<tr><th>op</th><th>instr</th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
  const rows = ACC_OPS.map((o, op) => {
    const c0 = accControl(op, 0), c1 = accControl(op, 1);
    const cell = (n: (typeof cols)[number]) => (c0[n] === c1[n] ? `<td${c0[n] ? ' class="on"' : ''}>${c0[n]}</td>` : '<td class="on">Z</td>');
    return `<tr><td>${op.toString(2).padStart(3, '0')}</td><td>${o}</td>${cols.map(cell).join('')}</tr>`;
  }).join('');
  return `<table class="acc-table">${head}${rows}</table>`;
};

export const chFirstComputer: Chapter = {
  id: 'firstcomputer', num: numOf('firstcomputer'), title: 'A first computer', level: 'Processor',
  blurb: 'Eight instructions, one register, one clock each: a counter reads a ROM, a decoder tells the rest what to do, and a computer runs.',
  goals: [
    'build a computer from parts already opened: a counter, a ROM, a register, the adder, multiplexers and the RAM',
    'follow one instruction through a clock: fetched, split into fields, decoded into control lines, done at the edge',
    'see how a jump and a flag let a program loop and stop, and write one',
    'say what the machine costs, part by part, and what a larger processor changes',
  ],
  builds: ['adders', 'registers', 'memory'],
  recap: {
    keep: [
      'A computer is a counter, a memory, a register and a decoder. The counter (the PC) reads the next word; the decoder turns its op bits into control lines; at the rising edge every register takes its new value.',
      `One instruction per clock: the clock has to wait for the slowest instruction's path, here PC → ROM → RAM → adder → A, ${ACC_COST.period} NAND delays.`,
      'A jump is a load into the counter, and a flag (Z) makes it conditional: that is all a program needs to loop and to stop.',
      `The control block is ${ACC_COST.ctl} NANDs; the RAM is ${k(ACC_COST.ram)}. Deciding is cheap, remembering is not.`,
    ],
    practise: ['m_acc'],
    check: [
      {
        question: 'Which part of the machine changes at the rising edge of a JZ instruction when A = 5?',
        options: ['Only the PC, to PC + 1', 'The PC, to the jump target', 'A and the PC', 'Nothing: JZ only reads'],
        answer: 0,
        explain: 'Z is 0 (A is not 0), so the jump line stays off: the PC\'s multiplexer passes PC + 1, and A, OUT and the RAM are not enabled.',
        why: ['', 'The jump line is JZ AND Z, and Z is 0 while A = 5.', 'A loads only on LDA, ADD, SUB and LDI.', 'The PC always takes a new value: PC + 1 or the target.'],
      },
      {
        question: 'Why can this machine not run a program longer than 32 instructions?',
        options: ['The PC and the address field are 5 bits wide', 'The ROM is too slow', 'Each instruction needs a clock', 'The RAM holds 32 bytes'],
        answer: 0,
        explain: 'Five bits count 0 … 31. The PC wraps from 31 to 0, and a jump\'s target is a 5-bit field, so nothing can reach a 33rd word.',
        why: ['', 'Speed sets the period, not the size.', 'Every machine here takes a clock per instruction; that limits time, not length.', 'The RAM holds data; the program is in the ROM, read by the PC.'],
      },
      {
        question: `The 6 × 7 loop takes ${MUL_LOOP} instructions a round here and ${MUL_RV.loop} on chapter ${numOf('cpu')}'s 32-register processor. What makes the difference?`,
        options: ['It keeps both numbers in registers, so nothing goes back to memory each round', 'Its clock is faster', 'It has a multiply instruction', 'Its words are wider'],
        answer: 0,
        explain: 'With one register, the count and the sum take turns in A: each must be loaded, changed and stored again every round. With 32 registers both stay put.',
        why: ['', 'Clock speed changes time, not the instruction count.', 'The loop compared uses adds; that processor has no multiply.', 'Width does not remove a load or a store.'],
      },
    ],
  },
  steps: [
    {
      title: 'A counter reads a ROM',
      body: `
        <p>Every part on this stage has been opened in an earlier chapter. Put together, they make a computer: a machine
        that does what a list of numbers tells it to.</p>
        <p>Start at the left. The <span data-show="pc">program counter</span> (PC) is a 5-bit register. Its output
        addresses the <span data-show="rom">ROM</span>, 32 words of 8 bits, and also feeds an
        <span data-show="inc">incrementer</span>, whose PC + 1 goes back through a
        <span data-show="jmux">multiplexer</span> into the PC. So at every rising edge the PC steps on, and a new word
        comes out of the ROM. Nothing more is needed to <em>fetch</em>: a counter reading a memory.</p>
        <p>The program on the stage only shows numbers: its words say in turn "put this number in A" and "show A", and
        the last one sends the PC back to 0. Run it and watch 1, 2, 3 appear on OUT, then the PC jump back to 0 and start
        again. How each word is read is the next step's subject.</p>
        <p>Cost of fetching: the PC is ${ACC_COST.pc} NANDs, the incrementer ${ACC_COST.inc}, the multiplexer
        ${ACC_COST.jmux}; the ROM, simulated as a lookup, is a tree of ${k(ACC_COST.rom)} NANDs of multiplexers whose
        inputs are tied to the program's bits.</p>
        <div class="try">Pulse a few times: the PC in the panel counts 0, 1, 2 …, and the highlighted line follows it.</div>`,
      scene: () => accScene({ program: 'fetch', highlight: ['pc', 'inc', 'jmux', 'rom'] }),
      tries: [(st) => !!st.sim && st.cycles >= 3],
      challenge: {
        kind: 'quiz',
        question: 'The ROM holds 32 words. What sets that number?',
        options: ['The PC is 5 bits wide: it counts 0 … 31', 'The ROM is built of 32 multiplexers', 'Each word is 8 bits', 'The clock period'],
        answer: 0,
        explain: 'A 5-bit address names 2⁵ = 32 words. A wider PC would reach more ROM; the instruction\'s jump field would have to grow with it.',
        why: ['', 'The tree has 31 two-input multiplexers per output bit; that follows from the size, not the other way round.', 'The width of a word sets what one instruction can say, not how many there are.', 'The period sets how fast the words come, not how many.'],
      },
    },
    {
      title: 'Splitting the word: LDA and STA',
      body: `
        <p>A word is 8 bits. The <span data-show="f">splitter</span> cuts it into two fields: the top 3 bits, the
        <strong>op</strong>, say what to do; the low 5 bits, <strong>x</strong>, say where. Three bits name eight
        instructions; five name any of the 32 bytes of the <span data-show="ram">RAM</span>, which takes x on its
        address input directly.</p>
        <table class="acc-table"><tr><th>op</th><th>instr</th><th>does</th></tr>
        ${ACC_OPS.map((o, i) => `<tr><td>${i.toString(2).padStart(3, '0')}</td><td>${o}${o === 'OUT' ? '' : o === 'LDI' ? ' k' : ' a'}</td><td style="text-align:left">${['A ← M[a]', 'A ← A + M[a]', 'A ← A − M[a]', 'M[a] ← A', 'A ← k (0 … 31)', 'PC ← a (to itself: halt)', 'PC ← a if A = 0', 'OUT ← A'][i]}</td></tr>`).join('')}</table>
        <p>The machine has one register for data, <span data-show="acc">A</span>, the <em>accumulator</em>: every
        result lands in it and every value leaves from it. <code>LDA a</code> copies M[a] into A: the RAM reads the
        addressed byte, the multiplexers pass it, and A loads it at the edge. <code>STA a</code> does the opposite: A is
        always on the RAM's data input, and STA raises its write enable, so at the edge M[a] takes A.</p>
        <p>The program here puts 9 in M[3] (<code>LDI</code> loads the 5 bits of x themselves, a constant), then copies
        M[3] to M[4] through A. Four instructions, four clocks: there is no other way for one byte to reach another.</p>
        <div class="try">Pulse four times and watch the RAM: M[3] becomes 9, then M[4].</div>`,
      scene: () => accScene({ source: COPY, highlight: ['f', 'ram', 'acc', 'mux1', 'mux2'] }),
      tries: [(st) => mem(st, 4) === 9],
      challenge: {
        kind: 'quiz',
        question: 'The word <code>01100100</code> is in the ROM. What does it do?',
        options: ['STA 4: M[4] ← A', 'LDA 4: A ← M[4]', 'ADD 12', 'LDI 4'],
        answer: 0,
        explain: 'The top three bits 011 are op 3, STA; the low five, 00100, are x = 4.',
        why: ['', 'LDA is op 000.', 'The op field is the top three bits, not the top four.', 'LDI is op 100.'],
      },
    },
    {
      title: 'Add and subtract',
      body: `
        <p>The <span data-show="alu">adder / subtractor</span> of chapter ${numOf('adders')} sits between A and the RAM's
        output: it adds M[x] to A, or subtracts it when its <code>sub</code> input is 1 (the two's complement: invert
        M[x] and carry in a 1). Its result is a third candidate for A's next value, so A's input now has three sources:
        M[x] (LDA), the sum (ADD, SUB) and x itself (LDI). Two 2-input <span data-show="mux1 mux2">multiplexers</span>
        choose: the first between the sum and M[x], the second between that and k, x widened to 8 bits with zeros.</p>
        <p>Every instruction still takes one clock, which means the clock has to wait for the slowest one. That is ADD or
        SUB: after the edge the PC settles (${ACC_COST.path.pc} NAND delays), the ROM gives the word (${ACC_COST.path.rom}),
        the RAM reads M[x] (${ACC_COST.path.ram}), the carry ripples through 8 bits (${ACC_COST.path.alu}), the two
        multiplexers pass the sum (${ACC_COST.path.mux2}) and A's flip-flops need it a few delays before the next edge:
        a period of <strong>${ACC_COST.period} NAND delays</strong>. LDI, which uses none of the RAM or the adder, is done
        far sooner and then waits.</p>
        <p>Cost: the adder ${ACC_COST.alu} NANDs, each multiplexer ${ACC_COST.mux}, A ${ACC_COST.acc}.</p>
        <div class="try">Run 6 × 7 to halt: the sum in M[28] grows by 7 each time round.</div>`,
      scene: () => accScene({ program: 'mul', highlight: ['alu', 'mux1', 'mux2', 'acc'] }),
      tries: [(st) => out(st) === 42],
      challenge: {
        kind: 'quiz',
        question: 'Which instruction decides the clock period of this machine?',
        options: ['ADD (or SUB): it goes through the ROM, the RAM and the adder', 'LDI: it is the first in most programs', 'JMP: it changes the PC', 'STA: it writes the RAM'],
        answer: 0,
        explain: 'A single clock has to fit the longest path any instruction uses. ADD reads the ROM, then the RAM, then ripples through the adder into A.',
        why: ['', 'LDI skips the RAM and the adder: its path is the shortest.', 'The jump only switches the PC\'s multiplexer: PC, ROM, decoder, multiplexer.', 'STA\'s path ends at the RAM\'s input, before the adder.'],
      },
    },
    {
      title: 'A jump is a load into the counter',
      body: `
        <p>So far the PC only counts. To go anywhere else, it loads: the <span data-show="jmux">multiplexer</span> in
        front of it passes x, the word's address field, instead of PC + 1, whenever the control line
        <code>jump</code> is 1. <code>JMP a</code> raises it. That is all a jump is: one multiplexer and one control
        line, and it costs no extra clock, because the next PC is chosen before the edge, like every other next value.</p>
        <p>A machine with no "stop" instruction stops by jumping to itself: <code>halt: JMP halt</code> loads the PC
        with its own address forever. The <span data-show="self hlt">halt test</span> (a 5-bit comparator and an AND,
        ${ACC_COST.halt} NANDs) recognizes it and raises the <code>halt</code> output, which is what the panel's Run waits
        for. The <span data-ahead="rv32i">RV32I programs (written for the 32-bit processor this book builds next)</span> end the same way, with <code>j .</code>.</p>
        <div class="try">Load the fetch loop (the panel's program menu) and Pulse past its last word: the PC goes from 6
        back to 0, not on to 7.</div>`,
      scene: () => accScene({ program: 'fetch', highlight: ['jmux', 'pc', 'self', 'hlt'] }),
      tries: [(st) => !!st.sim && st.cycles >= 7],
      challenge: {
        kind: 'quiz',
        question: 'Why does a jump cost no extra clock here?',
        options: ['The PC\'s next value is chosen by a multiplexer before the edge, like A\'s', 'The ROM reads two words at once', 'A jump skips the RAM', 'Jumps run on the falling edge'],
        answer: 0,
        explain: 'Every register takes its next value at the same rising edge. For the PC that value is PC + 1 or x, picked during the clock; either is ready in time.',
        why: ['', 'The ROM reads one word, at the PC.', 'It does skip the RAM, but that makes it shorter, not free: the reason is the multiplexer.', 'Everything here happens at the rising edge.'],
      },
    },
    {
      title: 'A flag, and the first loop that ends',
      body: `
        <p>A loop that never stops is easy: <code>JMP 0</code>. To stop it, the machine has to look at a value and
        choose. Eight bits into one <span data-show="zero">zero detector</span> (a NOR of every bit, ${ACC_COST.zero}
        NANDs) give one wire, <strong>Z</strong>, that is 1 when A is 0: a <em>flag</em>. <code>JZ a</code> raises the
        jump line only when Z is 1, through one AND gate in the control.</p>
        <p>That is enough for multiplication. The program counts down in M[29] and adds 7 into M[28] each round, and
        leaves when the count reaches 0. It is ${MUL.words} words long; a round of the loop is ${MUL_LOOP} instructions, so
        ${MUL_LOOP} clocks; OUT shows <strong>${MUL.value}</strong> at clock ${MUL.outAt}, and the halt loop is reached at
        clock ${MUL.clocks}.</p>
        <p>Why the count goes through A: Z looks at A, the only value the adder and the registers see. So each round loads
        the count, tests it, decrements it, stores it, then loads the sum, adds, stores it: one register, so the two
        numbers take turns in it, and ${MUL_MEM} of the ${MUL.clocks} instructions the program runs are loads, stores or
        RAM operands.</p>
        <div class="try">Run to halt and watch A and M[29]; OUT shows 42 once the count is 0.</div>`,
      scene: () => accScene({ program: 'mul', highlight: ['zero', 'ctl', 'jmux'] }),
      tries: [(st) => out(st) === 42],
      challenge: {
        kind: 'quiz',
        question: 'Why does JZ test A, not the count in M[29] directly?',
        options: ['Z is wired to A: the only value the flag can see', 'Memory cannot hold a zero', 'JZ is faster on a register', 'M[29] is read only'],
        answer: 0,
        explain: 'The zero detector\'s inputs are A\'s outputs. To test anything else, it must first be loaded into A.',
        why: ['', 'M[29] holds 0 at the end; the RAM stores any byte.', 'Speed is not the reason: the detector simply has no wire to the RAM.', 'STA writes M[29] every round.'],
      },
    },
    {
      title: 'The control is a decoder',
      body: `
        <p>Every part so far waited to be told what to do: A to load or hold, the multiplexers which source to take, the
        adder whether to subtract, the RAM whether to write, the PC whether to jump, OUT whether to load. All of it
        depends on the three op bits, and on Z for JZ. So the <span data-show="ctl">control block</span> is a 3 → 8
        decoder, one line per instruction, and each control line is the OR of the instruction lines that need it:</p>
        ${ctlTable()}
        <p>Each 1 is a line the instruction raises; the <strong>Z</strong> in JZ's jump column means the line is Z itself,
        1 only while A is 0. Open the control block (double-click it): the decoder's eight lines go into four OR gates and one AND, and that table
        is the whole of what the machine "understands": ${ACC_COST.ctl} NANDs, against ${k(ACC_LOGIC - ACC_COST.ctl)} for the rest of
        the logic and ${k(ACC_COST.ram)} for the RAM. Chapter ${numOf('cpu')}'s <span data-ahead="control">control unit (the decoder that drives every control line of a processor)</span> is the same idea with more
        rows and wider columns. Appendix C's SAP-1 spreads each instruction over several clocks and keeps its table in a
        ROM instead.</p>
        <div class="try">Click lines of the program in the panel: the parts each instruction
        uses light, and the control lines it raises are shown above the listing.</div>`,
      scene: () => accScene({ program: 'mul', highlight: ['ctl'] }),
      challenge: {
        kind: 'quiz',
        question: 'A new instruction <code>ADDK k</code> (A ← A + k) is wanted. Besides a decoder line, what must change in the hardware?',
        options: ['The adder\'s second input needs a multiplexer: M[x] or k', 'Nothing: OR gates are enough', 'A second accumulator', 'A wider PC'],
        answer: 0,
        explain: 'Control lines can only steer paths that exist. The adder takes A and M[x]; for A + k, k must reach the adder, through a new multiplexer and a line to choose it.',
        why: ['', 'The ORs make control lines; no line can create a wire from k to the adder.', 'The result still lands in A.', 'The program length is unchanged.'],
      },
    },
    {
      title: 'Program it',
      body: `
        <p>The program text becomes ROM words through the machine's <span data-ahead="assembly">assembler (the program that turns each line, like <code>LDA 29</code>, into its word)</span>, here a table: each instruction a mnemonic, its operand and its bit
        pattern (<code>LDA</code> is <code>000aaaaa</code>), the same kind of table the sandbox lets you write for a machine of your own. Labels
        (<code>loop:</code>) stand for addresses, <code>#</code> starts a comment. Open <em>Edit</em> in the panel,
        change a program, and <em>Assemble &amp; load</em> builds a new ROM and puts the machine on the stage, with the
        <span data-ahead="golden">golden model (a plain program that does what each instruction should, run beside the gates to check them)</span> in step beside it.</p>
        <p>Three things to keep in mind: the RAM starts at 0, so a program sets up its own data (LDI, then STA); LDI
        reaches only 0 … 31, so a larger number is built by adding; and the program ends with a jump to itself.</p>
        <p>The other programs: 1 + 2 + … + 10 shows ${SUM.outs[0].value} at clock ${SUM.outs[0].clock}; the countdown shows
        ${COUNT.outs.map((o) => o.value).join(', ')}.</p>`,
      scene: () => accScene({ program: 'mul', highlight: [] }),
      challenge: {
        kind: 'reach',
        goal: 'Make OUT show 27, three times nine, with a loop of ADDs (no number above 31 in the program).',
        check: (st) => out(st) === 27,
        hints: [
          'Start from 6 × 7: which two LDI constants are the factors?',
          'Change LDI 6 to LDI 3 and LDI 7 to LDI 9, assemble, and Run to halt.',
        ],
        answer: `<pre>${MUL27}</pre>`,
        solve: (st) => { st.load(accScene({ source: MUL27 })); st.runCycles(200, () => out(st) === 27); },
      },
    },
    {
      title: 'What a real instruction set changes',
      body: `
        <p>This machine is complete: it fetches, decodes, computes, remembers, jumps and decides. What it lacks is room.
        Chapter ${numOf('cpu')}'s <span data-ahead="rv32i">RV32I processor (a 32-bit design whose instruction list is an open standard)</span> keeps the same plan, a PC reading instructions, a decoder raising
        control lines, everything changing at one edge, and changes four things:</p>
        <ul>
          <li><strong>32 registers instead of one A.</strong> 6 × 7 in RV32I keeps the count and the sum in two
          registers: a round is ${MUL_RV.loop} instructions instead of ${MUL_LOOP}, with no load or store in it.</li>
          <li><strong>Operands named in the instruction.</strong> <code>add rd, rs1, rs2</code> names two sources and a
          destination; nothing has to be moved into place first.</li>
          <li><strong>32-bit words and addresses.</strong> 5 bits reach 32 words; 32 bits reach 4 GB of bytes, and a
          12-bit constant (−2048 … 2047) fits in one instruction.</li>
          <li><strong>Branches that compare two registers.</strong> <code>beq</code>, <code>blt</code> …: the flag is
          computed by the branch itself, not kept from the last result.</li>
        </ul>
        <p>All of that costs gates. Without its memories this machine is ${k(ACC_LOGIC)} NANDs; the RV32I
        CPU of chapter ${numOf('cpu')} is ${k(RV32I.nands)}, its program ROM aside. The next three chapters build its
        parts: the arithmetic unit, the register bank and the list of instructions with their encodings. The sandbox's Examples ▸ 4-bit CPU is a
        third design, an accumulator machine with sixteen registers beside it, in the style of Intel's 4004.</p>`,
      scene: () => accScene({ program: 'mul', highlight: [] }),
      challenge: {
        kind: 'quiz',
        question: 'Which change removes the most instructions from the 6 × 7 loop?',
        options: ['More registers: the count and the sum stay out of memory', 'Wider words', 'A faster adder', 'More ROM'],
        answer: 0,
        explain: `With registers, the loads and stores that shuttle the two numbers through A disappear: ${MUL_LOOP} instructions a round become ${MUL_RV.loop}.`,
        why: ['', '8 bits hold 42; width removes no instruction here.', 'A faster adder shortens the period, not the count.', 'The program already fits.'],
      },
    },
  ],
};
