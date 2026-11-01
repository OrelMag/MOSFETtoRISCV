import { cpuState } from '../riscv/cosim';
import { pyCompile, pyCost, pyLinked, pyProfile, pyScene } from '../widgets/python';
import { PY_PROGRAMS } from '../lang/pyprograms';
import type { Chapter } from './types';

// Every number in the prose is recomputed by tests/python-chapter.test.ts from the compiler (src/lang), the golden
// model and the gate-level CPU the scenes build (singleCycleCpu with PY_IMEM_K / PY_DMEM_K).

const src = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!.source;
const fmt = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');

/** Cycles the golden model needs for a sample program, and per Python line (own + runtime routines called from it). */
const PROF = (id: string) => { const c = pyCompile(src(id)); return { c, p: pyProfile(c) }; };
const SUM = PROF('sum');
const lineCycles = (r: { p: ReturnType<typeof pyProfile> }, l: number) => (r.p.own.get(l) ?? 0) + (r.p.rt.get(l) ?? 0);
const COST = ['sum', 'collatz', 'gcd', 'fib'].map((id) => ({ id, name: PY_PROGRAMS.find((p) => p.id === id)!.name, words: PROF(id).c.words.length, steps: PROF(id).p.steps }));
/** Calls a recursive fib(n) makes: the whole call tree. */
const primesBelow = (n: number) => { let k = 0; for (let i = 2; i < n; i++) { let p = true; for (let j = 2; j * j <= i; j++) if (i % j === 0) p = false; if (p) k++; } return k; };
const fibCalls = (n: number): number => (n < 2 ? 1 : 1 + fibCalls(n - 1) + fibCalls(n - 2));

export const chPython: Chapter = {
  id: 'python', num: 15, title: 'From Python to gates', level: 'Software',
  blurb: 'A Python program compiled to RV32I by the site\'s own compiler and run on the gate-level CPU, line by line down to the toggles.',
  goals: [
    'follow a Python line to its RV32I instructions, their machine words and the fields the decoder reads',
    'say where a compiler keeps variables (registers, data memory, the stack) and what an expression needs',
    'price a line in clock cycles, and say why <code>a % b</code> costs a loop on a CPU without a divider',
    'run a Python program on the gates and read its variables, its output and its stack from the hardware',
  ],
  builds: ['isa', 'cpu'],
  recap: {
    keep: [
      'A compiler maps a program onto the machine: each variable gets a home (a register while it can, data memory when a function shares it, the stack across calls), each expression a stack of temporaries, each test a branch.',
      'Nothing new runs on the CPU: the compiled words are the same RV32I chapter 14 decodes, so the golden model checks a Python program cycle by cycle as it checked hand-written assembly.',
      'Cost is visible per line. On the single-cycle CPU a line costs one cycle per instruction it executes: <code>total += i</code> is one <code>add</code>; <code>a % b</code> with b unknown is a call to a 32-step shift-and-subtract routine, about 240 cycles.',
      'Calls cost frames: the return address and every saved register go to the stack and come back, and a value computed before a call waits there across it.',
    ],
    check: [
      {
        question: '<code>n // 2</code> compiles to one <code>srai</code>. Why is that exactly Python\'s floor division, for negative n too?',
        options: ['An arithmetic shift right rounds toward minus infinity, as // does', 'Python rounds toward zero, and so does srai', 'It is not exact: the compiler accepts an error for negative n', 'srai calls the divide routine for negative n'],
        answer: 0,
        explain: 'Shifting a two\'s-complement number right by one, copying the sign bit in, is ⌊n / 2⌋: −7 becomes −4. Python\'s // is also the floor. Division by a power of two that is not a floor (C\'s, toward zero) needs a correction; Python\'s needs none.',
        why: ['', 'Python\'s // is the floor: −7 // 2 is −4, not −3.', 'Both are the floor: the test suite checks every edge case against the interpreter.', 'srai is one instruction; there is no call.'],
      },
      {
        question: 'Why does a top-level variable that a function reads live in data memory, and not in a register?',
        options: ['The function uses the registers for its own variables and saves them on entry; only memory is shared by every function', 'Registers are slower than memory', 'RV32I cannot read a register in a function', 'Python requires globals to be in memory'],
        answer: 0,
        explain: 'Each function saves the s registers it uses and gives them back on return. A global in s3 would be invisible inside a function that keeps its own variable there; a word of data memory has one address for everyone.',
        why: ['', 'A register is read in the same cycle; a load also takes one cycle on this CPU, but needs an instruction more.', 'Any instruction can read any register.', 'Python says nothing about registers; this is the compiler\'s choice.'],
      },
      {
        question: 'fib(n − 1) + fib(n − 2): where is fib(n − 1)\'s result while fib(n − 2) runs?',
        options: ['On the stack: t0 is pushed around the second call, because the callee uses t0 too', 'In t0, which the callee never touches', 'In a0, the return register', 'In data memory at a fixed address'],
        answer: 0,
        explain: 'Temporaries are the caller\'s to save: the compiler stores the live ones (here t0) below sp before the call and loads them after. The stack panel shows the word labelled "t0: waiting across a call".',
        why: ['', 'The callee evaluates its own expressions in t0–t6.', 'a0 carries fib(n − 2)\'s result back, overwriting it.', 'A fixed address would be overwritten by the recursion\'s deeper calls.'],
      },
    ],
  },
  steps: [
    {
      title: 'One program, three languages',
      body: `
        <p>The site compiles a small Python to RV32I: integers (32-bit, they wrap), <code>if</code>, <code>while</code>,
        <code>for … in range</code>, functions with recursion, global lists, <code>print</code>. No strings, floats or
        objects: each needs a heap or a runtime the CPU does not have yet.</p>
        <p>Four lines become 12 instructions. Each variable gets a register (<code>total</code> → s0,
        <code>i</code> → s1), the loop's test becomes one branch, and <code>total += i</code> one <code>add</code>.
        <code>print</code> is a store at gp, the output pointer, and gp moves on a word.</p>
        <p>Nothing here is new hardware: the words on the right go into chapter 14's ROM, and the decoder splits them
        into exactly the fields it split from hand-written assembly. Point at a line in any column; click to pin it and
        see its fields.</p>
        <p>The mapping has a fixed shape: each Python line owns a contiguous run of instructions, and a line that is a loop header owns the test and the jump back as well.
        Nothing on the right-hand side knows Python exists. That separation is the reason a compiler is a separate program: the hardware executes words, and every language
        reaches it the same way. Reading the three columns together is the quickest way to learn what a language construct costs.</p>`,
      widget: () => pyLinked('sum', 3),
      more: {
        derive: `<p>Counting the 12: two instructions set the stack pointer and the output pointer (<code>sp</code> = 256, <code>gp</code> = 0), two give <code>total</code> and <code>i</code> their first values,
          five make the loop (the limit into t1, the test <code>bge</code>, the <code>add</code>, the <code>addi</code> and the jump back), two are the <code>print</code> (a store at gp and gp + 4),
          and one jumps to itself to halt. The golden model runs the whole program in ${SUM.p.steps} cycles, and line 3's single <code>add</code> accounts for ${lineCycles(SUM, 3)} of them: one per pass.</p>`,
        pitfall: `<p>Expecting one instruction per source line. Line 2, the <code>for</code>, is not one instruction but several (the limit, the test, the jump back), and its test runs on every pass
          including the one that ends the loop. Point at a Python line and count the highlighted words on the right before trusting a cost estimate.</p>`,
        real: `<p>An optimizing compiler would hoist the limit out of the loop and probably unroll it; this one deliberately emits the plain translation so that the correspondence stays visible.
          The same program through a production compiler at -O2 is a few instructions, and at -O0 it looks like this listing, only with every variable kept in memory.</p>`,
      },
    },
    {
      title: 'Expressions and registers',
      body: `
        <p>An expression is evaluated on a stack of temporaries: t0 for the outermost value, t1 for an operand one
        level in, up to t6. Seven levels is the compiler's limit; a deeper expression asks for a variable.</p>
        <p>The cheap cases avoid the stack. A small constant rides in the instruction (<code>addi</code>,
        <code>andi</code>, <code>slti</code>); constants are folded at compile time; a comparison that decides a
        branch becomes the branch itself (<code>n != 1</code> is <code>beq s0, t1</code> to the loop's end). In
        Collatz, <code>3 * n + 1</code> is <code>slli</code>, <code>add</code>, <code>addi</code>: three cycles.</p>
        <p>Where a variable lives depends on who uses it. Top-level variables take s registers; a function's take
        a0–a7 if it calls nothing (its parameters arrive there), else s registers it saves on entry; a global a
        function reads or writes lives in data memory, the only place every function sees. The table under the
        listing says where each one went.</p>
        <p>The rule behind the stack of temporaries is the shape of the expression tree: evaluate the left subtree into t<sub>k</sub>, the right into t<sub>k+1</sub>, combine into t<sub>k</sub>.
        The number of temporaries live at once is the tree's depth to the right, so a left-associative chain <code>a + b + c + d</code> needs two while a right-nested one needs more.
        Seven is a design limit of this compiler, not of the machine: the ABI's t-registers are the pool it draws from.</p>`,
      widget: () => pyLinked('collatz', 7),
      more: {
        derive: `<p><code>3 * n + 1</code> with n in s0: the constant 3 has two bits set, so the product is <code>slli t0, s0, 1</code> (2n) then <code>add t0, t0, s0</code> (2n + n), and the
          <code>+ 1</code> is <code>addi t0, t0, 1</code>. Three instructions, three cycles, no multiply. Compare the generic route (<code>rt.mul</code>, next step) at 32 passes of shift and add. The
          compiler chooses between them by the constant\'s bit pattern.</p>`,
        pitfall: `<p>Writing an expression nested more than seven deep, usually by accident in a long arithmetic formula: the compiler refuses it and says so. Break it with a variable. Also remember that
          every Python integer here is 32-bit and wraps: <code>x * 1000003</code> silently overflows where real Python would grow.</p>`,
        real: `<p>Production compilers use graph-colouring or linear-scan register allocation over the whole function, with spilling to the stack when registers run out. This one has a fixed rule,
          temporaries for expressions and s-registers for variables, which is simple enough to read off the listing and loses efficiency on big functions.</p>`,
      },
    },
    {
      title: 'What * // % cost',
      body: `
        <p>RV32I has no multiply or divide instructions (the M extension of chapter 21 adds them). The compiler
        spends instructions instead.</p>
        <p>A power of two is a shift or a mask: <code>n % 2</code> is one <code>andi</code>, <code>n // 2</code> one
        <code>srai</code> (an arithmetic shift is exactly Python's floor division by 2), <code>x * 8</code> one
        <code>slli</code>. A constant with two bits set, or one less than a power of two, is two shifts and an add or a
        subtract. Anything else calls a routine: <code>rt.mul</code> adds one shifted copy per bit of the multiplier,
        <code>rt.divmod</code> runs 32 passes of shift, compare, subtract, then fixes the signs for Python's rounding
        toward minus infinity.</p>
        <p>Measured: Collatz from 27 runs 938 cycles, every line a few instructions. In gcd, <code>t = a % b</code>
        costs about 240 cycles a call, 1 472 of the program's 1 545. Chapter 21's divider does the same 32 steps in
        hardware, with no instruction fetched between them.</p>
        <p>The lesson generalizes: the cost of an operator is the number of instructions behind it, and an operator that looks atomic in the source can hide a loop. A programmer who
        knows the target sees that <code>%</code> by a power of two is free and <code>%</code> by a variable is a function call; a hardware divider (chapter 21) moves that loop out of
        the instruction stream, trading area for cycles, as every earlier chapter did.</p>`,
      widget: () => pyCost(['gcd']),
      more: {
        derive: `<p><code>x * 5</code> = <code>x * 4 + x</code>: <code>slli</code> then <code>add</code>, two cycles. <code>x * 7</code> = <code>x * 8 − x</code>: <code>slli</code> then <code>sub</code>.
          A constant that is not 2^k, 2^a + 2^b or 2^a − 1, such as 11, is not worth the shifts and calls <code>rt.mul</code>: one shifted add per bit of the multiplier, 32 passes. <code>rt.divmod</code> does the
          long division you learned in school in binary: shift the next dividend bit into the remainder, subtract the divisor if it fits, record a quotient bit. 32 passes, a few instructions each, about 240 cycles in all.</p>`,
        numbers: `<table class="mini"><tr><th>program</th><th>instructions</th><th>cycles</th></tr>${COST.map((r) => `<tr><td>${r.name}</td><td>${r.words}</td><td>${fmt(r.steps)}</td></tr>`).join('')}</table>
          <p>Measured on the golden model, which takes one cycle per instruction on the single-cycle CPU. The gap between instructions in the listing and cycles run is the loop count.</p>`,
        pitfall: `<p>Python's <code>//</code> and <code>%</code> floor toward minus infinity, while RISC-V's <code>div</code> and <code>rem</code> (and C's operators) truncate toward zero. <code>-7 // 2</code> is −4 in Python and −3 in C. The
          generated routine fixes the signs after the unsigned division, which is part of why it is longer than the bare loop. A hand-written shift-and-subtract that ignores signs gives the C answer.</p>`,
        real: `<p>Hardware dividers take tens of cycles, this site\'s 32 steps among them, and are rarely pipelined; multipliers are far faster. Compilers know this and replace division by a constant with
          a multiplication by its reciprocal (a magic number and a shift), which is one reason constants are cheap and variables are not.</p>`,
      },
    },
    {
      title: 'Run it on the gates',
      body: `
        <p>The CPU is chapter 14's, gate for gate, with a 256-word ROM and 64 words of data memory: 100 979 NANDs,
        403 916 transistors. The <em>Python</em> panel beside the CPU panel reads it: the PC through the compiler's map
        gives the line running, the registers and data memory give the variables, the words from the output's start to
        gp give what was printed.</p>
        <p><em>Step line</em> clocks <span data-show="pc imem rf alu">the CPU</span> until the next Python line starts
        (Back undoes it). The panel counts each line's cycles, and the wire toggles of its last cycle: one
        <code>total += i</code> is a single <code>add</code>, one clock cycle and about 25 000 nets changing value
        through <span data-show="rf alu">the register file and the ALU</span>. Click a line to light the hardware its
        instructions use. The CPU panel still checks every register against the golden model after every cycle.</p>
        <p>Two things this view makes concrete. First, how little of the machine a line uses: one <code>add</code> reads two registers and writes one, and the rest of the ~400 000 transistors
        sit idle in that cycle, though about 25 000 nets still change value, because a new instruction word has just been fetched and decoded. Second, that the abstraction
        holds: the Python never mentions a register or a wire, yet its variable <code>total</code> is a set of flip-flops you can read and watch change.</p>`,
      scene: () => pyScene(src('sum'), { highlight: ['rf', 'alu'] }),
      tour: {
        beats: [
          { title: 'Prologue', reset: true, show: ['pc', 'imem'], expect: { pcOut: 0, aluOut: 256 },
            say: '<p>Before line 1 the compiler\'s prologue runs: <code>addi sp, zero, 256</code> puts the stack pointer at the top of the 64-word data memory. The ALU\'s output is {v:aluOut}.</p>' },
          { title: 'The limit', cycles: 4, show: ['imm', 'alu'], expect: { pcOut: 16, aluOut: 11 },
            say: '<p>Four instructions in, total = 0 and i = 1 live in s0 and s1. The PC is {v:pcOut}: <code>addi t1, zero, 11</code>, the loop\'s limit, which is loaded again on every pass.</p>' },
          { title: 'The test', cycles: 1, show: ['alu', 'npc'], expect: { pcOut: 20, aluOut: 0xfffffff6 },
            say: '<p><code>bge s1, t1</code> asks whether i ≥ 11. The ALU computes 1 − 11 = −10, negative, so the loop continues.</p>' },
          { title: 'total += i', cycles: 1, show: ['rf', 'alu'], expect: { pcOut: 24, aluOut: 1 },
            say: '<p>The whole of line 3 is this one instruction: <code>add s0, s0, s1</code>, 0 + 1 = {v:aluOut}. One clock cycle, the register file read twice and written once.</p>' },
          { title: 'Round again', cycles: 3, show: ['target', 'pcmux'], expect: { pcOut: 16, aluOut: 11 },
            say: '<p><code>addi s1, s1, 1</code> advanced i, and the jump took the PC back to {v:pcOut}. Nine more passes make total 55.</p>' },
        ],
      },
      more: {
        derive: `<p>Cycles for the listing\'s lines, from the golden model: line 1 (<code>total = 0</code>) ${lineCycles(SUM, 1)}, line 2 (the <code>for</code> test and jump) ${lineCycles(SUM, 2)}, line 3 (<code>total += i</code>)
          ${lineCycles(SUM, 3)}, line 4 (<code>print</code>) ${lineCycles(SUM, 4)}: ${SUM.p.steps} in all with the prologue and the final halt. The toggle count is a different measurement:
          it counts nets that changed value in the last cycle, so it depends on the data and on which instruction came before, not on the line\'s length.</p>`,
        pitfall: `<p>Reading the cycles column as time. It is cycles on the single-cycle CPU, where every instruction takes one. On a pipeline the same program takes more cycles per instruction (stalls) but
          each cycle is shorter; on this panel the count is a count of instructions run.</p>`,
        real: `<p>The same run on CPython would execute tens to hundreds of machine instructions per line: it interprets bytecode, with dynamic types and reference counts behind every <code>+</code>.
          Compiling to machine code, as here, is why a C loop is one to two orders of magnitude faster than the Python loop.</p>`,
      },
      challenge: {
        kind: 'reach',
        goal: 'Run the program until total is 21.',
        check: (stage) => !!stage.sim && cpuState(stage.sim).x[8] === 21,
        hints: ['<em>Step line</em> in the Python panel runs one Python line.', '21 = 1 + 2 + 3 + 4 + 5 + 6: six passes of the loop.'],
        answer: 'Six passes of the loop: 1 + … + 6 = 21. Step line until line 3 has run six times (its cycle count reads 6); total is in s0.',
        solve: (stage) => { stage.runCycles(200, () => !!stage.sim && cpuState(stage.sim).x[8] === 21); },
      },
    },
    {
      title: 'Functions are a stack',
      body: `
        <p>A call is <code>jal ra, fib</code>: the return address goes to ra and the PC to the function. Since fib
        calls itself, it must keep ra and its n somewhere the next call will not overwrite: its prologue moves sp down
        two words and stores them; its epilogue loads them back and returns with <code>ret</code>.</p>
        <p>One more word appears during <code>fib(n - 1) + fib(n - 2)</code>: fib(n − 1)'s result is in t0 when the
        second call starts, and the callee uses t0 too, so the caller saves it below sp and loads it after. The stack
        panel labels every word by the store that wrote it. fib(7) runs 721 cycles for its 13; most of them move
        frames.</p>
        <p>The stack is a convention, not a hardware feature: <code>sp</code> is an ordinary register and the stack is an ordinary region of the data memory that every function agrees to
        use from the top down. The CPU has no notion of a frame. What makes the recursion work is discipline: whatever a function overwrites and its caller still needs, it saves
        before and restores after, and the order of the saves is the reverse of the restores, so a stack is the structure that fits.</p>`,
      scene: () => pyScene(src('fib')),
      tour: {
        beats: [
          { title: 'Call', reset: true, show: ['rf'], expect: { pcOut: 0, aluOut: 256 },
            say: '<p>The prologue sets sp = {v:aluOut}, the top of the 64-word data memory. The stack will grow downward from there.</p>' },
          { title: 'jal ra, fib', cycles: 4, show: ['target', 'pcmux'], expect: { pcOut: 16 },
            say: '<p>The argument 7 is in a0 and the PC is {v:pcOut}: <code>jal ra, fib</code> will put the return address, 20, in ra and jump to the function at 36.</p>' },
          { title: 'Push a frame', cycles: 1, show: ['alu', 'dm'], expect: { pcOut: 36, aluOut: 248 },
            say: '<p>The function\'s first instruction is <code>addi sp, sp, -8</code>: sp becomes 256 − 8 = {v:aluOut}. Two words are now reserved for this call.</p>' },
          { title: 'Save', cycles: 2, show: ['alu', 'dm'], expect: { pcOut: 44, aluOut: 252 },
            say: '<p><code>sw ra, 0(sp)</code> stored the return address at 248 and <code>sw s0, 4(sp)</code> stores the caller\'s s0 at {v:aluOut}. The function can now use s0 for its own n.</p>' },
          { title: 'The recursive step', cycles: 4, show: ['alu', 'npc'], expect: { pcOut: 68, aluOut: 6 },
            say: '<p>n = 7 is not below 2, so the branch skips the base case. At {v:pcOut}, <code>addi t0, s0, -1</code> computes n − 1 = {v:aluOut}: the argument of the first recursive call, which pushes a second frame.</p>' },
        ],
      },
      more: {
        derive: `<p>Call counts for fib(n), counting every call that runs the prologue: ${[1, 2, 3, 4, 5, 6, 7].map((n) => `n = ${n}: ${fibCalls(n)}`).join(', ')}. The count obeys calls(n) = 1 + calls(n−1) + calls(n−2), the Fibonacci recurrence plus one per node,
          so it grows by about 1.6 each step. The stack, in contrast, grows only with the longest path in the call tree: n frames of two words, plus a word for each live t0 waiting across a second call.</p>`,
        pitfall: `<p>A function that calls another and does not save <code>ra</code> returns into itself, forever. Same for a callee that overwrites a register its caller still needs: the symptom is a value that is right
          until the first nested call. In the stack panel the saved words are labelled by the instruction that stored them, so an unsaved register is a missing label.</p>`,
        real: `<p>The RISC-V calling convention splits registers into caller-saved (t0–t6, a0–a7) and callee-saved (s0–s11, sp, gp): the callee preserves the s-registers, the caller preserves anything in a t-register it
          needs after a call. This compiler follows it, which is why <code>s0</code> is saved in the prologue and <code>t0</code> around the second call. Real stacks also guard against overflow with a page the OS leaves unmapped; here a stack that
          meets the output overwrites it without a fault.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'fib(7) makes 41 calls. Why does the stack never hold more than seven frames?',
        options: ['A frame is popped when its call returns: only the calls in progress, one per level of recursion, hold one', 'The CPU has room for seven frames only', 'The compiler turns the recursion into a loop', 'Only every sixth call pushes a frame'],
        answer: 0,
        explain: 'The calls form a tree, but only one path from the root to the call running now is in progress at a time. fib(7) → fib(6) → … → fib(1) is the deepest path.',
        why: ['', '64 words of data memory would hold more; the depth comes from the program.', 'Every call runs jal and the prologue: watch sp move.', 'Every call that reaches the prologue pushes one.'],
      },
    },
    {
      title: 'Your own program',
      body: `
        <p>The editor compiles as you type and points at the first error in Python's terms. <em>Compile &amp; load</em>
        puts the program in the ROM and resets the CPU. The program list holds forty examples in six sections (first steps,
        numbers, lists, functions, bits, multiply and divide): a sieve, three sorts, binary search, a matrix multiply,
        the towers of Hanoi, Ackermann, a random-number generator, division by hand.</p>
        <p>The limits are the machine's: 256 instructions of ROM, 64 words of data memory shared by the variables, the
        lists, the output and the stack (output that runs into the stack overwrites it), seven temporaries, twelve
        variables a function (twenty in one that calls nothing).</p>
        <p>Budget the data memory before you write: a list takes one word per element (not a byte), the output takes one word per <code>print</code>, and the stack takes whatever is left from the top
        down. The panel shows all three regions, so an out-of-memory program shows as two regions meeting.</p>`,
      scene: () => pyScene(src('primes'), { edit: true }),
      more: {
        derive: `<p>The sieve here: a list of 30 words and ${primesBelow(30)} printed primes, ${30 + primesBelow(30)} words, leaving ${64 - 30 - primesBelow(30)} for the stack. With N = 60 it would be 60 words of list and ${primesBelow(60)} of output,
          ${60 + primesBelow(60)} against 64 before the first stack word: the program no longer fits.</p>`,
        pitfall: `<p>The Python habit of an unbounded list or recursion has no counterpart: the first runs out of its 64 words, the second out of stack, and the symptom is output that changes after a deeper call
          because the stack grew into it. When a program prints a wrong number only for larger inputs, compare the stack region with the output region.</p>`,
        real: `<p>Operating systems give a program a large virtual address space with the stack and heap far apart and an unmapped guard page between them, so an overflow is a fault, not a silent overwrite.
          Memory protection is hardware, and its absence here is why the failure is quiet.</p>`,
      },
    },
  ],
};
