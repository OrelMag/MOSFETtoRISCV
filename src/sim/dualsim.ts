// One gate-level simulation, two engines: GateSim (event-driven, every gate delay: what probes,
// the timing analyzer, gate mode and stepping need) and CycleSim (settled values only, flip-flops
// as tables: many times faster). Both give the same settled values, so DualSim runs on the cycle
// engine whenever it is asked to (preferFast: the sandbox's cycle mode) and the design allows,
// and hands the state from one to the other, pending input changes included, whenever timing is
// needed: step(), runUntil(), a trace listener (onTrace), a settle the cycle engine cannot do
// exactly (a clock that is not 0 / 1). Power-on and carry() always go through GateSim, so they
// are exactly its results. Consumers see one Sim whose identity never changes.

import { CycleSim } from './cyclesim';
import type { FlatDesign } from './flatten';
import { GateSim, type GateSimOptions } from './gatesim';
import type { PowerOnMode, Sim, SimState } from './sim';
import type { Bit } from './types';

/** Settles on GateSim before the cycle engine is built: a rebuild while editing settles once or twice, a run settles twice per cycle. */
const WARMUP = 4;

export class DualSim implements Sim {
  readonly kind = 'gate' as const;
  readonly gate: GateSim;
  /** Use the cycle engine whenever it can be exact. */
  private prefer = false;
  private fast: CycleSim | null = null;
  private built = false;
  /** Why there is no cycle engine for this design ('' if there is, or it was not tried yet). */
  whyNot = '';
  private onFast = false;
  private settles = 0;
  /** Do not try the cycle engine again before this many settles (after it refused a state). */
  private retryAt = WARMUP;
  private trace?: (net: number, value: Bit, time: number) => void;
  private watched: number[] = [];

  constructor(design: FlatDesign, opts: GateSimOptions = {}) {
    this.gate = new GateSim(design, opts);
  }

  get design(): FlatDesign {
    return this.gate.design;
  }

  private get cur(): Sim {
    return this.onFast ? this.fast! : this.gate;
  }

  /** Which engine runs now: 'gate' keeps gate-delay time, 'cycle' does not (its time stands still). */
  get engine(): 'gate' | 'cycle' {
    return this.onFast ? 'cycle' : 'gate';
  }

  get preferFast(): boolean {
    return this.prefer;
  }

  /** Allow the cycle engine (it takes over at a later settle), or go back to GateSim now. */
  set preferFast(on: boolean) {
    this.prefer = on;
    if (!on) this.toGate();
  }

  get time(): number {
    return this.cur.time;
  }

  get unstable(): boolean {
    return this.cur.unstable;
  }

  get evaluations(): number {
    return this.gate.evaluations + (this.fast?.evaluations ?? 0);
  }

  get onTrace(): ((net: number, value: Bit, time: number) => void) | undefined {
    return this.trace;
  }

  /** A trace listener wants every change at its time: GateSim from now on. */
  set onTrace(f: ((net: number, value: Bit, time: number) => void) | undefined) {
    this.trace = f;
    this.gate.onTrace = f;
    if (this.fast) this.fast.onTrace = f;
    if (f) this.toGate();
  }

  get(net: number): Bit {
    return this.cur.get(net);
  }

  getBits(nets: readonly number[]): Bit[] {
    return this.cur.getBits(nets);
  }

  setInput(port: string, value: number): void {
    this.cur.setInput(port, value);
  }

  setInputBits(port: string, bits: ArrayLike<number>): void {
    this.cur.setInputBits(port, bits);
  }

  getInput(port: string): number {
    return this.cur.getInput(port);
  }

  getInputBits(port: string): Bit[] {
    return this.cur.getInputBits(port);
  }

  poke(leaf: number, state: unknown): void {
    this.cur.poke(leaf, state);
  }

  leafState(leaf: number): unknown {
    return this.cur.leafState(leaf);
  }

  watch(nets: readonly number[]): void {
    this.gate.watch(nets);
    this.fast?.watch(nets);
    this.watched.push(...nets);
  }

  busy(): boolean {
    return this.cur.busy();
  }

  /** One gate delay: timing, so GateSim. */
  step(): boolean {
    this.toGate();
    return this.gate.step();
  }

  runUntil(t: number): void {
    this.toGate();
    this.gate.runUntil(t);
  }

  settle(): void {
    this.settles++;
    if (this.onFast) {
      const f = this.fast!;
      if (f.settle()) {
        // exact, but a flip-flop is now where its table cannot follow: GateSim from here
        if (f.tainted) {
          this.toGate();
          this.retryAt = this.settles + 64;
        }
        return;
      }
      // not exactly on the cycle engine: this one on GateSim, the cycle engine again after it
      this.toGate();
      this.gate.settle();
      this.retryAt = this.settles + 1;
      this.tryFast();
      return;
    }
    this.gate.settle();
    this.tryFast();
  }

  reset(mode?: PowerOnMode): void {
    this.onFast = false;
    this.gate.reset(mode);
    this.tryFast();
  }

  carry(prev: Sim, opts?: { known?: boolean }): void {
    this.onFast = false;
    this.gate.carry(prev, opts);
    this.tryFast();
  }

  saveState(): SimState {
    const s: DualState = { fast: this.onFast, s: this.cur.saveState() };
    return s as unknown as SimState;
  }

  restoreState(saved: SimState): void {
    const { fast, s } = saved as unknown as DualState;
    if (fast) this.fast!.restoreState(s);
    else this.gate.restoreState(s);
    this.onFast = fast;
  }

  /** Hand the state to GateSim (pending changes included) if the cycle engine has it. */
  private toGate(): void {
    if (!this.onFast) return;
    const f = this.fast!;
    this.gate.adopt(f, f.pendingNets, f.pendingLeaves);
    this.onFast = false;
  }

  /**
   * Running is about to start (Run, Run to halt): build and enter the cycle engine now if it is
   * wanted, rather than after the warm-up settles, so its one-time cost falls outside a frame's budget.
   */
  prepare(): void {
    if (this.retryAt === WARMUP) this.retryAt = 0;
    this.tryFast();
  }

  /** After a settle on GateSim: move to the cycle engine if wanted and possible. */
  private tryFast(): void {
    if (!this.prefer || this.onFast || this.trace || this.settles < this.retryAt) return;
    const g = this.gate;
    if (g.busy() || g.unstable) return;
    if (!this.built) {
      this.built = true;
      const r = CycleSim.build(this.design);
      if (r instanceof CycleSim) {
        this.fast = r;
        r.watch(this.watched);
      } else this.whyNot = r.reason;
    }
    if (!this.fast) return;
    if (this.fast.load(g)) this.onFast = true;
    else this.retryAt = this.settles + 64;
  }
}

interface DualState {
  fast: boolean;
  s: SimState;
}
