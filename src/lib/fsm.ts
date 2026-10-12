// A finite-state machine described as data: states, transitions with their conditions, outputs and
// a drawing position for each state. The state diagram (view/fsmdiagram.ts), the live panels and the
// campaign's read-back of a learner's circuit (editor/fsmread.ts) all come from one spec, and
// tests/fsm.test.ts reads the hardware back through the same spec, so the picture cannot drift from
// the circuit. Specs sit next to their hardware (multicycle.ts, rv16/logic.ts); fsms.ts lists them.
// No DOM.

export type FsmInputs = Record<string, number>;

export interface FsmState {
  name: string;
  /** Value of the state register. */
  code: number;
  /** What the hardware does in this state (hover card). */
  does?: string;
  /** Moore outputs (others 0). */
  out?: Record<string, number>;
  /** Centre in diagram units. */
  at: [number, number];
  /** Drawing extras (the read-back's unknown and duplicate states). */
  cls?: string;
}

export interface FsmArc {
  from: number;
  to: number;
  label?: string;
  /** Taken when this holds (absent: always). The first matching arc out of a state wins. */
  when?: (inp: FsmInputs) => boolean;
  /** Mealy outputs while the arc is the one the next edge takes (others: the state's). */
  out?: Record<string, number>;
  /** Instances of the reference circuit that make this transition (lit on hover). */
  parts?: string[];
  /** Drawing: bend of the curve (units to its left), label position along it, label offset. */
  bend?: number;
  t?: number;
  dx?: number;
  dy?: number;
  /** A self-loop's direction in degrees (0 right, −90 up). */
  loop?: number;
  /** Drawn along the spec's shared return rail. */
  rail?: boolean;
  cls?: string;
}

export interface FsmSpec {
  title: string;
  shape: 'pill' | 'circle';
  /** Diagram size (viewBox units). */
  size: [number, number];
  states: FsmState[];
  arcs: FsmArc[];
  /** The power-on / reset state (index). */
  reset: number;
  /** Inputs the arcs read (ports of the reference circuit), and the values worth trying for each (default 0 and 1). */
  inputs: string[];
  domain?: Record<string, number[]>;
  /** Outputs the states and arcs set. */
  outputs: string[];
  /** Synchronous reset: these input values force `reset` at the edge (drawn as an entry arrow). */
  resetIn?: FsmInputs;
  /** Ports of the reference whose bits (concatenated, least significant first) hold the state code. */
  stateBits: string[];
  /** Width of the code in bits (shown under circle states). */
  codeBits?: number;
  /** Returns drawn on one line: down to y, across to x, up to the target. */
  rail?: { to: number; x: number; y: number; label: string; labelX: number };
  /** The reset entry arrow's start. */
  entry?: [number, number];
}

const matches = (sub: FsmInputs, inp: FsmInputs) => Object.entries(sub).every(([k, v]) => inp[k] === v);

/** The arc the next edge takes from state s with these inputs (index), or −1 (reset, or nothing matches). */
export function fsmArc(spec: FsmSpec, s: number, inp: FsmInputs): number {
  if (spec.resetIn && matches(spec.resetIn, inp)) return -1;
  return spec.arcs.findIndex((a) => a.from === s && (!a.when || a.when(inp)));
}

/** The state after the next edge, or −1 when no arc says. */
export function fsmNext(spec: FsmSpec, s: number, inp: FsmInputs): number {
  if (spec.resetIn && matches(spec.resetIn, inp)) return spec.reset;
  const a = fsmArc(spec, s, inp);
  return a < 0 ? -1 : spec.arcs[a].to;
}

/** Outputs in state s with these inputs: the state's (Moore), then the arc's (Mealy), others 0. */
export function fsmOut(spec: FsmSpec, s: number, inp: FsmInputs): Record<string, number> {
  const a = fsmArc(spec, s, inp);
  const o: Record<string, number> = Object.fromEntries(spec.outputs.map((n) => [n, 0]));
  Object.assign(o, spec.states[s]?.out, a >= 0 ? spec.arcs[a].out : undefined);
  return o;
}

export const stateOfCode = (spec: FsmSpec, code: number): number => spec.states.findIndex((s) => s.code === code);

/** Every combination of the inputs' domains (first input most significant), the reset excluded. */
export function fsmInputCombos(spec: FsmSpec): FsmInputs[] {
  let out: FsmInputs[] = [{}];
  for (const n of spec.inputs) {
    const vals = spec.domain?.[n] ?? [0, 1];
    out = out.flatMap((o) => vals.map((v) => ({ ...o, [n]: v })));
  }
  return spec.resetIn ? out.filter((o) => !matches(spec.resetIn!, o)) : out;
}
