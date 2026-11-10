// Appendix E's golden model beside the gates (DOM-free, tests/baby.test.ts): BabyFollower steps the ISS at every edge
// that ends an instruction (retire high just before it) and compares CI (+ T: the hardware keeps a CMP's skip in the
// test flip-flop until the next S1), A and the stop lamp. babyHw reads the machine's pins and its tube.

import { HOLD_BEATS, isTubeState, type TubeState } from '../lib/baby';
import { SsemISS } from '../ssem/iss';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';

export interface BabyHw { ci: number; pi: number; a: number; beat: number; t: number; stop: number; retire: number; line: number }

const PINS = ['ci', 'pi', 'a', 'beat', 't', 'stop', 'retire', 'line'] as const;

export function babyHw(sim: Sim): BabyHw {
  const r = {} as Record<(typeof PINS)[number], number>;
  for (const p of PINS) r[p] = pack(sim.getBits(sim.design.root.ports[p]));
  return r;
}

/** The tube's leaf: its index in the design (found once per build). */
export function tubeLeaf(sim: Sim): number {
  for (let i = 0; i < sim.design.leaves.length; i++) if (isTubeState(sim.leafState(i))) return i;
  return -1;
}

export function tubeOf(sim: Sim, leaf: number): TubeState | null {
  const s = leaf >= 0 ? sim.leafState(leaf) : null;
  return isTubeState(s) ? s : null;
}

export const signed = (v: number): number => v | 0;

export class BabyFollower {
  iss: SsemISS;
  mismatch = '';
  private retiring = false;

  constructor(private readonly words: ArrayLike<number>) { this.iss = new SsemISS(words); }

  reset(): void { this.iss = new SsemISS(this.words); this.mismatch = ''; this.retiring = false; }

  /** Just before a rising edge. */
  before(hw: BabyHw): void { this.retiring = hw.retire === 1; }

  /** Just after it: true when an instruction finished at this edge. */
  after(hw: BabyHw): boolean {
    if (!this.retiring) return false;
    this.retiring = false;
    const step = this.iss.step();
    if (this.mismatch || !step) return true;
    const ci = (hw.ci + hw.t) | 0, at = `after line ${step.line} (instruction ${this.iss.instrs})`;
    if (ci !== this.iss.ci) this.mismatch = `CI + T is ${ci}, the model says ${this.iss.ci}, ${at}`;
    else if (signed(hw.a) !== this.iss.a) this.mismatch = `A is ${signed(hw.a)}, the model says ${this.iss.a}, ${at}`;
    else if (hw.stop !== (this.iss.halted ? 1 : 0)) this.mismatch = `the stop lamp is ${hw.stop ? 'on' : 'off'}, the model's ${this.iss.halted ? 'is on' : 'is off'}, ${at}`;
    return true;
  }

  save(): { iss: ReturnType<SsemISS['save']>; mismatch: string } { return { iss: this.iss.save(), mismatch: this.mismatch }; }
  restore(s: { iss: ReturnType<SsemISS['save']>; mismatch: string }): void { this.iss.restore(s.iss); this.mismatch = s.mismatch; this.retiring = false; }
}

/** Instructions a program runs to its stop on the golden model (null: none within `max`). */
export function instructionsToStop(words: ArrayLike<number>, max = 50_000_000): number | null {
  const iss = new SsemISS(words);
  iss.run(max);
  return iss.halted ? iss.instrs : null;
}

/** What store line i reads now (-1: X; a line past its hold time reads 0). */
export function storeLine(sim: Sim, i: number): number {
  const t = tubeOf(sim, tubeLeaf(sim));
  if (!t) return -1;
  return t.x[i] ? -1 : t.age[i] > HOLD_BEATS ? 0 : t.mem[i] | 0;
}
