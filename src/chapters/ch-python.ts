import { cpuState } from '../riscv/cosim';
import { pyCost, pyLinked, pyScene } from '../widgets/python';
import { PY_PROGRAMS } from '../lang/pyprograms';
import type { Chapter } from './types';

// Every number in the prose is recomputed by tests/python-chapter.test.ts from the compiler (src/lang), the golden
// model and the gate-level CPU the scenes build (singleCycleCpu with PY_IMEM_K / PY_DMEM_K).

const src = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!.source;

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
        see its fields.</p>`,
      widget: () => pyLinked('sum', 3),
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
        listing says where each one went.</p>`,
      widget: () => pyLinked('collatz', 7),
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
        hardware, with no instruction fetched between them.</p>`,
      widget: () => pyCost(['gcd']),
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
        instructions use. The CPU panel still checks every register against the golden model after every cycle.</p>`,
      scene: () => pyScene(src('sum'), { highlight: ['rf', 'alu'] }),
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
        frames.</p>`,
      scene: () => pyScene(src('fib')),
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
        variables a function (twenty in one that calls nothing).</p>`,
      scene: () => pyScene(src('primes'), { edit: true }),
    },
  ],
};
