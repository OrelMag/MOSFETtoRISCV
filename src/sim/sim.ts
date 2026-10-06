import type { FlatDesign } from './flatten';
import type { Bit } from './types';

export type PowerOnMode = 'x' | 'zero' | 'random';

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
  getInput(port: string): number;
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
   */
  carry(prev: Sim): void;
  /** Called after any net changes value (gate sim only reports watched nets). */
  onTrace?: (net: number, value: Bit, time: number) => void;
  watch(nets: readonly number[]): void;
  /** Total leaf evaluations so far (a rough proxy for switching activity / power). */
  readonly evaluations: number;
}
