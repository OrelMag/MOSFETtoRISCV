// Program puzzles: every reference solution passes its tests and meets its level's par; every
// starter assembles (and does not already pass); failures say what went wrong.

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
    console.log(id, 'size', r.size, 'cycles', r.cycles);
    expect(stars({ size: r.size, cycles: r.cycles }, n.par)).toBe(3);
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
