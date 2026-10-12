// A reference program measured on its ready-wired computer: the computer built around the program, compiled
// as the sandbox would, every test played on its gates (run.ts). Shared by tests/puzzles.test.ts and
// scripts/puzzles.ts. No DOM.

import { UserLibrary } from '../editor/library';
import { emptyWorkspace } from '../editor/model';
import { computerChip, type RefCpu } from './computers';
import type { Puzzle } from './puzzles';
import type { RefPoint } from './refs';
import { hardwareNands, programWords, type PuzzleRun, runPuzzle } from './run';

/** Run `src` on the puzzle computer `cpu` for puzzle `p`: the run and the point it measures. */
export function measureOn(cpu: RefCpu, p: Puzzle, src: string): { run: PuzzleRun; point: RefPoint; diags: string[] } {
  const id = `u_pz_${p.id}`;
  const doc = computerChip(cpu, id, p.title, src);
  const ws = { ...emptyWorkspace(), chips: { [id]: doc } };
  const c = new UserLibrary(ws).compiled(id)!;
  const diags = c.diags.filter((d) => d.level === 'error').map((d) => d.msg);
  const run = runPuzzle(p, c, doc.pins);
  return { run, diags, point: { cpu, cycles: run.cycles, words: programWords(doc, ws.chips) ?? 0, nands: hardwareNands(c.def) } };
}
