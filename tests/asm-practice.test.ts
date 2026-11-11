import { describe, expect, it } from 'vitest';
import { ASM_FRAME, ASM_IF, ASM_LOOP, FRAME_COST, FRAME_EXAMPLE, FRAME_SOLUTION, IF_SOLUTION, LOOP_EXAMPLE, LOOP_SOLUTION, MAX_STEPS, examplesWork, gradeProgram, loopSteps } from '../src/widgets/asmlab';

const allPass = (src: string, p: { cases: Parameters<typeof gradeProgram>[1] }) => {
  const g = gradeProgram(src, p.cases);
  return !g.errors.length && g.verdicts.every((v) => v.pass);
};

describe('chapter 13 programming practice', () => {
  it('the starting texts fail and the reference solutions pass', () => {
    for (const p of [ASM_IF, ASM_LOOP, ASM_FRAME]) {
      expect(allPass(p.initial, p)).toBe(false);
      expect(allPass(p.solution, p)).toBe(true);
      expect(p.reference().every((v) => v.pass && v.run.halted)).toBe(true);
    }
  });
  it('max: an unsigned compare, and always taking a1, are caught', () => {
    expect(allPass(IF_SOLUTION.replace('bge ', 'bgeu'), ASM_IF)).toBe(false);
    expect(allPass(IF_SOLUTION.replace('bge  a0, a1, halt', 'nop'), ASM_IF)).toBe(false);
  });
  it('array sum: off-by-one, a loop that runs for an empty array, a byte step are caught', () => {
    expect(allPass(LOOP_SOLUTION.replace('addi t0, t0, 4 ', 'addi t0, t0, 1 '), ASM_LOOP)).toBe(false);
    expect(allPass(LOOP_SOLUTION.replace('        bgeu t0, a1, halt   # an empty array: nothing to add\n', ''), ASM_LOOP)).toBe(false);
    expect(allPass(LOOP_SOLUTION.replace('slli a1, a1, 2 ', 'slli a1, a1, 1 '), ASM_LOOP)).toBe(false);
  });
  it('function: forgetting ra, an s register or the sp restore is caught', () => {
    const bad = (drop: RegExp) => ASM_FRAME.solution.split('\n').filter((l) => !drop.test(l)).join('\n');
    expect(allPass(bad(/ra, 12\(sp\)/), ASM_FRAME)).toBe(false);
    expect(allPass(bad(/lw\s+s0/), ASM_FRAME)).toBe(false);
    expect(allPass(bad(/addi sp, sp, 16/), ASM_FRAME)).toBe(false);
  });
  it('function: keeping x or ra in a register a callee may change, or not calling g at all, is caught', () => {
    const main = ASM_FRAME.initial.split('\nf:')[0];
    const f = (body: string) => `${main}\nf:${body}`;
    // x in t1 and ra in t3 across the calls: right only while g happens to leave them alone
    expect(allPass(f(`      mv t3, ra\n        mv t1, a0\n        call g\n        mv t2, a0\n        addi a0, t1, 1\n        call g\n        add a0, a0, t2\n        mv ra, t3\n        ret`), ASM_FRAME)).toBe(false);
    // x in a1 across a call, the rest of the frame right
    expect(allPass(f(`      addi sp, sp, -16\n        sw ra, 12(sp)\n        sw s0, 8(sp)\n        mv a1, a0\n        call g\n        mv s0, a0\n        addi a0, a1, 1\n        call g\n        add a0, a0, s0\n        lw s0, 8(sp)\n        lw ra, 12(sp)\n        addi sp, sp, 16\n        ret`), ASM_FRAME)).toBe(false);
    // 6x + 3 computed directly: the right value, but g is never called
    expect(allPass(f(`      slli t0, a0, 2\n        slli t1, a0, 1\n        add a0, t0, t1\n        addi a0, a0, 3\n        ret`), ASM_FRAME)).toBe(false);
  });
  it('the numbers the steps quote', () => {
    expect(MAX_STEPS).toEqual({ keep: 2, take: 3 });
    expect([0, 1, 2, 8].map(loopSteps)).toEqual([6, 10, 14, 38]);
    expect(FRAME_COST.frame).toBe(8);
    expect(FRAME_SOLUTION.split('\n').length).toBe(15);
    expect(FRAME_COST.steps).toBe(27);
  });
});

import { IF_TEMPLATE, NEG4_UNSIGNED } from '../src/widgets/asmlab';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';

describe('step 1 template', () => {
  it('picks 1 when a0 < a1 and 2 otherwise', () => {
    const run = (a: number, b: number) => { const iss = new ISS(assemble(IF_TEMPLATE).words); iss.x[10] = a >>> 0; iss.x[11] = b >>> 0; iss.run(100); return iss.x[12]; };
    expect([run(1, 2), run(2, 1), run(2, 2), run(-1, 0)]).toEqual([1, 2, 2, 1]);
    expect(NEG4_UNSIGNED).toBe(4294967292);
  });
});

describe('the worked examples the step bodies print', () => {
  it('run correctly on the simulator, and are not the challenges\' answers', () => {
    expect(examplesWork()).toBe(true);
    expect(LOOP_EXAMPLE).not.toBe(LOOP_SOLUTION);
    expect(FRAME_EXAMPLE).not.toBe(FRAME_SOLUTION);
    // the array example does not pass the sum challenge, nor the h example the f challenge
    expect(allPass(LOOP_EXAMPLE, ASM_LOOP)).toBe(false);
    expect(allPass(ASM_FRAME.initial.replace(/f:\s+# your code here\n\s+ret/, FRAME_EXAMPLE.replace(/^h:/, 'f:')), ASM_FRAME)).toBe(false);
  });
});
