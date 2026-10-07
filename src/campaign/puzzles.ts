// Program puzzles: write RV16 assembly that turns each test's inputs into the expected outputs.
// Run on the golden model (iss16); graded on size (instruction words) and cycles (instructions
// executed, mean over the tests). Every puzzle has a reference solution that passes and meets
// par (tests/campaign-puzzles.test.ts). No DOM.

import { assemble16 } from '../riscv/rv16/asm16';
import { Iss16 } from '../riscv/rv16/iss16';
import { rng } from './drills';

export interface PuzzleTest {
  name: string;
  /** Words read, in order, from IN (0xFFFC). */
  input?: number[];
  /** Initial data memory. */
  mem?: Record<number, number>;
  switches?: number;
  /** Raise the external interrupt line before these steps (system puzzles). */
  irqAt?: number[];
  expect: { out?: number[]; mem?: Record<number, number>; console?: string };
}

export interface ProgramPuzzle {
  /** HTML. */
  brief: string;
  starter: string;
  tests: () => PuzzleTest[];
  ref: string;
  /** Steps before a test is declared stuck. */
  maxSteps: number;
  m?: boolean;
  system?: boolean;
}

export interface PuzzleRun {
  ok: boolean;
  errors: { line: number; message: string }[];
  results: { name: string; ok: boolean; why?: string; steps: number }[];
  size: number;
  /** Mean steps over the tests (rounded up). */
  cycles: number;
}

const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;
const list = (vs: number[]) => (vs.length ? vs.map((v) => String(v)).join(', ') : 'nothing');

/** Run every test of a puzzle on a source. Never throws. */
export function runPuzzle(p: ProgramPuzzle, src: string): PuzzleRun {
  const a = assemble16(src);
  const size = a.words.length;
  if (a.errors.length) return { ok: false, errors: a.errors, results: [], size, cycles: 0 };
  const results = p.tests().map((t) => {
    const data = new Map(a.data);
    for (const [k, v] of Object.entries(t.mem ?? {})) data.set(Number(k), v);
    const iss = new Iss16(a.words, { m: p.m, system: p.system }, data);
    iss.input = [...(t.input ?? [])];
    iss.switches = t.switches ?? 0;
    const irqs = new Set(t.irqAt ?? []);
    while (!iss.halted && iss.steps < p.maxSteps) {
      if (irqs.has(iss.steps)) iss.irq = 1;
      iss.step();
    }
    const steps = iss.steps;
    const fail = (why: string) => ({ name: t.name, ok: false, why, steps });
    if (iss.error) return fail(iss.error);
    if (!iss.halted) return fail(`still running after ${p.maxSteps} instructions (missing halt?)`);
    const e = t.expect;
    if (e.out && (e.out.length !== iss.out.length || e.out.some((v, i) => (v & 0xffff) !== iss.out[i]))) {
      return fail(`output ${list(iss.out)}, expected ${list(e.out.map((v) => v & 0xffff))}`);
    }
    if (e.console !== undefined && e.console !== iss.console) return fail(`printed "${iss.console}", expected "${e.console}"`);
    for (const [k, v] of Object.entries(e.mem ?? {})) {
      const got = iss.dmem[Number(k)];
      if (got !== (v & 0xffff)) return fail(`memory[${hex(Number(k))}] = ${hex(got)}, expected ${hex(v & 0xffff)}`);
    }
    return { name: t.name, ok: true, steps };
  });
  const ok = results.every((r) => r.ok);
  const cycles = Math.ceil(results.reduce((s, r) => s + r.steps, 0) / Math.max(1, results.length));
  return { ok, errors: [], results, size, cycles };
}

const u16 = (v: number) => v & 0xffff;
const s16 = (v: number) => ((v & 0xffff) ^ 0x8000) - 0x8000;

const IO_HELP = 'Read a word with <code>lw rd, -4(x0)</code> (IN), write one with <code>sw rs, -3(x0)</code> (OUT), stop with <code>halt</code>.';

export const PUZZLES: Record<string, ProgramPuzzle> = {
  p_add: {
    brief: `Read two numbers from IN and write their sum (mod 2<sup>16</sup>) to OUT. ${IO_HELP}`,
    starter: `# a0 ← IN, a1 ← IN, OUT ← a0 + a1\n        lw   a0, -4(x0)\n        \n        halt\n`,
    ref: `        lw   a0, -4(x0)\n        lw   a1, -4(x0)\n        add  a0, a0, a1\n        sw   a0, -3(x0)\n        halt\n`,
    tests: () => [[2, 3], [0, 0], [40000, 30000], [0xffff, 1], [1234, 4321]].map(([a, b]) => ({ name: `${a} + ${b}`, input: [a, b], expect: { out: [u16(a + b)] } })),
    maxSteps: 100,
  },
  p_loop: {
    brief: `Read <i>n</i> (0 … 300) from IN and write 1 + 2 + … + <i>n</i> (mod 2<sup>16</sup>) to OUT. A loop: a counter, a branch back while it is not zero. ${IO_HELP}`,
    starter: `        lw   a0, -4(x0)      # n\n        li   a1, 0           # sum\nloop:\n        \n        sw   a1, -3(x0)\n        halt\n`,
    ref: `        lw   a0, -4(x0)\n        li   a1, 0\nloop:   beqz a0, done\n        add  a1, a1, a0\n        addi a0, a0, -1\n        j    loop\ndone:   sw   a1, -3(x0)\n        halt\n`,
    tests: () => [0, 1, 5, 100, 300].map((n) => ({ name: `n = ${n}`, input: [n], expect: { out: [u16((n * (n + 1)) / 2)] } })),
    maxSteps: 5000,
  },
  p_mem: {
    brief: 'An array of <i>n</i> signed words starts at address 0x100; <i>n</i> (1 … 30) is at 0x0FF. Write its <b>maximum</b> (signed) to OUT, then halt. Loads walk the array: <code>lw t1, 0(t0)</code>, then <code>addi t0, t0, 1</code>.',
    starter: `        li   t0, 0xff        # offsets are only −32…31: addresses go in a register\n        lw   a1, 0(t0)       # n\n        halt\n`,
    ref: `        li   t0, 0xff\n        lw   a1, 0(t0)       # n\n        addi t0, t0, 1\n        lw   a0, 0(t0)       # max = a[0]\nloop:   addi a1, a1, -1\n        beqz a1, done\n        addi t0, t0, 1\n        lw   t1, 0(t0)\n        bge  a0, t1, loop\n        mv   a0, t1\n        j    loop\ndone:   sw   a0, -3(x0)\n        halt\n`,
    tests: () => {
      const r = rng(3);
      return [[5], [-1, -7, -3], [3, 9, 9, 2], ...Array.from({ length: 3 }, () => Array.from({ length: 5 + Math.floor(r() * 25) }, () => Math.floor(r() * 65536) - 32768))].map((arr, i) => {
        const mem: Record<number, number> = { 0xff: arr.length };
        arr.forEach((v, k) => (mem[0x100 + k] = u16(v)));
        return { name: `array ${i + 1} (${arr.length} words)`, mem, expect: { out: [u16(Math.max(...arr.map(s16)))] } };
      });
    },
    maxSteps: 2000,
  },
  p_call: {
    brief: 'Read pairs <i>a</i>, <i>b</i> (both 1 … 1000) from IN until a 0 arrives; for each pair write gcd(<i>a</i>, <i>b</i>) to OUT. Write <b>gcd</b> as a function (arguments in a0, a1, result in a0) and <code>call</code> it: <code>ret</code> returns through ra, so a function that calls another must save ra (on the stack: <code>push ra</code> / <code>pop ra</code>).',
    starter: `        li   sp, 0x1000\nmain:   lw   a0, -4(x0)\n        beqz a0, end\n        lw   a1, -4(x0)\n        call gcd\n        sw   a0, -3(x0)\n        j    main\nend:    halt\n\ngcd:    # a0 ← gcd(a0, a1)\n        ret\n`,
    ref: `        li   sp, 0x1000\nmain:   lw   a0, -4(x0)\n        beqz a0, end\n        lw   a1, -4(x0)\n        call gcd\n        sw   a0, -3(x0)\n        j    main\nend:    halt\n\ngcd:    beq  a0, a1, gd\n        blt  a0, a1, gl\n        sub  a0, a0, a1\n        j    gcd\ngl:     sub  a1, a1, a0\n        j    gcd\ngd:     ret\n`,
    tests: () => {
      const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
      const sets = [[[12, 18], [7, 5]], [[100, 75], [1000, 1], [36, 36]], [[999, 333], [17, 51], [270, 192]]];
      return sets.map((ps, i) => ({ name: `set ${i + 1}`, input: [...ps.flat(), 0], expect: { out: ps.map(([a, b]) => gcd(a, b)) } }));
    },
    maxSteps: 20000,
  },
  p_mul: {
    brief: 'Read <i>a</i> and <i>b</i> (unsigned) from IN and write <i>a</i> × <i>b</i> mod 2<sup>16</sup> to OUT, with shifts and adds: for every 1 bit of <i>b</i>, add <i>a</i> shifted to that bit\'s position. RV16I has no multiply instruction (the side quests build one).',
    starter: `        lw   a0, -4(x0)\n        lw   a1, -4(x0)\n        li   a2, 0           # product\n        \n        sw   a2, -3(x0)\n        halt\n`,
    ref: `        lw   a0, -4(x0)\n        lw   a1, -4(x0)\n        li   a2, 0\nloop:   beqz a1, done\n        li   t1, 1\n        and  t0, a1, t1\n        beqz t0, skip\n        add  a2, a2, a0\nskip:   slli a0, a0, 1\n        srli a1, a1, 1\n        j    loop\ndone:   sw   a2, -3(x0)\n        halt\n`,
    tests: () => [[3, 4], [0, 999], [255, 255], [1000, 65], [0x1234, 0x0101], [65535, 65535]].map(([a, b]) => ({ name: `${a} × ${b}`, input: [a, b], expect: { out: [u16(a * b)] } })),
    maxSteps: 5000,
  },
  p_sort: {
    brief: 'Sort the array at 0x100 (<i>n</i> words at 0x0FF, 2 … 20) into ascending signed order, in place, then halt. Checked in memory. Any algorithm; graded on cycles.',
    starter: `        halt\n`,
    ref: `        li   t0, 0xff\n        lw   a2, 0(t0)       # n\nouter:  addi a2, a2, -1\n        blez a2, end\n        li   t0, 0x100\n        mv   a1, a2          # inner count\ninner:  lw   a0, 0(t0)\n        lw   t1, 1(t0)\n        bge  t1, a0, noswap\n        sw   t1, 0(t0)\n        sw   a0, 1(t0)\nnoswap: addi t0, t0, 1\n        addi a1, a1, -1\n        bnez a1, inner\n        j    outer\nend:    halt\n`,
    tests: () => {
      const r = rng(11);
      return [[2, 1], [5, 4, 3, 2, 1], ...Array.from({ length: 3 }, () => Array.from({ length: 6 + Math.floor(r() * 15) }, () => Math.floor(r() * 2000) - 1000))].map((arr, i) => {
        const mem: Record<number, number> = { 0xff: arr.length };
        arr.forEach((v, k) => (mem[0x100 + k] = u16(v)));
        const sorted = [...arr].sort((x, y) => x - y);
        return { name: `array ${i + 1} (${arr.length} words)`, mem, expect: { mem: Object.fromEntries(sorted.map((v, k) => [0x100 + k, u16(v)])) } };
      });
    },
    maxSteps: 10000,
  },
  p_print: {
    brief: 'Read <i>n</i> (unsigned, 0 … 65535) from IN and print it in decimal to the CONSOLE (<code>sw ch, -2(x0)</code> writes one character), without leading zeros. No divide instruction: subtract powers of ten.',
    starter: `        lw   a0, -4(x0)\n        halt\n`,
    ref: `        lw   a0, -4(x0)\n        la   t0, pow\n        li   a2, 0           # printed a digit yet?\n        li   sp, 48          # '0' (sp and ra are free: no calls)\nnext:   lw   a1, 0(t0)\n        beqz a1, last\n        li   t1, 0           # digit\nsub_:   sltu ra, a0, a1\n        bnez ra, emit\n        sub  a0, a0, a1\n        addi t1, t1, 1\n        j    sub_\nemit:   or   a2, a2, t1\n        beqz a2, skip\n        add  t1, t1, sp\n        sw   t1, -2(x0)\nskip:   addi t0, t0, 1\n        j    next\nlast:   add  a0, a0, sp\n        sw   a0, -2(x0)\n        halt\n        .data\npow:    .word 10000, 1000, 100, 10, 0\n`,
    tests: () => [0, 7, 10, 305, 1000, 65535, 4096].map((n) => ({ name: `n = ${n}`, input: [n], expect: { console: String(n) } })),
    maxSteps: 2000,
  },
  p_handler: {
    brief: 'A device raises the external interrupt three times. Each time, the handler must read the device\'s word from IN, write it doubled to OUT and acknowledge the device (store 0 to IRQ, 0xFFF9). Main enables the interrupt (mtvec, mie bit 11, mstatus.MIE) and waits until three have been handled, then halts. The handler must preserve every register main uses.',
    starter: `        li   sp, 0x1000\n        la   t0, handler\n        csrw mtvec, t0\n        # enable: mie bit 11 (MEIE), then mstatus bit 3 (MIE)\n        \nwait:   j    wait\n        halt\n\nhandler:\n        mret\n`,
    ref: `        li   sp, 0x1000\n        la   t0, handler\n        csrw mtvec, t0\n        li   t0, 0x800\n        csrw mie, t0\n        li   a2, 0           # interrupts handled\n        li   t0, 8\n        csrs mstatus, t0\n        li   t1, 3\nwait:   blt  a2, t1, wait\n        halt\n\nhandler:\n        push t0\n        lw   t0, -4(x0)\n        add  t0, t0, t0\n        sw   t0, -3(x0)\n        sw   x0, -7(x0)      # acknowledge\n        addi a2, a2, 1\n        pop  t0\n        mret\n`,
    tests: () => [[20, 60, 100], [30, 45, 60], [50, 200, 400]].map((at, i) => ({ name: `interrupts at ${at.join(', ')}`, input: [5 + i, 1000, 0x7fff], irqAt: at, expect: { out: [u16(2 * (5 + i)), 2000, 0xfffe] } })),
    maxSteps: 3000, system: true,
  },
};
