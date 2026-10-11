// The program puzzles' two ports (src/puzzles): PUZZLE IN hands the circuit a stream of words, PUZZLE OUT
// records the words the circuit writes. Like the console, both are external parts (sim/types isExternal:
// a behaviour with no structure, zero cost, a comment in Verilog) that sample their inputs when their own
// clk input rises, so they work at any depth of the hierarchy and on either engine. Their streams live in
// the leaves' private state: the puzzle runner and the puzzle drawer poke the input stream in and read the
// output back (Sim.poke / leafState).
//
// PUZZLE IN: `data` is the word waiting (0 when none), `ready` is 1 while one waits, and `read` = 1 at a
// rising clk edge takes it (the keyboard part's protocol); reading past the end is counted, not silent.
// PUZZLE OUT: on a rising clk edge with `we` = 1 it records `data` (an X word as -1) and the edge it came on.

import type { ComponentDef } from '../sim/types';
import type { Sim } from '../sim/sim';
import type { HierNode } from '../sim/flatten';

/** Widest puzzle port (packed behaviour values are exact to 53 bits; a CPU word is at most 32). */
export const PUZZLE_MAX_WIDTH = 32;

/** Private state of a PUZZLE IN leaf. */
export interface PuzzleInState {
  /** The clk level last seen (-1: none yet). */
  c: number;
  /** The stream, and how many words of it the circuit has taken. */
  q: number[];
  i: number;
  /** Rising clk edges seen, and reads at an edge with nothing left. */
  e: number;
  over: number;
}

/** Private state of a PUZZLE OUT leaf. */
export interface PuzzleOutState {
  c: number;
  /** The words written (-1: a word with an X bit) and the clk edge (1-based) each came on. */
  out: number[];
  at: number[];
  e: number;
}

export const puzzleInInit = (): PuzzleInState => ({ c: -1, q: [], i: 0, e: 0, over: 0 });
export const puzzleOutInit = (): PuzzleOutState => ({ c: -1, out: [], at: [], e: 0 });

/** A PUZZLE IN state holding `words` (none taken yet), keeping the clk level it last saw. */
export const loadedIn = (words: number[], old?: unknown): PuzzleInState =>
  ({ ...puzzleInInit(), c: (old as PuzzleInState | undefined)?.c ?? -1, q: words.slice() });

export const PUZZLE_IN_PREFIX = 'puzzle_in_';
export const PUZZLE_OUT_PREFIX = 'puzzle_out_';

const ins = new Map<number, ComponentDef>();
const outs = new Map<number, ComponentDef>();

/** v as an unsigned w-bit word. */
const toW = (v: number, w: number) => (w >= 32 ? v >>> 0 : v & (2 ** w - 1));

/** PUZZLE IN, w bits wide. */
export function puzzleIn(w: number): ComponentDef {
  let d = ins.get(w);
  if (d) return d;
  d = {
    id: `${PUZZLE_IN_PREFIX}${w}`, name: 'Puzzle in', category: 'plumbing',
    summary: 'The puzzle\'s input stream: data is the next word (0 when none is left), ready is 1 while one waits, and read = 1 at a '
      + 'rising clk edge takes it. Check fills it with each test\'s words. Outside the circuit: no gates, nothing in Verilog.',
    ports: [
      { name: 'read', width: 1, dir: 'in', doc: 'Takes the word on data at the next rising clk edge' },
      { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true, doc: 'Samples read on its rising edge' },
      { name: 'data', width: w, dir: 'out', doc: 'The next word of the stream (0 when none is left)' },
      { name: 'ready', width: 1, dir: 'out', doc: '1 while a word waits' },
    ],
    symbol: { kind: 'box', label: 'PUZZLE IN', w: 10, h: 6 },
    behavior: {
      init: puzzleInInit,
      eval: ([read, clk], s) => {
        const st = s as PuzzleInState;
        if (clk === 1 && st.c === 0) {
          st.e++;
          if (read === 1) {
            if (st.i < st.q.length) st.i++;
            else st.over++;
          }
        }
        st.c = clk;
        const left = st.i < st.q.length;
        return [left ? toW(st.q[st.i], w) : 0, left ? 1 : 0];
      },
    },
  };
  ins.set(w, d);
  return d;
}

/** PUZZLE OUT, w bits wide. */
export function puzzleOut(w: number): ComponentDef {
  let d = outs.get(w);
  if (d) return d;
  d = {
    id: `${PUZZLE_OUT_PREFIX}${w}`, name: 'Puzzle out', category: 'plumbing',
    summary: 'The puzzle\'s output stream: on a rising clk edge with we = 1 it records the word on data. Check compares what it '
      + 'recorded with each test\'s expected words. Outside the circuit: no gates, nothing in Verilog.',
    ports: [
      { name: 'data', width: w, dir: 'in', doc: 'The word recorded at the clock edge' },
      { name: 'we', width: 1, dir: 'in', doc: 'Write: 1 records data at the next rising clk edge' },
      { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true, doc: 'Samples data and we on its rising edge' },
    ],
    symbol: { kind: 'box', label: 'PUZZLE OUT', w: 10, h: 6 },
    behavior: {
      init: puzzleOutInit,
      eval: ([data, we, clk], s) => {
        const st = s as PuzzleOutState;
        if (clk === 1 && st.c === 0) {
          st.e++;
          if (we === 1) {
            st.out.push(data < 0 ? -1 : data);
            st.at.push(st.e);
          }
        }
        st.c = clk;
        return [];
      },
    },
  };
  outs.set(w, d);
  return d;
}

export type PuzzlePortKind = 'in' | 'out';

/** Which puzzle port a definition is, and its width (null for any other definition). */
export function puzzlePortOf(d: ComponentDef | undefined): { kind: PuzzlePortKind; width: number } | null {
  if (!d) return null;
  if (d.id.startsWith(PUZZLE_IN_PREFIX) && ins.get(d.ports[2].width) === d) return { kind: 'in', width: d.ports[2].width };
  if (d.id.startsWith(PUZZLE_OUT_PREFIX) && outs.get(d.ports[0].width) === d) return { kind: 'out', width: d.ports[0].width };
  return null;
}

export interface PuzzleLeaf { li: number; path: string[]; width: number }

/** The puzzle ports of a simulation, at any depth of its hierarchy. */
export function puzzleLeaves(sim: Sim): { ins: PuzzleLeaf[]; outs: PuzzleLeaf[] } {
  const r: { ins: PuzzleLeaf[]; outs: PuzzleLeaf[] } = { ins: [], outs: [] };
  sim.design.leaves.forEach((l, li) => {
    const k = puzzlePortOf(l.def);
    if (k) (k.kind === 'in' ? r.ins : r.outs).push({ li, path: l.node.path, width: k.width });
  });
  return r;
}

/** Does a hierarchy hold a puzzle port (in it or in any chip it places)? */
export function hasPuzzlePorts(root: HierNode): boolean {
  for (const c of root.children?.values() ?? []) if (puzzlePortOf(c.def) || hasPuzzlePorts(c)) return true;
  return false;
}
