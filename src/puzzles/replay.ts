// The puzzle player's engine: one test replayed on the open chip's own simulation, a cycle at a time, so the
// canvas, the CPU drawer and the probes show it live. Forward runs real clock cycles (EditorSim.runCycles:
// the edge hooks see them); back restores the nearest checkpoint (one every CHECKPOINT cycles) and runs
// forward from it. begin() saves the simulation's state and end() gives it back, as the challenges' test
// player does (editor/testrun.ts). No DOM.

import { type PuzzleInState, type PuzzleOutState } from '../editor/puzzleparts';
import type { EditorSim } from '../editor/runtime';
import type { Sim, SimState } from '../sim/sim';
import { outputFrom, type Puzzle, type PuzzleTest } from './puzzles';
import { findPorts, judge, loadTest, type PortsFound, type TestRun } from './run';

const CHECKPOINT = 32;

export interface ReplayView {
  /** Clock cycles run in this test. */
  cycle: number;
  /** Words of the input taken so far (puzzle words: pieces of a narrow port counted whole). */
  taken: number;
  /** Puzzle words written so far. */
  got: number[];
  halted: boolean;
  /** The judgement once halted or at the limit (null while running). */
  verdict: TestRun | null;
  /** Why it cannot play (no ports, no clock, …). */
  problems: string[];
}

export class PuzzleReplay {
  /** The test on the circuit (-1: none). */
  k = -1;
  private saved: { sim: Sim; state: SimState } | null = null;
  private on: Sim | null = null;
  private ports: PortsFound | null = null;
  private marks = new Map<number, SimState>();
  private problems: string[] = [];

  constructor(readonly es: EditorSim, readonly puzzle: Puzzle, private readonly tests: PuzzleTest[]) {}

  get active(): boolean {
    return this.saved !== null;
  }

  get test(): PuzzleTest | undefined {
    return this.tests[this.k];
  }

  /** Take over the simulation (pause the run loop, remember where it was). */
  private begin(): void {
    const es = this.es;
    es.flush();
    if (es.running) es.pause();
    this.saved = es.sim ? { sim: es.sim, state: es.sim.saveState() } : null;
    this.on = null;
  }

  /** Give the simulation back as it was before the player (or, after a rebuild, with the document's inputs). */
  end(): void {
    const s = this.saved;
    this.saved = null;
    this.on = null;
    this.marks.clear();
    this.k = -1;
    if (s && this.es.sim === s.sim) {
      s.sim.restoreState(s.state);
      this.es.notify(true);
    } else this.es.reapply();
  }

  /** Power on with test k loaded, at cycle 0. */
  load(k: number): void {
    const es = this.es;
    if (!this.saved) this.begin();
    this.k = Math.max(0, Math.min(this.tests.length - 1, k));
    this.restart();
    es.notify(true);
  }

  private restart(): void {
    const es = this.es;
    es.flush();
    this.on = es.sim;
    this.marks.clear();
    const p = es.sim ? findPorts(es) : ['the circuit cannot be simulated'];
    this.ports = Array.isArray(p) ? null : p;
    this.problems = Array.isArray(p) ? p : [];
    if (!this.ports || !es.sim) return;
    loadTest(es, this.ports, this.puzzle, this.tests[this.k]);
    this.marks.set(0, es.sim.saveState());
  }

  /** Go to cycle c of the current test (clamped to 0 … the halt or the limit). */
  goto(c: number): void {
    const es = this.es;
    if (this.k < 0) return;
    if (es.sim !== this.on) this.restart(); // rebuilt (an edit while paused): start the test over on it
    const sim = es.sim;
    if (!sim || !this.ports) return es.notify();
    c = Math.max(0, Math.min(this.puzzle.maxCycles, Math.round(c)));
    let restarted = false;
    if (c < es.cycles) {
      let j = Math.floor(c / CHECKPOINT) * CHECKPOINT;
      while (j > 0 && !this.marks.has(j)) j -= CHECKPOINT;
      sim.restoreState(this.marks.get(j)!);
      es.cycles = j;
      restarted = true;
    }
    while (es.cycles < c && !es.halted) {
      const next = Math.min(c, (Math.floor(es.cycles / CHECKPOINT) + 1) * CHECKPOINT);
      es.runCycles(next - es.cycles);
      if (es.cycles % CHECKPOINT === 0 && !this.marks.has(es.cycles)) this.marks.set(es.cycles, sim.saveState());
    }
    es.notify(restarted);
  }

  step(d: number): void {
    this.goto(this.es.cycles + d);
  }

  /** Run until the halt reads 1 (or the limit). */
  toEnd(): void {
    this.goto(this.puzzle.maxCycles);
  }

  /** After any change of the simulation: when it was rebuilt (an edit while playing), replay the test to the same cycle on it. */
  resync(): void {
    if (this.k < 0 || !this.saved || this.es.sim === this.on) return;
    const c = this.es.cycles;
    this.restart();
    this.goto(c);
  }

  read(): ReplayView {
    const es = this.es, sim = es.sim, t = this.test;
    if (!sim || !this.ports || !t) return { cycle: es.cycles, taken: 0, got: [], halted: false, verdict: null, problems: this.problems.length ? this.problems : ['no test loaded'] };
    const ist = sim.leafState(this.ports.inLi) as PuzzleInState;
    const ost = sim.leafState(this.ports.outLi) as PuzzleOutState;
    const k = Math.max(1, Math.ceil(this.puzzle.bits / this.ports.inW));
    const halted = es.halted;
    const done = halted || es.cycles >= this.puzzle.maxCycles;
    return {
      cycle: es.cycles, taken: Math.floor(ist.i / k), got: outputFrom(this.puzzle, ost.out, this.ports.outW), halted,
      verdict: done ? judge(es, this.ports, this.puzzle, t, es.cycles) : null, problems: [],
    };
  }
}
