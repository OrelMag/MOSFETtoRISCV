// Program puzzles: every reference solution passes its tests and meets its level's par; every
// starter assembles (and does not already pass); failures say what went wrong. Kernel puzzles run
// on the lane golden model and report idle lanes.

import { describe, expect, it } from 'vitest';
import { stars } from '../src/campaign/grade';
import { nodeById } from '../src/campaign/nodes';
import { PUZZLES, runPuzzle } from '../src/campaign/puzzles';

describe('program puzzles', () => {
  it.each(Object.entries(PUZZLES))('%s: the reference passes and meets par; the starter assembles and fails', (id, p) => {
    const r = runPuzzle(p, p.ref);
    expect(r.errors).toEqual([]);
    expect(r.results.filter((t) => !t.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    const n = nodeById(id)!;
    expect(n.kind).toBe('program');
    console.log(id, 'size', r.size, 'cycles', r.cycles, ...(p.lanes ? ['idle', r.idle] : []));
    expect(stars({ size: r.size, cycles: r.cycles, idle: r.idle }, n.par)).toBe(3);
    // A kernel's par is its reference, measured.
    if (p.lanes) expect(n.par).toEqual({ cycles: r.cycles, idle: r.idle });
    else expect(r.idle).toBeUndefined();
    const s = runPuzzle(p, p.starter);
    expect(s.errors).toEqual([]);
    expect(s.ok).toBe(false);
  });

  it('reports assembler errors, wrong outputs and runaway programs', () => {
    const p = PUZZLES.p_add;
    expect(runPuzzle(p, 'foo').errors[0]).toMatchObject({ line: 1 });
    const wrong = runPuzzle(p, 'lw a0, -4(x0)\nsw a0, -3(x0)\nhalt');
    expect(wrong.results[0].why).toMatch(/output 2, expected 5/);
    expect(runPuzzle(p, 'halt').results[0].why).toMatch(/output nothing, expected 5/);
    const loop = runPuzzle(p, 'l: beq x0, x0, l'); // a spin (j to itself would be halt)
    expect(loop.results[0].why).toMatch(/still running/);
  });
});

describe('kernel puzzles (four lanes)', () => {
  // The reference without tid: every lane walks elements 0, 4, 8, …, so 1–3, 5–7, … are never touched.
  const noTid = PUZZLES.p_saxpy.ref.replace(/^\s*csrr t0, tid\n/m, '').replace(/^\s*add {2}a0, a0, t0.*\n/m, '');

  it('a saxpy that forgets the tid offset fails on the elements it skips', () => {
    expect(noTid).not.toMatch(/tid/);
    const r = runPuzzle(PUZZLES.p_saxpy, noTid);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(false);
    const a0 = r.results.find((t) => t.name.endsWith('a = 0'))!;
    expect(a0.ok).toBe(true); // y unchanged: nothing to do
    for (const t of r.results.filter((t) => t !== a0)) expect(t.why).toMatch(/memory\[0x0121\]/);
  });

  it('idle lanes: none in saxpy, the combine\'s in a reduction, per test and as the mean', () => {
    const s = runPuzzle(PUZZLES.p_saxpy, PUZZLES.p_saxpy.ref);
    expect(s.idle).toBe(0);
    expect(s.results.every((t) => t.idle === 0)).toBe(true);
    const r = runPuzzle(PUZZLES.p_reduce, PUZZLES.p_reduce.ref);
    expect(r.results.every((t) => t.idle! > 0)).toBe(true);
    // the combine is a fixed cost: the shortest array idles the most
    const idles = r.results.map((t) => t.idle!);
    expect(r.results[0].idle).toBe(Math.max(...idles));
    expect(r.idle).toBe(Math.round(idles.reduce((a, b) => a + b, 0) / idles.length));
  });

  it('a combine with split / join passes too; one every lane repeats keeps every lane busy', () => {
    const partial = PUZZLES.p_reduce.ref.slice(0, PUZZLES.p_reduce.ref.indexOf('        li   t1, 1'));
    const split = runPuzzle(PUZZLES.p_reduce, `${partial}        seqz t1, t0
        split t1              # lane 0 runs on, the others wait
        beqz t1, skip
        lw   a2, 1(x0)
        add  a1, a1, a2
        lw   a2, 2(x0)
        add  a1, a1, a2
        lw   a2, 3(x0)
        add  a1, a1, a2
        sw   a1, -2(sp)
skip:   join
        halt
`);
    expect(split.results.filter((t) => !t.ok)).toEqual([]);
    expect(split.idle).toBeGreaterThan(0);
    const all = runPuzzle(PUZZLES.p_reduce, `${partial}        lw   a1, 0(x0)
        lw   a2, 1(x0)
        add  a1, a1, a2
        lw   a2, 2(x0)
        add  a1, a1, a2
        lw   a2, 3(x0)
        add  a1, a1, a2
        sw   a1, -2(sp)
        halt
`);
    expect(all.ok).toBe(true);
    expect(all.idle).toBe(0);
  });

  it('a lane error and a runaway warp are reported per test', () => {
    const p = PUZZLES.p_reduce;
    expect(runPuzzle(p, 'csrw mstatus, x0\nhalt').results[0].why).toMatch(/no CSRs/);
    expect(runPuzzle(p, 'l: beq x0, x0, l').results[0].why).toMatch(/still running after 2000 warp instructions/);
    const empty = runPuzzle(p, 'tmc x0'); // an empty mask ends the warp: halted, wrong sum
    expect(empty.results[0].why).toMatch(/memory\[0x00fe\]/);
  });
});
