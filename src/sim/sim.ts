import type { FlatDesign } from './flatten';
import type { Bit } from './types';

export type PowerOnMode = 'x' | 'zero' | 'random';

/** An opaque saved state (Sim.saveState). */
export type SimState = { readonly __simState: true };

/** Common interface of the gate-level and switch-level engines, as seen by views. */
export interface Sim {
  readonly design: FlatDesign;
  readonly kind: 'gate' | 'switch';
  /** Simulation time in gate delays (always 0 for the switch-level solver). */
  readonly time: number;
  /** True when the last settle() hit its limit (oscillation, e.g. a ring oscillator). */
  readonly unstable: boolean;
  get(net: number): Bit;
  getBits(nets: readonly number[]): Bit[];
  /** Drive a root input port with a packed value. Does not propagate until step/settle. */
  setInput(port: string, value: number): void;
  /** Drive a root input bit by bit (LSB first; exact at any width, X allowed; Z at switch level). */
  setInputBits(port: string, bits: ArrayLike<number>): void;
  /** The value driven on a root input (packed: −1 if any bit is X or Z). */
  getInput(port: string): number;
  /** The bits driven on a root input, LSB first. */
  getInputBits(port: string): Bit[];
  /** Advance one time instant. Returns false when nothing is left to do. */
  step(): boolean;
  /** Gate level only: process events up to time t and stand at t (pending ones stay pending). */
  runUntil?(t: number): void;
  /** Run until quiet. */
  settle(): void;
  /** True if there are events still to process. */
  busy(): boolean;
  reset(mode?: PowerOnMode): void;
  /**
   * Take over the state of `prev`, a simulation of an earlier version of the design (an editor
   * rebuilds the design on every edit): nets matched through the hierarchy, root inputs by name.
   * With `known`, only 0/1 values carry over: a net that was unknown (X) takes its power-on
   * value instead, so an edit heals storage that went X while it was half wired.
   */
  carry(prev: Sim, opts?: { known?: boolean }): void;
  /**
   * Everything a later step, edge or input change can alter (values, inputs, time, pending
   * events, behavioural state), for stepping back: restoreState(saveState()) puts the simulation
   * exactly where it was. The value is opaque and may only go back to the simulation it came from.
   */
  saveState(): SimState;
  restoreState(s: SimState): void;
  /**
   * Replace the private state of behavioural leaf `leaf` (an index into design.leaves) and
   * re-evaluate it: how an external source (a key) is driven from outside. Propagates like an
   * input change (step / settle).
   */
  poke(leaf: number, state: unknown): void;
  /** The private state of a behavioural leaf (undefined for any other leaf). */
  leafState(leaf: number): unknown;
  /** Called after any net changes value (gate sim only reports watched nets). */
  onTrace?: (net: number, value: Bit, time: number) => void;
  watch(nets: readonly number[]): void;
  /** Total leaf evaluations so far (a rough proxy for switching activity / power). */
  readonly evaluations: number;
}
