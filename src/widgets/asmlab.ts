// Chapter 13's programming practice: an editable assembly program graded on the golden model (the RV32I ISS), before any
// CPU exists. A practice is a starting text, a reference solution and cases (set registers and memory, run, compare); the
// reach challenge of its step passes when every case does, "Do it for me" puts the reference solution in the editor.
// tests/asm-practice.test.ts: the starting text fails, the solution passes, a wrong version of each fails.

import { assemble } from '../riscv/asm';
import { ISS } from '../riscv/iss';
import { debounce, h } from '../ui/dom';
import { codeEditor } from './codeedit';
import type { Stage, Widget } from '../view/stage';

export interface AsmCase {
  label: string;
  /** Registers and memory before the first instruction. */
  setup(iss: ISS): void;
  /** What a correct run leaves, in words. */
  want: string;
  /** What this run left (shown), and whether it is right. */
  got(iss: ISS): string;
  ok(iss: ISS): boolean;
  /** Called before every instruction with the program's labels (the frame practice: what a real callee may do at g). */
  watch?(iss: ISS, labels: Map<string, number>): void;
}

export interface AsmRun { halted: boolean; steps: number; iss: ISS }
export interface AsmVerdict { case: AsmCase; run: AsmRun; pass: boolean; got: string }

export const STEP_LIMIT = 2000;

/** Assemble `src` and run every case on a fresh ISS; null with `errors` when it does not assemble. */
export function gradeProgram(src: string, cases: AsmCase[]): { errors: { line: number; message: string }[]; verdicts: AsmVerdict[] } {
  const r = assemble(src);
  if (r.errors.length) return { errors: r.errors, verdicts: [] };
  const verdicts = cases.map((c) => {
    const iss = new ISS(r.words);
    c.setup(iss);
    let steps = 0;
    if (c.watch) while (!iss.halted && steps < STEP_LIMIT) { c.watch(iss, r.labels); iss.step(); steps++; }
    else steps = iss.run(STEP_LIMIT);
    const run = { halted: iss.halted, steps, iss };
    return { case: c, run, pass: run.halted && c.ok(iss), got: run.halted ? c.got(iss) : `no halt in ${STEP_LIMIT} instructions` };
  });
  return { errors: [], verdicts };
}

export interface AsmPracticeOpts {
  heading: string;
  /** One line under the heading (HTML). */
  note: string;
  initial: string;
  solution: string;
  cases: AsmCase[];
}

export interface AsmPractice extends AsmPracticeOpts {
  widget(stage: Stage): Widget;
  /** The challenge's check: the editor on the stage passes every case. */
  check(stage: Stage): boolean;
  solve(stage: Stage): void;
  /** The reference solution's verdicts. */
  reference(): AsmVerdict[];
}

export function asmPractice(o: AsmPracticeOpts): AsmPractice {
  let passing = false;
  let setText: ((t: string) => void) | null = null;
  const widget = (stage: Stage): Widget => {
    passing = false;
    const editor = codeEditor({ value: o.initial, lang: 'rvasm', rows: 16, onChange: () => later() });
    const out = h('div');
    const render = () => {
      const g = gradeProgram(editor.value, o.cases);
      editor.setDiagnostics(g.errors);
      const was = passing;
      passing = !g.errors.length && g.verdicts.every((v) => v.pass);
      if (g.errors.length) {
        out.replaceChildren(h('div', { class: 'asm-errors' }, g.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')));
      } else {
        const n = g.verdicts.filter((v) => v.pass).length;
        out.replaceChildren(
          h('p', { class: 'sub', 'aria-live': 'polite' }, `${n} of ${g.verdicts.length} cases right on the simulator.`),
          h('table', { class: 'mini abi-tab' },
            h('thead', null, h('tr', null, h('th', null, 'case'), h('th', null, 'wanted'), h('th', null, 'got'), h('th', { class: 'r' }, 'instrs'), h('th', null, ''))),
            h('tbody', null, g.verdicts.map((v) => h('tr', null,
              h('td', null, v.case.label), h('td', null, h('code', null, v.case.want)), h('td', null, h('code', null, v.got)),
              h('td', { class: 'r' }, String(v.run.steps)),
              h('td', { style: `color:var(--${v.pass ? 'good' : 'bad'});font-weight:600` }, v.pass ? 'pass' : 'fail'))))));
      }
      if (passing !== was) stage.notify();
    };
    const later = debounce(render, 250);
    setText = (t) => { editor.value = t; render(); };
    render();
    return {
      el: h('div', { class: 'widget asm-practice' }, h('div', { class: 'wgrid' },
        h('div', { class: 'panel' }, h('h3', null, o.heading), h('p', { class: 'sub', html: o.note }), editor.el),
        h('div', { class: 'panel' }, h('h3', null, 'Run on the simulator'), out))),
      destroy: () => { setText = null; editor.destroy(); },
    };
  };
  return {
    ...o,
    widget,
    check: () => passing,
    solve: () => setText?.(o.solution),
    reference: () => gradeProgram(o.solution, o.cases).verdicts,
  };
}

const wordsAt = (iss: ISS, addr: number, n: number) => Array.from({ length: n }, (_, i) => iss.dmem[(addr >> 2) + i] | 0);
const signed = (v: number) => v | 0;

// ---- 1. if and else: max(a0, a1) ----------------------------------------------------------------------------------

const MAX_PAIRS: [number, number][] = [[3, 9], [9, 3], [5, 5], [-4, 2], [-7, -2]];

export const IF_SOLUTION = `        bge  a0, a1, halt   # a0 is already the larger (or equal): leave it
        mv   a0, a1         # otherwise the answer is a1
halt:   j    halt`;

export const ASM_IF = asmPractice({
  heading: 'Write max',
  note: 'Leave the larger of the two <em>signed</em> numbers in <code>a0</code> and stop. The cases set <code>a0</code> and <code>a1</code> before the first instruction.',
  initial: `# a0 = max(a0, a1), signed numbers.
        # your code here
halt:   j    halt`,
  solution: IF_SOLUTION,
  cases: MAX_PAIRS.map(([a, b]) => ({
    label: `max(${a}, ${b})`,
    setup: (iss) => { iss.x[10] = a >>> 0; iss.x[11] = b >>> 0; },
    want: `a0 = ${Math.max(a, b)}`,
    got: (iss) => `a0 = ${signed(iss.x[10])}`,
    ok: (iss) => signed(iss.x[10]) === Math.max(a, b),
  })),
});

// ---- 2. a loop over an array --------------------------------------------------------------------------------------

export const LOOP_BASE = 0x20;
const ARRAYS: { label: string; base: number; vals: number[] }[] = [
  { label: '4 words', base: LOOP_BASE, vals: [3, 1, 4, 1] },
  { label: 'no words', base: LOOP_BASE, vals: [] },
  { label: '1 word', base: 0x10, vals: [-5] },
  { label: '8 words, some negative', base: 0x40, vals: [10, -3, 7, -20, 1, 1, 2, 100] },
];

export const LOOP_SOLUTION = `        slli a1, a1, 2      # N words are 4 N bytes
        add  a1, a0, a1     # a1 = the address just past the array
        mv   t0, a0         # t0 walks the array
        li   a0, 0          # sum = 0
        bgeu t0, a1, halt   # an empty array: nothing to add
loop:   lw   t1, 0(t0)      # the word t0 points at
        add  a0, a0, t1
        addi t0, t0, 4      # next word: 4 bytes on
        bltu t0, a1, loop
halt:   j    halt`;

export const ASM_LOOP = asmPractice({
  heading: 'Add up an array',
  note: 'On entry <code>a0</code> is the address of the first word and <code>a1</code> the number of words. Leave their sum in <code>a0</code> and stop.',
  initial: `# a0 = address of the array, a1 = number of words.
# Leave the sum of the words in a0.
        # your code here
halt:   j    halt`,
  solution: LOOP_SOLUTION,
  cases: ARRAYS.map((a) => ({
    label: a.label,
    setup: (iss) => { iss.x[10] = a.base; iss.x[11] = a.vals.length; a.vals.forEach((v, i) => { iss.dmem[(a.base >> 2) + i] = v >>> 0; }); iss.dmem[(a.base >> 2) + a.vals.length] = 1000; /* the word past the end: a loop that overruns adds it */ },
    want: `a0 = ${a.vals.reduce((s, v) => s + v, 0)}`,
    got: (iss) => `a0 = ${signed(iss.x[10])}`,
    ok: (iss) => signed(iss.x[10]) === a.vals.reduce((s, v) => s + v, 0) && wordsAt(iss, a.base, a.vals.length).every((v, i) => v === a.vals[i]),
  })),
});

/** Instructions of the reference loop over N words of array (the step quotes the slope and the empty case). */
export function loopSteps(n: number): number {
  const iss = new ISS(assemble(LOOP_SOLUTION).words);
  iss.x[10] = LOOP_BASE; iss.x[11] = n;
  return iss.run(STEP_LIMIT);
}

// ---- 3. a function and its frame ----------------------------------------------------------------------------------

const SENTINEL = (i: number) => 0xc0de0000 + i;
const S_REGS = [8, 9, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27];
/** s register names by number, for "s1 changed". */
const REG_NAME: Record<number, string> = { 8: 's0', 9: 's1', 18: 's2', 19: 's3', 20: 's4', 21: 's5', 22: 's6', 23: 's7', 24: 's8', 25: 's9', 26: 's10', 27: 's11' };
/** t1–t6 and a1–a7: a callee may change them, so f must not keep anything there across a call (t0 g uses itself). */
const CALLER_SAVED = [6, 7, 28, 29, 30, 31, 11, 12, 13, 14, 15, 16, 17];
export const FRAME_SP = 128;

export const FRAME_SOLUTION = `f:      addi sp, sp, -16    # open a frame
        sw   ra, 12(sp)     # call g overwrites ra
        sw   s0, 8(sp)
        sw   s1, 4(sp)
        mv   s0, a0         # s0 = x, still ours after a call
        call g              # a0 = g(x)
        mv   s1, a0         # s1 = g(x)
        addi a0, s0, 1
        call g              # a0 = g(x + 1)
        add  a0, a0, s1
        lw   s1, 4(sp)      # give the saved registers back
        lw   s0, 8(sp)
        lw   ra, 12(sp)
        addi sp, sp, 16     # close the frame
        ret`;

const FRAME_MAIN = `        li   sp, ${FRAME_SP}       # the stack starts at the top of the data memory
        call f             # a0 = f(a0)
halt:   j    halt

# g(x) = 3x.  Like any function, it may change
# t0-t6 and a1-a7: the cases make it leave junk
# there on every call.
g:      slli t0, a0, 1
        add  a0, a0, t0
        ret
`;

export const ASM_FRAME = asmPractice({
  heading: 'Write f',
  note: 'Write <code>f(x) = g(x) + g(x + 1)</code>, argument and result in <code>a0</code>, by calling <code>g</code> twice. The cases fill <code>s0</code>–<code>s11</code> with marker values and check they come back, along with <code>sp</code>; at every call <code>g</code> leaves junk in <code>t0</code>–<code>t6</code> and <code>a1</code>–<code>a7</code>, as any callee may.',
  initial: `# f(x) = g(x) + g(x + 1).  Give back sp and s0-s11 as you found them.
${FRAME_MAIN}
f:      # your code here
        ret`,
  solution: `${FRAME_MAIN}\n${FRAME_SOLUTION}`,
  cases: [4, 0, -2, 10].map((x) => {
    const want = 3 * x + 3 * (x + 1);
    const kept = (iss: ISS) => S_REGS.every((r, i) => iss.x[r] === SENTINEL(i)) && iss.x[2] === FRAME_SP;
    // what g was called with, this run: f must call it, with x and with x + 1
    let calls: number[] = [];
    const calledRight = () => calls.length === 2 && calls.includes(x) && calls.includes(x + 1);
    return {
      label: `f(${x})`,
      setup: (iss) => { calls = []; iss.x[10] = x >>> 0; S_REGS.forEach((r, i) => { iss.x[r] = SENTINEL(i); }); },
      // at g's entry, do what any callee may: leave junk in the temporaries and the other argument registers
      watch: (iss, labels) => {
        if (iss.pc !== labels.get('g')) return;
        calls.push(signed(iss.x[10]));
        for (const r of CALLER_SAVED) iss.x[r] = 0xbad0000 + r;
      },
      // short, so the table fits beside the editor: the note says what else is checked, a miss is named
      want: `a0 = ${want}, g(${x}) g(${x + 1})`,
      got: (iss) => `a0 = ${signed(iss.x[10])}, ${calledRight() ? `g(${x}) g(${x + 1})` : calls.length ? calls.map((c) => `g(${c})`).join(' ') : 'g not called'}${kept(iss) ? '' : iss.x[2] !== FRAME_SP ? ', sp changed' : `, ${REG_NAME[S_REGS[S_REGS.findIndex((r, i) => iss.x[r] !== SENTINEL(i))]]} changed`}`,
      ok: (iss) => signed(iss.x[10]) === want && calledRight() && kept(iss),
    };
  }),
});

/** The reference f's cost: the whole run for x = 4, and how many of those instructions are the frame, not the work. */
export const FRAME_COST = (() => {
  const g = gradeProgram(`${FRAME_MAIN}\n${FRAME_SOLUTION}`, ASM_FRAME.cases);
  const steps = g.verdicts[0].run.steps;
  const frame = FRAME_SOLUTION.split('\n').filter((l) => /^\s*(f:\s+)?(addi sp|sw\s+(ra|s\d)|lw\s+(ra|s\d))/.test(l)).length;
  return { steps, frame, ownLines: FRAME_SOLUTION.split('\n').length };
})();

// ---- the worked examples the step bodies print (not the challenges' answers, which only Show answer gives) ----------

/** Step 2's example: add 1 to every word of an array, in place (the same pointer, end address and guard as the sum). */
export const LOOP_EXAMPLE = `        slli a1, a1, 2      # N words are 4 N bytes
        add  a1, a0, a1     # a1 = the address just past the array
        bgeu a0, a1, halt   # an empty array: nothing to do
loop:   lw   t1, 0(a0)      # the word a0 points at
        addi t1, t1, 1
        sw   t1, 0(a0)      # written back where it came from
        addi a0, a0, 4      # next word: 4 bytes on
        bltu a0, a1, loop
halt:   j    halt`;

/** Step 3's example: h(x) = x + g(x), a frame for ra and one s register. */
export const FRAME_EXAMPLE = `h:      addi sp, sp, -16    # open a frame
        sw   ra, 12(sp)     # call g overwrites ra
        sw   s0, 8(sp)      # the caller's s0, kept for it
        mv   s0, a0         # x outlives the call in s0
        call g              # a0 = g(x)
        add  a0, a0, s0     # x + g(x)
        lw   s0, 8(sp)      # the caller's s0 back
        lw   ra, 12(sp)
        addi sp, sp, 16     # close the frame
        ret`;

/** The examples run: LOOP_EXAMPLE on each practice array, FRAME_EXAMPLE as h(x) = x + 3x with g and the markers (tests). */
export function examplesWork(): boolean {
  const loopOk = ARRAYS.every((a) => {
    const iss = new ISS(assemble(LOOP_EXAMPLE).words);
    iss.x[10] = a.base; iss.x[11] = a.vals.length; a.vals.forEach((v, i) => { iss.dmem[(a.base >> 2) + i] = v >>> 0; }); iss.dmem[(a.base >> 2) + a.vals.length] = 1000;
    iss.run(STEP_LIMIT);
    return iss.halted && wordsAt(iss, a.base, a.vals.length + 1).every((v, i) => (i < a.vals.length ? v === a.vals[i] + 1 : v === 1000));
  });
  const frame = gradeProgram(`${FRAME_MAIN.replace('call f', 'call h')}\n${FRAME_EXAMPLE}`, [4, 0, -2, 10].map((x) => ({
    label: `h(${x})`, want: '', got: () => '',
    setup: (iss: ISS) => { iss.x[10] = x >>> 0; S_REGS.forEach((r, i) => { iss.x[r] = SENTINEL(i); }); },
    ok: (iss: ISS) => signed(iss.x[10]) === 4 * x && S_REGS.every((r, i) => iss.x[r] === SENTINEL(i)) && iss.x[2] === FRAME_SP,
  })));
  return loopOk && !frame.errors.length && frame.verdicts.every((v) => v.pass);
}

/** Instructions the reference max takes when a0 is already the larger, and when a1 is. */
export const MAX_STEPS = (() => {
  const run = (a: number, b: number) => { const iss = new ISS(assemble(IF_SOLUTION).words); iss.x[10] = a; iss.x[11] = b; return iss.run(STEP_LIMIT); };
  return { keep: run(9, 3), take: run(3, 9) };
})();

/** Step 1's if / else template (a0 < a1 picks 1, else 2 in a2), tested in tests/asm-practice.test.ts. */
export const IF_TEMPLATE = `        bge  a0, a1, else   # the opposite of a0 < a1: jump over the then-part
        li   a2, 1          # then
        j    end            # skip the else-part
else:   li   a2, 2          # else
end:    j    end`;

/** -4 read as an unsigned number (what bltu sees). */
export const NEG4_UNSIGNED = (-4) >>> 0;
