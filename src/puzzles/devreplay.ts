// The device puzzle player's engine: one test replayed on the open chip's own simulation, a world step at a time, so the
// canvas (the device's face, the wires) and the probes follow it. Back replays from power-on (a test is at most a few
// thousand cycles). begin() saves the simulation's state and end() gives it back, as the stream puzzles' player does
// (replay.ts). No DOM.

import type { DeviceState } from '../editor/devparts';
import type { EditorSim } from '../editor/runtime';
import type { Sim, SimState } from '../sim/sim';
import { cycleLimit, type DeviceFound, deviceOver, type DevicePuzzle, deviceTests, type DeviceTestRun, findDevice, judgeDevice, loadDeviceTest } from './devpuzzles';

export interface DeviceView {
  /** World steps taken, and clock cycles run, in this test. */
  step: number;
  cycles: number;
  st: DeviceState | null;
  /** The judgement once the test is over (null while it runs). */
  verdict: DeviceTestRun | null;
  problems: string[];
}

export class DeviceReplay {
  k = -1;
  private saved: { sim: Sim; state: SimState } | null = null;
  private on: Sim | null = null;
  private found: DeviceFound | null = null;
  private problems: string[] = [];

  constructor(readonly es: EditorSim, readonly puzzle: DevicePuzzle) {}

  get test() {
    return deviceTests(this.puzzle)[this.k];
  }

  private begin(): void {
    const es = this.es;
    es.flush();
    if (es.running) es.pause();
    this.saved = es.sim ? { sim: es.sim, state: es.sim.saveState() } : null;
    this.on = null;
  }

  end(): void {
    const s = this.saved;
    this.saved = null;
    this.on = null;
    this.k = -1;
    if (s && this.es.sim === s.sim) {
      s.sim.restoreState(s.state);
      this.es.notify(true);
    } else this.es.reapply();
  }

  /** Power on with test k loaded, at step 0. */
  load(k: number): void {
    if (!this.saved) this.begin();
    this.k = Math.max(0, Math.min(deviceTests(this.puzzle).length - 1, k));
    this.restart();
    this.es.notify(true);
  }

  private restart(): void {
    const es = this.es;
    es.flush();
    this.on = es.sim;
    const f = es.sim ? findDevice(es, this.puzzle) : ['the circuit cannot be simulated'];
    this.found = Array.isArray(f) ? null : f;
    this.problems = Array.isArray(f) ? f : [];
    if (this.found) loadDeviceTest(es, this.found, this.puzzle, this.k);
    es.cycles = 0;
  }

  private st(): DeviceState | null {
    return this.found && this.es.sim ? (this.es.sim.leafState(this.found.li) as DeviceState) : null;
  }

  /** Go to world step n (clamped to the test's end). */
  goto(n: number): void {
    const es = this.es;
    if (this.k < 0) return;
    if (es.sim !== this.on) this.restart();
    let st = this.st();
    if (!st || !this.found) return es.notify();
    const t = this.test;
    let restarted = false;
    if (n < st.n) {
      this.restart();
      restarted = true;
      st = this.st()!;
    }
    const left = cycleLimit(t, this.found.en) - es.cycles;
    if (st.n < n && !deviceOver(st, t) && left > 0) es.runCycles(left, () => { const s = this.st()!; return s.n >= n || deviceOver(s, t); });
    es.notify(restarted);
  }

  step(d: number): void {
    const st = this.st();
    this.goto((st?.n ?? 0) + d);
  }

  toEnd(): void {
    this.goto(Infinity);
  }

  /** After an edit while playing: the same step on the rebuilt circuit. */
  resync(): void {
    if (this.k < 0 || !this.saved || this.es.sim === this.on) return;
    const n = this.st()?.n ?? 0;
    this.restart();
    this.goto(n);
  }

  read(): DeviceView {
    const st = this.st(), t = this.test;
    if (!st || !t || !this.found) return { step: 0, cycles: this.es.cycles, st: null, verdict: null, problems: this.problems.length ? this.problems : ['no test loaded'] };
    const over = deviceOver(st, t) || this.es.cycles >= cycleLimit(t, this.found.en);
    return { step: st.n, cycles: this.es.cycles, st, verdict: over ? judgeDevice(st, t, this.es.cycles) : null, problems: [] };
  }
}
