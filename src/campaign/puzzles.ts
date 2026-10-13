// Program puzzles: write RV16 assembly that turns each test's inputs into the expected outputs.
// Run on the golden model (iss16); graded on size (instruction words) and cycles (instructions
// executed, mean over the tests). Kernel puzzles (act 9, `lanes`) run on the lane golden model
// (simt16): cycles are warp instructions, and idle (the share of lane-steps with the lane masked
// off) is graded too. A kernel on two warps (warps16) counts issue slots: the warps take turns. Every puzzle has a reference solution that passes and meets par
// (tests/campaign-puzzles.test.ts). No DOM.

import { assemble16 } from '../riscv/rv16/asm16';
import { Iss16 } from '../riscv/rv16/iss16';
import { Simt16 } from '../riscv/rv16/simt16';
import { Warps16 } from '../riscv/rv16/warps16';
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
  /** A kernel: every test runs on a warp of this many lanes (Simt16), graded on idle lanes too. */
  lanes?: number;
  /** A kernel on this many warps taking turns (Warps16): cycles are issue slots. */
  warps?: number;
}

export interface PuzzleRun {
  ok: boolean;
  errors: { line: number; message: string }[];
  results: { name: string; ok: boolean; why?: string; steps: number; idle?: number }[];
  size: number;
  /** Mean steps over the tests (rounded up). */
  cycles: number;
  /** Kernels: mean over the tests of each one's idle lane-steps, in % (rounded). */
  idle?: number;
}

/** A test's machine for the stepper and runPuzzle: the scalar golden model, or a warp of lanes. */
export function puzzleMachine(p: ProgramPuzzle, words: number[], asmData: Map<number, number>, t: PuzzleTest): Iss16 | Simt16 | Warps16 {
  const data = new Map(asmData);
  for (const [k, v] of Object.entries(t.mem ?? {})) data.set(Number(k), v);
  if (p.lanes && p.warps) {
    const m = new Warps16(words, { lanes: p.lanes, warps: p.warps }, data);
    for (const w of m.warps) for (const l of w.lanes) l.input = [...(t.input ?? [])];
    return m;
  }
  if (p.lanes) {
    const w = new Simt16(words, { lanes: p.lanes }, data);
    for (const l of w.lanes) l.input = [...(t.input ?? [])];
    return w;
  }
  const iss = new Iss16(words, { m: p.m, system: p.system }, data);
  iss.input = [...(t.input ?? [])];
  iss.switches = t.switches ?? 0;
  return iss;
}

const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`;
const list = (vs: number[]) => (vs.length ? vs.map((v) => String(v)).join(', ') : 'nothing');

/** What a halted machine got wrong against a test's expectations, or null. */
function mismatch(t: PuzzleTest, mc: Iss16 | Simt16 | Warps16): string | null {
  const e = t.expect;
  if (e.out && (e.out.length !== mc.out.length || e.out.some((v, i) => (v & 0xffff) !== mc.out[i]))) {
    return `output ${list(mc.out)}, expected ${list(e.out.map((v) => v & 0xffff))}`;
  }
  const printed = mc instanceof Iss16 ? mc.console : '';
  if (e.console !== undefined && e.console !== printed) return `printed "${printed}", expected "${e.console}"`;
  for (const [k, v] of Object.entries(e.mem ?? {})) {
    const got = mc.dmem[Number(k)];
    if (got !== (v & 0xffff)) return `memory[${hex(Number(k))}] = ${hex(got)}, expected ${hex(v & 0xffff)}`;
  }
  return null;
}

/** Run every test of a puzzle on a source. Never throws. */
export function runPuzzle(p: ProgramPuzzle, src: string): PuzzleRun {
  const a = assemble16(src);
  const size = a.words.length;
  if (a.errors.length) return { ok: false, errors: a.errors, results: [], size, cycles: 0, ...(p.lanes ? { idle: 0 } : {}) };
  const what = p.warps ? 'cycles' : p.lanes ? 'warp instructions' : 'instructions';
  const results = p.tests().map((t) => {
    const mc = puzzleMachine(p, a.words, a.data, t);
    const irqs = new Set(t.irqAt ?? []);
    while (!mc.halted && mc.steps < p.maxSteps) {
      if (mc instanceof Iss16 && irqs.has(mc.steps)) mc.irq = 1;
      mc.step();
    }
    const steps = mc.steps;
    const idle = mc instanceof Iss16 ? {} : { idle: mc.idle };
    const fail = (why: string) => ({ name: t.name, ok: false, why, steps, ...idle });
    if (mc.error) return fail(mc.error);
    if (!mc.halted) return fail(`still running after ${p.maxSteps} ${what} (missing halt?)`);
    const wrong = mismatch(t, mc);
    if (wrong) return fail(wrong);
    // Warps: any scheduler may issue them in any order. Run warp W − 1 ahead (as long as it can issue)
    // too: a kernel that shares data without a bar works only by luck of the turn-taking.
    if (mc instanceof Warps16) {
      const ahead = puzzleMachine(p, a.words, a.data, t) as Warps16;
      for (let k = 0; !ahead.halted && k < p.maxSteps; k++) {
        const w = [...ahead.warps.keys()].reverse().find((v) => ahead.runnable(v));
        if (w === undefined) break;
        ahead.stepWarp(w);
      }
      const why = ahead.error ?? (ahead.halted ? mismatch(t, ahead) : 'it does not finish');
      if (why) return fail(`right when the warps take turns, but when warp ${ahead.W - 1} runs ahead: ${why}. A scheduler may issue warps in any order: share data between them only across a bar`);
    }
    return { name: t.name, ok: true, steps, ...idle };
  });
  const ok = results.every((r) => r.ok);
  const mean = (f: (r: (typeof results)[number]) => number) => results.reduce((s, r) => s + f(r), 0) / Math.max(1, results.length);
  const cycles = Math.ceil(mean((r) => r.steps));
  return { ok, errors: [], results, size, cycles, ...(p.lanes ? { idle: Math.round(mean((r) => r.idle ?? 0)) } : {}) };
}

const u16 = (v: number) => v & 0xffff;
const s16 = (v: number) => ((v & 0xffff) ^ 0x8000) - 0x8000;

const KERNEL_HELP = 'Four lanes run your program in lock-step, one shared memory: <code>csrr rd, tid</code> gives each its number (0 … 3); lane <i>t</i> takes elements <i>t</i>, <i>t</i> + 4, <i>t</i> + 8, …. Graded on cycles (warp instructions) and idle lanes.';
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

  // ---- Act 9: kernels, on four lanes ----
  p_saxpy: {
    brief: `<b>saxpy</b>: y[<i>i</i>] ← <i>a</i>·x[<i>i</i>] + y[<i>i</i>] (mod 2<sup>16</sup>) for every <i>i</i> &lt; <i>n</i>, checked in memory. ${KERNEL_HELP} `
      + '<i>n</i> (4 … 32, a multiple of 4) is at 0x0FF, <i>a</i> (0 … 15) at 0x0FE, x at 0x100, y at 0x120. There is no multiply: '
      + 'shift and add over the bits of <i>a</i>, which every lane has the same, so every lane takes the same branches.',
    starter: `# lane tid handles i = tid, tid + 4, tid + 8, … < n
        csrr t0, tid
        li   a0, 0x100
        lw   a1, -2(a0)       # a
        lw   ra, -1(a0)       # n
        
        halt
`,
    // For each set bit k of a (the same in every lane), one pass over the lane's elements: y += x << k.
    ref: `        csrr t0, tid
        li   a0, 0x100
        lw   a1, -2(a0)       # a
        lw   ra, -1(a0)       # n
        addi a0, a0, 16       # between x and y: x[i] at -16, y[i] at +16
        add  a0, a0, t0       # this lane's first element
        add  ra, ra, a0       # one past its last (n is a multiple of 4)
        li   sp, 0            # k: the bit of a
bit:    beqz a1, done         # no set bits left
        slli t0, a1, 15       # bit k alone
        beqz t0, next
        mv   t0, a0
elem:   lw   a2, -16(t0)      # x[i]
        sll  a2, a2, sp
        lw   t1, 16(t0)       # y[i]
        add  t1, t1, a2
        sw   t1, 16(t0)
        addi t0, t0, 4
        bne  t0, ra, elem
next:   srli a1, a1, 1
        addi sp, sp, 1
        j    bit
done:   halt
`,
    tests: () => {
      const r = rng(17);
      const w = () => Math.floor(r() * 65536);
      return [[4, 5], [8, 1], [32, 15], [16, 0], [12, 10], [24, 6]].map(([n, a]) => {
        const x = Array.from({ length: n }, w), y = Array.from({ length: n }, w);
        const mem: Record<number, number> = { 0xfe: a, 0xff: n };
        x.forEach((v, i) => (mem[0x100 + i] = v));
        y.forEach((v, i) => (mem[0x120 + i] = v));
        const expect: Record<number, number> = Object.fromEntries(y.map((v, i) => [0x120 + i, u16(a * x[i] + v)]));
        if (n < 32) expect[0x120 + n] = mem[0x120 + n] = 0x5a5a; // past the end: untouched
        return { name: `n = ${n}, a = ${a}`, mem, expect: { mem: expect } };
      });
    },
    maxSteps: 2000, lanes: 4,
  },
  p_reduce: {
    brief: `Sum the <i>n</i> words at 0x100 (mod 2<sup>16</sup>) into the word at 0x0FE. <i>n</i> (4 … 32, a multiple of 4) is at 0x0FF; `
      + `words 0x000 … 0x0FD are free for scratch. ${KERNEL_HELP} `
      + 'Each lane sums its share; then the four partial sums must become one, through memory, with fewer lanes: '
      + '<code>tmc rs1</code> sets the mask to the leader’s rs1 (<code>li t1, 1</code>, <code>tmc t1</code>: lane 0 alone), or <code>split</code> / <code>join</code>.',
    starter: `# lane tid sums words tid, tid + 4, … ; then combine the four sums
        csrr t0, tid
        li   sp, 0x100
        lw   ra, -1(sp)       # n
        
        halt
`,
    // Strided partial sums, all lanes busy; then lane 0 alone adds the other three (a tree is a cycle longer on 4 lanes).
    ref: `        csrr t0, tid
        li   sp, 0x100
        lw   ra, -1(sp)       # n
        add  a0, sp, t0       # this lane's first word
        add  ra, ra, a0       # one past its last
        li   a1, 0            # partial sum
loop:   lw   a2, 0(a0)
        add  a1, a1, a2
        addi a0, a0, 4
        bne  a0, ra, loop
        sw   a1, 0(t0)        # partial sums at 0 … 3
        li   t1, 1
        tmc  t1               # lane 0 alone
        lw   a2, 1(x0)
        add  a1, a1, a2
        lw   a2, 2(x0)
        add  a1, a1, a2
        lw   a2, 3(x0)
        add  a1, a1, a2
        sw   a1, -2(sp)
        halt
`,
    tests: () => {
      const r = rng(23);
      return [4, 8, 32, 12, 20, 28].map((n, i) => {
        const v = Array.from({ length: n }, () => Math.floor(r() * 65536));
        const mem: Record<number, number> = { 0xff: n };
        v.forEach((x, k) => (mem[0x100 + k] = x));
        return { name: `array ${i + 1} (${n} words)`, mem, expect: { mem: { 0xfe: u16(v.reduce((s, x) => s + x, 0)) } } };
      });
    },
    maxSteps: 2000, lanes: 4,
  },
  p_hist: {
    brief: '<b>Histogram</b>: count how many of the <i>n</i> values at 0x100 fall in each of 16 bins (a value is 0 … 15: its own bin) and write the 16 counts to 0x0E0 … 0x0EF. '
      + '<i>n</i> (8 … 64, a multiple of 8) is at 0x0FF; words 0x000 … 0x0DF start at 0 and are free for scratch. '
      + '<b>Two warps</b> of four lanes run your program, taking turns every cycle: <code>csrr rd, tid</code> gives each thread its number, 0 … 7 (warp · 4 + lane). '
      + 'RV16 has no atomic add: two threads that load, add 1 and store the same counter at once lose a count. Give every thread counters of its own; '
      + '<code>bar</code> waits until the other warp has arrived too (or has ended, with <code>tmc x0</code>), and after it every thread’s counts are in memory. '
      + 'Graded on cycles (both warps’ turns) and idle lanes.',
    starter: `# thread tid (0 … 7) takes elements tid, tid + 8, tid + 16, …
        csrr t0, tid
        li   sp, 0x100
        lw   ra, -1(sp)       # n
        
        bar                   # every thread's counts are in memory
        
        halt
`,
    // Private counters, bin-major (bin b, thread t at 8·b + t), so that after the bar thread t adds up
    // bins 2t and 2t + 1: sixteen counters in a row, at 16·t. Every lane busy throughout.
    ref: `        csrr t0, tid
        li   sp, 0x100
        lw   ra, -1(sp)       # n
        add  a0, sp, t0       # this thread's first element
        add  ra, ra, sp       # one past the last
count:  lw   a1, 0(a0)        # v
        slli a1, a1, 3
        add  a1, a1, t0       # its counter: 8·v + tid
        lw   a2, 0(a1)
        addi a2, a2, 1
        sw   a2, 0(a1)
        addi a0, a0, 8
        blt  a0, ra, count
        bar                   # every thread's counts are in memory
        slli a0, t0, 4        # bin 2·tid's eight counters, then bin 2·tid + 1's
        li   sp, 0xe0
        slli t1, t0, 1
        add  sp, sp, t1       # where bin 2·tid goes
        li   ra, 2
bin:    lw   a1, 0(a0)
        lw   a2, 1(a0)
        add  a1, a1, a2
        lw   a2, 2(a0)
        add  a1, a1, a2
        lw   a2, 3(a0)
        add  a1, a1, a2
        lw   a2, 4(a0)
        add  a1, a1, a2
        lw   a2, 5(a0)
        add  a1, a1, a2
        lw   a2, 6(a0)
        add  a1, a1, a2
        lw   a2, 7(a0)
        add  a1, a1, a2
        sw   a1, 0(sp)
        addi a0, a0, 8
        addi sp, sp, 1
        addi ra, ra, -1
        bnez ra, bin
        halt
`,
    tests: () => {
      const r = rng(29);
      const sets: number[][] = [
        Array.from({ length: 8 }, (_, i) => i),
        Array(16).fill(7),
        ...[64, 24, 40, 56].map((n) => Array.from({ length: n }, () => Math.floor(r() * 16))),
      ];
      return sets.map((v, i) => {
        const mem: Record<number, number> = { 0xff: v.length };
        v.forEach((x, k) => (mem[0x100 + k] = x));
        const bins = Array(16).fill(0);
        for (const x of v) bins[x]++;
        return { name: i === 1 ? '16 values, one bin' : `${v.length} values`, mem, expect: { mem: Object.fromEntries(bins.map((c, b) => [0xe0 + b, c])) } };
      });
    },
    maxSteps: 2000, lanes: 4, warps: 2,
  },
};
