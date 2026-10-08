// The test player's engine (Turing Complete style): a challenge's test cases replayed one at a
// time on the open chip's own simulation, so the canvas shows the case live (wires, pins,
// displays) and the learner can step, scrub and edit while paused. The cases are the checker's
// own (tableRows, seqStart / seqStep), so a replay sees exactly what Check saw. The document is
// never written: begin() saves the simulation's state and end() puts it back. No DOM.

import type { Sim, SimState } from '../sim/sim';
import type { Bit } from '../sim/types';
import { type BuildChallenge, type ChallengeCheck, ins, matches, outs, type PinSpec, seqClock, seqStart, seqStep, tableRows } from './challenges';
import type { EditorSim } from './runtime';

export interface TestCase {
  /** Every input's value during the case (a sequence's inputs keep their values from step to step). */
  inputs: Record<string, number>;
  /** Sequences: a clock cycle after the inputs are set. */
  tick?: boolean;
  /** Outputs checked, with their expected values (a sequence step may check only some). */
  expect: Record<string, number>;
  /** Per output, the bits that must match (absent: all). */
  care?: Record<string, number>;
}

/** A challenge's cases, made on demand (an exhaustive table has up to 65 536 rows). */
export interface TestSet {
  kind: 'table' | 'sequence';
  n: number;
  at(k: number): TestCase;
  /** The challenge's pins; `inputs` leaves out a sequence's clock. */
  ports: PinSpec[];
  inputs: PinSpec[];
  outputs: PinSpec[];
  /** Sequences: the clock pin `tick` toggles. */
  clock?: string;
}

const byName = (ps: PinSpec[], vs: number[]) => Object.fromEntries(ps.map((p, i) => [p.name, vs[i]]));

/** The cases Check runs, or null for a custom bench (a CPU core's programs). */
export function testSet(ch: BuildChallenge): TestSet | null {
  const c = ch.check;
  const I = ins(ch.ports), O = outs(ch.ports);
  if (c.kind === 'table') {
    const rows = tableRows(c, ch.ports);
    return {
      kind: 'table', n: rows.length, ports: ch.ports, inputs: I, outputs: O,
      at: (k) => {
        const v = rows[k];
        const care = c.care?.(v);
        return { inputs: byName(I, v), expect: byName(O, c.spec(v)), ...(care ? { care: byName(O, care) } : {}) };
      },
    };
  }
  if (c.kind === 'sequence') {
    const clock = seqClock(ch.ports);
    // Inputs after each step: the steps only say what changes.
    let vals: Record<string, number> = Object.fromEntries(I.map((p) => [p.name, c.init?.[p.name] ?? 0]));
    const after = c.steps.map((st) => (vals = { ...vals, ...st.set }));
    return {
      kind: 'sequence', n: c.steps.length, ports: ch.ports, inputs: I.filter((p) => p.name !== clock), outputs: O, clock,
      at: (k) => ({ inputs: after[k], expect: c.steps[k].expect, ...(c.steps[k].tick ? { tick: true } : {}) }),
    };
  }
  return null;
}

export interface OutView {
  name: string;
  width: number;
  /** What the circuit shows now (null: no such output). */
  got: Bit[] | null;
  /** Expected value; undefined when this case does not check the output. */
  want?: number;
  care?: number;
  ok: boolean;
}

export interface CaseView {
  k: number;
  case: TestCase;
  outs: OutView[];
  ok: boolean;
  /** The case could not be played (it oscillates, a pin is missing). */
  error?: string;
}

/** A sequence is replayed from a checkpoint saved before every CHECKPOINT-th step. */
const CHECKPOINT = 32;

export class TestReplay {
  /** The case on the circuit (-1: none yet). */
  k = -1;
  error: string | undefined;
  private saved: { sim: Sim; state: SimState } | null = null;
  /** The simulation the position and checkpoints belong to (a rebuild makes a new one). */
  private on: Sim | null = null;
  /** Sequences: state before step j, for j a multiple of CHECKPOINT. */
  private marks = new Map<number, SimState>();

  constructor(readonly es: EditorSim, readonly set: TestSet, private readonly check: ChallengeCheck) {}

  get active(): boolean {
    return this.saved !== null;
  }

  /** Take over the simulation: pause the run loop and remember where it was. */
  begin(): void {
    const es = this.es;
    es.flush();
    if (es.running) es.pause();
    this.saved = es.sim ? { sim: es.sim, state: es.sim.saveState() } : null;
    this.on = null;
  }

  /** Give the simulation back as it was (or, after a rebuild, with the document's inputs). */
  end(): void {
    const es = this.es;
    const s = this.saved;
    this.saved = null;
    this.on = null;
    this.marks.clear();
    this.k = -1;
    if (s && es.sim === s.sim) {
      s.sim.restoreState(s.state);
      es.notify(true);
    } else es.reapply();
  }

  /** Play case k on the circuit. */
  goto(k: number): void {
    const es = this.es;
    const sim = es.sim;
    k = Math.max(0, Math.min(this.set.n - 1, k));
    if (!sim) {
      this.k = k;
      this.error = 'the circuit cannot be simulated';
      return es.notify();
    }
    if (!this.saved) this.begin();
    let restarted = false;
    if (sim !== this.on) {
      // A new simulation (the first move, an edit while paused): no position, no checkpoints on it.
      this.on = sim;
      this.marks.clear();
      this.k = -1;
      if (this.set.kind === 'table') {
        // Check runs a table on a fresh simulation, where nothing is known before the inputs are:
        // a value the editor carried over onto a net nothing drives any more must not pass a row.
        sim.reset('x');
        restarted = true;
      }
    }
    this.error = undefined;
    try {
      if (this.set.kind === 'table') this.drive(sim, this.set.at(k).inputs);
      else restarted = this.play(sim, k);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      // Where the sequence stopped is unknown: start over on the next move.
      this.on = null;
    }
    this.k = k;
    es.notify(restarted);
  }

  /** The simulation was rebuilt (or the chip edited): play the current case again on it. */
  resync(): void {
    if (this.saved && this.k >= 0) {
      this.on = null;
      this.goto(this.k);
    }
  }

  /** The current case against what the circuit shows now. */
  read(): CaseView {
    const k = Math.max(0, this.k);
    const c = this.set.at(k);
    const outs: OutView[] = this.set.outputs.map((p) => {
      const got = this.es.pinBits(p.name);
      const want = c.expect[p.name];
      const care = c.care?.[p.name];
      const ok = want === undefined || (!!got && got.length === p.width && matches(got, want, care));
      return { name: p.name, width: p.width, got, ...(want !== undefined ? { want } : {}), ...(care !== undefined ? { care } : {}), ok };
    });
    return { k, case: c, outs, ok: !this.error && outs.every((o) => o.ok), ...(this.error ? { error: this.error } : {}) };
  }

  private drive(sim: Sim, vals: Record<string, number>): void {
    const ports = sim.design.root.def.ports;
    for (const [name, v] of Object.entries(vals)) {
      const p = ports.find((q) => q.name === name && q.dir === 'in');
      if (!p) throw new Error(`the chip has no input pin '${name}'`);
      sim.setInput(name, v);
    }
    sim.settle();
    if (sim.unstable) throw new Error('it does not settle (it oscillates)');
  }

  /** Sequences: bring the circuit to the state after step k. True when its time went back. */
  private play(sim: Sim, k: number): boolean {
    const c = this.check;
    if (c.kind !== 'sequence') return false;
    const clk = this.set.clock!;
    const ports = sim.design.root.def.ports;
    for (const p of ins(this.set.ports)) {
      if (!ports.some((q) => q.name === p.name && q.dir === 'in')) throw new Error(`the chip has no input pin '${p.name}'`);
    }
    let from = this.k + 1;
    let restarted = false;
    let vals: Record<string, number>;
    if (this.k >= 0 && this.k < k) vals = { ...this.set.at(this.k).inputs };
    else {
      // Back (or a fresh start): the nearest checkpoint at or before k.
      let j = Math.floor(k / CHECKPOINT) * CHECKPOINT;
      while (j > 0 && !this.marks.has(j)) j -= CHECKPOINT;
      const m = this.marks.get(j);
      if (m) {
        sim.restoreState(m);
        vals = j ? { ...this.set.at(j - 1).inputs } : Object.fromEntries(ins(this.set.ports).map((p) => [p.name, c.init?.[p.name] ?? 0]));
      } else {
        vals = seqStart(sim, this.set.ports, c);
        this.marks.set(0, sim.saveState());
      }
      from = j;
      restarted = true;
    }
    for (let s = from; s <= k; s++) {
      if (s % CHECKPOINT === 0 && !this.marks.has(s)) this.marks.set(s, sim.saveState());
      seqStep(sim, clk, c.steps[s], s, vals);
    }
    return restarted;
  }
}

